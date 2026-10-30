import type { EntityType } from "@prisma/client";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES BRANCHES D'UNE DEMANDE — qui pointe vers elle, et ce qu'on en fait quand elle part
 * (§118.162).
 *
 * Décision de la Direction (30/09/2026) : « toute demande doit être liée du début à la fin à
 * toutes ses branches — quand une demande Ad & Pro se retrouve dans Information médicale et
 * qu'ensuite cette demande est supprimée, celle d'Information médicale doit être supprimée
 * également. »
 *
 * ── LE DÉFAUT, ET POURQUOI AUCUNE CLÉ ÉTRANGÈRE NE LE VOYAIT ─────────────────────────────
 *
 * Une déclaration d'information médicale désigne sa demande par un COUPLE (type, identifiant)
 * — `sourceType` / `sourceId` — et non par une clé étrangère : la même table reçoit des
 * sponsorings, des congrès, des événements, du matériel promotionnel. Postgres ne peut donc rien
 * propager : supprimer le sponsoring laissait sa déclaration vivante dans la file du pharmacien,
 * pour une demande qui n'existait plus. Seize tables désignent ainsi un objet, et chacune
 * répondait à la question « et si la demande disparaît ? » par un silence.
 *
 * ── CE QUE CE MODULE DIT, POUR CHAQUE COUPLE DU SCHÉMA ───────────────────────────────────
 *
 *   • EMPORTEE — la ligne n'existe que pour la demande (sa déclaration, sa demande au
 *     secrétariat, son circuit de validation, son visa, sa demande de paiement, ses pièces au
 *     registre Legal, ses rappels…). Elle part AVEC elle, dans la MÊME entrée de corbeille, et
 *     revient avec elle.
 *   • COEUR — pièces jointes et commentaires : le cœur de la suppression les instantane déjà
 *     pour chaque ligne qui a un type d'entité.
 *   • HISTOIRE — le journal ne s'efface pas : audit, registre des faits, correspondance, index
 *     de recherche. Une trace d'un objet disparu reste une trace ; l'effacer réécrirait le passé.
 *
 * Et un fait qui a QUITTÉ l'ERP ne s'efface pas avec la demande : un règlement parti, une pièce
 * signée, une déclaration déposée aux autorités, un courrier inscrit au registre. La demande est
 * alors la JUSTIFICATION de ce fait — la supprimer le laisserait sans cause. Elle se garde, et le
 * refus nomme ce qui l'y oblige (`faitIrreversible`).
 *
 * Le cliquet (`branches.test.ts`) lit le schéma : tout couple (…Type, …Id) d'un modèle doit être
 * classé ICI, avec sa raison. Un couple ajouté demain sans décision fait tomber la suite — il ne
 * pourra pas redevenir un silence (§118.73).
 *
 * Module PUR : des données et deux fonctions, aucun accès à la base.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import { faitDeStock } from "@/lib/promo/reservations";

export type Conduite = "EMPORTEE" | "COEUR" | "HISTOIRE";

export interface Referent {
  /** Le modèle Prisma qui porte le couple. */
  modele: string;
  /** Le champ qui porte le TYPE de l'objet visé. */
  champType: string;
  /** Le champ qui porte l'IDENTIFIANT de l'objet visé. */
  champId: string;
  conduite: Conduite;
  raison: string;
}

