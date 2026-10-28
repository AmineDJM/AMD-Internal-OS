/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES BRIQUES DE MESURE — couche 1 du « KPI sans code » (Direction, 08/10). Module PUR, zéro import.
 *
 * Une brique est une mesure ÉCRITE UNE FOIS dans le code, à partir d'une donnée que la plateforme tient déjà
 * (visites, segmentation, plans de tournée, coaching, tâches, validations…). Un KPI n'est plus du code : c'est une
 * DÉFINITION enregistrée en base qui choisit une brique (ou le rapport de deux briques), ses filtres, sa cible.
 *
 * Ce fichier ne dit QUE ce que mesure chaque brique — sa définition voyage avec la valeur, comme dans
 * `metrics/catalog.ts` : un chiffre sans sa définition est une opinion. Le calcul vit côté serveur
 * (`briques-calcul.ts`). Ajouter une brique = le seul cas où l'on code ; tout le reste se règle à l'écran.
 *
 * Aucune brique n'estime : une donnée absente rend `null` avec sa raison, jamais zéro.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const BRIQUE_IDS = [
  "VISITES_REALISEES",
  "VISITES_AVEC_MESSAGE",
  "MESSAGES_PORTES",
  "CONTACTS_REQUIS",
  "CONTACTS_REALISES",
  "CIBLES_PANEL",
  "CIBLES_VUES_A_FREQUENCE",
  "CIBLES_VUES_N",
  "VISITES_A_RAPPORTER",
  "RAPPORTS_DANS_DELAI",
  "PLANS_DE_TOURNEE",
  "PLANS_VALIDES_A_TEMPS",
  "NOTE_COACHING",
  "TACHES_ECHUES",
  "TACHES_A_TEMPS",
  "VALIDATIONS_REPONDUES",
  "DELAI_VALIDATIONS",
  "DEMANDES_TRAITEES",
  "DELAI_DEMANDES",
  "LIVRE_PCH",
  "NON_SERVI_PCH",
  "EXECUTION_MARCHES",
] as const;
export type BriqueId = (typeof BRIQUE_IDS)[number];

/** L'unité de la valeur que rend une brique. */
export type UniteBrique = "NOMBRE" | "POURCENT" | "HEURES";

/** Les axes par lesquels une brique se filtre. Personne et période valent pour toutes. */
export type Dimension = "personne" | "periode" | "bu" | "produit" | "lettre";

/** Les réglages qu'une définition peut poser sur une brique. */
export type ParametreBrique = "lettres" | "seuilN" | "heures" | "produitId" | "buId";

export interface Brique {
  id: BriqueId;
  libelle: string;
  unite: UniteBrique;
  /** CE QUE COMPTE LA BRIQUE — affiché tel quel à côté du chiffre. */
  definition: string;
  /** D'où vient la donnée (modèle, champ) — ce que « d'où vient le chiffre » ouvre. */
  source: string;
  dimensions: readonly Dimension[];
  parametres: readonly ParametreBrique[];
  /**
   * ADDITIVE : la valeur s'additionne d'un mois à l'autre (un nombre de visites). Sur une fenêtre de trois mois, la
   * cible mensuelle d'un KPI qui la compte se multiplie par trois. Un taux, une note ou un délai ne s'additionnent pas.
   */
  additive: boolean;
  /** Ce que dit une personne pour parler de cette mesure — le repli sans IA les lit. */
  motsCles: readonly string[];
  /** Pour qui la brique a du sens aujourd'hui : le terrain (KAM) ou tout le monde. */
  metier: "KAM" | "TOUS";
}

const PERSONNE_PERIODE: Dimension[] = ["personne", "periode"];
const PANEL: Dimension[] = ["personne", "periode", "bu", "lettre"];
const VISITES: Dimension[] = ["personne", "periode", "bu", "produit", "lettre"];
const PERSONNE_PERIODE_BU: Dimension[] = ["personne", "periode", "bu"];

