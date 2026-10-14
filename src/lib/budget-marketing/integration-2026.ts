/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'INTÉGRATION DES DÉPENSES RÉELLES AD & PRO 2026 — LES DÉCISIONS DE LA DIRECTION, VERSIONNÉES (10/2026).
 *
 * Le fichier « Dépenses AP à ce jour » (Feuil1 fait foi : en-têtes ligne 4 — A ACTION, B ACTION, C DETAIL ACTION,
 * D Lieux, E MOIS, F TOTAL BUDGET, G Depenses Reelles, I Commentaires ; données lignes 5 à 59) entre dans Ad & Pro d'un
 * bloc : chaque dépense rejoint SA demande, avec ses postes payés, ses pièces attendues et son imputation au budget.
 * La maquette validée (« adpro-integration ») a tranché chaque ligne ; ces décisions vivent ICI, pas dans le code qui
 * écrit, et une ligne du fichier qui ne leur correspond plus fait REFUSER l'intégration (`controlerFichier`) — on ne
 * devine jamais ce que la Direction aurait décidé d'une ligne qu'elle n'a pas vue.
 *
 *   • seules les lignes dont « Depenses Reelles » > 0 entrent ; le consulting (3 000 000, L58) va aux RH ;
 *   • 32 dépenses → 30 demandes : les symposiums SAI (L22) et Pr Djaballah (L24) sont des POSTES de leur congrès ;
 *   • 33 558 715,94 DZD exactement, au centime ;
 *   • la date d'une dépense est le DERNIER JOUR du mois retenu (2026) ;
 *   • demandeur affiché : « Direction Marketing » ; pièces obligatoires mais non bloquantes.
 *
 * Module PUR, sans aucun import : lu par le serveur (lecture, écriture du lot), par l'assistant d'intégration (écran
 * client) et par les tests. Les montants sont en CENTIMES entiers — jamais un flottant dans une somme qui doit tomber
 * au centime.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** La version des décisions — gardée sur le lot : on sait toujours quelles règles ont écrit quoi. */
export const VERSION_INTEGRATION_2026 = "2026-10-14.1";
export const ANNEE_INTEGRATION = 2026;
export const DEMANDEUR_AFFICHE = "Direction Marketing";
export const BADGE_HISTORIQUE = "Historique 2026";

/** Le total intégré, en centimes : 33 558 715,94 DZD. */
export const TOTAL_ATTENDU_CENTIMES = 3_355_871_594;
export const NB_DEPENSES_ATTENDUES = 32;
export const NB_DEMANDES_ATTENDUES = 30;

/** La feuille et sa forme. */
export const FEUILLE = "Feuil1";
export const LIGNE_EN_TETES = 4;
export const PREMIERE_LIGNE = 5;
export const DERNIERE_LIGNE = 59;
/** Les en-têtes attendus (colonnes A à I), comparés sans casse ni accents ni espaces de bord. */
export const EN_TETES_ATTENDUS: readonly (string | null)[] = [
  "ACTION", "ACTION", "DETAIL ACTION", "Lieux", "MOIS", "TOTAL BUDGET", "Depenses Reelles", null, "Commentaires",
];

// ─────────────────────────────── Les catégories du budget Ad & Pro 2026 ───────────────────────────────

export const CATEGORIES_2026 = [
  "Prise en charge internationale",
  "Prise en charge nationale",
  "Sponsoring",
  "Matériel promotionnel",
  "Formation",
  "Consulting",
  "Événements",
] as const;
export type Categorie2026 = (typeof CATEGORIES_2026)[number];

export const SOUS_CATEGORIES_EVENEMENTS = ["Réunions", "Symposium", "Staff post-event", "Tables rondes"] as const;
export type SousCategorie2026 = (typeof SOUS_CATEGORIES_EVENEMENTS)[number];

/**
 * Les noms sous lesquels une catégorie d'enveloppe se RECONNAÎT (comparés normalisés). Une enveloppe créée avec les
 * catégories d'office (« Congrès internationaux »…) se rapproche ainsi sans renommer quoi que ce soit.
 */
export const ALIAS_CATEGORIES: Record<Categorie2026, readonly string[]> = {
  "Prise en charge internationale": ["prise en charge internationale", "prises en charge internationales", "congres internationaux", "congres international", "pec internationale"],
  "Prise en charge nationale": ["prise en charge nationale", "prises en charge nationales", "congres nationaux", "congres national", "pec nationale"],
  Sponsoring: ["sponsoring", "sponsorings"],
  "Matériel promotionnel": ["materiel promotionnel", "materiels promotionnels", "promotional material"],
  Formation: ["formation", "formations"],
  Consulting: ["consulting", "consultant", "consultant trainer"],
  "Événements": ["evenements", "evenement", "events"],
};
export const ALIAS_SOUS_CATEGORIES: Record<SousCategorie2026, readonly string[]> = {
  "Réunions": ["reunions", "reunion", "reunions d experts", "reunions dinatoires"],
  Symposium: ["symposium", "symposiums"],
  "Staff post-event": ["staff post event", "staff post-event", "staff", "staf post event"],
  "Tables rondes": ["tables rondes", "table ronde"],
};

// ─────────────────────────────── Les demandes et leurs postes ───────────────────────────────

/** La nature d'une demande Ad & Pro — la même clé que les écrans (`EntityType`). */
export type TypeDemandeIntegree =
  | "SPONSORING" | "CONGRESS_NATIONAL" | "CONGRESS_INTERNATIONAL" | "EVENT" | "TRAINING" | "PROMO_MATERIAL" | "MEDICAL_INFO_DECLARATION";

