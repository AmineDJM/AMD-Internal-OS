/**
 * DEMANDES ADMINISTRATIVES — le TRAITEMENT par le secrétariat : les demandes de validation composées (Finances,
 * interne, pièce jointe), la pièce à soumettre, ce qui retient la fin d'une demande, l'imputation aux moyens
 * généraux, et les paiements encore en vol.
 *
 * Sorti de `actions/admin-request-actions.ts` (lot V4). Les gardes, les lectures du formulaire et l'appel de
 * l'écrivain des validations restent dans les actions ; ici on compose ce qu'on lui passe.
 */
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import type { createDirectValidation } from "@/lib/validation";
import { refusFinApresDecision, refusFinDevisPromo } from "@/lib/secretariat/traitement";
import { etatsDesBC } from "@/lib/bons-de-commande/etat";
import { refusFinBCEnRoute } from "@/lib/secretariat/devis-natif";

/** Ce que l'écrivain des validations reçoit. */
type DemandeDeValidation = Parameters<typeof createDirectValidation>[0];

/** Les responsables Finances actifs — les validateurs d'un achat quand le formulaire n'en nomme aucun. */
export async function responsablesFinances(): Promise<string[]> {
  const finance = await prisma.user.findMany({ where: { isActive: true, role: "FINANCE_BUDGET_MANAGER" }, select: { id: true } });
  return finance.map((f) => f.id);
}

/** « Demande de validation des Finances » (flux achat), rattachée à la demande. */
export function validationFinances(
  requesterId: string, id: string, req: { reference: string; title: string }, note: string | null, amount: number | null,
  validatorIds: string[],
): DemandeDeValidation {
  return {
    requesterId,
    title: `Achat — ${req.reference} : ${req.title}`,
    description: [note, amount ? `Montant estimé : ${amount.toLocaleString("fr-FR")} DZD` : null].filter(Boolean).join(" — ") || null,
    module: "Finances",
    link: `/demandes/${id}`,
    validatorIds,
    entityType: "ADMIN_REQUEST",
    entityId: id,
  };
}

/** « Demander une validation » (flux hors achat), rattachée à la demande. */
export function validationInterne(
  requesterId: string, id: string, req: { reference: string; title: string }, description: string | null, validatorIds: string[],
): DemandeDeValidation {
  return {
    requesterId,
    title: `${req.reference} : ${req.title}`,
    description,
    module: "Bureau du secrétariat",
    link: `/demandes/${id}`,
    validatorIds,
    entityType: "ADMIN_REQUEST",
    entityId: id,
  };
}

/** La pièce de CETTE demande, et aucune validation déjà en cours sur elle. */
export async function pieceASoumettre(
  requestId: string, documentId: string,
): Promise<{ ok: true; doc: { id: string; name: string } } | { ok: false; error: string }> {
  const doc = await prisma.document.findFirst({
    where: { id: documentId, entityType: "ADMIN_REQUEST", entityId: requestId },
    select: { id: true, name: true },
  });
  if (!doc) return { ok: false, error: "Cette pièce n'appartient pas à la demande." };

  // Pas deux validations EN COURS sur la même pièce : la seconde sèmerait la confusion sur
  // laquelle fait foi. Une pièce refusée peut en revanche être resoumise (nouvelle version).
  const pending = await prisma.validationRequest.count({
    where: { documentId: doc.id, entityType: "ADMIN_REQUEST", entityId: requestId, status: "PENDING" },
  });
  if (pending > 0) return { ok: false, error: "Cette pièce est déjà en cours de validation." };
  return { ok: true, doc };
}

/** La validation d'UNE pièce jointe, en parallèle, au bureau central. */
export function validationDeLaPiece(
  requesterId: string, req: { id: string; reference: string; title: string }, doc: { id: string; name: string },
  note: string, validatorIds: string[], amount: number | null, category: string | null,
): DemandeDeValidation {
  return {
    requesterId,
    title: `Pièce jointe « ${doc.name} » — ${req.reference}`,
    description: note || `Validation de la pièce « ${doc.name} » de la demande ${req.reference} — ${req.title}.`,
    link: `/demandes/${req.id}`,
    module: "Bureau du secrétariat",
    entityType: "ADMIN_REQUEST",
    entityId: req.id,
    documentId: doc.id,
    mode: "PARALLEL",
    validatorIds,
    amount,
    category,
    // Se choisir soi-même comme validateur est PERMIS ici quand la pièce n'est pas chiffrée : la validation
    // est alors un avis, pas un circuit hiérarchique — sans cela, le choix s'évaporait et l'écran réclamait
    // « au moins un validateur » alors qu'on venait d'en saisir un. Chiffrée, elle émet un paiement : la
    // règle ci-dessus (`refusValidateursPieceChiffree`) a déjà refusé tout validateur intéressé.
    allowSelf: !(amount !== null && amount > 0),
  };
}

