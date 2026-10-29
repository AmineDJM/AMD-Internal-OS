/**
 * Libellés — le MENU : la forme d'une entrée (`NavItem`), les noms des modules et des actions du RBAC, l'arbre `NAVIGATION`, les anciens
 * libellés, et la résolution chemin → module (`moduleForPath`, `firstAccessibleHref`).
 * Module PUR (composants client compris) : `rbac` le lit pour l'accès par section ; réexporté par `lib/labels`.
 */

import type { Action, Module } from "../rbac/modules";
import { CHEMIN_STOCK_PROMO } from "../chemins/stock-promo";
import { CHEMIN_BONS_DE_COMMANDE } from "../chemins/bons-de-commande";
import { AGENDA_TABS, ADMIN_TABS, ANNUAIRES_TABS, BRAIN_TABS, BUDGET_MARKETING_TABS, BUDGET_OPERATIONS_TABS, BUDGET_REGULATORY_TABS, BUDGET_TABS, BUSINESS_UNITS_TABS, DOCS_TABS, EVENTS_TABS, MARKETING_COCKPIT_TABS, MEDICAL_TABS, SALES_PLANNING_TABS, SITE_WEB_TABS, STOCK_PROMO_TABS, VENTES_PCH_TABS, WORKSPACE_TABS, type NavTab } from "./onglets";

/** Navigation metadata: maps a sidebar entry to a module + route + icon name. */
export interface NavItem {
  module: Module;
  label: string;
  href: string;
  icon: string; // lucide-react icon name
  group: "Pilotage" | "Pôles" | "Transverse" | "Système";
  /**
   * Pôle d'entreprise auquel l'entrée appartient (groupe « Pôles » uniquement). C'est ce qui
   * remplace les treize entrées à plat : l'utilisateur voit son entreprise, pas les modules.
   */
  pole?: "REGULATORY" | "ADMINISTRATION" | "MARKETING" | "OPERATIONS_SALES" | "BUSINESS_DEV";
  /**
   * Garde SUPPLÉMENTAIRE au droit de module, résolue côté serveur dans le layout. Sert aux
   * écrans dont l'ouverture dépend d'un réglage et pas seulement d'un rôle (l'analyse CTD est
   * débloquée en Administration, rôle par rôle). `adamMissions` : le Centre de missions n'est
   * envoyé qu'au Super Admin (`peutPiloterMissionsAdam`, §118.136) — le module WORKSPACE est à
   * tout le monde, la règle n'est pas un module.
   */
  gate?: "regEnrollment" | "pipeline" | "payroll" | "myTeam" | "adamMissions" | "adam" | "corbeilleOps" | "pharmacovigilance";
  /**
   * Entrée fusionnée : plusieurs sous-modules présentés en onglets sur la page.
   * L'entrée est visible si l'utilisateur a accès à **au moins un** onglet, et son
   * lien est résolu (dans le layout) vers le premier onglet autorisé. Aucune
   * fonctionnalité n'est retirée : chaque onglet reste sa propre route, gardée par
   * son propre module.
   */
  tabs?: NavTab[];
  /**
   * SOUS-MODULES — des modules à part entière, rangés SOUS un autre dans le menu.
   *
   * Différent de `tabs` : un onglet est une section d'un même écran, un enfant est un module
   * autonome (sa route, sa garde, son écran) rangé sous son parent. Il se déplie par une flèche,
   * sur ordinateur comme sur mobile.
   *
   * La PAIE s'en sert : elle vit sous « Ressources humaines », derrière la flèche, parce qu'elle
   * n'a pas la même audience que le reste du module (voir l'entrée RH plus bas).
   */
  children?: NavItem[];
  /**
   * UN GROUPE de sous-modules (Ressources humaines, Direction 06/10) : l'entrée s'affiche dès qu'UN de ses enfants est
   * ouvert, même sans le module du parent — elle mène alors au premier enfant ouvert.
   */
  groupe?: boolean;
  /** Préfixes de chemin additionnels qui activent l'entrée (pour les entrées fusionnées). */
  match?: string[];
}

/**
 * Libellé lisible et **stable** par module, indépendant du menu (qui fusionne
 * désormais plusieurs modules sous une seule entrée). Utilisé par l'administration
 * (matrice d'accès) pour nommer chaque module, même ceux qui n'ont plus d'entrée
 * de menu dédiée. Typé `Record<Module, string>` → exhaustivité garantie.
 */
