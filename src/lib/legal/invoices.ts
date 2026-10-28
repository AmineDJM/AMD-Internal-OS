/**
 * UNE FACTURE EST UN DOCUMENT LÉGAL DE NATURE « FACTURE ».
 *
 * ── LE DÉFAUT QU'ON CORRIGE ─────────────────────────────────────────────────────────────────
 *
 * Les factures avaient leur écran à elles, leur table et leur vocabulaire. Legal tenait pourtant
 * déjà la chaîne d'achat entière — devis → bon de commande → FACTURE → règlement : la nature
 * `INVOICE` existait, le chaînage la prévoyait, l'envoi au règlement ne marchait QUE sur elle, et
 * le circuit des pièces réclamées y versait déjà les factures acceptées. Deux registres pour le
 * même objet, donc deux réponses à « quelles factures de ce fournisseur ? », sans qu'on sache
 * laquelle est complète (§17 : pas de second registre).
 *
 * ── CE QUE CE MODULE PORTE, ET POURQUOI IL EST PUR ──────────────────────────────────────────
 *
 * Ce que la fusion ne doit rien faire perdre : savoir d'un coup d'œil ce qui reste à payer, et
 * combien. L'écran dédié le donnait dans son bandeau ; il se calcule ici, sans base, pour que la
 * liste Legal, la fiche et les compteurs répondent tous à partir du MÊME calcul.
 *
 * Module PUR : ni base, ni session (il n'importe que le vocabulaire). Testé.
 */

import { isInvoice } from "@/lib/labels";
import { entierementCreditee, netDeLaFacture } from "@/lib/lecteurs/avoir";

/**
 * LA NATURE « FACTURE » ET SON ÉTAT DE RÈGLEMENT vivent dans le VOCABULAIRE (`lib/labels`) :
 * `INVOICE_KIND`, `isInvoice`, `settlementState`, `INVOICE_SETTLEMENT`. Ce ne sont pas des
 * règles du registre, ce sont deux champs qu'on lit — et TOUT le monde les lit : l'écran Legal,
 * la fiche marché, la recherche, la frise, Adam. Les enfermer ici les aurait fait recopier par
 * la moitié des appelants, et deux copies d'une même règle divergent au premier changement.
 *
 * Ce module-ci porte ce qui appartient VRAIMENT au registre : ce qui reste à payer, qui voit
 * quoi, et qui écrit quoi.
 */

export interface InvoiceTallyRow {
  kind: string;
  amount: number | null;
  /** L'échéance de règlement (`endDate` du document légal). */
  endDate: string | null;
  paidDate: string | null;
  expenseOrderId: string | null;
  /** Un document annulé ne se règle plus — il ne compte dans aucun total. */
  status: string;
  /**
   * LE TOTAL DE SES AVOIRS ACTIFS (§118.195) — ce que la facture ne doit plus. Le reste à payer est son NET, comme
   * au règlement : une facture de 45 220 DZD créditée de 5 950 ne laisse que 39 270 à régler, et une facture
   * entièrement créditée ne laisse rien. Absent : aucun avoir.
   */
  avoirs?: number;
}

export interface InvoiceTally {
  /** Combien de factures dans l'ensemble examiné. */
  count: number;
  /** Combien restent à régler — circuit compris : elles ne sont pas encore payées. */
  unpaid: number;
  /** Ce que ces factures-là représentent, en DZD. */
  unpaidTotal: number;
  /** Combien ont dépassé leur échéance sans être réglées. */
  overdue: number;
}

/**
 * CE QUI RESTE À PAYER, ET COMBIEN — sur l'ensemble QU'ON REGARDE.
 *
 * Le total suit la liste affichée, jamais un chiffre global : filtrer sur un fournisseur puis
 * additionner est le geste attendu, et un bandeau qui répondrait pour toute la base pendant que
 * le tableau montre autre chose fait douter des deux.
 *
 * Une facture ANNULÉE ne compte nulle part : elle ne sera jamais payée, et la laisser dans le
 * reste à payer gonflerait une dette qui n'existe pas.
 */
export function invoiceTally(rows: readonly InvoiceTallyRow[], today: Date = new Date()): InvoiceTally {
  const factures = rows.filter((r) => isInvoice(r.kind) && r.status !== "CANCELLED");
  // Une facture entièrement créditée par ses avoirs n'est plus à régler : la même lecture que le filtre de la liste.
  const dues = factures.filter((r) => !r.paidDate && !entierementCreditee(r.amount, r.avoirs ?? 0));
  const jour = today.getTime();
  return {
    count: factures.length,
    unpaid: dues.length,
    unpaidTotal: dues.reduce((a, r) => a + netDeLaFacture(r.amount ?? 0, [r.avoirs ?? 0]), 0),
    overdue: dues.filter((r) => r.endDate !== null && new Date(r.endDate).getTime() < jour).length,
  };
}

// ───────────────────── Qui voit quoi, une fois les deux registres fondus ─────────────────────

// LES PORTÉES DU REGISTRE ET LA PORTE D'ÉCRITURE vivent au SOCLE (`lecteurs/legal.ts`), à côté
// de la règle des lecteurs désignés : les pièces liées d'une fiche Ad & Pro doivent la lire pour
// n'offrir que les boutons que l'action acceptera, et le domaine Ad & Pro n'a pas le droit
// d'importer Legal (§118.114). Réexportée ici pour ses lecteurs d'origine — une seule règle.
export { PURCHASE_CHAIN_KINDS, legalViewScope, legalKindVisible, legalWriteAllowed } from "@/lib/lecteurs/legal";

/**
 * LA NATURE DEMANDÉE PAR L'URL — `?nature=INVOICE`.
 *
 * C'est ce qui remplace l'écran dédié : « les factures » est une VUE de la liste des documents
 * légaux, pas un autre endroit. Une valeur inconnue ne filtre rien plutôt que de rendre une liste
 * vide : un lien mal recopié doit montrer les documents, pas faire croire qu'il n'y en a plus.
 */
export function natureFromParam(raw: string | null | undefined, known: readonly string[]): string {
  const v = (raw ?? "").trim().toUpperCase();
  return known.includes(v) ? v : "";
}