export const REFERENTS: readonly Referent[] = [
  // ── EMPORTÉES : elles n'existent que pour la demande ─────────────────────────────────────
  { modele: "MedicalInfoDeclaration", champType: "sourceType", champId: "sourceId", conduite: "EMPORTEE",
    raison: "LA décision de la Direction : la déclaration d'une demande supprimée resterait dans la file du pharmacien, pour rien." },
  { modele: "AdministrativeRequest", champType: "linkedEntityType", champId: "linkedEntityId", conduite: "EMPORTEE",
    raison: "une demande au secrétariat (devis, BC) faite POUR la demande — l'assistante la traiterait pour un objet disparu." },
  { modele: "WorkflowInstance", champType: "entityType", champId: "entityId", conduite: "EMPORTEE",
    raison: "le circuit de validation de la demande — resté vivant, il apparaîtrait dans les files de ceux qui valident." },
  { modele: "AdProGateVisa", champType: "entityType", champId: "entityId", conduite: "EMPORTEE",
    raison: "le visa du DG ou du centre sur la demande — une porte ouverte sur un objet disparu." },
  { modele: "AdProPorteDg", champType: "entityType", champId: "entityId", conduite: "EMPORTEE",
    raison: "la décision du DG sur le TOTAL de la demande (27/10/2026) — sans demande, il n'y a plus de total à valider." },
  { modele: "ValidationRequest", champType: "entityType", champId: "entityId", conduite: "EMPORTEE",
    raison: "une validation demandée pour la demande ou l'une de ses pièces (bon de versement, BC)." },
  { modele: "PaymentRequest", champType: "entityType", champId: "entityId", conduite: "EMPORTEE",
    raison: "une demande de paiement faite pour la demande — tant que rien n'est réglé, elle n'a plus d'objet." },
  { modele: "ExpenseOrder", champType: "sourceType", champId: "sourceId", conduite: "EMPORTEE",
    raison: "un ordre de dépense pour la demande — non réglé, il resterait à payer au centre de paiement pour un objet disparu." },
  { modele: "LegalDocument", champType: "sourceType", champId: "sourceId", conduite: "EMPORTEE",
    raison: "une pièce liée (devis, BC, facture, convention) — non signée et non réglée, elle n'a plus de cause." },
  { modele: "MailEntry", champType: "sourceType", champId: "sourceId", conduite: "EMPORTEE",
    raison: "un courrier rattaché — le fait qu'il soit INSCRIT au registre bloque la suppression (voir faitIrreversible)." },
  { modele: "DocumentRequest", champType: "entityType", champId: "entityId", conduite: "EMPORTEE",
    raison: "une demande de pièce adressée à quelqu'un pour la demande — il la recevrait encore." },
  { modele: "Dossier", champType: "sourceType", champId: "sourceId", conduite: "EMPORTEE",
    raison: "le dossier ouvert pour impliquer un tiers sur la demande — sa conversation n'a de sens qu'avec elle." },
  { modele: "MissionAssignment", champType: "entityType", champId: "entityId", conduite: "EMPORTEE",
    raison: "l'affectation d'une personne à l'événement ou au congrès — une mission vers un objet disparu." },
  { modele: "Task", champType: "relatedEntityType", champId: "relatedEntityId", conduite: "EMPORTEE",
    raison: "une tâche POUR la demande — elle resterait dans la liste de quelqu'un, avec un lien vers rien." },
  { modele: "Reminder", champType: "entityType", champId: "entityId", conduite: "EMPORTEE",
    raison: "un rappel sur la demande — il sonnerait pour un objet disparu." },
  { modele: "RowGrant", champType: "entityType", champId: "entityId", conduite: "EMPORTEE",
    raison: "un droit accordé sur CETTE ligne — il revient avec elle, sinon la restauration rouvrirait mal." },
  { modele: "EntityLink", champType: "fromType", champId: "fromId", conduite: "EMPORTEE",
    raison: "un lien « relié à… » partant de la demande." },
  { modele: "EntityLink", champType: "toType", champId: "toId", conduite: "EMPORTEE",
    raison: "un lien « relié à… » arrivant sur la demande." },
  { modele: "MailLink", champType: "entityType", champId: "entityId", conduite: "EMPORTEE",
    raison: "un e-mail classé sur la demande — le lien part avec elle, l'e-mail reste dans la boîte." },
  { modele: "AdProMedecin", champType: "entityType", champId: "entityId", conduite: "EMPORTEE",
    raison: "un médecin concerné PAR la demande (bénéficiaire, orateur, invité) — le lien part avec elle, le praticien reste à l'annuaire ; resté seul, il gonflerait le cockpit marketing et la fiche du praticien d'une dépense disparue." },
  { modele: "AdProIntegrationDemande", champType: "demandeType", champId: "demandeId", conduite: "EMPORTEE",
    raison: "la ligne d'un lot d'intégration Ad & Pro 2026 qui a créé ou complété la demande — restée seule, elle couvrirait encore l'écriture de trésorerie qui l'a payée (comptée nulle part) et proposerait de « rendre » une demande disparue à l'annulation du lot ; elle part avec la demande et revient avec elle. Le lot et son audit restent." },
  { modele: "AdProRapprochement", champType: "demandeType", champId: "demandeId", conduite: "EMPORTEE",
    raison: "une dépense ou une pièce rapprochée de la demande (décision humaine) — restée seule, la dépense acceptée cesserait de compter au budget comme preuve d'une demande disparue ; elle part avec la demande et revient avec elle, la décision reste à l'audit." },
  { modele: "DemandeReservation", champType: "operationType", champId: "operationId", conduite: "EMPORTEE",
    raison: "la demande de réservation d'une fiche (billet, hôtel) de l'opération — la clé étrangère de sa fiche l'emporte déjà ; le couple dénormalisé dit la même chose, et une demande restaurée la retrouve avec ses fiches." },

  // ── COEUR : instantanés par le cœur de la suppression, ligne par ligne ───────────────────
  { modele: "Document", champType: "entityType", champId: "entityId", conduite: "COEUR",
    raison: "pièces jointes : le cœur les instantane pour chaque ligne qui a un type d'entité." },
  { modele: "Comment", champType: "entityType", champId: "entityId", conduite: "COEUR",
    raison: "commentaires : même traitement que les pièces jointes." },

  // ── HISTOIRE : la trace reste ─────────────────────────────────────────────────────────────
  { modele: "AuditLog", champType: "entityType", champId: "entityId", conduite: "HISTOIRE",
    raison: "le journal d'audit ne s'efface pas — c'est lui qui dira qui a supprimé quoi." },
  { modele: "BusinessEvent", champType: "entityType", champId: "entityId", conduite: "HISTOIRE",
    raison: "le registre canonique des faits (§17) : ce qui a eu lieu a eu lieu." },
  { modele: "Task", champType: "evidenceEntityType", champId: "evidenceEntityId", conduite: "HISTOIRE",
    raison: "la PREUVE d'une tâche qui vit ailleurs : la tâche reste, sa preuve désignait cet objet." },
  { modele: "Conversation", champType: "refType", champId: "refId", conduite: "HISTOIRE",
    raison: "une conversation qui CITE la demande : la correspondance des personnes ne s'efface pas avec l'objet cité." },
  { modele: "Message", champType: "refType", champId: "refId", conduite: "HISTOIRE",
    raison: "un message qui cite la demande : même raison." },
  { modele: "EntityMention", champType: "entityType", champId: "entityId", conduite: "HISTOIRE",
    raison: "l'index des mentions : il sait déjà ignorer un objet disparu." },
  { modele: "KnowledgeItem", champType: "sourceType", champId: "sourceId", conduite: "HISTOIRE",
    raison: "l'index de connaissance : une entrée périmée s'y retrouve sans rien casser." },
  { modele: "KnowledgeEntity", champType: "refType", champId: "refId", conduite: "HISTOIRE",
    raison: "idem : un index, pas une branche." },
  { modele: "AssistantSignal", champType: "entiteType", champId: "entiteId", conduite: "HISTOIRE",
    raison: "un constat d'un veilleur de l'Assistant IA (J12) : son passage suivant constate lui-même la disparition de l'objet (RÉSOLU) ; le constat reste à l'écran de sa personne comme une trace." },
  { modele: "AdamWatch", champType: "targetType", champId: "targetId", conduite: "HISTOIRE",
    raison: "une surveillance d'Adam : son balayage constate lui-même la disparition de sa cible." },
  { modele: "ApiCall", champType: "entityType", champId: "entityId", conduite: "HISTOIRE",
    raison: "le journal des appels d'API." },
  { modele: "TacheEnrichissement", champType: "rattachementType", champId: "rattachementId", conduite: "HISTOIRE",
    raison: "la file de l'enrichissement (refonte, V2-A) : la trace d'un DÉPÔT qui a eu lieu ; traitée ou non, elle ne porte aucun contenu et ne bloque rien." },
  { modele: "KnowledgeLink", champType: "toType", champId: "toId", conduite: "HISTOIRE",
    raison: "un lien de l'index de connaissance : un index, pas une branche." },
  { modele: "AssistantReminder", champType: "watchType", champId: "watchId", conduite: "HISTOIRE",
    raison: "un rappel interne d'Adam : comme ses surveillances, il constate lui-même que sa cible a disparu." },
  { modele: "LecturePieceConfirmation", champType: "cibleType", champId: "cibleId", conduite: "HISTOIRE",
    raison: "une ATTESTATION (lot D2) : une personne a relu, ligne à ligne, ce qu'une lecture proposait — l'audit porte son nom. On ne réécrit pas le passé : elle reste quand la pièce part, et une pièce restaurée la retrouve par son identifiant." },
  { modele: "DocumentReference", champType: "entityType", champId: "entityId", conduite: "HISTOIRE",
    raison: "le REGISTRE COMMUN des références NNN/DG/AAAA (Direction, 10/2026) : un numéro attribué ne se réutilise jamais — la ligne reste quand le document part, sinon son numéro redeviendrait libre et serait donné à un autre document." },
];