export const LIBELLE_TYPE_DEMANDE: Record<TypeDemandeIntegree, string> = {
  SPONSORING: "Sponsoring",
  CONGRESS_NATIONAL: "Congrès nationaux",
  CONGRESS_INTERNATIONAL: "Congrès internationaux",
  EVENT: "Événements",
  TRAINING: "Formations",
  PROMO_MATERIAL: "Matériel promotionnel",
  MEDICAL_INFO_DECLARATION: "Information médicale",
};

/** L'ordre des groupes à l'écran (celui de la maquette). */
export const ORDRE_TYPES: readonly TypeDemandeIntegree[] = [
  "CONGRESS_INTERNATIONAL", "CONGRESS_NATIONAL", "SPONSORING", "PROMO_MATERIAL", "MEDICAL_INFO_DECLARATION", "TRAINING", "EVENT",
];

/** La nature d'un poste (`AdProItemKind`), recopiée en chaîne : ce module n'importe rien. */
export type NaturePoste =
  | "ASSOCIATION_SUPPORT" | "SYMPOSIUM" | "TICKETING" | "ACCOMMODATION" | "TRAVEL" | "SERVICE" | "CATERING" | "PRINTING" | "VENUE" | "OTHER";

export interface PostePrevu {
  libelle: string;
  /** Centimes. */
  montant: number;
  nature: NaturePoste;
  /** La ligne du fichier qui porte ce poste. */
  ligne: number;
  categorie: Categorie2026;
  sousCategorie: SousCategorie2026 | null;
  fournisseur?: string | null;
}

export interface PieceAttendue { cle: string; libelle: string }

/**
 * Ce qu'on sait d'une demande déjà dans la plateforme (maquette : « existe ») — l'assistant la cherche d'abord par ces
 * indices, et la propose en tête. Jamais un identifiant : il change d'une base à l'autre.
 */
export interface IndiceExistant {
  reference?: string;
  /** Un poste existant, par son libellé (contient) et son montant (centimes). */
  poste?: { libelleContient: string; montant: number; fournisseur?: string };
  /** Une facture au registre, par son numéro. */
  facture?: { numero: string; montant: number; fournisseur: string };
  /** Une écriture de trésorerie, par sa référence (lecture seule — jamais modifiée). */
  ecriture?: { reference: string; montant: number };
  note: string;
}

export interface DemandePrevue {
  /** Clé stable de la demande dans ce plan (« D-L21 »). */
  cle: string;
  /** La ligne principale du fichier, et toutes celles qu'elle regroupe. */
  ligne: number;
  lignes: readonly number[];
  type: TypeDemandeIntegree;
  /** Le sous-type tel que l'écran le dit (« Sponsoring congrès », « Staff post-event »…). */
  sousType: string;
  libelle: string;
  lieu: string | null;
  /** Le mois retenu (1–12) ; la date est le dernier jour de ce mois. */
  mois: number;
  postes: readonly PostePrevu[];
  piecesAttendues: readonly PieceAttendue[];
  /** Les fiches voyageurs s'ajoutent à tout moment (prises en charge). */
  fichesVoyageurs: boolean;
  existant: IndiceExistant | null;
  /** Le type d'événement, pour une demande « Événements » créée (`EventType`). */
  typeEvenement?: "HOSPITAL_STAFF" | "OTHER";
}

/** Ce que la Direction a décidé d'une ligne du fichier — et ce qu'elle a VU dans le fichier (le contrôle). */
export interface DecisionLigne {
  ligne: number;
  /** La colonne C telle qu'elle a été lue quand la décision a été prise (comparée normalisée). */
  detailFichier: string;
  /** La colonne G telle qu'elle a été lue (DZD, comparée à 0,01 près). */
  depenseFichier: number;
  /** La colonne E telle qu'elle a été lue (normalisée), `null` si vide. */
  moisFichier: string | null;
  /** Le montant RETENU (centimes) — celui qui entre au budget. */
  montantRetenu: number;
  /** Le mois retenu (1–12). */
  mois: number;
  libelle: string;
  /** La demande qui porte la ligne. */
  demande: string;
  /** Pourquoi le montant ou le mois diffère du fichier, quand il diffère. */
  note: string | null;
}

/** Les lignes avec une dépense réelle que la Direction a écartées, et pourquoi. */
export const LIGNES_ECARTEES: readonly { ligne: number; detailFichier: string; depenseFichier: number; raison: string }[] = [
  { ligne: 58, detailFichier: "Consulting", depenseFichier: 3_000_000, raison: "Consulting (3 000 000) : n'entre pas dans Ad & Pro, il va aux RH." },
];

const c = (dzd: number): number => Math.round(dzd * 100);

const PIECES_SPONSORING: readonly PieceAttendue[] = [
  { cle: "convention", libelle: "Convention ou lettre de sponsoring" },
  { cle: "facture", libelle: "Facture" },
  { cle: "virement", libelle: "Preuve de virement" },
];
const PIECES_PEC_INTER: readonly PieceAttendue[] = [
  { cle: "fiches", libelle: "Fiches voyageurs (ajoutables à tout moment)" },
  { cle: "facture-agence", libelle: "Factures de l'agence de voyage" },
  { cle: "facture-hotel", libelle: "Facture(s) hôtel" },
  { cle: "inscriptions", libelle: "Reçus d'inscription" },
];
const PIECES_PROMO: readonly PieceAttendue[] = [
  { cle: "devis", libelle: "Devis retenu" },
  { cle: "bc", libelle: "Bon de commande" },
  { cle: "facture", libelle: "Facture" },
];
const PIECES_STAFF: readonly PieceAttendue[] = [
  { cle: "honoraires", libelle: "Note d'honoraires de l'orateur" },
  { cle: "traiteur", libelle: "Facture traiteur" },
];

