import { cache } from "react";
import type { AccessScope, EntityType, Prisma, UserAccess, UserRole } from "@prisma/client";
import { prisma } from "./prisma";
import { isRetiredModule } from "./modules-retired";
import { activeStandInsFor } from "./hr/stand-in-resolve";
import { getAppSettings } from "./settings"; // settings n'importe que prisma → aucun cycle
import { pipelineAccessFor } from "./regulatory/pipeline-access";
import { carrierAccess } from "./regulatory/assignment";
import { NAVIGATION, NAV_LEGACY_LABELS } from "./labels"; // labels n'importe de rbac QUE le type `Module` → aucun cycle runtime
import { lireSections, peutAnnuaire as regleAnnuaire, ouvertParSection, type AnnuaireAccordable, type FaitsAnnuaire, type GesteAnnuaire } from "./annuaires/acces"; // module PUR, zéro import → aucun cycle
import { DOMAINES, poleDe, type DomainePole } from "./budget/domaines"; // module PUR, zéro import → aucun cycle

// `cache` is a React Server Components API; fall back to identity outside an
// RSC render (e.g. unit tests) so the module loads everywhere.
const perRequest: <T extends (...args: never[]) => unknown>(fn: T) => T =
  typeof cache === "function" ? (cache as never) : (fn) => fn;

/**
 * Access control for AMD Internal OS — two layers, both enforced server-side:
 *
 *  1. Role defaults (PERMISSIONS) provide a baseline.
 *  2. Per-user overrides (UserAccess) + per-row grants (RowGrant), fully managed
 *     by an admin, take precedence. `getAccess` resolves the *effective* access
 *     for a user (cached per request); `userCan` and the `scope*` helpers read
 *     that resolved access so the UI and the database queries always reflect
 *     exactly what the admin granted.
 */

export const MODULES = [
  "WORKSPACE", "FEEDBACK", "MESSAGING", "REGULATORY",
  // REGULATORY_PIPELINE : « Pipeline réglementaire » — les dossiers VERROUILLÉS (à l'étude), un module À PART du
  // suivi des dossiers (Direction, 08/10 : « sépare Pipeline et Suivi de dossiers dans les accès … pour que je
  // contrôle »). Rangé juste après Regulatory pour que la console les montre côte à côte. Il gouverne l'écran
  // /regulatory/pipeline ET les dossiers verrouillés partout (portée, fiche, gestes) ; la confidence nommée
  // (« voit le pipeline » / « tient le cadenas », Réglages) reste une SECONDE clé, indépendante (`seesLockedRegulatory`).
  // Par défaut, chaque rôle y a exactement ses gestes de Regulatory : personne ne perd le pipeline le jour de la scission.
  "REGULATORY_PIPELINE",
  "SPONSORING", "BUDGETS", "FINANCES", "RH",
  "CONGRESS_INTERNATIONAL", "CONGRESS_NATIONAL", "EVENTS", "SALES", "LOGISTICS", "MEDICAL", "FIELD_REPORTS", "SALES_PLANNING",
  "BUSINESS_DEVELOPMENT", "PRODUCT_EXPLORER", "PCH", "STOCKS", "MEDICAL_INFO", "PROMO_MATERIAL", "CONSULTING", "AD_PRO_OTHER", "GENERAL_MEANS", "VALIDATIONS", "VALIDATION_CENTRE", "DIRECTIVES", "SUPPORT", "DOSSIERS", "DOCUMENTS", "DRIVE", "ADMIN_REQUESTS", "NOTIFICATIONS",
  // LEGAL : les engagements de la société (contrats, bons de commande, assurances).
  // MAIL_REGISTER : le carnet de courriers entrants/sortants de l'assistante de direction —
  // module à part, dont le Super Admin ouvre l'accès à qui il veut.
  // RECRUITMENT : les demandes de recrutement, de la demande d'un directeur à l'intégration.
  // Module À PART de RH, et pas un écran de plus dedans : le DEMANDEUR est un directeur
  // opérationnel qui n'a rien à faire dans la paie ni dans les dossiers du personnel.
  "LEGAL", "MAIL_REGISTER", "RECRUITMENT", "MY_TEAM",
  // DIRECTORIES : « Annuaires » — le sous-module du pôle Administration qui CENTRALISE tous les
  // annuaires de l'entreprise (médecins, pharmaciens, établissements, partenaires, personnes,
  // autres). C'est une PORTE, accordée à tout le monde comme MY_TEAM : chaque onglet reste gardé
  // par le droit du référentiel qu'il montre (MEDICAL pour les praticiens et les hôpitaux,
  // WORKSPACE pour les partenaires et les personnes). Une seconde matrice de droits par annuaire
  // aurait divergé de la première au premier réglage (§118.5).
  "DIRECTORIES",
  // PAYMENT_CENTRE : le centre d'autorisation des paiements — un module À PART, hors Finances.
  // Il n'appartient qu'au PDG et au Super Admin : celui qui autorise l'argent ne doit pas être
  // dans le même écran que celui qui le décaisse, sinon la séparation des rôles n'est qu'un onglet.
  "PAYMENT_CENTRE",
  // VALIDATION_CENTRE : le pendant du centre de paiement, côté DÉCISIONS. Il n'appartient qu'au
  // DIRECTEUR GÉNÉRAL et au Super Admin — pas au PDG, dont le centre est celui de l'argent :
  // donner les deux à la même personne referait l'écran fourre-tout qu'on vient de découper.
  "VALIDATION_CENTRE",
  // AD_PRO_CENTRE : le TROISIÈME centre — l'arbitrage des dépenses de promotion au-dessus du
  // seuil, et le RÉGLAGE de ce seuil. Directeur Général + Super Admin (`siegeAuCentreAdPro`).
  // Un module à part et non un onglet d'Ad & Pro : celui qui arbitre une dépense de 1,2 M ne
  // doit pas être dans le même écran que celui qui la demande, sinon la séparation des rôles
  // n'est qu'un onglet — le raisonnement du centre de paiement, mot pour mot.
  "AD_PRO_CENTRE",
  // CHIEF_OF_STAFF : « My Chief of Staff » — l'interface exécutive de pilotage (PDG + Super
  // Admin). Le même moteur que l'assistant, mais avec les outils de chef de cabinet : histoire
  // complète d'un dossier, lecture des documents du Drive, bilan d'une personne, rappels
  // planifiés, décisions du centre de paiement.
  "CHIEF_OF_STAFF",
  // ASSISTANT_IA : l'« Assistant IA » (/assistant, Mastra + MiMo) — PAS Adam. Fermé à tous par
  // défaut ; le Super Admin l'a (tous les modules), et l'OUVRE à une personne dans Administration ›
  // Accès comme n'importe quel module. Ouvert, il travaille avec les droits de CETTE personne : ses
  // outils sont filtrés par son RBAC et s'exécutent en son nom (`lib/agent/outils-v1.ts`).
  "ASSISTANT_IA",
  "PROCESS_INTELLIGENCE", "ADVENTUM_BRAIN", "ADMIN",
  // SITE_WEB : le site public adventumdz.com — les articles de blog que l'ERP y publie, et l'état
  // de la publication (file d'envoi, journal, réconciliation). Les OFFRES D'EMPLOI, elles, se
  // publient par les RH (droit `RH` en écriture) : ce sont des recrutements, pas de la
  // communication (§118.158).
  "SITE_WEB",
  // BD_PROJECTS : « Projets (BD) » — le registre des projets par lesquels on classe les dossiers
  // réglementaires. Un module À PART (§118.163), et non plus une porte déduite de Regulatory à
  // côté d'un module retiré : le Super Admin l'ouvre, le ferme et en règle les gestes personne par
  // personne dans Administration › Accès, comme n'importe quel module. Market Intelligence
  // (`BUSINESS_DEVELOPMENT`) reste retiré : ce module-ci ne le rouvre pas.
  "BD_PROJECTS",
  // PROMO_STOCK : le STOCK du matériel promotionnel (§118.164) — le magasin central, ce que chaque
  // délégué a en main, ce qui est en route. Un module À PART du circuit d'achat (`PROMO_MATERIAL`) :
  // le directeur des opérations y a la vue globale et la gestion de ses équipes sans avoir à
  // instruire les achats, et un délégué y tient son stock sans voir les dossiers des autres.
  // La PORTÉE réglée dans la console fait la vue globale (TOUT) ou la vue « moi et mon équipe ».
  "PROMO_STOCK",
  // PROMO_CATALOG : le CATALOGUE du matériel promotionnel — les références fixes CAT-0001… que
  // citent les demandes et les stocks. « Le super administrateur a un catalogue ; il peut l'ouvrir
  // en édition ou en lecture à qui il veut dans la société » : par défaut au seul Super Admin, il
  // s'ouvre personne par personne dans Administration › Accès (Voir = lecture, Créer/Modifier =
  // édition). Choisir un article dans une demande ne demande pas ce module : c'est une liste de
  // référence, comme celle des produits.
  "PROMO_CATALOG",
  // PURCHASE_ORDERS : « Bons de commande » — la file des bons de commande à SIGNER (§118.149),
  // devenue un module À PART des Finances (décision de la Direction, 01/10/2026 : « le module bon
  // de commande doit être à part et le super admin donne les accès à qui il veut », §118.176).
  // « Voir » ouvre la file et la lecture des bons de commande (fiche, fichiers émis) ; « Modifier »
  // est le droit de SIGNER — c'est la case que le Super Admin coche dans Administration › Accès.
  // Composer un bon de commande reste un geste de Legal ou des Finances : il écrit au registre et
  // engage une société, ce module ne l'ouvre pas.
  "PURCHASE_ORDERS",
  // MARKETING_COCKPIT : le cockpit de la Direction Marketing (Sales & Marketing) — vue d'ensemble par produit, leaders
  // d'opinion, MESSAGES que le KAM porte au médecin, marché, investissements (07/10 ; les SPÉCIALITÉS sont parties dans
  // les Annuaires). Un module À PART de la Force de vente (Direction, 06/10 : « fais-en un
  // module à part, avec ses accès gérables depuis la console d'admin ») : le Super Admin l'ouvre ou le ferme, et en
  // règle les gestes, personne par personne dans Administration › Accès.
  "MARKETING_COCKPIT",
  // SEGMENTATION : le SEGMENTATION STUDIO (Direction, 06/10 : « intègre en natif la segmentation… que tout soit relié »)
  // — stratégie par BU, produits classés, règles versionnées, potentiel terrain, dérogations, import d'un classeur.
  // Voir = lire le panel et le pourquoi de chaque segment ; Modifier = renseigner le potentiel et le statut (le terrain) ;
  // Créer = ajouter / retirer un praticien du panel ; Valider = publier une version de règles, importer, gérer la stratégie.
  // La PORTÉE « ses lignes » borne le KAM à son panel (secteur ∪ rattachement, `clausePanelDuKam`).
  "SEGMENTATION",
  // SEGMENTATION_POTENTIEL : FORCER LE POTENTIEL à la main (Direction, 07/10 : « le potentiel doit être manuellement
  // modifiable par ceux à qui je donne en tant que super admin l'autorisation. Évidemment, ils peuvent tout modifier,
  // supprimer, ajouter »). AUCUN rôle ne l'a par défaut : le Super Admin l'accorde personne par personne (case
  // « Modifier »), et qui l'a peut TOUT dans la segmentation — forcer ou rendre une lettre, réponses, statut, panel,
  // secteur, règles, fréquences, publication, import — sur toutes les lignes.
  "SEGMENTATION_POTENTIEL",
  // CONSUMPTION : « Consumption Intelligence » — les fichiers de consommation hospitalière, hétérogènes, rendus
  // fiables (colonnes reconnues, établissements et produits résolus, doublons écartés, revue), et l'affinité par
  // établissement qu'on en tire. Voir = lire ; Téléverser/Modifier = importer et revoir ; Valider = faire compter un
  // import, régler l'affinité d'un produit.
  "CONSUMPTION",
  // PRODUCTS : « Produits » — le référentiel canonique et la vue 360° de chaque produit (Direction, 06/10 : « fais-en un
  // module à part, je n'arrive pas à gérer ses accès depuis la console »). Voir = la liste et la fiche 360° ; chaque
  // section de la fiche reste gardée par SON module (Regulatory, PCH, Ventes, Segmentation, Consommation, Finances).
  "PRODUCTS",
  // BUSINESS_UNITS : « Business Units » — le MONTAGE de la force de vente (Direction, 08/10 : « tu crées dans le menu un
  // module "Business Units" et tu y mets BU et secteurs et paramètres »). Les BU (identité, superviseur, spécialités,
  // produits, KAM), les secteurs et territoires des KAM, les paramètres SFE. Il sort du « ⋯ Réglages » de la Force de
  // vente, qui garde le pilotage, les territoires et les produits (`SALES_PLANNING`). Par défaut : exactement ceux qui
  // configuraient la Force de vente (voir plus bas).
  "BUSINESS_UNITS",
  // BUDGET_MARKETING : « Budget Marketing » (Direction, 08/10) — les enveloppes Ad & Pro et celles que la Direction
  // Marketing crée (`domaine = MARKETING`). Les MÊMES lignes que Budgets, qui les lit en lecture seule : Voir = lire ces
  // enveloppes (sans liste d'accès par enveloppe), Modifier = gérer leur contenu (catégories, lignes, imputation),
  // Créer / Supprimer = créer ou retirer une enveloppe marketing. Les listes d'accès restent au Super Admin.
  "BUDGET_MARKETING",
  // BUDGET_REGULATORY / BUDGET_OPERATIONS : « Budget Regulatory » et « Budget Operations & Sales » (Direction, 08/10) —
  // la même mécanique que Budget Marketing, pour les enveloppes `domaine = REGULATORY` (les BV 25 % / 75 % des dossiers
  // d'enregistrement) et `domaine = OPERATIONS` (masse salariale de la force de vente, dépenses hors Ad & Pro).
  "BUDGET_REGULATORY", "BUDGET_OPERATIONS",
  // LES SOUS-MODULES DES RESSOURCES HUMAINES (Direction, 06/10 : « transformer les onglets de RH en sous-modules
  // indépendants mais reliés ») : EMPLOYEES — « Employés » (l'équipe, les consultants, les départements) ;
  // HR_REQUESTS — « Demandes RH » (attestations, ordres de mission, notes de frais, congés et absences) ;
  // TRAINING — « Formations ». « RH » garde la paie, les avances et le tableau de bord des RH.
  "EMPLOYEES", "HR_REQUESTS", "TRAINING",
  // PHARMACOVIGILANCE (Direction, 06/10) : la réception des cas signalés par les KAM depuis les Rapports terrain.
  // Voir en portée TOUT = la boîte de Regulatory ; en portée « ses lignes » = ses propres signalements et les cas
  // où l'on a été ajouté. Créer = signaler un cas ; Modifier/Valider = instruire (statut, enquête, participants).
  "PHARMACOVIGILANCE",
  // KPI : « KPI & bilans » (Direction, 08/10 — KPI sans code). Voir = son bilan et celui de son arbre ; Créer = déclarer,
  // proposer un KPI, en créer pour son équipe ; Valider = noter un KPI évalué, valider une déclaration, signer une revue.
  // Le PÉRIMÈTRE suit l'organigramme (l'arbre de Mon équipe), jamais le rôle : `src/lib/kpi/droits.ts`.
  "KPI",
  // PCH_VENTES : « Ventes PCH » (Operations & Sales, Direction 08/10) — les fichiers de la PCH (ventes des directions
  // régionales aux hôpitaux, réceptions de la PCH centrale) importés, rattachés, lus par BU : sell-in, distribution aux
  // hôpitaux, demande non servie, part de marché, chaîne AO → BC. Il REMPLACE l'ancien « Ventes » (saisie manuelle), dont
  // l'historique reste lisible sous `SALES`. Voir = lire ; Téléverser = importer un fichier ; Modifier = rattacher
  // (établissement, poste, fournisseur, direction régionale).
  "PCH_VENTES",
  // COCKPIT_OPERATIONS : « Cockpit Opérations » (Operations & Sales, Direction 08/10) — l'écran de tête du directeur des
  // opérations : livré à la PCH, exécution des marchés, demande non servie, ruptures de la chaîne, couverture terrain, et
  // « À traiter ». Lecture seule : chaque geste se fait dans l'écran du module visé. Voir = l'ouvrir.
  "COCKPIT_OPERATIONS",
  // BUDGET_CAMPAIGN : « Budgets 2027 / Campagne budgétaire » (Direction, 10/2026) — chaque pôle prépare sa proposition,
  // les valideurs l'examinent ligne par ligne, on arbitre, on valide, les enveloppes de l'année se créent. Voir (portée
  // TOUT) = la vue de la Direction ; Modifier = piloter la campagne ; le responsable d'un département prépare SON pôle
  // par l'organigramme (accès implicite, portée bornée). Valider = le comité nommé dans la campagne, pas ce droit seul.
  "BUDGET_CAMPAIGN",
  // ART_DIRECTION : « Direction artistique » (Transverse, 10/2026) — la papeterie de CHAQUE entité, tenue par l'assistante
  // de direction : papiers en-tête Word, modèle de bon de commande (et de devis, facture, avoir), modèles PowerPoint et
  // Excel, logo et charte. C'est ICI que la fabrique va chercher le modèle d'une pièce. Voir = lire ; Téléverser =
  // déposer un modèle ; Modifier = choisir le modèle par défaut / par nature, régler la charte ; Supprimer = retirer.
  "ART_DIRECTION",
] as const;
export type Module = (typeof MODULES)[number];

export const ACTIONS = [
  "VIEW", "CREATE", "UPDATE", "DELETE", "VALIDATE", "EXPORT", "UPLOAD",
] as const;
export type Action = (typeof ACTIONS)[number];

const ALL: Action[] = [...ACTIONS];
const READ: Action[] = ["VIEW", "EXPORT"];
const READ_VALIDATE: Action[] = ["VIEW", "EXPORT", "VALIDATE"];
const CONTRIBUTE: Action[] = ["VIEW", "CREATE", "UPDATE", "UPLOAD", "EXPORT"];
const MANAGE: Action[] = ["VIEW", "CREATE", "UPDATE", "DELETE", "VALIDATE", "EXPORT", "UPLOAD"];
/** Le Directeur des opérations dans le circuit Ad & Pro (27/10/2026) : tout MANAGE sauf retirer. */
const AD_PRO_OPERATIONS: Action[] = ["VIEW", "CREATE", "UPDATE", "VALIDATE", "EXPORT", "UPLOAD"];
// Personal workspace ("Mon espace"): every user manages their own tasks &
// self-service leave requests, so this baseline is granted to all roles.
const WORKSPACE_USER: Action[] = ["VIEW", "CREATE", "UPDATE", "EXPORT"];
// Drive d'entreprise : chacun gère ses fichiers / dossiers (upload, versions, partage).
const DRIVE_USER: Action[] = ["VIEW", "CREATE", "UPDATE", "DELETE", "EXPORT", "UPLOAD"];
// Demandes administratives : chacun peut soumettre une demande et y joindre des pièces.
const REQUEST_USER: Action[] = ["VIEW", "CREATE", "UPLOAD", "EXPORT"];
// Validations transversales : chacun voit « Mes validations » et peut demander une validation.
const VALIDATION_USER: Action[] = ["VIEW", "CREATE"];
/**
 * FEEDBACK — dire ce qu'on pense de l'outil, et suivre ce qu'on a dit.
 *
 * C'était un écran du module « espace de travail » : ouvert à tout le monde, et surtout
 * IMPOSSIBLE à régler — ni à fermer à un rôle, ni à retirer de la plateforme, parce qu'on ne
 * masque pas un module dont dépend l'espace personnel. Module à part désormais, donc réglable
 * comme les autres depuis la console d'administration.
 */