/**
 * LE TYPE D'ENTITÉ D'UNE LIGNE, par son modèle — ce qui permet de DESCENDRE : une déclaration
 * d'information médicale a elle-même sa demande de bon de versement, un poste ses demandes au
 * secrétariat. Sans type d'entité, une ligne n'a ni pièces jointes, ni branches à elle.
 */
export const ENTITE_DU_MODELE: Readonly<Record<string, EntityType>> = {
  SponsoringRequest: "SPONSORING",
  Event: "EVENT",
  CongressInternational: "CONGRESS_INTERNATIONAL",
  CongressNational: "CONGRESS_NATIONAL",
  PromoMaterial: "PROMO_MATERIAL",
  ConsultingContract: "CONSULTING_CONTRACT",
  AdProOtherRequest: "AD_PRO_OTHER",
  AdProItem: "AD_PRO_ITEM",
  MedicalInfoDeclaration: "MEDICAL_INFO_DECLARATION",
  AdministrativeRequest: "ADMIN_REQUEST",
  ValidationRequest: "VALIDATION_REQUEST",
  PaymentRequest: "PAYMENT_REQUEST",
  ExpenseOrder: "EXPENSE_ORDER",
  LegalDocument: "LEGAL_DOCUMENT",
  MailEntry: "MAIL_ENTRY",
  DocumentRequest: "DOCUMENT_REQUEST",
  Dossier: "DOSSIER",
  MissionAssignment: "MISSION_ASSIGNMENT",
  Task: "TASK",
  BdProject: "BD_PROJECT",
  // L'écriture de trésorerie (§118.176) : ses pièces jointes et commentaires partent avec elle.
  FinanceTransaction: "FINANCE_TRANSACTION",
  // Une formation (§118.184) : ses pièces s'écrivaient sous DOSSIER, donc ne la suivaient pas.
  Training: "TRAINING",
  // Un appel d'offres PCH (§118.185, I17) et ses bons de commande : leurs pièces jointes, leurs
  // factures (`sourceType = PCH_ORDER`), leurs courriers et leurs liens partent avec eux — une
  // facture RÉGLÉE bloque la suppression (`faitIrreversible`), elle ne la suit pas en silence.
  PchTender: "PCH_TENDER",
  PchOrder: "PCH_ORDER",
  // Un cas de pharmacovigilance (Direction, 06/10) : ses pièces et son échange le suivent.
  PharmacovigilanceCase: "PHARMACOVIGILANCE_CASE",
  // Un élément du Drive (10/2026) : ses pièces et commentaires polymorphes le suivent, sous-dossiers compris.
  DriveNode: "DRIVE_NODE",
  // Un praticien (audit 27/10, DONNEES-07) : ses pièces, ses commentaires, sa segmentation et ses observations
  // partent dans le même lot de corbeille et reviennent avec lui.
  MedicalDoctor: "DOCTOR",
};

