/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CATALOGUE DES EXPORTS DE L'ERP (lot K7, décision 0037) — une FICHE par export d'écran. PUR, zéro import.
 *
 * Constat de la Direction (31/10/2026) : « Envoie à Amine Djouamai l'Excel du suivi Regulatory » → « je ne peux pas
 * générer l'export ». Les exports étaient des ROUTES appelées par les boutons des écrans, invisibles pour l'assistant
 * (son registre ne connaissait que les actions serveur). Chaque export a désormais :
 *   • une FONCTION `(personne, options)` → fichier (`producteurs.ts`), que la route ET l'assistant appellent ;
 *   • une FICHE ici : l'outil de l'assistant (`exporter_…`), son libellé français, l'écran qui le porte (lien direct
 *     quand l'outil manque à la personne), ses filtres — comme à l'écran — et les mots d'une demande.
 *
 * Le catalogue part au registre des capacités et à la sélection d'outils de l'Assistant IA ; l'inventaire des gestes
 * d'écran (`modules/assistant-ia/gestes-ecran.test.ts`) y renvoie chaque route d'export.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface ProprieteExport {
  type: "string" | "integer" | "boolean" | "array";
  description: string;
  enum?: readonly string[];
}

export interface FicheExport {
  /** L'outil de l'assistant. */
  outil: string;
  /** La route d'écran qui produit le même fichier (`src/app/api/…`, sans `/route.ts`). */
  route: string;
  libelle: string;
  description: string;
  /** L'écran où le bouton existe — le lien direct quand l'assistant ne peut pas (droits, famille fermée). */
  ecran: string;
  format: string;
  proprietes: Readonly<Record<string, ProprieteExport>>;
  requis?: readonly string[];
  /** Les mots d'une demande (« l'Excel du suivi Regulatory ») — la sélection d'outils les pèse fort. */
  mots: string;
}

const designation = (quoi: string): ProprieteExport => ({ type: "string", description: `${quoi} — son nom (ou son identifiant).` });