export const MODULE_LABELS: Record<Module, string> = {
  FEEDBACK: "Feedback",
  GENERAL_MEANS: "Moyens généraux",
  LEGAL: "Legal",
  MAIL_REGISTER: "Courriers",
  RECRUITMENT: "Recrutement",
  MY_TEAM: "Mon Équipe",
  DIRECTORIES: "Annuaires",
  WORKSPACE: "Espace de travail",
  MESSAGING: "Messagerie",
  REGULATORY: "Regulatory",
  REGULATORY_PIPELINE: "Pipeline réglementaire",
  SPONSORING: "Sponsoring",
  BUDGETS: "Budgets",
  BUDGET_MARKETING: "Budget Marketing",
  BUDGET_REGULATORY: "Budget Regulatory",
  BUDGET_OPERATIONS: "Budget Operations & Sales",
  FINANCES: "Finances",
  RH: "Ressources humaines",
  CONGRESS_INTERNATIONAL: "Prises en charge Internationales",
  CONGRESS_NATIONAL: "Prises en charge Nationales",
  EVENTS: "Événements",
  SALES: "Ventes",
  LOGISTICS: "Logistique",
  // « Annuaire » était le nom de l'écran d'ORIGINE de ce module ; le menu dit « Promotion
  // médicale » depuis le chantier force de vente, et la console d'accès continuait à le
  // présenter sous son ancien nom. On cherchait « Promotion médicale » dans la liste des
  // modules et on ne le trouvait pas — un droit qu'on n'arrive pas à nommer est un droit qu'on
  // ne donne pas. Le libellé du module suit celui du menu.
  MEDICAL: "Promotion médicale",
  FIELD_REPORTS: "Rapports terrain",
  SALES_PLANNING: "Prévisions & Force de vente",
  BUSINESS_UNITS: "Business Units",
  // LES TROIS ÉCRANS DU PÔLE SE NOMMENT ICI COMME DANS LE MENU, et se règlent séparément.
  // « Business Development » couvrait DEUX entrées de menu (Market Intelligence et
  // l'Explorateur produits) sous un seul droit : on ne pouvait ni ouvrir l'un sans l'autre,
  // ni retrouver « Explorateur produits » dans la console — le nom n'y existait pas.
  BUSINESS_DEVELOPMENT: "Market Intelligence",
  PRODUCT_EXPLORER: "Explorateur produits",
  PCH: "Marchés PCH",
  STOCKS: "Stocks PCH",
  MEDICAL_INFO: "Information médicale",
  PROMO_MATERIAL: "Matériel promotionnel",
  PROMO_STOCK: "Stock promotionnel",
  PROMO_CATALOG: "Catalogue promotionnel",
  CONSULTING: "Consulting",
  AD_PRO_OTHER: "Ad & Pro — autres demandes",
  VALIDATIONS: "Demandes de validations",
  VALIDATION_CENTRE: "Centre de validations",
  AD_PRO_CENTRE: "Centre de validation Ad & Pro",
  DIRECTIVES: "Directives",
  SUPPORT: "Demandes de support",
  // « SUJETS » — Pilotage (anciennement « Projets », renommé sur décision de la Direction,
  // 30/09/2026) : un sujet délégué et suivi (recherche, analyse, demande). « Projets » ne nomme
  // plus que le registre de Business Development (§118.163).
  DOSSIERS: "Sujets",
  DOCUMENTS: "Documents",
  DRIVE: "Drive",
  ADMIN_REQUESTS: "Bureau du secrétariat",
  PAYMENT_CENTRE: "Centre de paiement",
  CHIEF_OF_STAFF: "My Chief of Staff",
  ASSISTANT_IA: "Assistant IA",
  NOTIFICATIONS: "Notifications",
  PROCESS_INTELLIGENCE: "Process Intelligence",
  ADVENTUM_BRAIN: "Adventum Brain",
  ADMIN: "Administration",
  SITE_WEB: "Site web",
  // « PROJETS » (BD) — le registre par lequel on classe les dossiers réglementaires, devenu un
  // module réglé depuis la console comme les autres (§118.163). Le libellé suit le menu ; il ne
  // se confond plus avec Pilotage, renommé « Sujets » : deux cases « Projets » dans la console
  // feraient ouvrir l'un en croyant ouvrir l'autre.
  BD_PROJECTS: "Projets",
  // « BONS DE COMMANDE » — la file des bons de commande à signer, devenue un module à part des
  // Finances (§118.176). Le libellé suit le menu : c'est sous ce nom qu'on le cherche dans la
  // console pour l'ouvrir à quelqu'un.
  PURCHASE_ORDERS: "Bons de commande",
  MARKETING_COCKPIT: "Marketing cockpit",
  SEGMENTATION: "Segmentation Studio",
  SEGMENTATION_POTENTIEL: "Segmentation — potentiel forcé à la main",
  CONSUMPTION: "Consumption Intelligence",
  PRODUCTS: "Produits",
  EMPLOYEES: "Employés",
  HR_REQUESTS: "Demandes RH",
  TRAINING: "Formations",
  PHARMACOVIGILANCE: "Pharmacovigilance",
  PCH_VENTES: "Ventes PCH",
  KPI: "KPI & bilans",
  COCKPIT_OPERATIONS: "Cockpit Opérations",
  BUDGET_CAMPAIGN: "Campagne budgétaire",
  ART_DIRECTION: "Direction artistique",
};

/**
 * Les ACTIONS, en français. Un seul endroit : l'écran des accès, la fiche d'un employé et le
 * journal d'audit doivent nommer « Valider » de la même façon, sinon deux écrans décrivent le
 * même droit avec deux mots et personne ne sait s'il s'agit du même.
 */
export const ACTION_LABELS: Record<Action, string> = {
  VIEW: "Voir",
  CREATE: "Créer",
  UPDATE: "Modifier",
  DELETE: "Supprimer",
  VALIDATE: "Valider",
  EXPORT: "Exporter",
  UPLOAD: "Téléverser",
};