const sponsoring = (
  ligne: number, libelle: string, mois: number, montant: number, sousType = "Sponsoring congrès", lieu: string | null = null,
  pieces: readonly PieceAttendue[] = PIECES_SPONSORING,
): DemandePrevue => ({
  cle: `D-L${ligne}`, ligne, lignes: [ligne], type: "SPONSORING", sousType, libelle, lieu, mois,
  postes: [{ libelle: "Sponsoring", montant: c(montant), nature: "ASSOCIATION_SUPPORT", ligne, categorie: "Sponsoring", sousCategorie: null }],
  piecesAttendues: pieces, fichesVoyageurs: false, existant: null,
});
const promo = (ligne: number, libelle: string, mois: number, montant: number, pieces: readonly PieceAttendue[] = PIECES_PROMO, poste = "Fabrication"): DemandePrevue => ({
  cle: `D-L${ligne}`, ligne, lignes: [ligne], type: "PROMO_MATERIAL", sousType: "Dossier matériel promotionnel", libelle, lieu: null, mois,
  postes: [{ libelle: poste, montant: c(montant), nature: "PRINTING", ligne, categorie: "Matériel promotionnel", sousCategorie: null }],
  piecesAttendues: pieces, fichesVoyageurs: false, existant: null,
});
const pecInter = (ligne: number, libelle: string, lieu: string, mois: number, montant: number, poste = "Prise en charge"): DemandePrevue => ({
  cle: `D-L${ligne}`, ligne, lignes: [ligne], type: "CONGRESS_INTERNATIONAL", sousType: "Prise en charge internationale", libelle, lieu, mois,
  postes: [{ libelle: poste, montant: c(montant), nature: "TRAVEL", ligne, categorie: "Prise en charge internationale", sousCategorie: null }],
  piecesAttendues: PIECES_PEC_INTER, fichesVoyageurs: true, existant: null,
});
const staff = (ligne: number, professeur: string, mois: number, restauration: number): DemandePrevue => ({
  cle: `D-L${ligne}`, ligne, lignes: [ligne], type: "EVENT", sousType: "Staff post-event", libelle: `Staff service ${professeur}`, lieu: null, mois,
  postes: [
    { libelle: "Honoraires orateur", montant: c(130_316.74), nature: "SERVICE", ligne, categorie: "Événements", sousCategorie: "Staff post-event" },
    { libelle: "Restauration", montant: c(restauration), nature: "CATERING", ligne, categorie: "Événements", sousCategorie: "Staff post-event" },
  ],
  piecesAttendues: PIECES_STAFF, fichesVoyageurs: false, existant: null, typeEvenement: "HOSPITAL_STAFF",
});

