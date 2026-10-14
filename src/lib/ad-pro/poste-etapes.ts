import type { AdProItemKind, AdProItemOrderStage, AdProItemStatus } from "@prisma/client";
import type { EtapeBC } from "@/lib/bons-de-commande/regle";
import type { DroitsValidation } from "@/lib/ad-pro/validation-poste";
// Seul import de valeur : un module PUR, sûr pour le navigateur — la règle des fiches par personne
// tient en un endroit, lu par l'action et par la carte (Direction, 06/10).
import { refusFichesPersonnes } from "@/lib/ad-pro/hebergements";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * OÙ EN EST UN POSTE, ET QUEL EST LE GESTE SUIVANT (§118.175) — lu en UNE fois, pour l'écran.
 *
 * « Ici c'est trop complexe : plus simple, plus séparé, plus lisible, moins de boutons et de CTA
 * partout » (Direction, 01/10). Un poste affichait jusqu'à neuf commandes à la fois — deux
 * demandes au secrétariat, une pièce, une validation, les pièces jointes, soumettre, émettre,
 * retirer, modifier —, dont plusieurs DÉSACTIVÉES avec leur raison collée à côté (« L'opération
 * n'a pas encore été accordée » sous un poste encore en brouillon). La personne lisait tout pour
 * trouver la seule chose qu'elle pouvait faire.
 *
 * La règle tient ici, PURE (seul import de valeur : la règle pure des fiches par personne) : la frise d'un poste — chiffré → Direction →
 * budget → bon de commande → paiement — et, pour la personne qui regarde, LE geste suivant, ou ce
 * qu'on attend et de qui. L'écran n'invente rien : il affiche ce que cette fonction rend. Les
 * gestes secondaires (modifier, pièces, demandes au secrétariat, historique, retirer) vivent dans
 * un menu : ils ne disparaissent pas, ils cessent de crier.
 *
 * ── L'ORDRE DES QUESTIONS EST LE CYCLE ──────────────────────────────────────────────────────
 *
 * On ne propose pas de choisir un budget avant l'accord, ni de demander un bon de commande sans
 * budget, ni d'émettre un ordre de dépense sur une opération que personne n'a accordée. Chaque
 * « geste » rendu ici est un geste que l'action serveur ACCEPTERA dans cet état : un bouton
 * qu'une action refuse n'est pas un bouton (§118.83). Les gardes restent dans les actions ; ce
 * module ne dit que ce qui a un sens à proposer — un banc rejoue chaque geste rendu par la VRAIE
 * action et exige qu'elle l'accepte.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type CleEtape = "CHIFFRE" | "OPERATIONS" | "MARKETING" | "BC" | "FACTURE" | "PAIEMENT";
export type EtatEtape = "FAIT" | "EN_COURS" | "A_VENIR" | "REFUSE";

export interface Etape {
  cle: CleEtape;
  libelle: string;
  etat: EtatEtape;
}

/**
 * OÙ EN EST LA DEMANDE DE BC CHEZ L'ASSISTANTE (§118.204) — la demande de pièce qu'elle a reçue.
 * `CHEZ_ASSISTANTE` : elle l'établit ; `DEPOSE` : elle l'a déposé, le demandeur le vérifie.
 */
export type EtatDemandeBC = "AUCUNE" | "CHEZ_ASSISTANTE" | "DEPOSE";

/** Ce qu'un poste porte — les colonnes qui décident de son étape. */
export interface FaitsPoste {
  kind: AdProItemKind;
  status: AdProItemStatus;
  amountEstimated: number | null;
  amountGranted: number | null;
  budgetCategoryId: string | null;
  orderStage: AdProItemOrderStage;
  expenseOrderId: string | null;
  /** Le statut de l'ordre de dépense (« PAID » = réglé). */
  expenseOrderStatus: string | null;
  /** La décision du centre de paiement sur l'ordre (« REFUSED » = refusé) — absente : non lue. */
  expenseOrderCentral?: string | null;
  /** Combien d'articles du magasin un poste « Matériel du stock » liste (§118.167). */
  lignesStock: number;
  /**
   * Le BC est passé SOUS le seuil, sans visa d'aucun centre (§118.149). Il porte le même
   * `DIRECTION_OK` qu'un BC visé — et la phrase ne doit pas dire « validé » à sa place.
   */
  orderSansCentre?: boolean;
  /** Le premier temps de la validation (Direction des opérations), §118.204. */
  opsDecidedAt?: string | null;
  /** La demande de pièce « bon de commande » envoyée à l'assistante, §118.204. */
  demandeBC?: EtatDemandeBC;
  /** L'étape du bon de commande du poste au registre Legal (signature des Finances), ou `null`. */
  bc?: EtapeBC | null;
  /** Combien de factures (non annulées) le poste porte. */
  factures?: number;
  /** Combien de devis / pro forma / lettres de demande (non annulés) le poste porte. */
  devis?: number;
  /**
   * Combien de devis du poste ont des lignes VALIDÉES et pas encore de bon de commande (§118.206) : le BC se GÉNÈRE
   * alors d'après elles, au lieu de se demander à l'assistante. Absent ou nul : aucune ligne validée — le geste
   * reste celui d'avant.
   */
  devisAGenerer?: number;
  /**
   * Combien de FICHES PERSONNES le poste porte — voyageurs (billetterie) et fiches hôtellerie
   * (hôtellerie), Direction 06/10. Absent : non compté — aucune attente n'en naît.
   */
  fichesPersonnes?: number;
  /** Le poste vit dans un sponsoring INDIRECT : ses fiches par personne sont facultatives. */
  priseEnChargeIndirecte?: boolean;
}

/** Ce que la personne qui regarde peut faire — calculé au serveur, jamais deviné ici. */
export interface RegardPoste {
  /** Décrire, chiffrer, soumettre, répartir, demander le BC, déposer la facture. */
  canEdit: boolean;
  /**
   * Arbitrer un poste « Matériel du stock » (sa décision unique), affecter un montant hors du
   * circuit, revoir une décision. Les postes d'ARGENT, eux, se valident en deux temps (`validation`).
   */
  canAllocate: boolean;
  /** Viser un bon de commande (siège au centre de validation Ad & Pro). */
  canViserBC: boolean;
  /** Annuler un ordre émis non réglé (les Finances, ou qui arbitre). */
  canEmettre: boolean;
  /** Demande clôturée : on n'arbitre plus, on exécute encore (§118.151). */
  fige: boolean;
  /** L'opération est accordée — sans quoi aucun ordre de dépense ne part (`canEmitOrder`). */
  operationDecidee: boolean;
  /** Les deux temps de la validation d'un poste d'argent (§118.204). */
  validation?: DroitsValidation;
  /** La demande a été déposée par la Direction Marketing : son second temps revient à la Direction des opérations. */
  secondTempsParOperations?: boolean;
  /** La personne qui regarde a demandé le BC : c'est elle qui vérifie la pièce déposée. */
  verifieLeBC?: boolean;
  /** Valider l'aperçu du BC et l'envoyer aux Finances : le demandeur de la demande, ou le Super Admin. */
  peutValiderBc?: boolean;
}

export type CleGeste =
  | "REPARTIR" | "CHIFFRER" | "SOUMETTRE" | "VALIDER_OPS" | "DECIDER" | "MONTANT" | "BUDGET"
  | "DEMANDER_BC" | "GENERER_BC" | "VISER_BC" | "VERIFIER_BC" | "DEMANDER_PAIEMENT";

export interface Geste {
  cle: CleGeste;
  libelle: string;
}

export interface ProchainPas {
  /** Le geste que CETTE personne peut faire maintenant — un seul. */
  geste: Geste | null;
  /** Sinon : ce qu'on attend, et de qui. `null` quand le poste est arrivé au bout. */
  attente: string | null;
}

/**
 * OÙ EN EST LE PAIEMENT D'UN POSTE (audit Ad & Pro, 14/10) — lu sur l'ordre de dépense ET sur la décision du centre.
 * La carte disait « Paiement en cours — chez le centre de paiement » pour un ordre que le centre avait REFUSÉ, ou que
 * l'annulation de sa facture dans Legal avait ANNULÉ : le demandeur attendait un paiement qui ne viendrait jamais, et le
 * geste qui libère le poste (« Annuler la demande de paiement ») n'était même pas proposé.
 *
 *   • PAYE — l'ordre est réglé ;
 *   • REFUSE — le centre de paiement l'a refusé : on libère le poste, puis on redemande avec la pièce corrigée ;
 *   • ANNULE — l'ordre est annulé ailleurs (facture annulée dans Legal…) : on libère le poste ;
 *   • EN_COURS — au centre, ou chez la comptabilité ;
 *   • AUCUN — pas d'ordre.
 */
export type EtatPaiementPoste = "AUCUN" | "EN_COURS" | "REFUSE" | "ANNULE" | "PAYE";

export function etatDuPaiement(p: { expenseOrderId: string | null; expenseOrderStatus: string | null; expenseOrderCentral?: string | null }): EtatPaiementPoste {
  if (!p.expenseOrderId) return "AUCUN";
  if (p.expenseOrderStatus === "PAID") return "PAYE";
  if (p.expenseOrderStatus === "CANCELLED") return "ANNULE";
  if (p.expenseOrderCentral === "REFUSED") return "REFUSE";
  return "EN_COURS";
}

/** La phrase d'un paiement qui n'aboutira pas — avec le geste qui libère le poste (§118.30). */
export function phrasePaiementBloque(etat: EtatPaiementPoste, reference: string | null = null): string | null {
  const ordre = reference ? `L'ordre ${reference}` : "L'ordre de dépense";
  if (etat === "REFUSE") return `${ordre} a été refusé par le centre de paiement : « Annuler la demande de paiement » libère le poste, puis redemandez le paiement avec la pièce corrigée.`;
  if (etat === "ANNULE") return `${ordre} a été annulé (sa facture a pu être annulée dans Legal) : « Annuler la demande de paiement » libère le poste pour redemander le paiement.`;
  return null;
}

/**
 * LES FAITS D'UN POSTE TELS QUE LE CHARGEUR LES REND — une seule traduction, lue par l'écran ET par
 * le banc qui rejoue chaque geste proposé (§118.5). Recopiée dans le banc, elle aurait pu diverger
 * de celle de l'écran, et le banc aurait vérifié un geste que l'écran ne propose pas (§118.120).
 */
export function faitsDuPoste(r: {
  kind: AdProItemKind;
  status: AdProItemStatus;
  amountEstimated: number | null;
  amountGranted: number | null;
  budgetCategoryId: string | null;
  orderStage: AdProItemOrderStage;
  expenseOrderId: string | null;
  expenseOrder: { status: string; centralStatus?: string | null } | null;
  lignesStock: readonly unknown[];
  orderSansCentre?: boolean;
  opsDecidedAt?: string | null;
  /** La demande de BC ouverte chez l'assistante (`DemandeBCDuPoste`), s'il y en a une. */
  demandeBC?: { etat: EtatDemandeBC } | null;
  /** La chaîne d'achat du poste (`PiecesDuPoste`). */
  pieces?: { bc: { etape: EtapeBC | null } | null; factures: readonly unknown[]; devis?: readonly { annulee?: boolean }[] };
  /** Les devis du poste, lus avec leurs lignes (`DevisDePosteVue`) — seul l'état de leur BC compte ici. */
  devisLignes?: readonly { etat: string }[];
  /** Les voyageurs (billetterie) et fiches hôtellerie (hôtellerie) du poste — seul leur nombre compte ici. */
  voyageurs?: readonly unknown[];
  hebergements?: readonly unknown[];
  priseEnChargeIndirecte?: boolean;
}): FaitsPoste {
  return {
    kind: r.kind, status: r.status, amountEstimated: r.amountEstimated, amountGranted: r.amountGranted,
    budgetCategoryId: r.budgetCategoryId, orderStage: r.orderStage, expenseOrderId: r.expenseOrderId,
    expenseOrderStatus: r.expenseOrder?.status ?? null, expenseOrderCentral: r.expenseOrder?.centralStatus ?? null,
    lignesStock: r.lignesStock.length, orderSansCentre: r.orderSansCentre,
    opsDecidedAt: r.opsDecidedAt ?? null, demandeBC: r.demandeBC?.etat ?? "AUCUNE",
    bc: r.pieces?.bc ? (r.pieces.bc.etape ?? "HORS_CIRCUIT") : null, factures: r.pieces?.factures.length ?? 0,
    devis: (r.pieces?.devis ?? []).filter((d) => !d.annulee).length,
    devisAGenerer: (r.devisLignes ?? []).filter((d) => d.etat === "A_GENERER").length,
    // Un poste ne porte que l'une des deux listes (la nature le décide) : la somme est son compte.
    fichesPersonnes: r.voyageurs || r.hebergements ? (r.voyageurs?.length ?? 0) + (r.hebergements?.length ?? 0) : undefined,
    priseEnChargeIndirecte: r.priseEnChargeIndirecte,
  };
}

/** Les statuts où le demandeur reprend la main : décrire, chiffrer, (re)soumettre. */
export const STATUTS_EDITABLES: readonly AdProItemStatus[] = ["DRAFT", "REVISION", "REJECTED"];

const positif = (m: number | null | undefined): boolean => typeof m === "number" && Number.isFinite(m) && m > 0;
const chiffre = (p: FaitsPoste) => positif(p.amountGranted ?? p.amountEstimated);

/**
 * Un poste dont l'argent part SANS bon de commande : le versement à l'association d'un
 * sponsoring direct (§118.151). « Si c'est un sponsoring direct, on n'a pas besoin d'émettre un bon
 * de commande : facture pro forma facultative, facture obligatoire » (Direction, 04/10, §118.204).
 */
export const VERSEMENT_SANS_BC: readonly AdProItemKind[] = ["ASSOCIATION_SUPPORT"];

/**
 * CE QUE LE PAIEMENT D'UN VERSEMENT À L'ASSOCIATION EXIGE (Direction, 05/10) : « quand c'est un
 * sponsoring direct (à l'association), ça demande « Proforma / lettre de demande de sponsoring » ;
 * la facture n'est pas obligatoire ». Le paiement d'un sponsoring DIRECT part donc de la pro forma
 * ou de la lettre de demande (qui est un DEVIS au registre : une pro forma l'a toujours été), et la
 * facture reste possible, jamais exigée. Un sponsoring INDIRECT (prise en charge : devis → BC →
 * facture) garde la règle d'avant. Une seule fonction, lue par la frise, le geste, les phrases,
 * l'action et l'ordre de dépense — deux lectures de « qu'exige-t-on pour payer ? » finiraient par
 * diverger (§118.5).
 */
export const LIBELLE_JUSTIFICATIF_DIRECT = "Proforma / lettre de demande de sponsoring";
export const facturePourPayer = (kind: AdProItemKind): boolean => !VERSEMENT_SANS_BC.includes(kind);

/** Le BC du poste est-il signé — la condition pour déposer la facture d'un poste qui en a un (§118.204) ? */
export const bcSigne = (p: FaitsPoste) => p.bc === "SIGNE";

/**
 * LA FRISE D'UN POSTE D'ARGENT — chiffré → Direction des opérations → Direction Marketing (budget) →
 * bon de commande → facture → paiement. Un poste « Matériel du stock » n'en a pas : il a son bloc.
 */
export function etapesDuPoste(p: FaitsPoste): Etape[] {
  if (p.kind === "STOCK_MATERIAL") return [];
  const accorde = p.status === "APPROVED";
  const opsFait = Boolean(p.opsDecidedAt) || accorde;
  const paye = p.expenseOrderStatus === "PAID";
  const sansBC = VERSEMENT_SANS_BC.includes(p.kind);
  const factures = p.factures ?? 0;
  const justificatifPose = (p.devis ?? 0) > 0 || factures > 0;
  const etapes: Etape[] = [
    { cle: "CHIFFRE", libelle: "Chiffré", etat: chiffre(p) ? "FAIT" : "EN_COURS" },
    {
      cle: "OPERATIONS", libelle: "Direction des opérations",
      etat: opsFait ? "FAIT"
        : p.status === "REJECTED" ? "REFUSE"
        : p.status === "PENDING" ? "EN_COURS"
        : "A_VENIR",
    },
    {
      cle: "MARKETING", libelle: "Direction Marketing · budget",
      etat: accorde && p.budgetCategoryId ? "FAIT"
        : p.status === "REJECTED" && p.opsDecidedAt ? "REFUSE"
        : (p.status === "PENDING" && p.opsDecidedAt) || accorde ? "EN_COURS"
        : "A_VENIR",
    },
  ];
  // Un versement sans BC qui en a quand même un (poste d'avant cette règle) MONTRE son BC : taire une
  // étape qui a eu lieu ferait mentir la frise.
  if (!sansBC || p.orderStage !== "NONE" || p.bc) {
    etapes.push({
      cle: "BC", libelle: "Bon de commande",
      etat: bcSigne(p) || (p.expenseOrderId && !p.bc) ? "FAIT"
        : p.orderStage === "REFUSED" || p.bc === "REFUSE" ? "REFUSE"
        : p.bc || p.orderStage === "REQUESTED" || p.orderStage === "DIRECTION_OK" ? "EN_COURS"
        : accorde && p.budgetCategoryId ? "EN_COURS" : "A_VENIR",
    });
  }
  const factureOuverte = accorde && p.budgetCategoryId && (sansBC ? true : bcSigne(p));
  // UN VERSEMENT À L'ASSOCIATION se justifie par la pro forma ou la lettre de demande, pas par une
  // facture : la frise nomme ce qui est exigé, et le dit FAIT dès qu'il est là.
  etapes.push(sansBC
    ? {
        cle: "FACTURE", libelle: "Pro forma / lettre",
        etat: justificatifPose ? "FAIT" : factureOuverte || p.expenseOrderId ? "EN_COURS" : "A_VENIR",
      }
    : {
        cle: "FACTURE", libelle: "Facture",
        etat: factures > 0 ? "FAIT" : factureOuverte || p.expenseOrderId ? "EN_COURS" : "A_VENIR",
      });
  const paiement = etatDuPaiement(p);
  etapes.push({
    cle: "PAIEMENT", libelle: "Paiement",
    etat: paye ? "FAIT" : paiement === "REFUSE" || paiement === "ANNULE" ? "REFUSE" : p.expenseOrderId ? "EN_COURS" : "A_VENIR",
  });
  return etapes;
}

/** Ce que la carte dit d'un BC au registre qui n'est pas encore signé. */
const ATTENTE_BC: Partial<Record<EtapeBC, string>> = {
  A_VALIDER: "BC en validation — chez le centre Ad & Pro.",
  A_REVOIR: "BC à revoir — demandé par le centre Ad & Pro.",
  A_SIGNER: "En attente de signature — chez les Finances.",
  A_CORRIGER: "BC renvoyé par les Finances — à corriger.",
  REFUSE: "BC refusé — à redemander.",
  SANS_PORTE: "BC à adresser au centre de validation.",
};

/**
 * LE PROCHAIN GESTE — un seul, celui de la personne qui regarde ; sinon ce qu'on attend.
 *
 * Fonction PURE — testée. Chaque branche rend soit un geste que l'action acceptera, soit une
 * phrase qui nomme QUI on attend : « en attente » sans sujet fait chercher.
 */
export function prochainPas(p: FaitsPoste, r: RegardPoste): ProchainPas {
  const editer = r.canEdit && !r.fige;
  const arbitrer = r.canAllocate && !r.fige;
  const droits = r.validation ?? { operations: false, marketing: false };
  const qui2 = r.secondTempsParOperations ? "la Direction des opérations" : "la Direction Marketing";

  // LE MATÉRIEL DU STOCK (§118.167) suit un ACCORD unique — soumettre, décider —, mais pas la suite
  // de l'argent : ni budget, ni bon de commande, ni paiement. Une fois accordé, son bloc le confirme.
  if (p.kind === "STOCK_MATERIAL") {
    if (STATUTS_EDITABLES.includes(p.status)) {
      if (!editer) return { geste: null, attente: "Le demandeur liste le matériel du magasin et le soumet à la Direction." };
      return p.lignesStock > 0
        ? { geste: { cle: "SOUMETTRE", libelle: p.status === "DRAFT" ? "Soumettre à la Direction" : "Resoumettre à la Direction" }, attente: null }
        : { geste: null, attente: "Ajoutez au moins un article du magasin pour soumettre ce poste." };
    }
    if (p.status === "PENDING") {
      return arbitrer
        ? { geste: { cle: "DECIDER", libelle: "Décider de ce poste" }, attente: null }
        : { geste: null, attente: "En attente de la décision de la Direction." };
    }
    return { geste: null, attente: null };
  }

  // UN SPONSORING INDIRECT NON RÉPARTI : sa ou ses natures ne sont pas dites (§118.175). Tant
  // qu'il ne l'est pas, il ne se soumet pas (`canSubmitItem`) — le seul geste utile est celui-là.
  if (p.kind === "INDIRECT_SUPPORT" && STATUTS_EDITABLES.includes(p.status)) {
    return editer
      ? { geste: { cle: "REPARTIR", libelle: "Répartir par nature" }, attente: null }
      : { geste: null, attente: "Le demandeur doit répartir ce sponsoring indirect par nature (imprimerie, hôtellerie…)." };
  }

  if (STATUTS_EDITABLES.includes(p.status)) {
    if (!editer) {
      return {
        geste: null,
        attente: p.status === "REVISION" ? "À revoir par le demandeur."
          : p.status === "REJECTED" ? "Refusé — le demandeur peut le corriger et le resoumettre."
          : "Brouillon — le demandeur le chiffre et le soumet pour validation.",
      };
    }
    if (!chiffre(p)) return { geste: { cle: "CHIFFRER", libelle: "Chiffrer le poste" }, attente: null };
    // UNE FICHE PAR PERSONNE (Direction, 06/10) — la même règle que `canSubmitItem` : jamais
    // « Soumettre » quand l'action refuserait (§118.83).
    const fiches = refusFichesPersonnes({ kind: p.kind, fichesPersonnes: p.fichesPersonnes, priseEnChargeIndirecte: p.priseEnChargeIndirecte });
    if (fiches) return { geste: null, attente: fiches };
    return { geste: { cle: "SOUMETTRE", libelle: p.status === "DRAFT" ? "Soumettre pour validation" : "Resoumettre pour validation" }, attente: null };
  }

  // ── LA VALIDATION EN DEUX TEMPS (§118.204) ─────────────────────────────────────────────
  if (p.status === "PENDING") {
    if (!p.opsDecidedAt) {
      return droits.operations && !r.fige
        ? { geste: { cle: "VALIDER_OPS", libelle: "Valider (Direction des opérations)" }, attente: null }
        : { geste: null, attente: "En attente — chez la Direction des opérations." };
    }
    return droits.marketing && !r.fige
      ? { geste: { cle: "DECIDER", libelle: "Valider et choisir le budget" }, attente: null }
      : { geste: null, attente: `En attente — chez ${qui2} (montant et budget).` };
  }

  // ── ACCORDÉ ────────────────────────────────────────────────────────────────────────────
  if (p.expenseOrderId) {
    const paiement = etatDuPaiement(p);
    return { geste: null, attente: paiement === "PAYE" ? null : phrasePaiementBloque(paiement) ?? "Paiement en cours — chez le centre de paiement." };
  }
  if (p.orderStage === "ISSUED") return { geste: null, attente: null };
  // Un poste accordé d'AVANT la validation en deux temps peut n'avoir ni montant ni budget.
  if (!positif(p.amountGranted)) {
    return droits.marketing && !r.fige
      ? { geste: { cle: "MONTANT", libelle: "Affecter le montant accordé" }, attente: null }
      : { geste: null, attente: `${capitale(qui2)} affecte le montant accordé à ce poste.` };
  }
  if (!p.budgetCategoryId) {
    return droits.marketing && !r.fige
      ? { geste: { cle: "BUDGET", libelle: "Choisir le budget" }, attente: null }
      : { geste: null, attente: `${capitale(qui2)} choisit le budget qui porte ce poste.` };
  }
  const direct = VERSEMENT_SANS_BC.includes(p.kind);
  const payer: ProchainPas = r.canEdit
    ? { geste: { cle: "DEMANDER_PAIEMENT", libelle: direct ? "Joindre la proforma / lettre de demande et demander le paiement" : "Déposer la facture et demander le paiement" }, attente: null }
    : { geste: null, attente: direct ? "Le demandeur joint la proforma ou la lettre de demande de sponsoring pour demander le paiement." : "Le demandeur dépose la facture pour demander le paiement." };

  // SPONSORING DIRECT : pas de bon de commande, et pas de facture exigée — la pro forma ou la lettre
  // de demande de sponsoring suffit à demander le paiement (Direction, 05/10).
  if (direct && p.orderStage === "NONE" && !p.bc) {
    if (!r.operationDecidee) return { geste: null, attente: "La proforma ou la lettre de demande se joindra quand l'opération sera accordée." };
    return payer;
  }

  // ── LE BON DE COMMANDE : demande → (centre) → assistante → vérification → signature Finances ──
  if (p.bc === "SIGNE") return payer;
  if (p.bc) return { geste: null, attente: ATTENTE_BC[p.bc] ?? "Bon de commande en cours au registre." };
  // DEMANDÉ : l'assistante l'établit pendant que, au-dessus du seuil, le centre le vise en parallèle.
  if (p.orderStage === "REQUESTED" || p.orderStage === "DIRECTION_OK") {
    if (p.orderStage === "REQUESTED" && r.canViserBC) return { geste: { cle: "VISER_BC", libelle: "Valider le bon de commande" }, attente: null };
    if (p.demandeBC === "DEPOSE") {
      return r.verifieLeBC
        ? { geste: { cle: "VERIFIER_BC", libelle: "Vérifier le bon de commande déposé" }, attente: null }
        : { geste: null, attente: "BC déposé — à vérifier par le demandeur." };
    }
    // UNE DEMANDE D'AVANT LA RÈGLE (§118.204) : demandée au secrétariat, elle ne reviendrait jamais sur
    // le poste. L'action accepte de l'envoyer à l'assistante ; la carte doit le proposer. Des lignes de devis
    // validées passent avant : le BC se GÉNÈRE d'après elles (§118.206).
    if (p.demandeBC === "AUCUNE") {
      if (r.canEdit && (p.devisAGenerer ?? 0) > 0) return { geste: gesteGenerer(p.devisAGenerer as number), attente: null };
      return r.canEdit
        ? { geste: { cle: "DEMANDER_BC", libelle: "Envoyer la demande de BC à l'assistante" }, attente: null }
        : { geste: null, attente: "Le demandeur envoie la demande de bon de commande à l'assistante de direction." };
    }
    return {
      geste: null,
      attente: p.orderStage === "REQUESTED"
        ? "BC en préparation — chez l'assistante de direction (visé en parallèle par le centre Ad & Pro)."
        : "BC en préparation — chez l'assistante de direction.",
    };
  }
  // Bon de commande à demander (ou à redemander après un refus du centre). Cette demande reste un
  // geste d'EXÉCUTION : elle s'offre encore sur une demande clôturée (§118.151). Quand des lignes de devis sont
  // VALIDÉES, c'est la génération qui est proposée : un BC par devis, avec ses seules lignes validées (§118.206).
  if (r.canEdit && (p.devisAGenerer ?? 0) > 0) return { geste: gesteGenerer(p.devisAGenerer as number), attente: null };
  return r.canEdit
    ? { geste: { cle: "DEMANDER_BC", libelle: p.orderStage === "REFUSED" ? "Redemander l'émission du BC" : "Demander l'émission du BC" }, attente: null }
    : { geste: null, attente: "Le demandeur demande l'émission du bon de commande." };
}

const capitale = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Le geste de génération : « Générer le BC » pour un devis, « Générer les BC (N) » pour plusieurs. */
const gesteGenerer = (n: number): Geste => ({ cle: "GENERER_BC", libelle: n > 1 ? `Générer les BC (${n})` : "Générer le BC" });

/**
 * LES POSTES REGROUPÉS PAR RÉPARTITION — dans l'ordre où ils apparaissent. Un poste né d'une
 * répartition rejoint le groupe de ses frères, même si d'autres postes ont été ajoutés entre eux :
 * l'écran montre « Sponsoring indirect — total — n natures » d'un seul tenant.
 */
export function grouperParRepartition<T extends { id: string; repartitionId: string | null }>(
  items: readonly T[],
): { cle: string; repartitionId: string | null; items: T[] }[] {
  const groupes: { cle: string; repartitionId: string | null; items: T[] }[] = [];
  const parRepartition = new Map<string, { cle: string; repartitionId: string | null; items: T[] }>();
  for (const it of items) {
    if (!it.repartitionId) {
      groupes.push({ cle: it.id, repartitionId: null, items: [it] });
      continue;
    }
    const g = parRepartition.get(it.repartitionId);
    if (g) {
      g.items.push(it);
      continue;
    }
    const neuf = { cle: `rep:${it.repartitionId}`, repartitionId: it.repartitionId, items: [it] };
    parRepartition.set(it.repartitionId, neuf);
    groupes.push(neuf);
  }
  return groupes;
}
