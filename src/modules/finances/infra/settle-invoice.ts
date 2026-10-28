import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { toNumber } from "@/lib/utils";
import { buildRef } from "@/lib/refs";
import { settlementAction, invoiceDirection, invoiceSettlementLabel } from "../domaine/chemins-paiement";
import { compteDeLEcriture } from "./comptes";
import { netDeLaFacture } from "@/lib/lecteurs/avoir";
import { montantsDesAvoirsActifs } from "@/lib/lecteurs/avoirs-actifs";
import { sansBloquer } from "@/lib/journal";

/**
 * L'ÉCRITURE FINANCIÈRE D'UNE FACTURE SAISIE COMME DÉJÀ RÉGLÉE.
 *
 * ── LA RÈGLE QUI TIENT TOUT ─────────────────────────────────────────────────────────────────
 *
 * TOUT PAIEMENT DE LA PLATEFORME PASSE PAR LES FINANCES. Marquer une facture « réglée » posait
 * une date, et rien d'autre : l'argent bougeait sans qu'aucune écriture n'apparaisse, si bien que
 * la trésorerie et le budget décrivaient une entreprise qui n'existait pas — et l'écran qu'on
 * aurait consulté pour s'en apercevoir était précisément celui qui mentait.
 *
 * ── POURQUOI IL VIT DANS `finance/` ET NON DANS `legal/` ────────────────────────────────────
 *
 * Parce qu'il ÉCRIT UNE ÉCRITURE COMPTABLE. La pièce lue est un document légal, mais le geste
 * appartient aux Finances : la référence de l'écriture, son sens, son compte, sa contrepartie.
 * Le loger dans `legal/` aurait fait dépendre le registre des engagements du module qui tient
 * l'argent, pour un geste qui va dans l'autre sens.
 *
 * ── POURQUOI CE N'EST PAS UNE ACTION SERVEUR ────────────────────────────────────────────────
 *
 * Il prend l'identifiant de l'ACTEUR en paramètre : exporté depuis un module `"use server"`, il
 * deviendrait appelable depuis le navigateur avec le nom de n'importe qui, et l'audit porterait
 * ce nom-là. C'est donc un helper de serveur, appelé par les actions qui ont DÉJÀ vérifié la
 * session — jamais une porte.
 *
 * ── LE MÊME DINAR NE SORT PAS DEUX FOIS ─────────────────────────────────────────────────────
 *
 * Une facture partie au CIRCUIT (ordre de dépense → centre de paiement → Finances) reçoit son
 * écriture au paiement de l'ordre. Y ajouter celle-ci compterait le décaissement deux fois. La
 * décision se prend dans `settlementAction`, module pur et testé — pas ici, où elle se perdrait.
 *
 * Idempotent dans les deux sens : ré-enregistrer une facture déjà réglée ne double pas son
 * écriture, et dé-marquer un règlement retire la sienne plutôt que de la laisser traîner.
 */
/** Le règlement a été écrit par un geste concurrent : rien à faire. */
class DejaReglee extends Error {}

