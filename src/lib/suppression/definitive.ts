/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA SUPPRESSION DÉFINITIVE D'UNE DEMANDE AD & PRO — ce qu'elle ajoute à la carte des branches
 * (Super Admin, 24/11/2026, DECISIONS.md « Ad & Pro — suppression définitive »).
 *
 * « Permets au super administrateur de supprimer toutes les demandes de manière définitive, même si
 * les ordres de dépense ont déjà été réglés ou engagés ou payés, n'importe quoi. Tout est retiré, y
 * compris les ordres de dépense, les budgétisations, tout ça. Mais uniquement ce qui est lié à la
 * demande. »
 *
 * ── L'UNIQUE EXCEPTION AUX INVARIANTS D'ARGENT ───────────────────────────────────────────
 *
 * Partout ailleurs, un ordre PAYÉ ne s'efface pas : la corbeille refuse la demande qui le justifie
 * (`faitIrreversible`), l'annulation d'un geste contre-passe une écriture au lieu de l'effacer. Ici, et
 * ICI SEULEMENT, le Super Admin réel retire l'ordre payé ET l'écriture de trésorerie qui l'a réglé : le
 * solde de trésorerie calculé change, le disponible du budget remonte — c'est voulu. Le cliquet
 * `definitive.test.ts` vérifie qu'aucune autre porte ne supprime un ordre de dépense.
 *
 * ── CE QUE CE MODULE DIT ─────────────────────────────────────────────────────────────────
 *
 * Le lot de la corbeille (`lot.ts`) lit déjà tout ce qui part avec une demande : enfants en cascade,
 * couples (type, identifiant) EMPORTÉS, liens directs. La suppression définitive y ajoute trois choses,
 * et seulement trois :
 *   • des SUITES — ce que la demande a fait naître en aval, que la corbeille ne suivait pas parce qu'un
 *     fait qui a quitté l'ERP la bloquait de toute façon (l'écriture d'un règlement, la pièce Legal d'un
 *     poste, l'ordre d'une prise en charge) ;
 *   • des RETOURS — ce qui désigne une branche et n'existe que pour elle (le dossier compagnon d'un
 *     ordre, la contre-passation d'une écriture) ;
 *   • des PARTAGEABLES — une pièce Legal, un fichier du Drive : ils partent avec la demande s'ils sont à
 *     ELLE seule ; reliés aussi à autre chose, ils restent, et seul le lien part.
 *
 * Et LE CLASSEMENT : chaque clé étrangère qui vise une ligne partant avec la demande dit ce qu'elle
 * devient — « part avec la demande » (cascade) ou « on retire seulement le lien » (mise à vide). Le
 * cliquet lit le schéma : un modèle lié ajouté demain sans classement fait tomber la suite.
 *
 * Module PUR : des données, aucune base.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Les natures qu'on supprime ainsi, et leur table — les 5 natures Ad & Pro et le matériel promotionnel. */
export const TETES_DEFINITIVES = {
  SPONSORING: "SponsoringRequest",
  CONGRESS_NATIONAL: "CongressNational",
  CONGRESS_INTERNATIONAL: "CongressInternational",
  EVENT: "Event",
  AD_PRO_OTHER: "AdProOtherRequest",
  PROMO_MATERIAL: "PromoMaterial",
} as const;

export type NatureDefinitive = keyof typeof TETES_DEFINITIVES;

export function estNatureDefinitive(kind: string): kind is NatureDefinitive {
  return Object.prototype.hasOwnProperty.call(TETES_DEFINITIVES, kind);
}

interface Lien { modele: string; champ: string; cible: string; raison: string }

/**
 * LES SUITES : ce qu'une branche a fait naître en aval, désigné par un champ de la branche. Un ordre de
 * dépense d'une demande, son écriture de règlement, la pièce Legal d'un poste ou d'un BC de prise en charge.
 */
