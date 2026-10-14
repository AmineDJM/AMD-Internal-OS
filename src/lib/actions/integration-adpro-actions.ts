"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { canManageEnvelope, type SessionUser } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { attachFiles, validateAttachments } from "@/lib/attach-files";
import { fdStr, type ActionResult } from "@/lib/actions/types";
import { chargerFacturesConnues, chercherFactureConnue, lireIdentiteDuDepot } from "@/lib/factures/connues";
import { IDENTITE_FACTURE_VIDE } from "@/lib/factures/identite";
import {
  annulerLot, apercuIntegration, blocHistoriqueDe, chargerCandidates, correspondanceCategories, ecrireLot, empreinte,
  enveloppesGerees, lireFichierIntegration, peutJoindrePieces, piecesConnuesDuPlan, proposer,
  type Apercu, type ChoixDemande, type CorrespondanceCategories, type EnveloppeCandidate, type PropositionDemande,
} from "@/lib/budget-marketing/integration-serveur";
import { controleDeLaPiece, piecesAttenduesDe, piecesRattacheesDe, stepKeyDePiece } from "@/lib/budget-marketing/integration-vue";
import { formatCentimes, type PlanIntegration, type TypeDemandeIntegree } from "@/lib/budget-marketing/integration-2026";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'INTÉGRATION DES DÉPENSES RÉELLES AD & PRO 2026 — LES GESTES (assistant Budget Marketing, et fiches des demandes).
 *
 *   • LIRE le fichier : décisions appliquées, total contrôlé au centime, demandes candidates proposées ;
 *   • VÉRIFIER : budget avant → après par catégorie et sous-catégorie, ce que le fichier remplace, ce qui est absent ;
 *   • VALIDER : double confirmation (case cochée + mot « INTÉGRER ») — écriture atomique du lot ;
 *   • ANNULER : d'un bloc, motif exigé, mot « ANNULER » ;
 *   • DÉCIDER d'un élément « absent du fichier » : le garder dans le budget, ou l'en sortir (rien n'est effacé) ;
 *   • JOINDRE des pièces (plusieurs fichiers, à tout moment, jamais bloquant) : Luna lit, le montant et le fournisseur
 *     sont comparés à la ligne ; une pièce déjà dans la plateforme est RATTACHÉE, jamais redéposée ;
 *   • RATTACHER une pièce existante de la demande ou de ses postes.
 *
 * Porte : gérer l'enveloppe (gestionnaire délégué, droit « Modifier » du Budget Marketing, Super Admin). Les pièces
 * s'ouvrent aussi à qui peut modifier la demande dans son module. Aucun geste ne touche le livre de trésorerie ni un
 * ordre de dépense.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const MODULE_AUDIT = "Budget Marketing — intégration Ad & Pro 2026";
const TYPES: readonly TypeDemandeIntegree[] = ["SPONSORING", "CONGRESS_NATIONAL", "CONGRESS_INTERNATIONAL", "EVENT", "TRAINING", "PROMO_MATERIAL", "MEDICAL_INFO_DECLARATION"];
const estType = (v: unknown): v is TypeDemandeIntegree => typeof v === "string" && (TYPES as readonly string[]).includes(v);

function revalider() {
  for (const p of ["/budget-marketing", "/budget-marketing/integration", "/budget-marketing/depenses", "/budget-marketing/ad-pro", "/budgets"]) revalidatePath(p);
}

async function fichierDuFormulaire(formData: FormData): Promise<{ nom: string; octets: Uint8Array } | { erreur: string }> {
  const f = formData.get("fichier");
  if (!(f instanceof File) || f.size === 0) return { erreur: "Choisissez le fichier « Dépenses AP » (.xlsx)." };
  if (f.size > 10 * 1024 * 1024) return { erreur: "Le fichier dépasse 10 Mo : ce n'est pas le fichier attendu." };
  return { nom: f.name, octets: new Uint8Array(await f.arrayBuffer()) };
}

async function enveloppeGeree(user: SessionUser, envelopeId: string | null) {
  if (!envelopeId) return null;
  const env = await prisma.budgetEnvelope.findUnique({ where: { id: envelopeId } });
  return env && canManageEnvelope(user, env) ? env : null;
}

const json = <T>(formData: FormData, key: string, defaut: T): T => {
  const s = fdStr(formData, key);
  if (!s) return defaut;
  try { return JSON.parse(s) as T; } catch { return defaut; }
};

function lireChoix(formData: FormData): ChoixDemande[] {
  const brut = json<unknown[]>(formData, "choix", []);
  const out: ChoixDemande[] = [];
  for (const c of Array.isArray(brut) ? brut : []) {
    if (typeof c !== "object" || c === null) continue;
    const o = c as Record<string, unknown>;
    if (typeof o.cle !== "string") continue;
    if (o.mode === "COMPLETEE" && typeof o.demandeId === "string" && estType(o.type)) {
      out.push({ cle: o.cle, mode: "COMPLETEE", type: o.type, demandeId: o.demandeId, posteRepere: typeof o.posteRepere === "string" ? o.posteRepere : null });
    } else {
      out.push({ cle: o.cle, mode: "CREEE" });
    }
  }
  return out;
}
function lireDecisions(formData: FormData): { cleSource: string; decision: "GARDER" | "SORTIR" }[] {
  const brut = json<unknown[]>(formData, "decisions", []);
  return (Array.isArray(brut) ? brut : [])
    .filter((d): d is { cleSource: string; decision: "GARDER" | "SORTIR" } => typeof d === "object" && d !== null && typeof (d as { cleSource?: unknown }).cleSource === "string" && ((d as { decision?: unknown }).decision === "GARDER" || (d as { decision?: unknown }).decision === "SORTIR"));
}

// ─────────────────────────────── 1. Lire ───────────────────────────────

export interface LectureIntegration {
  ok: boolean;
  error?: string;
  erreurs?: string[];
  sha256?: string;
  plan?: PlanIntegration;
  enveloppes?: EnveloppeCandidate[];
  correspondance?: CorrespondanceCategories;
  propositions?: PropositionDemande[];
  piecesConnues?: Record<string, { legalDocumentId: string; documentId: string | null; nom: string; cle: string }[]>;
  dossiersPromo?: { id: string; libelle: string }[];
}

/** ÉTAPE 1 — lire le fichier, contrôler les décisions, proposer les demandes existantes. Aucune écriture. */
export async function lireFichierIntegrationAdPro(formData: FormData): Promise<LectureIntegration> {
  const user = await requireUser();
  const enveloppes = await enveloppesGerees(user);
  if (enveloppes.length === 0) return { ok: false, error: "Vous ne gérez aucune enveloppe Budget Marketing couvrant 2026." };
  const f = await fichierDuFormulaire(formData);
  if ("erreur" in f) return { ok: false, error: f.erreur };
  const lu = lireFichierIntegration(f.octets);
  if (!lu.ok) return { ok: false, error: "Le fichier ne correspond plus aux décisions : rien n'est intégré.", erreurs: lu.erreurs };
  const envelopeId = fdStr(formData, "envelopeId") ?? enveloppes[0].id;
  const env = enveloppes.find((e) => e.id === envelopeId) ?? enveloppes[0];
  const [candidates, correspondance, piecesConnues, promos] = await Promise.all([
    chargerCandidates(),
    correspondanceCategories(env.id),
    piecesConnuesDuPlan(lu.plan),
    prisma.promoMaterial.findMany({ where: { createdAt: { gte: new Date(Date.UTC(2026, 0, 1)) } }, select: { id: true, reference: true, title: true }, orderBy: { createdAt: "desc" }, take: 100 }),
  ]);
  return {
    ok: true, sha256: lu.sha256, plan: lu.plan, enveloppes, correspondance,
    propositions: proposer(lu.plan, candidates), piecesConnues,
    dossiersPromo: promos.map((p) => ({ id: p.id, libelle: `${p.reference} — ${p.title}` })),
  };
}

// ─────────────────────────────── 2. Vérifier ───────────────────────────────

/** ÉTAPE 4 — l'aperçu avant → après, sur le fichier relu (jamais un plan venu du navigateur). Aucune écriture. */
export async function apercuIntegrationAdPro(formData: FormData): Promise<{ ok: boolean; error?: string; apercu?: Apercu }> {
  const user = await requireUser();
  const env = await enveloppeGeree(user, fdStr(formData, "envelopeId"));
  if (!env) return { ok: false, error: "Enveloppe introuvable, ou vous ne la gérez pas." };
  const f = await fichierDuFormulaire(formData);
  if ("erreur" in f) return { ok: false, error: f.erreur };
  const lu = lireFichierIntegration(f.octets);
  if (!lu.ok) return { ok: false, error: lu.erreurs.join(" ") };
  const r = await apercuIntegration(user, lu.plan, {
    envelopeId: env.id, choix: lireChoix(formData), decisions: lireDecisions(formData), dossierPromoDuVisa: fdStr(formData, "dossierPromoDuVisa"),
  });
  if ("erreur" in r) return { ok: false, error: r.erreur };
  return { ok: true, apercu: r };
}

// ─────────────────────────────── 3. Valider — d'un bloc ───────────────────────────────

export async function validerIntegrationAdPro(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const env = await enveloppeGeree(user, fdStr(formData, "envelopeId"));
  if (!env) return { ok: false, error: "Enveloppe introuvable, ou vous ne la gérez pas." };
  // LA DOUBLE CONFIRMATION, tenue AU SERVEUR : la case « j'ai vérifié » ET le mot tapé.
  if (fdStr(formData, "verifie") !== "on") return { ok: false, error: "Cochez « J'ai vérifié le budget avant → après » : c'est la première confirmation." };
  if ((fdStr(formData, "confirmation") ?? "").toUpperCase() !== "INTÉGRER") return { ok: false, error: "Tapez INTÉGRER pour confirmer : c'est la seconde confirmation." };
  const f = await fichierDuFormulaire(formData);
  if ("erreur" in f) return { ok: false, error: f.erreur };
  const lu = lireFichierIntegration(f.octets);
  if (!lu.ok) return { ok: false, error: `Le fichier ne correspond plus aux décisions : ${lu.erreurs.join(" ")}` };
  const r = await ecrireLot(user, lu.plan, { nom: f.nom, sha256: lu.sha256 }, {
    envelopeId: env.id, choix: lireChoix(formData), decisions: lireDecisions(formData),
    dossierPromoDuVisa: fdStr(formData, "dossierPromoDuVisa"), rattacherConnues: fdStr(formData, "rattacherConnues") !== "off",
  });
  if (!r.ok) return { ok: false, error: r.erreur };
  // Le fichier, rangé comme pièce du lot (best-effort : le lot est écrit, la pièce suit).
  const piece = await attachFiles({ files: [new File([f.octets as BlobPart], f.nom, { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })], entityType: "BUDGET", entityId: env.id, uploadedById: user.id, stepKey: `integration-lot:${r.resultat.lotId}` }).catch(() => ({ saved: 0 }));
  if (piece.saved) {
    const doc = await prisma.document.findFirst({ where: { entityType: "BUDGET", entityId: env.id, stepKey: `integration-lot:${r.resultat.lotId}` }, select: { id: true } });
    if (doc) await prisma.adProIntegrationLot.update({ where: { id: r.resultat.lotId }, data: { fichierDocumentId: doc.id } });
  }
  await recordAudit({
    actorId: user.id, action: "IMPORT", module: MODULE_AUDIT, entityType: "BUDGET", entityId: env.id, field: "integration",
    newValue: r.resultat.lotId,
    summary: `Intégration des dépenses réelles Ad & Pro 2026 validée — ${r.resultat.demandes} demandes (${r.resultat.creees} créées « Historique 2026 », ${r.resultat.completees} complétées), ${formatCentimes(Math.round(r.resultat.total * 100))} DZD, fichier « ${f.nom} » (${lu.sha256.slice(0, 12)}…).`,
  });
  revalider();
  return { ok: true, id: r.resultat.lotId, message: `Intégration validée : ${r.resultat.demandes} demandes, ${formatCentimes(Math.round(r.resultat.total * 100))} DZD au centime. Les pièces se joignent à tout moment sur chaque demande.` };
}

// ─────────────────────────────── 4. Annuler — d'un bloc ───────────────────────────────

export async function annulerIntegrationAdPro(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const lotId = fdStr(formData, "lotId");
  const motif = fdStr(formData, "motif");
  if (!lotId) return { ok: false, error: "Lot non précisé." };
  if (!motif) return { ok: false, error: "Dites pourquoi vous annulez l'intégration : le motif reste au journal." };
  if ((fdStr(formData, "confirmation") ?? "").toUpperCase() !== "ANNULER") return { ok: false, error: "Tapez ANNULER pour confirmer." };
  const r = await annulerLot(user, lotId, motif.slice(0, 500)).catch((e: unknown) => ({ ok: false as const, erreur: e instanceof Error ? e.message : "Annulation impossible." }));
  if (!r.ok) return { ok: false, error: r.erreur };
  const lot = await prisma.adProIntegrationLot.findUnique({ where: { id: lotId }, select: { envelopeId: true } });
  await recordAudit({
    actorId: user.id, action: "DELETE", module: MODULE_AUDIT, entityType: "BUDGET", entityId: lot?.envelopeId, field: "integration",
    oldValue: lotId, summary: `Intégration Ad & Pro 2026 annulée d'un bloc — ${r.retirees} demande(s) historique(s) retirée(s), ${r.rendues} demande(s) rendue(s) à leur état d'avant. Motif : ${motif}`,
  });
  revalider();
  return { ok: true, message: `Intégration annulée : ${r.retirees} demande(s) historique(s) retirée(s), ${r.rendues} rendue(s) à leur état d'avant. Le livre de trésorerie n'a pas bougé.` };
}

// ─────────────────────────────── 5. Absentes du fichier : garder ou sortir ───────────────────────────────

export async function deciderAbsenteIntegration(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const lotId = fdStr(formData, "lotId");
  const cleSource = fdStr(formData, "cleSource");
  const decision = fdStr(formData, "decision");
  if (!lotId || !cleSource || (decision !== "GARDER" && decision !== "SORTIR")) return { ok: false, error: "Choisissez : garder dans le budget, ou en sortir." };
  if (!/^(TX|LIGNE|POSTE|ORDRE):/.test(cleSource)) return { ok: false, error: "Élément inconnu." };
  const lot = await prisma.adProIntegrationLot.findUnique({ where: { id: lotId }, include: { envelope: true } });
  if (!lot || !canManageEnvelope(user, lot.envelope)) return { ok: false, error: "Lot introuvable, ou vous ne gérez pas son enveloppe." };
  if (lot.annuleLe) return { ok: false, error: "Ce lot est annulé : il n'y a plus rien à décider." };
  const libelle = (fdStr(formData, "libelle") ?? cleSource).slice(0, 300);
  const montant = Number(fdStr(formData, "montant") ?? "0");
  const avant = await prisma.adProIntegrationDecision.findUnique({ where: { lotId_cleSource: { lotId, cleSource } }, select: { decision: true } });
  if (avant?.decision === decision) return { ok: true, message: "C'était déjà ce choix." };
  await prisma.adProIntegrationDecision.upsert({
    where: { lotId_cleSource: { lotId, cleSource } },
    create: { lotId, cleSource, decision, libelle, montant: Number.isFinite(montant) ? montant : 0, decideParId: user.id },
    update: { decision, decideParId: user.id, decideLe: new Date() },
  });
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: MODULE_AUDIT, entityType: "BUDGET", entityId: lot.envelopeId, field: "absente-du-fichier",
    oldValue: avant?.decision ?? "à décider", newValue: decision,
    summary: `« ${libelle} » (absente du fichier) : ${decision === "GARDER" ? "gardée dans le budget" : "sortie du budget"} — rien n'est effacé.`,
  });
  revalider();
  return { ok: true, message: decision === "GARDER" ? "Gardée dans le budget." : "Sortie du budget (rien n'est effacé : elle reste dans son module)." };
}