/**
 * LES LIENS DIRECTS qui désignent une branche créée PAR une autre branche, sans passer par un
 * couple (type, identifiant) : le bon de versement d'une déclaration, l'ordre de dépense d'une
 * facture. Ce sont des objets EN AVAL — ils partent avec leur branche.
 */
export const LIENS_DIRECTS: readonly { modele: string; champ: string; cible: string }[] = [
  { modele: "MedicalInfoDeclaration", champ: "expenseOrderId", cible: "ExpenseOrder" },
  { modele: "MedicalInfoDeclaration", champ: "bvValidationId", cible: "ValidationRequest" },
  { modele: "MedicalInfoDeclaration", champ: "bvRequestId", cible: "PaymentRequest" },
  { modele: "PaymentRequest", champ: "expenseOrderId", cible: "ExpenseOrder" },
  { modele: "LegalDocument", champ: "expenseOrderId", cible: "ExpenseOrder" },
  // L'ORDRE DE DÉPENSE D'UN POSTE Ad & Pro (§118.187) : le poste le désigne par un champ texte, et
  // l'ordre ne porte que l'OPÉRATION en source. Sans ce lien, la corbeille emportait le poste et
  // laissait son ordre non réglé payable au centre de paiement, pour un poste disparu ; un ordre
  // RÉGLÉ, lui, bloque la suppression (`faitIrreversible`).
  { modele: "AdProItem", champ: "expenseOrderId", cible: "ExpenseOrder" },
];

