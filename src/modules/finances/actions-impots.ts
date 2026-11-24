"use server";

import { revalidatePath } from "next/cache";
import type { EcheanceFiscale, Prisma } from "@prisma/client";
import { requireUser, type CurrentUser } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { entitePermisePourFiche } from "@/lib/company";
import { deposerPieceDeModule, validateDocumentUpload } from "@/lib/storage";
import { fdStr, type ActionResult } from "@/lib/actions/types";
import { actionReversible } from "@/lib/effets/reversible";
import {
  AUCUNE_PROPOSITION, CENTRE_NON_DECIDE, decomposer, echeanceDeLaPeriode, estCompositionFiscale, etatDesOrdres, formatDzd, lireMontantFiscal,
  origineDuMontant, refusCorrectionEcheance, refusEnvoiEcheance, refusPreparationEcheance, refusQuittanceEcheance,
  refusRetraitEcheance, validerObligation, type CompositionFiscale, type EtatEcheance, type SaisiesFiscales,
} from "./domaine/impots";
import { libelleLigneBudget, repartirAuProrata, ventilationBudgetaire } from "./domaine/budget-impots";
import { lignesBudgetImpots, lignesMasseSalarialeParDepartement } from "./infra/budget-impots";
import { createExpenseOrder } from "./infra/expense-orders";
import { assurerLignesDuCalendrier, CHEMIN_IMPOTS, paieDuMois } from "./infra/impots";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * FINANCES › IMPÔTS & COTISATIONS — LES GESTES (maquette validée par le Super Admin, 24/11/2026).
 *
 * Préparer (brouillon), ENVOYER AU CENTRE DE PAIEMENT, retirer tant que le centre n'a pas décidé, corriger un refus,
 * joindre la quittance, ajouter un paiement ponctuel, régler le calendrier. La clé est `FINANCES_IMPOTS` (« Modifier » ;
 * « Créer » pour un ponctuel) ; chaque ligne est jugée sur SA société (`porteDeLaLigne`).
 *
 * L'ARGENT : l'ordre naît UNIQUEMENT par `createExpenseOrder` (bénéficiaire = l'organisme, source `TAX_PAYMENT`) ; le
 * centre décide (`decidePayment`), Banque & paiements paie (`settleExpenseOrder`) ; rien ici n'écrit l'autorisation, le
 * montant d'un ordre ni « payé ». Le JUSTIFICATIF est obligatoire : il se range sur l'ORDRE (un `Document` de l'ordre),
 * là où tout ordre porte sa pièce — le centre l'ouvre comme les autres.
 *
 * LE BUDGET (Super Admin, 24/11/2026, audit des dépenses) : la TVA et l'IBS s'imputent à l'enveloppe « Impôts & taxes »
 * de la société ; l'IRG et la CNAS à la MASSE SALARIALE des départements, au prorata des retenues de leurs fiches
 * (`domaine/budget-impots.ts`). Une imputation = un ordre : engagé tant qu'il n'est pas réglé, consommé au règlement,
 * comme toute enveloppe.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const MODULE_AUDIT = "Impôts & cotisations";
const REFUS_DROIT = "Préparer et envoyer les impôts et cotisations demande « Modifier » sur Impôts & cotisations — un Super Admin l'accorde dans Administration › Accès.";
const REFUS_SOCIETE = "Cette société n'est pas dans votre périmètre : demandez l'accès à la société au Super Admin.";

type Ligne = EcheanceFiscale;
interface OrdreLu { id: string; reference: string; status: string; centralStatus: string }
/** La ligne, TOUS les ordres de son envoi en cours (un par ligne du budget), le principal (pièce, quittance) et l'état. */
interface LigneLue { ligne: Ligne; ordres: OrdreLu[]; principal: OrdreLu | null; etat: EtatEcheance }

const idsDesOrdres = (l: Ligne): string[] => (l.ordresIds.length ? l.ordresIds : l.expenseOrderId ? [l.expenseOrderId] : []);

/** LA PORTE D'UNE LIGNE : le droit sur le module, et sa SOCIÉTÉ dans le périmètre de la personne. */
async function porteDeLaLigne(user: CurrentUser, id: string | null): Promise<LigneLue | ActionResult> {
  if (!userCan(user, "FINANCES_IMPOTS", "UPDATE")) return { ok: false, error: REFUS_DROIT };
  if (!id) return { ok: false, error: "Ligne introuvable." };
  const ligne = await prisma.echeanceFiscale.findUnique({ where: { id } });
  if (!ligne) return { ok: false, error: "Ligne introuvable : elle a peut-être été retirée. Rouvrez l'écran." };
  if (!(await entitePermisePourFiche(user.id, ligne.companyId))) return { ok: false, error: REFUS_SOCIETE };
  const ids = idsDesOrdres(ligne);
  const ordres = ids.length
    ? await prisma.expenseOrder.findMany({ where: { id: { in: ids } }, select: { id: true, reference: true, status: true, centralStatus: true } })
    : [];
  return { ligne, ordres, principal: ordres.find((o) => o.id === ligne.expenseOrderId) ?? ordres[0] ?? null, etat: etatDesOrdres(ordres) };
}
const estRefus = (x: LigneLue | ActionResult): x is ActionResult => "ok" in x;

/** Les saisies, telles que tapées — seulement des chaînes, seulement les clés connues (un brouillon n'invente rien). */
function lireSaisies(brut: string | null): SaisiesFiscales {
  let v: unknown = {};
  try { v = brut ? JSON.parse(brut) : {}; } catch { v = {}; }
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const s: SaisiesFiscales = {};
  for (const k of ["irg", "tva", "tvaC", "tvaD", "sal", "pat", "montant"] as const) if (typeof o[k] === "string") s[k] = (o[k] as string).slice(0, 40);
  if (Array.isArray(o.autres)) {
    s.autres = o.autres.slice(0, 20).map((a) => {
      const x = (a && typeof a === "object" ? a : {}) as Record<string, unknown>;
      return { libelle: typeof x.libelle === "string" ? x.libelle.slice(0, 120) : "", montant: typeof x.montant === "string" ? x.montant.slice(0, 40) : "" };
    });
  }
  return s;
}

const fichierDe = (formData: FormData, cle: string): File | null => {
  const f = formData.get(cle);
  return f instanceof File && f.size > 0 ? f : null;
};

function revalider() {
  revalidatePath(CHEMIN_IMPOTS);
  revalidatePath("/centre-de-paiement");
}

/**
 * L'ENVOI AU CENTRE — commun à une ligne du calendrier et à un paiement ponctuel. La ligne est PRISE d'abord (écriture
 * conditionnelle : un double clic n'émet pas deux ordres), puis l'ordre naît par l'unique écrivain, puis la pièce se
 * range sur l'ordre. Une erreur à la naissance de l'ordre rend la ligne : rien n'est parti.
 */
async function envoyerLaLigne(formData: FormData, user: CurrentUser, ligne: Ligne, surcharge?: SaisiesFiscales): Promise<ActionResult> {
  // porte d'écriture : la ligne a été ouverte par `porteDeLaLigne` (droit et société), ou créée à l'instant par l'appelant.
  const saisies = surcharge ?? lireSaisies(fdStr(formData, "saisies"));
  const fichier = fichierDe(formData, "justificatif");
  const composition: CompositionFiscale = estCompositionFiscale(ligne.composition) ? ligne.composition : "MONTANT";
  const paie = composition === "MONTANT" ? null : await paieDuMois(ligne.companyId, ligne.periode);
  const propositions = paie?.propositions ?? AUCUNE_PROPOSITION;
  const d = decomposer(composition, saisies, propositions);
  if (fichier) {
    const refusFichier = validateDocumentUpload(fichier.name, fichier.size);
    if (refusFichier) return { ok: false, error: refusFichier };
  }
  const refus = refusEnvoiEcheance({
    composition, decomposition: d, justificatif: Boolean(fichier || ligne.justificatifId), periodeLibelle: ligne.periodeLibelle, organisme: ligne.organisme,
  });
  if (refus) return { ok: false, error: refus };

  const maintenant = new Date();
  const prise = await prisma.echeanceFiscale.updateMany({
    where: { id: ligne.id, expenseOrderId: null, OR: [{ envoyeLe: null }, { envoyeLe: { lt: new Date(maintenant.getTime() - 120_000) } }] },
    data: { envoyeLe: maintenant, envoyeParId: user.id, saisies: saisies as Prisma.InputJsonValue },
  });
  if (prise.count === 0) return { ok: false, error: "Cette ligne vient d'être envoyée (double clic, ou par quelqu'un d'autre) : rouvrez-la avant de recommencer." };

  const lignesEnvoyees = d.lignes.filter((l) => !(l.cle.startsWith("autre") && l.montant === 0));
  const parts = ventilationBudgetaire(composition, lignesEnvoyees, ligne.nature, ligne.organisme);
  const notes = lignesEnvoyees.map((l) => `${l.label} : ${formatDzd(l.montant)} DZD — ${origineDuMontant(l)}`).join("\n");
  const libelle = `${ligne.nature} — ${ligne.periodeLibelle}`;

  // LES IMPUTATIONS (audit des dépenses, 24/11/2026) : la TVA et l'IBS à leur ligne d'« Impôts & taxes » ; l'IRG et la
  // CNAS à la MASSE SALARIALE des départements, au prorata des retenues que portent les fiches de leurs salariés ; une
  // autre ligne de la G50 reste à classer au règlement.
  const dateBudget = ligne.echeance ?? maintenant;
  const imputations: { libelle: string; montant: number; categoryId: string | null }[] = [];
  let fiches = paie?.base === "HORS_MOIS" ? null : paie?.fiches ?? null;
  try {
    const impots = parts.some((p) => p.cle === "TVA_NETTE" || p.cle === "IBS") ? await lignesBudgetImpots(ligne.companyId, dateBudget, user.id) : null;
    for (const part of parts) {
      if (part.cle === "TVA_NETTE" || part.cle === "IBS") {
        imputations.push({ libelle: libelleLigneBudget(part.cle), montant: part.montant, categoryId: impots?.get(part.cle) ?? null });
      } else if (part.cle === "MS_IRG" || part.cle === "MS_CNAS") {
        const cleMs = part.cle;
        if (!fiches) {
          const mois = /^\d{4}-\d{2}$/.test(ligne.periode ?? "") ? ligne.periode : `${maintenant.getUTCFullYear()}-${String(maintenant.getUTCMonth() + 1).padStart(2, "0")}`;
          fiches = (await paieDuMois(ligne.companyId, mois)).fiches;
        }
        const poidsDe = (f: (typeof fiches)[number]) => (cleMs === "MS_IRG" ? f.retIrg ?? 0 : (f.retSS9 ?? 0) + (f.partPatronale ?? 0));
        const msParDep = await lignesMasseSalarialeParDepartement(
          ligne.companyId, dateBudget, fiches.map((f) => f.departmentId).filter((x): x is string => Boolean(x)),
        );
        const parCategorie = new Map<string | null, { poids: number; enveloppe: string | null }>();
        for (const f of fiches) {
          const ms = f.departmentId ? msParDep.get(f.departmentId) : undefined;
          const cat = ms?.lignes.get(cleMs) ?? null;
          const acc = parCategorie.get(cat) ?? { poids: 0, enveloppe: ms?.enveloppe ?? null };
          acc.poids += poidsDe(f);
          parCategorie.set(cat, acc);
        }
        for (const r of repartirAuProrata(part.montant, [...parCategorie.entries()].map(([cle, v]) => ({ cle, poids: v.poids })))) {
          const env = r.cle ? parCategorie.get(r.cle)?.enveloppe : null;
          imputations.push({ libelle: `${libelleLigneBudget(cleMs)} · ${env ?? "à classer au règlement"}`, montant: r.montant, categoryId: r.cle });
        }
      } else {
        imputations.push({ libelle: "Autres lignes — à classer au règlement", montant: part.montant, categoryId: null });
      }
    }
  } catch (e) {
    console.error("[impots] imputation budgétaire non lue", e);
    await prisma.echeanceFiscale.updateMany({ where: { id: ligne.id, expenseOrderId: null }, data: { envoyeLe: null, envoyeParId: null } });
    return { ok: false, error: "Le budget de cette échéance n'a pas pu être lu : rien n'est parti au centre. Réessayez dans un instant." };
  }

  // UN ORDRE PAR IMPUTATION, tous par l'unique écrivain ; le plus gros est le principal (pièce, quittance).
  const ordres: { id: string; reference: string; montant: number; cle: string }[] = [];
  try {
    for (const imp of [...imputations].sort((a, b) => b.montant - a.montant)) {
      const o = await createExpenseOrder({
        label: imputations.length > 1 ? `${libelle} · ${imp.libelle}` : libelle,
        amount: imp.montant, category: "IMPOT", beneficiary: ligne.organisme,
        sourceType: "TAX_PAYMENT", sourceId: ligne.id, companyId: ligne.companyId, requestedById: user.id,
        dueDate: ligne.echeance, deadlineNature: "FIXED", requiresInvoice: false, budgetCategoryId: imp.categoryId,
        notes: imputations.length > 1 ? `${notes}\nPart imputée ici (${imp.libelle}) : ${formatDzd(imp.montant)} DZD sur ${formatDzd(d.total)} DZD.` : notes,
      });
      ordres.push({ id: o.id, reference: o.reference, montant: imp.montant, cle: imp.libelle });
    }
  } catch (e) {
    console.error("[impots] ordre non émis", e);
    // Rien ne reste à moitié parti : les ordres déjà émis de cet envoi sont annulés, la ligne est rendue.
    if (ordres.length) await prisma.expenseOrder.updateMany({ where: { id: { in: ordres.map((o) => o.id) }, status: "PENDING" }, data: { status: "CANCELLED" } });
    await prisma.echeanceFiscale.updateMany({ where: { id: ligne.id, expenseOrderId: null }, data: { envoyeLe: null, envoyeParId: null } });
    return { ok: false, error: "L'ordre de paiement n'a pas pu être créé : rien n'est parti au centre. Réessayez dans un instant." };
  }
  const principal = ordres[0]!;

  // LA PIÈCE SUR CHAQUE ORDRE : un fichier neuf s'y dépose ; celui d'un envoi retiré suit le principal (une pièce par
  // ordre, comme tout ordre — le centre et la banque l'ouvrent depuis l'ordre qu'ils ont sous les yeux).
  let justificatifId = ligne.justificatifId;
  let justificatifNom = ligne.justificatifNom;
  for (const [n, o] of ordres.entries()) {
    if (fichier) {
      const id = (await deposerPieceDeModule(fichier, {
        entityType: "EXPENSE_ORDER", entityId: o.id, category: "SUPPORTING_DOC", confidentiality: "INTERNAL", uploadedById: user.id, journal: "impots",
      })).id;
      if (n === 0) { justificatifId = id; justificatifNom = fichier.name; }
    } else if (justificatifId) {
      const piece = await prisma.document.findUnique({ where: { id: justificatifId }, select: { name: true, fileKey: true, mimeType: true, sizeBytes: true } });
      if (n === 0) await prisma.document.updateMany({ where: { id: justificatifId }, data: { entityType: "EXPENSE_ORDER", entityId: o.id } });
      else if (piece) {
        await prisma.document.create({
          data: { ...piece, category: "SUPPORTING_DOC", entityType: "EXPENSE_ORDER", entityId: o.id, confidentiality: "INTERNAL", uploadedById: user.id },
        });
      }
    }
  }

  await prisma.echeanceFiscale.updateMany({
    where: { id: ligne.id, expenseOrderId: null },
    data: {
      expenseOrderId: principal.id, ordresIds: ordres.map((o) => o.id), montant: d.total, justificatifId, justificatifNom, motifRefusPrecedent: null,
      propositions: propositions as unknown as Prisma.InputJsonValue,
      decomposition: lignesEnvoyees.map((l) => ({ cle: l.cle, label: l.label, source: l.source, montant: l.montant, propose: l.propose, origine: origineDuMontant(l) })) as Prisma.InputJsonValue,
    },
  });
  const references = ordres.map((o) => o.reference).join(", ");
  await recordAudit({
    actorId: user.id, action: "CREATE", module: MODULE_AUDIT, entityType: "TAX_PAYMENT", entityId: ligne.id,
    summary: `${libelle} envoyée au centre de paiement : ${references} (${formatDzd(d.total)} DZD — ${ordres.map((o) => `${o.cle} ${formatDzd(o.montant)}`).join(", ")}), justificatif ${justificatifNom ?? "joint"}`,
  });
  // L'ÉCART AVEC LA PROPOSITION, TRACÉ : proposé, envoyé, l'auteur et la date restent dans l'historique.
  for (const l of d.lignes.filter((x) => x.modifie)) {
    await recordAudit({
      actorId: user.id, action: "UPDATE", module: MODULE_AUDIT, entityType: "TAX_PAYMENT", entityId: ligne.id, field: l.label,
      oldValue: String(l.propose), newValue: String(l.montant),
      summary: `${l.label} corrigé avant l'envoi : proposé ${formatDzd(l.propose)} → envoyé ${formatDzd(l.montant)} DZD`,
    });
  }
  revalider();
  return { ok: true, id: ligne.id, message: `Envoyé au centre de paiement : ${ligne.nature} · ${ligne.periodeLibelle} · ${formatDzd(d.total)} DZD (${references}). La ligne passe « Au centre de paiement ».` };
}

/** ENREGISTRER LE BROUILLON — les saisies sont gardées, rien ne part. */
export async function enregistrerBrouillonImpot(formData: FormData): Promise<ActionResult> {
  return actionReversible("impots-cotisations-actions:enregistrerBrouillonImpot", "Enregistrer le brouillon d'une échéance", async () => {
    const user = await requireUser();
    if (!userCan(user, "FINANCES_IMPOTS", "UPDATE")) return { ok: false, error: REFUS_DROIT };
    const lu = await porteDeLaLigne(user, fdStr(formData, "id"));
    if (estRefus(lu)) return lu;
    const refus = refusPreparationEcheance(lu.etat);
    if (refus) return { ok: false, error: refus };
    const saisies = lireSaisies(fdStr(formData, "saisies"));
    const ecrit = await prisma.echeanceFiscale.updateMany({ where: { id: lu.ligne.id, expenseOrderId: null }, data: { saisies: saisies as Prisma.InputJsonValue } });
    if (ecrit.count === 0) return { ok: false, error: "Cette ligne vient de partir au centre de paiement : rouvrez-la." };
    await recordAudit({ actorId: user.id, action: "UPDATE", module: MODULE_AUDIT, entityType: "TAX_PAYMENT", entityId: lu.ligne.id, summary: `Brouillon enregistré — ${lu.ligne.nature} · ${lu.ligne.periodeLibelle}` });
    revalidatePath(CHEMIN_IMPOTS);
    return { ok: true, id: lu.ligne.id, message: "Brouillon enregistré — rien n'est envoyé au centre de paiement." };
  });
}

/** ENVOYER AU CENTRE DE PAIEMENT — une ligne du calendrier, avec son justificatif. */
export async function envoyerImpotAuCentre(formData: FormData): Promise<ActionResult> {
  return actionReversible("impots-cotisations-actions:envoyerImpotAuCentre", "Envoyer une échéance au centre de paiement", async () => {
    const user = await requireUser();
    if (!userCan(user, "FINANCES_IMPOTS", "UPDATE")) return { ok: false, error: REFUS_DROIT };
    const lu = await porteDeLaLigne(user, fdStr(formData, "id"));
    if (estRefus(lu)) return lu;
    const refus = refusPreparationEcheance(lu.etat);
    if (refus) return { ok: false, error: refus };
    return envoyerLaLigne(formData, user, lu.ligne);
  });
}

/** RETIRER LA DEMANDE — tant que le centre n'a pas décidé : l'ordre est annulé, la ligne revient « À préparer ». */
export async function retirerImpotDuCentre(formData: FormData): Promise<ActionResult> {
  return actionReversible("impots-cotisations-actions:retirerImpotDuCentre", "Retirer une échéance du centre de paiement", async () => {
    const user = await requireUser();
    if (!userCan(user, "FINANCES_IMPOTS", "UPDATE")) return { ok: false, error: REFUS_DROIT };
    const lu = await porteDeLaLigne(user, fdStr(formData, "id"));
    if (estRefus(lu)) return lu;
    const refus = refusRetraitEcheance(lu.etat);
    const vivants = lu.ordres.filter((o) => o.status !== "CANCELLED");
    if (refus || vivants.length === 0) return { ok: false, error: refus ?? "Rien à retirer." };
    if (vivants.some((o) => !(CENTRE_NON_DECIDE as readonly string[]).includes(o.centralStatus))) {
      return { ok: false, error: "Le centre de paiement a déjà décidé sur une partie de cette demande : elle ne se retire plus d'ici." };
    }
    // Conditionnelle sur l'autorisation LUE, ordre par ordre : un centre qui décide à la même seconde garde sa décision.
    const annules: OrdreLu[] = [];
    for (const o of vivants) {
      const a = await prisma.expenseOrder.updateMany({ where: { id: o.id, status: "PENDING", centralStatus: { in: [...CENTRE_NON_DECIDE] } }, data: { status: "CANCELLED" } });
      if (a.count === 1) annules.push(o);
    }
    if (annules.length !== vivants.length) {
      // Le centre a tranché sur une part pendant le retrait : on rétablit ce qu'on venait d'annuler, rien n'est retiré.
      await prisma.expenseOrder.updateMany({ where: { id: { in: annules.map((o) => o.id) }, status: "CANCELLED" }, data: { status: "PENDING" } });
      return { ok: false, error: "Le centre de paiement vient de décider sur cette demande : rouvrez la ligne." };
    }
    await prisma.paymentRequest.updateMany({ where: { expenseOrderId: { in: annules.map((o) => o.id) }, origin: "EXPENSE_ORDER", status: "SUBMITTED" }, data: { status: "CANCELLED" } });
    await prisma.echeanceFiscale.updateMany({ where: { id: lu.ligne.id, expenseOrderId: lu.ligne.expenseOrderId }, data: { expenseOrderId: null, ordresIds: [], envoyeLe: null, envoyeParId: null, montant: null } });
    const references = annules.map((o) => o.reference).join(", ");
    for (const o of annules) {
      await recordAudit({
        actorId: user.id, action: "UPDATE", module: "Finances", entityType: "EXPENSE_ORDER", entityId: o.id, field: "status", newValue: "CANCELLED",
        summary: `Ordre de dépense ${o.reference} annulé — demande retirée du centre par les Finances (Impôts & cotisations)`,
      });
    }
    await recordAudit({ actorId: user.id, action: "UPDATE", module: MODULE_AUDIT, entityType: "TAX_PAYMENT", entityId: lu.ligne.id, summary: `${lu.ligne.nature} — ${lu.ligne.periodeLibelle} retirée du centre de paiement (${references})` });
    revalider();
    return { ok: true, id: lu.ligne.id, message: "Demande retirée du centre de paiement — la ligne revient « À préparer »." };
  });
}

/** CORRIGER ET RENVOYER — un refus du centre : la ligne revient « À préparer », le motif reste sous les yeux. */
export async function corrigerImpotRefuse(formData: FormData): Promise<ActionResult> {
  return actionReversible("impots-cotisations-actions:corrigerImpotRefuse", "Reprendre une échéance refusée", async () => {
    const user = await requireUser();
    if (!userCan(user, "FINANCES_IMPOTS", "UPDATE")) return { ok: false, error: REFUS_DROIT };
    const lu = await porteDeLaLigne(user, fdStr(formData, "id"));
    if (estRefus(lu)) return lu;
    const refus = refusCorrectionEcheance(lu.etat);
    if (refus || lu.ordres.length === 0) return { ok: false, error: refus ?? "Rien à corriger." };
    if (lu.ordres.some((o) => o.status === "PAID")) {
      return { ok: false, error: "Une partie de cette demande est déjà payée : voyez Banque & paiements avant de la reprendre." };
    }
    const refuses = lu.ordres.filter((o) => o.centralStatus === "REFUSED");
    const motif = (await prisma.paymentCentreMessage.findFirst({ where: { orderId: { in: refuses.map((o) => o.id) }, decision: "REFUSE" }, orderBy: { createdAt: "desc" }, select: { body: true } }))?.body ?? null;
    // Les ordres refusés restent tels quels (l'histoire du centre) ; les autres parts du même envoi, non payées, sont
    // annulées : la G50 repart ENTIÈRE, corrigée.
    const autres = lu.ordres.filter((o) => o.centralStatus !== "REFUSED" && o.status !== "CANCELLED");
    if (autres.length) {
      await prisma.expenseOrder.updateMany({ where: { id: { in: autres.map((o) => o.id) }, status: { in: ["PENDING", "REVISION_REQUESTED"] } }, data: { status: "CANCELLED" } });
      await prisma.paymentRequest.updateMany({ where: { expenseOrderId: { in: autres.map((o) => o.id) }, origin: "EXPENSE_ORDER", status: "SUBMITTED" }, data: { status: "CANCELLED" } });
    }
    const ecrit = await prisma.echeanceFiscale.updateMany({
      where: { id: lu.ligne.id, expenseOrderId: lu.ligne.expenseOrderId },
      data: { expenseOrderId: null, ordresIds: [], envoyeLe: null, envoyeParId: null, montant: null, motifRefusPrecedent: motif },
    });
    if (ecrit.count === 0) return { ok: false, error: "Cette ligne vient de changer : rouvrez-la." };
    await recordAudit({ actorId: user.id, action: "UPDATE", module: MODULE_AUDIT, entityType: "TAX_PAYMENT", entityId: lu.ligne.id, summary: `${lu.ligne.nature} — ${lu.ligne.periodeLibelle} reprise après le refus de ${refuses.map((o) => o.reference).join(", ")}` });
    revalidatePath(CHEMIN_IMPOTS);
    return { ok: true, id: lu.ligne.id, message: "La ligne revient « À préparer » : corrigez-la, puis renvoyez-la." };
  });
}

/** JOINDRE LA QUITTANCE — une fois payé, la quittance de l'organisme se range sur l'ordre et complète la ligne. */
export async function joindreQuittanceImpot(formData: FormData): Promise<ActionResult> {
  return actionReversible("impots-cotisations-actions:joindreQuittanceImpot", "Joindre la quittance d'une échéance", async () => {
    const user = await requireUser();
    if (!userCan(user, "FINANCES_IMPOTS", "UPDATE")) return { ok: false, error: REFUS_DROIT };
    const lu = await porteDeLaLigne(user, fdStr(formData, "id"));
    if (estRefus(lu)) return lu;
    const refus = refusQuittanceEcheance(lu.etat);
    if (refus || !lu.principal) return { ok: false, error: refus ?? "Ligne non payée." };
    const fichier = fichierDe(formData, "quittance");
    if (!fichier) return { ok: false, error: "Choisissez le fichier de la quittance (PDF ou image)." };
    const refusFichier = validateDocumentUpload(fichier.name, fichier.size);
    if (refusFichier) return { ok: false, error: refusFichier };
    const numero = fdStr(formData, "numero")?.slice(0, 60) ?? null;
    const doc = await deposerPieceDeModule(fichier, {
      entityType: "EXPENSE_ORDER", entityId: lu.principal.id, category: "PAYMENT_RECEIPT", confidentiality: "INTERNAL", uploadedById: user.id, journal: "impots",
    });
    await prisma.echeanceFiscale.updateMany({ where: { id: lu.ligne.id, expenseOrderId: lu.principal.id }, data: { quittanceId: doc.id, quittanceNumero: numero } });
    await recordAudit({ actorId: user.id, action: "UPLOAD", module: MODULE_AUDIT, entityType: "TAX_PAYMENT", entityId: lu.ligne.id, summary: `Quittance${numero ? ` n° ${numero}` : ""} jointe — ${lu.ligne.nature} · ${lu.ligne.periodeLibelle} (${lu.principal.reference})` });
    revalidatePath(CHEMIN_IMPOTS);
    return { ok: true, id: lu.ligne.id, message: `Quittance${numero ? ` n° ${numero}` : ""} jointe : la ligne est complète.` };
  });
}

/**
 * UN PAIEMENT PONCTUEL (taxe foncière, pénalité, régularisation…) — hors calendrier : un montant tel que sur le
 * justificatif, sous le nom de qui le saisit. Avec `id`, c'est la CORRECTION d'un ponctuel refusé puis repris.
 */
export async function envoyerPaiementPonctuel(formData: FormData): Promise<ActionResult> {
  return actionReversible("impots-cotisations-actions:envoyerPaiementPonctuel", "Envoyer un paiement ponctuel au centre de paiement", async () => {
    const user = await requireUser();
    const organisme = fdStr(formData, "organisme")?.slice(0, 120) ?? "";
    const nature = fdStr(formData, "nature")?.slice(0, 200) ?? "";
    const periodeLibelle = fdStr(formData, "periode")?.slice(0, 80) ?? "—";
    const companyId = fdStr(formData, "companyId");
    const montant = fdStr(formData, "montant") ?? "";
    if (!organisme || !nature || !(lireMontantFiscal(montant) ?? 0)) return { ok: false, error: "Indiquez au moins l'organisme, la nature et le montant." };
    if (!companyId) return { ok: false, error: "Choisissez la société qui paie." };
    const fichier = fichierDe(formData, "justificatif");
    const id = fdStr(formData, "id");

    let ligne: Ligne;
    if (id) {
      const lu = await porteDeLaLigne(user, id);
      if (estRefus(lu)) return lu;
      const refus = refusPreparationEcheance(lu.etat);
      if (refus) return { ok: false, error: refus };
      if (lu.ligne.obligationId) return { ok: false, error: "Cette ligne vient du calendrier : préparez-la depuis la liste." };
      if (!(await entitePermisePourFiche(user.id, companyId))) return { ok: false, error: REFUS_SOCIETE };
      await prisma.echeanceFiscale.updateMany({ where: { id: lu.ligne.id, expenseOrderId: null }, data: { organisme, nature, periodeLibelle, companyId } });
      ligne = { ...lu.ligne, organisme, nature, periodeLibelle, companyId };
    } else {
      if (!userCan(user, "FINANCES_IMPOTS", "CREATE")) return { ok: false, error: "Ajouter un paiement ponctuel demande « Créer » sur Impôts & cotisations — un Super Admin l'accorde dans Administration › Accès." };
      if (!fichier) return { ok: false, error: "Le justificatif est obligatoire : avis d'imposition, bordereau ou lettre de l'organisme." };
      if (!(await entitePermisePourFiche(user.id, companyId))) return { ok: false, error: REFUS_SOCIETE };
      const societe = await prisma.company.findFirst({ where: { id: companyId, isActive: true }, select: { id: true } });
      if (!societe) return { ok: false, error: "Société introuvable ou désactivée." };
      ligne = await prisma.echeanceFiscale.create({
        data: { companyId, organisme, nature, composition: "MONTANT", periodeLibelle, createdById: user.id },
      });
    }
    const saisiesPonctuel: SaisiesFiscales = { montant };
    return envoyerLaLigne(formData, user, ligne, saisiesPonctuel);
  });
}

interface ObligationRecue { id?: string; companyId?: string; organisme?: string; nature?: string; composition?: string; periodicite?: string; jour?: string; mois?: string; rappel?: boolean; confirme?: boolean }

/**
 * ENREGISTRER LE CALENDRIER — chaque société, ses obligations : organisme, nature, composition, périodicité, jour limite,
 * rappel J-7, et la CONFIRMATION du jour par les Finances. Une ligne retirée ne fait plus naître de période (ses lignes
 * passées restent). Les lignes encore « À préparer » prennent le nouveau jour ; la période en cours naît aussitôt.
 */
export async function enregistrerCalendrierFiscal(formData: FormData): Promise<ActionResult> {
  return actionReversible("impots-cotisations-actions:enregistrerCalendrierFiscal", "Enregistrer le calendrier des échéances", async () => {
    const user = await requireUser();
    if (!userCan(user, "FINANCES_IMPOTS", "UPDATE")) return { ok: false, error: REFUS_DROIT };
    let recues: ObligationRecue[] = [];
    let retirees: string[] = [];
    try {
      recues = JSON.parse(fdStr(formData, "lignes") ?? "[]") as ObligationRecue[];
      retirees = JSON.parse(fdStr(formData, "retirees") ?? "[]") as string[];
    } catch {
      return { ok: false, error: "Calendrier illisible : rouvrez l'écran." };
    }
    if (!Array.isArray(recues) || !Array.isArray(retirees) || recues.length > 200) return { ok: false, error: "Calendrier illisible : rouvrez l'écran." };

    const valides: { id?: string; companyId: string; donnees: Omit<Prisma.ObligationFiscaleUncheckedCreateInput, "companyId">; confirme: boolean }[] = [];
    const societes = new Set<string>();
    for (const r of recues) {
      if (!r.companyId || !(await entitePermisePourFiche(user.id, r.companyId))) return { ok: false, error: REFUS_SOCIETE };
      const v = validerObligation({ organisme: r.organisme ?? "", nature: r.nature ?? "", composition: r.composition ?? "", periodicite: r.periodicite ?? "", jour: r.jour ?? "", mois: r.mois ?? "" });
      if (!v.ok) return { ok: false, error: v.error };
      if (r.confirme && v.jourLimite === null && v.periodicite !== "SELON_AVIS") return { ok: false, error: `Renseignez d'abord le jour limite de « ${v.nature} » avant de le confirmer.` };
      valides.push({
        id: r.id, companyId: r.companyId, confirme: Boolean(r.confirme),
        donnees: { organisme: v.organisme, nature: v.nature, composition: v.composition, periodicite: v.periodicite, jourLimite: v.jourLimite, moisLimite: v.moisLimite, rappel: r.rappel !== false },
      });
      societes.add(r.companyId);
    }

    const maintenant = new Date();
    let changees = 0;
    for (const v of valides) {
      if (v.id) {
        const avant = await prisma.obligationFiscale.findUnique({ where: { id: v.id } });
        if (!avant || avant.retireeLe) continue;
        if (!(await entitePermisePourFiche(user.id, avant.companyId))) return { ok: false, error: REFUS_SOCIETE };
        const jourChange = avant.jourLimite !== v.donnees.jourLimite || avant.moisLimite !== v.donnees.moisLimite;
        const confirmation = v.confirme
          ? (avant.jourConfirmeLe && !jourChange ? {} : { jourConfirmeLe: maintenant, jourConfirmeParId: user.id })
          : { jourConfirmeLe: null, jourConfirmeParId: null };
        await prisma.obligationFiscale.updateMany({ where: { id: v.id, retireeLe: null }, data: { ...v.donnees, companyId: v.companyId, ...confirmation } });
        if (jourChange || avant.periodicite !== v.donnees.periodicite) await realignerEcheances(v.id);
        changees += 1;
      } else {
        await prisma.obligationFiscale.create({
          data: { ...v.donnees, companyId: v.companyId, createdById: user.id, ...(v.confirme ? { jourConfirmeLe: maintenant, jourConfirmeParId: user.id } : {}) },
        });
        changees += 1;
      }
    }
    for (const id of retirees.filter((x) => typeof x === "string").slice(0, 200)) {
      const o = await prisma.obligationFiscale.findUnique({ where: { id }, select: { companyId: true } });
      if (!o || !(await entitePermisePourFiche(user.id, o.companyId))) continue;
      await prisma.obligationFiscale.updateMany({ where: { id, retireeLe: null }, data: { retireeLe: maintenant } });
      changees += 1;
    }
    const creees = await assurerLignesDuCalendrier(maintenant, [...societes]);
    await recordAudit({
      actorId: user.id, action: "UPDATE", module: MODULE_AUDIT,
      summary: `Calendrier des échéances enregistré — ${changees} échéance(s) modifiée(s) ou retirée(s), ${creees} ligne(s) de période créée(s)`,
    });
    revalidatePath(CHEMIN_IMPOTS);
    const aConfirmer = valides.filter((v) => !v.confirme).length;
    return {
      ok: true,
      message: `Calendrier enregistré.${creees ? ` ${creees} ligne(s) « À préparer » créée(s).` : ""}${aConfirmer ? ` ${aConfirmer} échéance(s) restent « à confirmer ».` : " Tous les jours limites sont confirmés."}`,
    };
  });
}

/** Les lignes encore à préparer d'une obligation prennent son nouveau jour limite (celles parties gardent le leur). */
async function realignerEcheances(obligationId: string): Promise<void> {
  const o = await prisma.obligationFiscale.findUnique({ where: { id: obligationId }, select: { jourLimite: true, moisLimite: true } });
  if (!o) return;
  const lignes = await prisma.echeanceFiscale.findMany({ where: { obligationId, expenseOrderId: null }, select: { id: true, periode: true } });
  for (const l of lignes) {
    // porte d'écriture : la ligne appartient à l'obligation que l'appelant vient d'ouvrir (société vérifiée plus haut).
    await prisma.echeanceFiscale.updateMany({ where: { id: l.id, expenseOrderId: null }, data: { echeance: echeanceDeLaPeriode(l.periode, o.jourLimite, o.moisLimite), rappelEnvoyeLe: null } });
  }
}