const FEEDBACK_USER: Action[] = ["VIEW", "CREATE", "UPLOAD"];
// Messagerie interne : socle de communication de tout employé (écrire, modifier/supprimer
// ses propres messages, joindre des fichiers). L'accès à une conversation reste gouverné
// par l'appartenance ; un admin peut retirer la messagerie à un compte via un override.
const MESSAGING_USER: Action[] = ["VIEW", "CREATE", "UPDATE", "DELETE", "UPLOAD"];
// Directives : tout employé voit celles qui le concernent et peut accuser réception,
// faire évoluer le statut et répondre dans le fil (UPDATE). Seule la Direction en crée.
const DIRECTIVES_USER: Action[] = ["VIEW", "UPDATE"];
// Demandes de support : tout employé peut en soumettre, suivre les siennes et répondre/
// joindre des pièces (directeur médical / Direction Marketing pour ce qui les vise). Le scope
// restreint la visibilité aux demandes émises / reçues / prises en charge.
const SUPPORT_USER: Action[] = ["VIEW", "CREATE", "UPDATE", "UPLOAD"];
// Dossiers de suivi : tout employé peut créer un dossier (déléguer/suivre un sujet),
// le mettre à jour, échanger dans le fil et y joindre des pièces. Le scope limite la
// visibilité aux dossiers créés / dont on est responsable / où l'on participe.
const DOSSIERS_USER: Action[] = ["VIEW", "CREATE", "UPDATE", "UPLOAD"];
// Moyens généraux : celui qui ACHÈTE au quotidien saisit ses dépenses et leurs pièces, tient
// sa caisse d'avance et consulte son budget — il ne l'ALLOUE pas (c'est `BUDGETS`, ailleurs).
const GENERAL_MEANS_USER: Action[] = ["VIEW", "CREATE", "UPDATE", "UPLOAD", "EXPORT"];
/**
 * BONS DE COMMANDE (§118.176) — « Voir » ouvre la file et la lecture des bons de commande,
 * « Modifier » est le droit de SIGNER. Les défauts reproduisent EXACTEMENT le périmètre d'hier,
 * quand la file vivait dans les Finances : qui modifiait les Finances signait (Direction,
 * Directeur Général, Finances & Budget), qui les lisait voyait la file (Directeur des opérations).
 * Personne ne perd l'écran le jour où la règle change de forme (§118.163) ; tout le reste se règle
 * désormais personne par personne dans Administration › Accès — c'est la demande.
 *
 * ÉCRITS, pas dérivés des Finances : un module « à part » qui suivrait les droits des Finances ne
 * serait pas à part — un rôle qui gagnerait demain les Finances gagnerait aussi la signature, sans
 * que personne l'ait décidé (§118.130).
 */
const BC_SIGNATAIRE: Action[] = ["VIEW", "UPDATE"];
const BC_LECTEUR: Action[] = ["VIEW"];

type RoleMatrix = Partial<Record<Module, Action[]>>;

/** Role defaults. A missing module entry means no baseline access. */
export const PERMISSIONS: Record<UserRole, RoleMatrix> = {
  SUPER_ADMIN: Object.fromEntries(MODULES.map((m) => [m, ALL])) as RoleMatrix,
  // La Direction est un **pair quasi-administrateur** : accès complet (gérer + valider)
  // à TOUS les pôles opérationnels + la vue d'ensemble (hasGlobalView, scope ALL).
  // Le **Super Admin reste souverain et SEUL** sur Administration et Adventum Brain
  // (+ Process Intelligence) : gestion des comptes/permissions, impersonation, IA,
  // Knowledge Graph et réglages d'adoption lui sont exclusivement réservés.
  DIRECTION: {
    WORKSPACE: WORKSPACE_USER, FEEDBACK: FEEDBACK_USER, MESSAGING: MESSAGING_USER, DRIVE: DRIVE_USER,
    REGULATORY: MANAGE, SPONSORING: MANAGE, BUDGETS: READ, FINANCES: MANAGE, RH: MANAGE,
    CONGRESS_INTERNATIONAL: MANAGE, CONGRESS_NATIONAL: MANAGE, EVENTS: MANAGE, SALES: MANAGE,
    LOGISTICS: MANAGE, PCH: MANAGE, STOCKS: MANAGE, MEDICAL: MANAGE, FIELD_REPORTS: MANAGE, SALES_PLANNING: MANAGE, BUSINESS_DEVELOPMENT: MANAGE, PRODUCT_EXPLORER: MANAGE,
    MEDICAL_INFO: MANAGE, PROMO_MATERIAL: MANAGE, CONSULTING: MANAGE, AD_PRO_OTHER: MANAGE, DOCUMENTS: MANAGE, ADMIN_REQUESTS: MANAGE,
    GENERAL_MEANS: MANAGE, LEGAL: MANAGE, MAIL_REGISTER: MANAGE, RECRUITMENT: MANAGE,
    // Le stock promotionnel (§118.164) : la Direction des opérations a la vue globale ET la gestion
    // du matériel de ses équipes. La règle (`promo/stock-acces.ts`) dit lesquelles.
    PROMO_STOCK: CONTRIBUTE,
    // Le CENTRE DE PAIEMENT : le PDG y siège avec le Directeur Général et le Super Admin
    // (règle sitsOnPaymentCentre, lib/payments/authorization.ts).
    PAYMENT_CENTRE: MANAGE,
    // « My Chief of Staff » — l'interface exécutive, même cercle que le centre de paiement.
    CHIEF_OF_STAFF: MANAGE,
    VALIDATIONS: [...VALIDATION_USER, "VALIDATE"], DIRECTIVES: MANAGE, SUPPORT: MANAGE, DOSSIERS: MANAGE,
    NOTIFICATIONS: ["VIEW"],
    // Le SITE PUBLIC (§118.158) : les articles de blog et l'état de la publication.
    SITE_WEB: MANAGE,
    // Les BONS DE COMMANDE (§118.176) : elle signait hier (Finances en écriture) — elle signe encore.
    PURCHASE_ORDERS: BC_SIGNATAIRE,
    // NB : Administration et Adventum Brain (+ Process Intelligence) sont réservés au
    // Super Admin. La Direction n'y a plus accès.
  },
  // DIRECTEUR GÉNÉRAL — tous les pouvoirs MÉTIER, sans la souveraineté du Super Admin.
  //
  // Il gère et décide sur tous les pôles (y compris les circuits Ad & Pro, dont il est le
  // signataire), mais il est délibérément ABSENT de `GLOBAL_VIEW_ROLES`. Deux conséquences
  // voulues, et c'est toute la différence avec la Direction :
  //  - il ne SUPERVISE PAS les demandes de validation de tout le monde (le tableau de
  //    supervision est réservé à la vue globale) : il voit et tranche ce qu'on lui adresse ;
  //  - les modules PERSONNELS (Drive, directives, dossiers, support) restent cloisonnés —
  //    un directeur général n'a pas à lire le Drive privé de chacun.
  // Administration, Adventum Brain et Process Intelligence restent au seul Super Admin.
  GENERAL_MANAGER: {
    WORKSPACE: WORKSPACE_USER, FEEDBACK: FEEDBACK_USER, MESSAGING: MESSAGING_USER, DRIVE: DRIVE_USER,
    REGULATORY: MANAGE, SPONSORING: MANAGE, BUDGETS: READ, FINANCES: MANAGE, RH: MANAGE,
    CONGRESS_INTERNATIONAL: MANAGE, CONGRESS_NATIONAL: MANAGE, EVENTS: MANAGE, SALES: MANAGE,
    LOGISTICS: MANAGE, PCH: MANAGE, STOCKS: MANAGE, MEDICAL: MANAGE, FIELD_REPORTS: MANAGE,
    SALES_PLANNING: MANAGE, BUSINESS_DEVELOPMENT: MANAGE, PRODUCT_EXPLORER: MANAGE, MEDICAL_INFO: MANAGE,
    PROMO_MATERIAL: MANAGE, CONSULTING: MANAGE, AD_PRO_OTHER: MANAGE, DOCUMENTS: MANAGE,
    ADMIN_REQUESTS: MANAGE, GENERAL_MEANS: MANAGE, LEGAL: MANAGE, MAIL_REGISTER: MANAGE,
    // Le stock promotionnel (§118.164) : la vue, sans le magasin (il appartient à la Direction Marketing).
    PROMO_STOCK: READ,
    // Le DG est le SOMMET de la chaîne de validation d'un recrutement, et celui qui tranche
    // entre les candidats : le module lui est acquis, quelle que soit sa place dans l'organigramme.
    RECRUITMENT: MANAGE,
    // Pas de VALIDATE global : il valide ce dont il est nommément validateur, comme tout le monde.
    VALIDATIONS: VALIDATION_USER, DIRECTIVES: MANAGE, SUPPORT: MANAGE, DOSSIERS: MANAGE,
    // LE CENTRE DE VALIDATIONS est le sien : un écran qui ne contient QUE les décisions qu'on
    // attend de lui, tous modules confondus. Il ne lui donne aucun droit nouveau — il rassemble
    // ce qui lui était déjà adressé, et que l'écran commun des validations noyait.
    VALIDATION_CENTRE: MANAGE,
    // LE CENTRE DE VALIDATION AD & PRO — décision de la Direction (09/2026). Le Directeur
    // Général y arbitre les demandes au-dessus du seuil et RÈGLE ce seuil. Le siège réel est la
    // règle pure `siegeAuCentreAdPro` : le module ouvre la porte, la règle dit qui s'assied.
    AD_PRO_CENTRE: MANAGE,
    // LE CENTRE DE PAIEMENT « Direction Générale » (Direction, 27/10) : le DG y siège avec le PDG et le
    // Super Admin — la règle `sitsOnPaymentCentre` (lib/payments/authorization.ts) dit qui s'assied.
    PAYMENT_CENTRE: MANAGE,
    NOTIFICATIONS: ["VIEW"],
    // Le SITE PUBLIC (§118.158) — tous les pouvoirs métier, la communication de l'entreprise comprise.
    SITE_WEB: MANAGE,
    // Les BONS DE COMMANDE (§118.176) : il signait hier (Finances en écriture) — il signe encore.
    PURCHASE_ORDERS: BC_SIGNATAIRE,
  },
  // DIRECTEUR DES OPÉRATIONS — rôle À PART, pas une Direction au rabais.
  //
  // Son métier, c'est ce qui FAIT TOURNER la maison : la chaîne d'approvisionnement
  // (logistique, marchés PCH, stocks), les ventes, les moyens généraux et le secrétariat.
  // Il LIT ce dont il dépend sans le piloter — le réglementaire qui conditionne ce qu'on peut
  // vendre, les budgets et les finances qui bornent ses achats — parce qu'un directeur des
  // opérations qui ne voit pas la date d'une décision d'enregistrement planifie à l'aveugle.
  OPERATIONS_DIRECTOR: {
    WORKSPACE: WORKSPACE_USER, FEEDBACK: FEEDBACK_USER, MESSAGING: MESSAGING_USER, DRIVE: DRIVE_USER,
    VALIDATIONS: VALIDATION_USER,
    LOGISTICS: MANAGE, PCH: MANAGE, STOCKS: MANAGE, SALES: MANAGE,
    GENERAL_MEANS: MANAGE, ADMIN_REQUESTS: MANAGE, LEGAL: CONTRIBUTE, MAIL_REGISTER: READ,
    REGULATORY: READ, BUDGETS: READ, FINANCES: READ, RH: READ, MEDICAL: READ, FIELD_REPORTS: READ,
    DOCUMENTS: CONTRIBUTE,
    // L'INFORMATION MÉDICALE, EN LECTURE ET EN ENTIER (Direction, 10/2026) : tout ce que le pharmacien
    // responsable fait valider lui revient (`medical-info/decideur.ts`) — il ouvre donc le registre, le
    // dossier et ses pièces. Il TRANCHE sans instruire : pas de VALIDATE ici, qui ferait de lui un
    // second pharmacien (demander des pièces, ouvrir des dossiers). La portée ALL est dans `defaultScope`.
    MEDICAL_INFO: READ,
    // LA FORCE DE VENTE ET LES BUSINESS UNITS (Direction, 08/10 : « Droits du Directeur des opérations : gestion de la
    // Force de vente et des Business Units … → oui ») : il les GÈRE, en portée TOUT (`resolveRepScope` → « all »). Le
    // Marketing cockpit, lui, reste en LECTURE : il se recopiait de la Force de vente (plus bas) et n'est pas son métier.
    SALES_PLANNING: MANAGE, BUSINESS_UNITS: MANAGE, MARKETING_COCKPIT: READ,
    // ADVENTUM BRAIN LIMITÉ À SON PÉRIMÈTRE (même décision) : il lit les risques de SON domaine (PCH, stocks,
    // logistique, ventes, force de vente, terrain) et agit dessus (prendre en charge, relancer, ignorer, résoudre) —
    // la règle est `adventum/perimetre.ts`. Le briefing, la question libre et les seuils restent au Super Admin.
    ADVENTUM_BRAIN: ["VIEW", "UPDATE"],
    DIRECTIVES: DIRECTIVES_USER, SUPPORT: SUPPORT_USER, DOSSIERS: DOSSIERS_USER, NOTIFICATIONS: ["VIEW"],
    // LE STOCK PROMOTIONNEL (décision de la Direction, 01/10/2026) : « la vue globale du stock
    // promotionnel, mais aussi la gestion du matériel de ses équipes — les superviseurs en dessous
    // de lui et les KAM ». Le module ouvre l'écran ; la règle dit QUI sont ses équipes.
    // + SUPPRIMER (Direction, 06/10 : « suppression, récupération… des modules qu'il gère ») : un article supprimé
    // part à la corbeille, d'où il le récupère lui-même (`suppression/delegation.ts`).
    PROMO_STOCK: MANAGE,
    // Les BONS DE COMMANDE (§118.176) : il lisait les Finances, donc il voyait la file — il la voit
    // encore, sans signer.
    PURCHASE_ORDERS: BC_LECTEUR,
    // LE CIRCUIT Ad & Pro (Direction, 27/10/2026) : le Directeur des opérations est le N+1 de tout demandeur hors
    // délégué médical, et le second filtre après le National Sales — il valide (VALIDATE), lit toutes les demandes
    // (portée ALL : absent de la carte `assigned`), et ajoute des postes en partie prenante (CREATE / UPDATE / UPLOAD).
    // Pas de DELETE : retirer une demande reste au demandeur et au Super Admin.
    SPONSORING: AD_PRO_OPERATIONS, CONGRESS_NATIONAL: AD_PRO_OPERATIONS, CONGRESS_INTERNATIONAL: AD_PRO_OPERATIONS,
    EVENTS: AD_PRO_OPERATIONS, AD_PRO_OTHER: AD_PRO_OPERATIONS,
  },
  HEAD_OF_REGULATORY: {
    WORKSPACE: WORKSPACE_USER, FEEDBACK: FEEDBACK_USER, MESSAGING: MESSAGING_USER, VALIDATIONS: VALIDATION_USER, DRIVE: DRIVE_USER, ADMIN_REQUESTS: REQUEST_USER, REGULATORY: MANAGE, DOCUMENTS: CONTRIBUTE, BUDGETS: READ, DIRECTIVES: DIRECTIVES_USER, SUPPORT: SUPPORT_USER, DOSSIERS: DOSSIERS_USER, NOTIFICATIONS: ["VIEW"],
  },
  REGULATORY_ASSISTANT: {
    WORKSPACE: WORKSPACE_USER, FEEDBACK: FEEDBACK_USER, MESSAGING: MESSAGING_USER, VALIDATIONS: VALIDATION_USER, DRIVE: DRIVE_USER, ADMIN_REQUESTS: REQUEST_USER, REGULATORY: CONTRIBUTE, DOCUMENTS: CONTRIBUTE, DIRECTIVES: DIRECTIVES_USER, SUPPORT: SUPPORT_USER, DOSSIERS: DOSSIERS_USER, NOTIFICATIONS: ["VIEW"],
  },
  HEAD_OF_SALES: {
    WORKSPACE: WORKSPACE_USER, FEEDBACK: FEEDBACK_USER, MESSAGING: MESSAGING_USER, VALIDATIONS: VALIDATION_USER, DRIVE: DRIVE_USER, ADMIN_REQUESTS: REQUEST_USER, SALES: MANAGE, LOGISTICS: READ, PCH: MANAGE, STOCKS: CONTRIBUTE, DOCUMENTS: CONTRIBUTE, DIRECTIVES: DIRECTIVES_USER, SUPPORT: SUPPORT_USER, DOSSIERS: DOSSIERS_USER, NOTIFICATIONS: ["VIEW"],
  },
  SALES_USER: { WORKSPACE: WORKSPACE_USER, FEEDBACK: FEEDBACK_USER, MESSAGING: MESSAGING_USER, VALIDATIONS: VALIDATION_USER, DRIVE: DRIVE_USER, ADMIN_REQUESTS: REQUEST_USER, SALES: CONTRIBUTE, PCH: CONTRIBUTE, STOCKS: READ, DIRECTIVES: DIRECTIVES_USER, SUPPORT: SUPPORT_USER, DOSSIERS: DOSSIERS_USER, NOTIFICATIONS: ["VIEW"] },
  LOGISTICS_MANAGER: {
    WORKSPACE: WORKSPACE_USER, FEEDBACK: FEEDBACK_USER, MESSAGING: MESSAGING_USER, VALIDATIONS: VALIDATION_USER, DRIVE: DRIVE_USER, ADMIN_REQUESTS: REQUEST_USER, LOGISTICS: MANAGE, PCH: MANAGE, STOCKS: MANAGE, DOCUMENTS: CONTRIBUTE, SALES: READ, DIRECTIVES: DIRECTIVES_USER, SUPPORT: SUPPORT_USER, DOSSIERS: DOSSIERS_USER, NOTIFICATIONS: ["VIEW"],
  },
  MEDICAL_PROMOTION_MANAGER: {
    WORKSPACE: WORKSPACE_USER, FEEDBACK: FEEDBACK_USER, MESSAGING: MESSAGING_USER, VALIDATIONS: VALIDATION_USER, DRIVE: DRIVE_USER, ADMIN_REQUESTS: REQUEST_USER, MEDICAL: MANAGE, FIELD_REPORTS: MANAGE, SALES_PLANNING: MANAGE, EVENTS: MANAGE, CONGRESS_NATIONAL: CONTRIBUTE, CONGRESS_INTERNATIONAL: CONTRIBUTE, PROMO_MATERIAL: CONTRIBUTE, CONSULTING: CONTRIBUTE, AD_PRO_OTHER: CONTRIBUTE, DOCUMENTS: CONTRIBUTE, DIRECTIVES: DIRECTIVES_USER, SUPPORT: SUPPORT_USER, DOSSIERS: DOSSIERS_USER, NOTIFICATIONS: ["VIEW"],
    // Son stock et celui de son équipe (portée ASSIGNÉE, carte `assigned`) — §118.164.
    PROMO_STOCK: CONTRIBUTE,
  },
  // KAM / délégué médical : accède à SON tableau de bord de force de vente (Pilotage — lecture,
  // portée limitée à lui-même par la couche métier ; il édite ses propres affectations via `canEditRep`).
  // MATÉRIEL PROMOTIONNEL (§118.153) — la Direction l'a nommé demandeur en toutes lettres (« si
  // c'est un KAM, délégué médical ou quoi ») et §118.152 affirmait que la matrice le lui donnait :
  // c'était FAUX, mesuré en parcours réel — le KAM n'avait pas le module, et seul un accès
  // personnalisé posé par le Super Admin lui permettait de créer sa demande. CONTRIBUTE, pas
  // MANAGE : il demande, il ne tranche rien (le circuit décide qui valide), et la portée est
  // ASSIGNÉE (carte `assigned` de defaultScope) — il ne voit que SES dossiers.
  MEDICAL_DELEGATE: { WORKSPACE: WORKSPACE_USER, FEEDBACK: FEEDBACK_USER, MESSAGING: MESSAGING_USER, VALIDATIONS: VALIDATION_USER, DRIVE: DRIVE_USER, ADMIN_REQUESTS: REQUEST_USER, MEDICAL: CONTRIBUTE, FIELD_REPORTS: CONTRIBUTE, SALES_PLANNING: READ, EVENTS: CONTRIBUTE, CONGRESS_NATIONAL: CONTRIBUTE, CONGRESS_INTERNATIONAL: CONTRIBUTE, PROMO_MATERIAL: CONTRIBUTE, DIRECTIVES: DIRECTIVES_USER, SUPPORT: SUPPORT_USER, DOSSIERS: DOSSIERS_USER, NOTIFICATIONS: ["VIEW"],
    // SON stock promotionnel (§118.164) : confirmer ses réceptions, rendre, transférer à un collègue,
    // déclarer une perte, demander du matériel. Portée ASSIGNÉE : il ne voit que le sien.
    PROMO_STOCK: CONTRIBUTE,
    // SON SPONSORING (§118.185 — audit 360°, I4). La décision du 28/09 fait passer « le sponsoring
    // d'un KAM » par le National Sales puis la Direction des opérations (§118.156) — et le KAM n'avait
    // pas le module : la règle était écrite pour une demande que personne ne pouvait déposer. Même
    // raisonnement que le matériel promotionnel (§118.153) : CONTRIBUTE (il demande, il ne tranche
    // rien) et portée ASSIGNÉE (`scopeSponsoring`) — il ne voit que SES demandes.
    SPONSORING: CONTRIBUTE,
    // LE RELEVÉ DES STOCKS HOSPITALIERS (§118.185 — audit 360°, I5). L'écran a été conçu pour lui
    // (§118.134 : les hôpitaux de SES secteurs, les produits de SA BU) et le rôle n'avait pas le
    // module — le banc le lui donnait à la main. La portée se calcule sur les faits (secteur, BU,
    // chaîne d'approvisionnement), pas sur le module : l'ouvrir ne lui montre rien d'autre.
    STOCKS: CONTRIBUTE },
  // National Sales : **toutes les capacités du délégué médical** (créer des demandes
  // de sponsoring / congrès / événements, terrain, annuaire) PLUS l'**approbation
  // préliminaire** de ces demandes avec choix du référent Direction Marketing. Volontairement
  // ABSENT de la carte `assigned` (cf. defaultScope) → portée ALL : il voit TOUTES
  // les demandes à instruire. CONTRIBUTE (sans VALIDATE) : la décision définitive
  // reste à la Direction ; l'étape préliminaire est ouverte par contrôle de rôle.
  // National Sales = superviseur national : voit TOUS les rapports terrain des délégués
  // (FIELD_REPORTS en portée ALL — absent de la carte `assigned` de defaultScope).
  // National Sales = **superviseur national** : pilote la force de vente de ses équipes
  // (Pilotage + affectations de SES KAM via `canEditRep`). SALES_PLANNING en lecture ;
  // l'édition des affectations de son équipe est autorisée par la couche métier.
  // Matériel promotionnel (§118.153) : « toutes les capacités du délégué », donc DEMANDER aussi.
  // Portée ASSIGNÉE, à la différence de ses autres modules Ad & Pro : il VALIDE les demandes de
  // ses KAM (le N+1 du circuit), et ce geste lui est ouvert par le dossier lui-même (partie
  // prenante, `peutOuvrirLeDossierPromo`) — pas par une vue de TOUS les dossiers de la société,
  // qu'aucune étape ne lui demande de lire. Le geste qui retourne cette décision : le retirer
  // de la carte `assigned` pour la clé PROMO_MATERIAL.
  NATIONAL_SALES: { WORKSPACE: WORKSPACE_USER, FEEDBACK: FEEDBACK_USER, MESSAGING: MESSAGING_USER, VALIDATIONS: VALIDATION_USER, DRIVE: DRIVE_USER, ADMIN_REQUESTS: REQUEST_USER, MEDICAL: CONTRIBUTE, FIELD_REPORTS: CONTRIBUTE, SALES_PLANNING: READ, EVENTS: CONTRIBUTE, CONGRESS_NATIONAL: CONTRIBUTE, CONGRESS_INTERNATIONAL: CONTRIBUTE, SPONSORING: CONTRIBUTE, PROMO_MATERIAL: CONTRIBUTE, CONSULTING: CONTRIBUTE, AD_PRO_OTHER: CONTRIBUTE, DIRECTIVES: DIRECTIVES_USER, SUPPORT: SUPPORT_USER, DOSSIERS: DOSSIERS_USER, NOTIFICATIONS: ["VIEW"],
    // Les stocks hospitaliers de TOUTE SA BU (§118.134 ; audit 360°, I5) — même raison que le KAM.
    STOCKS: CONTRIBUTE,
    // Son stock et celui des KAM de ses gammes (§118.164) — il les VOIT ; la gestion des équipes est
    // au directeur des opérations.
    PROMO_STOCK: CONTRIBUTE },
  // DIRECTION MARKETING. Depuis 09/2026 elle TRANCHE toute demande Ad & Pro (montant accordé +
  // sous-catégorie budgétaire) et valide le matériel promotionnel — §118.138. `SPONSORING` et
  // `PROMO_MATERIAL` sont donc ouverts : sans eux elle ne peut pas même OUVRIR la demande
  // qu'on lui demande de décider, et le circuit s'arrêterait sur une étape que son unique
  // titulaire ne voit pas. C'est une décision de PERMISSION, nommée ici pour être relue.
  // DIRECTION MARKETING — LE PÔLE Ad & Pro EN ENTIER (décision de la Direction, 09/2026).
  //
  // « Direction marketing reçoit la gestion de Ad&Pro, pas que sponsoring et matériel
  // promotionnel » : elle TRANCHE désormais toute demande Ad&Pro et choisit la sous-catégorie
  // budgétaire, donc lui ouvrir cinq natures sur sept lui donnait un pouvoir de décision sur des
  // demandes qu'elle ne pouvait pas ouvrir. `CONSULTING` et `AD_PRO_OTHER` manquaient.
  //
  // Les sept modules sont ÉCRITS ici, comme pour tous les autres rôles — une permission est une
  // DÉCISION, jamais une dérivation (§118.130) : dériver depuis `AD_PRO_KINDS` accorderait MANAGE
  // sur une huitième nature dont personne n'aurait décidé. Ce qui empêche l'omission de repasser
  // en silence (§118.73) est un CLIQUET armé sur le registre canonique : `ad-pro/pole.test.ts`
  // exige que l'ensemble des modules nommés par `AD_PRO_KINDS` soit exactement celui accordé ici,
  // et il nomme le module fautif. Le socle ne peut pas lire `lib/ad-pro/` (ce serait une fuite de
  // socle, `domains.ts`) — le test, lui, a le droit, et c'est le bon endroit pour le constat.
  PRODUCT_MANAGER: {
    WORKSPACE: WORKSPACE_USER, FEEDBACK: FEEDBACK_USER, MESSAGING: MESSAGING_USER, VALIDATIONS: VALIDATION_USER, DRIVE: DRIVE_USER, ADMIN_REQUESTS: REQUEST_USER,
    SPONSORING: MANAGE, CONGRESS_INTERNATIONAL: MANAGE, CONGRESS_NATIONAL: MANAGE, EVENTS: MANAGE, PROMO_MATERIAL: MANAGE, CONSULTING: MANAGE, AD_PRO_OTHER: MANAGE,
    MEDICAL: READ, FIELD_REPORTS: READ, BUDGETS: READ, DOCUMENTS: CONTRIBUTE, DIRECTIVES: DIRECTIVES_USER, SUPPORT: SUPPORT_USER, DOSSIERS: DOSSIERS_USER, NOTIFICATIONS: ["VIEW"],
    // LE MAGASIN CENTRAL du matériel promotionnel (décision de la Direction, 01/10/2026) : « c'est la
    // directrice marketing » qui le gère. Le module est ouvert à la Direction Marketing entière (la
    // vue globale) ; la règle (`promo/stock-acces.ts`) réserve le magasin à sa CHEFFE.
    PROMO_STOCK: CONTRIBUTE,
    // LE BLOG DU SITE PUBLIC (§118.158) : c'est de la communication, donc la Direction Marketing.
    // Une DÉCISION prise ici, pas écrite dans la demande — elle se défait en une ligne : retirer
    // cette entrée laisse les articles à la Direction, au Directeur Général et au Super Admin, et
    // la console d'accès les ouvre ensuite nommément à qui les rédige.
    SITE_WEB: MANAGE,
    // LA FORCE DE VENTE EN LECTURE (§118.185 — audit 360°, I11). Les messages pré-définis — que les
    // rapports terrain EXIGENT, et dont l'écran s'intitule « Messages Direction Marketing » — vivent
    // sous ce module ; la Direction Marketing ne pouvait pas même les lire, et le lien « Business
    // units » de son budget menait à une page fermée. LECTURE seulement : écrire les messages reste
    // une liste de rôles que le Super Admin pose (Administration › Réglages), et rien de la force de
    // vente ne se modifie d'ici.
    SALES_PLANNING: READ,
    // LE MARKETING COCKPIT EST SON TABLEAU (Direction, 07/10 : « la Direction Marketing écrit ses messages par
    // défaut ») : elle y crée, modifie et archive ses messages — sans rien gagner sur la Force de vente. Un DÉFAUT :
    // la console le règle personne par personne, et la liste des auteurs (Administration › Réglages) reste la
    // seconde clé (`peutEcrireMessagesCockpit`). Posé ici, il n'est pas recopié de la Force de vente (lecture).
    MARKETING_COCKPIT: ["VIEW", "CREATE", "UPDATE", "DELETE", "EXPORT"],
  },
  BUSINESS_DEVELOPMENT_MANAGER: {
    WORKSPACE: WORKSPACE_USER, FEEDBACK: FEEDBACK_USER, MESSAGING: MESSAGING_USER, VALIDATIONS: VALIDATION_USER, DRIVE: DRIVE_USER, ADMIN_REQUESTS: REQUEST_USER, BUSINESS_DEVELOPMENT: MANAGE, PRODUCT_EXPLORER: MANAGE, DOCUMENTS: CONTRIBUTE, DIRECTIVES: DIRECTIVES_USER, SUPPORT: SUPPORT_USER, DOSSIERS: DOSSIERS_USER, NOTIFICATIONS: ["VIEW"],
  },
  FINANCE_BUDGET_MANAGER: {
    WORKSPACE: WORKSPACE_USER, FEEDBACK: FEEDBACK_USER, MESSAGING: MESSAGING_USER, VALIDATIONS: VALIDATION_USER, DRIVE: DRIVE_USER, ADMIN_REQUESTS: REQUEST_USER, BUDGETS: MANAGE, FINANCES: MANAGE, GENERAL_MEANS: MANAGE, RH: READ, SPONSORING: READ, SALES: READ, LOGISTICS: READ, PCH: READ, STOCKS: READ,
    DOCUMENTS: READ, MEDICAL_INFO: ["VIEW", "UPLOAD"], PROMO_MATERIAL: ["VIEW", "UPLOAD", "EXPORT"], CONSULTING: READ, AD_PRO_OTHER: READ, DIRECTIVES: DIRECTIVES_USER, SUPPORT: SUPPORT_USER, DOSSIERS: DOSSIERS_USER, NOTIFICATIONS: ["VIEW"],
    // Le stock promotionnel en lecture : ce qui est entré, ce qui reste (§118.164).
    PROMO_STOCK: READ,
    // Les BONS DE COMMANDE (§118.176) : c'est leur file — la signature est leur métier.
    PURCHASE_ORDERS: BC_SIGNATAIRE,
  },
  // Pharmacien responsable de l'information médicale : déclare aux autorités les
  // événements validés définitivement, exige des pièces, puis valide (→ ordre de
  // dépense). Lecture des pôles événementiels pour instruire ses déclarations.
  MEDICAL_INFO_PHARMACIST: {
    WORKSPACE: WORKSPACE_USER, FEEDBACK: FEEDBACK_USER, MESSAGING: MESSAGING_USER, VALIDATIONS: VALIDATION_USER, DRIVE: DRIVE_USER, ADMIN_REQUESTS: REQUEST_USER,
    MEDICAL_INFO: MANAGE, SPONSORING: READ, CONGRESS_INTERNATIONAL: READ, CONGRESS_NATIONAL: READ, EVENTS: READ, MEDICAL: READ, DOCUMENTS: CONTRIBUTE, DIRECTIVES: DIRECTIVES_USER, SUPPORT: SUPPORT_USER, DOSSIERS: DOSSIERS_USER, NOTIFICATIONS: ["VIEW"],
  },
  // Assistante de Direction : **tout passe par les Demandes administratives**
  // (gestion complète, portée ALL). Elle pilote AUSSI le circuit Matériel
  // promotionnel mais SANS accès au module dédié : ses étapes (devis, bon de
  // commande, transmission à l'agence, facture) sont surfacées directement dans
  // la demande administrative liée (cf. entity-access : accès aux pièces du
  // dossier promo lié). Pas d'accès à Administration ni à Adventum Brain.
  // L'assistante de direction ACHÈTE au quotidien : les Moyens généraux sont SON module —
  // son budget, ses dépenses, sa caisse d'avance. Elle n'a pas (et n'a pas besoin d')
  // « Budgets », qui est l'écran de ceux qui ALLOUENT.
  DIRECTION_ASSISTANT: {
    WORKSPACE: WORKSPACE_USER, FEEDBACK: FEEDBACK_USER, MESSAGING: MESSAGING_USER, VALIDATIONS: VALIDATION_USER, DRIVE: DRIVE_USER,
    ADMIN_REQUESTS: MANAGE, GENERAL_MEANS: GENERAL_MEANS_USER, MAIL_REGISTER: MANAGE, LEGAL: MANAGE,
    DOCUMENTS: CONTRIBUTE, DIRECTIVES: DIRECTIVES_USER, SUPPORT: SUPPORT_USER, DOSSIERS: DOSSIERS_USER, NOTIFICATIONS: ["VIEW"],
  },
  // Coordination / coursier-acheteur : **espace restreint** — pas de congrès,
  // événements, sponsoring, regulatory, finances, etc. Accès à son espace perso
  // (tâches/courses + dossier RH), à la messagerie, au Drive, à ses demandes et
  // validations, aux directives reçues et aux dossiers où il participe.
  COORDINATOR: {
    WORKSPACE: WORKSPACE_USER, FEEDBACK: FEEDBACK_USER, MESSAGING: MESSAGING_USER, DRIVE: DRIVE_USER, ADMIN_REQUESTS: REQUEST_USER,
    VALIDATIONS: VALIDATION_USER, DIRECTIVES: DIRECTIVES_USER, SUPPORT: SUPPORT_USER, DOSSIERS: DOSSIERS_USER, NOTIFICATIONS: ["VIEW"],
  },
  VIEWER: { WORKSPACE: ["VIEW", "CREATE", "UPDATE"], FEEDBACK: FEEDBACK_USER, MESSAGING: MESSAGING_USER, DRIVE: ["VIEW", "EXPORT"], ADMIN_REQUESTS: ["VIEW", "CREATE", "UPLOAD"], DOCUMENTS: ["VIEW"], DIRECTIVES: DIRECTIVES_USER, SUPPORT: SUPPORT_USER, DOSSIERS: DOSSIERS_USER, NOTIFICATIONS: ["VIEW"] },
};