export const SUITES_DEFINITIVES: readonly Lien[] = [
  // L'argent : l'écriture de trésorerie qui a réglé l'ordre — c'est elle qui fait la consommation du budget et le solde.
  { modele: "ExpenseOrder", champ: "transactionId", cible: "FinanceTransaction", raison: "l'écriture de trésorerie écrite au règlement de l'ordre." },
  { modele: "LegalDocument", champ: "settlementTxId", cible: "FinanceTransaction", raison: "l'écriture d'une facture de la demande réglée directement." },
  // Les ordres que la demande désigne par un champ texte (l'ordre ne porte pas toujours la demande en source).
  { modele: "SponsoringRequest", champ: "expenseOrderId", cible: "ExpenseOrder", raison: "l'ordre d'un accord à montant global." },
  { modele: "CongressNational", champ: "expenseOrderId", cible: "ExpenseOrder", raison: "l'ordre d'une prise en charge nationale." },
  { modele: "CongressInternational", champ: "expenseOrderId", cible: "ExpenseOrder", raison: "l'ordre d'une prise en charge internationale." },
  { modele: "Event", champ: "expenseOrderId", cible: "ExpenseOrder", raison: "l'ordre d'un événement." },
  { modele: "PromoMaterial", champ: "paymentOrderId", cible: "ExpenseOrder", raison: "l'ordre de paiement du matériel." },
  { modele: "PromoMaterial", champ: "settlementOrderId", cible: "ExpenseOrder", raison: "l'ordre de solde du matériel." },
  { modele: "CareCell", champ: "expenseOrderId", cible: "ExpenseOrder", raison: "l'ordre d'une case de prise en charge." },
  { modele: "CareQuote", champ: "expenseOrderId", cible: "ExpenseOrder", raison: "l'ordre d'un devis de prise en charge accepté." },
  { modele: "CarePecBc", champ: "expenseOrderId", cible: "ExpenseOrder", raison: "l'ordre d'un BC de prise en charge." },
  // Les pièces Legal des branches — PARTAGEABLES : elles ne partent que si elles sont à la demande seule.
  { modele: "AdProItemPiece", champ: "legalDocumentId", cible: "LegalDocument", raison: "la pièce (devis, BC, facture) d'un poste." },
  { modele: "CarePecBc", champ: "legalDocumentId", cible: "LegalDocument", raison: "le BC numéroté d'une prise en charge." },
  { modele: "PromoQuote", champ: "legalDocumentId", cible: "LegalDocument", raison: "le devis du matériel au registre Legal." },
  { modele: "PromoQuote", champ: "purchaseOrderId", cible: "LegalDocument", raison: "le BC généré pour un devis du matériel." },
  // Le fichier d'une pièce Legal vit au Drive — PARTAGEABLE lui aussi.
  { modele: "LegalDocument", champ: "driveNodeId", cible: "DriveNode", raison: "le fichier d'une pièce Legal de la demande, au Drive." },
];

/**
 * LES RETOURS : ce qui DÉSIGNE une branche et n'existe que pour elle. `ou` restreint aux lignes nées pour la
 * branche — un dossier de paiement saisi à la main qui a fait naître l'ordre n'est pas son compagnon.
 */
export const RETOURS_DEFINITIFS: readonly (Lien & { ou?: Record<string, unknown> })[] = [
  { modele: "PaymentRequest", champ: "expenseOrderId", cible: "ExpenseOrder", ou: { origin: "EXPENSE_ORDER" },
    raison: "le dossier compagnon ouvert avec l'ordre — ses pièces, ses questions, ses relances." },
  { modele: "FinanceTransaction", champ: "compensationDeId", cible: "FinanceTransaction",
    raison: "la contre-passation (ou l'« à récupérer ») d'une écriture de règlement — sans elle, le solde compterait un remboursement d'une dépense disparue." },
];

/**
 * LES PARTAGEABLES : une ligne qui peut servir AUSSI autre chose que la demande. Elle part si tout ce qui la
 * rattache est dans le périmètre ; reliée à autre chose, elle reste et seul le lien part (`partageDe`).
 */