export async function syncInvoiceSettlement(documentId: string, actorId: string): Promise<void> {
  const doc = await prisma.legalDocument.findUnique({
    where: { id: documentId },
    select: {
      id: true, kind: true, reference: true, title: true, amount: true, paidDate: true,
      direction: true, companyId: true, counterparty: true, settlementTxId: true, expenseOrderId: true,
    },
  });
  // Seule une facture se règle. Un contrat porteur d'une date de fin n'est pas un décaissement.
  if (!doc || doc.kind !== "INVOICE") return;

  const what = settlementAction({
    paidDate: doc.paidDate,
    transactionId: doc.settlementTxId,
    expenseOrderId: doc.expenseOrderId,
  });
  if (what === "NOOP") return;

  if (what === "REMOVE") {
    const txId = doc.settlementTxId!;
    // On délie AVANT de supprimer : si la suppression échoue, la facture ne pointe plus vers une
    // écriture fantôme — mieux vaut une écriture orpheline, visible, qu'un lien mort.
    await prisma.legalDocument.update({ where: { id: doc.id }, data: { settlementTxId: null } });
    await prisma.financeTransaction.delete({ where: { id: txId } }).catch(sansBloquer("settle-invoice.syncInvoiceSettlement.financeTransaction"));
    await recordAudit({
      actorId, action: "UPDATE", module: "Finances", entityType: "FINANCE_TRANSACTION", entityId: txId,
      summary: `Règlement annulé — écriture retirée pour « ${doc.title} »`,
    });
    return;
  }

  // CREATE — le montant est obligatoire pour écrire : une écriture à zéro est un mouvement qui
  // n'a pas eu lieu, et elle brouillerait la trésorerie sans rien apporter.
  //
  // LE NET D'UNE FACTURE CRÉDITÉE (§118.195) : le client règle la facture MOINS ses avoirs actifs — encaisser le TTC
  // entier ferait entrer en trésorerie un montant que personne n'a versé ; une facture entièrement créditée ne
  // s'encaisse pas du tout. Un avoir émis APRÈS le règlement ne touche pas une écriture qui a eu lieu : c'est un
  // remboursement, qui se demande à part (la phrase de l'avoir le dit).
  const amount = netDeLaFacture(doc.amount != null ? toNumber(doc.amount) : 0, await montantsDesAvoirsActifs(doc.id));
  if (!(amount > 0)) return;

  const year = (doc.paidDate ?? new Date()).getFullYear();
  const refs = (await prisma.financeTransaction.findMany({
    where: { reference: { startsWith: `FIN-${year}-` } },
    select: { reference: true },
  })).map((r) => r.reference);

  const direction = invoiceDirection(doc.direction);
  const compteDuReglement = await compteDeLEcriture({ compte: "Banque", societeId: doc.companyId });
  // UNE FACTURE NE SE RÈGLE QU'UNE FOIS, MÊME À DEUX CLICS OU DEUX ONGLETS (audit données 2026-10-27).
  // L'écriture et le lien naissent dans la même transaction, et le lien ne se pose que sur une facture
  // ENCORE sans écriture (§118.151) : le perdant de la course voit son écriture annulée avec lui, au lieu
  // de laisser au livre une seconde sortie d'argent orpheline.
  let tx: { id: string };
  try {
    tx = await prisma.$transaction(async (t) => {
      const ecriture = await t.financeTransaction.create({
        data: {
          reference: buildRef("FIN", year, refs),
          date: doc.paidDate ?? new Date(),
          direction,
          category: "AUTRE",
          label: invoiceSettlementLabel(doc),
          amount,
          method: "BANK_TRANSFER",
          account: "Banque",
          // La contrepartie, c'est L'AUTRE — celle des deux parties qui n'est pas nous.
          counterparty: doc.counterparty,
          status: "SETTLED",
          companyId: doc.companyId,
          // Le compte d'où part (ou où arrive) le règlement, figé à l'écriture (§118.176).
          treasuryAccountId: compteDuReglement,
          createdById: actorId,
        },
        select: { id: true },
      });
      const lien = await t.legalDocument.updateMany({ where: { id: doc.id, settlementTxId: null }, data: { settlementTxId: ecriture.id } });
      if (lien.count === 0) throw new DejaReglee();
      return ecriture;
    });
  } catch (e) {
    if (e instanceof DejaReglee) return;
    // Deux règlements à la même milliseconde se disputent aussi la référence : si l'autre a gagné, c'est réglé.
    if ((e as { code?: string }).code === "P2002") {
      const apres = await prisma.legalDocument.findUnique({ where: { id: doc.id }, select: { settlementTxId: true } });
      if (apres?.settlementTxId) return;
    }
    throw e;
  }
  await recordAudit({
    actorId, action: "CREATE", module: "Finances", entityType: "FINANCE_TRANSACTION", entityId: tx.id,
    summary: `${direction === "OUT" ? "Décaissement" : "Encaissement"} ${amount.toLocaleString("fr-FR")} DZD — « ${doc.title} » (facture réglée)`,
  });
}