/**
 * « PROJETS (BD) » PAR DÉFAUT — le périmètre d'avant, sous la forme d'un module (§118.163).
 *
 * La porte se DÉDUISAIT de Regulatory (« quiconque voit Regulatory lit le registre ») : personne ne
 * pouvait la régler, ni pour l'ouvrir à quelqu'un qui n'a pas Regulatory, ni pour la fermer à
 * quelqu'un qui l'a. Elle devient un module, et ce qui suit n'en est que le DÉFAUT : la LECTURE
 * pour chaque rôle qui voit Regulatory — exactement les mêmes personnes qu'hier, pour que personne
 * ne perde l'écran le jour où la règle change de forme. Nommer, renommer et supprimer un projet
 * restent au seul Super Admin par défaut (il tient tous les modules). Tout le reste se règle
 * désormais dans Administration › Accès, personne par personne.
 *
 * Un défaut, pas une copie : il se lit dans la matrice des rôles, donc un rôle qui gagne demain
 * Regulatory gagne aussi la lecture du registre, sans qu'on y pense.
 */
for (const role of Object.keys(PERMISSIONS) as UserRole[]) {
  if (role === "SUPER_ADMIN") continue;
  const matrice = PERMISSIONS[role];
  if (matrice.REGULATORY?.includes("VIEW") && !matrice.BD_PROJECTS) matrice.BD_PROJECTS = ["VIEW"];
}

/**
 * « MARKETING COCKPIT » PAR DÉFAUT — les mêmes personnes qu'hier (Direction, 06/10). Ses écrans vivaient dans la Force
 * de vente : chaque rôle qui avait la Force de vente reçoit, par défaut, les mêmes gestes sur le cockpit — personne ne
 * perd l'écran le jour où il devient un module. Ce n'est qu'un DÉFAUT : la console le règle ensuite personne par
 * personne, indépendamment de la Force de vente. (Écrire un message et gérer les spécialités gardent leurs règles
 * propres : `peutEcrireMessagesPromo`, `peutGererSpecialites`.)
 */
for (const role of Object.keys(PERMISSIONS) as UserRole[]) {
  if (role === "SUPER_ADMIN") continue;
  const matrice = PERMISSIONS[role];
  if (matrice.SALES_PLANNING && !matrice.MARKETING_COCKPIT) matrice.MARKETING_COCKPIT = [...matrice.SALES_PLANNING];
}

/**
 * « BUSINESS UNITS » PAR DÉFAUT — les mêmes personnes qu'hier (Direction, 08/10). Le montage (BU, secteurs, paramètres)
 * vivait dans le « ⋯ Réglages » de la Force de vente, réservé à qui la CONFIGURAIT (`SALES_PLANNING:UPDATE`, ou la vue
 * globale) : chaque rôle qui la modifiait reçoit, par défaut, ses gestes sur le nouveau module ; un rôle qui ne faisait
 * que la LIRE n'y gagne rien (il n'ouvrait pas ces écrans). Les accès personnalisés déjà posés sur la Force de vente
 * sont recopiés par la migration `module_business_units`. Ce n'est qu'un DÉFAUT : la console le règle ensuite personne
 * par personne, indépendamment de la Force de vente.
 */
for (const role of Object.keys(PERMISSIONS) as UserRole[]) {
  if (role === "SUPER_ADMIN") continue;
  const matrice = PERMISSIONS[role];
  if (matrice.SALES_PLANNING?.includes("UPDATE") && !matrice.BUSINESS_UNITS) matrice.BUSINESS_UNITS = [...matrice.SALES_PLANNING];
}

/**
 * « SEGMENTATION STUDIO » PAR DÉFAUT — le cahier des charges (§69, §86) : la Direction et le directeur des opérations
 * tiennent la stratégie et les règles ; la Direction de la promotion lit, renseigne et pose des dérogations motivées ;
 * le KAM lit SON panel et met à jour le potentiel terrain — sans jamais toucher aux règles, à la BU ni aux
 * allocations. Ce n'est qu'un DÉFAUT : la console le règle ensuite personne par personne.
 */
const SEGMENTATION_PAR_DEFAUT: Partial<Record<UserRole, Action[]>> = {
  DIRECTION: MANAGE,
  GENERAL_MANAGER: MANAGE,
  OPERATIONS_DIRECTOR: MANAGE,
  MEDICAL_PROMOTION_MANAGER: ["VIEW", "CREATE", "UPDATE", "EXPORT"],
  HEAD_OF_SALES: READ,
  PRODUCT_MANAGER: READ,
  NATIONAL_SALES: ["VIEW", "UPDATE"],
  MEDICAL_DELEGATE: ["VIEW", "UPDATE"],
};
for (const [role, actions] of Object.entries(SEGMENTATION_PAR_DEFAUT) as [UserRole, Action[]][]) {
  if (!PERMISSIONS[role].SEGMENTATION) PERMISSIONS[role].SEGMENTATION = [...actions];
}

