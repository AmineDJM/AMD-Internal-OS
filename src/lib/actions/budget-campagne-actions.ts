"use server";

import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import { requireUser, type CurrentUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { notifyUser } from "@/lib/notify";
import { anyRoleFilter, userCan } from "@/lib/rbac";
import { toNumber } from "@/lib/utils";
import { voitLesSalaires } from "@/lib/hr/confidentialite";
import { attachFiles } from "@/lib/attach-files";
import { fdStr, fdNum, fdDate, fdCase, type ActionResult } from "@/lib/actions/types";
import { CHEMIN_CAMPAGNE_BUDGETAIRE, lienExamenProposition, lienPropositionPole } from "@/lib/chemins/budget-campagne";
import { DOMAINES } from "@/lib/budget/domaines";
import {
  SEUIL_JUSTIFICATION_DEFAUT, STATUTS_ACCEPTES, aDesAjustements, decisionsApresResoumission, diffVersions, domaineParDefaut,
  droitsCampagne, estDecisionLigne, estDomaineCampagne, estModeValidation, estRegleValidation, estStatutCampagne,
  estStatutProposition, estSourceLigne, fusionnerPrefill, gestePermis, issueDesVotes, lignesSansJustification, peutPasserCampagne,
  peutPreparer, peutVoirProposition, statutApres, verifierCloture, LIBELLE_STATUT_CAMPAGNE,
  type GesteProposition, type LigneInstantane, type StatutCampagne, type StatutProposition,
} from "@/lib/budget-campagne/regles";
import { entreeDroits } from "@/lib/budget-campagne/requetes";
import { calculerPrefill } from "@/lib/budget-campagne/prefill";
import { ouvrirEnveloppeDeLaProposition } from "@/lib/budget-campagne/enveloppes";
import { brouillonJustification, resumerVersions } from "@/lib/budget-campagne-luna";
import { sansBloquer } from "@/lib/journal";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA CAMPAGNE BUDGÉTAIRE — LES GESTES (Budgets 2027, Direction 10/2026). Les règles sont pures
 * (`lib/budget-campagne/regles.ts`) ; ici on lit, on vérifie les droits ET l'état, on écrit, on audite, on prévient la
 * bonne personne avec le lien exact (`chemins/budget-campagne.ts`).
 *
 * Qui fait quoi : la Direction (BUDGET_CAMPAIGN:UPDATE) pilote ; le responsable d'un département (ou son adjoint)
 * prépare SON pôle ; les VALIDEURS nommés dans la campagne décident ; le Super Admin seul autorise une révision après
 * validation. Le cadrage ne s'écrit et ne se lit que par qui le voit.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const MODULE_AUDIT = "Campagne budgétaire";
const NON_AUTORISE: ActionResult = { ok: false, error: "Non autorisé." };
const revalider = () => revalidatePath(CHEMIN_CAMPAGNE_BUDGETAIRE);

const CAMPAGNE_SELECT = {
  id: true, year: true, title: true, status: true, companyId: true, validatorIds: true, validatorRule: true,
  allowRectificatif: true, seuilJustificationPct: true,
} as const;

async function contexte(user: CurrentUser, proposalId: string) {
  const p = await prisma.budgetProposal.findUnique({
    where: { id: proposalId },
    select: {
      id: true, departmentId: true, poleLabel: true, domaine: true, status: true, currentVersion: true,
      revisionAutorisee: true, estRectificatif: true, rectificatifs: true, envelopeId: true,
      campaign: { select: CAMPAGNE_SELECT },
      department: { select: { head: { select: { userId: true } }, deputy: { select: { userId: true } } } },
    },
  });
  if (!p) return null;
  const e = await entreeDroits(user, p.campaign.validatorIds);
  const statut: StatutProposition = estStatutProposition(p.status) ? p.status : "EN_PREPARATION";
  const statutCampagne: StatutCampagne = estStatutCampagne(p.campaign.status) ? p.campaign.status : "DRAFT";
  const geste = (g: GesteProposition) => gestePermis(g, {
    statutCampagne, statut, revisionAutorisee: p.revisionAutorisee, allowRectificatif: p.campaign.allowRectificatif, estRectificatif: p.estRectificatif,
  });
  const responsables = [p.department?.head?.userId, p.department?.deputy?.userId].filter((x): x is string => Boolean(x));
  return { p, e, droits: droitsCampagne(e), statut, statutCampagne, geste, responsables };
}

async function prevenir(userIds: readonly string[], title: string, body: string, link: string, sauf?: string): Promise<void> {
  for (const userId of [...new Set(userIds)].filter((id) => id && id !== sauf)) {
    await notifyUser({ userId, type: "VALIDATION_REQUIRED", title, body, link }).catch(sansBloquer("budget-campagne-actions.prevenir.notifyUser"));
  }
}

/** Les comités par défaut (Direction, 10/2026) : le DG ET le Super Admin. */
async function valideursParDefaut(): Promise<string[]> {
  const rows = await prisma.user.findMany({ where: { isActive: true, ...anyRoleFilter(["GENERAL_MANAGER", "SUPER_ADMIN"]) }, select: { id: true }, orderBy: { createdAt: "asc" } });
  return rows.map((r) => r.id);
}

async function validerValideurs(ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await prisma.user.findMany({ where: { id: { in: ids }, isActive: true }, select: { id: true } });
  return rows.map((r) => r.id);
}

// ─────────────────────────────── La campagne ───────────────────────────────

/** Crée une campagne (brouillon) et la proposition de chaque pôle choisi. */
export async function creerCampagne(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, "BUDGET_CAMPAIGN", "CREATE")) return NON_AUTORISE;
  const year = fdNum(formData, "year");
  const title = fdStr(formData, "title");
  const opensAt = fdDate(formData, "opensAt");
  const submitDeadline = fdDate(formData, "submitDeadline");
  const validationDeadline = fdDate(formData, "validationDeadline");
  if (!year || year < 2020 || year > 2100) return { ok: false, error: "Année invalide." };
  if (!opensAt || !submitDeadline || !validationDeadline) return { ok: false, error: "Les trois dates sont obligatoires." };
  if (!(opensAt <= submitDeadline && submitDeadline <= validationDeadline)) return { ok: false, error: "Ouverture ≤ remise ≤ validation." };
  const mode = fdStr(formData, "validatorMode");
  const regle = fdStr(formData, "validatorRule");
  const voulus = await validerValideurs(formData.getAll("validatorIds").map(String).filter(Boolean));
  const validatorMode = estModeValidation(mode) ? mode : "COMITE";
  let validatorIds = voulus.length ? voulus : await valideursParDefaut();
  if (validatorMode === "DG") validatorIds = validatorIds.slice(0, 1);
  const seuil = fdNum(formData, "seuilJustificationPct");
  // LE CADRAGE ne s'écrit que par qui le VOIT (DG, Super Admin — un pilote non valideur ne le pose pas).
  const voitCadrage = user.role === "SUPER_ADMIN" || user.role === "GENERAL_MANAGER" || user.secondaryRole === "GENERAL_MANAGER" || validatorIds.includes(user.id);
  const cadrageTotal = voitCadrage ? fdNum(formData, "cadrageTotal") : null;
  const poleIds = formData.getAll("poleIds").map(String).filter(Boolean);
  const deps = poleIds.length ? await prisma.department.findMany({ where: { id: { in: poleIds } }, select: { id: true, name: true, code: true } }) : [];

  const c = await prisma.budgetCampaign.create({
    data: {
      year, title: title ?? `Campagne budgétaire ${year}`, opensAt, submitDeadline, validationDeadline,
      companyId: fdStr(formData, "companyId"),
      cadrageTotal: cadrageTotal !== null && cadrageTotal > 0 ? cadrageTotal : null,
      validatorMode, validatorIds, validatorRule: estRegleValidation(regle) ? regle : "ALL",
      // RECTIFICATIF : le Super Admin seul l'ouvre pour toute une campagne (défaut : non).
      allowRectificatif: user.role === "SUPER_ADMIN" ? fdCase(formData, "allowRectificatif") ?? false : false,
      seuilJustificationPct: seuil !== null && seuil >= 0 && seuil <= 100 ? seuil : SEUIL_JUSTIFICATION_DEFAUT,
      createdById: user.id,
      proposals: { create: deps.map((d) => ({ departmentId: d.id, poleLabel: d.name, domaine: domaineParDefaut(d.name, d.code) })) },
    },
    select: { id: true, title: true },
  });
  await recordAudit({ actorId: user.id, action: "CREATE", module: MODULE_AUDIT, entityType: "BUDGET", entityId: c.id, summary: `Campagne « ${c.title} » créée (${deps.length} pôle(s))` });
  revalider();
  return { ok: true, id: c.id };
}