/** La validation de pièce à retirer, avec ses marches. */
export async function validationDePiece(validationId: string) {
  return prisma.validationRequest.findFirst({
    where: { id: validationId, entityType: "ADMIN_REQUEST", documentId: { not: null } },
    select: {
      id: true, reference: true, title: true, status: true, requesterId: true, entityId: true,
      version: true, mode: true, currentOrder: true,
      steps: { select: { validatorId: true, status: true, order: true } },
    },
  });
}

/** L'ordre de dépense encore en vol d'une demande close — il en retient la suppression. */
export async function paiementEnVol(requestId: string): Promise<{ reference: string } | null> {
  return prisma.expenseOrder.findFirst({
    where: { sourceType: "ADMIN_REQUEST", sourceId: requestId, status: { notIn: ["CANCELLED", "PAID"] } }, select: { reference: true },
  });
}

/**
 * CE QUI RETIENT LA FIN D'UNE DEMANDE : la dernière décision du validateur, le dossier promotionnel d'une demande de
 * devis, un bon de commande encore en route. `null` = rien ne la retient.
 */
export async function refusAvantLaFin(
  id: string, req: { linkedEntityType: string | null; linkedEntityId: string | null; type: string },
): Promise<string | null> {
  // LA DERNIÈRE DÉCISION DU VALIDATEUR FAIT FOI (audit du 14/10/2026) : un achat refusé ne se termine pas (il
  // s'imputait au budget), un achat renvoyé pour modification ne s'achète pas avant d'être revalidé.
  const derniere = await prisma.adminApproval.findFirst({ where: { requestId: id }, orderBy: { createdAt: "desc" }, select: { status: true } });
  const apresDecision = refusFinApresDecision(derniere);
  if (apresDecision) return apresDecision;
  if (req.linkedEntityType === "PROMO_MATERIAL" && req.linkedEntityId && req.type === "QUOTE") {
    const dossier = await prisma.promoMaterial.findUnique({ where: { id: req.linkedEntityId }, select: { circuitState: true } });
    const devisPromo = refusFinDevisPromo(dossier?.circuitState ?? null);
    if (devisPromo) return devisPromo;
  }

  // « TERMINER » ATTEND LA SIGNATURE DU BC (devis natifs, Direction 10/2026) : un bon de commande de la demande encore
  // au centre, à signer ou renvoyé n'engage pas la société — la demande se termine une fois le BC « signé et validé ».
  const bcsDeLaDemande = await prisma.legalDocument.findMany({ where: { sourceType: "ADMIN_REQUEST", sourceId: id, kind: "PURCHASE_ORDER" }, select: { id: true } });
  if (bcsDeLaDemande.length > 0) {
    const etats = await etatsDesBC(bcsDeLaDemande.map((b) => b.id));
    const refusBC = refusFinBCEnRoute([...etats.values()].map((e) => ({ reference: e.reference, etape: e.etape, annule: e.annule })));
    if (refusBC) return refusBC;
  }
  return null;
}

/** Un achat se termine avec sa facture finale — là où l'écran de la demande la range. */
export const REFUS_SANS_FACTURE = "Pour un achat, joignez la facture finale : dans cette fenêtre, ou dans « Pièces » (« + Ajouter une pièce » → Facture) — une facture au registre (« Pièces liées → Facture ») compte aussi, avec son PDF. Une facture annulée, ou enregistrée sans son fichier, ne compte pas.";

/** Un achat terminé dit QUI le paie : le budget de moyens généraux à débiter, et le montant dépensé. */
export const REFUS_SANS_IMPUTATION = "Choisissez le budget de moyens généraux à débiter (le vôtre ou celui du département concerné) et le montant réellement dépensé.";

/** L'IMPUTATION AUX MOYENS GÉNÉRAUX du département choisi — la ligne de dépense que la demande terminée y écrit. */
export function imputationDeLaDemande(
  id: string, req: { reference: string; title: string }, dept: { id: string }, amount: number, notes: string | null,
  acteurId: string,
) {
  return {
    departmentId: dept.id,
    year: new Date().getFullYear(),
    kind: "OPERATING" as const,
    label: `${req.reference} — ${req.title}`,
    amount,
    notes,
    adminRequestId: id,
    createdById: acteurId,
  };
}

/** L'imputation tracée au journal, et les budgets rafraîchis. */
export async function tracerLImputation(id: string, dept: { name: string }, amount: number, acteurId: string): Promise<void> {
  await recordAudit({
    actorId: acteurId, action: "CREATE", module: "Bureau du secrétariat",
    entityType: "ADMIN_REQUEST", entityId: id,
    summary: `Imputée aux moyens généraux de ${dept.name} — ${amount} DZD`,
  });
  revalidatePath("/moyens-generaux");
  revalidatePath("/budgets/departements");
}