/** « CONSUMPTION INTELLIGENCE » PAR DÉFAUT — la Direction et les opérations font compter un import ; la Direction de
 *  la promotion et le BD importent et revoient ; le commercial et le chef de produit lisent. Le KAM n'y est pas. */
const CONSUMPTION_PAR_DEFAUT: Partial<Record<UserRole, Action[]>> = {
  DIRECTION: MANAGE,
  GENERAL_MANAGER: MANAGE,
  OPERATIONS_DIRECTOR: MANAGE,
  MEDICAL_PROMOTION_MANAGER: CONTRIBUTE,
  BUSINESS_DEVELOPMENT_MANAGER: CONTRIBUTE,
  HEAD_OF_SALES: READ,
  PRODUCT_MANAGER: READ,
};
for (const [role, actions] of Object.entries(CONSUMPTION_PAR_DEFAUT) as [UserRole, Action[]][]) {
  if (!PERMISSIONS[role].CONSUMPTION) PERMISSIONS[role].CONSUMPTION = [...actions];
}

/** « VENTES PCH » PAR DÉFAUT (Direction, 08/10) — le directeur des opérations et la Direction importent et rattachent ;
 *  la direction commerciale, la promotion et le marketing lisent. Personne d'autre : la console l'ouvre ensuite. */
const PCH_VENTES_PAR_DEFAUT: Partial<Record<UserRole, Action[]>> = {
  DIRECTION: MANAGE,
  GENERAL_MANAGER: MANAGE,
  OPERATIONS_DIRECTOR: MANAGE,
  NATIONAL_SALES: READ,
  HEAD_OF_SALES: READ,
  MEDICAL_PROMOTION_MANAGER: READ,
  PRODUCT_MANAGER: READ,
};
for (const [role, actions] of Object.entries(PCH_VENTES_PAR_DEFAUT) as [UserRole, Action[]][]) {
  if (!PERMISSIONS[role].PCH_VENTES) PERMISSIONS[role].PCH_VENTES = [...actions];
}

/**
 * « BUDGET MARKETING » PAR DÉFAUT (Direction, 08/10) — la Direction Marketing (rôle PRODUCT_MANAGER) tient ses
 * enveloppes : elle les crée, les répartit, les consomme. La Direction et le Directeur Général aussi ; les Finances
 * lisent. Personne d'autre par défaut — la console l'ouvre ensuite personne par personne.
 */
const BUDGET_MARKETING_PAR_DEFAUT: Partial<Record<UserRole, Action[]>> = {
  DIRECTION: MANAGE,
  GENERAL_MANAGER: MANAGE,
  PRODUCT_MANAGER: MANAGE,
  FINANCE_BUDGET_MANAGER: READ,
};
for (const [role, actions] of Object.entries(BUDGET_MARKETING_PAR_DEFAUT) as [UserRole, Action[]][]) {
  if (!PERMISSIONS[role].BUDGET_MARKETING) PERMISSIONS[role].BUDGET_MARKETING = [...actions];
}

/**
 * « BUDGET REGULATORY » et « BUDGET OPERATIONS & SALES » PAR DÉFAUT (Direction, 08/10) — chaque pôle tient ses
 * enveloppes (le Head of Regulatory, le Directeur des Opérations) ; la Direction et le Directeur Général aussi ; les
 * Finances lisent ; l'assistante réglementaire lit les BV. Personne d'autre : la console ouvre ensuite au cas par cas.
 */
const BUDGET_REGULATORY_PAR_DEFAUT: Partial<Record<UserRole, Action[]>> = {
  DIRECTION: MANAGE,
  GENERAL_MANAGER: MANAGE,
  HEAD_OF_REGULATORY: MANAGE,
  FINANCE_BUDGET_MANAGER: READ,
  REGULATORY_ASSISTANT: READ,
};
const BUDGET_OPERATIONS_PAR_DEFAUT: Partial<Record<UserRole, Action[]>> = {
  DIRECTION: MANAGE,
  GENERAL_MANAGER: MANAGE,
  OPERATIONS_DIRECTOR: MANAGE,
  FINANCE_BUDGET_MANAGER: READ,
};
for (const [role, actions] of Object.entries(BUDGET_REGULATORY_PAR_DEFAUT) as [UserRole, Action[]][]) {
  if (!PERMISSIONS[role].BUDGET_REGULATORY) PERMISSIONS[role].BUDGET_REGULATORY = [...actions];
}
for (const [role, actions] of Object.entries(BUDGET_OPERATIONS_PAR_DEFAUT) as [UserRole, Action[]][]) {
  if (!PERMISSIONS[role].BUDGET_OPERATIONS) PERMISSIONS[role].BUDGET_OPERATIONS = [...actions];
}

/**
 * « PRODUITS » PAR DÉFAUT — les mêmes personnes qu'hier : chaque rôle qui voyait au moins une facette d'un produit
 * (Regulatory, AO, ventes, Force de vente, segmentation, consommation, finances) garde la LECTURE. Ce n'est qu'un
 * défaut : la console l'ouvre ou le ferme ensuite personne par personne.
 */
const FACETTES_PRODUIT: Module[] = ["REGULATORY", "PCH", "SALES", "SALES_PLANNING", "SEGMENTATION", "CONSUMPTION", "FINANCES"];
for (const role of Object.keys(PERMISSIONS) as UserRole[]) {
  if (role === "SUPER_ADMIN") continue;
  const matrice = PERMISSIONS[role];
  if (!matrice.PRODUCTS && FACETTES_PRODUIT.some((m) => matrice[m]?.includes("VIEW"))) matrice.PRODUCTS = [...READ];
}

/**
 * LES SOUS-MODULES RH PAR DÉFAUT — les mêmes personnes qu'hier : chaque rôle qui tenait les ressources humaines garde,
 * sur Employés, Demandes RH et Formations, exactement ce qu'il avait sur « RH ». Ce n'est qu'un défaut, LISIBLE dans la
 * console : chacun s'ouvre ou se ferme ensuite indépendamment des autres (Direction, 06/10).
 */
const SOUS_MODULES_RH: Module[] = ["EMPLOYEES", "HR_REQUESTS", "TRAINING"];
for (const role of Object.keys(PERMISSIONS) as UserRole[]) {
  if (role === "SUPER_ADMIN") continue;
  const matrice = PERMISSIONS[role];
  const rh = matrice.RH;
  if (!rh) continue;
  for (const m of SOUS_MODULES_RH) if (!matrice[m]) matrice[m] = [...rh];
}

/**
 * LA PHARMACOVIGILANCE PAR DÉFAUT (Direction, 06/10) — qui tient Regulatory reçoit les cas, avec exactement ses gestes
 * de Regulatory ; qui rédige des rapports terrain (Créer) peut SIGNALER un cas — Voir + Créer + Téléverser, en portée
 * « ses lignes » (`defaultScope`) : il ne lit que ses signalements. Un défaut, réglable ensuite dans la console.
 */
/**
 * LE PIPELINE RÉGLEMENTAIRE PAR DÉFAUT (Direction, 08/10) — les mêmes personnes qu'hier, avec les mêmes gestes : chaque
 * rôle qui tenait Regulatory reçoit, sur le pipeline, EXACTEMENT ses gestes de Regulatory (le pipeline vivait sous ce
 * module). Un DÉFAUT, lisible dans la console : le pipeline s'ouvre ou se ferme ensuite personne par personne,
 * indépendamment du suivi des dossiers. La confidence « voit les dossiers verrouillés » (Réglages) reste requise en plus.
 */
for (const role of Object.keys(PERMISSIONS) as UserRole[]) {
  if (role === "SUPER_ADMIN") continue;
  const matrice = PERMISSIONS[role];
  if (matrice.REGULATORY && !matrice.REGULATORY_PIPELINE) matrice.REGULATORY_PIPELINE = [...matrice.REGULATORY];
}

const GESTES_DECLARANT_PV: Action[] = ["VIEW", "CREATE", "UPLOAD"];
for (const role of Object.keys(PERMISSIONS) as UserRole[]) {
  if (role === "SUPER_ADMIN") continue;
  const matrice = PERMISSIONS[role];
  if (matrice.PHARMACOVIGILANCE) continue;
  if (matrice.REGULATORY?.includes("VIEW")) matrice.PHARMACOVIGILANCE = [...matrice.REGULATORY];
  else if (matrice.FIELD_REPORTS?.includes("CREATE")) matrice.PHARMACOVIGILANCE = [...GESTES_DECLARANT_PV];
}

/**
 * « KPI & BILANS » PAR DÉFAUT (Direction, 08/10) — comme Mon équipe, une PORTE accordée à tous : chacun voit son bilan
 * et y déclare ; qui encadre crée des KPI pour son équipe, note, valide et signe — mais seulement sur SON arbre (la
 * règle est dans `kpi/droits.ts`, l'arbre est celui de Mon équipe). Sans équipe, Créer/Valider ne donnent prise sur
 * personne. Le Super Admin (tous les modules) tient le catalogue et les modèles par rôle. La console peut retirer un
 * geste personne par personne. ÉCRIT, pas dérivé (§118.130).
 */
const KPI_PAR_DEFAUT: Action[] = ["VIEW", "CREATE", "UPDATE", "VALIDATE", "EXPORT"];
for (const role of Object.keys(PERMISSIONS) as UserRole[]) {
  if (!PERMISSIONS[role].KPI) PERMISSIONS[role].KPI = [...KPI_PAR_DEFAUT];
}

/** « COCKPIT OPÉRATIONS » PAR DÉFAUT (Direction, 08/10) — le directeur des opérations, la Direction et le Directeur
 *  Général le lisent (le Super Admin a tous les modules). Personne d'autre : la console l'ouvre au cas par cas. */
const COCKPIT_OPERATIONS_PAR_DEFAUT: Partial<Record<UserRole, Action[]>> = {
  OPERATIONS_DIRECTOR: ["VIEW"],
  DIRECTION: ["VIEW"],
  GENERAL_MANAGER: ["VIEW"],
};
for (const [role, actions] of Object.entries(COCKPIT_OPERATIONS_PAR_DEFAUT) as [UserRole, Action[]][]) {
  if (!PERMISSIONS[role].COCKPIT_OPERATIONS) PERMISSIONS[role].COCKPIT_OPERATIONS = [...actions];
}

/** « CAMPAGNE BUDGÉTAIRE » PAR DÉFAUT (Direction, 10/2026) — la Direction et le DG la pilotent (le Super Admin a tout) ;
 *  les Finances l'examinent en lecture ; les responsables de département préparent LEUR pôle par l'organigramme
 *  (`getAccess`, accès implicite). Personne d'autre : la console l'ouvre au cas par cas. */
const BUDGET_CAMPAIGN_PAR_DEFAUT: Partial<Record<UserRole, Action[]>> = {
  DIRECTION: MANAGE,
  GENERAL_MANAGER: MANAGE,
  FINANCE_BUDGET_MANAGER: READ,
};
for (const [role, actions] of Object.entries(BUDGET_CAMPAIGN_PAR_DEFAUT) as [UserRole, Action[]][]) {
  if (!PERMISSIONS[role].BUDGET_CAMPAIGN) PERMISSIONS[role].BUDGET_CAMPAIGN = [...actions];
}

/** « DIRECTION ARTISTIQUE » PAR DÉFAUT (Transverse, 10/2026) — l'assistante de direction la tient (le Super Admin a tout).
 *  Personne d'autre : la console l'ouvre au cas par cas, personne par personne. */
const ART_DIRECTION_PAR_DEFAUT: Partial<Record<UserRole, Action[]>> = {
  DIRECTION_ASSISTANT: ["VIEW", "CREATE", "UPDATE", "DELETE", "UPLOAD"],
};
for (const [role, actions] of Object.entries(ART_DIRECTION_PAR_DEFAUT) as [UserRole, Action[]][]) {
  if (!PERMISSIONS[role].ART_DIRECTION) PERMISSIONS[role].ART_DIRECTION = [...actions];
}

const GLOBAL_VIEW_ROLES: UserRole[] = ["SUPER_ADMIN", "DIRECTION"];

/** Type minimal « porteur de rôles » : rôle principal + éventuel rôle secondaire. */
type RoleBearer = { role: UserRole; secondaryRole?: UserRole | null };

/**
 * Vue globale (voit tout / valide comme la Direction). Accepte un **rôle brut**
 * (rétrocompatible) OU un **utilisateur** — auquel cas le **rôle secondaire** est
 * aussi pris en compte (ex. un compte dont l'« autre rôle » est Direction).
 */
export function hasGlobalView(u: UserRole | RoleBearer): boolean {
  if (typeof u === "string") return GLOBAL_VIEW_ROLES.includes(u);
  return GLOBAL_VIEW_ROLES.includes(u.role) || (u.secondaryRole != null && GLOBAL_VIEW_ROLES.includes(u.secondaryRole));
}

/**
 * LE SOMMET DE LA MAISON — celui qui tranche en dernier ressort.
 *
 * Plus large que `hasGlobalView` d'un cran : le Directeur Général en fait partie. Il est
 * délibérément hors de la vue globale (il ne supervise pas les validations de tout le monde, il
 * ne lit pas les Drive privés), mais sur les décisions d'ENTREPRISE — arbitrer un recrutement,
 * choisir entre deux candidats — il est précisément la personne qu'on appelle « le PDG ».
 *
 * Sert d'OUTREPASSE, jamais de raccourci : la chaîne de validation d'un recrutement est
 * calculée sur l'organigramme réel, et son dernier échelon est le vrai sommet, quel que soit son
 * rôle applicatif. Ce prédicat ne fait que permettre de trancher quand un maillon est absent —
 * exactement la période où les demandes s'accumulent.
 */
export function isTopManagement(u: UserRole | RoleBearer): boolean {
  const tops: UserRole[] = ["SUPER_ADMIN", "DIRECTION", "GENERAL_MANAGER"];
  if (typeof u === "string") return tops.includes(u);
  return tops.includes(u.role) || (u.secondaryRole != null && tops.includes(u.secondaryRole));
}

/**
 * ═══════════════════════════════════════════════════════════
 * LES MISSIONS D'ADAM SONT RÉSERVÉES AU SUPER ADMIN — décision de la Direction (09/2026).
 *
 * Une mission est un moteur durable : elle planifie, exécute, attend, relance, écrit et notifie
 * SANS session, au nom de son propriétaire, pendant des jours. Une surveillance (`watch_entity`)
 * est le même moteur avec une seule règle. La Direction a tranché : ce pouvoir-là n'appartient
 * qu'au compte souverain. Tout le reste d'Adam — lire, agir sur confirmation, rappels datés,
 * tâches, engagements — reste ouvert selon les droits ordinaires.
 *
 * ── UN PRÉDICAT, ET UN SEUL ─────────────────────────────────────────────────────────
 *
 * Écrans (`/centre-de-missions`, `/missions/<id>`), actions serveur, outils de conversation,
 * entrée de menu, moteur (`lancerMission`, `creerSurveillance`), interrupteur et battement le
 * lisent tous ICI. Deux copies de « qui peut » finiraient par diverger, et le symptôme serait un
 * écran qui montre une mission qu'une action refuse — ou l'inverse (§118.5, §118.71).
 *
 * ── POURQUOI LE RÔLE PRINCIPAL, ET LUI SEUL ─────────────────────────────────────────
 *
 * `hasGlobalView` accepte un rôle secondaire : voir tout est une casquette qu'on prête. Piloter
 * un moteur autonome au nom d'un compte n'en est pas une : le Super Admin est un COMPTE, pas une
 * fonction déléguée, et une casquette secondaire ne l'ouvre pas.
 *
 * ── CE QUE LA RÈGLE FAIT DES MISSIONS DÉJÀ LANCÉES PAR D'AUTRES ────────────────────────
 *
 * Le battement relit le propriétaire à chaque passage (§118.119b) : une mission dont le
 * propriétaire n'est pas Super Admin passe en PAUSE — jamais supprimée, avec son motif au
 * journal — parce qu'une planification ne doit pas être une permission qui survit à la règle.
 * ═══════════════════════════════════════════════════════════
 */
export function peutPiloterMissionsAdam(u: UserRole | RoleBearer): boolean {
  return (typeof u === "string" ? u : u.role) === "SUPER_ADMIN";
}

/** Le refus, écrit UNE fois — écran, action, outil et moteur disent la même phrase. */
export const REFUS_MISSIONS_ADAM = "Les missions et surveillances d'Adam sont réservées au Super Admin.";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * ADAM N'EST VISIBLE QUE DU SUPER ADMIN — décision de la Direction (09/2026, §118.153).
 *
 * « Adam ne doit être visible par personne sauf le super admin ; Adam en tant que chief of staff
 * est en pause de développement. » L'assistant de conversation, le bureau du chief of staff, la
 * voix, le brief du matin et la question posée depuis la palette sont UN seul produit : le
 * masquer d'un côté et le laisser de l'autre ferait une porte fermée à côté d'une porte ouverte
 * (§118.71). Menu, pages, points d'entrée d'API, voix et brief lisent CE prédicat.
 *
 * La règle est celle des missions (le rôle PRINCIPAL, jamais une casquette secondaire), et elle
 * l'ÉLARGIT : les missions sont une partie d'Adam. Ce qui reste ouvert à tous est ce qui n'est PAS
 * Adam — les écrans de l'ERP, et les fonctions d'IA qu'un écran appelle pour son propre compte
 * (OCR, transcription d'un rapport terrain, fabrique de documents depuis un bouton).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export function peutVoirAdam(u: UserRole | RoleBearer): boolean {
  return peutPiloterMissionsAdam(u);
}

/**
 * L'ASSISTANT IA EST-IL OUVERT À CETTE PERSONNE ? Le module `ASSISTANT_IA` en VUE — le Super Admin
 * l'a d'office, les autres seulement si l'accès leur est ouvert (Administration › Accès). Un droit
 * qui ne tiendrait qu'à un intérim ne compte pas : l'assistant parle au nom de son utilisateur.
 */
export function peutUtiliserAssistantIA(u: SessionUser): boolean {
  return userCan(u, "ASSISTANT_IA", "VIEW") && !estPrete(u, "ASSISTANT_IA", "VIEW");
}

/** Le refus, écrit une fois — page, actions et confirmation disent la même phrase. */
export const REFUS_ASSISTANT_IA = "L'assistant ne vous est pas ouvert.";

/** Le refus, écrit UNE fois — une action serveur d'Adam appelée hors de son écran dit cette phrase. */
export const REFUS_ADAM = "Adam est réservé au Super Admin.";

/** L'utilisateur porte-t-il ce rôle, en **principal OU en secondaire** ? */
export function hasRole(u: RoleBearer, role: UserRole): boolean {
  return u.role === role || u.secondaryRole === role;
}

/**
 * Superviseur Regulatory : le **Super Admin** (toujours) OU un rôle **configuré en
 * Administration** (`AppSetting.regulatorySupervisorRoles`), porté en principal OU
 * secondaire. Il fixe la **priorité** et les **dates cibles** des dossiers, reçoit les
 * notifications (nouveau dossier à prioriser / dossier déposé) et peut **demander des
 * mises à jour de statut**. Les rôles sont passés depuis les réglages (pas en dur).
 */
export function isRegulatorySupervisor(u: RoleBearer, supervisorRoles: string[]): boolean {
  if (u.role === "SUPER_ADMIN") return true;
  return supervisorRoles.includes(u.role) || (u.secondaryRole != null && supervisorRoles.includes(u.secondaryRole));
}

/** Filtre Prisma « porte l'un de ces rôles » — principal **OU secondaire**. À utiliser
 *  pour TOUTE sélection d'utilisateurs par rôle (notifications, candidats désignables,
 *  pharmacien PRIM, annuaires…), sinon un rôle attribué en secondaire est ignoré. */
/**
 * Les rôles dont la matrice donne au moins la VUE sur un module.
 *
 * Sert à dresser « les personnes concernées par X » sans deviner : c'est la même matrice qui
 * gouverne l'accès à l'écran, on ne réinvente pas une liste en parallèle qui divergerait au
 * premier réglage.
 */