export const PARTAGEABLES: Readonly<Record<string, string>> = {
  ExpenseOrder: "un ordre dont la SOURCE est un autre dossier, ou qu'une autre demande cite, n'est pas un ordre de cette demande — on ne règle pas les comptes d'une autre.",
  LegalDocument: "une pièce Legal sert parfois deux demandes (le même BC rattaché à deux postes) — on n'efface pas celle d'une autre.",
  DriveNode: "un fichier du Drive peut être cité par une autre pièce, un courrier, un message — il reste tant qu'on le cite ailleurs.",
};

/**
 * LES RÉFÉRENCES TEXTE vers un partageable, depuis une ligne qui pourrait RESTER : la demande de pièce d'un
 * autre poste qui a reçu ce BC, le BC de prise en charge d'une autre demande. Une telle ligne hors du
 * périmètre rend la pièce PARTAGÉE.
 */
export const ATTACHES_TEXTE: readonly { modele: string; champ: string; cible: string }[] = [
  { modele: "DocumentRequest", champ: "legalDocumentId", cible: "LegalDocument" },
  { modele: "PaymentRequest", champ: "expenseOrderId", cible: "ExpenseOrder" },
];

/**
 * Un co-propriétaire qui ne fait PAS d'une pièce une pièce partagée : le lecteur désigné d'une pièce Legal est
 * rattaché à son compte, le partage d'un fichier aussi — un compte n'est pas « autre chose » que la demande sert.
 */
export const PROPRIETAIRES_NEUTRES: ReadonlySet<string> = new Set(["User", "DriveSpace"]);

export type Sort = "PART_AVEC_LA_DEMANDE" | "LIEN_RETIRE";

/**
 * LE CLASSEMENT des clés étrangères qui visent une ligne partant avec la demande (la tête et tout ce qu'elle
 * emporte en cascade). La clé : `Modèle.champ`. Le cliquet exige que la conduite du schéma (cascade / mise à
 * vide) soit celle écrite ici — un changement de schéma qui ferait partir (ou rester) une ligne en silence casse.
 */