// ─────────────────────────────── 6. Les pièces — à tout moment ───────────────────────────────

async function demandeDuLot(user: SessionUser, demandeRowId: string | null) {
  if (!demandeRowId) return null;
  const row = await prisma.adProIntegrationDemande.findUnique({ where: { id: demandeRowId }, include: { lot: { include: { envelope: true } } } });
  if (!row || row.lot.annuleLe) return null;
  if (!(await peutJoindrePieces(user, row.demandeType as TypeDemandeIntegree, row.demandeId, row.lot.envelope))) return null;
  return row;
}

function revaliderDemande(type: string, id: string) {
  const chemins: Record<string, string> = {
    SPONSORING: "/sponsoring", CONGRESS_NATIONAL: "/congress-national", CONGRESS_INTERNATIONAL: "/congress-international",
    EVENT: "/events", PROMO_MATERIAL: "/promo-material", MEDICAL_INFO_DECLARATION: "/information-medicale",
  };
  if (chemins[type]) revalidatePath(`${chemins[type]}/${id}`);
  revalidatePath(`/budget-marketing/integration/demande/${type}/${id}`);
  revalidatePath("/budget-marketing/integration");
}

/**
 * JOINDRE DES PIÈCES à une pièce attendue — plusieurs fichiers d'un coup, à tout moment, jamais bloquant.
 *
 * Pour chaque fichier : le même fichier déjà dans la plateforme se reconnaît sans lecture ; sinon Luna lit la pièce et
 * elle se compare à toutes les factures connues (`factures/connues.ts`). Une facture déjà connue (CERTAIN) n'est PAS
 * redéposée : elle est RATTACHÉE à la demande. Sinon le fichier est déposé, et ce que Luna a lu (montant, fournisseur)
 * est comparé à la ligne du fichier — un écart se dit, il n'empêche rien.
 */