/** Règle une campagne (dates, valideurs, seuil, cadrage pour qui le voit, rectificatif pour le Super Admin). */
export async function modifierCampagne(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, "BUDGET_CAMPAIGN", "UPDATE")) return NON_AUTORISE;
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Campagne introuvable." };
  const c = await prisma.budgetCampaign.findUnique({ where: { id }, select: { validatorIds: true, status: true } });
  if (!c) return { ok: false, error: "Campagne introuvable." };
  const e = await entreeDroits(user, c.validatorIds);
  const droits = droitsCampagne(e);
  const data: Prisma.BudgetCampaignUpdateInput = {};
  const title = fdStr(formData, "title");
  if (title) data.title = title;
  const opensAt = fdDate(formData, "opensAt");
  const submitDeadline = fdDate(formData, "submitDeadline");
  const validationDeadline = fdDate(formData, "validationDeadline");
  if (opensAt) data.opensAt = opensAt;
  if (submitDeadline) data.submitDeadline = submitDeadline;
  if (validationDeadline) data.validationDeadline = validationDeadline;
  if (formData.has("validatorMode")) { const m = fdStr(formData, "validatorMode"); if (estModeValidation(m)) data.validatorMode = m; }
  if (formData.has("validatorRule")) { const r = fdStr(formData, "validatorRule"); if (estRegleValidation(r)) data.validatorRule = r; }
  if (formData.has("validatorIds")) {
    let ids = await validerValideurs(formData.getAll("validatorIds").map(String).filter(Boolean));
    if (ids.length === 0) return { ok: false, error: "Nommez au moins un valideur." };
    if ((data.validatorMode ?? null) === "DG") ids = ids.slice(0, 1);
    data.validatorIds = ids;
  }
  if (formData.has("seuilJustificationPct")) {
    const s = fdNum(formData, "seuilJustificationPct");
    if (s !== null && s >= 0 && s <= 100) data.seuilJustificationPct = s;
  }
  if (formData.has("cadrageTotal") && droits.voitLeCadrage) {
    const v = fdNum(formData, "cadrageTotal");
    data.cadrageTotal = v !== null && v > 0 ? v : null;
  }
  if (formData.has("allowRectificatif") && droits.peutReglerRectificatif) {
    const v = fdCase(formData, "allowRectificatif");
    if (v !== undefined) data.allowRectificatif = v;
  }
  if (formData.has("companyId")) data.companyId = fdStr(formData, "companyId");
  await prisma.budgetCampaign.update({ where: { id }, data });
  await recordAudit({ actorId: user.id, action: "UPDATE", module: MODULE_AUDIT, entityType: "BUDGET", entityId: id, summary: "Réglages de la campagne modifiés" });
  revalider();
  return { ok: true };
}

