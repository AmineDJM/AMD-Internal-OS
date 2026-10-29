/**
 * MATÉRIEL PROMOTIONNEL, EXÉCUTION — le DOSSIER lu par les actions : le charger, qui le pilote, les refus communs
 * (exécution, réception), son devis et son BC, sa facture et ses lignes, le paiement en cours, et les lectures de
 * nombres saisis.
 *
 * Sorti de `actions/promo-execution-actions.ts` (lot V4) : lectures et règles, aucune écriture.
 */
import { prisma } from "@/lib/prisma";
import { hasGlobalView, type SessionUser } from "@/lib/rbac";
import { etatDuBC } from "@/lib/bons-de-commande/etat";
import { ordreClos } from "@/lib/finances/settlement";
import { lireBrouillonPromo } from "@/lib/promo-material/bc-brouillon-promo";
import { piloteLExecution } from "@/lib/promo-material/circuit";
import { peutReceptionner } from "@/lib/promo-material/achats";
import { parseQuantity } from "@/lib/promo/stock";
import { SELECT_LIGNE_FACTURE } from "@/lib/queries/promo-achats";

export const PATH = "/promo-material";
export const chemin = (id: string) => `${PATH}/${id}`;

export type Dossier = {
  id: string; reference: string; title: string; status: string; circuitVersion: number; circuitState: string | null;
  requesterId: string | null; companyId: string | null;
  /** Le budget imputé par la Direction Marketing (point 21) : l'ordre fournisseur le porte, son règlement aussi. */
  budgetCategoryId: string | null;
};

export async function chargerDossier(id: string | null): Promise<Dossier | null> {
  if (!id) return null;
  return prisma.promoMaterial.findUnique({
    where: { id },
    select: { id: true, reference: true, title: true, status: true, circuitVersion: true, circuitState: true, requesterId: true, companyId: true, budgetCategoryId: true },
  });
}

/** Ceux qui PILOTENT l'exécution — la règle du module pur, lue aussi par la fiche et la clôture des chantiers. */
export function pilote(user: SessionUser, pm: Dossier): boolean {
  return piloteLExecution({ id: user.id, role: user.role, secondaryRole: user.secondaryRole, vueGlobale: hasGlobalView(user.role) }, pm);
}

/** Le refus commun : ni pilote, ni circuit 2, ni validations obtenues. `null` = on peut agir. */
export function refusExecution(user: SessionUser, pm: Dossier | null): string | null {
  if (!pm) return "Dossier introuvable.";
  if (pm.circuitVersion !== 2) return "Ce dossier suit l'ancien circuit : ses bons de commande se créent depuis « Pièces liées ».";
  if (!pilote(user, pm)) return "Seuls le demandeur, l'assistante de direction et la Direction pilotent l'exécution de ce dossier.";
  if (pm.circuitState !== "IN_EXECUTION") {
    // UN DOSSIER CLOS SE DIT CLOS : annulé ou refusé, « une fois les validations obtenues » promettait
    // une suite qui n'existe plus.
    if (pm.status === "CANCELLED") return "Ce dossier a été annulé : plus rien ne s'y génère ni ne s'y facture.";
    if (pm.circuitState === "REFUSED") return "Ce dossier a été refusé : plus rien ne s'y génère ni ne s'y facture.";
    return pm.circuitState === "COMPLETED"
      ? "Ce dossier est terminé."
      : "Les bons de commande se génèrent une fois TOUTES les validations obtenues (demandeur, Direction Marketing, et Directeur Général au-dessus du seuil).";
  }
  return null;
}

/** Le devis de ce dossier, et son BC s'il en a un d'actif. */
export async function devisEtBC(pm: Dossier, quoteId: string | null) {
  if (!quoteId) return null;
  const devis = await prisma.promoQuote.findFirst({
    where: { id: quoteId, promoMaterialId: pm.id },
    select: { id: true, supplierId: true, supplierName: true, purchaseOrderId: true, purchaseOrderSentAt: true },
  });
  if (!devis) return null;
  const etat = devis.purchaseOrderId ? await etatDuBC(devis.purchaseOrderId) : null;
  return { devis, bc: etat && !etat.annule ? etat : null };
}