export async function joindrePiecesIntegration(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const row = await demandeDuLot(user, fdStr(formData, "demandeRowId"));
  if (!row) return { ok: false, error: "Demande introuvable, ou vous ne pouvez pas y joindre de pièce." };
  const cle = fdStr(formData, "cle");
  const attendues = piecesAttenduesDe(row.piecesAttendues);
  if (!cle || !attendues.some((a) => a.cle === cle)) return { ok: false, error: "Choisissez la pièce attendue à laquelle joindre ces fichiers." };
  const fichiers = formData.getAll("fichiers").filter((f): f is File => f instanceof File && f.size > 0);
  if (fichiers.length === 0) return { ok: false, error: "Choisissez au moins un fichier." };
  const refus = await validateAttachments(fichiers);
  if (refus) return { ok: false, error: refus };

  const montant = Number(row.montant);
  const connues = await chargerFacturesConnues().catch(() => []);
  const instances = [`FICHE:${row.demandeType}:${row.demandeId}`];
  const rattachees = piecesRattacheesDe(row.piecesRattachees);
  const nouvellesRattachees: typeof rattachees = [];
  const deposer: File[] = [];
  const messages: string[] = [];
  for (const f of fichiers) {
    const octets = Buffer.from(await f.arrayBuffer());
    const parFichier = chercherFactureConnue({ ...IDENTITE_FACTURE_VIDE, empreintes: [empreinte(octets)] }, connues, { instances });
    let trouvaille = parFichier;
    let lu: { ttc: number | null; fournisseur: string | null } = { ttc: null, fournisseur: null };
    if (!(parFichier.niveau === "CERTAIN" && parFichier.connue)) {
      const identite = await lireIdentiteDuDepot(user.id, octets, f.name).catch(() => null);
      if (identite) {
        lu = { ttc: identite.ttc, fournisseur: identite.fournisseur.nom };
        trouvaille = chercherFactureConnue(identite, connues, { instances });
      }
    }
    if (trouvaille.niveau === "CERTAIN" && trouvaille.connue) {
      const c = trouvaille.connue;
      if (!rattachees.some((r) => r.documentId && r.documentId === c.documentId)) {
        nouvellesRattachees.push({ cle, documentId: c.documentId, nom: c.pieceNom, le: new Date().toISOString(), parId: user.id, source: `${c.module} — ${c.dossier.titre}` });
      }
      messages.push(`« ${f.name} » est déjà dans la plateforme (${c.module} — ${c.dossier.titre}) : rattachée, pas redéposée.`);
      continue;
    }
    const controle = controleDeLaPiece(lu, { montant });
    if (!controle.ok) messages.push(`« ${f.name} » : ${controle.ecarts.join(" ; ")} — l'écart reste affiché, rien n'est bloqué.`);
    if (trouvaille.niveau === "PROBABLE" && trouvaille.connue) messages.push(`« ${f.name} » ressemble à une pièce de ${trouvaille.connue.module} (${trouvaille.connue.dossier.titre}) : vérifiez qu'il ne s'agit pas d'un doublon.`);
    deposer.push(f);
  }
  if (deposer.length) {
    const r = await attachFiles({ files: deposer, entityType: row.demandeType as TypeDemandeIntegree, entityId: row.demandeId, uploadedById: user.id, stepKey: stepKeyDePiece(cle), category: "SUPPORTING_DOC" });
    if (r.error) return { ok: false, error: r.error };
  }
  if (nouvellesRattachees.length) {
    // Conditionnel sur l'état lu : deux dépôts simultanés ne s'écrasent pas leurs rattachements.
    const n = await prisma.adProIntegrationDemande.updateMany({
      where: { id: row.id, updatedAt: row.updatedAt },
      data: { piecesRattachees: [...rattachees, ...nouvellesRattachees] as unknown as object },
    });
    if (n.count !== 1) return { ok: false, error: "La demande vient d'être modifiée par quelqu'un d'autre : rechargez, puis rattachez de nouveau." };
  }
  await recordAudit({
    actorId: user.id, action: "UPLOAD", module: MODULE_AUDIT, entityType: row.demandeType as TypeDemandeIntegree, entityId: row.demandeId,
    summary: `Pièces « ${attendues.find((a) => a.cle === cle)?.libelle} » : ${deposer.length} déposée(s), ${nouvellesRattachees.length} rattachée(s) (déjà dans la plateforme).`,
  });
  revaliderDemande(row.demandeType, row.demandeId);
  return { ok: true, message: [`${deposer.length} pièce(s) déposée(s)${nouvellesRattachees.length ? `, ${nouvellesRattachees.length} rattachée(s)` : ""}.`, ...messages].join(" ") };
}