/** LES 30 DEMANDES, dans l'ordre de la maquette. */
export const DEMANDES_2026: readonly DemandePrevue[] = [
  // ── Congrès internationaux (prises en charge internationales) ──
  pecInter(5, "AIDS 2026 — 26th International AIDS Conference", "Rio de Janeiro", 6, 10_989_940, "Prise en charge (billets, hôtel, inscriptions, repas)"),
  pecInter(7, "AFRA VIH Lausanne", "Lausanne", 5, 4_300_000),
  pecInter(9, "Santé Expo (Paris)", "Paris", 5, 3_500_000),
  // ── Congrès nationaux ──
  {
    cle: "D-L32", ligne: 32, lignes: [32], type: "CONGRESS_NATIONAL", sousType: "Prise en charge nationale",
    libelle: "Prise en charge totale des pharmaciens", lieu: null, mois: 10,
    postes: [{ libelle: "Billetterie (6 voyageurs)", montant: c(124_750), nature: "TICKETING", ligne: 32, categorie: "Prise en charge nationale", sousCategorie: null, fournisseur: "Genius Travel" }],
    piecesAttendues: [
      { cle: "proforma", libelle: "Pro forma / facture Genius Travel" },
      { cle: "billets", libelle: "Billets émis" },
      { cle: "facture", libelle: "Facture finale" },
    ],
    fichesVoyageurs: true,
    existant: { poste: { libelleContient: "billetterie", montant: c(124_750), fournisseur: "Genius Travel" }, note: "Poste « Prise en charge de la billetterie », 124 750 accordés, Genius Travel" },
  },
  // ── Sponsoring ──
  sponsoring(10, "6ème conférence d'Oran", 4, 2_157_018.5),
  {
    cle: "D-L25", ligne: 25, lignes: [25, 24], type: "SPONSORING", sousType: "Sponsoring congrès",
    libelle: "ASARI + symposium Pr Djaballah", lieu: null, mois: 10,
    postes: [
      { libelle: "Sponsoring", montant: c(2_000_000), nature: "ASSOCIATION_SUPPORT", ligne: 25, categorie: "Sponsoring", sousCategorie: null },
      { libelle: "Symposium Pr Djaballah : honoraires", montant: c(195_475), nature: "SYMPOSIUM", ligne: 24, categorie: "Événements", sousCategorie: "Symposium" },
    ],
    piecesAttendues: [...PIECES_SPONSORING, { cle: "honoraires", libelle: "Note d'honoraires (symposium)" }],
    fichesVoyageurs: false, existant: null,
  },
  {
    cle: "D-L21", ligne: 21, lignes: [21, 22], type: "SPONSORING", sousType: "Sponsoring congrès",
    libelle: "Société Algérienne d'Infectiologie (SAI) + symposium", lieu: "Constantine", mois: 10,
    postes: [
      { libelle: "Sponsoring", montant: c(1_500_000), nature: "ASSOCIATION_SUPPORT", ligne: 21, categorie: "Sponsoring", sousCategorie: null },
      { libelle: "Symposium : honoraires orateur", montant: c(195_475), nature: "SYMPOSIUM", ligne: 22, categorie: "Événements", sousCategorie: "Symposium" },
      { libelle: "Symposium : billetterie", montant: c(8_000), nature: "TICKETING", ligne: 22, categorie: "Événements", sousCategorie: "Symposium" },
      { libelle: "Symposium : hébergement", montant: c(12_000), nature: "ACCOMMODATION", ligne: 22, categorie: "Événements", sousCategorie: "Symposium" },
    ],
    piecesAttendues: [
      ...PIECES_SPONSORING,
      { cle: "honoraires", libelle: "Note d'honoraires (symposium)" },
      { cle: "billet", libelle: "Billet (symposium)" },
      { cle: "hotel", libelle: "Facture hôtel (symposium)" },
    ],
    fichesVoyageurs: false, existant: null,
  },
  sponsoring(28, "Journées de Batna", 6, 510_400),
  sponsoring(11, "AIDS Algérie — programme de dépistage", 4, 500_000, "Sponsoring association", null, [
    { cle: "convention", libelle: "Convention" }, { cle: "recu", libelle: "Reçu de l'association" },
  ]),
  sponsoring(23, "2ème conférence de Tlemcen", 10, 400_000),
  sponsoring(30, "Journées des pharmaciens à Sétif", 10, 400_000, "Sponsoring congrès", "Sétif"),
  sponsoring(14, "Sapsox", 2, 300_000),
  sponsoring(13, "CDR Batna — programme de dépistage", 6, 187_110, "Sponsoring programme", null, [
    { cle: "convention", libelle: "Convention" }, { cle: "facture", libelle: "Facture" },
  ]),
  {
    ...sponsoring(19, "SAI — webinaire", 7, 53_550, "Sponsoring webinaire", null, [
      { cle: "facture", libelle: "Facture" }, { cle: "virement", libelle: "Preuve de virement" },
    ]),
    existant: { reference: "SPO-2026-003", ecriture: { reference: "FIN-2026-119", montant: c(53_350) }, note: "SPO-2026-003 (payé 53 350 le 21/09 — l'écart avec 53 550 reste affiché)" },
  },
  sponsoring(18, "Programme de dépistage Ministère", 4, 35_130, "Sponsoring programme", null, [
    { cle: "facture", libelle: "Facture" }, { cle: "virement", libelle: "Preuve de virement" },
  ]),
  // ── Matériel promotionnel ──
  promo(37, "Campagne ARV", 9, 961_000, [...PIECES_PROMO, { cle: "bat", libelle: "BAT" }]),
  promo(39, "Snap up, desk banner BN et stylo", 9, 648_000),
  promo(38, "Lingettes désinfectantes", 9, 559_625),
  promo(15, "INSIGN — banner et stand", 2, 406_560),
  promo(16, "INSIGN — banner charte", 2, 226_210),
  {
    ...promo(20, "Lettre de félicitations aux lauréats", 8, 14_280, [{ cle: "facture", libelle: "Facture ePrint 226-00572" }], "Impression"),
    existant: { facture: { numero: "226-00572", montant: c(14_280), fournisseur: "ePrint" }, note: "Facture ePrint 226-00572 (14 280) au registre — rattachée, jamais redéposée" },
  },
  // ── Information médicale : le visa de publicité ──
  {
    cle: "D-L40", ligne: 40, lignes: [40], type: "MEDICAL_INFO_DECLARATION", sousType: "Déclaration DIM — visa publicitaire",
    libelle: "Visa de publicité", lieu: null, mois: 9,
    postes: [{ libelle: "Bon de versement / quittance", montant: c(240_000), nature: "OTHER", ligne: 40, categorie: "Matériel promotionnel", sousCategorie: null }],
    piecesAttendues: [
      { cle: "decision-visa", libelle: "Décision de visa (n°, date, échéance)" },
      { cle: "quittance", libelle: "Quittance du versement" },
    ],
    fichesVoyageurs: false, existant: null,
  },
  // ── Formations ──
  {
    cle: "D-L17", ligne: 17, lignes: [17], type: "TRAINING", sousType: "Formation des équipes",
    libelle: "Formation ARV", lieu: null, mois: 6,
    postes: [{ libelle: "Formation", montant: c(350_000), nature: "SERVICE", ligne: 17, categorie: "Formation", sousCategorie: null }],
    piecesAttendues: [
      { cle: "convention", libelle: "Convention de formation" }, { cle: "facture", libelle: "Facture" }, { cle: "emargement", libelle: "Liste d'émargement" },
    ],
    fichesVoyageurs: false, existant: null,
  },
  // ── Événements ──
  {
    cle: "D-L12", ligne: 12, lignes: [12], type: "EVENT", sousType: "Réunion d'experts",
    libelle: "Réunion d'experts Taghit (KOL)", lieu: "Taghit", mois: 2,
    postes: [{ libelle: "Organisation (hébergement, transport, restauration, honoraires)", montant: c(1_643_792), nature: "VENUE", ligne: 12, categorie: "Événements", sousCategorie: "Réunions" }],
    piecesAttendues: [{ cle: "factures", libelle: "Factures" }, { cle: "experts", libelle: "Liste des experts" }, { cle: "programme", libelle: "Programme" }],
    fichesVoyageurs: false, existant: null, typeEvenement: "OTHER",
  },
  staff(49, "Pr Mouffok", 9, 87_500),
  staff(48, "Pr Brahimi", 9, 80_000),
  staff(45, "Pr Tabet Derraz", 7, 55_000),
  staff(44, "Pr Ouyahia", 7, 52_000),
  staff(42, "Pr Belabbès", 6, 44_000),
  staff(43, "Pr Mammeri", 6, 40_000),
];