export const CLASSEMENT_DEFINITIF: Readonly<Record<string, { sort: Sort; raison: string }>> = {
  // ── La demande elle-même : ses postes, sa prise en charge, son matériel, ses inscriptions ──
  "AdProItem.sponsoringId": { sort: "PART_AVEC_LA_DEMANDE", raison: "les postes du sponsoring." },
  "AdProItem.congressNationalId": { sort: "PART_AVEC_LA_DEMANDE", raison: "les postes de la prise en charge nationale." },
  "AdProItem.congressInternationalId": { sort: "PART_AVEC_LA_DEMANDE", raison: "les postes de la prise en charge internationale." },
  "AdProItem.eventId": { sort: "PART_AVEC_LA_DEMANDE", raison: "les postes de l'événement." },
  "AdProItem.otherRequestId": { sort: "PART_AVEC_LA_DEMANDE", raison: "les postes de la demande « autre »." },
  "AdProItem.promoMaterialParentId": { sort: "PART_AVEC_LA_DEMANDE", raison: "les postes du dossier de matériel." },
  "CareBeneficiary.congressNationalId": { sort: "PART_AVEC_LA_DEMANDE", raison: "les professionnels pris en charge (le médecin reste à l'annuaire)." },
  "CareBeneficiary.congressInternationalId": { sort: "PART_AVEC_LA_DEMANDE", raison: "idem, à l'international." },
  "CareQuote.congressNationalId": { sort: "PART_AVEC_LA_DEMANDE", raison: "les devis de la prise en charge." },
  "CareQuote.congressInternationalId": { sort: "PART_AVEC_LA_DEMANDE", raison: "idem, à l'international." },
  "CareChiffrage.congressNationalId": { sort: "PART_AVEC_LA_DEMANDE", raison: "les chiffrages de l'assistante." },
  "CareChiffrage.congressInternationalId": { sort: "PART_AVEC_LA_DEMANDE", raison: "idem, à l'international." },
  "CarePecBc.congressNationalId": { sort: "PART_AVEC_LA_DEMANDE", raison: "les BC numérotés de la prise en charge." },
  "CarePecBc.congressInternationalId": { sort: "PART_AVEC_LA_DEMANDE", raison: "idem, à l'international." },
  "CareGroupPoste.congressNationalId": { sort: "PART_AVEC_LA_DEMANDE", raison: "les postes « par personne » d'une prise en charge de groupe." },
  "CareGroupPoste.congressInternationalId": { sort: "PART_AVEC_LA_DEMANDE", raison: "idem, à l'international." },
  "PromoQuote.promoMaterialId": { sort: "PART_AVEC_LA_DEMANDE", raison: "les devis retranscrits du matériel." },
  "PromoRequestItem.promoMaterialId": { sort: "PART_AVEC_LA_DEMANDE", raison: "les articles demandés au catalogue." },
  "EventRegistration.eventId": { sort: "PART_AVEC_LA_DEMANDE", raison: "les inscriptions à l'événement." },
  // ── Ce que les postes emportent ──
  "AdProVoyageur.itemId": { sort: "PART_AVEC_LA_DEMANDE", raison: "les voyageurs d'un poste de billetterie." },
  "AdProVoyageurDevis.voyageurId": { sort: "PART_AVEC_LA_DEMANDE", raison: "les devis d'un voyageur." },
  "AdProVoyageurDevis.pieceId": { sort: "PART_AVEC_LA_DEMANDE", raison: "le devis d'un voyageur, par sa pièce de poste." },
  "AdProHebergement.itemId": { sort: "PART_AVEC_LA_DEMANDE", raison: "les fiches hôtellerie d'un poste." },
  "DemandeReservation.voyageurId": { sort: "PART_AVEC_LA_DEMANDE", raison: "la demande de réservation d'un voyageur." },
  "DemandeReservation.hebergementId": { sort: "PART_AVEC_LA_DEMANDE", raison: "la demande de réservation d'une fiche hôtellerie." },
  "DemandeReservation.careCellId": { sort: "PART_AVEC_LA_DEMANDE", raison: "la demande de réservation d'une case de prise en charge." },
  "AdProItemPiece.itemId": { sort: "PART_AVEC_LA_DEMANDE", raison: "le LIEN d'un poste à sa pièce Legal — la pièce, elle, ne part que si elle est à la demande seule." },
  "AdProItemDecision.itemId": { sort: "PART_AVEC_LA_DEMANDE", raison: "l'historique des décisions sur un poste." },
  "AdProProductAllocation.itemId": { sort: "PART_AVEC_LA_DEMANDE", raison: "la répartition d'un poste par produit." },
  "AdProStockLine.itemId": { sort: "PART_AVEC_LA_DEMANDE", raison: "le matériel du stock demandé par un poste (le stock garde ses mouvements)." },
  "AdProExecutionPoste.itemId": { sort: "PART_AVEC_LA_DEMANDE", raison: "le suivi d'exécution d'un poste." },
  // ── Ce que la prise en charge emporte ──
  "CareCell.beneficiaryId": { sort: "PART_AVEC_LA_DEMANDE", raison: "les cases (billet, hôtel…) d'un professionnel." },
  "CareQuoteCell.quoteId": { sort: "PART_AVEC_LA_DEMANDE", raison: "les lignes d'un devis de prise en charge." },
  "CareQuoteCell.cellId": { sort: "PART_AVEC_LA_DEMANDE", raison: "idem, par la case." },
  "CarePrixHistorique.cellId": { sort: "PART_AVEC_LA_DEMANDE", raison: "l'historique des prix chiffrés." },
  "CarePecBcLigne.bcId": { sort: "PART_AVEC_LA_DEMANDE", raison: "les lignes d'un BC de prise en charge." },
  "CarePecBcLigne.cellId": { sort: "PART_AVEC_LA_DEMANDE", raison: "idem, par la case." },
  // ── Ce que le matériel emporte ──
  "PromoQuoteLine.quoteId": { sort: "PART_AVEC_LA_DEMANDE", raison: "les lignes d'un devis retranscrit." },
  "PromoRequestItemProduct.itemId": { sort: "PART_AVEC_LA_DEMANDE", raison: "les produits d'un article demandé." },
  // ── On retire seulement le lien : la ligne vit ailleurs ──
  "AdProDevisLigne.validatedItemId": { sort: "LIEN_RETIRE", raison: "la ligne d'un devis lu (pièce Legal) validée pour un poste : la pièce, si elle reste, perd ce lien." },
  "PromoQuoteLine.requestItemId": { sort: "LIEN_RETIRE", raison: "une ligne de devis qui citait un article demandé." },
  "PromoFacture.quoteId": { sort: "LIEN_RETIRE", raison: "une facture saisie en lignes qui citait un devis retranscrit." },
  "PromoFactureLigne.quoteLineId": { sort: "LIEN_RETIRE", raison: "une ligne de facture qui citait une ligne de devis." },
  "PromoFactureLigne.requestItemId": { sort: "LIEN_RETIRE", raison: "une ligne de facture qui citait un article demandé." },
  "PromoStockMovement.adProLineId": { sort: "LIEN_RETIRE", raison: "un mouvement du stock promotionnel : le stock ne bouge pas quand on supprime une demande." },
};