/** RATTACHER une pièce déjà dans la plateforme (sur la demande, sur un poste, au registre) à une pièce attendue. */
export async function rattacherPieceIntegration(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const row = await demandeDuLot(user, fdStr(formData, "demandeRowId"));
  if (!row) return { ok: false, error: "Demande introuvable, ou vous ne pouvez pas y joindre de pièce." };
  const cle = fdStr(formData, "cle");
  const documentId = fdStr(formData, "documentId");
  if (!cle || !piecesAttenduesDe(row.piecesAttendues).some((a) => a.cle === cle)) return { ok: false, error: "Choisissez la pièce attendue." };
  const bloc = await blocHistoriqueDe(user, row.demandeType as TypeDemandeIntegree, row.demandeId);
  const piece = bloc?.rattachables.find((r) => r.documentId === documentId);
  if (!piece) return { ok: false, error: "Cette pièce n'est pas une pièce de cette demande ou de ses postes." };
  const rattachees = piecesRattacheesDe(row.piecesRattachees);
  const n = await prisma.adProIntegrationDemande.updateMany({
    where: { id: row.id, updatedAt: row.updatedAt },
    data: { piecesRattachees: [...rattachees, { cle, documentId: piece.documentId, nom: piece.nom, le: new Date().toISOString(), parId: user.id, source: piece.ou }] as unknown as object },
  });
  if (n.count !== 1) return { ok: false, error: "La demande vient d'être modifiée : rechargez, puis rattachez de nouveau." };
  await recordAudit({ actorId: user.id, action: "UPDATE", module: MODULE_AUDIT, entityType: row.demandeType as TypeDemandeIntegree, entityId: row.demandeId, summary: `Pièce « ${piece.nom} » rattachée (${piece.ou}) — jamais redéposée.` });
  revaliderDemande(row.demandeType, row.demandeId);
  return { ok: true, message: `« ${piece.nom} » rattachée.` };
}

