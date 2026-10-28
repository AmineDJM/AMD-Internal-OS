/**
 * Libellés — les ONGLETS des entrées fusionnées du menu (`NavTab` et les listes `*_TABS`).
 * Module PUR (composants client compris) : `navigation.ts` les range dans le menu ; réexporté par `lib/labels`.
 */

import type { AnnuaireAccordable } from "../annuaires/acces";
import type { Module } from "../rbac/modules";
import { CHEMIN_CATALOGUE_PROMO, CHEMIN_STOCK_PROMO } from "../chemins/stock-promo";
import { CHEMIN_RAPPORTS_TERRAIN } from "../chemins/rapports-terrain";

/** Un onglet d'une entrée fusionnée (sous-module + route). */
export interface NavTab {
  module: Module;
  label: string;
  href: string;
  /**
   * L'ANNUAIRE que cet onglet montre (§118.147). Présent = l'onglet s'affiche selon la règle de
   * l'accès par annuaire — le module de son référentiel OU l'annuaire coché dans la console —,
   * et plus selon le seul `module`. Absent = la règle ordinaire du module.
   */
  annuaire?: AnnuaireAccordable;
  /**
   * Nouveauté livrée derrière un drapeau de version (`src/lib/features.ts`) : l'onglet
   * n'apparaît qu'aux comptes qui la voient (stade TEST → testeurs, stade PROD → tout le
   * monde). Absent = onglet visible dès que le module est autorisé.
   */
  feature?: string;
  /**
   * Une RÈGLE nommée qui décide de l'affichage à la place du seul `module` — la même que la page et
   * les actions lisent (`nav-tabs.ts` la traduit). `"specialites"` : `peutGererSpecialites`, qui ouvre
   * le référentiel aux deux directeurs des opérations même sans la Promotion médicale en écriture.
   * `"marche-cockpit"` / `"argent-cockpit"` : le module PUIS la règle du marché ou de l'argent du Marketing cockpit
   * (`marketing-cockpit/acces.ts`).
   */
  regle?: "specialites" | "marche-cockpit" | "argent-cockpit";
}
/**
 * L'ESPACE PERSONNEL — UN SEUL ENDROIT.
 *
 * Il y en avait trois : « Mon travail » (ce qu'on doit signer et traiter), « Mon espace » (ses
 * tâches, ses congés) et « Mon dossier RH » (ses documents, ses demandes) — trois écrans pour
 * une seule question, « qu'est-ce qui me concerne ? ». On les ouvrait l'un après l'autre pour
 * en faire le tour, et l'on manquait celui qu'on n'avait pas pensé à ouvrir.
 *
 * « Mon travail » a fondu DANS « Mon espace » : ce qui attend une signature s'y lit en tête, les
 * tâches en dessous — puis les ordres de mission et les pièces demandées y sont devenus des
 * SECTIONS à leur tour. « Mon dossier RH » reste le seul onglet frère : c'est le dossier de la
 * personne (documents, demandes, congés), pas son travail. Le « Dashboard » a disparu.
 */