export const BRIQUES: readonly Brique[] = [
  {
    id: "VISITES_REALISEES", libelle: "Visites réalisées", unite: "NOMBRE", additive: true, metier: "KAM",
    definition: "Visites au statut « réalisée » de la personne, datées dans la période. Filtrable par produit présenté et par lettre de segmentation du praticien.",
    source: "Visites médicales (MedicalVisit : statut COMPLETED, délégué, date ; produits présentés)",
    dimensions: VISITES, parametres: ["lettres", "produitId", "buId"],
    motsCles: ["visite", "visites", "realise", "realisees", "contacts faits", "par lettre"],
  },
  {
    id: "VISITES_AVEC_MESSAGE", libelle: "Visites avec un message porté", unite: "NOMBRE", additive: true, metier: "KAM",
    definition: "Visites réalisées dans la période dont le rapport retient au moins un message pré-défini de la Direction Marketing.",
    source: "Messages retenus au rapport (MedicalVisitMessage) sur les visites réalisées",
    dimensions: VISITES, parametres: ["lettres", "produitId", "buId"],
    motsCles: ["message", "messages", "porte", "portes", "argumentaire"],
  },
  {
    id: "MESSAGES_PORTES", libelle: "Messages portés", unite: "NOMBRE", additive: true, metier: "KAM",
    definition: "Nombre de messages pré-définis retenus aux rapports des visites réalisées dans la période (un message par visite au plus une fois).",
    source: "Messages retenus au rapport (MedicalVisitMessage)",
    dimensions: VISITES, parametres: ["lettres", "produitId", "buId"],
    motsCles: ["message", "messages", "porte", "portes"],
  },
  {
    id: "CONTACTS_REQUIS", libelle: "Contacts requis", unite: "NOMBRE", additive: true, metier: "KAM",
    definition: "Somme des visites requises par cycle pour chaque praticien du panel (lettre de segmentation × fréquence du secteur ; à défaut, palier de potentiel), multipliée par le nombre de mois de la période. Panel actuel.",
    source: "Segmentation publiée (lettre requise) et panel du KAM (secteur ∪ rattachement)",
    dimensions: PANEL, parametres: ["lettres", "buId"],
    motsCles: ["requis", "contacts requis", "frequence", "objectif de visites"],
  },
  {
    id: "CONTACTS_REALISES", libelle: "Contacts réalisés (plafonnés au requis)", unite: "NOMBRE", additive: true, metier: "KAM",
    definition: "Visites réalisées auprès des praticiens du panel, chaque praticien plafonné à son requis : une cinquième visite au même médecin ne comble pas un autre trou.",
    source: "Visites réalisées × panel et segmentation",
    dimensions: PANEL, parametres: ["lettres", "buId"],
    motsCles: ["realise", "realise requis", "contacts realises", "taux de realisation"],
  },
  {
    id: "CIBLES_PANEL", libelle: "Cibles du panel", unite: "NOMBRE", additive: false, metier: "KAM",
    definition: "Praticiens du panel dont la lettre est retenue (H, A, B par défaut) et qui demandent au moins une visite. Le dénominateur d'une couverture.",
    source: "Segmentation publiée et panel du KAM",
    dimensions: PANEL, parametres: ["lettres", "buId"],
    motsCles: ["cibles", "panel", "decideurs", "prioritaires"],
  },
  {
    id: "CIBLES_VUES_A_FREQUENCE", libelle: "Cibles vues à fréquence", unite: "NOMBRE", additive: false, metier: "KAM",
    definition: "Cibles du panel ayant reçu au moins leur requis de visites sur la période (requis du cycle × nombre de mois).",
    source: "Visites réalisées × segmentation (règle de `couvertureAFrequence`)",
    dimensions: PANEL, parametres: ["lettres", "buId"],
    motsCles: ["frequence", "a frequence", "couverture", "cibles vues", "h a b"],
  },
  {
    id: "CIBLES_VUES_N", libelle: "Cibles vues au moins N fois par mois", unite: "NOMBRE", additive: false, metier: "KAM",
    definition: "Cibles du panel (lettre H par défaut : les décideurs) vues au moins N fois par mois sur la période (N × nombre de mois).",
    source: "Visites réalisées × segmentation",
    dimensions: PANEL, parametres: ["lettres", "seuilN", "buId"],
    motsCles: ["decideur", "decideurs", "fois par mois", "deux fois", "2 fois", "au moins"],
  },
  {
    id: "VISITES_A_RAPPORTER", libelle: "Visites à rapporter", unite: "NOMBRE", additive: true, metier: "KAM",
    definition: "Visites de la période ni annulées ni reportées, dont le rapport est fait ou dont le délai de rapport est écoulé.",
    source: "Visites médicales (date, statut, rapport écrit ou compte rendu vocal rattaché)",
    dimensions: PERSONNE_PERIODE, parametres: ["heures"],
    motsCles: ["rapport", "rapports", "compte rendu"],
  },
  {
    id: "RAPPORTS_DANS_DELAI", libelle: "Rapports rendus dans le délai", unite: "NOMBRE", additive: true, metier: "KAM",
    definition: "Visites dont le rapport est rendu au plus X heures après la visite (48 h par défaut). L'heure du rapport est celle du premier compte rendu vocal rattaché, sinon la dernière modification de la visite — une borne haute : le chiffre ne peut pas être surestimé.",
    source: "Visites médicales (date, dernière modification) et comptes rendus vocaux (FieldReport.createdAt)",
    dimensions: PERSONNE_PERIODE, parametres: ["heures"],
    motsCles: ["48 h", "48h", "heures", "delai", "a temps", "rapport", "rapports"],
  },
  {
    id: "PLANS_DE_TOURNEE", libelle: "Plans de tournée", unite: "NOMBRE", additive: true, metier: "KAM",
    definition: "Plans de tournée de la personne qui couvrent au moins un jour de la période.",
    source: "Plans de tournée (TourPlan)",
    dimensions: PERSONNE_PERIODE, parametres: [],
    motsCles: ["plan de tournee", "plans de tournee", "planning"],
  },
  {
    id: "PLANS_VALIDES_A_TEMPS", libelle: "Plans de tournée validés, soumis à temps", unite: "NOMBRE", additive: true, metier: "KAM",
    definition: "Plans de la période VALIDÉS et soumis avant leur échéance de soumission (figée à la création du plan).",
    source: "Plans de tournée (statut, soumis le, échéance de soumission)",
    dimensions: PERSONNE_PERIODE, parametres: [],
    motsCles: ["plan de tournee", "valide", "soumis a temps", "a temps"],
  },
  {
    id: "NOTE_COACHING", libelle: "Note de coaching", unite: "POURCENT", additive: false, metier: "KAM",
    definition: "Moyenne des fiches de coaching FINALISÉES de la période, chacune ramenée à son total sur son maximum (sa propre version de grille).",
    source: "Fiches de coaching (CoachingSheet finalisées) et leur grille",
    dimensions: PERSONNE_PERIODE, parametres: [],
    motsCles: ["coaching", "tournee en double", "grille de coaching", "note"],
  },
  {
    id: "TACHES_ECHUES", libelle: "Tâches échues", unite: "NOMBRE", additive: true, metier: "TOUS",
    definition: "Tâches confiées à la personne dont l'échéance tombe dans la période et est passée (annulées et refusées exclues).",
    source: "Tâches (Task : responsable, échéance, statut)",
    dimensions: PERSONNE_PERIODE, parametres: [],
    motsCles: ["tache", "taches", "echeance"],
  },
  {
    id: "TACHES_A_TEMPS", libelle: "Tâches faites à temps", unite: "NOMBRE", additive: true, metier: "TOUS",
    definition: "Tâches échues de la période terminées au plus tard le jour de leur échéance.",
    source: "Tâches (statut DONE, terminée le, échéance)",
    dimensions: PERSONNE_PERIODE, parametres: [],
    motsCles: ["tache", "taches", "a temps", "dans les delais"],
  },
  {
    id: "VALIDATIONS_REPONDUES", libelle: "Validations répondues", unite: "NOMBRE", additive: true, metier: "TOUS",
    definition: "Étapes de validation tranchées par la personne (approuvées, refusées, à réviser) dans la période.",
    source: "Validations transversales (ValidationStep : validateur, décidé le)",
    dimensions: PERSONNE_PERIODE, parametres: [],
    motsCles: ["validation", "validations", "repondre", "decisions"],
  },
  {
    id: "DELAI_VALIDATIONS", libelle: "Délai de réponse aux validations", unite: "HEURES", additive: false, metier: "TOUS",
    definition: "Médiane, en heures, entre l'arrivée d'une validation chez la personne et sa décision. Seules les étapes dont l'heure d'arrivée est connue comptent : la première d'un circuit, ou toute étape d'un circuit parallèle.",
    source: "Validations transversales (étape créée le → décidée le)",
    dimensions: PERSONNE_PERIODE, parametres: [],
    motsCles: ["delai", "temps de reponse", "reactivite", "validation"],
  },
  {
    id: "DEMANDES_TRAITEES", libelle: "Demandes traitées", unite: "NOMBRE", additive: true, metier: "TOUS",
    definition: "Demandes que la personne a traitées dans la période : support (première réponse ou clôture par le répondant), demandes RH (prête, remise, accordée, refusée) et demandes administratives terminées. Une demande ancienne sans date de traitement ne compte pas.",
    source: "Support (SupportRequest : répondant, traitée le), demandes RH (HrDocumentRequest : traitant, traitée le), demandes administratives (AdministrativeRequest : assigné, terminée le)",
    dimensions: PERSONNE_PERIODE, parametres: [],
    motsCles: ["demande", "demandes", "traitee", "traitees", "support", "tickets", "assistante", "rh"],
  },
  {
    id: "DELAI_DEMANDES", libelle: "Délai de traitement des demandes", unite: "HEURES", additive: false, metier: "TOUS",
    definition: "Médiane, en heures, entre le dépôt d'une demande (support, RH, administrative) et son traitement par la personne, sur les demandes traitées dans la période. Seules les demandes datées des deux bouts comptent.",
    source: "Support, demandes RH et demandes administratives (créée le → traitée / terminée le)",
    dimensions: PERSONNE_PERIODE, parametres: [],
    motsCles: ["delai", "temps de traitement", "reactivite", "demande", "demandes", "support", "rh"],
  },
  {
    id: "LIVRE_PCH", libelle: "Livré PCH (secteur / BU)", unite: "NOMBRE", additive: true, metier: "KAM",
    definition: "Quantités livrées par la PCH aux hôpitaux sur la période, pour nos produits : celles des établissements du secteur du KAM ; à défaut de secteur, celles de la BU qu'il dirige ou supervise (ou la BU choisie). Rien n'est estimé : sans import PCH sur la période, la mesure est absente.",
    source: "Ventes PCH (PchVenteLigne : livré, établissement, mois) × secteurs (SalesSectorInstitution) ou produits de la BU",
    dimensions: PERSONNE_PERIODE_BU, parametres: ["buId"],
    motsCles: ["pch", "livre", "livre pch", "livraison", "hopitaux", "secteur", "sell out"],
  },
  {
    id: "NON_SERVI_PCH", libelle: "Demande non servie PCH (secteur / BU)", unite: "NOMBRE", additive: true, metier: "KAM",
    definition: "Quantités demandées par les hôpitaux et NON servies par la PCH sur la période, pour nos produits : établissements du secteur du KAM ; à défaut, BU qu'il dirige ou supervise (ou la BU choisie). Un signal de rupture : plus bas = mieux. Sans import PCH sur la période, la mesure est absente.",
    source: "Ventes PCH (PchVenteLigne : statut NON_SERVIE, quantité commandée) × secteurs ou produits de la BU",
    dimensions: PERSONNE_PERIODE_BU, parametres: ["buId"],
    motsCles: ["non servi", "non servie", "rupture", "pch", "demande non servie", "hopitaux"],
  },
  {
    id: "EXECUTION_MARCHES", libelle: "Exécution des marchés (BU)", unite: "POURCENT", additive: false, metier: "KAM",
    definition: "Part livrée de ce que les marchés PCH ont attribué à la BU : unités livrées (bons de commande livrés) ÷ unités attribuées, sur les marchés de ses produits. État cumulé au jour du calcul, indépendant de la période. BU = celle choisie, sinon celle que la personne dirige, supervise ou dans laquelle elle est rattachée.",
    source: "Marchés PCH (chaîne attribué → commandé → livré par produit : PchContractLine, PchTenderLine, PchOrderLine, livraisons)",
    dimensions: PERSONNE_PERIODE_BU, parametres: ["buId"],
    motsCles: ["marche", "marches", "execution", "attribue", "appel d'offres", "pch", "taux de livraison"],
  },
];