/**
 * LES RÉFÉRENCES TEXTE vers une ligne du lot, depuis une ligne qui RESTE (§118.176).
 *
 * Un champ texte, pas une clé étrangère : Postgres ne le viderait pas, et il désignerait une ligne
 * disparue — l'ordre de dépense réglé dirait « payé par l'écriture FIN-2026-104 » sur une écriture
 * qui n'existe plus. Le lot le VIDE, dans la même transaction, et le RÉTABLIT à la restauration,
 * exactement comme un lien qu'une clé étrangère met à vide.
 *
 * À la différence de `LIENS_DIRECTS`, ces lignes ne partent JAMAIS avec le lot : un ordre de dépense
 * n'est pas « en aval » de son écriture, c'est l'écriture qui raconte son règlement. Les mêler à
 * `LIENS_DIRECTS` les aurait fait suivre dans l'autre sens — supprimer un ordre aurait emporté
 * l'écriture de trésorerie qui le règle. Deux questions, deux listes (§118.57).
 */
export const REFERENCES_TEXTE: readonly { modele: string; champ: string; cible: string }[] = [
  { modele: "ExpenseOrder", champ: "transactionId", cible: "FinanceTransaction" },
  { modele: "PettyCashAllotment", champ: "transactionId", cible: "FinanceTransaction" },
  { modele: "PettyCashTopUpRequest", champ: "transactionId", cible: "FinanceTransaction" },
  { modele: "SalaryAdvance", champ: "transactionId", cible: "FinanceTransaction" },
  { modele: "PayrollEntry", champ: "transactionId", cible: "FinanceTransaction" },
  // Le virement de paie garde l'écriture qui l'a soldé (§118.176) — ce fait survit à la purge
  // de l'historique des règlements, et doit être vidé puis rétabli avec elle.
  { modele: "PayrollWire", champ: "transactionId", cible: "FinanceTransaction" },
];

const ref = (d: Record<string, unknown>) => {
  const r = d.reference ?? d.number ?? d.title ?? d.label ?? d.id;
  return typeof r === "string" && r.trim() ? r.trim() : String(d.id ?? "");
};

/**
 * UN FAIT QUI A QUITTÉ L'ERP — et qui interdit donc de supprimer la demande qui le justifie.
 *
 * Rend la phrase qui le NOMME, ou `null`. La liste est FERMÉE : chaque entrée est un fait qu'on
 * ne défait pas en effaçant une ligne — l'argent est parti, une personne a signé, l'autorité a
 * reçu un dépôt, un courrier est inscrit au registre chronologique.
 */