export const WORKSPACE_TABS: NavTab[] = [
  // « AUJOURD'HUI » REMPLACE « MON ESPACE » (Direction, 14/10/2026 — maquette « Mon espace par métier ») :
  // l'onglet principal de `/mon-espace` porte désormais la journée du MÉTIER (file groupée par lot, semaine,
  // équipe). L'ancien onglet « Aujourd'hui » (`/aujourdhui`, nouveauté `home_today` au stade TEST) quitte la
  // barre : deux onglets du même nom ne se distinguent pas. Sa page reste servie, inchangée (accueil des
  // testeurs, liens existants).
  { module: "WORKSPACE", label: "Aujourd'hui", href: "/mon-espace" },
  // TOUTES LES TÂCHES EN UN SEUL ENDROIT (Direction, 07/10) — à accepter, à faire, demandées, partagées, terminées.
  // Le compteur de l'onglet est posé par `ongletsEspace` (`queries/mes-taches.ts`).
  { module: "WORKSPACE", label: "Tâches", href: "/mon-espace/taches" },
  // MES MISSIONS (Direction, 10/2026) — les missions Ad & Pro reliées au profil : invitations, ordre de mission
  // (N+1 → RH), et les étapes que la personne ajoute. `/missions` y renvoie.
  { module: "WORKSPACE", label: "Mes missions", href: "/mon-espace/missions" },
  { module: "WORKSPACE", label: "Mon dossier RH", href: "/mon-dossier" },
  // MON BILAN (KPI sans code, Direction 08/10) : ses KPI en continu, sa revue signée, ses déclarations.
  { module: "KPI", label: "Mon bilan", href: "/mon-espace/bilan" },
  // PLUS D'ONGLET « ANNUAIRE » (Direction, 06/10 : « enlève Annuaire de Mon espace ») : les carnets vivent dans le
  // module Annuaires. La page `/mon-espace/annuaire` reste servie — liens et notifications y pointent encore.
  // Les pièces demandées ne sont PLUS un onglet : elles s'affichent en SECTION dans « Mon espace »
  // (la page /pieces survit — liens et notifications y pointent encore).
  // PLUS D'ONGLET « DIRECTIVES » (Direction, 07/10) : elles restent dans « Aujourd'hui », le centre d'actions, la
  // recherche et les notifications ; /directives reste servie.
];
/**
 * L'AGENDA — le calendrier ET les réunions, au même endroit.
 *
 * C'étaient deux entrées de menu, dans deux groupes différents, pour une seule journée : le
 * « Calendrier » projetait DÉJÀ les réunions planifiées (`getScheduledMeetingsAsEvents`), et
 * « Réunions & appels » listait les mêmes objets sous un autre angle. On planifiait d'un côté,
 * on retrouvait de l'autre, et l'on cherchait toujours dans celui qu'on n'avait pas ouvert.
 *
 * Une entrée, deux vues : le MOIS (où l'on voit sa journée) et la LISTE des réunions (où l'on
 * ouvre un compte rendu). Elles n'ont pas le même module — l'une tient à l'espace de travail,
 * l'autre à la messagerie — et c'est justement ce que les onglets savent faire : chacun
 * n'apparaît qu'à qui y a droit.
 */
export const AGENDA_TABS: NavTab[] = [
  { module: "WORKSPACE", label: "Calendrier", href: "/calendar" },
  { module: "MESSAGING", label: "Réunions & appels", href: "/meetings" },
];

// BUDGETS — trois écrans au lieu d'un seul écran fourre-tout : on REGARDE (vue d'ensemble
// graphique), on TRAVAILLE (dépenses à imputer), on RÈGLE (enveloppe, catégories, total).

export const BUDGET_TABS: NavTab[] = [
  { module: "BUDGETS", label: "Vue d'ensemble", href: "/budgets" },
  { module: "BUDGETS", label: "Dépenses", href: "/budgets/depenses" },
  { module: "BUDGETS", label: "Départements", href: "/budgets/departements" },
  // LE BUDGET PAR GAMME — une Business Unit EST un sous-département, mais on ne vient pas la
  // chercher dans une liste où elle voisine avec les Finances et les Ressources humaines : la
  // question « combien l'oncologie a-t-elle dépensé ? » se pose sur les gammes, entre elles.
  { module: "BUDGETS", label: "Business Units", href: "/budgets/business-units" },
  { module: "BUDGETS", label: "Réglages", href: "/budgets/reglages" },
];

// BUDGET MARKETING (Direction, 08/10) — les écrans de Budgets, bornés aux enveloppes de la Direction Marketing, plus
// la liste des demandes Ad & Pro qui consomment l'enveloppe. Mêmes lignes en base : Budgets les lit aussi.
export const BUDGET_MARKETING_TABS: NavTab[] = [
  { module: "BUDGET_MARKETING", label: "Vue d'ensemble", href: "/budget-marketing" },
  { module: "BUDGET_MARKETING", label: "Dépenses", href: "/budget-marketing/depenses" },
  { module: "BUDGET_MARKETING", label: "Demandes Ad & Pro", href: "/budget-marketing/ad-pro" },
  { module: "BUDGET_MARKETING", label: "Réglages", href: "/budget-marketing/reglages" },
];