/**
 * LES 32 LIGNES DU FICHIER, telles que la Direction les a vues et tranchées. `detailFichier`, `depenseFichier` et
 * `moisFichier` sont le CONTRÔLE (le fichier doit encore les porter) ; `montantRetenu` et `mois` sont la DÉCISION.
 */
export const DECISIONS_LIGNES: readonly DecisionLigne[] = [
  { ligne: 5, detailFichier: "AIDS 2026, the 26th International AIDS Conference", depenseFichier: 10_989_940, moisFichier: "juin", montantRetenu: c(10_989_940), mois: 6, libelle: "AIDS 2026 — 26th International AIDS Conference", demande: "D-L5", note: null },
  { ligne: 7, detailFichier: "AFRA VIH Lausane", depenseFichier: 4_300_000, moisFichier: "mai", montantRetenu: c(4_300_000), mois: 5, libelle: "AFRA VIH Lausanne", demande: "D-L7", note: null },
  { ligne: 9, detailFichier: "HOPI Pharm Sante expo", depenseFichier: 3_500_000, moisFichier: "mai", montantRetenu: c(3_500_000), mois: 5, libelle: "Santé Expo (Paris)", demande: "D-L9", note: "Libellé corrigé : « Santé Expo (Paris) », pas HOPI." },
  { ligne: 10, detailFichier: "6ème conférence d'Oran", depenseFichier: 2_157_018.5, moisFichier: "avril", montantRetenu: c(2_157_018.5), mois: 4, libelle: "6ème conférence d'Oran", demande: "D-L10", note: null },
  { ligne: 11, detailFichier: "AIDS Algerie Programme de depistage", depenseFichier: 500_000, moisFichier: "avril", montantRetenu: c(500_000), mois: 4, libelle: "AIDS Algérie — programme de dépistage", demande: "D-L11", note: null },
  { ligne: 12, detailFichier: "Reunion Taghit", depenseFichier: 1_643_792, moisFichier: "fevrier", montantRetenu: c(1_643_792), mois: 2, libelle: "Réunion d'experts Taghit (KOL)", demande: "D-L12", note: "Imputée en Événements › Réunions." },
  { ligne: 13, detailFichier: "CDR BATNA", depenseFichier: 187_110, moisFichier: "juin", montantRetenu: c(187_110), mois: 6, libelle: "CDR Batna — programme de dépistage", demande: "D-L13", note: null },
  { ligne: 14, detailFichier: "Sapsox", depenseFichier: 300_000, moisFichier: null, montantRetenu: c(300_000), mois: 2, libelle: "Sapsox", demande: "D-L14", note: "Mois absent du fichier : février (décision)." },
  { ligne: 15, detailFichier: "INSIGN Banner et Stand", depenseFichier: 406_560, moisFichier: "fevrier", montantRetenu: c(406_560), mois: 2, libelle: "INSIGN — banner et stand", demande: "D-L15", note: null },
  { ligne: 16, detailFichier: "INSIGN Banner Charte", depenseFichier: 226_210, moisFichier: "fevrier", montantRetenu: c(226_210), mois: 2, libelle: "INSIGN — banner charte", demande: "D-L16", note: null },
  { ligne: 17, detailFichier: "Formation ARV", depenseFichier: 350_000, moisFichier: "juin", montantRetenu: c(350_000), mois: 6, libelle: "Formation ARV", demande: "D-L17", note: null },
  { ligne: 18, detailFichier: "Programme de depistage Ministere", depenseFichier: 35_130, moisFichier: "avril", montantRetenu: c(35_130), mois: 4, libelle: "Programme de dépistage Ministère", demande: "D-L18", note: null },
  { ligne: 19, detailFichier: "Société Algérienne d'infectiologie SAI Webinar", depenseFichier: 53_550, moisFichier: "juillet", montantRetenu: c(53_550), mois: 7, libelle: "SAI — webinaire", demande: "D-L19", note: "53 550 retenus (53 350 sortis de la banque : l'écart reste affiché)." },
  { ligne: 20, detailFichier: "Lettre de feliciation aux Laureats", depenseFichier: 14_280, moisFichier: "aoiut", montantRetenu: c(14_280), mois: 8, libelle: "Lettre de félicitations aux lauréats", demande: "D-L20", note: null },
  { ligne: 21, detailFichier: "Société Algérienne d'infectiologie SAI", depenseFichier: 1_500_000, moisFichier: "octobre", montantRetenu: c(1_500_000), mois: 10, libelle: "Société Algérienne d'Infectiologie (SAI)", demande: "D-L21", note: null },
  { ligne: 22, detailFichier: "Sympo Lors du congrés de la Société Algérienne d'infectiologie SAI", depenseFichier: 215_475.11312217196, moisFichier: "octobre", montantRetenu: c(215_475), mois: 10, libelle: "Symposium au congrès SAI", demande: "D-L21", note: "215 475 = 195 475 honoraires + 8 000 billetterie + 12 000 hébergement — poste du congrès SAI." },
  { ligne: 23, detailFichier: "2ème conférence de Tlemcen", depenseFichier: 400_000, moisFichier: "octobre", montantRetenu: c(400_000), mois: 10, libelle: "2ème conférence de Tlemcen", demande: "D-L23", note: null },
  { ligne: 24, detailFichier: "ASARI + Sympo Pr Djaballah", depenseFichier: 195_475, moisFichier: "octobre", montantRetenu: c(195_475), mois: 10, libelle: "Symposium Pr Djaballah", demande: "D-L25", note: "Poste du congrès ASARI, imputé en Événements › Symposium." },
  { ligne: 25, detailFichier: "ASARI", depenseFichier: 2_000_000, moisFichier: "octobre", montantRetenu: c(2_000_000), mois: 10, libelle: "ASARI", demande: "D-L25", note: null },
  { ligne: 28, detailFichier: "Journées de Batna", depenseFichier: 510_400, moisFichier: "juin", montantRetenu: c(510_400), mois: 6, libelle: "Journées de Batna", demande: "D-L28", note: null },
  { ligne: 30, detailFichier: "Les journées des pharmaciens à Setif", depenseFichier: 400_000, moisFichier: "octobre", montantRetenu: c(400_000), mois: 10, libelle: "Journées des pharmaciens à Sétif", demande: "D-L30", note: null },
  { ligne: 32, detailFichier: "Prise en charge totale des pharmaciens", depenseFichier: 137_750, moisFichier: null, montantRetenu: c(124_750), mois: 10, libelle: "Prise en charge totale des pharmaciens", demande: "D-L32", note: "124 750 retenus (le fichier dit 137 750), octobre." },
  { ligne: 37, detailFichier: "Campagne ARV", depenseFichier: 961_000, moisFichier: "sep", montantRetenu: c(961_000), mois: 9, libelle: "Campagne ARV", demande: "D-L37", note: null },
  { ligne: 38, detailFichier: "Lingettes désinfectantes", depenseFichier: 559_625, moisFichier: "sep", montantRetenu: c(559_625), mois: 9, libelle: "Lingettes désinfectantes", demande: "D-L38", note: null },
  { ligne: 39, detailFichier: "Snap up Desk Banner BN et Stylo", depenseFichier: 648_000, moisFichier: "sep", montantRetenu: c(648_000), mois: 9, libelle: "Snap up, desk banner BN et stylo", demande: "D-L39", note: null },
  { ligne: 40, detailFichier: "Visa de Publicité", depenseFichier: 240_000, moisFichier: "sep", montantRetenu: c(240_000), mois: 9, libelle: "Visa de publicité", demande: "D-L40", note: "Déclaration d'information médicale (visa publicitaire) ; budget rangé en Matériel promotionnel." },
  { ligne: 42, detailFichier: "Staf Service Pr Belabbes", depenseFichier: 174_316.74208144797, moisFichier: "juin", montantRetenu: c(174_316.74), mois: 6, libelle: "Staff service Pr Belabbès", demande: "D-L42", note: "130 316,74 d'honoraires + 44 000 de repas." },
  { ligne: 43, detailFichier: "Staf Service Pr Mammeri", depenseFichier: 170_316.74208144797, moisFichier: "juin", montantRetenu: c(170_316.74), mois: 6, libelle: "Staff service Pr Mammeri", demande: "D-L43", note: "130 316,74 d'honoraires + 40 000 de repas." },
  { ligne: 44, detailFichier: "Staf Service Pr Ouyahia", depenseFichier: 182_316.74208144797, moisFichier: "juillet", montantRetenu: c(182_316.74), mois: 7, libelle: "Staff service Pr Ouyahia", demande: "D-L44", note: "130 316,74 d'honoraires + 52 000 de repas." },
  { ligne: 45, detailFichier: "Staf Service Pr Tabet Deraze", depenseFichier: 185_316.74208144797, moisFichier: "juillet", montantRetenu: c(185_316.74), mois: 7, libelle: "Staff service Pr Tabet Derraz", demande: "D-L45", note: "130 316,74 d'honoraires + 55 000 de repas." },
  { ligne: 48, detailFichier: "Staf Service Pr Brahimi", depenseFichier: 210_316.74208144797, moisFichier: "sep", montantRetenu: c(210_316.74), mois: 9, libelle: "Staff service Pr Brahimi", demande: "D-L48", note: "130 316,74 d'honoraires + 80 000 de repas." },
  { ligne: 49, detailFichier: "Staf Service Pr Mouffok", depenseFichier: 217_816.74208144797, moisFichier: "sep", montantRetenu: c(217_816.74), mois: 9, libelle: "Staff service Pr Mouffok", demande: "D-L49", note: "130 316,74 d'honoraires + 87 500 de repas." },
];