export function faitIrreversible(modele: string, d: Record<string, unknown>): string | null {
  switch (modele) {
    case "ExpenseOrder":
      if (d.status === "PAID" || d.paidDate || d.transactionId) return `l'ordre de dépense ${ref(d)} a été réglé`;
      return null;
    case "LegalDocument":
      if (d.paidDate || d.settlementTxId) return `la facture ${ref(d)} a été réglée`;
      if (d.signedById) return `la pièce ${ref(d)} a été signée par les Finances`;
      if (d.signedAt) return `la pièce ${ref(d)} est signée`;
      return null;
    case "MedicalInfoDeclaration":
      if (d.authorityRef) return `la déclaration ${ref(d)} a été déposée auprès des autorités (récépissé ${String(d.authorityRef)})`;
      return null;
    case "MailEntry":
      return `le courrier ${ref(d)} est inscrit au registre des courriers`;
    case "PromoFactureLigne":
      // LA RÉCEPTION D'UNE LIGNE DE FACTURE A FAIT ENTRER DU MATÉRIEL AU MAGASIN (§118.165) : le
      // lot reste au stock quoi qu'on efface, et la demande est la cause de cette entrée.
      if (Number(d.quantiteRecue ?? 0) > 0) return `du matériel de la facture (« ${String(d.designation ?? "ligne")} ») a été reçu au magasin`;
      return null;
    case "AdProStockLine":
      // LE MATÉRIEL DU STOCK (§118.167) — la MÊME règle que la suppression d'un poste : sinon une
      // demande que la corbeille refuse se laisserait vider poste par poste (§118.71).
      return faitDeStock({ statut: String(d.statut ?? ""), utilisee: d.utilisee, abimee: d.abimee, perdue: d.perdue });
    default:
      return null;
  }
}

/** Le délégué Prisma d'un modèle — la convention du client généré (première lettre minuscule). */
export function delegueDe(modele: string): string {
  return modele.charAt(0).toLowerCase() + modele.slice(1);
}