// BUDGET REGULATORY et BUDGET OPERATIONS & SALES (Direction, 08/10) — la même mécanique que Budget Marketing : les écrans
// de Budgets bornés aux enveloppes du pôle, plus l'écran propre au pôle (les BV par dossier ; la masse salariale).
export const BUDGET_REGULATORY_TABS: NavTab[] = [
  { module: "BUDGET_REGULATORY", label: "Vue d'ensemble", href: "/budget-regulatory" },
  { module: "BUDGET_REGULATORY", label: "BV par dossier", href: "/budget-regulatory/bv" },
  { module: "BUDGET_REGULATORY", label: "Dépenses", href: "/budget-regulatory/depenses" },
  { module: "BUDGET_REGULATORY", label: "Réglages", href: "/budget-regulatory/reglages" },
];
export const BUDGET_OPERATIONS_TABS: NavTab[] = [
  { module: "BUDGET_OPERATIONS", label: "Vue d'ensemble", href: "/budget-operations" },
  { module: "BUDGET_OPERATIONS", label: "Masse salariale", href: "/budget-operations/masse-salariale" },
  { module: "BUDGET_OPERATIONS", label: "Dépenses", href: "/budget-operations/depenses" },
  { module: "BUDGET_OPERATIONS", label: "Réglages", href: "/budget-operations/reglages" },
];

// VENTES PCH (Direction, 08/10) — les fichiers de la PCH lus par BU. Il remplace « Ventes » (saisie manuelle, module
// `SALES` retiré du service) : son historique reste lisible, en lecture seule, dans le dernier onglet.
export const VENTES_PCH_TABS: NavTab[] = [
  { module: "PCH_VENTES", label: "Synthèse", href: "/sales" },
  { module: "PCH_VENTES", label: "Contrats", href: "/sales/contrats" },
  { module: "PCH_VENTES", label: "Territoires", href: "/sales/territoires" },
  { module: "PCH_VENTES", label: "Non servi", href: "/sales/non-servi" },
  { module: "PCH_VENTES", label: "Importer", href: "/sales/importer" },
  { module: "PCH_VENTES", label: "Historique", href: "/sales/historique" },
];
// LES SOUS-MODULES RH (Direction, 06/10) — indépendants (chacun son droit, réglable dans la console) mais reliés (un même
// groupe « Ressources humaines » dans le menu, et chaque page renvoie aux autres).
// « Employés » : l'équipe, les consultants suivis par les RH (§118.150), la structure (départements).
export const EMPLOYES_TABS: NavTab[] = [
  { module: "EMPLOYEES", label: "Équipe", href: "/rh/equipe" },
  // Les contrats des consultants suivis par les RH — les mêmes contrats qu'Ad & Pro › Consulting, au pôle RH : c'est ici
  // qu'arrive un contrat transféré depuis Ad & Pro.
  { module: "EMPLOYEES", label: "Consultants", href: "/rh/consultants" },
  { module: "EMPLOYEES", label: "Départements", href: "/rh/departements" },
];
// « Demandes RH » : les demandes des salariés (attestations, ordres de mission, notes de frais, entrevues) et les congés.
export const DEMANDES_RH_TABS: NavTab[] = [
  { module: "HR_REQUESTS", label: "Demandes", href: "/rh/demandes" },
  { module: "HR_REQUESTS", label: "Congés et absences", href: "/rh/conges" },
];// « Ad & Pro » : sponsoring + congrès (international/national) + événements +
// matériel promotionnel, sous un seul module. Le matériel promotionnel a été
// déplacé ici depuis « Promotion médicale » (sa fonctionnalité est inchangée).
/**
 * VENTES · LOGISTIQUE · PCH — TROIS MODULES SÉPARÉS, plus une entrée à onglets.
 *
 * Les regrouper supposait qu'on passe de l'un à l'autre ; en réalité on ouvre les Ventes pour
 * le chiffre d'affaires, la Logistique pour une livraison et PCH pour un appel d'offres — trois
 * métiers, trois moments. Chacun a désormais sa propre entrée de menu (Ventes sous Sales &
 * Marketing, Marchés PCH sous Business Development, Commandes & logistique sous Supply Chain).
 */