/** Le devis et son aperçu, lus pour l'un des gestes de l'aperçu — après la porte commune de l'exécution. */
export async function devisAvecApercu(pm: Dossier, quoteId: string | null) {
  if (!quoteId) return null;
  const devis = await prisma.promoQuote.findFirst({
    where: { id: quoteId, promoMaterialId: pm.id },
    select: { id: true, supplierName: true, purchaseOrderId: true, bcBrouillon: true },
  });
  if (!devis) return null;
  return { devis, brouillon: lireBrouillonPromo(devis.bcBrouillon) };
}

/** « 4 800 », « 4 800,5 » → nombre ; vide → 0 (la ligne n'est pas sur cette facture) ; illisible → null. */
export function lireNombreSaisi(brut: unknown): number | null {
  const s = String(brut ?? "").trim();
  if (s === "") return 0;
  return parseQuantity(s);
}

/** La ligne de facture d'un dossier, avec sa facture — `null` si elle n'est pas à ce dossier. */
export async function ligneDuDossier(pm: Dossier, ligneId: string | null) {
  if (!ligneId) return null;
  return prisma.promoFactureLigne.findFirst({
    where: { id: ligneId, facture: { legalDocument: { kind: "INVOICE", sourceType: "PROMO_MATERIAL", sourceId: pm.id, status: { not: "CANCELLED" } } } },
    select: {
      ...SELECT_LIGNE_FACTURE,
      facture: { select: { legalDocument: { select: { id: true, reference: true, companyId: true, expenseOrderId: true, paidDate: true, counterparty: true } } } },
    },
  });
}

/** Le refus commun de la réception ; `null` = on peut cocher. */
export function refusReception(user: SessionUser, pm: Dossier | null): string | null {
  if (!pm) return "Dossier introuvable.";
  if (pm.circuitVersion !== 2) return "Ce dossier suit l'ancien circuit : il n'a pas de réception ligne à ligne.";
  if (!peutReceptionner({ id: user.id, role: user.role }, pm)) {
    return "La réception se coche par le demandeur du dossier (le Super Admin en suppléance) : c'est lui qui atteste ce qui est arrivé.";
  }
  if (pm.circuitState !== "IN_EXECUTION") return pm.circuitState === "COMPLETED" ? "Ce dossier est terminé." : "La réception vient après les bons de commande et leurs factures.";
  return null;
}

export const quantiteLue = (n: number) => n.toLocaleString("fr-FR", { maximumFractionDigits: 3 });

/**
 * LE PAIEMENT DE CETTE FACTURE EST-IL EN COURS ? Réglée en direct, ou partie au circuit sur un ordre
 * qui peut encore payer. Un ordre REFUSÉ par le centre ou ANNULÉ ne paiera jamais (§118.185, audit
 * 360° I8) : la facture redevient corrigeable, annulable et renvoyable — sinon elle restait figée.
 */
export async function paiementEnCours(facture: { expenseOrderId: string | null; paidDate: Date | null }): Promise<boolean> {
  if (facture.paidDate) return true;
  if (!facture.expenseOrderId) return false;
  const ordre = await prisma.expenseOrder.findUnique({ where: { id: facture.expenseOrderId }, select: { status: true, centralStatus: true } });
  return !ordreClos(ordre);
}

/** La facture de CE dossier, et le BC dont elle découle. */
export async function factureDuDossier(pm: Dossier, invoiceId: string | null) {
  if (!invoiceId) return null;
  return prisma.legalDocument.findFirst({
    where: { id: invoiceId, kind: "INVOICE", sourceType: "PROMO_MATERIAL", sourceId: pm.id, status: { not: "CANCELLED" } },
    select: {
      id: true, reference: true, title: true, kind: true, amount: true, counterparty: true, endDate: true,
      paidDate: true, expenseOrderId: true, chainFrom: { select: { id: true, reference: true } },
    },
  });
}