/** Libellés lisibles, pour dire à la personne ce qui part avec la demande. */
export const LIBELLE_DU_MODELE: Readonly<Record<string, [string, string]>> = {
  // Ce qui part avec un praticien (DONNEES-07) — l'aperçu le dit en français avant le clic.
  DirectoryCellStyle: ["couleur de cellule d'annuaire", "couleurs de cellule d'annuaire"],
  SegmentationFiche: ["fiche de segmentation", "fiches de segmentation"],
  HcpObservation: ["observation de praticien", "observations de praticien"],
  SegmentationDerogation: ["dérogation de segmentation", "dérogations de segmentation"],
  AdProItem: ["poste", "postes"],
  AdProItemDecision: ["décision de poste", "décisions de poste"],
  AdProProductAllocation: ["répartition par produit", "répartitions par produit"],
  EventRegistration: ["inscription", "inscriptions"],
  CareBeneficiary: ["personne prise en charge", "personnes prises en charge"],
  CareCell: ["case de prise en charge", "cases de prise en charge"],
  CareQuote: ["devis de prise en charge", "devis de prise en charge"],
  CareQuoteCell: ["ligne de devis", "lignes de devis"],
  // Les postes « par personne » d'une prise en charge de groupe (Direction, 10/2026) : ils partent avec la demande.
  CareGroupPoste: ["poste de groupe", "postes de groupe"],
  AdProStockLine: ["article du stock demandé", "articles du stock demandés"],
  // Les voyageurs d'un poste de billetterie (§118.175) : ils partent avec leur poste, et reviennent avec lui.
  AdProVoyageur: ["voyageur", "voyageurs"],
  // Les fiches hôtellerie d'un poste d'hôtellerie (Direction, 06/10) : même sort que les voyageurs.
  AdProHebergement: ["fiche hôtellerie", "fiches hôtellerie"],
  DemandeReservation: ["demande de réservation", "demandes de réservation"],
  AdProIntegrationDemande: ["ligne d'intégration Ad & Pro", "lignes d'intégration Ad & Pro"],
  AdProRapprochement: ["rapprochement Ad & Pro", "rapprochements Ad & Pro"],
  AdProItemPiece: ["pièce de poste", "pièces de poste"],
  AdProVoyageurDevis: ["devis de voyageur", "devis de voyageurs"],
  // Le devis d'un poste lu par Luna (§118.206) : la fiche structurée et ses lignes partent avec la pièce.
  AdProDevis: ["devis lu", "devis lus"],
  AdProDevisLigne: ["ligne de devis lue", "lignes de devis lues"],
  // Les achats du matériel promotionnel (§118.165) : ce qu'une demande pioche dans le catalogue,
  // et les factures reçues ligne à ligne.
  PromoRequestItem: ["article demandé", "articles demandés"],
  PromoRequestItemProduct: ["produit d'un article demandé", "produits d'articles demandés"],
  PromoFacture: ["facture saisie en lignes", "factures saisies en lignes"],
  PromoFactureLigne: ["ligne de facture", "lignes de facture"],
  PromoQuote: ["devis retranscrit", "devis retranscrits"],
  PromoQuoteLine: ["ligne de devis", "lignes de devis"],
  ConsultingTask: ["tâche du contrat", "tâches du contrat"],
  MedicalInfoDeclaration: ["déclaration d'information médicale", "déclarations d'information médicale"],
  MedicalInfoSlip: ["bon de versement", "bons de versement"],
  MedicalInfoDocRequest: ["demande de pièce du pharmacien", "demandes de pièces du pharmacien"],
  AdministrativeRequest: ["demande au secrétariat", "demandes au secrétariat"],
  AdminApproval: ["validation au secrétariat", "validations au secrétariat"],
  WorkflowInstance: ["circuit de validation", "circuits de validation"],
  WorkflowStepEvent: ["étape franchie", "étapes franchies"],
  AdProGateVisa: ["visa", "visas"],
  AdProPorteDg: ["validation du total par le DG", "validations du total par le DG"],
  ValidationRequest: ["demande de validation", "demandes de validation"],
  ValidationStep: ["étape de validation", "étapes de validation"],
  ValidationParticipant: ["participant à la demande de validation", "participants à la demande de validation"],
  PharmacovigilanceCase: ["cas de pharmacovigilance", "cas de pharmacovigilance"],
  PharmacovigilanceParticipant: ["participant à un cas de pharmacovigilance", "participants à un cas de pharmacovigilance"],
  LeaveEscalation: ["avis demandé au N+1", "avis demandés au N+1"],
  ValidationItemDecision: ["décision de ligne validée", "décisions de lignes validées"],
  PaymentRequest: ["demande de paiement", "demandes de paiement"],
  PaymentPiece: ["pièce de paiement", "pièces de paiement"],
  PaymentRequestEvent: ["événement de paiement", "événements de paiement"],
  ExpenseOrder: ["ordre de dépense", "ordres de dépense"],
  PaymentCentreMessage: ["message du centre de paiement", "messages du centre de paiement"],
  LegalDocument: ["pièce au registre Legal", "pièces au registre Legal"],
  LegalDocumentReader: ["lecteur désigné", "lecteurs désignés"],
  MailEntry: ["courrier", "courriers"],
  MailEntryPiece: ["pièce de courrier", "pièces de courrier"],
  DocumentRequest: ["demande de pièce", "demandes de pièces"],
  Dossier: ["sujet", "sujets"],
  DossierMessage: ["message de sujet", "messages de sujet"],
  DossierMessageAttachment: ["pièce de message", "pièces de message"],
  MissionAssignment: ["affectation", "affectations"],
  MissionParticipationVersion: ["version de fiche de participation", "versions de fiche de participation"],
  MissionExpenseLine: ["dépense de mission", "dépenses de mission"],
  Task: ["tâche", "tâches"],
  TaskComment: ["commentaire de tâche", "commentaires de tâche"],
  Reminder: ["rappel", "rappels"],
  RowGrant: ["droit sur la ligne", "droits sur la ligne"],
  EntityLink: ["lien « relié à »", "liens « relié à »"],
  MailLink: ["e-mail classé", "e-mails classés"],
  AdProMedecin: ["médecin concerné", "médecins concernés"],
  PchContractLine: ["ligne de marché", "lignes de marché"],
  // Le registre des projets (§118.163) : ce qu'un projet emporte, et ce qui perd son lien avec lui.
  BdRange: ["gamme", "gammes"],
  BdProduct: ["produit à l'étude", "produits à l'étude"],
  RegulatoryProduct: ["dossier réglementaire", "dossiers réglementaires"],
  // Une écriture de trésorerie supprimée depuis « À imputer » (§118.176) : ce qui la cite et RESTE.
  FinanceTransaction: ["écriture de trésorerie", "écritures de trésorerie"],
  PettyCashAllotment: ["dotation de caisse d'avance", "dotations de caisse d'avance"],
  PettyCashTopUpRequest: ["rallonge de caisse d'avance", "rallonges de caisse d'avance"],
  SalaryAdvance: ["avance sur salaire", "avances sur salaire"],
  PayrollEntry: ["bulletin de paie", "bulletins de paie"],
  PayrollWire: ["virement de paie", "virements de paie"],
  // Les pièces jointes d'un rapport terrain (§118.212) : elles partent avec lui, et reviennent avec lui.
  FieldReportAttachment: ["pièce jointe", "pièces jointes"],
  // Un appel d'offres PCH (§118.185, I17) : ce qui part avec lui…
  PchTenderLine: ["lot du marché", "lots du marché"],
  PchTenderLineBusinessUnit: ["affectation d'un lot à une BU", "affectations de lots à des BU"],
  PchTenderExtraction: ["lecture du document du marché", "lectures du document du marché"],
  PchSubmission: ["version de soumission", "versions de soumission"],
  PchOrder: ["bon de commande du marché", "bons de commande du marché"],
  PchOrderLine: ["ligne de bon de commande", "lignes de bon de commande"],
  PchDelivery: ["livraison", "livraisons"],
  PchDeliveryLine: ["ligne de livraison", "lignes de livraison"],
  // …et ce qui RESTE en perdant son lien avec lui : une vente déjà faite, un mouvement de stock
  // déjà passé — le stock ne bouge pas quand on supprime un marché.
  Sale: ["vente", "ventes"],
  StockMovement: ["mouvement de stock", "mouvements de stock"],
  // Un élément du Drive supprimé depuis la corbeille du Drive (10/2026) : tout son contenu part avec lui et revient
  // avec lui ; les messages, courriers et pièces qui le citaient RESTENT, et retrouvent leur lien à la restauration.
  DriveNode: ["élément du Drive", "éléments du Drive"],
  FileVersion: ["version", "versions"],
  DriveShare: ["partage", "partages"],
  DriveComment: ["commentaire", "commentaires"],
  DriveTextIndex: ["index de recherche", "index de recherche"],
  EntityMention: ["mention", "mentions"],
  ArtifactSession: ["session d'édition", "sessions d'édition"],
  ArtifactOperation: ["modification enregistrée", "modifications enregistrées"],
  MessageAttachment: ["pièce partagée en messagerie", "pièces partagées en messagerie"],
};