export const EVENTS_TABS: NavTab[] = [
  // UNE SEULE DEMANDE : la vue unifiée ouvre le pôle. Les écrans par nature restent derrière —
  // ils portent les champs propres (billets, visas, devis d'agence) et leurs circuits.
  { module: "SPONSORING", label: "Toutes les demandes", href: "/ad-pro" },
  { module: "SPONSORING", label: "Sponsoring", href: "/sponsoring" },
  { module: "CONGRESS_INTERNATIONAL", label: "Prises en charge Internationales", href: "/congress-international" },
  { module: "CONGRESS_NATIONAL", label: "Prises en charge Nationales", href: "/congress-national" },
  { module: "EVENTS", label: "Événements", href: "/events" },
  { module: "PROMO_MATERIAL", label: "Matériel promotionnel", href: "/promo-material" },
  // LE STOCK ET LE CATALOGUE NE SONT PLUS DES ONGLETS D'AD & PRO (§118.173) — décision de la
  // Direction (01/10) : « un sous-module à part de Sales & Marketing, totalement à part ». Ils ont
  // leur propre entrée de menu (`STOCK_PROMO_TABS`), et restent reliés aux achats par leurs liens :
  // une réception de facture entre au magasin, un poste Ad & Pro y réserve son matériel.
  { module: "CONSULTING", label: "Consulting", href: "/consulting" },
  { module: "AD_PRO_OTHER", label: "Autres demandes", href: "/ad-pro/autres" },
];
/**
 * LE STOCK PROMOTIONNEL — un sous-module À PART du pôle Sales & Marketing (§118.173).
 *
 * Deux écrans, deux questions : le STOCK (« qu'avons-nous, où, et qu'est-ce qui est en route ? »,
 * module `PROMO_STOCK` : le directeur des opérations tient le stock de ses équipes sans instruire
 * d'achat) et le CATALOGUE (les supports qu'on peut commander, triés en trois familles, module
 * `PROMO_CATALOG` : au Super Admin par défaut, ouvert par lui à qui il veut). L'entrée de menu
 * s'ouvre sur le premier des deux que la personne a le droit de voir. Les adresses vivent au socle
 * (`chemins/stock-promo.ts`) : le menu, les actions, les rappels et les écrans les lisent.
 */
export const STOCK_PROMO_TABS: NavTab[] = [
  { module: "PROMO_STOCK", label: "Stock", href: CHEMIN_STOCK_PROMO },
  { module: "PROMO_CATALOG", label: "Catalogue", href: CHEMIN_CATALOGUE_PROMO },
];
/**
 * MARKETING COCKPIT — le tableau de la Direction Marketing (Direction, 07/10 — maquette validée). UNE page,
 * `/marketing-cockpit`, et ses vues par `?vue=` : le produit choisi (`?produit=`) suit d'une vue à l'autre, ce
 * qu'une route par onglet perdrait. La page rend elle-même la barre (l'onglet actif est un paramètre, pas un
 * chemin) : l'entrée de menu n'a donc pas de `tabs`. « Spécialités » est parti dans les Annuaires (07/10).
 * « Marché » s'affiche à qui a DÉJÀ le marché (Business Development) ; « Investissements » à qui lit l'argent.
 */
export const MARKETING_COCKPIT_TABS: NavTab[] = [
  { module: "MARKETING_COCKPIT", label: "Vue d'ensemble", href: "/marketing-cockpit" },
  { module: "MARKETING_COCKPIT", label: "Leaders d'opinion", href: "/marketing-cockpit?vue=leaders" },
  { module: "MARKETING_COCKPIT", label: "Messages", href: "/marketing-cockpit?vue=messages" },
  { module: "MARKETING_COCKPIT", label: "Marché", href: "/marketing-cockpit?vue=marche", regle: "marche-cockpit" },
  { module: "MARKETING_COCKPIT", label: "Investissements", href: "/marketing-cockpit?vue=investissements", regle: "argent-cockpit" },
];
/**
 * FORCE DE VENTE — l'outil du superviseur et de la Direction (Direction, 07/10 — maquette validée). Trois vues :
 * « Pilotage » (l'ouverture), « Territoires » (secteurs, panel par lettre, charge, cibles hors panel), « Produits »
 * (P1/P2/P3 par délégué). Business units, secteurs et paramètres sont un module à part : « Business Units » (08/10).
 */
export const SALES_PLANNING_TABS: NavTab[] = [
  { module: "SALES_PLANNING", label: "Pilotage", href: "/planning" },
  { module: "SALES_PLANNING", label: "Territoires", href: "/planning/territoires" },
  { module: "SALES_PLANNING", label: "Produits", href: "/planning/produits" },
];
/**
 * BUSINESS UNITS — le montage de la force de vente (Direction, 08/10 : « tu crées dans le menu un module "Business Units"
 * et tu y mets BU et secteurs et paramètres »). Il vivait dans le « ⋯ Réglages » de la Force de vente.
 */