export const CATALOGUE_EXPORTS: readonly FicheExport[] = [
  {
    outil: "exporter_suivi_regulatory", route: "/api/regulatory/export", ecran: "/regulatory", format: "Excel",
    libelle: "Exporter le suivi Regulatory (Excel)",
    description: "PRODUIT le classeur Excel du SUIVI DES DOSSIERS REGULATORY (le bouton « Exporter » de l'écran Regulatory), sous la portée de la personne, filtres de l'écran facultatifs. Le fichier est déposé dans son Drive (dossier « Exports ») et rendu téléchargeable.",
    proprietes: {
      statuts: { type: "array", description: "Statuts du dossier (« Attente ANPP », « Déposé », « Décision obtenue »…) — facultatif." },
      categorie: { type: "string", description: "Médicament ou Dispositif médical — facultatif." },
      gamme: { type: "string", description: "Gamme de ville, Hospitalière, Ville + Hôpital — facultatif." },
      responsable: { type: "string", description: "Le chargé du dossier (son nom) — facultatif." },
      recherche: { type: "string", description: "Référence, DCI, marque ou laboratoire — facultatif." },
    },
    mots: "excel export exporte exporter extraction classeur fichier tableau suivi regulatory reglementaire dossiers enregistrement produits anpp",
  },
  {
    outil: "exporter_budget", route: "/api/budgets/export", ecran: "/budgets", format: "Excel",
    libelle: "Exporter un budget (Excel)",
    description: "PRODUIT le classeur Excel d'une ENVELOPPE BUDGÉTAIRE (lignes, consommé, engagé, taux) et le total des enveloppes — le bouton d'export de l'écran Budgets. Déposé dans le Drive de la personne (« Exports »).",
    proprietes: {
      enveloppe: designation("L'enveloppe (par défaut : celle de l'écran)"),
      du: { type: "string", description: "Début de période AAAA-MM-JJ — facultatif." },
      au: { type: "string", description: "Fin de période AAAA-MM-JJ — facultatif." },
      portee: { type: "string", description: "Budget d'un pôle : MARKETING, REGULATORY, OPERATIONS — facultatif.", enum: ["MARKETING", "REGULATORY", "OPERATIONS"] },
    },
    mots: "excel export exporte exporter classeur budget enveloppe consomme engage depenses taux",
  },
  {
    outil: "exporter_budget_marketing", route: "/api/budgets/marketing/export", ecran: "/budget-marketing", format: "Excel, PDF, CSV ou PowerPoint",
    libelle: "Exporter le budget Marketing (Excel, PDF, CSV, PowerPoint)",
    description: "PRODUIT le rapport du BUDGET MARKETING (vue d'ensemble) : Excel complet, rapport PDF, CSV des dépenses ou diapositives PowerPoint, sous les filtres de l'écran (mois, catégorie, comparaison N-1). Déposé dans le Drive de la personne (« Exports »).",
    proprietes: {
      format: { type: "string", description: "xlsx (défaut), pdf, csv, pptx.", enum: ["xlsx", "pdf", "csv", "pptx"] },
      enveloppe: designation("L'enveloppe marketing (par défaut : la plus récente)"),
      debut: { type: "string", description: "Premier mois AAAA-MM — facultatif." },
      fin: { type: "string", description: "Dernier mois AAAA-MM — facultatif." },
      categorie: { type: "string", description: "Une catégorie budgétaire (son nom) — facultatif." },
      n1: { type: "boolean", description: "Comparer à l'année précédente." },
    },
    mots: "rapport export exporte budget marketing pdf powerpoint pptx diapositives csv depenses excel presentation",
  },
  {
    outil: "exporter_pilotage_force_de_vente", route: "/api/planning/export", ecran: "/planning", format: "Excel",
    libelle: "Exporter le pilotage de la force de vente (Excel)",
    description: "PRODUIT le classeur Excel du PILOTAGE de la force de vente (délégués, couverture H·A·B, réalisé, requis, plan, rapports en retard) pour un mois, sous la portée de la personne. Déposé dans le Drive (« Exports »).",
    proprietes: {
      annee: { type: "integer", description: "L'année (par défaut : l'année en cours)." },
      mois: { type: "integer", description: "Le mois 1-12 (par défaut : le mois en cours)." },
      bu: { type: "string", description: "La BU (son nom) — facultatif : toutes les BU visibles sinon." },
    },
    mots: "export exporte excel pilotage force vente delegues couverture realise visites planning kam mois",
  },
  {
    outil: "exporter_appel_d_offres_pch", route: "/api/pch/export", ecran: "/pch", format: "Excel",
    libelle: "Exporter un appel d'offres PCH (Excel)",
    description: "PRODUIT le tableau de réponse Excel d'un APPEL D'OFFRES PCH (produits demandés, prix de référence, analyse de marché). Déposé dans le Drive (« Exports »).",
    proprietes: { appelDOffres: designation("L'appel d'offres (sa référence)") },
    requis: ["appelDOffres"],
    mots: "export exporte excel appel offres pch marche tableau reponse soumission",
  },
  {
    outil: "exporter_segmentation", route: "/api/segmentation/export", ecran: "/segmentation", format: "Excel",
    libelle: "Exporter la segmentation d'une BU (Excel)",
    description: "PRODUIT le classeur Excel de la SEGMENTATION d'une BU (secteur, praticien, grade, Q1, Q2, potentiel), lignes visibles par la personne. Déposé dans le Drive (« Exports »).",
    proprietes: { strategie: designation("La stratégie de segmentation ou sa BU") },
    requis: ["strategie"],
    mots: "export exporte excel segmentation bu praticiens potentiel lettres ciblage",
  },
  {
    outil: "exporter_demande_stocks", route: "/api/stocks/demandes/[id]/export", ecran: "/stocks/demandes", format: "CSV",
    libelle: "Exporter une demande de stocks (CSV)",
    description: "PRODUIT le CSV d'une DEMANDE DE STOCKS (une ligne par établissement × produit, ruptures, saisies). Déposé dans le Drive (« Exports »).",
    proprietes: { demande: designation("La demande de stocks (son titre)") },
    requis: ["demande"],
    mots: "export exporte csv excel demande stocks inventaire etablissements ruptures boites",
  },
  {
    outil: "exporter_inscrits_evenement", route: "/api/events/[id]/export", ecran: "/events", format: "CSV",
    libelle: "Exporter les inscrits d'un événement (CSV)",
    description: "PRODUIT le CSV des INSCRITS d'un ÉVÉNEMENT (rôle, établissement, coordonnées, statut, check-in). Déposé dans le Drive (« Exports »).",
    proprietes: { evenement: designation("L'événement") },
    requis: ["evenement"],
    mots: "export exporte csv excel liste inscrits participants presence check in evenement",
  },
  {
    outil: "exporter_etude_de_marche", route: "/api/market-research/[id]/export", ecran: "/business-development/etudes", format: "Excel",
    libelle: "Exporter une étude de marché (Excel)",
    description: "PRODUIT le classeur Excel d'une ÉTUDE DE MARCHÉ (Business Development) au format du modèle. Déposé dans le Drive (« Exports »).",
    proprietes: { etude: designation("L'étude (son titre)") },
    requis: ["etude"],
    mots: "export exporte excel etude marche business development acteurs",
  },
  {
    outil: "exporter_presentation_etude", route: "/api/market-research/presentation/[versionId]", ecran: "/business-development/etudes", format: "PowerPoint",
    libelle: "Télécharger la présentation d'une étude (PowerPoint)",
    description: "PRODUIT la PRÉSENTATION PowerPoint d'une étude de marché (dernière version). Déposée dans le Drive (« Exports »).",
    proprietes: { presentation: designation("L'étude ou la présentation (son titre)") },
    requis: ["presentation"],
    mots: "presentation powerpoint pptx diapositives etude marche telecharge",
  },
  {
    outil: "exporter_suivi_coaching", route: "/api/medical/coaching/export", ecran: "/medical/coaching", format: "Excel",
    libelle: "Exporter le suivi du coaching (Excel)",
    description: "PRODUIT le classeur Excel du SUIVI DU COACHING (toutes les fiches visibles + synthèse), filtrable par collaborateur et statut. Déposé dans le Drive (« Exports »).",
    proprietes: {
      collaborateur: { type: "string", description: "Le collaborateur (son nom) — facultatif." },
      statut: { type: "string", description: "DRAFT (brouillon) ou FINALIZED (finalisée) — facultatif.", enum: ["DRAFT", "FINALIZED"] },
    },
    mots: "export exporte excel suivi coaching fiches synthese collaborateurs",
  },
  {
    outil: "exporter_fiche_coaching", route: "/api/medical/coaching/[id]/export", ecran: "/medical/coaching", format: "Excel",
    libelle: "Exporter une fiche de coaching (Excel)",
    description: "PRODUIT le classeur d'UNE FICHE DE COACHING au format du modèle de la Direction (la plus récente du collaborateur désigné). Déposé dans le Drive (« Exports »).",
    proprietes: { fiche: designation("Le collaborateur coaché") },
    requis: ["fiche"],
    mots: "fiche coaching telecharge export excel grille tournee collaborateur",
  },
  {
    outil: "exporter_annuaire", route: "/api/medical/annuaire/export", ecran: "/annuaires/medecins", format: "Excel",
    libelle: "Exporter l'annuaire des praticiens (Excel)",
    description: "PRODUIT le classeur Excel de l'ANNUAIRE des praticiens (colonnes de l'écran), sous la portée de la personne : médecins, pharmaciens, ou toute la feuille. Déposé dans le Drive (« Exports »).",
    proprietes: { grade: { type: "string", description: "medecins, pharmaciens — facultatif (toute la feuille sinon).", enum: ["medecins", "pharmaciens"] } },
    mots: "export exporte excel annuaire medecins pharmaciens praticiens liste",
  },
  {
    outil: "exporter_plan_de_tournee_pdf", route: "/api/medical/plan-de-tournee/[id]/pdf", ecran: "/medical/plan-de-tournee", format: "PDF",
    libelle: "Télécharger le plan de tournée (PDF)",
    description: "PRODUIT le PDF d'un PLAN DE TOURNÉE validé (visites par jour, lettres de segmentation) — le sien par défaut, ou celui d'un KAM qu'elle voit. Déposé dans le Drive (« Exports »).",
    proprietes: {
      kam: { type: "string", description: "Le KAM (son nom) — par défaut : la personne elle-même." },
      mois: { type: "string", description: "Le mois AAAA-MM — par défaut : le plan le plus récent." },
    },
    mots: "pdf plan tournee imprime telecharge visites mois kam planning",
  },
];


/** Le dossier du Drive personnel où l'assistant dépose les exports. */
export const DOSSIER_EXPORTS = "Exports";
