/**
 * RBAC — le CATALOGUE : les modules (`MODULES`, `Module`) et les gestes (`ACTIONS`, `Action`).
 * Module PUR, zéro import : réexporté par la porte `lib/rbac`.
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
