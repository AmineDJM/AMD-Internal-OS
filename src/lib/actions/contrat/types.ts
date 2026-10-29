/**
 * LES TYPES DU CONTRAT D'UNE ACTION — ce que `decrireAction` rend et ce qu'il reçoit.
 *
 * Morceau de `actions/contrat.ts` (qui les réexporte) : pur, sans un seul import, comme le reste
 * du dossier — le contrat se lit partout, navigateur compris.
 */

/** Ce qu'un champ attend. `reference` désigne une autre fiche — le pont vers `resoudreCible`. */
export type TypeChamp = "texte" | "nombre" | "date" | "booleen" | "liste" | "reference";

/**
 * CE QUE LE SCHÉMA DIT DES RÉFÉRENCES — `"CareBeneficiary.doctorId" → "MedicalDoctor"`.
 *
 * Fournie par l'appelant (`contrat-scan.ts` la lit du DMMF) pour que ce module n'importe rien.
 * Elle porte AUSSI la clé propre de chaque modèle (`"DriveNode.id" → "DriveNode"`) : ainsi le
 * champ `id` n'est pas un cas particulier écrit ici, c'est le schéma qui dit qu'une clé
 * primaire désigne son propre modèle.
 */
export type TableRelations = Readonly<Record<string, string>>;

export interface ChampAction {
  nom: string;
  type: TypeChamp;
  /** Le code refuse-t-il SANS ce champ ? `true` = prouvé par sa garde, jamais supposé. */
  obligatoire: boolean;
  /** Les valeurs admises quand elles se lisent. `null` = NON LUES (jamais « toutes »). */
  valeurs: readonly string[] | null;
  /**
   * LE MODÈLE PRISMA QUE CE CHAMP DÉSIGNE — dit par le SCHÉMA, jamais deviné.
   *
   * C'est ce qui permet à une personne d'écrire « Nivolex » là où l'action attend un `cuid`.
   * `null` = le schéma ne le dit pas à coup sûr, et l'on ne comble pas : substituer
   * l'identifiant d'un objet à la place d'un autre ferait AGIR SUR LA MAUVAISE LIGNE en
   * annonçant que c'est fait, le défaut le plus coûteux de tout ce système (§104.7).
   */
  modele: string | null;
}

/** Ce que la source déclare de sa porte. N'AUTORISE RIEN : l'action revérifie à l'exécution. */
export interface PorteLue {
  /** Le module RBAC (« REGULATORY »), quand un `userCan` le nomme. */
  module: string | null;
  /** Le verbe RBAC (« CREATE », « UPDATE »…). */
  verbe: string | null;
  /** Le type d'entité d'un `canAccessEntity`, quand il y en a un. */
  entite: string | null;
  /**
   * Les gardes RECONNUES, telles qu'écrites (`requireAdmin`, `requireChief`…).
   *
   * ⚠ Une liste VIDE ne veut PAS dire « action sans protection » — seulement « aucune garde
   * d'une forme que la dérivation sait nommer ». Mesuré : `setRegulatoryLock` (le cadenas d'un
   * dossier confidentiel) sort avec `gardes: []` alors que son corps appelle
   * `holdsRegulatoryLock(user)`, et `saveOrgNode` teste `user.role !== "SUPER_ADMIN"` en clair.
   * Ce champ sert à DÉCRIRE et à faire trouver une action, jamais à décider si on l'autorise :
   * la décision appartient à l'action elle-même, que l'exécuteur appelle telle quelle (§118.74).
   * Bâtir une garde là-dessus refuserait 182 actions à tort et, pire, ferait croire qu'une
   * liste vide est un fait.
   */
  gardes: readonly string[];
  /**
   * LE MODULE EN FRANÇAIS, lu sur `recordAudit({ module })` — 434 actions le déclarent.
   *
   * Ce n'est pas un doublon du module RBAC : celui-là est une clé technique
   * (`BUSINESS_DEVELOPMENT`), celui-ci est le mot que la personne emploie (« Business
   * Development »), et c'est LUI que la recherche par intention doit rencontrer. Trouvé en
   * cassant la découverte : déplacer la garde d'une action a fait disparaître son module RBAC
   * du contrat, et « crée un projet business development » a cessé de trouver l'action — alors
   * que le mot était toujours écrit deux lignes plus bas, dans son audit.
   */
  moduleFr: string | null;
}

export interface ContratAction {
  /** `fichier:fonction` — la même clé que le registre de parité, pour qu'ils se recoupent. */
  id: string;
  fichier: string;
  fonction: string;
  /**
   * COMMENT ON L'APPELLE — et ce n'est pas cosmétique.
   *
   * 98 actions de l'ERP sont des `useActionState` : elles reçoivent l'ÉTAT PRÉCÉDENT avant le
   * formulaire. Appeler `f(formData)` sur l'une d'elles lui ferait lire un formulaire là où
   * elle attend un état, et le vrai formulaire n'arriverait jamais — sans erreur, sans effet,
   * et avec un `{ ok: … }` à l'air normal. Le faux succès parfait, pour une virgule.
   */
  appel: "formulaire" | "etat-formulaire" | "arguments" | "arguments-etat-formulaire" | "objet" | "sans-entree";
  champs: readonly ChampAction[];
  /**
   * COMBIEN DE CHAMPS SONT DES ARGUMENTS POSITIONNELS, avant le formulaire.
   *
   * `editLegalDocument(id, _prev, formData)` : `id` est un ARGUMENT, tout le reste vient du
   * formulaire. Sans ce compte, l'exécuteur ne saurait pas où s'arrête l'un et où commence
   * l'autre — et un rang mal rempli DÉCALE les suivants sans qu'aucune erreur ne le dise
   * (§118.78). Vaut 0 partout ailleurs.
   */
  avantFormulaire: number;
  porte: PorteLue;
  /** L'action écrit-elle en base ? Lu sur les effets réellement présents dans le corps. */
  ecrit: boolean;
  /**
   * LES MODÈLES QU'ELLE ÉCRIT, lus sur ses appels Prisma.
   *
   * C'est le FAIT sur lequel s'arme l'interdiction d'auto-escalade (`generique.ts`). Une garde
   * qui reconnaîtrait les actions sensibles à leur NOM raterait `updateUserRole` — aucun des
   * motifs de `policy/guard.ts` n'attrape ce camel-case — et raterait surtout celle que
   * quelqu'un nommera autrement demain. Le modèle écrit, lui, ne se renomme pas pour échapper
   * à une garde.
   */
  modelesEcrits: readonly string[];
  /** L'action laisse-t-elle une trace d'audit ? */
  audit: boolean;
  /**
   * POURQUOI ON NE PEUT PAS L'APPELER GÉNÉRIQUEMENT — `null` quand on le peut.
   * Une phrase, pas un code : c'est ce qu'un modèle et un humain lisent tous les deux.
   */
  illisible: string | null;
}

/** Une action telle qu'on la trouve dans un fichier : sa signature et son corps. */
export interface SourceAction {
  fichier: string;
  fonction: string;
  signature: string;
  corps: string;
  /**
   * Une fonction d'une aide interne (`actions/internes/`, voir `contrat/internes.ts`) : les imports et les lecteurs
   * de SON module, pour suivre ses écrivains et lire ses champs. Absent pour une fonction du fichier d'actions.
   */
  interne?: { imports: Readonly<Record<string, string>>; lecteurs: Readonly<Record<string, TypeChamp>> };
}

/** Les énums connus, fournis par l'appelant (Prisma les tient ; ce module reste pur). */
export type TableEnums = Readonly<Record<string, readonly string[]>>;
