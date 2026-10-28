/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CONTRAT DE PLATEFORME — la seule chose qu'Adam sait de l'ERP.
 *
 * ── CE QUE CE FICHIER EST, ET CE QU'IL N'EST PAS ──────────────────────────────────────────
 *
 * C'EST la frontière. Adam parle à la plateforme par QUATRE verbes, et rien d'autre :
 *
 *     query      — lire l'état métier canonique
 *     command    — demander une action (la plateforme décide si elle est permise, et l'exécute)
 *     authorize  — « cette personne a-t-elle le droit de … ? »
 *     events     — être prévenu quand quelque chose change
 *
 * CE N'EST PAS un miroir de l'ERP. L'audit de départ comptait 447 imports d'Adam vers
 * 173 modules internes. Envelopper les 173 aurait produit exactement ce que la mission
 * interdit : « une nouvelle couche abstraite inutile au-dessus du système existant ». Le
 * contrat est donc SÉMANTIQUE et étroit — il décrit ce dont Adam a besoin, pas ce que l'ERP
 * contient. Il grandit quand un besoin réel apparaît, jamais par symétrie.
 *
 * ── ZÉRO IMPORT ──────────────────────────────────────────────────────────────────────────
 *
 * Ce fichier n'importe RIEN — ni Prisma, ni `@/lib/*`, ni un type généré. C'est la propriété
 * qui rend le contrat portable : le jour où Adam devient un service à part, ce fichier part
 * avec lui sans modification, et l'ERP en publie l'implémentation derrière HTTP.
 *
 * Un type Prisma qui traverserait cette frontière (`User`, `Employee`, `$Enums`…) recréerait
 * le couplage qu'on retire — et personne ne s'en apercevrait avant la migration suivante.
 * `boundary.test.ts` échoue si cela arrive.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/**
 * LA VERSION DU CONTRAT — pas une décoration.
 *
 * Adam et la plateforme peuvent évoluer séparément TANT QUE ce numéro est compatible. Il
 * s'incrémente en MAJEUR quand un champ requis disparaît ou change de sens ; en MINEUR quand on
 * ajoute quelque chose d'optionnel. L'adaptateur l'annonce, Adam le vérifie au démarrage.
 */
export const PLATFORM_CONTRACT_VERSION = "1.0.0";

// ═════════════════════════════════════════════════════════════════════════════════════════════
// IDENTITÉ
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * QUI PARLE — la vue d'Adam sur une personne. Volontairement plus pauvre que le `CurrentUser`
 * de l'ERP : Adam n'a pas besoin de la session, du mot de passe à changer, ni de l'objet d'accès
 * complet. Moins il en sait, moins il dépend.
 *
 * LES CAPACITÉS SONT RÉSOLUES PAR LA PLATEFORME, JAMAIS CALCULÉES PAR ADAM. C'est ce qui
 * permet à Adam de filtrer sa liste d'outils SANS aller-retour (latence nulle) tout en gardant
 * la décision canonique là où elle doit être. La règle qui rend cela sûr n'a pas changé d'un
 * pouce : **la liste présentée au modèle est une suggestion, l'exécution revérifie toujours**.
 * Une capacité périmée coûte donc un refus poli, jamais une action indue.
 */
export interface Principal {
  id: string;
  displayName: string;
  /** Adresse de connexion — sert à identifier, jamais à autoriser. */
  email: string;
  /**
   * Le rôle canonique, en chaîne OPAQUE. Adam le transmet et l'affiche ; il ne raisonne pas
   * dessus. Raisonner sur le rôle, c'est réimplémenter le RBAC de l'ERP dans Adam — et le voir
   * diverger au premier changement de politique.
   */
  role: string;
  /**
   * Ce que cette personne peut faire, résolu à l'instant du tour. Forme `MODULE:NIVEAU`
   * (« RH:VIEW », « FINANCE:EDIT ») plus quelques capacités transverses (« platform:global-view »).
   */
  capabilities: ReadonlySet<string>;
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// LECTURES
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * UNE PERSONNE, telle qu'Adam la voit. Pas une ligne `Employee`, pas un `User` : le sous-ensemble
 * dont l'annuaire, la messagerie et les missions ont besoin.
 */
export interface PersonView {
  id: string;
  fullName: string;
  jobTitle: string | null;
  department: string | null;
  company: string | null;
  /** Coordonnées AVEC leur provenance — une adresse sans provenance est un piège. */
  endpoints: readonly ContactEndpoint[];
}

export interface ContactEndpoint {
  channel: "email" | "phone" | "whatsapp";
  value: string;
  label: string | null;
  /** « vérifiée en interne », « déduite — à confirmer »… La confiance se transporte. */
  confidence: string;
  primary: boolean;
}

/** Une fiche métier quelconque — dossier réglementaire, facture, contrat… */
export interface RecordView {
  id: string;
  type: string;
  title: string;
  /** Champs scalaires prêts à afficher, dans l'ordre où ils comptent. */
  fields: readonly { label: string; value: string }[];
  /** Lien interne vers l'écran canonique. */
  href: string | null;
  updatedAt: string | null;
}

/**
 * LES LECTURES QU'ADAM SAIT DEMANDER — une union fermée, et c'est le point.
 *
 * Fermée signifie : ajouter une lecture est une DÉCISION, prise en sachant ce qu'elle expose.
 * Une méthode générique `runAnyQuery(sql)` aurait été plus « souple » et aurait rouvert la porte
 * que cette frontière existe pour fermer.
 */
export type PlatformQuery =
  | { kind: "person.search"; text: string; limit?: number }
  | { kind: "person.list"; department?: string; limit?: number }
  | { kind: "record.get"; type: string; id: string }
  | { kind: "record.search"; text: string; types?: readonly string[]; limit?: number }
  | { kind: "pending-decisions.list"; limit?: number }
  /**
   * UN DOCUMENT À MONTRER — désigné par son nœud Drive, sa pièce jointe, ou son nom.
   *
   * Première lecture non-personne à passer par ce contrat, et elle y est pour une raison
   * précise : afficher un fichier demande la base, le stockage, les droits du Drive ET ceux du
   * dossier porteur. Laissée dans un outil d'Adam, elle aurait franchi la frontière sept fois.
   * Ici, c'est l'ERP qui ouvre le fichier — Adam ne reçoit qu'une vue, et un lien qui revérifie.
   */
  | { kind: "document.show"; driveNodeId?: string; documentId?: string; name?: string }
  /**
   * CHERCHE DANS LE CONTENU des documents indexés — pas dans leurs titres.
   *
   * Ajoutée au contrat plutôt que branchée en direct, et c'est le test de frontière qui l'a
   * exigé : « le besoin est vraiment nouveau → l'ajouter au CONTRAT, ce qui est une décision
   * explicite ». Adam demande une recherche ; il ne sait pas qu'il existe un index, un routeur,
   * un reclassement — et il n'a pas à le savoir pour poser la question.
   */
  | { kind: "document.search"; question: string; limit?: number }
  /**
   * L'ÉCONOMIE D'UN PRODUIT — ce qu'il rapporte, ce qu'il coûte, qui le porte.
   *
   * Ajoutée au CONTRAT et non branchée en direct, pour la raison que le test de frontière donne
   * lui-même : « le besoin est vraiment nouveau → l'ajouter au contrat, ce qui est une décision
   * explicite ». Elle traverse ventes, Ad&Pro, RH, marchés et réglementaire ; laissée dans un
   * outil d'Adam, elle aurait franchi la frontière quatre fois de plus.
   *
   * Adam demande l'économie d'un produit. Il ne sait pas qu'il existe un produit canonique, une
   * couche de métriques, ni cinq définitions du mot « chiffre d'affaires » — et il n'a pas à le
   * savoir pour poser la question.
   */
  | { kind: "product.economics"; mention: string }
  /** L'ÉTAT D'UN MARCHÉ PCH, de la soumission à l'encaissement. Même raison. */
  | { kind: "pch.market-status"; reference: string }
  /**
   * « RETRACE-MOI X » — l'histoire complète d'une affaire, reconstituée par l'ERP.
   *
   * `ancre` est ce que le PDG a dit : une référence de marché, un nom de produit. C'est l'ERP
   * qui décide ce que ça désigne — Adam n'a pas à savoir qu'un marché se reconnaît à sa
   * référence et un produit à son nom canonique, et le lui faire deviner rouvrirait exactement
   * l'heuristique de ressemblance de libellé que la clé étrangère a remplacée.
   */
  | { kind: "business.story"; ancre: string }
  /**
   * L'ÉTAT D'UNE MISSION D'EXÉCUTION. `mission` omis ⇒ les missions en cours du demandeur.
   *
   * Elle entre au contrat plutôt que d'être lue en direct : le Mission Runtime vit du côté ERP
   * (c'est une façade transverse), et Adam ne doit pas le connaître. Le jour où le runtime
   * devient un service à part, cette ligne ne bouge pas.
   */
  | { kind: "mission.status"; mission?: string }
  ;

export type PlatformQueryResult =
  | { kind: "person.search" | "person.list"; people: readonly PersonView[]; total: number }
  | { kind: "record.get"; record: RecordView | null }
  | { kind: "record.search"; records: readonly RecordView[]; total: number }
  | { kind: "pending-decisions.list"; items: readonly PendingDecision[]; total: number }
  /**
   * `document` absent ⇒ `refusal` dit POURQUOI, en français, prêt à être lu tel quel.
   *
   * On distingue le refus de l'absence : « ce fichier ne vous est pas ouvert » et « aucun
   * fichier de ce nom » appellent deux réactions différentes, et les confondre en un `null`
   * ferait dire à Adam « je n'ai rien trouvé » là où il aurait fallu dire « je n'ai pas le droit ».
   */
  | { kind: "document.show"; document: DocumentView | null; refusal?: string }
  | { kind: "document.search"; extracts: readonly DocumentExtract[]; examined: number }
  /**
   * `data` absent ⇒ `question` porte ce qu'il faut demander à l'humain : soit le produit est
   * introuvable, soit la mention désigne PLUSIEURS produits. Rendre `null` sans la question
   * ferait dire « je n'ai rien trouvé » là où il fallait dire « lequel des deux ? » — et
   * trancher seul entre un 40 mg et un 100 mg met un chiffre d'affaires sous le mauvais nom.
   */
  | { kind: "product.economics"; data: BusinessSnapshot | null; question?: string }
  | { kind: "pch.market-status"; data: BusinessSnapshot | null; question?: string }
  | { kind: "business.story"; data: BusinessStoryView | null; question?: string }
  | { kind: "mission.status"; data: MissionStatusView | null; missions?: readonly MissionBrief[] };

/**
 * UNE VUE MÉTIER DÉJÀ COMPOSÉE — l'ERP a fait le calcul, Adam n'a plus qu'à la restituer.
 *
 * Volontairement opaque (`unknown` en valeurs) : le CONTRAT dit qu'une vue arrive, pas de quels
 * champs elle est faite. Y figer la forme exacte obligerait à modifier le contrat — donc les
 * deux côtés — à chaque colonne ajoutée dans un tableau de bord, ce qui est précisément le
 * couplage qu'une frontière existe pour empêcher.
 *
 * `metriques` est en revanche NOMMÉE : c'est la promesse que chaque chiffre arrive avec sa
 * définition, et c'est ce que la couche sémantique garantit. Elle ne se négocie pas.
 */
export interface BusinessSnapshot {
  metriques: readonly {
    nom: string; libelle: string; valeur: number | null; unite: string;
    definition: string; pourquoi?: string; base?: string;
  }[];
  /** Le reste de la vue — structuré, mais non contraint par le contrat. */
  [section: string]: unknown;
}

/**
 * L'HISTOIRE D'UNE AFFAIRE, TELLE QUE L'ERP LA RECONSTITUE.
 *
 * ── POURQUOI `events` N'EST PAS TYPÉ ICI ─────────────────────────────────────────────────
 *
 * Un jalon a quinze champs — genre, état, retard, provenance, certitude, participants, pièces,
 * fils… — et ils sont ceux du PROTOCOLE D'AFFICHAGE, qui vit du côté d'Adam. Les recopier dans
 * ce contrat créerait une seconde définition du même objet, et deux définitions du même objet
 * divergent : le jour où un état s'ajoute d'un côté, l'autre le laisse tomber en silence.
 *
 * Le contrat promet donc ce qui compte et qui ne bouge pas : une ancre identifiée, un titre,
 * des jalons, des fils de lecture, et les LIMITES de la reconstitution. La forme exacte de
 * chaque jalon est revalidée champ par champ au moment de composer l'écran — une seule fois,
 * au seul endroit qui sait ce qu'il sait rendre.
 *
 * ── CE QUE `limites` GARANTIT ────────────────────────────────────────────────────────────
 *
 * Qu'une frise ne se donne jamais pour complète. « La date de soumission est déduite » ou
 * « aucun contrat rattaché » sont ce qui empêche de lire un trou comme une absence de fait.
 */
/**
 * L'ÉTAT D'UNE MISSION, DÉJÀ COMPOSÉ — comme les vues métier, l'ERP a fait le travail.
 *
 * `bloc` est opaque pour la même raison que `BusinessSnapshot` : c'est de l'affichage, et y
 * figer la forme obligerait à toucher le contrat — donc les deux côtés — à chaque colonne
 * ajoutée. `avancement`, en revanche, est NOMMÉ : c'est le chiffre dont on répond, et il compte
 * les étapes réellement exécutées, jamais les modèles d'éventail.
 */
export interface MissionStatusView {
  titre: string;
  etat: string;
  avancement: { faites: number; total: number; echouees: number };
  enAttenteDeVous: string | null;
  sousMissions: number;
  bloc: unknown;
  /** Le journal par action (§33) — présent quand une mission précise est demandée. */
  observabilite?: ObservabiliteMission | null;
}

/** LA DÉCISION DE PERMISSION qu'une action a rencontrée — constatée, jamais déduite d'une phrase. */
export type DecisionPermission = "ACCORDEE" | "REFUSEE" | "ACCORD_REQUIS" | "ACCORDEE_PAR_HUMAIN" | "SANS_OBJET";

/**
 * UNE ACTION DE MISSION, OBSERVÉE (§33) : les treize champs du mandat, tels que le code les a
 * CONSTATÉS — un champ que la mission n'a pas produit est `null`, jamais rempli par déduction.
 */
export interface ActionObservee {
  etape: string;
  titre: string;
  nodeType: string;
  statut: string;
  /** L'outil (la capacité) appelé. */
  outil: string | null;
  /** La version du prompt du planificateur qui a produit l'étape. */
  promptVersion: string | null;
  /** La source interrogée (domaine du registre), depuis le reçu. */
  source: string | null;
  /** SUCCES | VIDE | ECHEC | INDETERMINE, depuis le reçu. */
  issue: string | null;
  tentatives: number;
  maxTentatives: number;
  latenceMs: number | null;
  debut: string | null;
  fin: string | null;
  decisionPermission: DecisionPermission;
  /** La certitude qu'un reçu autorise : CERTAIN (trouvé ou preuve d'absence), PROBABLE (dédoublonné), HYPOTHESE (indéterminé), MANQUANT (échec). */
  certitude: "CERTAIN" | "PROBABLE" | "HYPOTHESE" | "MANQUANT" | null;
  /** Les règles enseignées servies au planificateur pour cette mission (les mêmes pour toutes ses actions). */
  reglesUtilisees: string[];
  sousAgent: { role: string; modele: string | null; statut: string; coutUsd: number | null } | null;
  modele: string | null;
  coutUsd: number | null;
  erreur: string | null;
  erreurKind: string | null;
  resultats: number | null;
}

export interface ObservabiliteMission {
  missionId: string;
  planVersion: number;
  promptVersion: string | null;
  reglesUtilisees: string[];
  /** Les modèles réellement appelés pour cette mission (journal des appels), avec leur coût quand il est connu. */
  modeles: { modele: string; appels: number; coutUsd: number | null }[];
  appelsModele: number;
  appelsOutil: number;
  coutUsd: number | null;
  actions: ActionObservee[];
  /** Les treize champs du mandat, pour qu'un lecteur (ou un test) vérifie qu'aucun ne manque. */
  champs: readonly string[];
}

/** Une mission en cours, en une ligne. */
export interface MissionBrief {
  id: string;
  titre: string;
  etat: string;
  avancement: string;
}

export interface BusinessStoryView {
  ancre: { type: string; id: string; label: string };
  titre: string;
  sousTitre: string | null;
  kpis: readonly unknown[];
  events: readonly unknown[];
  threads: readonly unknown[];
  limites: readonly string[];
}

/** Un extrait de document, avec de quoi le CITER — sans quoi il ne vaut rien. */
export interface DocumentExtract {
  /** Le document d'où il vient. */
  document: string | null;
  /** Où il se trouve dedans — « page 3 », « Feuille Tarifs », « Diapositive 7 ». */
  at: string | null;
  text: string;
  /** Ce qui l'a fait remonter — un classement qu'on ne peut pas relire ne se corrige pas. */
  because: readonly string[];
}

/** Le contenu d'un tableur, déjà lu — c'est ce qui permet de relire un export avant l'envoi. */
export interface DocumentSheet {
  columns: readonly { key: string; label: string; numeric?: boolean }[];
  rows: readonly Record<string, string>[];
  /** Le nombre de lignes DU FICHIER, pas de l'aperçu. */
  total: number;
}

export interface DocumentView {
  name: string;
  /**
   * Une ROUTE INTERNE de l'ERP, jamais une URL signée ni un lien externe : les droits sont
   * revérifiés à chaque requête, et un lien recopié ailleurs n'ouvre rien.
   */
  href: string;
  kind: "pdf" | "image" | "feuille" | "texte" | "autre";
  /** Taille lisible (« 2,4 Mo »), `null` si inconnue. */
  size: string | null;
  subtitle: string | null;
  sheet: DocumentSheet | null;
}

export interface PendingDecision {
  id: string;
  title: string;
  detail: string | null;
  status: string | null;
  waitingSince: string | null;
  href: string | null;
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// COMMANDES
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * UNE DEMANDE D'ACTION — « Adam peut décider de ce que veut le PDG ; l'ERP décide si l'action
 * est autorisée et l'exécute correctement ».
 *
 * `actionId` est l'identifiant STABLE d'une action canonique du registre ERP, pas un nom de
 * fonction. C'est ce qui permet de renommer l'implémentation sans casser Adam.
 *
 * `idempotencyKey` est OBLIGATOIRE, et ce n'est pas du zèle : un « oui » redit, un rejeu de
 * webhook et une reprise de tâche décrivent la même action. Sans clé, le troisième la referait.
 */
export interface PlatformCommand {
  actionId: string;
  args: Readonly<Record<string, unknown>>;
  idempotencyKey: string;
  /** D'où vient la demande — tracé dans l'audit de l'ERP. */
  origin: "text" | "voice" | "nudge" | "schedule";
}

export type CommandOutcome =
  | { ok: true; message: string; link?: string | null; createdId?: string | null; replayed?: boolean }
  /** Refus MÉTIER ou de DROIT — la plateforme a décidé, Adam le dit tel quel. */
  | { ok: false; refused: true; reason: string }
  /** Panne — l'action n'a pas eu lieu et pourrait réussir plus tard. La distinction compte. */
  | { ok: false; refused: false; error: string };

// ═════════════════════════════════════════════════════════════════════════════════════════════
// ÉVÉNEMENTS
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * CE QUI A CHANGÉ DANS LA PLATEFORME — le canal qui remplace l'interrogation permanente.
 *
 * FAIT, PAS ORDRE. Un événement décrit quelque chose qui EST ARRIVÉ (« le dossier X est passé à
 * l'étape 5 »), au passé, et n'attend rien en retour. Adam en fait ce qu'il veut : rafraîchir une
 * projection, prévenir le PDG, ou rien. Un bus qui transporterait des ordres recréerait le
 * couplage dans l'autre sens.
 *
 * `subject` est le couple type+id de l'entité concernée ; `at` est l'horloge de la PLATEFORME
 * (celle qui fait foi), `seq` un compteur monotone par processus qui permet de repérer un trou.
 */
export interface DomainEvent {
  /** Verbe au passé, préfixé par le domaine : « regulatory.stage-changed », « hr.employee-added ». */
  type: string;
  subject: { type: string; id: string };
  at: string;
  seq: number;
  /** Qui a provoqué le changement — `null` quand c'est le système (import, tâche planifiée). */
  actorId: string | null;
  /** Charge utile MINIMALE : de quoi décider s'il faut relire, pas une copie de la ligne. */
  data: Readonly<Record<string, unknown>>;
}

export type EventHandler = (event: DomainEvent) => void;
export type Unsubscribe = () => void;

// ═════════════════════════════════════════════════════════════════════════════════════════════
// LE PORT
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * LA PLATEFORME, VUE D'ADAM. Quatre verbes, et rien de plus.
 *
 * Aujourd'hui l'implémentation est en-processus : un appel de fonction, zéro sérialisation, zéro
 * réseau — donc AUCUN coût de latence par rapport à l'existant. Demain, la même interface peut
 * être servie par HTTP sans qu'Adam le sache. C'est tout l'intérêt d'avoir séparé le code sans
 * séparer le déploiement : on gagne l'indépendance sans payer le réseau.
 */
export interface PlatformPort {
  readonly contractVersion: string;

  /** LIT l'état canonique. Ne modifie jamais rien. */
  query(principal: Principal, query: PlatformQuery): Promise<PlatformQueryResult>;

  /** DEMANDE une action. La plateforme vérifie les droits, exécute, audite, et répond. */
  command(principal: Principal, command: PlatformCommand): Promise<CommandOutcome>;

  /**
   * « Cette personne peut-elle … ? » — la réponse FAIT FOI, contrairement aux capacités portées
   * par le `Principal`, qui sont un instantané destiné au filtrage rapide.
   */
  authorize(principal: Principal, capability: string): Promise<boolean>;

  /** S'abonne aux changements. Rend une fonction de désabonnement. */
  subscribe(handler: EventHandler): Unsubscribe;
}
