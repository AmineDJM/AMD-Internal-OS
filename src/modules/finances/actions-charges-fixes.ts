"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { hasRole, userCan, type SessionUser } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { getMyCompanies } from "@/lib/company";
import { fdNum, fdStr, type ActionResult } from "@/lib/actions/types";
import { CHEMIN_INFORMATIONS_SOCIETE } from "@/lib/chemins/finances";
import { annulable } from "@/lib/effets/ecran";
import {
  CLE_RESERVE_IMPREVUS, CODE_ENVELOPPE_ADMINISTRATION, lireSaisieCharge, peutLibererReserve, REFUS_RESERVE,
} from "./domaine/charges-fixes";
import { demanderPaiementEcheance, enregistrerCharge, retirerCharge } from "./infra/charges-fixes";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * « INFORMATIONS DE LA SOCIÉTÉ › LOCAUX & CHARGES FIXES » ET LE BUDGET DE L'ADMINISTRATION — les gestes (24/11/2026).
 *
 *   · saisir une charge : les Finances (Finances › Modifier) et qui tient la page (Legal › Modifier — l'assistante de
 *     direction) ; le budget de l'Administration de la société se recalcule ;
 *   · demander le paiement d'une échéance : les FINANCES seulement (elles paient chaque mois les charges fixes), facture
 *     jointe ; l'ordre naît par `createExpenseOrder` (origine `FIXED_CHARGE`) et part au centre de paiement ;
 *   · libérer la réserve pour imprévus vers une autre ligne : le DG ou le Super Admin seulement (règle serveur).
 * Toujours pour une société de son périmètre.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const REFUS_SAISIE = "Réservé aux Finances (« Finances › Modifier ») et à qui tient Informations de la société (« Legal › Modifier ») — un Super Admin l'accorde dans Administration › Accès.";
const REFUS_PAIEMENT = "Le paiement des charges fixes se demande par les Finances : demandez au responsable des finances de joindre la facture.";
const HORS_PERIMETRE = "Cette société n'est pas dans votre périmètre : demandez l'accès à un Super Admin (Administration › Accès).";

const peutSaisir = (u: SessionUser) => userCan(u, "FINANCES", "UPDATE") || userCan(u, "LEGAL", "UPDATE");
const estFinances = (u: SessionUser) => hasRole(u, "FINANCE_BUDGET_MANAGER") || u.role === "SUPER_ADMIN";

async function dansLePerimetre(userId: string, companyId: string | null): Promise<boolean> {
  return Boolean(companyId) && (await getMyCompanies(userId)).some((c) => c.id === companyId);
}

function revalider() {
  revalidatePath(CHEMIN_INFORMATIONS_SOCIETE);
  revalidatePath("/budgets");
  revalidatePath("/mon-espace");
}

/** Ajouter ou corriger une charge fixe d'une société. */
export async function enregistrerChargeFixe(formData: FormData): Promise<ActionResult & { id?: string }> { return annulable("charges-fixes-actions:enregistrerChargeFixe", "Enregistrer une charge fixe", async () => {
  const user = await requireUser();
  if (!peutSaisir(user)) return { ok: false, error: REFUS_SAISIE };
  const companyId = fdStr(formData, "companyId");
  if (!(await dansLePerimetre(user.id, companyId))) return { ok: false, error: HORS_PERIMETRE };
  const lu = lireSaisieCharge({
    site: fdStr(formData, "site"), nature: fdStr(formData, "nature"), libelle: fdStr(formData, "libelle"),
    beneficiaire: fdStr(formData, "beneficiaire"), rib: fdStr(formData, "rib"), legalDocumentId: fdStr(formData, "legalDocumentId"),
    modeMontant: fdStr(formData, "modeMontant"), montant: fdStr(formData, "montant"), periodicite: fdStr(formData, "periodicite"),
    jourEcheance: fdStr(formData, "jourEcheance"), moisEcheance: fdStr(formData, "moisEcheance"), dateDebut: fdStr(formData, "dateDebut"),
    dateFin: fdStr(formData, "dateFin"), echeanceFixe: fdStr(formData, "echeanceFixe"), notes: fdStr(formData, "notes"),
  });
  if (!lu.ok) return lu;
  const r = await enregistrerCharge({ companyId: companyId as string, id: fdStr(formData, "id"), saisie: lu.valeur, actorId: user.id });
  if (!r.ok) return r;
  revalider();
  return { ok: true, id: r.id, message: r.creee ? "Charge ajoutée — le budget de l'Administration est à jour." : "Charge enregistrée — le budget de l'Administration est à jour." };
}); }

/** Retirer une charge (fin de bail, contrat résilié) : plus d'échéance, l'historique reste. */
export async function retirerChargeFixe(formData: FormData): Promise<ActionResult> { return annulable("charges-fixes-actions:retirerChargeFixe", "Retirer une charge fixe", async () => {
  const user = await requireUser();
  if (!peutSaisir(user)) return { ok: false, error: REFUS_SAISIE };
  const id = fdStr(formData, "id");
  const charge = id ? await prisma.chargeFixeSociete.findUnique({ where: { id }, select: { companyId: true } }) : null;
  if (!id || !charge) return { ok: false, error: "Cette charge n'existe plus : rechargez la page." };
  if (!(await dansLePerimetre(user.id, charge.companyId))) return { ok: false, error: HORS_PERIMETRE };
  const r = await retirerCharge({ id, companyId: charge.companyId, actorId: user.id });
  if (!r.ok) return r;
  revalider();
  return { ok: true, message: "Charge retirée — plus aucune échéance ; le budget de l'Administration est à jour." };
}); }