/**
 * RELIER L'ÉCRITURE DE TRÉSORERIE qui a payé la dépense — par sa référence (FIN-…), en LECTURE SEULE : l'écriture n'est
 * ni modifiée ni réimputée, la demande affiche seulement son montant, sa date et l'écart avec la ligne du fichier. Une
 * référence vide délie.
 */
export async function relierEcritureIntegration(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const row = await demandeDuLot(user, fdStr(formData, "demandeRowId"));
  if (!row) return { ok: false, error: "Demande introuvable, ou vous ne pouvez pas la compléter." };
  const reference = fdStr(formData, "reference");
  const ecriture = reference ? await prisma.financeTransaction.findUnique({ where: { reference }, select: { id: true, direction: true, reference: true } }) : null;
  if (reference && !ecriture) return { ok: false, error: `Aucune écriture « ${reference} » au livre de trésorerie.` };
  if (ecriture && ecriture.direction !== "OUT") return { ok: false, error: "Cette écriture n'est pas une dépense." };
  const n = await prisma.adProIntegrationDemande.updateMany({ where: { id: row.id, updatedAt: row.updatedAt }, data: { ecritureId: ecriture?.id ?? null } });
  if (n.count !== 1) return { ok: false, error: "La demande vient d'être modifiée : rechargez, puis reliez de nouveau." };
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: MODULE_AUDIT, entityType: row.demandeType as TypeDemandeIntegree, entityId: row.demandeId,
    field: "ecriture", oldValue: row.ecritureId, newValue: ecriture?.id ?? null,
    summary: ecriture ? `Écriture ${ecriture.reference} reliée (lecture seule).` : "Écriture de trésorerie déliée.",
  });
  revaliderDemande(row.demandeType, row.demandeId);
  return { ok: true, message: ecriture ? `Écriture ${ecriture.reference} reliée — le livre de trésorerie n'est pas modifié.` : "Écriture déliée." };
}