// ─────────────────────────────── Normalisations ───────────────────────────────

/** Compare deux textes du fichier : casse, accents, apostrophes et espaces mis de côté. */
export function normaliserTexte(v: unknown): string {
  return String(v ?? "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[’'`]/g, " ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const MOIS: Record<string, number> = {
  janvier: 1, jan: 1, fevrier: 2, fev: 2, mars: 3, avril: 4, avr: 4, mai: 5, juin: 6, juillet: 7, juil: 7,
  aout: 8, aoiut: 8, septembre: 9, sep: 9, sept: 9, octobre: 10, oct: 10, novembre: 11, nov: 11, decembre: 12, dec: 12,
};
/** Le mois d'une cellule « MOIS » (« Juin », « Sep », « Aoiut »…) — `null` si vide ou illisible. */
export function moisDuTexte(v: unknown): number | null {
  const t = normaliserTexte(v);
  return t ? MOIS[t] ?? null : null;
}

/** Le dernier jour du mois retenu, à midi UTC (aucun fuseau ne le fait glisser d'un mois). */
export function dateDeLaDepense(mois: number, annee = ANNEE_INTEGRATION): Date {
  return new Date(Date.UTC(annee, mois, 0, 12, 0, 0));
}

/** Centimes → « 33 558 715,94 » (espaces fines insécables, comme les écrans). */
export function formatCentimes(centimes: number): string {
  const neg = centimes < 0;
  const abs = Math.abs(Math.round(centimes));
  const entier = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  const cts = abs % 100;
  return `${neg ? "-" : ""}${entier}${cts ? `,${cts.toString().padStart(2, "0")}` : ""}`;
}

// ─────────────────────────────── La lecture du fichier ───────────────────────────────

/** Une ligne de Feuil1 telle que lue (colonnes A à I), avant toute décision. */
export interface LigneLue {
  ligne: number;
  actionA: string | null;
  actionB: string | null;
  detail: string | null;
  lieux: string | null;
  mois: string | null;
  budget: number | null;
  depense: number | null;
  commentaire: string | null;
}

const texte = (v: unknown): string | null => {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
};
const nombre = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v.replace(/\s/g, "").replace(",", "."));
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

/**
 * Les lignes de la feuille, d'après un tableau de cellules (ligne 1 = index 0, colonne A = index 0) — la forme que rend
 * `XLSX.utils.sheet_to_json(feuille, { header: 1 })`. Les en-têtes de la ligne 4 sont vérifiés.
 */
export function lireLignes(cellules: readonly (readonly unknown[])[]): { ok: true; lignes: LigneLue[] } | { ok: false; erreur: string } {
  const entetes = cellules[LIGNE_EN_TETES - 1] ?? [];
  for (const [i, attendu] of EN_TETES_ATTENDUS.entries()) {
    if (attendu === null) continue;
    if (normaliserTexte(entetes[i]) !== normaliserTexte(attendu)) {
      return { ok: false, erreur: `Ce n'est pas le format attendu : la colonne ${String.fromCharCode(65 + i)} de la ligne ${LIGNE_EN_TETES} devrait être « ${attendu} » (lu : « ${texte(entetes[i]) ?? "vide"} »).` };
    }
  }
  const lignes: LigneLue[] = [];
  for (let n = PREMIERE_LIGNE; n <= DERNIERE_LIGNE; n++) {
    const r = cellules[n - 1] ?? [];
    lignes.push({
      ligne: n, actionA: texte(r[0]), actionB: texte(r[1]), detail: texte(r[2]), lieux: texte(r[3]), mois: texte(r[4]),
      budget: nombre(r[5]), depense: nombre(r[6]), commentaire: texte(r[8]),
    });
  }
  return { ok: true, lignes };
}

// ─────────────────────────────── Le contrôle et le plan ───────────────────────────────

export interface LignePlan {
  decision: DecisionLigne;
  lue: LigneLue;
  /** La date retenue (dernier jour du mois). */
  date: Date;
}

export interface PlanIntegration {
  version: string;
  lignes: LignePlan[];
  demandes: DemandePrevue[];
  ecartees: { ligne: number; libelle: string; montant: number; raison: string }[];
  totalCentimes: number;
  parCategorie: Record<Categorie2026, number>;
  parSousCategorie: Record<SousCategorie2026, number>;
}

export type ResultatControle = { ok: true; plan: PlanIntegration } | { ok: false; erreurs: string[] };

const EPSILON_DZD = 0.01;

/**
 * LE CONTRÔLE : le fichier correspond-il encore aux décisions ? Chaque ligne décidée doit porter le même détail, la
 * même dépense (à 0,01 DZD) et le même mois ; aucune AUTRE ligne ne doit porter de dépense réelle (une ligne nouvelle
 * n'a été vue par personne). Puis le plan : les demandes, leurs postes, et le total contrôlé AU CENTIME.
 */
export function controlerFichier(lignes: readonly LigneLue[]): ResultatControle {
  const erreurs: string[] = [];
  const parNumero = new Map(lignes.map((l) => [l.ligne, l]));
  const decidees = new Set(DECISIONS_LIGNES.map((d) => d.ligne));
  const ecartees = new Set(LIGNES_ECARTEES.map((e) => e.ligne));
  const planLignes: LignePlan[] = [];

  for (const d of DECISIONS_LIGNES) {
    const l = parNumero.get(d.ligne);
    if (!l) { erreurs.push(`Ligne ${d.ligne} absente du fichier.`); continue; }
    if (normaliserTexte(l.detail) !== normaliserTexte(d.detailFichier)) {
      erreurs.push(`Ligne ${d.ligne} : le détail a changé (« ${l.detail ?? "vide"} » au lieu de « ${d.detailFichier} »).`);
    }
    if (l.depense == null || Math.abs(l.depense - d.depenseFichier) > EPSILON_DZD) {
      erreurs.push(`Ligne ${d.ligne} (${d.libelle}) : la dépense réelle a changé (${l.depense ?? "vide"} au lieu de ${d.depenseFichier}).`);
    }
    if (normaliserTexte(l.mois) !== normaliserTexte(d.moisFichier)) {
      erreurs.push(`Ligne ${d.ligne} (${d.libelle}) : le mois a changé (« ${l.mois ?? "vide"} » au lieu de « ${d.moisFichier ?? "vide"} »).`);
    }
    planLignes.push({ decision: d, lue: l, date: dateDeLaDepense(d.mois) });
  }
  for (const e of LIGNES_ECARTEES) {
    const l = parNumero.get(e.ligne);
    if (!l || normaliserTexte(l.detail) !== normaliserTexte(e.detailFichier) || l.depense == null || Math.abs(l.depense - e.depenseFichier) > EPSILON_DZD) {
      erreurs.push(`Ligne ${e.ligne} : la ligne écartée (« ${e.detailFichier} », ${e.depenseFichier}) n'est plus celle que la Direction a vue.`);
    }
  }
  for (const l of lignes) {
    if (decidees.has(l.ligne) || ecartees.has(l.ligne)) continue;
    if (l.depense != null && l.depense > 0) {
      erreurs.push(`Ligne ${l.ligne} (« ${l.detail ?? "sans détail"} », ${l.depense}) porte une dépense réelle qu'aucune décision ne couvre : rien n'est intégré tant qu'elle n'est pas tranchée.`);
    }
  }
  if (erreurs.length) return { ok: false, erreurs };

  const totalCentimes = DECISIONS_LIGNES.reduce((s, d) => s + d.montantRetenu, 0);
  const parCategorie = Object.fromEntries(CATEGORIES_2026.map((k) => [k, 0])) as Record<Categorie2026, number>;
  const parSousCategorie = Object.fromEntries(SOUS_CATEGORIES_EVENEMENTS.map((k) => [k, 0])) as Record<SousCategorie2026, number>;
  for (const d of DEMANDES_2026) {
    for (const p of d.postes) {
      parCategorie[p.categorie] += p.montant;
      if (p.sousCategorie) parSousCategorie[p.sousCategorie] += p.montant;
    }
  }
  return {
    ok: true,
    plan: {
      version: VERSION_INTEGRATION_2026,
      lignes: planLignes,
      demandes: [...DEMANDES_2026],
      ecartees: LIGNES_ECARTEES.map((e) => ({ ligne: e.ligne, libelle: e.detailFichier, montant: c(e.depenseFichier), raison: e.raison })),
      totalCentimes,
      parCategorie,
      parSousCategorie,
    },
  };
}

/**
 * LA COHÉRENCE INTERNE des décisions — vérifiée par les tests et avant toute écriture : chaque ligne décidée est portée
 * par sa demande, les postes d'une ligne font exactement son montant retenu, et le tout fait le total attendu.
 */
export function incoherences(): string[] {
  const out: string[] = [];
  const demandes = new Map(DEMANDES_2026.map((d) => [d.cle, d]));
  if (DECISIONS_LIGNES.length !== NB_DEPENSES_ATTENDUES) out.push(`${DECISIONS_LIGNES.length} lignes décidées au lieu de ${NB_DEPENSES_ATTENDUES}.`);
  if (DEMANDES_2026.length !== NB_DEMANDES_ATTENDUES) out.push(`${DEMANDES_2026.length} demandes au lieu de ${NB_DEMANDES_ATTENDUES}.`);
  for (const d of DECISIONS_LIGNES) {
    const dem = demandes.get(d.demande);
    if (!dem) { out.push(`Ligne ${d.ligne} : demande ${d.demande} inconnue.`); continue; }
    if (!dem.lignes.includes(d.ligne)) out.push(`Ligne ${d.ligne} : la demande ${d.demande} ne la regroupe pas.`);
    const somme = dem.postes.filter((p) => p.ligne === d.ligne).reduce((s, p) => s + p.montant, 0);
    if (somme !== d.montantRetenu) out.push(`Ligne ${d.ligne} : postes ${somme} ≠ montant retenu ${d.montantRetenu}.`);
    if (dem.ligne === d.ligne && dem.mois !== d.mois) out.push(`Ligne ${d.ligne} : mois ${d.mois} ≠ mois de la demande ${dem.mois}.`);
  }
  const total = DECISIONS_LIGNES.reduce((s, d) => s + d.montantRetenu, 0);
  if (total !== TOTAL_ATTENDU_CENTIMES) out.push(`Total ${total} ≠ ${TOTAL_ATTENDU_CENTIMES} centimes.`);
  return out;
}

/** Les postes d'une demande, groupés par catégorie › sous-catégorie, pour l'écran. */
export function libelleImputation(p: Pick<PostePrevu, "categorie" | "sousCategorie">): string {
  return p.sousCategorie ? `${p.categorie} › ${p.sousCategorie}` : p.categorie;
}

/** Le montant total d'une demande (centimes). */
export function montantDeLaDemande(d: Pick<DemandePrevue, "postes">): number {
  return d.postes.reduce((s, p) => s + p.montant, 0);
}

/** Retrouver la catégorie d'enveloppe d'une catégorie du plan, d'après les noms (alias normalisés). */
export function categorieCorrespond(nomEnveloppe: string, cat: Categorie2026): boolean {
  const n = normaliserTexte(nomEnveloppe);
  return ALIAS_CATEGORIES[cat].some((a) => normaliserTexte(a) === n);
}
export function sousCategorieCorrespond(nomEnveloppe: string, sous: SousCategorie2026): boolean {
  const n = normaliserTexte(nomEnveloppe);
  return ALIAS_SOUS_CATEGORIES[sous].some((a) => normaliserTexte(a) === n);
}