/** Joindre la facture d'une échéance et en demander le paiement au centre de paiement. */
export async function demanderPaiementChargeFixe(formData: FormData): Promise<ActionResult & { reference?: string }> { return annulable("charges-fixes-actions:demanderPaiementChargeFixe", "Demander le paiement d'une charge fixe", async () => {
  const user = await requireUser();
  if (!estFinances(user)) return { ok: false, error: REFUS_PAIEMENT };
  const chargeId = fdStr(formData, "chargeId");
  const periode = fdStr(formData, "periode");
  const charge = chargeId ? await prisma.chargeFixeSociete.findUnique({ where: { id: chargeId }, select: { companyId: true, active: true } }) : null;
  if (!chargeId || !charge || !periode || !/^\d{4}-\d{2}$/.test(periode)) return { ok: false, error: "Échéance introuvable : rechargez la page." };
  if (!charge.active) return { ok: false, error: "Cette charge est retirée : réactivez-la (ou ajoutez-la de nouveau) avant d'en demander le paiement." };
  if (!(await dansLePerimetre(user.id, charge.companyId))) return { ok: false, error: HORS_PERIMETRE };
  const facture = formData.get("facture");
  if (!(facture instanceof File) || facture.size === 0) {
    return { ok: false, error: "Joignez la facture : sans justificatif, le paiement n'entre pas au centre de paiement." };
  }
  const montant = fdNum(formData, "montant");
  if (montant === null || !(montant > 0)) return { ok: false, error: "Indiquez le montant de la facture (lu sur la pièce)." };
  const r = await demanderPaiementEcheance({
    chargeId, companyId: charge.companyId, periode, montantFacture: Math.round(montant * 100) / 100, facture, actorId: user.id,
  });
  if (!r.ok) return r;
  revalider();
  revalidatePath("/centre-de-paiement");
  return { ok: true, reference: r.reference, message: `Paiement demandé (${r.reference}) — il attend la décision du centre de paiement.` };
}); }

/**
 * LIBÉRER LA RÉSERVE POUR IMPRÉVUS vers une autre ligne du même budget de l'Administration — le DG ou le Super Admin
 * seulement. La cession est conditionnelle (la réserve doit couvrir le montant au moment même de l'écriture).
 */
export async function libererReserveImprevus(formData: FormData): Promise<ActionResult> { return annulable("charges-fixes-actions:libererReserveImprevus", "Libérer la réserve pour imprévus", async () => {
  const user = await requireUser();
  if (!peutLibererReserve(user)) return { ok: false, error: REFUS_RESERVE };
  const envelopeId = fdStr(formData, "envelopeId");
  const cibleId = fdStr(formData, "cibleId");
  const montant = fdNum(formData, "montant");
  const motif = fdStr(formData, "motif");
  if (montant === null || !(montant > 0)) return { ok: false, error: "Indiquez le montant à libérer." };
  if (!motif) return { ok: false, error: "Dites pourquoi la réserve est libérée : le motif reste au journal." };
  const env = envelopeId ? await prisma.budgetEnvelope.findUnique({ where: { id: envelopeId }, select: { id: true, name: true, module: true, companyId: true } }) : null;
  if (!env || env.module !== CODE_ENVELOPPE_ADMINISTRATION) return { ok: false, error: "Budget de l'Administration introuvable : rechargez la page." };
  if (!(await dansLePerimetre(user.id, env.companyId))) return { ok: false, error: HORS_PERIMETRE };
  const [reserve, cible] = await Promise.all([
    prisma.budgetCategoryLine.findFirst({ where: { envelopeId: env.id, parentId: null, cle: CLE_RESERVE_IMPREVUS }, select: { id: true, allocated: true } }),
    cibleId ? prisma.budgetCategoryLine.findFirst({ where: { id: cibleId, envelopeId: env.id }, select: { id: true, name: true, cle: true } }) : null,
  ]);
  if (!reserve) return { ok: false, error: "Ce budget n'a pas de réserve pour imprévus." };
  if (!cible || cible.id === reserve.id) return { ok: false, error: "Choisissez la ligne du budget qui reçoit le montant libéré." };
  const fait = await prisma.$transaction(async (tx) => {
    const cede = await tx.budgetCategoryLine.updateMany({ where: { id: reserve.id, allocated: { gte: montant - 0.005 } }, data: { allocated: { decrement: montant } } });
    if (cede.count === 0) return false;
    await tx.budgetCategoryLine.update({ where: { id: cible.id }, data: { allocated: { increment: montant } } });
    return true;
  });
  if (!fait) return { ok: false, error: `La réserve ne couvre pas ${Math.round(montant).toLocaleString("fr-FR")} DZD : libérez au plus ce qu'elle porte.` };
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Budgets", entityType: "BUDGET", entityId: env.id, field: "reserve-imprevus",
    oldValue: "Réserve pour imprévus", newValue: `${cible.name} : ${montant}`,
    summary: `${env.name} : ${Math.round(montant).toLocaleString("fr-FR")} DZD libérés de la réserve pour imprévus vers « ${cible.name} » — ${motif}`,
  });
  revalider();
  return { ok: true, message: `Réserve libérée : ${Math.round(montant).toLocaleString("fr-FR")} DZD vers « ${cible.name} ».` };
}); }
