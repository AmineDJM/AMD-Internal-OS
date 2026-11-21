import type { AdProItemKind, AdProItemOrderStage, AdProItemStatus } from "@prisma/client";
import type { EtapeBC } from "@/lib/bons-de-commande/regle";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE PARCOURS AGENCE D'UN POSTE (Direction, 15/11/2026) — PUR, sûr pour le navigateur.
 *
 * Un poste « payé par une agence » suit un seul chemin, le même pour tout l'Ad & Pro :
 *
 *   prospection (la Direction Marketing la demande, l'assistante dépose les devis)
 *   → choix de l'agence (la Direction Marketing : montant = devis retenu, budget)
 *   → bon de commande (généré du devis, finalisé par l'assistante, validé + signé + cacheté par la Direction Marketing,
 *     visé par le centre Ad & Pro au-dessus du seuil, signé + cacheté par les Finances)
 *   → envoi à l'agence → conformité du BAT (information médicale, si requise) → réception (PV)
 *   → facture → centre de paiement → paiement.
 *
 * Ce module dit OÙ en est le poste (`etapeAgence`), la frise (`friseAgence`) et, pour la personne qui regarde, LE geste
 * suivant ou qui l'on attend (`pasAgence`). Les gardes restent dans les actions ; chaque geste rendu ici est un geste que
 * l'action accepte dans cet état.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type StatutConformite = "EN_CONTROLE" | "CONFORME" | "NON_CONFORME";

/** Ce que l'exécution d'un poste « agence » porte — lu sur `AdProExecutionPoste` et la chaîne d'achat du poste. */
export interface FaitsAgence {
  prospectionDemandee: boolean;
  devisTransmis: boolean;
  agenceRetenue: boolean;
  /** Le brouillon du BC (aperçu, sans numéro) existe sur le devis retenu. */
  brouillonBc: boolean;
  bcSoumis: boolean;
  /** La Direction Marketing a signé (en ligne) le BC émis. */
  signatureMarketing: boolean;
  bcEnvoye: boolean;
  conformiteRequise: boolean;
  conformite: StatutConformite | null;
  receptionFaite: boolean;
  /** Le nom de l'assistante chargée de la prospection, pour dire chez qui en est le poste. */
  assistante: string | null;
}

/** Les faits du poste lui-même dont le parcours dépend. */
export interface FaitsPosteAgence {
  status: AdProItemStatus;
  orderStage: AdProItemOrderStage;
  /** L'étape du BC émis au registre, ou `null` tant qu'aucun BC n'est émis. */
  bc: EtapeBC | null;
  factures: number;
  expenseOrderId: string | null;
  expenseOrderStatus: string | null;
  expenseOrderCentral?: string | null;
  agence: FaitsAgence;
}

export type EtapeAgence =
  | "PROSPECTION_A_DEMANDER" | "PROSPECTION" | "CHOIX"
  | "BC_A_PREPARER" | "BC_CHEZ_ASSISTANTE" | "BC_A_VALIDER" | "BC_A_SIGNER_MARKETING"
  | "BC_CHEZ_CENTRE" | "BC_A_SIGNER_FINANCES" | "BC_A_CORRIGER"
  | "BC_A_ENVOYER" | "BAT_A_ENVOYER" | "CONFORMITE" | "BAT_NON_CONFORME"
  | "RECEPTION" | "FACTURE" | "PAIEMENT" | "PAYE" | "REFUSE";

/** OÙ EN EST LE POSTE — le premier pas non fait, dans l'ordre du cycle. */
export function etapeAgence(p: FaitsPosteAgence): EtapeAgence {
  const a = p.agence;
  if (p.status === "REJECTED") return "REFUSE";
  if (p.expenseOrderStatus === "PAID") return "PAYE";
  if (p.expenseOrderId) return "PAIEMENT";
  if (!a.prospectionDemandee) return "PROSPECTION_A_DEMANDER";
  if (!a.devisTransmis) return "PROSPECTION";
  if (!a.agenceRetenue || p.status !== "APPROVED") return "CHOIX";
  if (!p.bc) {
    if (!a.brouillonBc) return "BC_A_PREPARER";
    return a.bcSoumis ? "BC_A_VALIDER" : "BC_CHEZ_ASSISTANTE";
  }
  if (p.bc === "REFUSE") return "REFUSE";
  if (!a.signatureMarketing) return "BC_A_SIGNER_MARKETING";
  if (p.bc === "A_VALIDER" || p.bc === "A_REVOIR" || p.bc === "SANS_PORTE" || p.orderStage === "REQUESTED") return "BC_CHEZ_CENTRE";
  if (p.bc === "A_CORRIGER") return "BC_A_CORRIGER";
  if (p.bc !== "SIGNE") return "BC_A_SIGNER_FINANCES";
  if (!a.bcEnvoye) return "BC_A_ENVOYER";
  if (a.conformiteRequise && a.conformite !== "CONFORME") {
    if (a.conformite === "EN_CONTROLE") return "CONFORMITE";
    return a.conformite === "NON_CONFORME" ? "BAT_NON_CONFORME" : "BAT_A_ENVOYER";
  }
  if (!a.receptionFaite) return "RECEPTION";
  return "FACTURE";
}

export type EtatFrise = "FAIT" | "EN_COURS" | "A_VENIR" | "REFUSE";
export interface EtapeFriseAgence { cle: string; libelle: string; etat: EtatFrise }

/** L'ordre des étapes de la frise, et l'étape du parcours qui ouvre chacune. */
const JALONS: { cle: string; libelle: string; debut: EtapeAgence[] }[] = [
  { cle: "AGENCES", libelle: "Agences", debut: ["PROSPECTION_A_DEMANDER", "PROSPECTION"] },
  { cle: "CHOIX", libelle: "Choix", debut: ["CHOIX"] },
  { cle: "BC", libelle: "Bon de commande", debut: ["BC_A_PREPARER", "BC_CHEZ_ASSISTANTE", "BC_A_VALIDER", "BC_A_SIGNER_MARKETING", "BC_CHEZ_CENTRE", "BC_A_SIGNER_FINANCES", "BC_A_CORRIGER"] },
  { cle: "EXECUTION", libelle: "Exécution", debut: ["BC_A_ENVOYER", "BAT_A_ENVOYER", "CONFORMITE", "BAT_NON_CONFORME"] },
  { cle: "RECEPTION", libelle: "Réception", debut: ["RECEPTION"] },
  { cle: "FACTURE", libelle: "Facture", debut: ["FACTURE"] },
  { cle: "PAIEMENT", libelle: "Paiement", debut: ["PAIEMENT", "PAYE"] },
];

/** LA FRISE D'UN POSTE AGENCE — une étape EN COURS au plus, les précédentes faites. */
export function friseAgence(p: FaitsPosteAgence): EtapeFriseAgence[] {
  const e = etapeAgence(p);
  if (e === "REFUSE") {
    const ou = p.bc === "REFUSE" ? 2 : 1;
    return JALONS.map((j, i) => ({ cle: j.cle, libelle: j.libelle, etat: i < ou ? "FAIT" : i === ou ? "REFUSE" : "A_VENIR" }));
  }
  const ici = JALONS.findIndex((j) => j.debut.includes(e));
  return JALONS.map((j, i) => ({
    cle: j.cle, libelle: j.libelle,
    etat: e === "PAYE" || i < ici ? "FAIT" : i === ici ? "EN_COURS" : "A_VENIR",
  }));
}

/** Qui regarde — calculé au serveur. */
export interface RegardAgence {
  /** Direction Marketing sur cette demande (ou Super Admin) : demande la prospection, choisit, valide, signe, exécute. */
  marketing: boolean;
  /** L'assistante chargée de la prospection de CE poste (ou, la prospection pas encore assignée, toute assistante). */
  assistante: boolean;
  /** L'information médicale (pharmacien responsable, ou Super Admin). */
  infoMed: boolean;
  /** Siège au centre de validation Ad & Pro (DG, Super Admin). */
  centre: boolean;
  /** Demande close : on exécute encore, on ne décide plus. */
  fige: boolean;
}

export type GesteAgence =
  | "DEMANDER_PROSPECTION" | "DEPOSER_DEVIS" | "CHOISIR_AGENCE" | "PREPARER_BC" | "FINALISER_BC"
  | "VALIDER_SIGNER_BC" | "SIGNER_BC_MARKETING" | "VISER_BC" | "ENVOYER_BC" | "ENVOYER_BAT" | "CONTROLER_BAT"
  | "SIGNER_RECEPTION" | "DEPOSER_FACTURE";

export interface PasAgence {
  geste: { cle: GesteAgence; libelle: string } | null;
  /** Sinon, ce qu'on attend et de qui. `null` au bout du chemin. */
  attente: string | null;
}

const DM = "la Direction Marketing";

/** LE PROCHAIN GESTE de la personne qui regarde — un seul ; sinon chez qui en est le poste. */
export function pasAgence(p: FaitsPosteAgence, r: RegardAgence): PasAgence {
  const e = etapeAgence(p);
  const chezAssistante = p.agence.assistante ? `chez ${p.agence.assistante} (assistante de direction)` : "chez l'assistante de direction";
  const g = (cle: GesteAgence, libelle: string): PasAgence => ({ geste: { cle, libelle }, attente: null });
  const att = (attente: string): PasAgence => ({ geste: null, attente });
  const mk = r.marketing && !r.fige;
  switch (e) {
    case "PROSPECTION_A_DEMANDER":
      return mk ? g("DEMANDER_PROSPECTION", "Demander la prospection d'agences") : att(`À lancer — ${DM} demande la prospection d'agences.`);
    case "PROSPECTION":
      return r.assistante ? g("DEPOSER_DEVIS", "Déposer les devis des agences") : att(`Prospection d'agences — ${chezAssistante}.`);
    case "CHOIX":
      return mk ? g("CHOISIR_AGENCE", "Comparer les devis et choisir l'agence") : att(`Devis reçus — ${DM} choisit l'agence.`);
    case "BC_A_PREPARER":
      return mk ? g("PREPARER_BC", "Préparer le bon de commande") : att(`Bon de commande en préparation — ${DM}.`);
    case "BC_CHEZ_ASSISTANTE":
      return r.assistante ? g("FINALISER_BC", "Finaliser le bon de commande") : att(`Bon de commande à finaliser — ${chezAssistante}.`);
    case "BC_A_VALIDER":
      return mk ? g("VALIDER_SIGNER_BC", "Valider, signer et cacheter le BC") : att(`BC à valider et signer — chez ${DM}.`);
    case "BC_A_SIGNER_MARKETING":
      return mk ? g("SIGNER_BC_MARKETING", "Signer et cacheter le BC") : att(`BC à signer — chez ${DM}.`);
    case "BC_CHEZ_CENTRE":
      return r.centre ? g("VISER_BC", "Viser le bon de commande") : att("BC au-dessus du seuil — chez le DG (centre de validation Ad & Pro).");
    case "BC_A_SIGNER_FINANCES":
      return att("BC à signer et cacheter — chez les Finances.");
    case "BC_A_CORRIGER":
      return r.assistante ? g("FINALISER_BC", "Corriger le bon de commande renvoyé") : att(`BC renvoyé par les Finances — à corriger ${chezAssistante}.`);
    case "BC_A_ENVOYER":
      return mk ? g("ENVOYER_BC", "Envoyer le BC signé à l'agence") : att(`BC signé — ${DM} l'envoie à l'agence.`);
    case "BAT_A_ENVOYER":
      return mk ? g("ENVOYER_BAT", "Envoyer le BAT à l'information médicale") : att(`En exécution — ${DM} transmet le BAT pour le contrôle de conformité.`);
    case "BAT_NON_CONFORME":
      return mk ? g("ENVOYER_BAT", "Envoyer le BAT corrigé") : att(`BAT non conforme — ${DM} le fait corriger par l'agence.`);
    case "CONFORMITE":
      return r.infoMed ? g("CONTROLER_BAT", "Contrôler la conformité du BAT") : att("Contrôle de conformité — chez l'information médicale.");
    case "RECEPTION":
      return mk ? g("SIGNER_RECEPTION", "Signer le PV de réception") : att(`En exécution — ${DM} réceptionne la commande.`);
    case "FACTURE":
      return mk ? g("DEPOSER_FACTURE", "Déposer la facture et demander le paiement") : att(`Réceptionné — ${DM} dépose la facture de l'agence.`);
    case "PAIEMENT":
      return att(p.expenseOrderCentral === "APPROVED" ? "Paiement autorisé — chez les Finances." : "Paiement demandé — chez le centre de paiement.");
    case "PAYE":
    case "REFUSE":
      return { geste: null, attente: null };
  }
}

/**
 * LE CONTRÔLE DE CONFORMITÉ PROPOSÉ selon la nature (Direction, 15/11/2026) : ce qui porte un message sur le produit — l'imprimé,
 * le stand, le symposium, le matériel promotionnel — passe par l'information médicale ; la salle, le traiteur, l'hôtel, le
 * transport, non. La Direction Marketing peut changer la case poste par poste.
 */
const NATURES_A_CONFORMITE: readonly AdProItemKind[] = ["PRINTING", "STAND", "SYMPOSIUM", "PROMO_MATERIAL", "SERVICE"];
export const conformiteParDefaut = (kind: AdProItemKind): boolean => NATURES_A_CONFORMITE.includes(kind);

/**
 * LES NATURES QUI PEUVENT PASSER PAR UNE AGENCE — tout poste d'argent, sauf ceux qui ont déjà leur propre chemin : le matériel du
 * stock (aucun argent), le matériel promotionnel (son circuit), la billetterie et l'hôtellerie (devis par personne) et le
 * sponsoring indirect non réparti (il se répartit d'abord en blocs).
 */
const HORS_AGENCE: readonly AdProItemKind[] = ["STOCK_MATERIAL", "PROMO_MATERIAL", "TICKETING", "ACCOMMODATION", "INDIRECT_SUPPORT"];
export const voieAgencePossible = (kind: AdProItemKind): boolean => !HORS_AGENCE.includes(kind);

/** La voie proposée à l'ajout d'un poste : directe pour le versement à l'association, par une agence sinon (quand c'est possible). */
export const voieParDefaut = (kind: AdProItemKind): "AGENCE" | "DIRECT" | null =>
  kind === "ASSOCIATION_SUPPORT" ? "DIRECT" : voieAgencePossible(kind) ? "AGENCE" : null;

/** Le libellé court d'une étape — pour les files « à faire » et l'historique. */
export const LIBELLE_ETAPE_AGENCE: Record<EtapeAgence, string> = {
  PROSPECTION_A_DEMANDER: "Prospection à demander",
  PROSPECTION: "Prospection d'agences",
  CHOIX: "Choix de l'agence",
  BC_A_PREPARER: "BC à préparer",
  BC_CHEZ_ASSISTANTE: "BC à finaliser",
  BC_A_VALIDER: "BC à valider et signer",
  BC_A_SIGNER_MARKETING: "BC à signer (Direction Marketing)",
  BC_CHEZ_CENTRE: "BC au centre Ad & Pro",
  BC_A_SIGNER_FINANCES: "BC à signer (Finances)",
  BC_A_CORRIGER: "BC renvoyé par les Finances",
  BC_A_ENVOYER: "BC à envoyer à l'agence",
  BAT_A_ENVOYER: "BAT à transmettre",
  CONFORMITE: "Contrôle de conformité",
  BAT_NON_CONFORME: "BAT non conforme",
  RECEPTION: "Réception",
  FACTURE: "Facture à déposer",
  PAIEMENT: "Paiement en cours",
  PAYE: "Payé",
  REFUSE: "Refusé",
};

/** Ce que la carte d'un poste « agence » montre — chargé au serveur (`agencesDesPostes`), lu par l'écran. */
export interface AgenceVue {
  faits: FaitsAgence;
  assistanteId: string | null;
  cahierDesCharges: string | null;
  agenceDevisId: string | null;
  agenceNom: string | null;
  conformiteNote: string | null;
  receptionNote: string | null;
  receptionReserve: boolean;
  /** Le BC actif du poste au registre, s'il est émis. */
  bcId: string | null;
  signatures: { qualite: string; nom: string; titre?: string | null; le: string; jeton: string }[];
  /** Le dernier BAT déposé pour le contrôle de conformité. */
  bat: { id: string; nom: string } | null;
  /** L'événement du poste — l'e-mail de demande de devis le cite (16/11/2026). */
  evenement?: { nom: string; debut: string | null; fin: string | null; lieu: string | null; ville: string | null } | null;
}

export const STATUTS_CONFORMITE: readonly StatutConformite[] = ["EN_CONTROLE", "CONFORME", "NON_CONFORME"];
export const lireStatutConformite = (s: string | null | undefined): StatutConformite | null =>
  STATUTS_CONFORMITE.includes(s as StatutConformite) ? (s as StatutConformite) : null;