/** Les montants d'un aperçu — ce qu'on rend au budget, ce qu'on retire de la trésorerie. */
export interface LigneBudgetRendue { categorieId: string; engagement: number; consommation: number }

/** Additionne au centime, sans flottant qui dérive (« 0,1 + 0,2 »). */
export function somme(montants: readonly number[]): number {
  return Math.round(montants.reduce((s, m) => s + Math.round(m * 100), 0)) / 100;
}

// ─── L'APERÇU — ce que la personne lit AVANT de retaper la référence (§118.53) ─────────────────────────────

/** Les faits lus dans le périmètre (`apercu-definitif.ts`), avant tout calcul. */
export interface FaitsApercu {
  postes: number;
  ordres: readonly { reference: string; montant: number; statut: string; centralStatus: string }[];
  ecritures: readonly { montant: number; direction: string; statut: string; categorieId: string | null }[];
  /** L'engagé (BC signés, ordres en circuit) que la demande portait, par catégorie — lu par la règle des budgets. */
  engagements: readonly { categorieId: string; montant: number }[];
  /** Le nom lisible de chaque catégorie citée (« Enveloppe › Catégorie »). */
  categories: Readonly<Record<string, string>>;
  legal: number;
  jointes: number;
  fichiers: number;
  gardees: readonly { libelle: string; pourquoi: string }[];
  resume: readonly string[];
  faits: readonly string[];
  bloquants: readonly string[];
  lignes: number;
}

export interface ApercuDefinitif {
  postes: number;
  ordres: { nombre: number; payes: number; montantPaye: number; enCircuit: number; montantEnCircuit: number; montantTotal: number };
  ecritures: { nombre: number; sorties: number; entrees: number };
  /** Ce que chaque ligne de budget récupère : l'engagé qui disparaît, la consommation qui disparaît. */
  budget: { categorieId: string; libelle: string; engagement: number; consommation: number }[];
  totalBudget: { engagement: number; consommation: number };
  pieces: { legal: number; jointes: number; fichiers: number };
  gardees: { libelle: string; pourquoi: string }[];
  autres: string[];
  faits: string[];
  bloquants: string[];
  lignes: number;
}

/** Un ordre qui engage encore de l'argent : émis, pas réglé, pas annulé, pas refusé par le centre (`budget/engage.ts`). */
const enCircuit = (statut: string, centralStatus: string) => (statut === "PENDING" || statut === "REVISION_REQUESTED") && centralStatus !== "REFUSED";