export function rolesWithModule(module: Module, action: Action = "VIEW"): UserRole[] {
  return (Object.keys(PERMISSIONS) as UserRole[]).filter((r) => (PERMISSIONS[r][module] ?? []).includes(action));
}

export function anyRoleFilter(roles: UserRole[]): Prisma.UserWhereInput {
  return { OR: [{ role: { in: roles } }, { secondaryRole: { in: roles } }] };
}

/**
 * GOUVERNANCE GLOBALE des **enveloppes budgétaires** (créer / supprimer une enveloppe,
 * régler le budget total et surtout DÉCIDER QUI voit ou gère chaque enveloppe) :
 * **strictement le Super Admin**.
 *
 * On NE dérive PLUS ce pouvoir d'un droit de module. Auparavant `BUDGETS:DELETE`
 * suffisait — or `DELETE` fait partie du bundle `MANAGE` (porté par le rôle
 * Finance/Budget, et cochable dans la matrice d'accès quand l'admin ouvre le module) :
 * quiconque « gérait » le module devenait de facto gouverneur et voyait / gérait
 * TOUTES les enveloppes, court-circuitant les listes d'accès par enveloppe (fuite).
 *
 * La délégation se fait désormais **par enveloppe**, granulaire et stricte, via ses
 * listes `managerRoles`/`managerUserIds` (gestion du contenu) et
 * `accessRoles`/`accessUserIds` (consultation). Une personne non listée sur une
 * enveloppe — quel que soit son droit sur le module Budget — ne la voit pas.
 */
export function canManageEnvelopes(user: SessionUser): boolean {
  return user.role === "SUPER_ADMIN";
}

/** Listes d'accès d'une enveloppe (visualisation + gestion déléguée). Toutes optionnelles. */
export interface EnvelopeAccessBearer {
  accessRoles?: string[];
  accessUserIds?: string[];
  managerRoles?: string[];
  managerUserIds?: string[];
  /** « MARKETING » / « REGULATORY » / « OPERATIONS » = enveloppe d'un pôle (`lib/budget/domaines.ts`). Absent = générale. */
  domaine?: string | null;
}

/** Le droit du module de budget d'un pôle — lu sans lever d'erreur sur un utilisateur de test sans accès résolu. */
export function peutBudgetDuPole(user: SessionUser, pole: DomainePole, action: Action): boolean {
  return user.access?.modules?.get(DOMAINES[pole].module)?.actions.has(action) ?? false;
}

/** Le droit du module Budget Marketing (`peutBudgetDuPole` pour le pôle Marketing). */
export function peutBudgetMarketing(user: SessionUser, action: Action): boolean {
  return peutBudgetDuPole(user, "MARKETING", action);
}

/** L'enveloppe est tenue par un pôle, et la personne porte le geste demandé sur le module de budget de CE pôle. */
function droitDuPole(user: SessionUser, env: EnvelopeAccessBearer, action: Action): boolean {
  const pole = poleDe(env);
  return pole !== null && peutBudgetDuPole(user, pole, action);
}

/**
 * GESTION du CONTENU d'une enveloppe précise (catégories, allocations, dépenses budgétaires) :
 * un gestionnaire global OU une personne/rôle que l'admin a explicitement désigné(e) sur CETTE
 * enveloppe. Ne confère PAS le droit de modifier l'enveloppe elle-même (montant, période, accès) —
 * cela reste réservé à `canManageEnvelopes`.
 *
 * BUDGETS DES PÔLES (08/10) : une enveloppe MARKETING, REGULATORY ou OPERATIONS se gère aussi par le droit « Modifier »
 * du module de budget de SON pôle — le pôle n'a pas à être listé enveloppe par enveloppe, et le droit d'un pôle ne
 * touche jamais l'enveloppe d'un autre.
 */
export function canManageEnvelope(user: SessionUser, env: EnvelopeAccessBearer): boolean {
  return canManageEnvelopes(user) || (env.managerRoles ?? []).includes(user.role) || (env.managerUserIds ?? []).includes(user.id)
    || droitDuPole(user, env, "UPDATE");
}

/**
 * VISUALISATION d'une enveloppe : quiconque peut la gérer (global ou délégué) OU à qui l'admin
 * a ouvert la consultation (par rôle ou nommément). Défaut = invisible (encadrement strict).
 * Une enveloppe de pôle se lit aussi par le droit « Voir » du module de budget de son pôle.
 */
export function canViewEnvelope(user: SessionUser, env: EnvelopeAccessBearer): boolean {
  return canManageEnvelope(user, env) || (env.accessRoles ?? []).includes(user.role) || (env.accessUserIds ?? []).includes(user.id)
    || droitDuPole(user, env, "VIEW");
}

/**
 * GOUVERNANCE d'une enveloppe de PÔLE (la créer, régler son montant / sa période, la retirer) : le Super Admin, ou le
 * titulaire du geste correspondant sur le module de budget du pôle (Créer, Modifier, Supprimer). Une enveloppe générale
 * — ou celle d'un autre pôle — reste hors de portée. Les LISTES D'ACCÈS ne sont jamais concernées : Super Admin seulement.
 */
export function canGovernPoleEnvelope(user: SessionUser, pole: DomainePole, action: "CREATE" | "UPDATE" | "DELETE", env?: EnvelopeAccessBearer): boolean {
  if (canManageEnvelopes(user)) return true;
  if (env && poleDe(env) !== pole) return false;
  return peutBudgetDuPole(user, pole, action);
}

/** `canGovernPoleEnvelope` pour le pôle Marketing. */
export function canGovernMarketingEnvelope(user: SessionUser, action: "CREATE" | "UPDATE" | "DELETE", env?: EnvelopeAccessBearer): boolean {
  return canGovernPoleEnvelope(user, "MARKETING", action, env);
}

// ─────────── Catégories (espaces partagés) du Drive ───────────
/**
 * Une « catégorie » de Drive (ex. « Promotion Médicale ») est un espace partagé présenté en
 * onglet à côté de « Drive » et « Documents ». Son accès est encadré EXACTEMENT comme une
 * enveloppe budgétaire : rôles/personnes en CONSULTATION (accès) et rôles/personnes
 * GESTIONNAIRES (déposer, organiser, supprimer, régler les accès).
 */
export interface DriveSpaceAccessBearer {
  accessRoles?: string[];
  accessUserIds?: string[];
  managerRoles?: string[];
  managerUserIds?: string[];
}

/**
 * Peut CRÉER une catégorie de Drive : le Super Admin, ou un rôle que le Super Admin a
 * explicitement autorisé (réglage `driveSpaceCreatorRoles`, configuré en Administration).
 */
export function canCreateDriveSpace(user: SessionUser, creatorRoles: string[]): boolean {
  return user.role === "SUPER_ADMIN" || creatorRoles.includes(user.role);
}

/**
 * GESTION d'une catégorie (déposer/organiser/supprimer des fichiers, régler ses accès,
 * la renommer) : Super Admin, ou un rôle/personne « gestionnaire » désigné sur CETTE
 * catégorie. Le créateur y est ajouté d'office (managerUserIds).
 */
export function canManageDriveSpace(user: SessionUser, space: DriveSpaceAccessBearer): boolean {
  return user.role === "SUPER_ADMIN" || (space.managerRoles ?? []).includes(user.role) || (space.managerUserIds ?? []).includes(user.id);
}

/**
 * VISUALISATION d'une catégorie : quiconque peut la gérer OU à qui la consultation est
 * ouverte (par rôle ou nommément). Défaut = invisible (encadrement strict, comme les enveloppes).
 */
export function canViewDriveSpace(user: SessionUser, space: DriveSpaceAccessBearer): boolean {
  return canManageDriveSpace(user, space) || (space.accessRoles ?? []).includes(user.role) || (space.accessUserIds ?? []).includes(user.id);
}

// ─────────── Demandes à Regulatory (émission → prise en charge) ───────────
/** Role-default check (baseline, ignores per-user overrides). */
export function can(role: UserRole, module: Module, action: Action): boolean {
  return PERMISSIONS[role]?.[module]?.includes(action) ?? false;
}

/**
 * QUI VOIT TOUT LE BUREAU DU SECRÉTARIAT, au-delà de ses propres demandes.
 *
 * Ceux qui PAIENT et ceux qui CONTRÔLENT : une mission chauffeur, un achat de fournitures, une
 * prestation, un visa d'invité finissent tous en décaissement ou au dossier du personnel. Ne
 * montrer au DRH et aux Finances que « leurs » demandes revenait à leur faire valider des
 * dépenses dont ils ne voyaient ni l'origine, ni les pièces, ni le circuit.
 *
 * Il faut TENIR le module, pas seulement le lire : une lecture des RH accordée à quelqu'un pour
 * consulter un organigramme n'ouvre pas le courrier de toute l'entreprise.
 *
 * Portée de LECTURE uniquement — le bureau reste tenu par l'assistante de direction. Voir n'est
 * pas instruire.
 */
/**
 * L'ACCÈS AU MODULE RECRUTEMENT — dicté par l'ORGANIGRAMME, pas par une liste de rôles.
 *
 * « Chaque directeur de département a le droit de demander un recrutement » : la condition est
 * FACTUELLE (diriger un département), pas nominale. Un « Responsable Logistique » qui ne dirige
 * rien n'a pas à demander de poste ; quelqu'un dont le rôle ne dit rien de particulier mais qui
 * tient un service en a besoin. Écrire une liste de rôles serait donc faux dans les deux sens, et
 * fausse dès la première réorganisation.
 *
 * L'ADJOINT compte comme le responsable : c'est lui qui tient le service quand l'autre est
 * absent, et un recrutement ne s'arrête pas pendant les congés du directeur.
 *
 * Les RH obtiennent le module ENTIER : ce sont eux qui instruisent, publient et intègrent.
 *
 * Et TOUT LE MONDE peut demander (Direction, 07/10 — « n'importe qui peut demander un nouveau
 * recrutement ») : VIEW + CREATE + UPLOAD, portée ASSIGNED — on voit ce dont on est partie, rien
 * d'autre. Le chef de département garde son jeu plus large, les RH le module entier.
 *
 * Fonction PURE — les faits (dirige-t-il un département ? tient-il les RH ?) sont établis par
 * l'appelant ; la règle, elle, est ici et se teste.
 */
export function recruitmentAccessFor(caps: {
  headsDepartment: boolean;
  rhCanUpdate: boolean;
}): { actions: Action[]; scope: AccessScope } {
  if (caps.rhCanUpdate) return { actions: [...MANAGE], scope: "ALL" };
  // Le demandeur voit SES demandes — pas celles des autres départements. Ce qu'un directeur
  // recrute ailleurs ne le regarde pas, et une fourchette de rémunération est une information
  // sensible qui n'a aucune raison de circuler entre pairs.
  if (caps.headsDepartment) return { actions: ["VIEW", "CREATE", "UPDATE", "UPLOAD", "EXPORT"], scope: "ASSIGNED" };
  // N'IMPORTE QUI PEUT DEMANDER UN RECRUTEMENT (Direction, 07/10) — la demande part à son N+1 et remonte
  // jusqu'au DG. Demander, joindre sa fiche de poste, et voir CE dont on est partie (`recruitmentScope` :
  // ses demandes, celles qu'on valide ou qu'on suit) : rien de plus. Un blocage dans la console prime.
  return { actions: ["VIEW", "CREATE", "UPLOAD"], scope: "ASSIGNED" };
}

export function seesWholeSecretariat(caps: { rhCanUpdate: boolean; financeCanUpdate: boolean }): boolean {
  return caps.rhCanUpdate || caps.financeCanUpdate;
}

/** Default row scope for a role on a module (ALL vs only assigned rows). */
export function defaultScope(role: UserRole, module: Module): AccessScope {
  if (hasGlobalView(role)) return "ALL";
  // Drive defaults to per-user scope: one only sees one's own and shared files.
  if (module === "DRIVE") return "ASSIGNED";
  // Admin requests : ceux qui PILOTENT le secrétariat les voient toutes (ALL) — l'Assistante
  // de Direction, et les deux directions qui gèrent le module. Les autres ne voient que les
  // leurs (l'admin peut élargir via un override).
  if (module === "ADMIN_REQUESTS") {
    return (["DIRECTION_ASSISTANT", "GENERAL_MANAGER", "OPERATIONS_DIRECTOR"] as UserRole[]).includes(role) ? "ALL" : "ASSIGNED";
  }
  // Information médicale : le pharmacien responsable voit tout ; les autres (Direction
  // exceptée via hasGlobalView) ne voient que les déclarations où une pièce leur est demandée.
  // Le Directeur des Opérations, qui tranche tout ce que le pharmacien fait valider, voit tout aussi.
  if (module === "MEDICAL_INFO") return role === "MEDICAL_INFO_PHARMACIST" || role === "OPERATIONS_DIRECTOR" ? "ALL" : "ASSIGNED";
  // Directives : chacun ne voit que celles qui le concernent (la Direction voit tout via ALL).
  if (module === "DIRECTIVES") return "ASSIGNED";
  // Demandes de support : chacun ne voit que ce qu'il a émis / reçu (rôle visé) / pris en charge.
  if (module === "SUPPORT") return "ASSIGNED";
  // Dossiers de suivi : chacun ne voit que les dossiers créés / dont il est responsable / où il participe.
  if (module === "DOSSIERS") return "ASSIGNED";
  // Pharmacovigilance (Direction, 06/10) : la boîte entière à qui tient Regulatory ; les autres (le KAM qui signale)
  // ne lisent que leurs signalements et les cas où on les a ajoutés.
  if (module === "PHARMACOVIGILANCE") return PERMISSIONS[role]?.REGULATORY?.includes("VIEW") ? "ALL" : "ASSIGNED";
  const assigned: Partial<Record<Module, UserRole[]>> = {
    REGULATORY: ["REGULATORY_ASSISTANT"],
    // Le pipeline suit la portée de Regulatory (Direction, 08/10) : l'assistante n'y voit que les dossiers où elle est nommée.
    REGULATORY_PIPELINE: ["REGULATORY_ASSISTANT"],
    SALES: ["SALES_USER"],
    MEDICAL: ["MEDICAL_DELEGATE"],
    // Rapports terrain : le délégué ne voit QUE les siens ; le National Sales (superviseur
    // national) est volontairement absent → portée ALL, il voit tous les rapports des délégués.
    FIELD_REPORTS: ["MEDICAL_DELEGATE"],
    CONGRESS_INTERNATIONAL: ["MEDICAL_DELEGATE"],
    CONGRESS_NATIONAL: ["MEDICAL_DELEGATE"],
    // Matériel promotionnel (§118.153) : le délégué et le superviseur national DEMANDENT — ils
    // voient leurs dossiers, et ceux où le circuit les attend s'ouvrent par la règle du dossier.
    PROMO_MATERIAL: ["MEDICAL_DELEGATE", "NATIONAL_SALES"],
    // Stock promotionnel (§118.164) : la force de vente voit SON stock et celui de son équipe ;
    // les autres porteurs du module (Direction, Direction Marketing, directeur des opérations,
    // Finances) ont la vue globale. La console élargit ou resserre personne par personne.
    PROMO_STOCK: ["MEDICAL_DELEGATE", "NATIONAL_SALES", "MEDICAL_PROMOTION_MANAGER"],
    // Sponsoring (audit 360°, I4) : le délégué DEMANDE et ne voit que ses demandes ; le National
    // Sales, absent, les voit toutes — c'est lui qui en instruit l'étape préliminaire.
    SPONSORING: ["MEDICAL_DELEGATE"],
    // Segmentation Studio : le KAM ne voit et ne renseigne que SON panel (secteur ∪ rattachement).
    SEGMENTATION: ["MEDICAL_DELEGATE"],
  };
  return assigned[module]?.includes(role) ? "ASSIGNED" : "ALL";
}

/**
 * Résout le MODULE d'une demande de validation — pour l'accès TEMPORAIRE accordé au
 * validateur. D'abord via le libellé stocké (l'option de navigation choisie à la
 * création, ex. « PCH — Marchés »), sinon via l'URL de l'objet lié (préfixe de route
 * le plus spécifique, ex. `/pch/123` → PCH). Renvoie null si rien de fiable.
 */
/**
 * Toutes les destinations connues : entrées de menu ET leurs ONGLETS. Depuis que plusieurs
 * modules se présentent en onglets sous une entrée unique (Ventes & Marchés = Ventes ·
 * Logistique · PCH, Ad & Pro, Budgets, RH…), l'onglet est le seul endroit où vit le lien entre
 * une route et son module. Ignorer les onglets ferait perdre l'accès temporaire d'un validateur
 * sur tout module fusionné.
 */
const NAV_TARGETS: { href: string; module: Module; label: string }[] = NAVIGATION.flatMap((n) => [
  { href: n.href, module: n.module, label: n.label },
  ...(n.tabs ?? []).map((t) => ({ href: t.href, module: t.module, label: t.label })),
  // LES SOUS-MODULES (Ressources humaines, Direction 06/10) : leur route ET leurs chemins rattachés disent leur module —
  // « /rh/conges » est aux Demandes RH, pas au module RH du parent.
  ...(n.children ?? []).flatMap((c) => [c.href, ...(c.match ?? [])].map((href) => ({ href, module: c.module, label: c.label }))),
]);