/** Fait avancer (ou reculer d'un pas) la campagne. Ouvrir prévient chaque pôle ; clore ouvre les enveloppes validées. */
export async function changerStatutCampagne(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, "BUDGET_CAMPAIGN", "UPDATE")) return NON_AUTORISE;
  const id = fdStr(formData, "id");
  const vers = fdStr(formData, "statut");
  if (!id || !estStatutCampagne(vers)) return { ok: false, error: "Étape inconnue." };
  const c = await prisma.budgetCampaign.findUnique({
    where: { id },
    select: { id: true, title: true, status: true, year: true, proposals: { select: { id: true, status: true, department: { select: { head: { select: { userId: true } }, deputy: { select: { userId: true } } } } } } },
  });
  if (!c || !estStatutCampagne(c.status)) return { ok: false, error: "Campagne introuvable." };
  if (!peutPasserCampagne(c.status, vers)) return { ok: false, error: `Passage impossible : ${LIBELLE_STATUT_CAMPAGNE[c.status]} → ${LIBELLE_STATUT_CAMPAGNE[vers]}.` };
  if (vers === "OPEN" && c.proposals.length === 0) return { ok: false, error: "Ajoutez au moins un pôle avant d'ouvrir la campagne." };
  if (vers === "CLOSED") {
    const v = verifierCloture(c.proposals.map((p) => p.status));
    if (!v.ok) return { ok: false, error: v.raison };
  }
  await prisma.budgetCampaign.update({ where: { id }, data: { status: vers } });
  await recordAudit({ actorId: user.id, action: "UPDATE", module: MODULE_AUDIT, entityType: "BUDGET", entityId: id, field: "status", oldValue: c.status, newValue: vers, summary: `Campagne « ${c.title} » : ${LIBELLE_STATUT_CAMPAGNE[vers]}` });

  if (vers === "OPEN") {
    for (const p of c.proposals) {
      await prevenir([p.department?.head?.userId ?? "", p.department?.deputy?.userId ?? ""],
        `Budget ${c.year} : préparez la proposition de votre pôle`, c.title, lienPropositionPole(p.id), user.id);
    }
  }
  let enveloppes = 0;
  if (vers === "CLOSED") {
    // VALIDÉ = OUVERT — rejoué à la clôture : idempotent, il ne double jamais une enveloppe déjà ouverte à l'acceptation.
    for (const p of c.proposals.filter((x) => estStatutProposition(x.status) && STATUTS_ACCEPTES.includes(x.status))) {
      const r = await ouvrirEnveloppeDeLaProposition(p.id, user.id);
      if (r.ok) enveloppes++;
    }
    for (const d of Object.values(DOMAINES)) revalidatePath(d.chemin);
    revalidatePath("/budgets");
  }
  revalider();
  return { ok: true, message: vers === "CLOSED" ? `${enveloppes} enveloppe(s) ${c.year} ouvertes.` : undefined };
}

/** Ajoute un pôle (un département de l'organigramme) à la campagne. */
export async function ajouterPoleCampagne(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, "BUDGET_CAMPAIGN", "UPDATE")) return NON_AUTORISE;
  const campaignId = fdStr(formData, "campaignId");
  const departmentId = fdStr(formData, "departmentId");
  if (!campaignId || !departmentId) return { ok: false, error: "Choisissez le département." };
  const [c, d] = await Promise.all([
    prisma.budgetCampaign.findUnique({ where: { id: campaignId }, select: { status: true } }),
    prisma.department.findUnique({ where: { id: departmentId }, select: { name: true, code: true } }),
  ]);
  if (!c || !d) return { ok: false, error: "Campagne ou département introuvable." };
  if (c.status === "CLOSED") return { ok: false, error: "La campagne est close." };
  const deja = await prisma.budgetProposal.findFirst({ where: { campaignId, departmentId }, select: { id: true } });
  if (deja) return { ok: false, error: "Ce pôle est déjà dans la campagne." };
  const p = await prisma.budgetProposal.create({ data: { campaignId, departmentId, poleLabel: d.name, domaine: domaineParDefaut(d.name, d.code) }, select: { id: true } });
  await recordAudit({ actorId: user.id, action: "CREATE", module: MODULE_AUDIT, entityType: "BUDGET", entityId: p.id, summary: `Pôle « ${d.name} » ajouté à la campagne` });
  revalider();
  return { ok: true, id: p.id };
}