export const BRIQUE_PAR_ID: Readonly<Record<BriqueId, Brique>> = Object.fromEntries(BRIQUES.map((b) => [b.id, b])) as Record<BriqueId, Brique>;

export const estBrique = (v: unknown): v is BriqueId => typeof v === "string" && (BRIQUE_IDS as readonly string[]).includes(v);

/** Les lettres de segmentation qu'une définition peut retenir. */
export const LETTRES_KPI = ["H", "A", "B", "C", "D"] as const;
export type LettreKpi = (typeof LETTRES_KPI)[number];

// ── Les mots de la définition d'un KPI (couche 2) ─────────────────────────────────────────────

export const NATURES = ["CALCULE", "RATIO", "EVALUE", "DECLARE", "IMPORTE"] as const;
export type NatureKpi = (typeof NATURES)[number];
export const NATURE_LABELS: Record<NatureKpi, string> = {
  CALCULE: "calculé", RATIO: "ratio", EVALUE: "évalué", DECLARE: "déclaré", IMPORTE: "importé",
};

export const UNITES = ["POURCENT", "NOMBRE", "HEURES", "NIVEAU"] as const;
export type UniteKpi = (typeof UNITES)[number];

export const SENS = ["PLUS_HAUT", "PLUS_BAS"] as const;
export type SensKpi = (typeof SENS)[number];

/** La période À LAQUELLE LA CIBLE SE RAPPORTE (« 20 visites par mois », « 1 formation par trimestre »). */
export const PERIODES_REF = ["MOIS", "TRIMESTRE"] as const;
export type PeriodeRef = (typeof PERIODES_REF)[number];

/** La fréquence de revue — choisie par chaque manager (Direction, 08/10 : « revue au choix du manager »). */
export const FREQUENCES = ["MENSUELLE", "TRIMESTRIELLE", "SEMESTRIELLE"] as const;
export type FrequenceRevue = (typeof FREQUENCES)[number];
export const FREQUENCE_LABELS: Record<FrequenceRevue, string> = {
  MENSUELLE: "mensuelle", TRIMESTRIELLE: "trimestrielle", SEMESTRIELLE: "semestrielle",
};