export const BUSINESS_UNITS_TABS: NavTab[] = [
  { module: "BUSINESS_UNITS", label: "Business units", href: "/business-units" },
  { module: "BUSINESS_UNITS", label: "Secteurs", href: "/business-units/secteurs" },
  { module: "BUSINESS_UNITS", label: "Paramètres", href: "/business-units/parametres" },
];
// Module « Drive » (Drive personnel). L'onglet « Documents » a été retiré (tout est consolidé
// dans le Drive + les catégories partagées ; on y glisse des dossiers à la souris).
export const DOCS_TABS: NavTab[] = [
  { module: "DRIVE", label: "Drive", href: "/drive" },
];
// Promotion médicale (annuaire, segmentation) et Rapports terrain sont désormais DEUX modules
// distincts (accès configurables séparément dans Administration). Les onglets partagés sont retirés.
// Adventum Brain + Process Intelligence, dans un seul cockpit Super Admin.
export const BRAIN_TABS: NavTab[] = [
  { module: "ADVENTUM_BRAIN", label: "Adventum Brain", href: "/adventum-brain" },
  { module: "PROCESS_INTELLIGENCE", label: "Process Intelligence", href: "/process-intelligence" },
];
// Administration : console + Contrôle de l'IA + Score d'adoption.
export const ADMIN_TABS: NavTab[] = [
  { module: "ADMIN", label: "Administration", href: "/admin" },
  { module: "ADMIN", label: "Bases de données", href: "/admin/bases" },
  // L'arbre entité → gammes → produits : de lui découle ce que chacun voit de la plateforme.
  { module: "ADMIN", label: "Gammes & produits", href: "/admin/gammes" },
  { module: "ADMIN", label: "Contrôle de l'IA", href: "/admin/ai" },
  // Le catalogue des KPI et les modèles par rôle (KPI sans code) — Super Admin seul.
  { module: "ADMIN", label: "KPI & modèles", href: "/admin/kpi" },
  { module: "ADMIN", label: "Coût IA & audit Regulatory", href: "/admin/regulatory-ia" },
  { module: "ADMIN", label: "Score d'adoption", href: "/admin/adoption" },
  { module: "ADMIN", label: "Diagnostic", href: "/admin/diagnostic" },
  // La couche de connaissance tourne en fond, donc invisible par construction : sans cet écran,
  // une file qui s'engorge ou une dérive vers les modèles chers se découvre sur une facture.
  { module: "ADMIN", label: "Couche de connaissance", href: "/admin/connaissance" },
  { module: "ADMIN", label: "Messagerie & notifications", href: "/admin/messagerie" },
  // La LIAISON au site public (§118.160) : la clé, la vérification, le rapprochement à la demande,
  // la mise en service — Super Admin seul. Les contenus se publient, eux, depuis le module « Site web ».
  { module: "ADMIN", label: "Site web (connexion)", href: "/admin/site-web" },
  { module: "ADMIN", label: "Test Center", href: "/admin/test-center" },
];

// Navigation simplifiée : modules fusionnés en onglets (`tabs`) pour réduire le
// nombre d'entrées. Messagerie & Notifications ne sont PLUS dans le menu — elles
// restent accessibles via leurs icônes dans la barre du haut (les routes /messages
// et /notifications et leurs modules RBAC sont inchangés).
/**
 * PROMOTION MÉDICALE — « Ma journée » (le terrain) et l'annuaire (le référentiel).
 *
 * Le premier onglet est celui qu'on ouvre chaque matin ; le second celui qu'on consulte. Mettre
 * l'annuaire en tête obligeait un délégué à traverser un référentiel pour noter une visite.
 */
export const MEDICAL_TABS: NavTab[] = [
  { module: "MEDICAL", label: "Ma journée", href: "/medical/ma-journee" },
  // LE PLAN DE TOURNÉE — là où le KAM prépare son mois et où son N+1 le tranche. Il vient
  // AVANT l'annuaire : un engagement validé passe devant un référentiel qu'on consulte.
  { module: "MEDICAL", label: "Plan de tournée", href: "/medical/plan-de-tournee" },
  // LE COACHING — la fiche « tournée en double » (§118.157), juste après le plan de tournée : on
  // l'écrit au retour d'une tournée. Sa grille est administrée par le directeur des opérations,
  // qui n'a que la LECTURE du module — l'onglet s'affiche donc sur le droit de voir, et ce que
  // chacun y FAIT vient de la règle du coaching (`lib/coaching/acces.ts`).
  { module: "MEDICAL", label: "Coaching", href: "/medical/coaching" },
  // LES RAPPORTS TERRAIN (Direction, 07/10) — plus une entrée de menu à part : le KAM rapporte depuis son planning, et
  // cet onglet n'est que la LISTE des rapports. Il porte le module `FIELD_REPORTS` : la console décide toujours qui le
  // voit (la Direction et les managers : tous les rapports ; un délégué : les siens). `/field-reports` y REDIRIGE.
  { module: "FIELD_REPORTS", label: "Rapports", href: CHEMIN_RAPPORTS_TERRAIN },
  // PLUS D'ONGLET « ANNUAIRE » (Direction, 06/10) : les praticiens se tiennent dans Annuaires › Médecins / Pharmaciens.
  // PLUS D'ONGLET « ÉTABLISSEMENTS » ICI (décision de la Direction, 09/2026 — §118.138) : « on
  // les crée et on les gère depuis les Annuaires ». Le référentiel des hôpitaux ne vit donc plus
  // qu'à UN endroit, Administration › Annuaires › Établissements. Deux portes vers le même
  // référentiel n'était pas une fuite — les deux lisaient le même chargeur — mais c'était deux
  // endroits où chercher, et la Direction a tranché lequel garder. `/medical/etablissements`
  // REDIRIGE (les liens déjà envoyés restent valides).
];