function moduleFromLink(link: string): Module | null {
  const path = link.split(/[?#]/)[0];
  const byHref = [...NAV_TARGETS]
    .filter((n) => n.href !== "/")
    .sort((a, b) => b.href.length - a.href.length) // route la plus spécifique d'abord
    .find((n) => path === n.href || path.startsWith(`${n.href}/`));
  return byHref?.module ?? null;
}

/**
 * LES LIBELLÉS RÉEMPLOYÉS — un nom de menu qui a désigné un AUTRE module.
 *
 * « Projets » a nommé Pilotage (les sujets) jusqu'au renommage de §118.163 ; il ne nomme plus que
 * le registre BD. Une demande de validation libellée « Projets » ne dit donc pas, par son nom,
 * lequel des deux elle vise : seul le LIEN le dit. Sans lien, on n'ouvre AUCUN module sur la foi du
 * nom. L'ancienne lecture (Pilotage) est déjà ouverte à tous les rôles — mesuré, 19 sur 19 —, donc
 * rien ne se perd ; la nouvelle (le registre BD, fermé par défaut à 13 rôles) aurait été un
 * élargissement silencieux accordé au validateur d'un sujet. La ligne liée, elle, reste accordée,
 * et la page « Demandes de validations » aussi : il peut toujours décider.
 */
const LIBELLES_REEMPLOYES: ReadonlySet<string> = new Set(["Projets"]);

function moduleFromValidation(moduleLabel: string | null, link: string | null): Module | null {
  let fromLabel: Module | null = null;
  if (moduleLabel) {
    const byLabel = NAV_TARGETS.find((n) => n.label === moduleLabel);
    if (byLabel) fromLabel = byLabel.module;
    // Libellé d'AVANT un renommage de menu : une demande créée sous l'ancien nom doit continuer
    // d'ouvrir le même module à son validateur.
    else if (NAV_LEGACY_LABELS[moduleLabel]) fromLabel = NAV_LEGACY_LABELS[moduleLabel];
    else {
      const up = moduleLabel.trim().toUpperCase();
      if ((MODULES as readonly string[]).includes(up)) fromLabel = up as Module;
    }
  }
  // Le libellé générique « Demandes de validations » (→ VALIDATIONS) n'est jamais la
  // cible réelle : dans ce cas l'URL de l'objet lié est le signal fiable.
  const fromLink = link ? moduleFromLink(link) : null;
  // QUAND LES DEUX DÉSIGNENT DEUX MODULES, LE LIEN L'EMPORTE (§118.163). Un libellé de menu est
  // un NOM, et un nom se renomme ou se réemploie : « Projets » désignait Pilotage jusqu'à ce que
  // Pilotage devienne « Sujets » et que « Projets » ne nomme plus que le registre BD. Une demande
  // ancienne libellée « Projets » aurait alors ouvert au validateur un module sans rapport avec
  // ce qu'il doit décider. Le lien, lui, désigne l'objet même qu'il doit ouvrir — c'est la seule
  // raison d'être de cet accès temporaire.
  if (fromLabel && fromLink && fromLabel !== fromLink) return fromLink;
  if (moduleLabel && LIBELLES_REEMPLOYES.has(moduleLabel.trim())) return fromLink;
  if (fromLabel && fromLabel !== "VALIDATIONS") return fromLabel;
  return fromLink ?? fromLabel;
}

// ───────────────────────── Effective (resolved) access ─────────────────────────

export interface EffectiveModuleAccess {
  actions: Set<Action>;
  scope: AccessScope;
  /**
   * LES SECTIONS qu'un accès PERSONNALISÉ ouvre à l'intérieur du module — aujourd'hui les
   * annuaires cochés sur le module Annuaires (§118.147). Absent = aucune section en plus.
   */
  sections?: ReadonlySet<string>;
}
export interface EffectiveAccess {
  modules: Map<Module, EffectiveModuleAccess>;
  rowGrants: Map<EntityType, Set<string>>;
  /** Rôle secondaire résolu (toujours renseigné par `getAccess` ; optionnel pour les
   *  fabriques de test qui construisent un accès minimal). */
  secondaryRole?: UserRole | null;
  /** Rôle principal résolu EN DIRECT depuis la base (le JWT fige le rôle au login →
   *  il peut être périmé après un changement de rôle). Utilisé par la session comme
   *  rôle faisant autorité. Optionnel : les fabriques de test peuvent l'omettre. */
  role?: UserRole;
  /** PIPELINE — voit-il les dossiers VERROUILLÉS ? Réglé en Administration, résolu ici une
   *  fois par requête parce que le verrou est consulté par des fonctions SYNCHRONES
   *  (`scopeRegulatory`, `regulatoryLockWhere`) qui ne peuvent pas lire la base.
   *  Optionnel : les fabriques de test construisent un accès minimal. */
  pipelineView?: boolean;
  /** PIPELINE — tient-il le CADENAS (ouvrir un dossier = le publier à toute l'entreprise) ? */
  pipelineManage?: boolean;
  /** CENTRE DE PAIEMENT — a-t-il un SIÈGE NOMMÉ ? Une désignation personnelle, indépendante du
   *  rôle, qui n'ouvre QUE le centre (voir `PaymentCentreSeat`). Résolu ici pour la même raison
   *  que le pipeline : `sitsOnPaymentCentre` est SYNCHRONE et appelée partout, elle ne peut pas
   *  lire la base. Optionnel : les fabriques de test construisent un accès minimal. */
  paymentCentreSeat?: boolean;
  /**
   * LES INTÉRIMS QUI ÉLARGISSENT CET ACCÈS AUJOURD'HUI (§118.196, lot E4 — audit 360°, M13) — qui l'on
   * remplace, jusqu'à quand, quels modules en viennent réellement. Un droit prêté qui ne se voit nulle
   * part ne se distingue pas d'un droit propre : le bandeau d'intérim (coque) le dit. Optionnel : les
   * fabriques de test construisent un accès minimal.
   */
  interims?: readonly InterimEnCours[];
  /**
   * Les actions que SEUL un intérim donne — celles que la personne ne détenait pas elle-même. Les gestes
   * de DROITS (ouvrir l'accès d'un tiers à une entité, fermer un compte, désigner ou valider un intérim)
   * les lisent (`estPrete`) : un droit prêté ne s'accorde pas à son tour.
   */
  pretes?: ReadonlyMap<Module, ReadonlySet<Action>>;
}

/** Un intérim en cours, vu de l'intérimaire (§118.196). */
export interface InterimEnCours {
  absentId: string;
  absentNom: string;
  jusquau: Date;
  /** Les modules réellement ouverts par cet intérim (ceux que la console ne bloque pas chez l'intérimaire). */
  modules: Module[];
}
export interface SessionUser {
  id: string;
  role: UserRole;
  /** « Autre rôle » : fonction secondaire cumulée (réglée par le Super Admin). */
  secondaryRole?: UserRole | null;
  access: EffectiveAccess;
}

/** Une ligne d'accès PERSONNALISÉ telle que la console l'écrit — les seules colonnes que la règle lit. */
export type LigneAccesAttribue = Pick<UserAccess,
  "module" | "canView" | "canCreate" | "canUpdate" | "canDelete" | "canValidate" | "canExport" | "canUpload" | "scope" | "sections">;

/**
 * L'ACCÈS ATTRIBUÉ — ce que le rôle, l'« autre rôle » et la console donnent à une personne, AVANT tout
 * accès implicite (validation en attente, département dirigé, dossier porté, partage, siège, intérim).
 *
 * `getAccess` en part ; l'INTÉRIM y lit ce que l'absent DÉTIENT (§118.196, lot E4 — audit 360°, M13).
 * Écrite une fois : un second calcul « de ce qu'une personne a » finirait par ne plus voir le blocage que
 * l'administrateur vient de poser (§118.5), et l'intérimaire hériterait du module qu'on a retiré à
 * l'absent. PURE : aucune lecture de base.
 */
export function accesAttribue(
  role: UserRole,
  secondaryRole: UserRole | null,
  overrides: readonly LigneAccesAttribue[],
): { modules: Map<Module, EffectiveModuleAccess>; blockedModules: Set<Module> } {
  const overrideMap = new Map(overrides.map((o) => [o.module as Module, o]));
  const modules = new Map<Module, EffectiveModuleAccess>();
  // Modules explicitement BLOQUÉS par l'administrateur. On les retient pour que les accès
  // IMPLICITES posés plus bas (porter un dossier, se voir partager une catégorie…) ne défassent
  // pas une décision prise à la main — un blocage qui se lèverait tout seul serait pire
  // qu'inutile : il serait imprévisible.
  const blockedModules = new Set<Module>();

  for (const module of MODULES) {
    // UN MODULE RETIRÉ N'ENTRE PAS DANS L'ACCÈS EFFECTIF — et c'est LA garde qui compte.
    // `userCan` répond alors non partout d'un seul coup : écrans, actions serveur, routes
    // d'API et outils d'Adam. Le masquage du menu ne fait que rendre l'interface cohérente ;
    // s'il était seul, l'assistant continuerait de créer des projets dans un module retiré.
    // Voir `lib/modules-retired.ts`.
    if (isRetiredModule(module)) continue;
    const ov = overrideMap.get(module);
    // Override « BLOQUÉ » (ligne présente, canView=false) : **absolu**. Il retire le
    // module quoi qu'il arrive — y compris par-dessus un défaut de rôle PRINCIPAL **ou
    // SECONDAIRE**. C'est ce qui rend l'action de l'admin (« bloquer X à Untel »)
    // réellement effective en temps réel, même si son « autre rôle » l'accorde.
    const blocked = !!ov && !ov.canView;
    if (blocked) blockedModules.add(module);
    const actions = new Set<Action>();
    let scope: AccessScope = "ASSIGNED";
    let hasView = false;

    const addRoleDefaults = (r: UserRole) => {
      const def = PERMISSIONS[r]?.[module];
      if (def?.includes("VIEW")) {
        hasView = true;
        for (const a of def) actions.add(a);
        if (defaultScope(r, module) === "ALL") scope = "ALL";
      }
    };

    // Rôle principal : l'override par utilisateur (s'il existe) REMPLACE ses défauts.
    if (ov) {
      if (ov.canView) {
        hasView = true;
        actions.add("VIEW");
        if (ov.canCreate) actions.add("CREATE");
        if (ov.canUpdate) actions.add("UPDATE");
        if (ov.canDelete) actions.add("DELETE");
        if (ov.canValidate) actions.add("VALIDATE");
        if (ov.canExport) actions.add("EXPORT");
        if (ov.canUpload) actions.add("UPLOAD");
        if (ov.scope === "ALL") scope = "ALL";
      }
    } else {
      addRoleDefaults(role);
    }

    // Un « accès personnalisé » (override) ne doit pas RÉTRÉCIR SILENCIEUSEMENT la
    // portée qu'un rôle possède NATIVEMENT : si le rôle voit tout le module par défaut
    // (ex. National Sales voit TOUTES les demandes de congrès à pré-valider), on conserve
    // la portée ALL même quand l'admin a coché « accès personnalisé » sans (re)choisir
    // « tout » dans le sélecteur de portée (qui retombe sinon sur ASSIGNED). Symétrique
    // de la règle du rôle secondaire ci-dessous.
    if (ov?.canView && defaultScope(role, module) === "ALL") scope = "ALL";

    // Rôle SECONDAIRE : ses capacités se cumulent (union des actions, portée la plus
    // large) — SAUF si l'admin a explicitement **BLOQUÉ** ce module pour ce compte :
    // un blocage prime sur l'« autre rôle » (sinon on ne pourrait jamais retirer un
    // module à quelqu'un qui le détient via son rôle secondaire). Hors blocage, un
    // ancien réglage « accès personnalisé » ne doit pas neutraliser silencieusement
    // l'« autre rôle » attribué ensuite (ex. un National Sales en secondaire doit voir
    // TOUTES les demandes de congrès à pré-valider).
    if (!blocked && secondaryRole && secondaryRole !== role) addRoleDefaults(secondaryRole);

    // LES SECTIONS ne viennent QUE d'un accès personnalisé : un rôle n'en porte pas, et un
    // accès bloqué n'en ouvre aucune. Les clés sont relues par la règle pure — une clé
    // inconnue en base est écartée, jamais interprétée.
    const sections = ov?.canView ? lireSections(ov.sections) : [];
    if (hasView && !blocked) modules.set(module, { actions, scope, ...(sections.length ? { sections: new Set(sections) } : {}) });
  }
  return { modules, blockedModules };
}

/**
 * Resolve a user's effective access: per-user UserAccess overrides win over the
 * role default for a module; row grants are loaded for assigned-scope checks.
 * Cached per request so repeated `scope*`/`userCan` calls hit the DB once.
 */
export const getAccess = perRequest(
  async (userId: string, roleHint: UserRole): Promise<EffectiveAccess> => {
    const [overrides, grants, userRow, pendingValidations, departmentsLed, standIns, appSettings, centreSeat] = await Promise.all([
      prisma.userAccess.findMany({ where: { userId } }),
      prisma.rowGrant.findMany({ where: { userId }, select: { entityType: true, entityId: true } }),
      prisma.user.findUnique({ where: { id: userId }, select: { role: true, secondaryRole: true } }),
      // Accès TEMPORAIRE de validation : étapes EN ATTENTE dont je suis le validateur.
      prisma.validationStep.findMany({
        where: { validatorId: userId, status: "PENDING", request: { status: "PENDING" } },
        select: { request: { select: { module: true, link: true, entityType: true, entityId: true } } },
      }),
      // Dirige-t-il un département ? C'est ce FAIT — et non son rôle — qui ouvre le module
      // Recrutement. L'adjoint compte : il tient le service quand le responsable est absent.
      prisma.department.count({ where: { OR: [{ head: { userId } }, { deputy: { userId } }] } }),
      // Remplace-t-il quelqu'un en congé aujourd'hui ? La délégation est bornée par les droits
      // de l'absent et s'éteint d'elle-même à la fin du congé — voir `lib/hr/stand-in.ts`.
      activeStandInsFor(userId).catch(() => []),
      // Les accès au PIPELINE (dossiers verrouillés) sont un réglage d'instance, pas un rôle :
      // le Super Admin décide qui voit le portefeuille à l'étude et qui tient le cadenas.
      // `getAppSettings` est lui-même mis en cache par requête et retombe sur ses valeurs par
      // défaut en cas de souci — le doute referme le verrou, il ne l'ouvre pas.
      getAppSettings(),
      // LE SIÈGE NOMMÉ AU CENTRE DE PAIEMENT. Une désignation PERSONNELLE, accordée une par une
      // par le Super Admin : elle n'ouvre que le centre, et rien d'autre. On la résout ici parce
      // que `sitsOnPaymentCentre` est synchrone et appelée depuis l'écran, l'action, l'assistant
      // et la recherche — lui donner une lecture de base rendrait toute la chaîne asynchrone.
      prisma.paymentCentreSeat.count({ where: { userId } }).catch(() => 0),
    ]);

    // Rôle principal résolu EN DIRECT depuis la base : le JWT fige le rôle au login, donc
    // un compte promu (ex. Délégué Médical → National Sales) garderait un accès et un
    // libellé périmés jusqu'à sa reconnexion. On prend le rôle réel de la base (repli sur
    // l'indice du JWT si l'utilisateur est introuvable — cas des fabriques de test).
    const role = (userRow?.role ?? roleHint) as UserRole;
    // « Autre rôle » : l'utilisateur CUMULE son rôle principal ET son rôle secondaire.
    const secondaryRole = userRow?.secondaryRole ?? null;

    // L'ACCÈS ATTRIBUÉ (rôle, « autre rôle », console) — la règle même où l'intérim lit ce que l'absent
    // détient (`accesAttribue`, §118.196). Les accès IMPLICITES s'y ajoutent plus bas.
    const { modules, blockedModules } = accesAttribue(role, secondaryRole, overrides);

    // ── Confidentialité STRICTE du Drive et des Projets (Dossiers) ──────────────
    // Ces deux modules sont « privés par conception » : on ne voit que SES fichiers /
    // SES projets + ceux qu'on nous a explicitement PARTAGÉS ou CONFIÉS (portée
    // ASSIGNED). Seule la **vue globale** (Super Admin / Direction) voit tout. On
    // NEUTRALISE donc toute portée « ALL » pour un rôle ordinaire — qu'elle vienne
    // d'un override de la matrice, d'un réglage hérité ou d'un rôle secondaire — afin
    // qu'un compte comme l'Assistante de Direction n'ait JAMAIS accès à l'ensemble
    // des drives / projets de la société. (La visibilité fine reste assurée par
    // `scopeDossiers` / `getDriveListing` / `resolveDriveAccess`.)
    if (!hasGlobalView({ role, secondaryRole })) {
      for (const mod of ["DRIVE", "DOSSIERS"] as const) {
        const m = modules.get(mod);
        if (m && m.scope === "ALL") m.scope = "ASSIGNED";
      }
    }

    const rowGrants = new Map<EntityType, Set<string>>();
    for (const g of grants) {
      if (!rowGrants.has(g.entityType)) rowGrants.set(g.entityType, new Set());
      rowGrants.get(g.entityType)!.add(g.entityId);
    }

    /**
     * ═══════════════════════════════════════════════════════════════════════════════════════
     * POSER UN ACCÈS IMPLICITE — jamais par-dessus un blocage explicite de l'administrateur.
     *
     * ── LE DÉFAUT QU'ON CORRIGE ────────────────────────────────────────────────────────────
     *
     * Les accès implicites posés plus bas (tenir les RH ouvre les Moyens généraux, diriger un
     * département ouvre le Recrutement, avoir une validation en attente ouvre le module visé…)
     * ignoraient `blockedModules`. Un administrateur qui RETIRAIT un module à quelqu'un dans la
     * console le voyait donc revenir au rafraîchissement suivant, sans explication : la règle
     * implicite le rendait, en silence, à chaque requête.
     *
     * Le commentaire de `blockedModules` promet pourtant l'inverse depuis toujours — « un blocage
     * qui se lèverait tout seul serait pire qu'inutile : il serait imprévisible ». La promesse
     * n'était tenue que par le siège du centre de paiement. Elle l'est maintenant partout, par
     * ce passage OBLIGÉ : plus aucun `modules.set` implicite n'existe hors de cette fonction.
     *
     * `mode` distingue les deux gestes réels : ÉLARGIR ce qu'on a déjà (le cas ordinaire) ou
     * REMPLACER (le recrutement et le pipeline calculent un accès complet, qui ne se cumule pas).
     * ═══════════════════════════════════════════════════════════════════════════════════════
     */
    const grantImplicit = (
      module: Module,
      actions: readonly Action[],
      scope: AccessScope | null,
      mode: "widen" | "replace" = "widen",
    ): boolean => {
      // LE BLOCAGE EXPLICITE PRIME, TOUJOURS. C'est la décision d'une personne, prise à la main,
      // devant l'écran des accès ; une règle automatique ne la défait pas.
      if (blockedModules.has(module)) return false;
      // UN MODULE RETIRÉ N'ENTRE PAS — pas plus par une porte implicite que par la console : la garde
      // d'`accesAttribue` serait défaite par la première validation en attente qui le nomme, ou par un
      // intérim (§118.75, §118.196).
      if (isRetiredModule(module)) return false;
      const cur = modules.get(module);
      if (!cur || mode === "replace") {
        modules.set(module, { actions: new Set<Action>(actions), scope: scope ?? "ASSIGNED" });
        return true;
      }
      for (const a of actions) cur.actions.add(a);
      // On n'élargit la portée que vers le HAUT : un accès implicite ne rétrécit jamais ce
      // qu'un rôle accorde nativement.
      if (scope === "ALL") cur.scope = "ALL";
      return true;
    };

    // ── Accès TEMPORAIRE de validation ──────────────────────────────────────────
    // Un validateur dont une étape est EN ATTENTE obtient, LE TEMPS de décider, une
    // LECTURE (VIEW/EXPORT) du module concerné + l'accès à la LIGNE liée — de sorte
    // qu'il puisse RÉELLEMENT ouvrir le document / la demande d'origine à valider.
    // Dès que l'étape est traitée (approuvée/refusée), elle n'est plus renvoyée par
    // la requête → l'accès disparaît de lui-même. Toujours en LECTURE SEULE.
    for (const s of pendingValidations) {
      const mod = moduleFromValidation(s.request.module, s.request.link);
      if (mod) grantImplicit(mod, ["VIEW", "EXPORT"], null);
      if (s.request.entityType && s.request.entityId) {
        if (!rowGrants.has(s.request.entityType)) rowGrants.set(s.request.entityType, new Set());
        rowGrants.get(s.request.entityType)!.add(s.request.entityId);
      }
    }
    // Un validateur qui a une étape EN ATTENTE doit TOUJOURS pouvoir ouvrir la page
    // « Demandes de validations » pour décider — même si son rôle n'accorde pas ce
    // module par défaut (ex. un VIEWER, ou un compte dont l'accès a été personnalisé
    // sans VALIDATIONS). Sinon `requireModule("VALIDATIONS")` le redirige et la demande
    // qui l'attend reste invisible. On garantit donc au moins la LECTURE de la page.
    if (pendingValidations.length > 0) grantImplicit("VALIDATIONS", ["VIEW"], null);

    // ── LE SIÈGE NOMMÉ OUVRE LE MODULE QU'IL SERT, ET LUI SEUL ──
    //
    // Désigner quelqu'un au centre sans lui ouvrir l'entrée de menu produirait exactement le
    // défaut qu'on corrige : un accès accordé qui ne mène nulle part, et une personne qui doit
    // connaître l'URL pour exercer un droit qu'on croit lui avoir donné.
    //
    // On accorde `PAYMENT_CENTRE` en VUE + VALIDATE, et RIEN d'autre : le siège ne donne pas les
    // Finances, ni la vue globale, ni un module de plus. Un BLOCAGE explicite de l'administrateur
    // prime, comme partout ailleurs — sinon on ne pourrait plus retirer le module à quelqu'un.
    if (centreSeat > 0) grantImplicit("PAYMENT_CENTRE", ["VIEW", "VALIDATE"], "ALL");

    // ── LES MOYENS GÉNÉRAUX NE S'OUVRENT PLUS TOUT SEULS ──────────────────────────────────
    //
    // Ce module s'accordait ICI, implicitement, à quiconque tenait les ressources humaines
    // (`RH` en écriture) — au motif que les RH pilotent la dotation des départements. C'était
    // une PORTE DÉROBÉE : la console d'administration affichait « Aucun accès » sur la ligne
    // Moyens généraux, et la personne l'avait quand même. Retirer le module depuis la console
    // ne changeait rien, et il fallait connaître cette ligne de code pour comprendre pourquoi.
    //
    // Un droit qui ne se lit pas là où on le règle n'est pas administrable. Les Moyens généraux
    // s'accordent donc comme tous les autres : par la matrice du rôle, ou nommément depuis la
    // console. Ceux qui l'avaient par ce détour le reçoivent d'un clic, et cette fois cela se
    // VOIT sur leur ligne.

    // ── LE DRH ET LES FINANCES VOIENT TOUT LE BUREAU DU SECRÉTARIAT ──
    //
    // Ce sont eux qui PAIENT et qui CONTRÔLENT ce que le secrétariat engage : une mission
    // chauffeur, un achat de fournitures, une prestation, un visa d'invité finissent tous en
    // décaissement ou en dossier du personnel. Ne leur montrer que « leurs » demandes — celles
    // qu'ils ont eux-mêmes émises — revenait à leur demander de valider des dépenses dont ils
    // ne voyaient ni l'origine, ni les pièces, ni le circuit.
    //
    // On accorde la portée ALL en LECTURE, jamais le pilotage : le bureau reste tenu par
    // l'assistante de direction. Voir n'est pas instruire.
    if (seesWholeSecretariat({
      rhCanUpdate: modules.get("RH")?.actions.has("UPDATE") ?? false,
      financeCanUpdate: modules.get("FINANCES")?.actions.has("UPDATE") ?? false,
    })) {
      grantImplicit("ADMIN_REQUESTS", ["VIEW", "EXPORT"], "ALL");
    }

    // ── LE RECRUTEMENT : TOUT LE MONDE DEMANDE, LES RH INSTRUISENT ──
    // N'importe qui peut demander un poste (Direction, 07/10) ; qui dirige un département le suit de
    // plus près ; qui tient les RH instruit tout. La règle est dans `recruitmentAccessFor` — ici on ne
    // fait que la poser, en ÉLARGISSANT, comme « Mon Équipe » ci-dessous : un rôle qui accorde déjà
    // davantage (Direction, DG) ne s'en trouve pas rétréci, et un BLOCAGE de la console prime.
    const recruitment = recruitmentAccessFor({
      headsDepartment: departmentsLed > 0,
      rhCanUpdate: modules.get("RH")?.actions.has("UPDATE") ?? false,
    });
    grantImplicit("RECRUITMENT", recruitment.actions, recruitment.scope);

    // ── LA CAMPAGNE BUDGÉTAIRE : QUI DIRIGE UN DÉPARTEMENT PRÉPARE LE BUDGET DE SON PÔLE ──
    // Un FAIT de l'organigramme (responsable ou adjoint), pas un rôle. En LECTURE et portée bornée (ASSIGNED) : l'écran
    // ne lui montre que SES pôles, jamais la vue de la Direction ni le cadrage (`lib/budget-campagne/regles.ts`).
    if (departmentsLed > 0) grantImplicit("BUDGET_CAMPAIGN", ["VIEW"], null);

    // ── « MON ÉQUIPE » SUIT L'ORGANIGRAMME, PAS LE RÔLE ──
    //
    // Encadrer n'est pas un rôle : c'est un FAIT de l'organigramme. La Direction Marketing, un
    // responsable régulatoire, un directeur commercial encadrent tous quelqu'un sans partager
    // le moindre rôle — et l'on ne peut pas prévoir dans une matrice quels rôles encadrent, ni
    // la corriger à chaque nomination.
    //
    // Le module est donc accordé à TOUT LE MONDE, et c'est la GARDE de navigation (`myTeam`,
    // dans `nav-access.ts`) qui n'affiche l'entrée qu'à ceux qui ont réellement des N-1. Ce
    // n'est pas un trou : l'écran d'une personne sans équipe ne contient rien à voir — il ne
    // lit que SES subordonnés, et elle n'en a pas.
    grantImplicit("MY_TEAM", ["VIEW"], null);

    // ── « ANNUAIRES » EST UNE PORTE, PAS UN DROIT ──
    //
    // Le concentrateur ne montre RIEN par lui-même : chacun de ses onglets est gardé par le
    // module du référentiel qu'il affiche, et un onglet interdit n'est pas rendu. Accorder la
    // porte à tout le monde ne donne donc accès à aucune donnée de plus — cela évite seulement
    // qu'un droit « Annuaires » à régler dans la console redise, en retard, ce que MEDICAL et
    // WORKSPACE décident déjà (§118.5, §118.74).
    grantImplicit("DIRECTORIES", ["VIEW"], null);

    // ── INTÉRIM D'UN CONGÉ ──
    //
    // Quelqu'un est absent, quelqu'un d'autre tient sa place : l'intérimaire reçoit, LE TEMPS DU
    // CONGÉ, les modules que l'absent a délégués — jamais plus que ce que l'absent avait
    // lui-même, jamais la suppression, et jamais ses espaces personnels (Drive, messagerie).
    //
    // La délégation s'ÉTEINT SEULE : elle n'est calculée que si le congé couvre aujourd'hui.
    // Personne n'a rien à révoquer au retour, et c'est précisément ce qui la rend sûre — un
    // accès ouvert « pour cette fois » par un administrateur, lui, ne se referme jamais.
    //
    // CE QUI SE PRÊTE se lit sur ce que l'absent DÉTIENT (`accesAttribue`), borné par la matrice de
    // son rôle principal — jamais la matrice seule (§118.196, lot E4 — audit 360°, M13) : un module
    // qu'on lui a bloqué, un accès plus étroit que son rôle, un module retiré ne passent pas. Et ce
    // qui en vient se DIT : `interims` nourrit le bandeau de la coque, `pretes` garde ce que la
    // personne ne détenait pas elle-même — les gestes de droits le lisent (`estPrete`).
    const interims: InterimEnCours[] = [];
    const pretes = new Map<Module, Set<Action>>();
    for (const intérim of standIns) {
      const ouverts: Module[] = [];
      for (const d of intérim.delegations) {
        const avant = modules.get(d.module)?.actions;
        const neufs = d.actions.filter((a) => !avant?.has(a));
        if (!grantImplicit(d.module, d.actions, null)) continue;
        ouverts.push(d.module);
        if (neufs.length > 0) {
          const s = pretes.get(d.module) ?? new Set<Action>();
          for (const a of neufs) s.add(a);
          pretes.set(d.module, s);
        }
      }
      interims.push({ absentId: intérim.absenteeUserId, absentNom: intérim.absenteeName, jusquau: intérim.endDate, modules: ouverts });
    }

    // ── PORTER UN DOSSIER RÉGLEMENTAIRE OUVRE LE MODULE ─────────────────────────
    //
    // On confie un dossier à quelqu'un depuis le tableau Regulatory, et cette personne recevait
    // la notification « Vous êtes chargé(e) de ce dossier »… dont le lien menait à une
    // redirection : son rôle n'ouvrait pas le module, donc `requireModule` la renvoyait à
    // l'accueil et `scopeRegulatory` ne lui montrait aucune ligne. On lui confiait un dossier
    // qu'elle ne pouvait ni voir ni ouvrir.
    //
    // La portée reste ASSIGNED : `scopeRegulatory` ne retient que les dossiers où elle est
    // NOMMÉE (responsable, assistante, participante, créatrice). Porter trois dossiers n'ouvre
    // pas le portefeuille de la société — et le VERROU du pipeline continue de passer avant tout.
    if (!modules.has("REGULATORY")) {
      const carried = await prisma.regulatoryProduct
        .findFirst({
          where: {
            OR: [
              { responsibleId: userId },
              { assistantId: userId },
              { assignedUsers: { some: { id: userId } } },
            ],
          },
          select: { id: true },
        })
        .catch(() => null);
      const grant = carrierAccess({
        carries: Boolean(carried),
        blocked: blockedModules.has("REGULATORY"),
        hasModule: modules.has("REGULATORY"),
      });
      if (grant) grantImplicit("REGULATORY", grant.actions, grant.scope, "replace");
    }
    // …ET PORTER UN DOSSIER VERROUILLÉ OUVRE LE PIPELINE (Direction, 08/10), à la même portée nommée : le pipeline
    // était sous Regulatory, et ce porteur-là y voyait son dossier (s'il a aussi la confidence du pipeline). La
    // scission ne le lui retire pas — un BLOCAGE de la console sur le pipeline prime, comme partout. Sans la
    // confidence, il ne voyait rien du pipeline : on ne lit alors même pas la base.
    const pipeline = pipelineAccessFor({ id: userId, role, secondaryRole }, appSettings);
    if (pipeline.view && !modules.has("REGULATORY_PIPELINE")) {
      const carriedLocked = await prisma.regulatoryProduct
        .findFirst({
          where: {
            isLocked: true,
            OR: [
              { responsibleId: userId },
              { assistantId: userId },
              { assignedUsers: { some: { id: userId } } },
            ],
          },
          select: { id: true },
        })
        .catch(() => null);
      const grant = carrierAccess({
        carries: Boolean(carriedLocked),
        blocked: blockedModules.has("REGULATORY_PIPELINE"),
        hasModule: modules.has("REGULATORY_PIPELINE"),
      });
      if (grant) grantImplicit("REGULATORY_PIPELINE", grant.actions, grant.scope, "replace");
    }

    // ── Accès IMPLICITE au module Budget quand une enveloppe est PARTAGÉE avec ce compte ──
    // Partager une enveloppe (par personne OU par rôle, en visualisation ou en gestion) doit
    // suffire à ce que le destinataire puisse OUVRIR le module Budget et l'y voir — même si son
    // rôle n'a AUCUN accès Budget par défaut (sinon la porte `requireModule("BUDGETS")` le
    // redirige et l'enveloppe partagée reste invisible). On n'accorde qu'une LECTURE ; le
    // filtrage fin (quelles enveloppes) reste assuré par `canViewEnvelope` dans les requêtes.
    if (!modules.has("BUDGETS")) {
      const roles = [role, secondaryRole].filter(Boolean) as string[];
      const shared = await prisma.budgetEnvelope
        .findFirst({
          where: {
            OR: [
              { accessUserIds: { has: userId } },
              { managerUserIds: { has: userId } },
              ...(roles.length ? [{ accessRoles: { hasSome: roles } }, { managerRoles: { hasSome: roles } }] : []),
            ],
          },
          select: { id: true },
        })
        .catch(() => null);
      if (shared) grantImplicit("BUDGETS", ["VIEW", "EXPORT"], null);
    }

    // ── Accès IMPLICITE au module Drive quand quelque chose est PARTAGÉ avec ce compte ──
    // Être membre d'une CATÉGORIE (par personne OU par rôle, consultation ou gestion), ou tenir
    // un partage NOMINATIF sur un fichier/dossier, doit suffire à OUVRIR le module Drive — même
    // si le rôle n'accorde aucun accès Drive par défaut. Sans cela, recevoir un document du Drive
    // dans la messagerie donnait un lien qui menait à un refus : l'accès existait en base, et la
    // porte du module le rendait inutile.
    // On n'accorde qu'une LECTURE du module ; le filtrage fin (quels nœuds, quels droits) reste
    // assuré par canViewDriveSpace / resolveDriveAccess / driveVisibilityWhere dans les requêtes.
    if (!modules.has("DRIVE")) {
      const roles = [role, secondaryRole].filter(Boolean) as string[];
      const [space, share] = await Promise.all([
        prisma.driveSpace
          .findFirst({
            where: {
              isArchived: false,
              OR: [
                { accessUserIds: { has: userId } },
                { managerUserIds: { has: userId } },
                ...(roles.length ? [{ accessRoles: { hasSome: roles } }, { managerRoles: { hasSome: roles } }] : []),
              ],
            },
            select: { id: true },
          })
          .catch(() => null),
        prisma.driveShare.findFirst({ where: { userId }, select: { id: true } }).catch(() => null),
      ]);
      if (space || share) grantImplicit("DRIVE", ["VIEW"], null);
    }

    // ── LE PIPELINE (dossiers VERROUILLÉS) ──────────────────────────────────────
    // Résolu ICI et non au moment de la lecture : `scopeRegulatory` et `regulatoryLockWhere`
    // sont synchrones et servent partout (tableau, recherche, sélecteurs de produits,
    // assistant). Un droit qui exigerait une requête à chaque appel ne pourrait pas y vivre.
    // (`pipeline` est résolu plus haut : le porteur d'un dossier verrouillé en dépend.)

    return {
      modules, rowGrants, secondaryRole, role,
      pipelineView: pipeline.view, pipelineManage: pipeline.manage,
      paymentCentreSeat: centreSeat > 0,
      interims, pretes,
    };
  },
);

/** Does the user's effective access permit this action on this module? */
export function userCan(user: SessionUser, module: Module, action: Action): boolean {
  return user.access.modules.get(module)?.actions.has(action) ?? false;
}

/**
 * CE DROIT NE TIENT-IL QU'À UN INTÉRIM ? (§118.196, lot E4 — audit 360°, M13)
 *
 * Un intérim prête des gestes de MÉTIER ; il ne prête pas le pouvoir d'accorder des droits. Les
 * portes qui ouvrent ou ferment un accès — l'accès d'un tiers à une entité, la fermeture d'un compte,
 * la désignation ou la validation d'un intérim — refusent un droit qui n'est que prêté : sinon
 * l'intérimaire des RH ouvrirait des entités, fermerait des comptes et validerait des intérims au nom
 * d'une personne absente, trois gestes qui survivent au retour du titulaire.
 *
 * Nommé `est…` exprès : la dérivation des contrats ne le prend pas pour une garde, et les portes
 * gardent leur `userCan(user, "RH", "UPDATE")` littéral — `porte` et `gardes` ne bougent pas.
 */
export function estPrete(user: { access: EffectiveAccess }, module: Module, action: Action): boolean {
  return user.access.pretes?.get(module)?.has(action) ?? false;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'ACCÈS PAR ANNUAIRE (§118.147) — la règle pure vit au socle (`annuaires/acces.ts`) ; ici on
 * ne fait que lui porter les faits d'une personne. UNE lecture, pour les onglets, les pages, les
 * chargeurs, les actions et la conversation : une porte qui recopierait la règle à sa façon
 * finirait par ouvrir ce qu'une autre ferme (§118.5, §118.71).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export function faitsAnnuaire(user: SessionUser): FaitsAnnuaire {
  return {
    peut: (module, geste) => userCan(user, module as Module, geste),
    sections: user.access.modules.get("DIRECTORIES")?.sections ?? new Set<string>(),
    tientPersonnesParRole: [user.role, user.secondaryRole ?? null].some((r) => r === "SUPER_ADMIN" || r === "DIRECTION"),
  };
}

/** Cette personne peut-elle faire ce geste dans cet annuaire — par son module OU par la console ? */
export function peutAnnuaire(user: SessionUser, cle: AnnuaireAccordable, geste: GesteAnnuaire): boolean {
  return regleAnnuaire(faitsAnnuaire(user), cle, geste);
}

/**
 * L'annuaire lui est-il ouvert PAR LA CONSOLE ? C'est ce qui décide de la PORTÉE des lignes : un
 * annuaire ouvert par la console s'ouvre en entier (un référentiel, pas un portefeuille), là où
 * le module garde la portée de son métier (les praticiens d'un délégué).
 */
export function annuaireOuvertParConsole(user: SessionUser, cle: AnnuaireAccordable, geste: GesteAnnuaire): boolean {
  return ouvertParSection(faitsAnnuaire(user), cle, geste);
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE RÉFÉRENTIEL DES SPÉCIALITÉS — qui le gère (§118.180).
 *
 * Décision de la Direction (04/10/2026) : « donne la gestion/création des spécialités au directeur
 * des opérations ». Les DEUX rôles qui portent ce nom (`DIRECTION`, « Direction des opérations », et
 * `OPERATIONS_DIRECTOR`, « Directeur des Opérations » — la lecture de `promo-material/validateurs.ts`)
 * gèrent tout le référentiel : créer, renommer, fusionner, retirer, rattacher un libellé hérité. Le
 * second n'a de la Promotion médicale que la LECTURE : sans cette règle, il aurait vu l'onglet sans un
 * seul bouton. Les autres gardent ce qu'ils avaient — le droit de la Promotion médicale, geste par geste.
 *
 * LA DIRECTION MARKETING LE GÈRE AUSSI (05/10/2026, §118.209) : « donne la gestion des spécialités, dans
 * Force de vente, dans un onglet à part au marketing — ils peuvent ajouter, supprimer, modifier ».
 * Elle n'a de la Promotion médicale (`MEDICAL`) et de la Force de vente (`SALES_PLANNING`) que la
 * LECTURE ; lui donner l'écriture de l'un ou l'autre module lui ouvrirait les praticiens, les visites,
 * les Business Units, les affectations (§118.16). La règle est donc PRÉCISE : le rôle `PRODUCT_MANAGER`
 * (principal OU secondaire), tous les gestes, sur le seul référentiel. Le Manager Promotion médicale
 * le gère déjà par son droit de module (MANAGE) — on ne lui ajoute pas un rôle que la console pourrait
 * resserrer : « garde ce qu'il avait ». Le Super Admin passe par `userCan`.
 *
 * UNE lecture pour l'onglet, la page et les cinq actions : une porte qui recopierait la règle
 * finirait par ouvrir un bouton que l'action refuse (§118.5, §118.83). Le rôle se lit principal OU
 * secondaire (`hasRole`), comme les autres lectures du « directeur des opérations ».
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export type GesteSpecialites = "VIEW" | "CREATE" | "UPDATE" | "DELETE";

export function peutGererSpecialites(user: SessionUser, geste: GesteSpecialites): boolean {
  if (hasRole(user, "DIRECTION") || hasRole(user, "OPERATIONS_DIRECTOR") || hasRole(user, "PRODUCT_MANAGER")) return true;
  return userCan(user, "MEDICAL", geste);
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * BD › PROJETS — un module à part, réglé depuis la console (§118.163).
 *
 * Décision de la Direction (30/09/2026) : « le module Projets dans Business Development : donne la
 * permission au Super Admin de gérer l'accès au module depuis Super Admin ».
 *
 * Le registre survivait au retrait de Market Intelligence par une porte DÉDUITE (« quiconque voit
 * Regulatory »), qui ne passait pas par le module retiré. Elle avait raison sur ce point et le garde
 * — `BUSINESS_DEVELOPMENT` reste retiré, `userCan` y répond NON pour tout le monde, sinon rouvrir
 * Projets rouvrirait Market Intelligence, ses actions et l'accès générique d'Adam (§118.16). Mais
 * une porte déduite ne se RÈGLE pas : aucune case de la console ne l'ouvrait ni ne la fermait.
 * Elle devient donc un module, `BD_PROJECTS`, et ces deux prédicats le lisent.
 *
 * VOIR — le droit de lecture du module (par défaut : chaque rôle qui voit Regulatory, voir sous
 * `PERMISSIONS`). Ce que l'écran montre d'un projet — ses dossiers — reste filtré par
 * `regulatoryVisibleWhere` : ouvrir le registre à quelqu'un ne lui ouvre aucun dossier.
 *
 * GÉRER — le droit de MODIFIER le module (par défaut : le Super Admin seul, qui tient tous les
 * modules). Créer et supprimer lisent leur geste propre (`CREATE`, `DELETE`) dans les actions.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export function canViewBdProjects(user: SessionUser): boolean {
  return userCan(user, "BD_PROJECTS", "VIEW");
}

export function canManageBdProjects(user: SessionUser): boolean {
  return userCan(user, "BD_PROJECTS", "UPDATE");
}

/** Modules the user can at least view — drives the sidebar. */
export function accessibleModules(user: SessionUser): Module[] {
  return MODULES.filter((m) => user.access.modules.has(m));
}

export function moduleScope(user: SessionUser, module: Module): AccessScope | null {
  return user.access.modules.get(module)?.scope ?? null;
}

// ─────────────────────── Row-level scoping (Prisma where) ───────────────────────

function grantsFor(user: SessionUser, entityType: EntityType): string[] {
  return [...(user.access.rowGrants.get(entityType) ?? [])];
}

/**
 * QUI VOIT LES DOSSIERS VERROUILLÉS — le Super Admin, et ceux à qui il a ouvert le pipeline.
 *
 * Le Super Admin est en dur : c'est lui qui distribue ces accès depuis la console, et un réglage
 * malheureux ne doit pas pouvoir l'enfermer dehors. Les autres viennent du réglage d'instance,
 * résolu par `getAccess` (voir `lib/regulatory/pipeline-access.ts`).
 */
export function seesLockedRegulatory(user: SessionUser): boolean {
  // DEUX CLÉS (Direction, 08/10) : la confidence (réglage nommé ou par rôle) ET le module « Pipeline réglementaire »
  // de la console. Fermer le module à quelqu'un ferme le pipeline PARTOUT — l'écran, la recherche, les sélecteurs,
  // l'assistant —, pas seulement l'entrée de menu : sinon la console mentirait.
  return user.role === "SUPER_ADMIN" || (user.access.pipelineView === true && user.access.modules.has("REGULATORY_PIPELINE"));
}

/** Qui tient le CADENAS : ouvrir un dossier, c'est le publier à toute l'entreprise. On n'ouvre pas ce qu'on ne voit
 *  pas : le module « Pipeline réglementaire » est requis aussi (Direction, 08/10). */
export function holdsRegulatoryLock(user: SessionUser): boolean {
  return user.role === "SUPER_ADMIN" || (user.access.pipelineManage === true && user.access.modules.has("REGULATORY_PIPELINE"));
}

/**
 * Le VERROU d'un dossier réglementaire passe AVANT tout le reste : ni la portée « toutes les
 * lignes », ni le fait d'en être responsable, ni une autorisation nominative ne l'ouvrent. Il ne
 * s'ouvre QUE par l'accès au pipeline, accordé nommément ou par rôle en Administration.
 *
 * Cette règle vit ici, dans la portée, et non dans l'écran Regulatory : un dossier caché du
 * tableau mais visible depuis la recherche, le sélecteur de produits des stocks ou l'assistant
 * ne serait pas caché du tout.
 */
function lockGate(user: SessionUser): Prisma.RegulatoryProductWhereInput | null {
  return seesLockedRegulatory(user) ? null : { isLocked: false };
}

/**
 * LE MODULE QUI GOUVERNE UN DOSSIER (Direction, 08/10) : un dossier VERROUILLÉ est au pipeline, un dossier ouvert au
 * suivi. Pur — la fiche, les gestes et la portée lisent la même règle (`modulesDesEntites`, `scopeRegulatory`).
 */
export function moduleDuDossierRegulatory(dossier: { isLocked: boolean }): "REGULATORY" | "REGULATORY_PIPELINE" {
  return dossier.isLocked ? "REGULATORY_PIPELINE" : "REGULATORY";
}

/** La portée NOMMÉE d'un module sur les dossiers — « ses lignes » : créés, portés, partagés, accordés. */
function porteeDossiers(user: SessionUser, module: "REGULATORY" | "REGULATORY_PIPELINE"): Prisma.RegulatoryProductWhereInput | null {
  const m = user.access.modules.get(module);
  if (!m) return null;
  if (m.scope === "ALL") return {};
  const ors: Prisma.RegulatoryProductWhereInput[] = [
    { createdById: user.id }, // le créateur voit toujours son propre dossier (sinon 404 après création)
    { responsibleId: user.id },
    { assistantId: user.id },
    { assignedUsers: { some: { id: user.id } } },
  ];
  const ids = grantsFor(user, "REGULATORY_PRODUCT");
  if (ids.length) ors.push({ id: { in: ids } });
  return { OR: ors };
}

/**
 * LES DOSSIERS QU'UNE PERSONNE VOIT — deux moitiés depuis la scission (Direction, 08/10) : les dossiers OUVERTS par
 * le module Regulatory (suivi des dossiers), les dossiers VERROUILLÉS par le module « Pipeline réglementaire » ET la
 * confidence du pipeline (`lockGate`). Chaque moitié garde sa propre portée (« tout » ou « ses lignes »).
 */
export function scopeRegulatory(user: SessionUser): Prisma.RegulatoryProductWhereInput {
  const suivi = porteeDossiers(user, "REGULATORY");
  const pipeline = lockGate(user) ? null : porteeDossiers(user, "REGULATORY_PIPELINE");
  if (!suivi && !pipeline) return { id: "__none__" };
  // Les deux moitiés en « tout » : tout le portefeuille, sans clause (le cas du Super Admin et de la Direction).
  if (suivi && pipeline && Object.keys(suivi).length === 0 && Object.keys(pipeline).length === 0) return {};
  const moitie = (portee: Prisma.RegulatoryProductWhereInput, isLocked: boolean): Prisma.RegulatoryProductWhereInput =>
    Object.keys(portee).length === 0 ? { isLocked } : { AND: [portee, { isLocked }] };
  if (suivi && !pipeline) return moitie(suivi, false);
  if (pipeline && !suivi) return moitie(pipeline, true);
  return { OR: [moitie(suivi!, false), moitie(pipeline!, true)] };
}

/**
 * Le même verrou pour les lectures qui ne passent PAS par `scopeRegulatory` : sélecteur de
 * produits des stocks, rapprochement « notre produit » d'un appel d'offres PCH, compteurs du
 * tableau de bord. Elles n'ont pas de portée par ligne, mais elles nomment des produits — et
 * un nom qui apparaît suffit à révéler le portefeuille.
 */
export function regulatoryLockWhere(user: SessionUser | null): Prisma.RegulatoryProductWhereInput {
  return user && seesLockedRegulatory(user) ? {} : { isLocked: false };
}

/**
 * LE PANEL D'UN KAM — les praticiens qu'il couvre, en UNE clause (§118.179).
 *
 * Son SECTEUR d'abord : un secteur est une sélection d'établissements — entiers, ou certains de
 * leurs services (§118.172) — et les praticiens de ce qu'il couvre sont son territoire. Plus ceux
 * qui lui sont rattachés directement (`delegateId`) : un libéral n'a pas d'hôpital.
 *
 * Il y avait DEUX définitions. Le plan de tournée lisait secteur ∪ rattachement ; tout le reste —
 * Ma journée, la saisie d'une visite, la visite imprévue, le cockpit et ses alertes, la carte
 * d'équipe, l'accès à la fiche — le seul rattachement. Un KAM planifiait un praticien de son
 * secteur, puis ne le trouvait pas dans Ma journée, ne pouvait ni saisir la visite imprévue ni
 * ouvrir sa fiche, et le cockpit l'alertait « aucun praticien dans son panel » sur un secteur qui
 * en comptait quarante.
 *
 * Ce que la clause ne fait PAS : un établissement RESTREINT ne couvre que les services choisis, et
 * un praticien SANS service n'y entre pas (on ne devine pas son service, §118.34) ; un secteur
 * INACTIF ne couvre rien. Relationnelle et synchrone : elle se compose dans n'importe quelle
 * requête sans lecture préalable, et c'est elle — elle seule — que lisent les panels de plusieurs
 * KAM (`queries/panel-kam.ts`) : une seconde écriture de la règle en mémoire divergerait sur le
 * premier cas que personne n'a pensé à tester.
 */
export function clausePanelDuKam(repId: string): Prisma.MedicalDoctorWhereInput {
  // UN SECTEUR DE SA BU (§118.184 — audit 360°, S15) : retiré d'une BU ou passé dans une autre, un KAM
  // gardait ses affectations aux secteurs de l'ancienne — et leurs praticiens dans son panel (fiche,
  // modification, tournée). Le geste qui change la BU les retire désormais ; la règle de lecture ne compte
  // de toute façon que les secteurs de la BU où il est rattaché, pour qu'une ligne restée en base, par un
  // chemin qu'on n'a pas vu, n'ouvre rien.
  const secteurDuKam: Prisma.SalesSectorWhereInput = { isActive: true, reps: { some: { repId } }, businessUnit: { reps: { some: { repId } } } };
  return {
    OR: [
      { delegateId: repId },
      { institutionRef: { sectors: { some: { tousLesServices: true, sector: secteurDuKam } } } },
      { serviceRef: { secteurs: { some: { sectorInstitution: { tousLesServices: false, sector: secteurDuKam } } } } },
    ],
  };
}

/**
 * LES PRATICIENS QU'UNE PERSONNE VOIT ET TOUCHE dans l'annuaire de la Promotion médicale.
 *
 * Portée entière : tous. Portée « ses lignes » (le délégué) : SON PANEL — secteur ∪ rattachement
 * (§118.179) — plus ce qui lui est accordé ligne à ligne. C'est la règle du cahier des charges
 * (« CAM : son portefeuille + mises à jour terrain »), et c'est ce qui rend cohérents le plan de
 * tournée (qui propose les praticiens du secteur) et la fiche (qui doit s'ouvrir sur eux).
 * Le geste qui la retourne, si la Direction veut qu'un délégué ne MODIFIE que ses rattachés : dans
 * `canAccessEntity("DOCTOR")`, garder `{ delegateId }` pour les gestes autres que VIEW — et la
 * feuille de l'annuaire devra alors porter un drapeau « modifiable » par ligne.
 */
export function scopeMedicalDoctors(user: SessionUser): Prisma.MedicalDoctorWhereInput {
  const m = user.access.modules.get("MEDICAL");
  if (!m) return { id: "__none__" };
  if (m.scope === "ALL") return {};
  const ors: Prisma.MedicalDoctorWhereInput[] = [clausePanelDuKam(user.id)];
  const ids = grantsFor(user, "DOCTOR");
  if (ids.length) ors.push({ id: { in: ids } });
  return { OR: ors };
}

export function scopeMedicalVisits(user: SessionUser): Prisma.MedicalVisitWhereInput {
  const m = user.access.modules.get("MEDICAL");
  if (!m) return { id: "__none__" };
  if (m.scope === "ALL") return {};
  const ors: Prisma.MedicalVisitWhereInput[] = [{ delegateId: user.id }];
  const ids = grantsFor(user, "VISIT");
  if (ids.length) ors.push({ id: { in: ids } });
  return { OR: ors };
}

export function scopeSales(user: SessionUser): Prisma.SaleWhereInput {
  const m = user.access.modules.get("SALES");
  if (!m) return { id: "__none__" };
  if (m.scope === "ALL") return {};
  const ors: Prisma.SaleWhereInput[] = [{ salesUserId: user.id }];
  const ids = grantsFor(user, "SALE");
  if (ids.length) ors.push({ id: { in: ids } });
  return { OR: ors };
}

export function scopeBusinessDevelopment(user: SessionUser): Prisma.BusinessDevelopmentOpportunityWhereInput {
  const m = user.access.modules.get("BUSINESS_DEVELOPMENT");
  if (!m) return { id: "__none__" };
  if (m.scope === "ALL") return {};
  const ors: Prisma.BusinessDevelopmentOpportunityWhereInput[] = [{ ownerId: user.id }];
  const ids = grantsFor(user, "BD_OPPORTUNITY");
  if (ids.length) ors.push({ id: { in: ids } });
  return { OR: ors };
}

/** Prises en charge Internationales : scope ALL voit tout ; sinon le demandeur + le chef
 *  de produit assigné (un délégué ne voit que ses propres demandes). */
export function scopeCongressIntl(user: SessionUser): Prisma.CongressInternationalWhereInput {
  const m = user.access.modules.get("CONGRESS_INTERNATIONAL");
  if (!m) return { id: "__none__" };
  if (m.scope === "ALL") return {};
  return { OR: [{ requesterId: user.id }, { productManagerId: user.id }] };
}

/** Congrès / événements nationaux : même logique. */
export function scopeCongressNational(user: SessionUser): Prisma.CongressNationalWhereInput {
  const m = user.access.modules.get("CONGRESS_NATIONAL");
  if (!m) return { id: "__none__" };
  if (m.scope === "ALL") return {};
  return { OR: [{ requesterId: user.id }, { productManagerId: user.id }] };
}

/**
 * SPONSORING (§118.185 — audit 360°, I4) : jusqu'ici, qui avait le module voyait tout — aucun rôle
 * n'avait de portée par ligne. Le délégué médical reçoit le module pour déposer SA demande : sa
 * portée ASSIGNÉE se lit ici, une fois, par la liste, la fiche, la recherche et la porte des pièces.
 */
export function scopeSponsoring(user: SessionUser): Prisma.SponsoringRequestWhereInput {
  const m = user.access.modules.get("SPONSORING");
  if (!m) return { id: "__none__" };
  if (m.scope === "ALL") return {};
  return { OR: [{ requesterId: user.id }, { productManagerId: user.id }] };
}

/** Projets BD (Projet → Gamme → Produit) : scope ALL voit tout ; sinon le
 *  propriétaire du projet + les projets explicitement accordés (RowGrant). */
export function scopeBdProject(user: SessionUser): Prisma.BdProjectWhereInput {
  const m = user.access.modules.get("BD_PROJECTS");
  /**
   * LA PORTÉE SE LIT SUR LE MODULE `BD_PROJECTS` LUI-MÊME (§118.163) : sans le module, rien ;
   * avec, la portée que la console lui a donnée — tout le registre par défaut (`defaultScope`).
   *
   * Elle a longtemps été DÉDUITE de Regulatory, parce que le registre vivait sous
   * `BUSINESS_DEVELOPMENT`, un module retiré que `getAccess` n'accorde à personne : sans cette
   * déduction, la portée rendait « rien » à TOUT LE MONDE, et quatre lecteurs le payaient —
   * l'écran Projets, la porte par ligne, la liste déroulante « Projet » de Regulatory et la fiche
   * d'un projet (§118.61). Le module propre remplace la déduction : la console l'ouvre ou le ferme,
   * et le défaut reproduit exactement l'ancienne porte (qui voit Regulatory lit le registre).
   *
   * Le registre est une liste d'ÉTIQUETTES : ce qu'un projet contient (les dossiers) reste filtré
   * par `regulatoryVisibleWhere`, et l'ENTITÉ du projet se compose à part (`projetsBdVisibles`).
   */
  if (!m) return { id: "__none__" };
  if (m.scope === "ALL") return {};
  const ors: Prisma.BdProjectWhereInput[] = [{ ownerId: user.id }];
  const ids = grantsFor(user, "BD_PROJECT");
  if (ids.length) ors.push({ id: { in: ids } });
  return { OR: ors };
}

/** Demandes de support : ALL voit tout ; sinon le demandeur, le destinataire (nommé ou
 *  par rôle visé) et le répondant assigné. */
export function scopeSupport(user: SessionUser): Prisma.SupportRequestWhereInput {
  const m = user.access.modules.get("SUPPORT");
  if (!m) return { id: "__none__" };
  if (m.scope === "ALL") return {};
  return { OR: [{ requesterId: user.id }, { targetUserId: user.id }, { targetRole: user.role }, { assignedToId: user.id }] };
}

/** Dossiers de suivi : la Direction (scope ALL) voit tout ; sinon on ne voit que
 *  les dossiers créés, dont on est responsable, ou où l'on participe. */
export function scopeDossiers(user: SessionUser): Prisma.DossierWhereInput {
  const m = user.access.modules.get("DOSSIERS");
  if (!m) return { id: "__none__" };
  if (m.scope === "ALL") return {};
  return { OR: [{ createdById: user.id }, { assignedToId: user.id }, { participantIds: { has: user.id } }] };
}

/** Directives : la Direction (scope ALL) voit tout ; un employé ne voit que les
 *  directives qui le ciblent nommément ou qui visent son rôle. */
/**
 * LES DIRECTIVES QU'UNE PERSONNE VOIT.
 *
 * Quatre portées (voir `lib/directives/audience.ts`) et une règle qui prime sur toutes :
 * **une directive non publiée n'existe pour personne d'autre que son auteur**. Elle attend la
 * signature de la direction générale ; la faire apparaître dans la liste de ses destinataires
 * avant cet accord reviendrait à l'avoir diffusée.
 *
 * `companyIds` : les entités dont la personne relève (fiche employé). Non fourni — depuis un
 * appelant qui ne les connaît pas — les notes d'entité ne remontent tout simplement pas, plutôt
 * que de remonter celles d'une entité qui ne la regarde pas.
 */
export function scopeDirectives(user: SessionUser, companyIds: string[] = []): Prisma.DirectiveWhereInput {
  const m = user.access.modules.get("DIRECTIVES");
  if (!m) return { id: "__none__" };
  if (m.scope === "ALL") return {};
  const destinataire: Prisma.DirectiveWhereInput[] = [
    { audience: "ALL" },
    { targetUserIds: { has: user.id } },
    { targetRole: user.role },
    ...(user.secondaryRole ? [{ targetRole: user.secondaryRole }] : []),
    ...(companyIds.length ? [{ companyId: { in: companyIds } }] : []),
    // Compat : les notes émises avant les portées multiples ne portent que `targetUserId`.
    { targetUserId: user.id },
  ];
  return {
    OR: [
      { fromId: user.id }, // sa propre note, à tout état — sinon il la croirait perdue
      { AND: [{ publication: "PUBLISHED" }, { OR: destinataire }] },
    ],
  };
}

/**
 * INFORMATION MÉDICALE — qui voit quelle déclaration.
 *
 * Portée ALL (le pharmacien responsable) : tout. Sinon, on voit ce qui nous concerne — et
 * « nous concerne » inclut LES DÉCLARATIONS QUE PERSONNE N'A ENCORE PRISES.
 *
 * Le trou, corrigé ici : une déclaration arrive « à déclarer » sans pharmacien assigné
 * (`pharmacistId` nul). Avec l'ancienne règle, celui qui a le droit de la VALIDER ne la voyait
 * pas dans son module — il ne la découvrait que par le raccourci de « Mon espace », c'est-à-dire
 * par accident. Un dossier que personne ne voit est un dossier que personne ne prend : c'est
 * exactement la panne silencieuse que ce module doit empêcher.
 */
export function scopeMedicalInfo(user: SessionUser): Prisma.MedicalInfoDeclarationWhereInput {
  const m = user.access.modules.get("MEDICAL_INFO");
  if (!m) return { id: "__none__" };
  if (m.scope === "ALL") return {};
  const ors: Prisma.MedicalInfoDeclarationWhereInput[] = [
    { pharmacistId: user.id },
    { requests: { some: { targetUserId: user.id } } },
  ];
  // Qui peut VALIDER une déclaration doit voir celles qui attendent d'être prises en charge.
  if (m.actions.has("VALIDATE")) ors.push({ pharmacistId: null });
  return { OR: ors };
}

/** Admin requests scope: a manager (scope ALL) sees all; others see the ones they
 *  requested, are concerned by, are assigned to, or must validate. */
export function scopeAdminRequests(user: SessionUser): Prisma.AdministrativeRequestWhereInput {
  const m = user.access.modules.get("ADMIN_REQUESTS");
  if (!m) return { id: "__none__" };
  // Les demandes supprimées (soft delete traçable) sont masquées des vues normales.
  if (m.scope === "ALL") return { deletedAt: null };
  // Les PARTICIPANTS ajoutés par le demandeur (`fields.participantIds`, Direction 10/2026) lisent la demande.
  return {
    deletedAt: null,
    OR: [
      { requesterId: user.id }, { concernedUserId: user.id }, { assignedToId: user.id }, { validatorId: user.id },
      { fields: { path: ["participantIds"], array_contains: [user.id] } },
    ],
  };
}

/** Matériel promotionnel : scope ALL voit tout ; sinon l'initiateur Marketing et
 *  l'assistante de direction en charge. */
export function scopePromoMaterial(user: SessionUser): Prisma.PromoMaterialWhereInput {
  const m = user.access.modules.get("PROMO_MATERIAL");
  if (!m) return { id: "__none__" };
  if (m.scope === "ALL") return {};
  return { OR: [{ requesterId: user.id }, { assistantId: user.id }] };
}
