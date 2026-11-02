/**
 * RBAC — la MATRICE PAR DÉFAUT des rôles (`PERMISSIONS`) et les défauts posés module par module
 * (les boucles qui la complètent s'exécutent au chargement, dans l'ordre d'origine).
 * Module PUR (aucune base) : réexporté par la porte `lib/rbac`.
 */

import type { UserRole } from "@prisma/client";
import { MODULES, type Action, type Module } from "./modules";
import { ALL, READ, CONTRIBUTE, MANAGE, AD_PRO_OPERATIONS, WORKSPACE_USER, DRIVE_USER, REQUEST_USER, VALIDATION_USER, FEEDBACK_USER, MESSAGING_USER, DIRECTIVES_USER, SUPPORT_USER, DOSSIERS_USER, GENERAL_MEANS_USER, BC_SIGNATAIRE, BC_LECTEUR, type RoleMatrix } from "./gestes";

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
    // SA DEMANDE « AUTRE » (Direction, 27/10/2026 : « les demandes autres suivent le même circuit ») —
    // le délégué la dépose comme son sponsoring, en portée ASSIGNÉE (`scopeAdProOther`) : il ne voit que
    // les siennes. Elle passe ensuite par son National Sales, le Directeur des opérations, la Direction Marketing.
    AD_PRO_OTHER: CONTRIBUTE,
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