export const NAVIGATION: NavItem[] = [
  // Pilotage — « Mon espace » regroupe désormais Mon travail, Mon espace, Dashboard, Calendrier
  // (onglets). `match` couvre ces routes pour l'état actif de la barre latérale. Les Directives n'en font plus partie (07/10).
  { module: "WORKSPACE", label: "Mon espace", href: "/mon-espace", icon: "LayoutGrid", group: "Pilotage", tabs: WORKSPACE_TABS, match: ["/mon-travail", "/mon-dossier", "/missions", "/pieces"] },
  { module: "WORKSPACE", label: "Agenda", href: "/calendar", icon: "CalendarDays", group: "Pilotage", tabs: AGENDA_TABS, match: ["/meetings"] },
  // Assistant IA : MODULE À PART ENTIÈRE (`ASSISTANT_IA`), distinct d'Adam — le Super Admin l'a,
  // et l'ouvre à qui il veut dans Administration › Accès. L'entrée suit le module, comme les autres.
  { module: "ASSISTANT_IA", label: "Assistant IA", href: "/assistant", icon: "Sparkles", group: "Pilotage" },
  // LE CENTRE DE MISSIONS — le PARC de ce qu'Adam exécute. Il vit à côté de l'assistant et pas
  // dedans : une mission est un objet de l'ERP (identifiant, propriétaire, étapes, livrables,
  // journal), et la ranger dans la conversation ferait dépendre son écran de l'assistant, ce
  // que le cliquet de frontière mesure et fait baisser lot après lot. `/missions/<id>` — où
  // pointent toutes ses notifications — reste son adresse ; ceci en est la liste, qui manquait.
  // RÉSERVÉ AU SUPER ADMIN (décision de la Direction, 09/2026) : la garde `adamMissions` lit
  // `peutPiloterMissionsAdam` dans `nav-access.ts` — l'entrée n'est pas envoyée aux autres.
  { module: "WORKSPACE", label: "Missions d'Adam", href: "/centre-de-missions", icon: "Radar", group: "Pilotage", match: ["/centre-de-missions"], gate: "adamMissions" },
  // « MY CHIEF OF STAFF » — l'interface exécutive de pilotage, réservée au PDG et au Super
  // Admin (module CHIEF_OF_STAFF). Même moteur que l'assistant, mais les outils d'un chef de
  // cabinet : histoire complète d'un dossier, lecture des documents, bilans, rappels planifiés,
  // décisions du centre de paiement.
  { module: "CHIEF_OF_STAFF", label: "My Chief of Staff", href: "/chief-of-staff", icon: "Crown", group: "Pilotage", gate: "adam" },
  { module: "DOSSIERS", label: "Sujets", href: "/dossiers", icon: "ClipboardList", group: "Pilotage" },
  // Messagerie Microsoft 365 — sous le module MESSAGING (droit déjà existant) ; l'ouverture réelle
  // dépend en plus du drapeau MICROSOFT_MAIL et de la liste pilote, vérifiés dans l'écran.
  // Elle est dans PILOTAGE et non dans Transverse : on relève ses mails en même temps qu'on
  // regarde son espace et son calendrier, pas en même temps qu'on range un fichier.
  { module: "MESSAGING", label: "Messagerie e-mail", href: "/messagerie", icon: "Mail", group: "Pilotage" },
  // « Courrier » (boîte mail intégrée) retiré de la plateforme — la messagerie e-mail se gère
  // désormais directement dans l'app Infomaniak. Le code back-end reste dormant (non exposé).
  // ─────────────────────────── PÔLES D'ENTREPRISE ───────────────────────────
  // Les routes ne changent PAS : seul le rangement change. Un lien de notification écrit il y a
  // six mois reste donc valide, sans redirection.

  // REGULATORY — le suivi d'un dossier a SA porte : une assistante qui suit un dossier n'a pas à
  // traverser toute l'interface d'analyse CTD pour y arriver.
  { module: "REGULATORY", label: "Suivi des dossiers", href: "/regulatory", icon: "FileCheck2", group: "Pôles", pole: "REGULATORY" },
  // Le PIPELINE est un module du pôle REGULATORY, au même rang que le suivi des dossiers : il se
  // découvre en dépliant la flèche de Regulatory. Ce sont les dossiers verrouillés — ce qu'on
  // étudie sans l'avoir encore ouvert à l'équipe.
  // GARDE `pipeline` : l'entrée ne s'affiche que pour qui voit RÉELLEMENT des dossiers
  // verrouillés (accès réglé en Administration). Sans elle, tout le pôle Regulatory voyait un
  // menu menant à un écran vide — et se demandait ce qu'il avait manqué.
  // SON PROPRE MODULE (Direction, 08/10 : « sépare Pipeline et Suivi de dossiers dans les accès ») : la console
  // l'ouvre ou le ferme personne par personne, indépendamment du suivi des dossiers.
  { module: "REGULATORY_PIPELINE", label: "Pipeline", href: "/regulatory/pipeline", icon: "GitBranch", group: "Pôles", pole: "REGULATORY", gate: "pipeline" },
  { module: "REGULATORY", label: "Analyse CTD", href: "/regulatory/enregistrement", icon: "ScanSearch", group: "Pôles", pole: "REGULATORY", gate: "regEnrollment" },
  // INFORMATION MÉDICALE — décision de la Direction (09/2026) : elle passe de Sales & Marketing
  // au pôle REGULATORY. Une déclaration d'information médicale est un acte réglementaire, pas
  // un acte de promotion, et la ranger sous la force de vente laissait entendre le contraire.
  //
  // SEUL LE PÔLE CHANGE, PAS LES DROITS. `pole` ne sert qu'à `groupIntoPoles` — le regroupement
  // du menu — et rien du contrôle d'accès ne le lit : la garde reste le MODULE `MEDICAL_INFO`,
  // avec exactement les mêmes titulaires qu'hier. Déplacer une entrée de menu ne doit jamais
  // ouvrir ni fermer un écran à quiconque, et c'est vérifié (`navigation.test.ts`).
  { module: "MEDICAL_INFO", label: "Information médicale", href: "/information-medicale", icon: "ShieldPlus", group: "Pôles", pole: "REGULATORY" },
  // PHARMACOVIGILANCE (Direction, 06/10) — la boîte de réception des cas signalés par les KAM. GARDE
  // `pharmacovigilance` : l'entrée ne s'affiche qu'à qui reçoit les cas (portée TOUT) ; le KAM, qui ne lit que ses
  // signalements, les retrouve dans les Rapports terrain — il n'a rien à faire dans le pôle Regulatory.
  { module: "PHARMACOVIGILANCE", label: "Pharmacovigilance", href: "/regulatory/pharmacovigilance", icon: "ShieldAlert", group: "Pôles", pole: "REGULATORY", gate: "pharmacovigilance" },
  // BUDGET REGULATORY (Direction, 08/10) — les BV 25 % / 75 % des dossiers et les frais réglementaires.
  { module: "BUDGET_REGULATORY", label: "Budget Regulatory", href: "/budget-regulatory", icon: "PiggyBank", group: "Pôles", pole: "REGULATORY", tabs: BUDGET_REGULATORY_TABS, match: ["/budget-regulatory"] },

  // ADMINISTRATION — l'administration de L'ENTREPRISE (à ne pas confondre avec la Console
  // d'Administration, qui est celle du logiciel et vit dans « Système »).
  // MOYENS GÉNÉRAUX — L'ENTRÉE SUIT LE MODULE, comme partout ailleurs.
  //
  // Elle était portée par WORKSPACE — que tout le monde a — du temps où la page servait aussi à
  // DEMANDER un achat : le module retenu ouvrait le catalogue à tous, et le budget restait gardé
  // à l'intérieur. Les demandes d'achat ont déménagé dans « Mon espace », et la page refuse
  // désormais l'entrée à qui n'a pas `GENERAL_MEANS` : l'entrée de menu promettait donc un écran
  // qui répond « ce n'est pas pour vous ».
  //
  // Pire, cela faisait mentir la console : un administrateur BLOQUE les Moyens généraux à
  // quelqu'un, et la personne continue de voir l'entrée dans son menu. Elle en conclut que le
  // blocage n'a pas pris — c'est le défaut rapporté sur deux comptes.
  //
  // L'entrée porte donc le MÊME module que sa page. Un droit qui ne se lit pas là où on le règle
  // n'est pas administrable, et un menu qui ne dit pas la vérité sur les droits non plus.
  {
    module: "GENERAL_MEANS", label: "Moyens généraux", href: "/moyens-generaux", icon: "ShoppingBasket",
    group: "Pôles", pole: "ADMINISTRATION",
    // L'ANNUAIRE DE L'ENTREPRISE A DÉMÉNAGÉ DANS « MON ESPACE » (onglet à part).
    //
    // C'est un carnet d'adresses, pas un outil de caisse : l'imprimeur, le transitaire et
    // l'agence de voyage sont cherchés par tout le monde, et le ranger derrière un module que
    // la plupart des gens n'ouvrent jamais revenait à le rendre introuvable pour ceux à qui il
    // sert. Les Moyens généraux gardent un lien vers lui — c'est le service qui traite avec eux
    // —, mais l'écran vit désormais où on le cherche.
  },
  // FINANCES — DEUX SOUS-MODULES, DANS LE MENU et nulle part ailleurs.
  //
  // Ils ont d'abord été des onglets DANS la page : deux chemins pour la même chose, et une barre
  // d'onglets qui redisait sous chaque titre ce que le menu montrait déjà à gauche. Le menu suffit
  // — on déplie la flèche et l'on arrive directement là où l'on va travailler.
  //
  // LE « DASHBOARD » A DISPARU (2026-09). Il ne portait aucun geste : on y regardait la
  // trésorerie, puis on allait travailler ailleurs — un écran d'escale entre le menu et le vrai
  // écran. Le solde de la banque a rejoint « Banque & paiements », là où l'on décide ce qu'on
  // paie ; le cockpit du DAF a rejoint la Comptabilité, là où il devient des écritures.
  //
  // L'ENTRÉE PARENTE MÈNE DONC À « Banque & paiements » : cliquer « Finances » ne doit pas
  // conduire à une page d'accueil vide qu'il faut quitter aussitôt. `/finances` reste dans le
  // `match` — l'adresse survit par une redirection, et le menu ne doit pas se désélectionner
  // pour ceux qui arrivent par un lien ou un favori.
  {
    module: "FINANCES", label: "Finances", href: "/finances/paiements-a-faire", icon: "Landmark", group: "Pôles", pole: "ADMINISTRATION",
    match: ["/finances", "/finances/comptabilite", "/finances/doublons-factures"],
    children: [
      { module: "FINANCES", label: "Banque & paiements", href: "/finances/paiements-a-faire", icon: "Banknote", group: "Pôles", pole: "ADMINISTRATION" },
      { module: "FINANCES", label: "Comptabilité", href: "/finances/comptabilite", icon: "BookOpen", group: "Pôles", pole: "ADMINISTRATION" },
      // LE RECENSEMENT DES DOUBLONS DE FACTURES (Direction, 14/10/2026) — lecture seule, droit Finances VIEW.
      { module: "FINANCES", label: "Doublons de factures", href: "/finances/doublons-factures", icon: "Copy", group: "Pôles", pole: "ADMINISTRATION" },
    ],
  },
  // LES BONS DE COMMANDE — un module À PART (décision de la Direction, 01/10/2026, §118.176).
  //
  // C'était le troisième sous-module des Finances (§118.149) : « les bons de commande à signer de
  // leur part. Si un BC se retrouve là-bas, c'est qu'il doit être signé. » La file n'a pas changé ;
  // sa PORTE, si : « le module bon de commande doit être à part et le super admin donne les accès à
  // qui il veut ». Rangé sous les Finances, il s'ouvrait à quiconque lisait les Finances, et l'on ne
  // pouvait ni le donner à quelqu'un qui ne les a pas, ni le retirer à quelqu'un qui les a.
  { module: "PURCHASE_ORDERS", label: "Bons de commande", href: CHEMIN_BONS_DE_COMMANDE, icon: "FilePen", group: "Pôles", pole: "ADMINISTRATION" },
  // LE CENTRE DE PAIEMENT — un module À PART, HORS Finances : celui qui autorise l'argent ne
  // doit pas être dans l'écran de celui qui le décaisse. L'entrée n'apparaît qu'à qui a le
  // module (PDG + Super Admin) ; un demandeur à qui le centre rend la main y arrive par le LIEN
  // de sa notification — pas par le menu.
  { module: "PAYMENT_CENTRE", label: "Centre de paiement", href: "/centre-de-paiement", icon: "ShieldCheck", group: "Pôles", pole: "ADMINISTRATION" },
  // LE CENTRE DE VALIDATIONS — le pendant du précédent, côté DÉCISIONS, pour le Directeur
  // Général et le Super Admin. Un écran qui ne contient QUE ce qu'on attend d'eux, tous modules
  // confondus : dans l'écran commun des validations, ces demandes se noyaient entre leurs
  // propres dossiers et les blocs de suivi, et l'on découvrait une signature attendue depuis six
  // jours en cherchant autre chose.
  { module: "VALIDATION_CENTRE", label: "Centre de validations", href: "/centre-de-validations", icon: "Gavel", group: "Pôles", pole: "ADMINISTRATION" },
  // LE CENTRE DE VALIDATION AD & PRO — le TROISIÈME centre (décision de la Direction, 09/2026).
  // Toute demande Ad & Pro dont le budget total dépasse le seuil s'y arrête, et le SEUIL se
  // règle depuis cet écran. Il siège avec les deux autres centres et non dans Ad & Pro : celui
  // qui arbitre une dépense de 1,2 M ne doit pas être dans l'écran de celui qui la demande.
  { module: "AD_PRO_CENTRE", label: "Centre de validation Ad & Pro", href: "/centre-ad-pro", icon: "Scale", group: "Pôles", pole: "ADMINISTRATION" },
  // LES DEMANDES DE PAIEMENT n'ont PLUS d'entrée de menu : la demande se fait depuis les
  // Demandes de validations (bouton « Demande de paiement »), et une fois le bon à payer donné,
  // le dossier passe par le centre de paiement puis atterrit dans les Règlements à effectuer.
  // Les écrans /validations/paiements restent servis — on y arrive par le bouton et les liens.
  // LA PAIE EST UN SOUS-MODULE DES RH, pas un onglet de plus. Elle n'a pas la même
  // audience que le reste du module : les congés, l'équipe et les départements se lisent
  // largement, la paie ne s'ouvre qu'à qui TIENT les RH (`gate: "payroll"` = droit de mise à
  // jour). Un onglet l'aurait affichée à tout le monde pour la refuser au clic ; en enfant,
  // elle se déplie par la flèche — sur ordinateur comme sur mobile — et n'apparaît qu'à ceux
  // qui peuvent l'ouvrir. Elle reste servie par sa propre route, gardée par sa propre page.
  {
    // UN GROUPE (Direction, 06/10) : « RH » garde le tableau de bord des RH, la paie et les avances ; Employés, Demandes RH
    // et Formations sont des modules à part. L'entrée s'ouvre dès qu'UN de ses sous-modules est ouvert.
    module: "RH", label: "Ressources humaines", href: "/rh", icon: "UsersRound", group: "Pôles",
    pole: "ADMINISTRATION", groupe: true,
    children: [
      { module: "EMPLOYEES", label: "Employés", href: "/rh/equipe", icon: "Users", group: "Pôles", pole: "ADMINISTRATION", match: ["/rh/consultants", "/rh/departements"] },
      { module: "HR_REQUESTS", label: "Demandes RH", href: "/rh/demandes", icon: "Inbox", group: "Pôles", pole: "ADMINISTRATION", match: ["/rh/conges"] },
      // RECRUTEMENT — un module à part sous les RH (Direction, 07/10) : n'importe qui y demande un poste, la chaîne
      // remonte jusqu'au DG, puis les RH publient et diffusent. Ses accès se règlent dans la console, comme les autres.
      { module: "RECRUITMENT", label: "Recrutement", href: "/recrutement", icon: "UserPlus", group: "Pôles", pole: "ADMINISTRATION", match: ["/recrutement"] },
      { module: "TRAINING", label: "Formations", href: "/formations", icon: "GraduationCap", group: "Pôles", pole: "ADMINISTRATION" },
      { module: "RH", label: "Paie", href: "/rh/paie", icon: "Banknote", group: "Pôles", pole: "ADMINISTRATION", gate: "payroll" },
    ],
  },
  // LEGAL — les engagements de la société : contrats, bons de commande, assurances, baux. Le
  // fichier reste dans le Drive ; Legal porte ce que le Drive ne sait pas dire (dates, échéance,
  // partie en face) et rappelle avant l'échéance.
  {
    module: "LEGAL", label: "Legal", href: "/legal", icon: "Scale", group: "Pôles", pole: "ADMINISTRATION",
    // Les COORDONNÉES LÉGALES & FISCALES de chaque entité vivent sous Legal : ce sont les
    // numéros par lesquels la société s'engage, et on les cherche là où l'on range ses engagements.
    //
    // LES FACTURES N'ONT PAS D'ENTRÉE, et c'est le sujet. Elles ne sont pas un endroit : ce sont
    // des documents légaux de NATURE « facture », dans la même liste que les devis et les bons
    // de commande dont elles découlent. `/legal?nature=INVOICE` en est une VUE — un filtre de
    // colonne prérempli, retirable d'un clic. Lui donner un onglet recréerait, sous un autre
    // nom, l'écran séparé qu'on vient de fermer.
    children: [
      { module: "LEGAL", label: "Coordonnées des entités", href: "/legal/identites", icon: "IdCard", group: "Pôles", pole: "ADMINISTRATION" },
    ],
  },
  // COURRIERS — le carnet entrant/sortant de l'assistante de direction.
  { module: "MAIL_REGISTER", label: "Courriers", href: "/courriers", icon: "Mails", group: "Pôles", pole: "ADMINISTRATION" },
  // ANNUAIRES — tous les annuaires de l'entreprise en un seul sous-module (décision de la
  // Direction, 09/2026). L'entrée est visible dès qu'UN onglet l'est, et mène au premier
  // onglet autorisé : chaque onglet porte le module de son référentiel.
  {
    module: "DIRECTORIES", label: "Annuaires", href: "/annuaires", icon: "BookUser", group: "Pôles",
    pole: "ADMINISTRATION", tabs: ANNUAIRES_TABS, match: ["/annuaires"],
  },
  // MON ÉQUIPE — l'écran de celui qui ENCADRE. Une entrée simple : le RECRUTEMENT en est sorti pour devenir un
  // module à part sous « Ressources humaines » (Direction, 07/10) — n'importe qui peut demander un poste, pas
  // seulement l'encadrant.
  { module: "MY_TEAM", label: "Mon Équipe", href: "/mon-equipe", icon: "Users", group: "Pilotage", gate: "myTeam" },
  { module: "BUDGETS", label: "Budgets", href: "/budgets", icon: "Wallet", group: "Pôles", pole: "ADMINISTRATION", tabs: BUDGET_TABS, match: ["/budgets/depenses", "/budgets/departements", "/budgets/business-units", "/budgets/reglages"] },
  // LA CAMPAGNE BUDGÉTAIRE (Budgets 2027, Direction 10/2026) — chaque pôle prépare, le comité valide, les enveloppes de
  // l'année s'ouvrent d'elles-mêmes. Un responsable de département y entre par l'organigramme (accès implicite).
  { module: "BUDGET_CAMPAIGN", label: "Campagne budgétaire", href: "/budget-campagne", icon: "PiggyBank", group: "Pôles", pole: "ADMINISTRATION", match: ["/budget-campagne"] },

  // MARKETING — séparé de « Operations & Sales » (Direction, 08/10 : « sépare Marketing et Sales »). Ce que la
  // Direction Marketing tient : son cockpit, la segmentation, les produits, Ad & Pro, le stock promotionnel et le site
  // public (« le module du site web passe également au département marketing »). Les droits ne bougent pas : seul le
  // rangement du menu change.
  // MARKETING COCKPIT — le tableau de la Direction Marketing (07/10) : une page, ses vues par `?vue=` (barre rendue par la
  // page, `MARKETING_COCKPIT_TABS`) — d'où l'absence de `tabs` ici.
  { module: "MARKETING_COCKPIT", label: "Marketing cockpit", href: "/marketing-cockpit", icon: "Megaphone", group: "Pôles", pole: "MARKETING", match: ["/marketing-cockpit"] },
  // SEGMENTATION STUDIO — la segmentation native : stratégie par BU, règles versionnées, panel calculé et expliqué.
  { module: "SEGMENTATION", label: "Segmentation", href: "/segmentation", icon: "Layers", group: "Pôles", pole: "MARKETING", match: ["/segmentation"] },
  // PRODUITS — chaque produit canonique et sa vue 360° (réglementaire, AO, ventes, segmentation, consommation, coûts).
  // Un MODULE À PART (Direction, 06/10) : ses accès se règlent dans la console, comme les autres.
  { module: "PRODUCTS", label: "Produits 360", href: "/produits", icon: "Pill", group: "Pôles", pole: "MARKETING", match: ["/produits"] },
  // « RAPPORTS TERRAIN » N'EST PLUS UNE ENTRÉE (Direction, 07/10) : c'est l'onglet « Rapports » de la Promotion médicale
  // (`MEDICAL_TABS`, module `FIELD_REPORTS`). `/field-reports` redirige ; l'entrée médicale le couvre par `match`.
  { module: "SPONSORING", label: "Ad & Pro", href: "/ad-pro", icon: "PartyPopper", group: "Pôles", pole: "MARKETING", tabs: EVENTS_TABS, match: ["/sponsoring", "/promo-material", "/consulting"] },
  // BUDGET MARKETING (Direction, 08/10) — les enveloppes Ad & Pro et celles de la Direction Marketing. Les mêmes lignes
  // que Budgets (pôle Administration), qui les montre en lecture seule.
  { module: "BUDGET_MARKETING", label: "Budget Marketing", href: "/budget-marketing", icon: "PiggyBank", group: "Pôles", pole: "MARKETING", tabs: BUDGET_MARKETING_TABS, match: ["/budget-marketing"] },
  // LE STOCK PROMOTIONNEL — son propre sous-module (§118.173), et plus un onglet d'Ad & Pro.
  { module: "PROMO_STOCK", label: "Stock promotionnel", href: CHEMIN_STOCK_PROMO, icon: "Warehouse", group: "Pôles", pole: "MARKETING", tabs: STOCK_PROMO_TABS, match: [CHEMIN_STOCK_PROMO] },
  // LE SITE PUBLIC (§118.158) — l'ERP y publie les offres d'emploi et les articles de blog. Rangé sous Marketing
  // (Direction, 08/10) ; ses accès restent les siens (module `SITE_WEB`, onglets `SITE_WEB_TABS`).
  { module: "SITE_WEB", label: "Site web", href: "/site-web", icon: "Globe", group: "Pôles", pole: "MARKETING", tabs: SITE_WEB_TABS, match: ["/site-web"] },

  // OPERATIONS & SALES — le terrain et le business réalisé (Direction, 08/10) : la promotion médicale, le montage des
  // BU, la force de vente, les marchés PCH — puis les ventes et la consommation, qui étaient dans le même pôle. L'annuaire
  // des praticiens vit DANS Promotion médicale : on ne consulte pas un annuaire pour lui-même, on le consulte en
  // préparant une visite.
  // PROMOTION MÉDICALE — deux onglets, et l'ordre compte : « Ma journée » d'abord, parce que
  // c'est l'écran quotidien du terrain (sa tournée, sa saisie de visite en trois gestes) ;
  // l'annuaire ensuite, qui est le référentiel. L'ancien « Visites & segmentation » retiré est
  // remplacé par cette journée — les visites en base n'ont jamais bougé, et elle les relit.
  // COCKPIT OPÉRATIONS — la PREMIÈRE entrée du pôle (Direction, 08/10) : l'écran de tête du directeur des opérations.
  { module: "COCKPIT_OPERATIONS", label: "Cockpit Opérations", href: "/operations", icon: "Gauge", group: "Pôles", pole: "OPERATIONS_SALES", match: ["/operations"] },
  { module: "MEDICAL", label: "Promotion médicale", href: "/medical/ma-journee", icon: "Stethoscope", group: "Pôles", pole: "OPERATIONS_SALES", tabs: MEDICAL_TABS, match: ["/medical", "/field-reports"] },
  { module: "SALES_PLANNING", label: "Force de vente", href: "/planning", icon: "Target", group: "Pôles", pole: "OPERATIONS_SALES", tabs: SALES_PLANNING_TABS, match: ["/planning"] },
  // BUSINESS UNITS — le montage de la force de vente, sorti du « ⋯ Réglages » de la Force de vente (Direction, 08/10) :
  // les BU et leurs quatre étapes, les secteurs, les paramètres. Son propre module (`BUSINESS_UNITS`).
  { module: "BUSINESS_UNITS", label: "Business Units", href: "/business-units", icon: "Building2", group: "Pôles", pole: "OPERATIONS_SALES", tabs: BUSINESS_UNITS_TABS },
  { module: "PCH", label: "Marchés PCH", href: "/pch", icon: "Gavel", group: "Pôles", pole: "OPERATIONS_SALES" },
  // VENTES PCH — remplace « Ventes » (saisie manuelle, `SALES` retiré du service) : les fichiers de la PCH, lus par BU.
  // L'historique de l'ancienne saisie reste lisible, en lecture seule, dans son onglet.
  { module: "PCH_VENTES", label: "Ventes PCH", href: "/sales", icon: "TrendingUp", group: "Pôles", pole: "OPERATIONS_SALES", tabs: VENTES_PCH_TABS, match: ["/sales"] },
  // LA CHAÎNE PHYSIQUE REJOINT LE PÔLE (Direction, 08/10 : « Stocks et Logistique rejoignent Operations & Sales ») — le
  // pôle « Supply Chain & Logistics » disparaît. Stocks : la chaîne Adventum + PCH central + hôpitaux, par BU.
  // Logistique : son module reste RETIRÉ du service (`modules-retired.ts`) — l'entrée est rangée ici, et ne s'affiche
  // pour personne tant que le retrait n'est pas levé.
  { module: "STOCKS", label: "Stocks", href: "/stocks", icon: "Boxes", group: "Pôles", pole: "OPERATIONS_SALES" },
  { module: "LOGISTICS", label: "Logistique", href: "/logistics", icon: "Truck", group: "Pôles", pole: "OPERATIONS_SALES" },
  // CONSUMPTION INTELLIGENCE n'a PLUS d'entrée de menu (Direction, 08/10 : « supprime ce module Consommation ou masque-le
  // de ma vue »). Seule l'ENTRÉE part : les écrans `/consommation`, leurs données et le module `CONSUMPTION` restent — ils
  // nourrissent l'affinité de la segmentation et la fiche Produits 360, qui y mènent encore par leurs liens.
  // BUDGET OPERATIONS & SALES (Direction, 08/10) — la masse salariale de la force de vente et les dépenses hors Ad & Pro.
  { module: "BUDGET_OPERATIONS", label: "Budget Operations & Sales", href: "/budget-operations", icon: "PiggyBank", group: "Pôles", pole: "OPERATIONS_SALES", tabs: BUDGET_OPERATIONS_TABS, match: ["/budget-operations"] },

  // BUSINESS DEVELOPMENT — l'AVANT-VENTE : ce qu'on étudie et ce qu'on vise. Les ventes
  // réalisées sont passées dans Operations & Sales (avec les marchés PCH, 08/10) : analyser une opportunité et constater un
  // chiffre d'affaires ne sont pas le même métier.
  // BUSINESS DEVELOPMENT — « Projets » est un SOUS-MODULE, pas un onglet : c'est son propre
  // écran, avec sa propre question. Le tableau stratégique demande « où en est ce projet ? » ;
  // « Projets » demande « qu'est-ce que ce projet contient, dossier par dossier ? ». Le
  // classement se pose dans Regulatory, il se LIT ici.
  // MARKET INTELLIGENCE est RETIRÉ du service (2026-09) ; « Projets » a été redemandé et lui
  // survit seul. L'entrée n'est donc plus un parent avec un enfant — le parent ouvrirait une
  // adresse qui ne s'ouvre plus.
  // « PROJETS » EST SON PROPRE MODULE, `BD_PROJECTS` (§118.163). Il survivait au retrait par un
  // chemin « maintenu » et une garde déduite de Regulatory, que personne ne pouvait régler :
  // l'entrée s'affiche désormais comme toutes les autres, parce que la personne a le module, et
  // le Super Admin l'ouvre ou la ferme dans Administration › Accès.
  { module: "BD_PROJECTS", label: "Projets", href: "/business-development/projets", icon: "FolderKanban", group: "Pôles", pole: "BUSINESS_DEV" },
  // L'EXPLORATEUR PRODUITS — module à part, et non plus une sous-page d'Intelligence marché.
  // On ne l'ouvre pas « en analysant le marché » : on l'ouvre parce qu'on cherche UN produit,
  // UNE molécule, UN laboratoire. C'était le geste le plus fréquent du pôle, et il fallait deux
  // clics et connaître le chemin pour y arriver.
  { module: "PRODUCT_EXPLORER", label: "Explorateur produits", href: "/explorateur-produits", icon: "PackageSearch", group: "Pôles", pole: "BUSINESS_DEV", match: ["/business-development/marche/produits"] },

  // Transverse — « Demandes de validations » est le bureau de validation : chacun
  // y demande une validation professionnelle (selon l'accès accordé par le Super
  // Admin), et les validateurs y traitent ce qui leur revient. Les validations en
  // attente restent aussi visibles dans « Mon espace » (Action Center).
  { module: "VALIDATIONS", label: "Demandes de validations", href: "/validations", icon: "ShieldCheck", group: "Transverse" },
  { module: "DRIVE", label: "Drive", href: "/drive", icon: "FolderOpen", group: "Transverse", tabs: DOCS_TABS },
  // BUREAUTIQUE N'A PLUS D'ENTRÉE : créer un document Word/Excel/PowerPoint est le bouton
  // « Nouveau document » du Drive, et la papeterie de la société est dans son menu « ⋯ ».
  // Un second écran pour les mêmes fichiers finissait par en donner une seconde liste.
  { module: "ADMIN_REQUESTS", label: "Bureau du secrétariat", href: "/demandes", icon: "ClipboardList", group: "Transverse" },
  // DIRECTION ARTISTIQUE (10/2026) — la papeterie de chaque entité (en-têtes, modèles de pièces, PowerPoint, Excel, logo
  // et charte), tenue par l'assistante de direction. La fabrique y lit le modèle d'un bon de commande.
  { module: "ART_DIRECTION", label: "Direction artistique", href: "/direction-artistique", icon: "Palette", group: "Transverse" },
  // FEEDBACK — module à part, donc réglable : accès par rôle ou par personne, et masquable
  // depuis la console d'administration comme n'importe quel autre. Rattaché à « espace de
  // travail », il était ouvert à tous sans qu'on puisse ni le fermer ni le retirer.
  { module: "FEEDBACK", label: "Feedback", href: "/feedback", icon: "MessageSquarePlus", group: "Transverse" },
  // Système
  { module: "ADVENTUM_BRAIN", label: "Adventum Brain", href: "/adventum-brain", icon: "BrainCircuit", group: "Système", tabs: BRAIN_TABS },
  // « Console d'Administration » et non « Administration » : l'administration de
  // L'ENTREPRISE est un pôle métier (Moyens généraux / Finances / RH / Budgets). Les
  // confondre, c'est envoyer un directeur financier dans les réglages techniques.
  { module: "ADMIN", label: "Console d'Administration", href: "/admin", icon: "Settings", group: "Système", tabs: ADMIN_TABS },
  // LA CORBEILLE DE SES MODULES — le directeur des opérations y récupère ce qui a été supprimé chez lui (06/10).
  // Le module WORKSPACE est à tout le monde : c'est la garde `corbeilleOps` qui ouvre l'entrée.
  { module: "WORKSPACE", label: "Corbeille", href: "/corbeille", icon: "Trash2", group: "Système", gate: "corbeilleOps" },
];