export function libelleDe(modele: string, n: number): string {
  const l = LIBELLE_DU_MODELE[modele];
  if (!l) return `${n} ${modele}`;
  return `${n} ${n > 1 ? l[1] : l[0]}`;
}

/**
 * CE QUI RESTE mais PERD SON LIEN avec l'élément supprimé — « 3 dossiers réglementaires »
 * perdent leur projet, une pièce d'un autre dossier perd sa pièce parente (§118.163).
 *
 * Compté par LIGNE, jamais par lien : un dossier qui désignerait l'élément par deux champs reste
 * UN dossier, et le compter deux fois gonflerait ce qu'on annonce à la personne.
 */
export function resumeDesLiens(liens: readonly { modele: string; cle: Record<string, unknown> }[]): string[] {
  const parModele = new Map<string, Set<string>>();
  for (const l of liens) {
    const lignes = parModele.get(l.modele) ?? new Set<string>();
    lignes.add(JSON.stringify(l.cle));
    parModele.set(l.modele, lignes);
  }
  return [...parModele]
    .sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]))
    .map(([modele, lignes]) => libelleDe(modele, lignes.size));
}

/** Le nom d'UN élément de ce modèle, sans compte — pour une phrase qui désigne une ligne précise. */
export function nomDe(modele: string): string {
  return LIBELLE_DU_MODELE[modele]?.[0] ?? modele;
}