/** L'APERÇU, calculé des faits — pur, pour que l'écran, l'action et la trace disent les mêmes nombres. */
export function composerApercu(f: FaitsApercu): ApercuDefinitif {
  const payes = f.ordres.filter((o) => o.statut === "PAID");
  const circuit = f.ordres.filter((o) => enCircuit(o.statut, o.centralStatus));
  const parCat = new Map<string, { engagement: number[]; consommation: number[] }>();
  const de = (c: string) => parCat.get(c) ?? (parCat.set(c, { engagement: [], consommation: [] }), parCat.get(c)!);
  for (const e of f.engagements) de(e.categorieId).engagement.push(e.montant);
  // LA CONSOMMATION d'une catégorie, ce sont ses sorties RÉGLÉES (une contre-passation, de montant négatif, s'y retranche).
  for (const e of f.ecritures) if (e.direction === "OUT" && e.statut === "SETTLED" && e.categorieId) de(e.categorieId).consommation.push(e.montant);
  const budget = [...parCat].map(([categorieId, v]) => ({
    categorieId, libelle: f.categories[categorieId] ?? "Catégorie supprimée", engagement: somme(v.engagement), consommation: somme(v.consommation),
  })).filter((b) => b.engagement !== 0 || b.consommation !== 0).sort((a, b) => a.libelle.localeCompare(b.libelle, "fr"));
  return {
    postes: f.postes,
    ordres: {
      nombre: f.ordres.length, payes: payes.length, montantPaye: somme(payes.map((o) => o.montant)),
      enCircuit: circuit.length, montantEnCircuit: somme(circuit.map((o) => o.montant)), montantTotal: somme(f.ordres.map((o) => o.montant)),
    },
    ecritures: {
      nombre: f.ecritures.length,
      sorties: somme(f.ecritures.filter((e) => e.direction === "OUT" && e.statut === "SETTLED").map((e) => e.montant)),
      entrees: somme(f.ecritures.filter((e) => e.direction === "IN" && e.statut === "SETTLED").map((e) => e.montant)),
    },
    budget,
    totalBudget: { engagement: somme(budget.map((b) => b.engagement)), consommation: somme(budget.map((b) => b.consommation)) },
    pieces: { legal: f.legal, jointes: f.jointes, fichiers: f.fichiers },
    gardees: [...f.gardees],
    autres: [...f.resume],
    faits: [...f.faits],
    bloquants: [...f.bloquants],
    lignes: f.lignes,
  };
}

const dzd = (n: number) => `${n.toLocaleString("fr-FR", { minimumFractionDigits: 0, maximumFractionDigits: 2 })} DZD`;
const pluriel = (n: number, un: string, plusieurs: string) => `${n} ${n > 1 ? plusieurs : un}`;

/** LA TRACE — la seule ligne qui survit : qui (l'audit le porte), quoi, et le résumé chiffré de ce qui a été retiré. */
export function resumeDeLaDestruction(entete: { nature: string; reference: string; titre: string }, a: ApercuDefinitif): string {
  const parts = [
    pluriel(a.postes, "poste", "postes"),
    `${pluriel(a.ordres.nombre, "ordre de dépense", "ordres de dépense")} (${a.ordres.payes} payé${a.ordres.payes > 1 ? "s" : ""} : ${dzd(a.ordres.montantPaye)} ; total ${dzd(a.ordres.montantTotal)})`,
    `${pluriel(a.ecritures.nombre, "écriture de trésorerie", "écritures de trésorerie")} (sorties ${dzd(a.ecritures.sorties)})`,
    `budget rendu : engagement ${dzd(a.totalBudget.engagement)}, consommation ${dzd(a.totalBudget.consommation)}`
      + (a.budget.length ? ` [${a.budget.map((b) => `${b.libelle} : +${dzd(b.engagement + b.consommation)}`).join(" ; ")}]` : ""),
    `${pluriel(a.pieces.legal, "pièce Legal", "pièces Legal")}, ${pluriel(a.pieces.jointes, "pièce jointe", "pièces jointes")}, ${pluriel(a.pieces.fichiers, "fichier", "fichiers")}`,
    `${a.lignes} élément${a.lignes > 1 ? "s" : ""} en tout`,
  ];
  const gardees = a.gardees.length ? ` Gardé${a.gardees.length > 1 ? "s" : ""} (lien seul retiré) : ${a.gardees.map((g) => g.libelle).join(", ")}.` : "";
  return `Suppression DÉFINITIVE (Super Admin) — ${entete.nature} ${entete.reference} « ${entete.titre} » : ${parts.join(" ; ")}.${gardees}`;
}