/**
 * Première destination de navigation que `canView` autorise — pour un atterrissage
 * **sûr** après un refus (jamais une page qui refuserait à nouveau → anti-boucle
 * `ERR_TOO_MANY_REDIRECTS`). On ignore les **sous-pages d'admin** (`/admin/…`),
 * gardées par un contrôle plus strict que VIEW ; « /admin » (VIEW) reste valide.
 * Renvoie `null` si l'utilisateur ne peut voir aucune destination.
 */
/**
 * Module « propriétaire » d'un chemin — pour router une notification (via son lien) vers l'entrée
 * de menu concernée et y poser un badge. Renvoie le module de l'entrée (ou d'un onglet) dont le
 * href/match est le plus long préfixe du chemin ; `null` si aucune ne correspond.
 */
/**
 * LIBELLÉS HISTORIQUES → module.
 *
 * `ValidationRequest.module` stocke le LIBELLÉ tel qu'il était au moment de la demande. Renommer
 * une entrée de menu casserait donc l'accès temporaire d'un validateur sur toute demande créée
 * avant le renommage — il ouvrirait une page vide sans comprendre pourquoi.
 *
 * Cette table conserve les anciens noms. On n'en retire JAMAIS une ligne : les demandes
 * historiques, elles, ne se renomment pas.
 */