/** Règle un pôle : son domaine d'enveloppe, et son cadrage (privé — pour qui le voit). */
export async function reglerPoleCampagne(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const proposalId = fdStr(formData, "proposalId");
  if (!proposalId) return { ok: false, error: "Proposition introuvable." };
  const ctx = await contexte(user, proposalId);
  if (!ctx || !ctx.droits.peutPiloter) return NON_AUTORISE;
  const data: Prisma.BudgetProposalUpdateInput = {};
  if (formData.has("domaine")) { const d = fdStr(formData, "domaine"); if (estDomaineCampagne(d)) data.domaine = d; }
  if (formData.has("cadrage") && ctx.droits.voitLeCadrage) { const v = fdNum(formData, "cadrage"); data.cadrage = v !== null && v > 0 ? v : null; }
  await prisma.budgetProposal.update({ where: { id: proposalId }, data });
  await recordAudit({ actorId: user.id, action: "UPDATE", module: MODULE_AUDIT, entityType: "BUDGET", entityId: proposalId, summary: `Pôle « ${ctx.p.poleLabel} » réglé` });
  revalider();
  return { ok: true };
}

/** Retire un pôle qui n'a encore rien soumis. */
export async function retirerPoleCampagne(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const proposalId = fdStr(formData, "proposalId");
  if (!proposalId) return { ok: false, error: "Proposition introuvable." };
  const ctx = await contexte(user, proposalId);
  if (!ctx || !ctx.droits.peutPiloter) return NON_AUTORISE;
  if (ctx.p.currentVersion > 0) return { ok: false, error: "Ce pôle a déjà soumis une version : il reste dans la campagne." };
  await prisma.budgetProposal.delete({ where: { id: proposalId } });
  await recordAudit({ actorId: user.id, action: "DELETE", module: MODULE_AUDIT, entityType: "BUDGET", entityId: proposalId, summary: `Pôle « ${ctx.p.poleLabel} » retiré de la campagne` });
  revalider();
  return { ok: true };
}

// ─────────────────────────────── La préparation (le pôle) ───────────────────────────────

function peutEcrire(ctx: NonNullable<Awaited<ReturnType<typeof contexte>>>): ActionResult | null {
  if (!peutPreparer(ctx.e, ctx.p.departmentId)) return NON_AUTORISE;
  const g = ctx.geste("MODIFIER");
  return g.ok ? null : { ok: false, error: g.raison };
}

/** « Pré-remplir depuis l'année en cours » — rejouable, ne remplace jamais un montant saisi. */
export async function preremplirProposition(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const proposalId = fdStr(formData, "proposalId");
  if (!proposalId) return { ok: false, error: "Proposition introuvable." };
  const ctx = await contexte(user, proposalId);
  if (!ctx) return NON_AUTORISE;
  const refus = peutEcrire(ctx);
  if (refus) return refus;
  if (!ctx.p.departmentId) return { ok: false, error: "Le département de ce pôle n'existe plus." };
  const proposees = await calculerPrefill({
    departmentId: ctx.p.departmentId, domaine: estDomaineCampagne(ctx.p.domaine) ? ctx.p.domaine : "GENERAL",
    annee: ctx.p.campaign.year, companyId: ctx.p.campaign.companyId, voitLesSalaires: voitLesSalaires(user),
  });
  const existantes = await prisma.budgetProposalLine.findMany({ where: { proposalId }, select: { key: true, source: true, propose: true, justification: true, sortOrder: true } });
  const { creer, maj } = fusionnerPrefill(existantes.map((l) => ({ ...l, propose: toNumber(l.propose) })), proposees);
  const ordre = existantes.reduce((a, l) => Math.max(a, l.sortOrder), 0);
  await prisma.$transaction([
    ...creer.map((l, i) => prisma.budgetProposalLine.create({
      data: { proposalId, key: l.key, label: l.label, categoryKey: l.categoryKey, source: l.source, realise2026: l.realise2026, propose: l.propose, justification: l.justification ?? null, sortOrder: ordre + i + 1 },
    })),
    ...maj.map((m) => prisma.budgetProposalLine.update({
      where: { proposalId_key: { proposalId, key: m.key } },
      data: { realise2026: m.realise2026, source: m.source, ...(m.propose !== undefined ? { propose: m.propose } : {}), ...(m.justification !== undefined ? { justification: m.justification } : {}) },
    })),
  ]);
  await recordAudit({ actorId: user.id, action: "UPDATE", module: MODULE_AUDIT, entityType: "BUDGET", entityId: proposalId, summary: `Pré-remplissage — ${creer.length} ligne(s) ajoutée(s), ${maj.length} mise(s) à jour` });
  revalider();
  return { ok: true, message: `${creer.length} ligne(s) ajoutée(s), ${maj.length} mise(s) à jour.` };
}