/**
 * ANNUAIRES — le sous-module du pôle Administration qui centralise TOUS les annuaires.
 *
 * Demande de la Direction (09/2026) : « un module à part dans Administration nommé Annuaires qui
 * contiendra tous les annuaires (partenaires, médecins, pharmaciens, établissements, et autres),
 * tous centralisés ». Chaque onglet porte le MODULE du référentiel qu'il montre : c'est lui qui
 * décide de son affichage (`visibleTabs`), pas la porte « Annuaires » — un onglet Médecins
 * visible à qui n'a pas la Promotion médicale serait une fuite par le menu.
 *
 * Les écrans de chaque onglet rendent les MÊMES composants et lisent les MÊMES chargeurs que les
 * pages des modules d'origine (`lib/queries/annuaires.ts`) : deux écrans qui chargent
 * séparément le même annuaire divergent, toujours (§118.5).
 */
export const ANNUAIRES_TABS: NavTab[] = [
  { module: "MEDICAL", label: "Médecins", href: "/annuaires/medecins", annuaire: "MEDECINS" },
  { module: "MEDICAL", label: "Pharmaciens", href: "/annuaires/pharmaciens", annuaire: "PHARMACIENS" },
  { module: "MEDICAL", label: "Établissements", href: "/annuaires/etablissements", annuaire: "ETABLISSEMENTS" },
  // LES SPÉCIALITÉS REVIENNENT DANS LES ANNUAIRES (Direction, 07/10 : « Spécialités → Annuaires ») — porte UNIQUE ;
  // les anciennes adresses (Marketing cockpit, Force de vente) y mènent. Le référentiel suit `peutGererSpecialites`
  // (la Promotion médicale, les directeurs des opérations, la Direction Marketing), pas une case d'annuaire.
  { module: "MEDICAL", label: "Spécialités", href: "/annuaires/specialites", regle: "specialites" },
  // « Autres annuaires » disparaît : ses fournisseurs deviennent un annuaire à part entière ;
  // les partenaires du courrier et les lieux de stock restent dans leurs modules.
  { module: "WORKSPACE", label: "Partenaires", href: "/annuaires/partenaires", annuaire: "PARTENAIRES" },
  { module: "WORKSPACE", label: "Partenaires publics", href: "/annuaires/partenaires-publics", annuaire: "PARTENAIRES_PUBLICS" },
  { module: "DIRECTORIES", label: "Fournisseurs Regulatory", href: "/annuaires/fournisseurs", annuaire: "FOURNISSEURS" },
  { module: "WORKSPACE", label: "Personnes", href: "/annuaires/personnes", annuaire: "PERSONNES" },
];

/**
 * LE SITE PUBLIC (§118.158) — trois écrans d'un même module : l'état de la publication (ce qui est
 * en ligne, en file, refusé ; la réconciliation quotidienne), les articles de blog, et les offres
 * d'emploi. Les offres s'ÉCRIVENT par les RH (droit `RH` en écriture), qui y arrivent aussi depuis
 * le Recrutement ; l'onglet les montre à qui tient le module, en lecture.
 */
export const SITE_WEB_TABS: NavTab[] = [
  { module: "SITE_WEB", label: "Publication", href: "/site-web" },
  { module: "SITE_WEB", label: "Articles", href: "/site-web/articles" },
  { module: "SITE_WEB", label: "Offres d'emploi", href: "/site-web/offres" },
  { module: "SITE_WEB", label: "Audience", href: "/site-web/audience" },
];