export const NAV_LEGACY_LABELS: Record<string, Module> = {
  "Regulatory": "REGULATORY",
  "Ventes & Marchés": "SALES",
  "Logistique": "LOGISTICS",
  "PCH — Marchés": "PCH",
  "Prévisions & Force de vente": "SALES_PLANNING",
  "Business Development": "BUSINESS_DEVELOPMENT",
  "Explorateur produits": "PRODUCT_EXPLORER",
  "Administration": "ADMIN",
};

export function moduleForPath(path: string): Module | null {
  let bestLen = -1;
  let bestModule: Module | null = null;
  const consider = (href: string, module: Module) => {
    if (href && (path === href || path.startsWith(`${href}/`)) && href.length > bestLen) {
      bestLen = href.length;
      bestModule = module;
    }
  };
  for (const n of NAVIGATION) {
    if (n.tabs) for (const t of n.tabs) consider(t.href, t.module);
    consider(n.href, n.module);
    for (const m of n.match ?? []) consider(m, n.module);
  }
  return bestModule;
}

export function firstAccessibleHref(canView: (module: Module) => boolean): string | null {
  for (const n of NAVIGATION) {
    if (n.href.startsWith("/admin/")) continue;
    if (n.tabs) {
      const t = n.tabs.find((tab) => canView(tab.module));
      if (t) return t.href;
    } else if (canView(n.module)) {
      return n.href;
    }
  }
  return null;
}