/** Ajoute ou modifie une ligne (libellé, montant proposé, justification). */
export async function enregistrerLigneProposition(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const proposalId = fdStr(formData, "proposalId");
  if (!proposalId) return { ok: false, error: "Proposition introuvable." };
  const ctx = await contexte(user, proposalId);
  if (!ctx) return NON_AUTORISE;
  const refus = peutEcrire(ctx);
  if (refus) return refus;
  const lineId = fdStr(formData, "lineId");
  const label = fdStr(formData, "label");
  const propose = fdNum(formData, "propose");
  if (propose !== null && propose < 0) return { ok: false, error: "Un montant ne peut pas être négatif." };
  const justification = formData.has("justification") ? fdStr(formData, "justification") : undefined;
  if (lineId) {
    const l = await prisma.budgetProposalLine.findFirst({ where: { id: lineId, proposalId }, select: { id: true } });
    if (!l) return { ok: false, error: "Ligne introuvable." };
    await prisma.budgetProposalLine.update({
      where: { id: lineId },
      data: { ...(label ? { label } : {}), ...(propose !== null ? { propose } : {}), ...(justification !== undefined ? { justification } : {}) },
    });
  } else {
    if (!label) return { ok: false, error: "Le libellé de la ligne est obligatoire." };
    const n = await prisma.budgetProposalLine.count({ where: { proposalId } });
    await prisma.budgetProposalLine.create({
      data: { proposalId, key: `SAISIE:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, label, source: "SAISIE", propose: propose ?? 0, justification: justification ?? null, sortOrder: n + 1 },
    });
  }
  revalider();
  return { ok: true };
}

/** Retire une ligne (avant soumission, ou à revoir). */
export async function supprimerLigneProposition(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const lineId = fdStr(formData, "lineId");
  if (!lineId) return { ok: false, error: "Ligne introuvable." };
  const l = await prisma.budgetProposalLine.findUnique({ where: { id: lineId }, select: { proposalId: true, label: true } });
  if (!l) return { ok: false, error: "Ligne introuvable." };
  const ctx = await contexte(user, l.proposalId);
  if (!ctx) return NON_AUTORISE;
  const refus = peutEcrire(ctx);
  if (refus) return refus;
  await prisma.budgetProposalLine.delete({ where: { id: lineId } });
  await recordAudit({ actorId: user.id, action: "DELETE", module: MODULE_AUDIT, entityType: "BUDGET", entityId: l.proposalId, summary: `Ligne « ${l.label} » retirée` });
  revalider();
  return { ok: true };
}

/** Joint une ou plusieurs pièces à une ligne. */
export async function joindrePieceLigne(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const lineId = fdStr(formData, "lineId");
  if (!lineId) return { ok: false, error: "Ligne introuvable." };
  const l = await prisma.budgetProposalLine.findUnique({ where: { id: lineId }, select: { proposalId: true, key: true } });
  if (!l) return { ok: false, error: "Ligne introuvable." };
  const ctx = await contexte(user, l.proposalId);
  if (!ctx || !peutVoirProposition(ctx.e, ctx.p.departmentId)) return NON_AUTORISE;
  if (!peutPreparer(ctx.e, ctx.p.departmentId)) return NON_AUTORISE;
  const files = formData.getAll("fichiers").filter((f): f is File => f instanceof File);
  const stepKey = `campagne:${lineId}`;
  const r = await attachFiles({ files, entityType: "BUDGET", entityId: l.proposalId, uploadedById: user.id, stepKey });
  const docs = await prisma.document.findMany({ where: { entityType: "BUDGET", entityId: l.proposalId, stepKey }, select: { id: true, name: true }, orderBy: { createdAt: "asc" } });
  await prisma.budgetProposalLine.update({ where: { id: lineId }, data: { attachments: docs.map((d) => ({ id: d.id, name: d.name })) } });
  revalider();
  return r.error ? { ok: false, error: r.error } : { ok: true, message: `${r.saved} pièce(s) jointe(s).` };
}

/** Luna propose une première rédaction de justification (rien n'est enregistré : le pôle relit, garde ou non). */
export async function proposerJustificationLuna(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const lineId = fdStr(formData, "lineId");
  if (!lineId) return { ok: false, error: "Ligne introuvable." };
  const l = await prisma.budgetProposalLine.findUnique({ where: { id: lineId }, select: { proposalId: true, label: true, source: true, realise2026: true, propose: true, justification: true } });
  if (!l) return { ok: false, error: "Ligne introuvable." };
  const ctx = await contexte(user, l.proposalId);
  if (!ctx || !peutPreparer(ctx.e, ctx.p.departmentId)) return NON_AUTORISE;
  const r = await brouillonJustification({
    pole: ctx.p.poleLabel, label: l.label, source: estSourceLigne(l.source) ? l.source : "SAISIE",
    realise: toNumber(l.realise2026), propose: toNumber(l.propose), contexte: l.justification,
  }, user.id);
  return { ok: true, message: r.texte };
}

/** SOUMETTRE — fige la version n+1, résume les changements (Luna ou le repli exact), prévient les valideurs. */
export async function soumettreProposition(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const proposalId = fdStr(formData, "proposalId");
  if (!proposalId) return { ok: false, error: "Proposition introuvable." };
  const ctx = await contexte(user, proposalId);
  if (!ctx || !peutPreparer(ctx.e, ctx.p.departmentId)) return NON_AUTORISE;
  const g = ctx.geste("SOUMETTRE");
  if (!g.ok) return { ok: false, error: g.raison };
  const lignes = await prisma.budgetProposalLine.findMany({ where: { proposalId }, orderBy: { sortOrder: "asc" } });
  if (lignes.length === 0) return { ok: false, error: "Ajoutez au moins une ligne (ou pré-remplissez) avant de soumettre." };
  const seuil = toNumber(ctx.p.campaign.seuilJustificationPct);
  const nombres = lignes.map((l) => ({ ...l, realise2026: toNumber(l.realise2026), propose: toNumber(l.propose), ajuste: l.ajuste === null ? null : toNumber(l.ajuste) }));
  const manquantes = lignesSansJustification(nombres, seuil);
  if (manquantes.length) {
    const noms = nombres.filter((l) => manquantes.includes(l.key)).map((l) => `« ${l.label} »`).join(", ");
    return { ok: false, error: `Justification requise (écart de plus de ${seuil} %) : ${noms}.` };
  }
  const version = ctx.p.currentVersion + 1;
  const instantane: LigneInstantane[] = nombres.map((l) => ({ key: l.key, label: l.label, propose: l.propose, categoryLineId: l.categoryLineId, justification: l.justification, source: l.source }));
  const precedente = ctx.p.currentVersion > 0
    ? await prisma.budgetProposalVersion.findUnique({ where: { proposalId_version: { proposalId, version: ctx.p.currentVersion } }, select: { lines: true } })
    : null;
  const avant = (Array.isArray(precedente?.lines) ? precedente!.lines : []) as unknown as LigneInstantane[];
  const resume = precedente ? await resumerVersions(ctx.p.currentVersion, version, diffVersions(avant, instantane), user.id) : null;
  const decisions = decisionsApresResoumission(new Map(avant.map((l) => [l.key, Number(l.propose)])), nombres);
  const total = nombres.reduce((a, l) => a + l.propose, 0);

  // L'ÉTAT AVANCE SOUS CONDITION : deux soumissions simultanées ne font pas deux versions.
  const ok = await prisma.$transaction(async (tx) => {
    const r = await tx.budgetProposal.updateMany({
      where: { id: proposalId, currentVersion: ctx.p.currentVersion, status: { in: ["EN_PREPARATION", "A_REVOIR"] } },
      data: { status: statutApres("SOUMETTRE"), currentVersion: version, submittedById: user.id, submittedAt: new Date() },
    });
    if (r.count === 0) return false;
    await tx.budgetProposalVersion.create({
      data: { proposalId, version, lines: instantane as unknown as Prisma.InputJsonValue, total, rectificatif: ctx.p.estRectificatif, submittedById: user.id, summary: resume?.texte ?? null, summaryByLuna: resume?.parLuna ?? false },
    });
    for (const d of decisions) await tx.budgetProposalLine.update({ where: { proposalId_key: { proposalId, key: d.key } }, data: { decision: d.decision, ajuste: d.ajuste } });
    if (resume) await tx.budgetProposalComment.create({ data: { proposalId, parLuna: true, body: resume.texte } });
    return true;
  });
  if (!ok) return { ok: false, error: "La proposition a changé entre-temps — rechargez l'écran." };
  await recordAudit({ actorId: user.id, action: "UPDATE", module: MODULE_AUDIT, entityType: "BUDGET", entityId: proposalId, summary: `« ${ctx.p.poleLabel} » soumet la v${version}${ctx.p.estRectificatif ? " (rectificatif)" : ""} — ${total} DZD` });
  await prevenir(ctx.p.campaign.validatorIds, `Budget ${ctx.p.campaign.year} — ${ctx.p.poleLabel} a soumis la v${version}`, resume?.texte ?? "À examiner ligne par ligne.", lienExamenProposition(proposalId), user.id);
  revalider();
  return { ok: true, message: `Version ${version} soumise.` };
}

// ─────────────────────────────── L'examen (les valideurs) ───────────────────────────────

/** Décision sur une ligne : accepter, ajuster (montant), poser une question, refuser la ligne. */
export async function deciderLigneProposition(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const lineId = fdStr(formData, "lineId");
  const decision = fdStr(formData, "decision");
  if (!lineId || !estDecisionLigne(decision)) return { ok: false, error: "Décision inconnue." };
  const l = await prisma.budgetProposalLine.findUnique({ where: { id: lineId }, select: { proposalId: true, label: true, propose: true } });
  if (!l) return { ok: false, error: "Ligne introuvable." };
  const ctx = await contexte(user, l.proposalId);
  if (!ctx) return NON_AUTORISE;
  // Une QUESTION peut venir de qui examine (Finances comprises) ; trancher une ligne revient aux valideurs.
  if (decision === "QUESTION" ? !ctx.droits.voitVueDG : !ctx.droits.estValideur) return NON_AUTORISE;
  const g = ctx.geste("DECIDER_LIGNE");
  if (!g.ok) return { ok: false, error: g.raison };
  const ajuste = fdNum(formData, "ajuste");
  const question = fdStr(formData, "question");
  if (decision === "AJUSTE" && (ajuste === null || ajuste < 0)) return { ok: false, error: "Indiquez le montant ajusté." };
  if (decision === "QUESTION" && !question) return { ok: false, error: "Écrivez la question." };
  await prisma.budgetProposalLine.update({ where: { id: lineId }, data: { decision, ajuste: decision === "AJUSTE" ? ajuste : null } });
  if (question) await prisma.budgetProposalComment.create({ data: { proposalId: l.proposalId, lineId, authorId: user.id, body: question } });
  await recordAudit({
    actorId: user.id, action: decision === "REFUSE" ? "REFUSE" : "VALIDATE", module: MODULE_AUDIT, entityType: "BUDGET", entityId: l.proposalId,
    field: "decision", newValue: decision === "AJUSTE" ? `AJUSTE ${ajuste}` : decision, summary: `Ligne « ${l.label} » (${ctx.p.poleLabel}) : ${decision.toLowerCase()}`,
  });
  if (question) await prevenir(ctx.responsables, `Budget ${ctx.p.campaign.year} — question sur « ${l.label} »`, question, lienPropositionPole(l.proposalId), user.id);
  revalider();
  return { ok: true };
}

/** L'avis d'un valideur sur la version en cours (accepter / refuser). La règle de la campagne (tous / un seul) tranche. */
export async function voterProposition(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const proposalId = fdStr(formData, "proposalId");
  const decision = fdStr(formData, "decision");
  if (!proposalId || (decision !== "ACCEPTE" && decision !== "REFUSE")) return { ok: false, error: "Décision inconnue." };
  const ctx = await contexte(user, proposalId);
  if (!ctx || !ctx.droits.estValideur) return NON_AUTORISE;
  const g = ctx.geste("VOTER");
  if (!g.ok) return { ok: false, error: g.raison };
  const comment = fdStr(formData, "comment");
  const version = ctx.p.currentVersion;
  await prisma.budgetProposalVote.upsert({
    where: { proposalId_version_userId: { proposalId, version, userId: user.id } },
    create: { proposalId, version, userId: user.id, decision, comment },
    update: { decision, comment, createdAt: new Date() },
  });
  if (comment) await prisma.budgetProposalComment.create({ data: { proposalId, authorId: user.id, body: comment } });
  const [votes, lignes] = await Promise.all([
    prisma.budgetProposalVote.findMany({ where: { proposalId, version }, select: { userId: true, decision: true, createdAt: true } }),
    prisma.budgetProposalLine.findMany({ where: { proposalId }, select: { propose: true, ajuste: true, decision: true } }),
  ]);
  const issue = issueDesVotes({
    votes: votes.map((v) => ({ userId: v.userId, decision: v.decision === "REFUSE" ? "REFUSE" : "ACCEPTE", at: v.createdAt.getTime() })),
    validatorIds: ctx.p.campaign.validatorIds,
    regle: estRegleValidation(ctx.p.campaign.validatorRule) ? ctx.p.campaign.validatorRule : "ALL",
    ajustements: aDesAjustements(lignes.map((l) => ({ propose: toNumber(l.propose), ajuste: l.ajuste === null ? null : toNumber(l.ajuste), decision: l.decision }))),
  });
  await recordAudit({ actorId: user.id, action: decision === "REFUSE" ? "REFUSE" : "VALIDATE", module: MODULE_AUDIT, entityType: "BUDGET", entityId: proposalId, summary: `Avis ${decision.toLowerCase()} sur la v${version} de « ${ctx.p.poleLabel} »` });
  let message: string | undefined;
  if (issue) {
    const r = await prisma.budgetProposal.updateMany({ where: { id: proposalId, status: "SOUMIS", currentVersion: version }, data: { status: issue, decidedAt: new Date(), ...(STATUTS_ACCEPTES.includes(issue) ? { estRectificatif: false } : {}) } });
    if (r.count > 0) {
      await recordAudit({ actorId: user.id, action: issue === "REFUSE" ? "REFUSE" : "VALIDATE", module: MODULE_AUDIT, entityType: "BUDGET", entityId: proposalId, field: "status", newValue: issue, summary: `« ${ctx.p.poleLabel} » v${version} : ${issue.toLowerCase().replace(/_/g, " ")}` });
      if (STATUTS_ACCEPTES.includes(issue)) {
        const env = await ouvrirEnveloppeDeLaProposition(proposalId, user.id);
        message = env.ok ? "Validé — l'enveloppe de l'année est ouverte." : `Validé — enveloppe à ouvrir : ${env.error}`;
        const dom = estDomaineCampagne(ctx.p.domaine) && ctx.p.domaine !== "GENERAL" ? DOMAINES[ctx.p.domaine].chemin : "/budgets";
        await prevenir(ctx.responsables, `Budget ${ctx.p.campaign.year} de ${ctx.p.poleLabel} validé`, "Votre enveloppe de l'année est ouverte.", dom, user.id);
        revalidatePath(dom);
        revalidatePath("/budgets");
      } else {
        await prevenir(ctx.responsables, `Budget ${ctx.p.campaign.year} de ${ctx.p.poleLabel} refusé`, comment ?? "Voir le fil d'échanges.", lienPropositionPole(proposalId), user.id);
      }
    }
  }
  revalider();
  return { ok: true, message };
}

/** « À revoir » — renvoie la version au pôle, avec un commentaire (obligatoire). */
export async function renvoyerProposition(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const proposalId = fdStr(formData, "proposalId");
  const comment = fdStr(formData, "comment");
  if (!proposalId) return { ok: false, error: "Proposition introuvable." };
  if (!comment) return { ok: false, error: "Dites au pôle ce qu'il faut revoir." };
  const ctx = await contexte(user, proposalId);
  if (!ctx || !(ctx.droits.estValideur || ctx.droits.peutPiloter)) return NON_AUTORISE;
  const g = ctx.geste("RENVOYER");
  if (!g.ok) return { ok: false, error: g.raison };
  const r = await prisma.budgetProposal.updateMany({ where: { id: proposalId, status: "SOUMIS" }, data: { status: statutApres("RENVOYER") } });
  if (r.count === 0) return { ok: false, error: "La proposition a changé entre-temps — rechargez l'écran." };
  await prisma.budgetProposalComment.create({ data: { proposalId, authorId: user.id, body: comment } });
  await recordAudit({ actorId: user.id, action: "UPDATE", module: MODULE_AUDIT, entityType: "BUDGET", entityId: proposalId, field: "status", newValue: "A_REVOIR", summary: `« ${ctx.p.poleLabel} » v${ctx.p.currentVersion} renvoyée à revoir` });
  await prevenir(ctx.responsables, `Budget ${ctx.p.campaign.year} — à revoir`, comment, lienPropositionPole(proposalId), user.id);
  revalider();
  return { ok: true };
}

/** Reprend une proposition refusée : elle repart « à revoir » chez le pôle. */
export async function reprendreProposition(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const proposalId = fdStr(formData, "proposalId");
  if (!proposalId) return { ok: false, error: "Proposition introuvable." };
  const ctx = await contexte(user, proposalId);
  if (!ctx || !(ctx.droits.estValideur || ctx.droits.peutPiloter)) return NON_AUTORISE;
  const g = ctx.geste("REPRENDRE");
  if (!g.ok) return { ok: false, error: g.raison };
  await prisma.budgetProposal.update({ where: { id: proposalId }, data: { status: statutApres("REPRENDRE") } });
  await recordAudit({ actorId: user.id, action: "UPDATE", module: MODULE_AUDIT, entityType: "BUDGET", entityId: proposalId, field: "status", newValue: "A_REVOIR", summary: `« ${ctx.p.poleLabel} » reprise après refus` });
  await prevenir(ctx.responsables, `Budget ${ctx.p.campaign.year} — votre proposition est rouverte`, "Elle est à revoir.", lienPropositionPole(proposalId), user.id);
  revalider();
  return { ok: true };
}

/** Le fil d'échanges — un message, éventuellement sur une ligne. Il prévient l'autre côté. */
export async function commenterProposition(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const proposalId = fdStr(formData, "proposalId");
  const body = fdStr(formData, "body");
  if (!proposalId || !body) return { ok: false, error: "Message vide." };
  const ctx = await contexte(user, proposalId);
  if (!ctx || !peutVoirProposition(ctx.e, ctx.p.departmentId)) return NON_AUTORISE;
  const lineId = fdStr(formData, "lineId");
  if (lineId && !(await prisma.budgetProposalLine.findFirst({ where: { id: lineId, proposalId }, select: { id: true } }))) return { ok: false, error: "Ligne introuvable." };
  await prisma.budgetProposalComment.create({ data: { proposalId, lineId, authorId: user.id, body: body.slice(0, 4000) } });
  const cotePole = ctx.responsables.includes(user.id);
  if (cotePole) await prevenir(ctx.p.campaign.validatorIds, `Budget ${ctx.p.campaign.year} — ${ctx.p.poleLabel} a répondu`, body.slice(0, 200), lienExamenProposition(proposalId), user.id);
  else await prevenir(ctx.responsables, `Budget ${ctx.p.campaign.year} — nouveau message`, body.slice(0, 200), lienPropositionPole(proposalId), user.id);
  revalider();
  return { ok: true };
}

// ─────────────────────────────── Après la validation ───────────────────────────────

/** AUTORISER UNE RÉVISION (Super Admin seul, audité) — sans elle, un budget validé ne bouge plus. */
export async function autoriserRevisionProposition(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const proposalId = fdStr(formData, "proposalId");
  if (!proposalId) return { ok: false, error: "Proposition introuvable." };
  const ctx = await contexte(user, proposalId);
  if (!ctx || !ctx.droits.peutAutoriserRevision) return { ok: false, error: "Réservé au Super Admin." };
  const g = ctx.geste("AUTORISER_REVISION");
  if (!g.ok) return { ok: false, error: g.raison };
  await prisma.budgetProposal.update({ where: { id: proposalId }, data: { revisionAutorisee: true, revisionAutoriseeParId: user.id } });
  await recordAudit({ actorId: user.id, action: "VALIDATE", module: MODULE_AUDIT, entityType: "BUDGET", entityId: proposalId, field: "revisionAutorisee", newValue: "true", summary: `Révision autorisée sur le budget validé de « ${ctx.p.poleLabel} »` });
  await prevenir(ctx.responsables, `Budget ${ctx.p.campaign.year} — révision autorisée`, "Vous pouvez rouvrir votre budget en rectificatif.", lienPropositionPole(proposalId), user.id);
  revalider();
  return { ok: true };
}

/** ROUVRIR EN RECTIFICATIF — une nouvelle version sur un budget validé, à re-valider ; l'autorisation est consommée. */
export async function rouvrirRectificatif(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const proposalId = fdStr(formData, "proposalId");
  if (!proposalId) return { ok: false, error: "Proposition introuvable." };
  const ctx = await contexte(user, proposalId);
  if (!ctx || !peutPreparer(ctx.e, ctx.p.departmentId)) return NON_AUTORISE;
  const g = ctx.geste("ROUVRIR_RECTIFICATIF");
  if (!g.ok) return { ok: false, error: g.raison };
  const r = await prisma.budgetProposal.updateMany({
    where: { id: proposalId, status: { in: [...STATUTS_ACCEPTES] } },
    data: { status: statutApres("ROUVRIR_RECTIFICATIF"), estRectificatif: true, rectificatifs: { increment: 1 }, revisionAutorisee: false },
  });
  if (r.count === 0) return { ok: false, error: "La proposition a changé entre-temps — rechargez l'écran." };
  await recordAudit({ actorId: user.id, action: "UPDATE", module: MODULE_AUDIT, entityType: "BUDGET", entityId: proposalId, field: "status", newValue: "A_REVOIR", summary: `Rectificatif ouvert sur le budget de « ${ctx.p.poleLabel} »` });
  await prevenir(ctx.p.campaign.validatorIds, `Budget ${ctx.p.campaign.year} — rectificatif ouvert par ${ctx.p.poleLabel}`, "Une nouvelle version viendra à examiner.", lienExamenProposition(proposalId), user.id);
  revalider();
  return { ok: true };
}
