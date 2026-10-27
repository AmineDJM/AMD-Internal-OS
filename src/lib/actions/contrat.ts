/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CONTRAT D'UNE ACTION — DÉRIVÉ DE SA SOURCE, JAMAIS DÉCLARÉ À CÔTÉ.
 *
 * ── POURQUOI PAS UNE TABLE ÉCRITE À LA MAIN ──────────────────────────────────────────────
 *
 * L'ERP porte 712 actions serveur. Pour qu'Adam puisse en appeler UNE QUELCONQUE, il lui faut
 * savoir ce qu'elle attend. La façon évidente — écrire une fiche par action — a été mesurée
 * ailleurs dans ce dépôt : 520 déclarations d'op, 503 propose/execute, 117 résolveurs. Elle
 * produit exactement le défaut que le dirigeant a nommé : on ajoute la capacité de retirer
 * « classe thérapeutique », pas la capacité de tout faire. Et une table écrite à la main est
 * fausse le jour où quelqu'un ajoute un champ sans y penser — silencieusement.
 *
 * §118.17 : un garde-fou s'arme sur un FAIT DU PROCESSUS, jamais sur une variable qu'un auteur
 * futur devrait penser à poser. Ici le fait est la SOURCE de l'action. Le contrat se dérive
 * d'elle, donc il ne peut pas prendre de retard sur elle.
 *
 * Contrainte qui a décidé de la forme : un fichier `"use server"` ne peut EXPORTER que des
 * fonctions asynchrones. Le contrat ne peut donc pas vivre dans le fichier de l'action ; il
 * est LU depuis lui. Ce module est la lecture — pur, sans un seul import, testable sur une
 * chaîne de caractères, et exécutable partout (§ frontière client/serveur).
 *
 * ── CE QU'IL REFUSE DE DEVINER ───────────────────────────────────────────────────────────
 *
 * Trois choses seulement doivent être EXACTES, parce qu'une erreur sur elles produit un faux
 * succès : l'identité de l'action, les noms de ses champs, et le fait qu'elle écrive. Le reste
 * (le libellé du module, l'indice de porte) peut être approximatif SANS DANGER, parce que
 * l'action revérifie ses droits à l'exécution — la porte lue ici n'autorise rien, elle sert à
 * ne pas proposer ce que la personne ne peut pas faire.
 *
 * Quand les champs ne se lisent PAS à coup sûr, le contrat le DIT (`illisible`) au lieu de
 * rendre une liste plausible (§118.26 : le silence d'une fiche se lit comme une permission de
 * deviner). Une action illisible n'est pas appelable génériquement — sans quoi Adam la
 * appellerait avec des noms de champs inventés, recevrait `{ ok: false }` ou, pire, un
 * `{ ok: true }` n'ayant rien modifié, et annoncerait que c'est fait.
 *
 * `obligatoire: true` veut dire « le code REFUSE sans ce champ », prouvé par sa garde. `false`
 * veut dire « non prouvé obligatoire », pas « facultatif » — et l'asymétrie est voulue : se
 * tromper dans ce sens fait recevoir un refus honnête (« Le nom est obligatoire. »), se
 * tromper dans l'autre ferait déranger un humain pour rien.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
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
}

/** Les énums connus, fournis par l'appelant (Prisma les tient ; ce module reste pur). */
export type TableEnums = Readonly<Record<string, readonly string[]>>;

// ───────────────────────────────────────────────────────────────────────────────────────────
// DÉCOUPAGE DE LA SOURCE
// ───────────────────────────────────────────────────────────────────────────────────────────

const RE_ENTETE = /^export async function ([A-Za-z0-9_]+)\s*\(/gm;

/** Le contenu d'un couple de délimiteurs, par équilibrage. `null` si jamais refermé. */
function equilibrer(source: string, ouvre: number, o: string, f: string): { texte: string; fin: number } | null {
  if (source[ouvre] !== o) return null;
  let profondeur = 0;
  for (let i = ouvre; i < source.length; i++) {
    if (source[i] === o) profondeur++;
    else if (source[i] === f) {
      profondeur--;
      if (profondeur === 0) return { texte: source.slice(ouvre + 1, i), fin: i + 1 };
    }
  }
  return null;
}

/**
 * OÙ COMMENCE LE CORPS — la question a l'air triviale et ne l'est pas.
 *
 * Entre la parenthèse des paramètres et l'accolade du corps, il peut y avoir un type de retour,
 * et ce type peut CONTENIR une accolade : `Promise<{ ok: boolean; error?: string }>`. Prendre
 * « la prochaine accolade » découperait un corps qui commence au milieu du type de retour —
 * l'action rendrait alors moins de champs, ce qui ressemble à une action plus simple, jamais à
 * une erreur. On avance donc en suivant la profondeur des chevrons ET des accolades : le corps
 * s'ouvre à la première accolade rencontrée hors de tout type.
 *
 * ET UN TYPE OBJET PEUT ÊTRE NU — `): { ok: true; demande: X } | { ok: false; error: string } {`.
 * Là, aucun chevron ne l'enveloppe : la première version prenait l'accolade du type pour celle
 * du corps, et le « corps » de la fonction devenait `{ ok: true; demande: X }`. Mesuré sur le
 * parc : CINQ fonctions locales découpées ainsi, dont `lireDemande` — le délégué qui lit les
 * trente champs d'une pièce commerciale — et l'action sortait « aucune lecture de champ trouvée »
 * à trois lignes de ses lectures (§118.78, encore). La règle qui distingue les deux accolades
 * est syntaxique, pas devinée : une accolade ouvre un TYPE quand ce qui la précède attend un
 * opérande de type (`:`, `|`, `&`, `,`, `<`, `(`, `[`, `=>`) ; sinon, c'est le corps. Un type
 * objet reconnu est sauté EN BLOC, chevrons ou pas.
 */
const ATTEND_UN_TYPE = new Set([":", "|", "&", ",", "<", "(", "[", "=>"]);

function debutDuCorps(source: string, apresParams: number): number {
  let profondeur = 0; // chevrons, parenthèses et crochets du type de retour
  let precedent = ""; // le dernier caractère significatif lu (« => » compte pour un)
  for (let i = apresParams; i < source.length; i++) {
    const c = source[i]!;
    if (c === " " || c === "\n" || c === "\r" || c === "\t") continue;
    if (c === "<" || c === "(" || c === "[") profondeur++;
    else if (c === ">" || c === ")" || c === "]") {
      if (profondeur > 0) profondeur--;
      if (c === ">" && precedent === "=") { precedent = "=>"; continue; }
    } else if (c === "{") {
      if (profondeur === 0 && !ATTEND_UN_TYPE.has(precedent)) return i;
      const bloc = equilibrer(source, i, "{", "}");
      if (!bloc) return -1;
      i = bloc.fin - 1;
      precedent = "}";
      continue;
    } else if (c === ";" && profondeur === 0) return -1; // une surcharge sans corps
    precedent = c;
  }
  return -1;
}

/**
 * Les actions exportées d'un fichier, avec leur signature et leur corps.
 *
 * Le découpage se fait par ÉQUILIBRAGE, pas par expression régulière : une première version
 * exigeait `)\s*:` — donc un type de retour — et perdait en silence les trois actions qui n'en
 * déclarent pas. C'est le recoupement avec le registre de parité qui l'a dit ; seul, ce module
 * aurait affiché « 709 actions » avec l'assurance d'en avoir vu 712.
 */
export function decouperActions(fichier: string, source: string): SourceAction[] {
  const out: SourceAction[] = [];
  RE_ENTETE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RE_ENTETE.exec(source)) !== null) {
    const params = equilibrer(source, m.index + m[0].length - 1, "(", ")");
    if (!params) continue;
    const ouvre = debutDuCorps(source, params.fin);
    if (ouvre < 0) continue;
    const corps = equilibrer(source, ouvre, "{", "}");
    out.push({
      fichier, fonction: m[1]!,
      signature: params.texte.replace(/\s+/g, " ").trim(),
      corps: corps ? `{${corps.texte}}` : source.slice(ouvre),
    });
  }
  return out;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UNE ACTION QUI DÉLÈGUE SA LECTURE A QUAND MÊME UNE ENTRÉE — cinq actions le disaient en creux.
 *
 * `createStockAnnex(formData) { return createStockLocation(formData, "ANNEX"); }` sortait avec
 * « aucune lecture de champ trouvée dans le corps — l'entrée attendue reste inconnue ». C'était
 * vrai de SON corps et faux de l'action : la fonction voisine, dans le MÊME fichier, lit `name`
 * à la ligne suivante. Encore §118.78 : le refus était écrit à trois lignes de ce qu'il
 * déclarait ignorer.
 *
 * ── UN SEUL NIVEAU, ET LE MÊME FICHIER ───────────────────────────────────────────────────
 *
 * On ne suit pas une délégation vers un autre module : son texte n'est pas là, et prétendre le
 * contraire rendrait une liste de champs inventée. On ne suit pas non plus deux niveaux : la
 * règle « ce qu'on ne relie pas au formulaire à coup sûr ne déclenche rien » vaut ici comme
 * ailleurs, et un niveau suffit au parc mesuré.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
const RE_LOCALE = /^(?:export\s+)?(?:async\s+)?function ([A-Za-z0-9_]+)\s*\(/gm;

export function fonctionsLocales(source: string): Record<string, SourceAction> {
  const out: Record<string, SourceAction> = {};
  RE_LOCALE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RE_LOCALE.exec(source)) !== null) {
    const params = equilibrer(source, m.index + m[0].length - 1, "(", ")");
    if (!params) continue;
    const ouvre = debutDuCorps(source, params.fin);
    if (ouvre < 0) continue;
    const corps = equilibrer(source, ouvre, "{", "}");
    out[m[1]!] = {
      fichier: "", fonction: m[1]!,
      signature: params.texte.replace(/\s+/g, " ").trim(),
      corps: corps ? `{${corps.texte}}` : source.slice(ouvre),
    };
  }
  return out;
}

/**
 * À QUELLES FONCTIONS DU FICHIER CETTE ACTION PASSE-T-ELLE SON FORMULAIRE ? Toutes, pas la
 * première — et c'est une correction, pas un raffinement.
 *
 * `updateLegalDocument` lit `id` chez elle PUIS appelle `readFields(formData)`, qui lit le titre,
 * la nature, les dates et huit autres champs. Une première version ne suivait la délégation que
 * lorsque le corps ne lisait RIEN : l'action sortait donc « lisible » avec UN SEUL champ. Le
 * résultat n'est pas un manque, c'est un piège : `validerEntree` refuse tout champ hors contrat,
 * donc Adam ne pouvait NI passer le titre NI réussir sans lui — une action décrite et
 * inappelable, le « je ne peux pas » né d'une incohérence interne (§118.83), et une liste de
 * champs plausible mais fausse (§118.26).
 *
 * Le formulaire est le MÊME objet des deux côtés : l'union des clés lues est donc la vérité, et
 * elle ne peut qu'être plus complète. Un seul niveau, dans le seul fichier dont on a le texte.
 */
function deleguesDuCorps(
  corps: string,
  formulaires: readonly string[],
  locales: Readonly<Record<string, SourceAction>>,
  /** Les LECTEURS du fichier (`num(fd, "k")`) : ce ne sont pas des délégations. */
  lecteurs: ReadonlySet<string>,
): SourceAction[] {
  if (formulaires.length === 0) return [];
  const ech = (n: string) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const fd = formulaires.map(ech).join("|");
  // Le formulaire peut arriver à N'IMPORTE QUEL rang (`readParties(user.id, formData)`) :
  // exiger le premier faisait manquer la moitié des délégations.
  const re = new RegExp(`(?<![.\\w$])([A-Za-z0-9_]+)\\s*\\(([^()]*)\\)`, "g");
  const formulaire = new RegExp(`(?<![.\\w$])(?:${fd})(?![\\w$])`);
  const out: SourceAction[] = [];
  for (const m of sansCommentaires(corps).matchAll(re)) {
    if (!formulaire.test(m[2]!)) continue;
    // UN LECTEUR N'EST PAS UN DÉLÉGUÉ, et les confondre a coûté 31 actions d'un coup :
    // `num(fd: FormData, key: string)` reçoit bien le formulaire, mais sa clé EST son
    // paramètre — c'est ce qui en fait un lecteur. Le suivre comme une délégation faisait
    // voir une « lecture calculée » dans le corps d'un helper parfaitement ordinaire, et sept
    // actions de `market-research-actions` devenaient illisibles pour cette seule raison.
    if (lecteurs.has(m[1]!)) continue;
    const cible = locales[m[1]!];
    // Une fonction qui s'appelle elle-même ne dit rien de plus, et la suivre boucle.
    if (cible && cible.corps !== corps && !out.includes(cible)) out.push(cible);
  }
  return out;
}

/**
 * LES SYMBOLES IMPORTÉS D'UN MODULE DU PROJET — `{ a, b as c }` depuis `@/lib/...` ou
 * `@/platform/...`.
 *
 * On ne retient que le code du DÉPÔT : un import de bibliothèque n'écrit pas dans notre base, et
 * lire `node_modules` pour s'en assurer coûterait un scan du monde à chaque dérivation. Le pont
 * de plateforme (`@/platform/in-process/…`) en fait partie — c'est là que vivent les écrivains
 * qu'Adam et l'ERP partagent, la fabrique documentaire la première : une action qui émet une
 * facture par `emettreDocumentDrive` sortait `ecrit: false`, et la carte de confirmation disait
 * « aucune écriture en base détectée » sur un geste qui inscrit une pièce au registre Legal et
 * consomme un numéro (§118.116, par l'autre porte).
 */
export function importsProjet(source: string): Record<string, string> {
  const table: Record<string, string> = {};
  const re = /import\s*\{([^}]*)\}\s*from\s*"(@\/(?:lib|platform|modules)\/[^"]+)"/g;
  for (const m of sansCommentaires(source).matchAll(re)) {
    for (const brut of m[1]!.split(",")) {
      const t = brut.trim();
      if (!t || t.startsWith("type ")) continue; // un TYPE n'écrit rien
      const nom = (t.includes(" as ") ? t.split(" as ")[1]! : t).trim();
      if (nom) table[nom] = m[2]!;
    }
  }
  return table;
}

/**
 * LES FAITS D'ÉCRITURE D'UN DÉLÉGUÉ IMPORTÉ — et c'est un AUTRE mécanisme que la délégation de
 * formulaire, exactement comme l'en-tête de `decrireAction` l'annonçait.
 *
 * ── POURQUOI IL FALLAIT L'AJOUTER ────────────────────────────────────────────────────────
 *
 * `deleguesDuCorps` ne suit un appel que lorsqu'il reçoit le FORMULAIRE — c'est ce qui lui
 * permet d'en lire les CHAMPS. Une action qui sort son écriture dans un module de domaine
 * (`creerDemandeEtatStock({ actorId, … })`) ne passe aucun formulaire : elle sortait donc
 * `ecrit: false`, `modelesEcrits: []`, `audit: false` — c'est-à-dire un MENSONGE sur une action
 * qui crée une tâche, notifie une personne et journalise.
 *
 * Ce que ce mensonge coûte, mesuré : `executer.ts` lit `contrat.ecrit` pour décider s'il faut
 * RELIRE la ligne écrite (§118.81) — « c'est fait » redevient une parole à croire. 49 actions du
 * parc étaient déjà dans cet état avant ce mécanisme.
 *
 * ── CE QU'IL NE FAIT PAS, ET POURQUOI ────────────────────────────────────────────────────
 *
 * Il n'union QUE les trois faits d'écriture, jamais la liste des CHAMPS : les champs restent
 * gouvernés par la délégation de formulaire, qui seule sait qu'un formulaire a voyagé. Les
 * mélanger ferait déclarer, sur une action, des champs qu'aucun formulaire ne lui apporte.
 *
 * Et il ne suit QU'UN NIVEAU. Une chaîne de délégations est un autre problème : la suivre sans
 * borne ferait lire la moitié du dépôt pour décrire une action, et le premier cycle
 * (`a → b → a`) bouclerait. Un niveau non suivi laisse `ecrit: false` — le même défaut, plus
 * loin — mais jamais un fait FAUX.
 *
 * ── IL LIT LE CORPS DE LA FONCTION APPELÉE, JAMAIS LE MODULE ENTIER ──────────────────────
 *
 * La première version lisait le module en entier, avec une justification qui sonnait juste : un
 * écrivain de domaine découpe souvent son écriture en aides internes. Elle était RUINEUSE, et
 * la mesure l'a dit tout de suite : `requireUser` vient de `@/lib/session`, un module qui écrit
 * `UserSession` — donc **593 actions sur 732 se sont mises à déclarer qu'elles touchaient aux
 * sessions**, un modèle que `generique.ts` INTERDIT. Le chemin générique aurait refusé 604
 * actions sur 732. Un refus à tort est pire que le défaut qu'on corrige (§118.27), et celui-là
 * aurait fermé presque tout l'ERP à Adam pour réparer la description de 46 actions.
 *
 * Ce qu'on lit est donc le CORPS de la fonction effectivement appelée, avec la même mécanique
 * que la délégation locale. Le prix est nommé : si cette fonction délègue à son tour dans son
 * propre module, on ne la suit pas. C'est un fait manquant, pas un fait faux — et la seule des
 * deux erreurs qu'on accepte.
 */
export function faitsEcritureImportes(
  corps: string,
  imports: Readonly<Record<string, string>>,
  /** Le source de chaque module importé, par spécificateur. Fourni par le scanner. */
  sources: Readonly<Record<string, string>>,
): { ecrit: boolean; modelesEcrits: string[]; audit: boolean } {
  const vide = { ecrit: false, modelesEcrits: [] as string[], audit: false };
  const noms = Object.keys(imports);
  if (noms.length === 0) return vide;
  const propre = sansCommentaires(corps);
  const modeles = new Set<string>();
  let ecrit = false;
  let audit = false;
  for (const nom of noms) {
    const spec = imports[nom]!;
    const src = sources[spec];
    if (!src) continue; // module non fourni : on ne devine pas ce qu'il fait
    // L'APPEL doit être présent dans le corps, et pas seulement l'import : une action qui
    // importe un écrivain sans l'appeler n'écrit rien.
    const appel = new RegExp(`(?<![.\\w$])${nom.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\(`);
    if (!appel.test(propre)) continue;
    // LE CORPS DE LA FONCTION APPELÉE, et lui seul. Lire le module entier attribuait à chaque
    // action les écritures de `@/lib/session` par le seul fait qu'elle appelle `requireUser`.
    const corpsDelegue = fonctionsLocales(src)[nom]?.corps;
    if (!corpsDelegue) continue; // le symbole n'est pas une fonction de ce module : on ne devine pas
    if (RE_ECRITURE.test(corpsDelegue)) ecrit = true;
    for (const m of modelesEcrits(corpsDelegue)) modeles.add(m);
    if (/recordAudit\s*\(/.test(corpsDelegue)) audit = true;
  }
  return { ecrit, modelesEcrits: [...modeles].sort(), audit };
}

// ───────────────────────────────────────────────────────────────────────────────────────────
// LES VALEURS ADMISES
// ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * Les listes de littéraux déclarées EN TÊTE d'un fichier (`const STATUTS: T[] = [...]`,
 * `new Set([...])`). C'est la forme sous laquelle l'ERP écrit ses allowlists.
 */
export function enumsLocaux(source: string): TableEnums {
  const table: Record<string, readonly string[]> = {};
  const re = /^const\s+([A-Za-z_0-9]+)(?:\s*:\s*[A-Za-z0-9_<>\[\]| ]+)?\s*=\s*(?:new Set\()?\[([^\]]*)\]/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const valeurs = [...m[2]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!);
    if (valeurs.length >= 2) table[m[1]!] = valeurs;
  }
  return table;
}

// ───────────────────────────────────────────────────────────────────────────────────────────
// LA LECTURE D'UNE ACTION
// ───────────────────────────────────────────────────────────────────────────────────────────

export const HELPERS_PARTAGES: Readonly<Record<string, TypeChamp>> = {
  // `fdCase` (§118.172) : la case à cocher PRÉCÉDÉE de son témoin caché — `fdBool` lit la PREMIÈRE
  // valeur, donc le témoin, et une case cochée ne réactivait jamais rien.
  fdStr: "texte", fdNum: "nombre", fdDate: "date", fdBool: "booleen", fdCase: "booleen",
};

/** `id`, `userId`, `dossierId`… désignent une autre fiche. C'est le pont vers `resoudreCible`. */
const estReference = (nom: string): boolean => nom === "id" || /[a-z0-9]Id$/.test(nom);

/**
 * QUE DÉSIGNE CE CHAMP ? LE SCHÉMA RÉPOND, OU PERSONNE.
 *
 * `careBeneficiary.doctorId` pointe vers `MedicalDoctor` parce que la relation Prisma le dit —
 * pas parce que le nom y ressemble. La tentation du nom a été MESURÉE : elle ajoutait 35 champs
 * sur 730, et faisait pointer le `messageId` de la messagerie Microsoft vers le modèle `Message`
 * de l'ERP, deux objets qui n'ont rien à voir. Un champ de plus obtenu en devinant vaut moins
 * qu'un champ de moins obtenu à coup sûr : ici la conséquence d'une erreur est d'agir sur la
 * mauvaise ligne (§118.16, §104.7).
 *
 * PLUSIEURS modèles écrits qui répondent différemment n'en désignent AUCUN (§118.34).
 */
function modeleDesigne(nom: string, modelesEcrits: readonly string[], relations: TableRelations): string | null {
  const ecrits = [...new Set(modelesEcrits.map((m) => m.charAt(0).toUpperCase() + m.slice(1)))];
  const via = [...new Set(ecrits.map((m) => relations[`${m}.${nom}`]).filter((x): x is string => Boolean(x)))];
  return via.length === 1 ? via[0]! : null;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UN LECTEUR LOCAL EST UN LECTEUR — quatre actions le prouvaient en creux.
 *
 * `setOrderArrival` écrit `const parseDate = (k: string) => { const v = fdStr(formData, k); … }`
 * puis `parseDate("expectedArrival")`, `parseDate("arrivedDate")`. Les clés sont LITTÉRALES et
 * à trois lignes de là ; le détecteur de dynamisme, lui, voyait `fdStr(formData, k)` — une clé
 * non littérale — et déclarait toute l'action incompréhensible. C'est §118.78 une fois de plus :
 * le refus était écrit à côté de ce qu'il déclarait ne pas savoir lire.
 *
 * Quatre actions du parc : `setOrderArrival`, `createTask`, `updateVisit`, `saveAdoptionSettings`.
 *
 * ── CE QUI RESTE REFUSÉ, ET C'EST LA MOITIÉ QUI COMPTE ───────────────────────────────────
 *
 * Reconnaître le lecteur ne suffit pas : si on l'APPELLE avec une variable (`clean(champ)` dans
 * une boucle), les clés redeviennent inconnues et l'action redevient illisible. Sans cette
 * seconde règle, on aurait échangé un refus honnête contre une liste de champs INCOMPLÈTE —
 * et un champ manquant peut être celui qui aiguille l'écriture (§118.26).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export function lecteursLocaux(
  corps: string,
  formulaires: readonly string[],
  lecteursConnus: Readonly<Record<string, TypeChamp>>,
): { lecteurs: Record<string, TypeChamp>; parametres: Set<string>; presences: Set<string> } {
  const lecteurs: Record<string, TypeChamp> = {};
  const parametres = new Set<string>();
  const presences = new Set<string>();
  if (formulaires.length === 0) return { lecteurs, parametres, presences };
  const ech = (n: string) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const fd = formulaires.map(ech).join("|");
  const noms = Object.keys(lecteursConnus).map(ech).join("|");
  const propre = sansCommentaires(corps);

  const re = /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?\(([^)]*)\)\s*(?::[^=]*?)?=>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(propre)) !== null) {
    const nom = m[1]!;
    const premier = /^\s*([A-Za-z_$][\w$]*)\s*:\s*string\b/.exec(m[2]!);
    if (!premier) continue;
    const cle = premier[1]!;
    // La FENÊTRE qui suit la flèche : on n'a pas besoin des bornes exactes du corps, seulement
    // d'y trouver la preuve d'une lecture. Trop large ne fait qu'ajouter du contexte ; on ne
    // conclut que sur une occurrence qui NOMME à la fois le formulaire et le paramètre.
    const fenetre = propre.slice(m.index + m[0].length, m.index + m[0].length + 500);
    const k = ech(cle);
    const lit = (methode: string) => new RegExp(`\\b(?:${fd})\\s*\\.\\s*${methode}\\s*\\(\\s*${k}\\s*\\)`).test(fenetre);
    const type: TypeChamp | null =
      lit("getAll") ? "liste"
      : lit("get") ? "texte"
      : (() => {
          const r = new RegExp(`\\b(${noms})\\s*\\(\\s*(?:${fd})\\s*,\\s*${k}\\s*\\)`).exec(fenetre);
          return r ? lecteursConnus[r[1]!]! : null;
        })()
        // UN TEST DE PRÉSENCE n'est pas une lecture (§118.172) : `(cle) => formData.has(cle)` dit
        // si le formulaire PORTE un champ, jamais ce qu'il vaut. Il reste un lecteur local — sans
        // quoi `formData.has(cle)`, clé non littérale, rendrait l'action illisible — mais il ne
        // TYPE rien et ne prouve aucune obligation : `if (porte("wilaya") && !wilaya.ok)` déclarait
        // la wilaya OBLIGATOIRE sur une action qui la rend facultative.
        ?? (lit("has") ? (presences.add(nom), "texte" as const) : null);
    if (!type) continue;
    lecteurs[nom] = type;
    parametres.add(cle);
  }
  return { lecteurs, parametres, presences };
}

/**
 * Le nom du champ est-il CALCULÉ à l'exécution ? Alors on ne peut rien annoncer.
 *
 * Le test porte sur le premier caractère non blanc après la virgule (ou la parenthèse) : un
 * guillemet est un littéral, autre chose est une variable. Une première version testait
 * `[^"]` juste après la virgule et comptait 563 actions sur 619 comme dynamiques — parce
 * qu'un retour à la ligne n'est pas un guillemet. Un détecteur trop large aurait fermé la
 * porte à 90 % du parc en annonçant l'avoir ouverte.
 */
function lectureDynamique(
  corps: string,
  lecteurs: readonly string[],
  formulaires: readonly string[],
  /** Les paramètres des lecteurs LOCAUX : une clé qui porte ce nom-là est littérale à l'appel. */
  parametresLocaux: ReadonlySet<string> = new Set(),
  /** Les lecteurs LOCAUX eux-mêmes : appelés avec une variable, la clé redevient inconnue. */
  locaux: readonly string[] = [],
): boolean {
  const ech = (n: string) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const noms = lecteurs.map(ech).join("|");
  /** La clé lue est-elle le PARAMÈTRE d'un lecteur local ? Alors ce n'est pas du dynamisme. */
  const local = (cle: string | undefined) => Boolean(cle && parametresLocaux.has(cle));
  const cherche = (re: RegExp, rang: number): boolean => {
    for (const m of corps.matchAll(re)) if (!local(m[rang])) return true;
    return false;
  };
  // (a) UN LECTEUR appelé avec une clé qui n'est pas un littéral.
  if (cherche(new RegExp(`\\b(?:${noms})\\s*\\(\\s*[A-Za-z0-9_]+\\s*,\\s*(?!\\s*")([A-Za-z_\`$][\\w$]*)`, "g"), 1)) return true;
  // (d) UN LECTEUR LOCAL appelé avec une variable : reconnaître le lecteur ne suffit pas, il
  //     faut que ses CLÉS soient littérales — sinon on rendrait une liste de champs amputée.
  // LE RÉCEPTEUR COMPTE, ici comme ailleurs (§118.78) : sans le regard négatif sur le point,
  // un lecteur local nommé `has` s'accrochait à `supported.has(a)` — un ENSEMBLE, sans le
  // moindre rapport avec le formulaire — et déclarait l'action illisible. Mesuré sur
  // `updateVisit`, où c'est exactement ce qui se passait.
  if (locaux.length > 0
    && new RegExp(`(?<![.\\w$])(?:${locaux.map(ech).join("|")})\\s*\\(\\s*(?!\\s*")[A-Za-z_\`$]`).test(corps)) return true;
  if (formulaires.length === 0) return false;
  const fd = formulaires.map(ech).join("|");
  // (b) LE FORMULAIRE LUI-MÊME interrogé sur une clé calculée — le récepteur compte : sans lui,
  //     `PROJECT_TEXT.has(field)` (un ENSEMBLE) faisait passer l'action pour dynamique.
  if (cherche(new RegExp(`\\b(?:${fd})\\s*\\.\\s*(?:get|getAll|has)\\s*\\(\\s*(?!\\s*")([A-Za-z_\`$][\\w$]*)`, "g"), 1)) return true;
  // (c) LE FORMULAIRE PARCOURU : on ne sait alors rien annoncer.
  return new RegExp(`\\b(?:${fd})\\s*\\.\\s*(?:entries|keys|forEach)\\s*\\(`).test(corps);
}

/** Une action qui touche la base — lu sur les appels réellement présents. */
const RE_ECRITURE = /prisma\s*\.\s*[A-Za-z0-9_]+\s*\.\s*(?:create|createMany|update|updateMany|upsert|delete|deleteMany)\b|\$executeRaw|\$transaction/;
const RE_MODELE_ECRIT = /(?:prisma|tx)\s*\.\s*([A-Za-z0-9_]+)\s*\.\s*(?:create|createMany|update|updateMany|upsert|delete|deleteMany)\b/g;

/** Les modèles Prisma qu'une action ÉCRIT — `prisma.user.update` comme `tx.rowGrant.createMany`. */
function modelesEcrits(corps: string): string[] {
  const vus = new Set<string>();
  for (const m of corps.matchAll(RE_MODELE_ECRIT)) vus.add(m[1]!);
  return [...vus].sort();
}

function lirePorte(corps: string, constantes: Readonly<Record<string, string>>): PorteLue {
  let module: string | null = null, verbe: string | null = null, entite: string | null = null;
  const audit = /recordAudit\s*\(\s*\{[^}]*?\bmodule\s*:\s*(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/s.exec(corps);
  const moduleFr = audit ? (audit[1] ?? constantes[audit[2]!] ?? null) : null;
  const gardes = new Set<string>();

  const rc = /userCan\s*\(\s*[A-Za-z0-9_.]+\s*,\s*(?:"([A-Z_]+)"|([A-Z_0-9]+))\s*,\s*"([A-Z_]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = rc.exec(corps)) !== null) {
    module ??= m[1] ?? constantes[m[2]!] ?? m[2]!;
    verbe ??= m[3]!;
    gardes.add("userCan");
  }
  const re = /canAccessEntity\s*\(\s*[A-Za-z0-9_.]+\s*,\s*(?:"([A-Z_]+)"|([A-Z_0-9]+))\s*,/g;
  while ((m = re.exec(corps)) !== null) {
    entite ??= m[1] ?? constantes[m[2]!] ?? m[2]!;
    gardes.add("canAccessEntity");
  }
  // Les autres gardes de l'ERP, telles qu'écrites. La liste est OUVERTE par construction :
  // on relève ce qui ressemble à une garde, et ne pas en reconnaître une ne rend rien faux —
  // l'exécution revérifie de toute façon.
  // `peut…` : les prédicats de droit écrits en français au socle (`peutPiloterMissionsAdam`,
  // `peutEmettrePieces`) — sans eux, une action gardée par une RÈGLE et non par un module
  // sortait avec `gardes: []`, c'est-à-dire l'air de n'être gardée par rien (§118.136).
  //
  // `sits…`, `siege…`, `holds…` : les prédicats de SIÈGE et de VERROU. Mesuré sur les fichiers
  // `"use server"` du parc — trois gardes réelles qu'aucun préfixe ne voyait : le siège du centre
  // de PAIEMENT (`sitsOnPaymentCentre`, en production depuis toujours), celui du centre Ad & Pro
  // (`siegeAuCentreAdPro`) et le cadenas d'un dossier confidentiel (`holdsRegulatoryLock`) — cette
  // dernière NOMMÉE par §118.80, constatée et laissée. Ce n'est pas un fait de sécurité qui change
  // (l'action garde exactement les mêmes gardes) : c'est ce que la CARTE de confirmation sait dire
  // à la personne avant qu'elle clique (§118.80, §118.120).
  //
  // `allowed…` et `autorise…` sont DÉLIBÉRÉMENT dehors : la même mesure a trouvé
  // `allowedGeneralMeansCategoryIds`, qui rend une LISTE D'IDENTIFIANTS et non un droit. On relève
  // une garde sur un fait, jamais sur un nom plausible (§118.79a) — l'inscrire ferait annoncer une
  // garde là où il n'y a qu'une lecture de catégories.
  //
  // Un APPEL DE MÉTHODE n'est pas une garde (§118.172) : `Array.isArray(`, `Number.isFinite(`,
  // `Number.isNaN(` s'écrivent comme un prédicat de droit, et 37 fiches du parc annonçaient
  // « isFinite » ou « isArray » parmi leurs gardes. Mesuré sur toutes les sources d'actions : aucun
  // prédicat de droit ne s'appelle comme méthode — le point qui précède suffit à les écarter.
  for (const g of corps.matchAll(/(?<![.\w$])(require[A-Z][A-Za-z]*|assert[A-Z][A-Za-z]*|can[A-Z][A-Za-z]*|has[A-Z][A-Za-z]*|is[A-Z][A-Za-z]*|peut[A-Z][A-Za-z]*|sits[A-Z][A-Za-z]*|siege[A-Z][A-Za-z]*|holds[A-Z][A-Za-z]*)\s*\(/g)) {
    if (g[1] !== "requireUser") gardes.add(g[1]!);
  }
  return { module, verbe, entite, moduleFr, gardes: [...gardes].sort() };
}

/**
 * À QUEL RANG L'ACTION REÇOIT-ELLE SON FORMULAIRE ?
 *
 * `null` quand elle n'en prend pas, ou quand il arrive APRÈS un argument qu'on ne saurait pas
 * fournir — deux actions de l'ERP prennent `(id, prev, formData)`, et deviner leur premier
 * argument reviendrait à choisir la cible à la place d'un humain. On le DIT au lieu de tenter.
 */
/**
 * LE NOM SOUS LEQUEL LE FORMULAIRE ARRIVE — et ses alias directs.
 *
 * Sans lui, le détecteur de lecture dynamique s'armait sur `.get|.getAll|.has` SANS REGARDER
 * LE RÉCEPTEUR, donc sur n'importe quel `.has(variable)` du corps. Mesuré : 19 des 27 actions
 * déclarées « noms de champs calculés à l'exécution » ne l'étaient pas du tout — leurs `.has`
 * portaient sur des ENSEMBLES (`PROJECT_TEXT.has(field)`, `CREATOR_DELETABLE.has(kind)`),
 * c'est-à-dire des tests d'appartenance sans le moindre rapport avec un formulaire. Une garde
 * armée sur une forme qui ignore son récepteur refuse ce qu'elle n'a pas regardé.
 *
 * Les ALIAS comptent : `const fd = formData` est du même objet, et fermer les yeux dessus
 * ferait déclarer COMPLÈTE une liste de champs qui ne l'est pas — le sens dangereux de
 * l'erreur, car un champ manquant peut être celui qui AIGUILLE l'écriture (`kind === "project"`
 * choisit la table). On ne suit pas une déstructuration ni un passage par argument : ce qu'on
 * ne relie pas au formulaire à coup sûr ne déclenche rien, et c'est la limite ASSUMÉE de ce
 * lecteur — elle est ici pour qu'on la lise avant de s'y fier.
 */
export function nomsDuFormulaire(signature: string, corps: string): string[] {
  const rang = rangDuFormulaire(signature);
  if (rang === null) return [];
  const params: string[] = [];
  let prof = 0, cur = "";
  for (const c of signature) {
    if ("<([{".includes(c)) prof++;
    else if (">)]}".includes(c)) prof--;
    if (c === "," && prof === 0) { params.push(cur); cur = ""; continue; }
    cur += c;
  }
  if (cur.trim()) params.push(cur);
  const nom = /(\w+)\s*:/.exec(params[rang] ?? "")?.[1];
  if (!nom) return [];
  const noms = new Set([nom]);
  // Les alias DIRECTS, autant de fois qu'il en faut (`const a = formData; const b = a;`).
  for (let i = 0; i < 3; i++) {
    for (const m of corps.matchAll(/(?:const|let)\s+(\w+)\s*=\s*(\w+)\s*;/g)) {
      if (noms.has(m[2]!)) noms.add(m[1]!);
    }
  }
  return [...noms];
}

/**
 * À QUEL RANG L'ACTION REÇOIT-ELLE SON FORMULAIRE ? `null` si elle n'en prend pas.
 *
 * Mesuré sur le parc : 100 actions au rang 1 — TOUTES avec l'état précédent de `useActionState`
 * juste avant — et 2 au rang 2, `(id: string, _prev: ActionResult | undefined, formData)`. Le
 * rang n'est donc pas une borne arbitraire : c'est la convention React, et le paramètre qui
 * précède immédiatement le formulaire est TOUJOURS l'état précédent.
 */
export function rangDuFormulaire(signature: string): number | null {
  if (!/FormData/.test(signature)) return null;
  const params: string[] = [];
  let profondeur = 0, courant = "";
  for (const c of signature) {
    if ("<([{".includes(c)) profondeur++;
    else if (">)]}".includes(c)) profondeur--;
    if (c === "," && profondeur === 0) { params.push(courant); courant = ""; continue; }
    courant += c;
  }
  if (courant.trim()) params.push(courant);
  const rang = params.findIndex((p) => /FormData/.test(p));
  return rang >= 0 ? rang : null;
}

/**
 * LE CONTRAT D'UNE ACTION.
 *
 * `constantes` porte les `const X = "…"` du fichier (pour résoudre `userCan(user, MODULE, …)`),
 * `enums` les valeurs admises connues — celles du fichier ET celles du schéma, fournies par
 * l'appelant pour que ce module n'importe rien.
 */
export function decrireAction(
  src: SourceAction,
  constantes: Readonly<Record<string, string>> = {},
  enums: TableEnums = {},
  /** Les lecteurs de champ RECONNUS dans ce fichier, en plus des quatre helpers partagés. */
  lecteursDuFichier: Readonly<Record<string, TypeChamp>> = {},
  /** Ce que le schéma dit des références. Vide = aucun champ ne portera de modèle. */
  relations: TableRelations = {},
  /** Les fonctions du MÊME fichier, pour suivre une délégation d'UN niveau. */
  locales: Readonly<Record<string, SourceAction>> = {},
  /**
   * LES SYMBOLES IMPORTÉS PAR LE FICHIER (`nom` → `@/lib/...`) et LE SOURCE de chaque module,
   * par spécificateur. Les imports vivent dans l'EN-TÊTE du fichier et non dans le corps de
   * l'action : `contratsDuFichier` les résout UNE fois pour tout le fichier, et le scanner —
   * seul à lire le disque — fournit les sources.
   *
   * Vides = aucun délégué importé n'est suivi, et les faits d'écriture restent ceux du corps :
   * c'est le comportement d'AVANT ce mécanisme, donc le défaut ne s'aggrave jamais de son
   * absence.
   */
  importsFichier: Readonly<Record<string, string>> = {},
  sourcesImportees: Readonly<Record<string, string>> = {},
): ContratAction {
  const { fichier, fonction, signature, corps } = src;
  /**
   * CE QUE LE CORPS DE L'ACTION DIT D'ELLE-MÊME. `deleguesDuCorps` ne suit une délégation LOCALE
   * que lorsqu'un formulaire est passé : les branches sans formulaire n'ont rien à en unir.
   */
  const baseCorps = {
    id: `${fichier}:${fonction}`,
    fichier, fonction, avantFormulaire: 0,
    porte: lirePorte(corps, constantes),
    ecrit: RE_ECRITURE.test(corps),
    modelesEcrits: modelesEcrits(corps),
    audit: /recordAudit\s*\(/.test(corps),
  };

  // ── LE DÉLÉGUÉ IMPORTÉ, LUI, NE DÉPEND D'AUCUNE FORME D'APPEL (§118.158) ────────────────
  //
  // `faitsEcritureImportes` suit un APPEL, pas un formulaire. Il n'était pourtant lu qu'après
  // la branche des formulaires : une action SANS entrée, ou à arguments typés, qui confie son
  // écriture à un module de domaine sortait `ecrit: false`, `modelesEcrits: []`. Trouvé sur
  // `leverBlocageSite`, dont le délégué écrit `appSetting` — un réglage, c'est-à-dire l'un des
  // modèles que `generique.ts` interdit : la garde d'auto-escalade ne le VOYAIT pas, et la carte
  // aurait dit « aucune écriture en base détectée » sur le geste qui désarme un disjoncteur.
  // C'est l'angle mort que §118.119f a fermé pour les formulaires, rouvert par la porte d'à
  // côté (§118.71). Les modèles importés s'unissent à ce qu'on DÉCLARE, jamais à ce qu'on
  // attribue aux champs (voir « DEUX CONSOMMATEURS » plus bas) : l'attribution reste lue sur
  // `baseCorps.modelesEcrits`.
  const importes = faitsEcritureImportes(corps, importsFichier, sourcesImportees);
  const declares = {
    ecrit: baseCorps.ecrit || importes.ecrit,
    modelesEcrits: [...new Set([...baseCorps.modelesEcrits, ...importes.modelesEcrits])].sort(),
    audit: baseCorps.audit || importes.audit,
  };

  const rang = rangDuFormulaire(signature);
  if (rang === null) {
    // Sans argument : rien à décrire, donc APPELABLE. C'est le cas des bascules (« révoquer
    // toutes les sessions »). Une entrée typée, elle, ne passe pas par un formulaire : Adam ne
    // saurait pas fabriquer l'objet, et le dire vaut mieux que de tenter.
    if (signature === "") {
      return { ...baseCorps, ...declares, appel: "sans-entree", champs: [], illisible: null };
    }
    // L'OBJET UNIQUE D'ABORD : `lireArguments` le refuserait pour « pas une valeur simple »,
    // alors que ses membres sont écrits dans la signature (§118.87).
    const objet = lireObjetUnique(signature);
    const lue = objet && "champs" in objet ? objet : objet ?? lireArguments(signature);
    const forme = objet ? "objet" as const : "arguments" as const;
    return "champs" in lue
      ? {
          ...baseCorps, ...declares, appel: forme, illisible: null,
          champs: lue.champs.map((ch) => (ch.type === "reference" || (ch.type === "liste" && estReference(ch.nom))
            ? { ...ch, modele: modeleDesigne(ch.nom, baseCorps.modelesEcrits, relations) }
            : ch)),
        }
      : {
          ...baseCorps, ...declares, appel: forme, champs: [],
          illisible: `entrée typée (${signature}) — ${lue.refus}`,
        };
  }

  // ── CE QUI PRÉCÈDE LE FORMULAIRE ────────────────────────────────────────────────────────
  //
  // Le paramètre JUSTE AVANT est l'état précédent de `useActionState` : on le remplit avec
  // `undefined`, ce qu'un premier envoi lui donne de toute façon. Il doit l'ACCEPTER — sans
  // cette vérification, un jour quelqu'un écrirait `(id, autreChose, formData)` et l'on
  // passerait `undefined` à une valeur obligatoire, en silence (§118.78).
  const params = decouperParametres(sansCommentaires(signature)).map((p) => p.trim()).filter(Boolean);
  const etat = rang >= 1 ? params[rang - 1] ?? "" : "";
  if (rang >= 1 && !/\|\s*undefined\b/.test(etat) && !/^\w+\?\s*:/.test(etat)) {
    return {
      ...baseCorps, appel: "etat-formulaire" as const, champs: [],
      illisible: `le paramètre « ${etat.split(":")[0]!.trim()} » précède le formulaire sans accepter `
        + `« undefined » — ce n'est pas l'état précédent d'un formulaire React, et on ne devine pas sa valeur`,
    };
  }
  const avant: ChampAction[] = [];
  for (const brut of params.slice(0, Math.max(0, rang - 1))) {
    const lu = lireUnParametre(brut);
    if (!lu) continue;
    if ("refus" in lu) {
      return {
        ...baseCorps, appel: "arguments-etat-formulaire" as const, champs: [],
        illisible: `entrée mixte (${sansCommentaires(signature).replace(/\s+/g, " ").trim()}) — le paramètre ${lu.refus}`,
      };
    }
    avant.push({ ...lu.champ, modele: modeleDesigne(lu.champ.nom, baseCorps.modelesEcrits, relations) });
  }
  const appel = rang === 0
    ? "formulaire" as const
    : avant.length > 0 ? "arguments-etat-formulaire" as const : "etat-formulaire" as const;

  const lecteurs = { ...HELPERS_PARTAGES, ...lecteursDuFichier };
  const formulaires = nomsDuFormulaire(signature, corps);
  const locaux = lecteursLocaux(corps, formulaires, lecteurs);
  const tousLecteurs = { ...lecteurs, ...locaux.lecteurs };
  const delegues = deleguesDuCorps(corps, formulaires, locales, new Set(Object.keys(tousLecteurs)));

  // ── CE QU'UNE DÉLÉGATION ÉCRIT EST CE QUE L'ACTION ÉCRIT ────────────────────────────────
  //
  // MESURÉ, et c'était mon propre défaut. `createSector` valide son entrée puis passe le
  // formulaire à `ecrireSecteur`, qui écrit TROIS tables et enregistre un audit. Le corps de
  // l'action, lui, n'écrit rien : elle sortait donc `ecrit: false`, `modelesEcrits: []`,
  // `audit: false` — une action qui écrit trois tables DÉCRITE comme une lecture, en silence.
  //
  // Deux coûts nommables, et le second est le vrai. La carte de confirmation doit dire ce que
  // le geste TOUCHE (§118.83) : elle aurait présenté une écriture comme une consultation. Et
  // `actions/generique.ts` arme sa garde d'auto-escalade sur le MODÈLE ÉCRIT lu dans la source
  // (§118.74) : une action qui délègue son écriture est INVISIBLE à cette garde — c'est l'angle
  // mort du FAIT que §118.78 a déjà payé sur `mission-runtime-actions`, et le refermer là sans
  // le refermer ici laisserait une porte non gardée à côté d'une porte gardée (§118.71).
  //
  // Le remède est celui que §118.87c a déjà posé pour les CHAMPS : l'union, un seul niveau,
  // dans le seul fichier dont on a le texte. Elle ne peut qu'ÉLARGIR ce qu'on déclare écrire —
  // donc au pire elle refuse davantage, jamais moins.
  //
  // ── ET LE DÉLÉGUÉ D'UN AUTRE FICHIER ───────────────────────────────────────────────────
  //
  // `deleguesDuCorps` ne suit un appel que lorsqu'il reçoit le FORMULAIRE — c'est ce qui lui
  // permet d'en lire les champs. Une action qui sort son écriture dans un module de DOMAINE
  // (`creerDemandeEtatStock({ actorId, … })`) ne passe aucun formulaire, et sortait donc
  // `ecrit: false` : le mensonge d'au-dessus, par la porte d'à côté. MESURÉ avant d'y toucher :
  // 49 actions du parc portaient un nom d'écriture et se déclaraient sans écriture.
  //
  // `faitsEcritureImportes` est donc un SECOND mécanisme, plus étroit — trois faits, jamais les
  // champs, un seul niveau. L'écrivain ne peut PAS revenir dans le fichier de l'action : un
  // `"use server"` n'exporte que des fonctions asynchrones, et chacune devient un point
  // d'entrée appelable SANS la garde de l'action. Sortir l'écriture était donc obligatoire, et
  // rendre la dérivation aveugle n'était pas une option. (`importes` est lu plus haut, avant
  // l'aiguillage des formes d'appel : il vaut pour toutes.)
  //
  // ── DEUX CONSOMMATEURS, DEUX BESOINS — et les confondre a coûté 187 champs ──────────────
  //
  // `modelesEcrits` sert deux questions qui ne veulent pas la même chose :
  //   · la garde d'auto-escalade veut TOUS les modèles touchés — plus large est plus sûr ;
  //   · `lireChamps` cherche le modèle PRIMAIRE auquel attribuer une référence — plus large
  //     est plus AMBIGU, donc il renonce à nommer.
  //
  // MESURÉ en unissant les deux : `notification`, `auditLog` et `expenseOrder` entrant dans la
  // liste, 198 actions ont perdu l'attribution de leurs références et le parc est passé de 546
  // champs modélisés à 359 — le plancher de désignation (500) est tombé, et avec lui la
  // capacité d'Adam à viser une ligne par son nom plutôt que par un `cuid` (§118.85).
  //
  // Les modèles d'un délégué IMPORTÉ n'entrent donc PAS dans ce que lit `lireChamps` : ils
  // s'unissent au contrat APRÈS, là où seule la garde les consulte. `ecrit` et `audit`, eux,
  // sont des booléens sans effet sur l'attribution : ils s'unissent tout de suite.
  const base = {
    ...baseCorps,
    ecrit: baseCorps.ecrit || delegues.some((d) => RE_ECRITURE.test(d.corps)) || importes.ecrit,
    modelesEcrits: [...new Set([...baseCorps.modelesEcrits, ...delegues.flatMap((d) => modelesEcrits(d.corps))])],
    audit: baseCorps.audit || delegues.some((d) => /recordAudit\s*\(/.test(d.corps)) || importes.audit,
  };
  /** Les modèles à DÉCLARER — l'union complète, une fois l'attribution des champs faite. */
  const modelesDeclares = [...new Set([...base.modelesEcrits, ...importes.modelesEcrits])].sort();

  if (lectureDynamique(corps, Object.keys(lecteurs), formulaires, locaux.parametres, Object.keys(locaux.lecteurs))) {
    return {
      ...base, modelesEcrits: modelesDeclares, appel, champs: [],
      illisible: "les noms de champs sont calculés à l'exécution — la source ne les énonce pas",
    };
  }

  const testesSeulement = new Set<string>();
  const propres = lireChamps(
    corps, enums, tousLecteurs, base.modelesEcrits, relations, Object.keys(locaux.lecteurs), formulaires, locaux.presences,
    testesSeulement,
  );

  // CE QUE LES FONCTIONS DU FICHIER LISENT DANS LE MÊME FORMULAIRE (voir `deleguesDuCorps`).
  //
  // UN DÉLÉGUÉ DYNAMIQUE N'EFFACE PAS CE QU'ON SAIT — mesuré, et j'avais d'abord tranché dans
  // l'autre sens. `createRequest` lit son titre, son type et sa société EN CLAIR, puis appelle
  // `collectAllFields(formData)`, qui ramasse les champs personnalisés `f_*`. Rendre l'action
  // illisible pour cette raison coûtait une capacité RÉELLE — créer une demande administrative
  // — pour protéger d'un défaut qui n'existe pas : un champ personnalisé en plus n'a jamais
  // empêché l'action de réussir. Un refus à tort est pire que le défaut qu'on corrige (§118.27).
  // On IGNORE donc ce délégué-là, et l'on ne le déclare illisible que s'il ne reste RIEN.
  let delegueMuet: string | null = null;
  const parDelegation: ChampAction[] = [];
  for (const d of delegues) {
    const fdD = nomsDuFormulaire(d.signature, d.corps);
    const locD = lecteursLocaux(d.corps, fdD, lecteurs);
    if (lectureDynamique(d.corps, Object.keys(lecteurs), fdD, locD.parametres, Object.keys(locD.lecteurs))) {
      delegueMuet ??= d.fonction;
      continue;
    }
    parDelegation.push(...lireChamps(
      d.corps, enums, { ...lecteurs, ...locD.lecteurs }, base.modelesEcrits, relations, Object.keys(locD.lecteurs),
      fdD, locD.presences,
    ));
  }
  // UN TEST DE PRÉSENCE CÈDE À UNE LECTURE TYPÉE, et pas seulement dans le même corps. Une
  // écriture partielle teste `formData.has("startDate")` puis passe la main à `readFields`, qui lit
  // la DATE : le corps de l'action était lu en premier et « startDate : texte » gagnait l'union —
  // une date, une liste de parties, redevenues du texte dans le contrat (mesuré sur
  // `updateLegalDocument`, §118.194). La règle est celle du corps unique : un champ seulement
  // testé ne se déclare que si personne d'autre ne le lit.
  const typesParDelegation = new Set(parDelegation.map((ch) => ch.nom));
  const vus = new Set<string>();
  const duFormulaire = [...propres.filter((ch) => !(testesSeulement.has(ch.nom) && typesParDelegation.has(ch.nom))), ...parDelegation]
    .filter((ch) => (vus.has(ch.nom) ? false : (vus.add(ch.nom), true)))
    .sort((a, b) => a.nom.localeCompare(b.nom));
  // UN ARGUMENT ET UN CHAMP DE MÊME NOM ne peuvent pas coexister : l'entrée n'aurait qu'une
  // valeur pour deux places, et l'on ne saurait pas laquelle la personne a voulu remplir.
  const collision = avant.map((a) => a.nom).filter((n) => duFormulaire.some((f) => f.nom === n));
  if (collision.length > 0) {
    return {
      ...base, modelesEcrits: modelesDeclares, appel, champs: [],
      illisible: `« ${collision.join(", ") }» est à la fois un argument et un champ du formulaire — `
        + `une seule valeur ne peut pas remplir deux places`,
    };
  }
  const champs = [...avant, ...duFormulaire];
  if (duFormulaire.length > 0) {
    return { ...base, modelesEcrits: modelesDeclares, appel, champs, avantFormulaire: avant.length, illisible: null };
  }

  return {
    ...base, modelesEcrits: modelesDeclares, appel, champs: [],
    illisible: delegueMuet
      ? `« ${delegueMuet} » lit le formulaire pour cette action et calcule ses noms de champs à `
        + `l'exécution — rien dans la source n'énonce l'entrée attendue`
      : "aucune lecture de champ trouvée dans le corps — l'entrée attendue reste inconnue",
  };
}

function lireChamps(
  corps: string,
  enums: TableEnums,
  lecteurs: Readonly<Record<string, TypeChamp>>,
  modelesEcrits: readonly string[],
  relations: TableRelations,
  /** Les lecteurs LOCAUX, appelés avec la seule clé (`parseDate("arrivedDate")`). */
  locaux: readonly string[] = [],
  /** Les noms sous lesquels le corps tient le FORMULAIRE (paramètre et alias directs). */
  formulaires: readonly string[] = [],
  /** Les lecteurs locaux qui ne font que TESTER la présence (`(k) => formData.has(k)`). */
  presences: ReadonlySet<string> = new Set(),
  /** REMPLI par la fonction : les champs que ce corps n'a fait que TESTER (voir l'union des délégués). */
  seulementTestes?: Set<string>,
): ChampAction[] {
  const parNom = new Map<string, ChampAction>();
  /** Le nom de variable sous lequel un champ a été rangé — pour retrouver sa garde et son cast. */
  const variableDe = new Map<string, string>();
  /** Les champs seulement TESTÉS (présence) — déclarés à la fin, s'ils ne sont lus nulle part. */
  const faibles = new Set<string>();

  const poser = (nom: string, type: TypeChamp) => {
    const deja = parNom.get(nom);
    // LA CARDINALITÉ L'EMPORTE SUR CE QUE LA VALEUR DÉSIGNE — deux axes, jamais confondus
    // (§118.16). `setRowGrants` lit `getAll("rowId")` : c'est une LISTE de références. Une
    // première version laissait le nom en `…Id` écraser la liste, et Adam aurait accordé UNE
    // ligne là où la personne en demandait vingt — un faux succès parfait, l'écran affichant
    // simplement moins de droits que prévu.
    const t = type === "liste" || deja?.type === "liste"
      ? "liste"
      : estReference(nom) ? "reference" : type;
    if (!deja || t !== deja.type) {
      parNom.set(nom, {
        nom, type: t, obligatoire: deja?.obligatoire ?? false, valeurs: deja?.valeurs ?? null,
        modele: deja?.modele ?? null,
      });
    }
  };

  // LES LECTEURS SONT CEUX DU FICHIER, pas une liste de quatre noms (voir `helpersDuFichier`).
  const noms = Object.keys(lecteurs).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  for (const m of corps.matchAll(new RegExp(`(?:const|let)\\s+([A-Za-z_0-9]+)\\s*=\\s*(?:await\\s+)?(${noms})\\s*\\(\\s*[A-Za-z0-9_]+\\s*,\\s*"([^"]+)"`, "g"))) {
    poser(m[3]!, lecteurs[m[2]!]!);
    variableDe.set(m[3]!, m[1]!);
  }
  for (const m of corps.matchAll(new RegExp(`\\b(${noms})\\s*\\(\\s*[A-Za-z0-9_]+\\s*,\\s*"([^"]+)"`, "g"))) {
    poser(m[2]!, lecteurs[m[1]!]!);
  }
  // LES LECTEURS LOCAUX prennent la CLÉ SEULE : `parseDate("arrivedDate")`. Les faire passer
  // par les motifs à deux arguments ci-dessus ne les verrait jamais.
  if (locaux.length > 0) {
    const nomsLocaux = locaux.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    for (const m of corps.matchAll(new RegExp(`(?:const|let)\\s+([A-Za-z_0-9]+)\\s*=\\s*(?:await\\s+)?(${nomsLocaux})\\s*\\(\\s*"([^"]+)"`, "g"))) {
      if (presences.has(m[2]!)) { faibles.add(m[3]!); continue; }
      poser(m[3]!, lecteurs[m[2]!]!);
      variableDe.set(m[3]!, m[1]!);
    }
    for (const m of corps.matchAll(new RegExp(`\\b(${nomsLocaux})\\s*\\(\\s*"([^"]+)"`, "g"))) {
      if (presences.has(m[1]!)) { faibles.add(m[2]!); continue; }
      poser(m[2]!, lecteurs[m[1]!]!);
    }
  }
  // LE RÉCEPTEUR COMPTE (§118.79b, §118.172) : `user.access.modules.get("MEDICAL")` n'est pas un
  // champ du formulaire, `presents.has("institution")` (un ENSEMBLE de colonnes) non plus — et
  // l'import des praticiens déclarait « MEDICAL », « institution », « service » et « delegate »
  // comme des champs à remplir. Les lectures directes se bornent aux noms du formulaire.
  const recepteur = formulaires.length > 0
    ? `\\b(?:${formulaires.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\s*`
    : "";
  for (const m of corps.matchAll(new RegExp(`${recepteur}\\.getAll\\s*\\(\\s*"([^"]+)"`, "g"))) poser(m[1]!, "liste");
  for (const m of corps.matchAll(new RegExp(`${recepteur}\\.get\\s*\\(\\s*"([^"]+)"`, "g"))) poser(m[1]!, "texte");
  // UN TEST DE PRÉSENCE DÉCLARE un champ, il ne le TYPE pas : `formData.has("capDaysPerMonth")`
  // précède `num(formData, "capDaysPerMonth")` dans une écriture partielle, et la dernière passe
  // gagnait — un nombre redevenait du texte. Il ne pose qu'un champ que rien d'autre n'a lu.
  for (const m of corps.matchAll(new RegExp(`${recepteur}\\.has\\s*\\(\\s*"([^"]+)"`, "g"))) faibles.add(m[1]!);
  for (const nom of faibles) if (!parNom.has(nom)) { poser(nom, "texte"); seulementTestes?.add(nom); }

  for (const champ of parNom.values()) {
    const v = variableDe.get(champ.nom);
    if (v) {
      champ.obligatoire = new RegExp(`if\\s*\\(\\s*!\\s*${v}\\b|\\|\\|\\s*!\\s*${v}\\b|&&\\s*!\\s*${v}\\b`).test(corps);
      champ.valeurs = valeursAdmises(corps, v, enums);
    }
    if (!champ.valeurs) champ.valeurs = valeursAdmisesInline(corps, champ.nom, enums);
    // Une LISTE de références (`getAll("rowId")`) porte aussi son modèle : la cardinalité et ce
    // que la valeur désigne sont deux axes, et les confondre a déjà coûté (§118.16).
    if (champ.type === "reference" || (champ.type === "liste" && estReference(champ.nom))) {
      champ.modele = modeleDesigne(champ.nom, modelesEcrits, relations);
    }
  }
  return [...parNom.values()].sort((a, b) => a.nom.localeCompare(b.nom));
}

/** `X as StatutProjet` ou `LISTE.includes(x)` — deux façons dont l'ERP borne une valeur. */
function valeursAdmises(corps: string, variable: string, enums: TableEnums): readonly string[] | null {
  const cast = new RegExp(`\\b${variable}\\s+as\\s+([A-Za-z_][A-Za-z0-9_]*)`).exec(corps);
  if (cast && enums[cast[1]!]) return enums[cast[1]!]!;
  for (const [nom, valeurs] of Object.entries(enums)) {
    if (new RegExp(`\\b${nom}\\b\\s*\\.\\s*(?:includes|has)\\s*\\(\\s*${variable}\\b`).test(corps)) return valeurs;
  }
  return null;
}

/** Le cas `fdStr(fd, "status") as StatutProjet`, sans variable intermédiaire. */
function valeursAdmisesInline(corps: string, nom: string, enums: TableEnums): readonly string[] | null {
  // Deux formes réelles, et la seconde a échappé à la première version : `fdStr(fd, "k") as T`
  // et `(fdStr(fd, "k") ?? "AUTRE") as T` — la parenthèse fermante n'est pas au même endroit.
  const echappe = nom.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const lecture = `(?:fdStr|fdNum)\\s*\\(\\s*[A-Za-z0-9_]+\\s*,\\s*"${echappe}"\\s*\\)`;
  for (const motif of [
    `${lecture}(?:\\s*\\?\\?\\s*"[^"]*")?\\s+as\\s+([A-Za-z_][A-Za-z0-9_]*)`,
    `\\(\\s*${lecture}\\s*\\?\\?\\s*"[^"]*"\\s*\\)\\s+as\\s+([A-Za-z_][A-Za-z0-9_]*)`,
  ]) {
    const m = new RegExp(motif).exec(corps);
    if (m && enums[m[1]!]) return enums[m[1]!]!;
  }
  return null;
}

/** Les `const X = "…"` d'un fichier — pour résoudre `userCan(user, MODULE, …)`. */
/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * QUI LIT UN CHAMP DE FORMULAIRE ? — la question posée à la SOURCE, pas à une liste.
 *
 * Le lecteur ne connaissait que `fdStr`, `fdNum`, `fdDate`, `fdBool`. Or le parc en compte
 * QUATORZE : `str` (114 appels), `num` (30), `int` (9), `list`, `readIds`, `fd`, `posInt`,
 * `fdList`, `parseIds`, `checked`, `fdDateTime`… Résultat mesuré : 23 actions déclarées
 * « aucune lecture de champ trouvée dans le corps » — dont DIX-HUIT du seul
 * `regulatory-actions.ts`, où chaque champ est pourtant nommé en clair
 * (`str(formData, "priority")`). Le refus était celui du LECTEUR, pas de la source : §118.78,
 * une seconde fois, à un autre étage.
 *
 * ── SUR QUOI LA RECONNAISSANCE S'ARME ────────────────────────────────────────────────────
 *
 * Pas sur une liste de noms — elle serait fausse au quinzième helper, EN SILENCE (§118.73).
 * Sur la DÉFINITION : une fonction dont le premier paramètre est un `FormData` et le second
 * une clé `string`. C'est exactement ce qu'est un lecteur de champ, et c'est ce qui distingue
 * `str(formData, "id")` de `createStockLocation(formData, "ANNEX")` — dont le second
 * paramètre est une union de littéraux (`"HOSPITAL" | "ANNEX"`), donc une VALEUR et non une
 * clé. Ce faux positif existe dans le parc ; sans ce point, on aurait déclaré un champ nommé
 * « ANNEX » qui n'a jamais existé.
 *
 * Le TYPE vient du type de RETOUR déclaré. Un helper qui n'en déclare pas rend « texte » :
 * ce n'est pas une supposition, c'est le medium — un `FormData` ne transporte que du texte, et
 * `enFormulaire` sérialise tout. Se tromper de type sur un champ de formulaire coûte une
 * indication au modèle, jamais un appel faux (contrairement aux ARGUMENTS positionnels, où le
 * type gouverne la valeur réellement passée — d'où la rigueur inverse là-bas).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export function helpersDuFichier(source: string): Record<string, TypeChamp> {
  const out: Record<string, TypeChamp> = {};
  // `function NAME(p: FormData, k: string): RET` ET `const NAME = (p: FormData, k: string): RET =>`
  const re = /(?:function|const)\s+([A-Za-z_][\w]*)\s*(?:=\s*)?(?:async\s*)?\(\s*\w+\s*:\s*FormData\s*,\s*\w+\s*:\s*string\s*\)\s*(?::\s*([^={\n]+))?/g;
  for (const m of source.matchAll(re)) {
    const retour = (m[2] ?? "").trim();
    out[m[1]!] = typeDuRetour(retour);
  }
  return out;
}

/** Ce qu'un type de retour dit du champ. Inconnu → « texte », la nature même d'un formulaire. */
function typeDuRetour(retour: string): TypeChamp {
  const t = retour.replace(/\s+/g, " ").replace(/Promise<(.*)>/, "$1").trim();
  if (/^(?:readonly )?string\s*\[\]/.test(t)) return "liste";
  if (/^number\b/.test(t)) return "nombre";
  if (/^Date\b/.test(t)) return "date";
  if (/^boolean\b/.test(t)) return "booleen";
  return "texte";
}

export function constantesDuFichier(source: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of source.matchAll(/^const\s+([A-Za-z_][A-Za-z_0-9]*)\s*(?::[^=]+)?=\s*"([^"]+)"/gm)) out[m[1]!] = m[2]!;
  return out;
}

/** Tous les contrats d'un fichier — le point d'entrée pur, testable sur une chaîne. */
export function contratsDuFichier(
  fichier: string,
  source: string,
  enumsSchema: TableEnums = {},
  relations: TableRelations = {},
  /** Le source des modules `@/lib/...` importés par ce fichier — fourni par le scanner. */
  sourcesImportees: Readonly<Record<string, string>> = {},
): ContratAction[] {
  const constantes = constantesDuFichier(source);
  const enums = { ...enumsSchema, ...enumsLocaux(source) };
  const lecteurs = helpersDuFichier(source);
  const locales = fonctionsLocales(source);
  // UNE FOIS PAR FICHIER : les imports sont un fait de l'en-tête, pas de chaque action.
  const imports = importsProjet(source);
  return decouperActions(fichier, source).map((a) =>
    decrireAction(a, constantes, enums, lecteurs, relations, locales, imports, sourcesImportees));
}

/**
 * CE QU'ON DIT AU MODÈLE. Une phrase par action, lisible par un humain comme par un modèle —
 * et qui NOMME son ignorance au lieu de la taire.
 */
export function direContrat(c: ContratAction): string {
  if (c.illisible) return `${c.id} — non appelable directement : ${c.illisible}`;
  if (c.champs.length === 0) return `${c.id} — sans entrée.`;
  const champ = (ch: ChampAction) => {
    const marque = ch.obligatoire ? "" : " (facultatif)";
    const val = ch.valeurs ? ` ∈ {${ch.valeurs.join(", ")}}` : "";
    // CE QU'UNE RÉFÉRENCE DÉSIGNE, quand le schéma le dit : sans cette mention, un modèle ne
    // peut pas savoir qu'il a le droit d'écrire un NOM là où le type dit « reference », et il
    // invente un identifiant ou renonce. Ce que le code accepte, la fiche doit le dire (§118.19).
    const quoi = ch.modele ? `→${ch.modele}` : "";
    return `${ch.nom} : ${ch.type}${quoi}${val}${marque}`;
  };
  return `${c.id} — ${c.champs.map(champ).join(" ; ")}`;
}

// ───────────────────────────────────────────────────────────────────────────────────────────
// UNE ACTION À ARGUMENTS SE LIT AUSSI
// ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * 67 REFUS IMPRIMAIENT LA SIGNATURE QU'ILS DÉCLARAIENT NE PAS SAVOIR LIRE.
 *
 * « entrée typée (missionId: string) — cette action ne s'appelle pas par un formulaire » :
 * le nom du paramètre, son type et son rang étaient DANS le message. C'est un « je ne peux
 * pas » artificiel écrit dans le CODE, comme le contrôle des livrables qui déclarait « aucun
 * moteur de calcul Excel dans le dépôt » alors que le dossier d'à côté en portait un
 * (§118.59) et comme l'ingestion qui renvoyait océriser à la main (§118.63). On TRADUIT au
 * lieu de refuser (§118.34).
 *
 * ── POURQUOI LA LECTURE EST TOUT-OU-RIEN ─────────────────────────────────────────────────
 *
 * Un formulaire est NOMMÉ : une clé manquante arrive vide et l'action s'en plaint. Un appel
 * positionnel est MUET : un argument manquant devient `undefined` au bon rang, et la fonction
 * part quand même. Un paramètre mal lu ne dégrade donc pas la lecture — il DÉCALE tous les
 * suivants, et `renameDocument(id, name)` appelé de travers renomme avec l'identifiant.
 * Un seul paramètre illisible rend TOUTE la signature illisible : ici, lire quatre paramètres
 * sur cinq est strictement pire que n'en lire aucun.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Ce qu'on sait traduire — et rien d'autre. Un type absent d'ici rend la signature illisible. */
const TYPES_SIMPLES: Readonly<Record<string, TypeChamp>> = {
  string: "texte", number: "nombre", boolean: "booleen", Date: "date",
  "string[]": "liste", "readonly string[]": "liste",
};

/**
 * L'IDENTITÉ DE L'ACTEUR, reconnue au NOM du paramètre — et refusée.
 *
 * Toute action d'écran tient son acteur de la SESSION (`requireUser`) ; celle qui le reçoit en
 * argument fait confiance à son appelant. Le bouton est un appelant sûr, un modèle ne l'est
 * pas : ouvrir ce paramètre, c'est permettre d'agir au nom de quelqu'un d'autre — exactement
 * ce qu'`executerAction` refuse déjà en ne transmettant PAS `user` (§118.7).
 *
 * La liste est FERMÉE et COURTE, parce qu'une garde large — « tout paramètre finissant par
 * Id » — refuserait `missionId`, `taskId`, `messageId`, c'est-à-dire la quasi-totalité du
 * parc, pour se protéger d'un risque qu'aucune de ces actions ne porte. Le refus NOMME la raison.
 *
 * La seule action qui a été dans ce cas (`rememberExchange`) n'est plus une action : le refus au
 * chemin générique ne fermait pas son point d'entrée public, et elle vit désormais dans un module
 * serveur ordinaire (`lib/memoire-echange.ts`, §118.153). La règle reste, pour la prochaine.
 */
const IDENTITE_ACTEUR = /^(userId|actorId|asUser|onBehalfOf|accountId|sessionUserId|impersonate\w*)$/i;

/**
 * Découpe une liste au niveau ZÉRO — un `{ a: string }` ne se coupe pas en deux.
 *
 * `separateurs` vaut « , » pour des paramètres et « ,; » pour les MEMBRES d'un type objet, que
 * TypeScript accepte séparés par l'un ou l'autre. Deux découpeurs auraient divergé au premier
 * membre écrit avec l'autre signe (§118.5).
 */
function decouperParametres(signature: string, separateurs = ","): string[] {
  const out: string[] = [];
  let prof = 0, cur = "";
  for (const ch of signature) {
    if ("{<([".includes(ch)) prof++;
    else if ("}>)]".includes(ch)) prof--;
    if (separateurs.includes(ch) && prof === 0) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** Une union de littéraux (`"GRANTED" | "REFUSED"`) — les valeurs admises, lues sans les deviner. */
function litterauxUnion(type: string): string[] | null {
  const parts = type.split("|").map((p) => p.trim());
  if (parts.length < 2 || !parts.every((p) => /^"[^"]*"$/.test(p))) return null;
  return parts.map((p) => p.slice(1, -1));
}

/** Le résultat d'une lecture de signature : des champs, ou la RAISON exacte du refus (§118.30). */
export type LectureArguments = { champs: ChampAction[] } | { refus: string };

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UN PARAMÈTRE OBJET LITTÉRAL SE LIT — ses membres SONT écrits dans la signature.
 *
 * `setInvoicePaid(input: { id: string; paidDate: string | null })` était refusée pour « le type
 * de « input » n'est pas une valeur simple ». C'est le refus de §118.78 recommencé un cran plus
 * bas : la source ÉNONCE `id` et `paidDate`, avec leurs types, à l'endroit exact où le refus
 * disait ne rien savoir. Treize actions du parc sont dans ce cas.
 *
 * ── POURQUOI SEULEMENT LE PARAMÈTRE UNIQUE ───────────────────────────────────────────────
 *
 * Un appel positionnel est MUET : rien ne signale un rang mal rempli (§118.78). Mélanger des
 * rangs simples et un objet demanderait de savoir, champ par champ, dans quel rang il va — un
 * état de plus à tenir juste, pour un gain que le parc ne réclame pas : les treize actions
 * concernées prennent TOUTES un objet unique. On lit ce cas-là, exactement, et l'on refuse le
 * reste en le NOMMANT.
 *
 * La lecture reste TOUT-OU-RIEN : un membre au type illisible (un objet imbriqué, un type
 * importé) rend toute la signature illisible. Livrer un objet amputé d'un champ ferait appeler
 * l'action avec une clé manquante — et une clé absente n'est pas une clé vide (§118.71).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export function lireObjetUnique(signature: string): LectureArguments | null {
  // LES COMMENTAIRES PARTENT D'ABORD, pas membre par membre : une phrase de documentation
  // contient des virgules, et découper dedans coupait un membre en deux — donc une liste de
  // champs AMPUTÉE, c'est-à-dire le sens dangereux de l'erreur (§118.78).
  const propre = sansCommentaires(signature);
  const params = decouperParametres(propre).map((p) => p.trim()).filter(Boolean);
  if (params.length !== 1) return null;
  const m = /^(\w+)\??\s*:\s*\{([\s\S]*)\}\s*$/.exec(params[0]!.replace(/,$/, "").trim());
  if (!m) return null;
  const membres = decouperParametres(m[2]!, ",;");
  const champs: ChampAction[] = [];
  for (const brut of membres) {
    const lu = lireUnParametre(brut);
    if (!lu) continue;
    if ("refus" in lu) return { refus: `le membre ${lu.refus} de « ${m[1]} »` };
    champs.push(lu.champ);
  }
  return champs.length ? { champs } : null;
}

/**
 * UN PARAMÈTRE (ou un MEMBRE d'objet), lu ou refusé avec sa raison. `null` = rien à lire ici
 * (une virgule finale, un commentaire seul) — ce n'est pas un refus.
 */
export const sansCommentaires = (t: string): string =>
  t.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

/**
 * UNE VALEUR PAR DÉFAUT LITTÉRALE N'EST PAS UN CALCUL.
 *
 * `spaceId: string | null = null` dit « facultatif, et voici ce que vaut son absence » — on
 * peut l'omettre sans rien changer. `now = new Date()` est autre chose : sa valeur est
 * CALCULÉE à l'appel, et la remplir depuis une demande ferait écrire une date choisie par un
 * modèle là où le code voulait « maintenant ». La liste des littéraux est FERMÉE, parce qu'un
 * détecteur qui accepterait « tout ce qui ne ressemble pas à un appel » finirait par laisser
 * passer une constante importée dont on ne sait rien.
 */
const DEFAUT_LITTERAL = /^(null|undefined|true|false|""|''|``|\[\]|\{\}|-?\d+(?:\.\d+)?)$/;

function lireUnParametre(brut: string): { champ: ChampAction } | { refus: string } | null {
  const p = sansCommentaires(brut).trim().replace(/[,;]$/, "");
  if (!p) return null;
  if (p.startsWith("...")) return { refus: `« ${p.slice(0, 30)} » est variadique` };
  const avantType = p.split(":")[0] ?? "";
  const egal = p.indexOf("=");
  if (avantType.includes("=") || /[^=!<>]=[^=>]/.test(p)) {
    const defaut = egal >= 0 ? p.slice(egal + 1).trim() : "";
    if (!DEFAUT_LITTERAL.test(defaut)) {
      return { refus: `« ${avantType.split("=")[0]!.trim()} » a une valeur par défaut CALCULÉE (${defaut.slice(0, 30)})` };
    }
    // Littérale : le paramètre est FACULTATIF, et l'omettre rend exactement ce défaut.
    return lireUnParametre(`${p.slice(0, egal).replace(/:/, "?:")}`);
  }
  const m = /^(\w+)(\?)?\s*:\s*([\s\S]+)$/.exec(p);
  if (!m) return { refus: `« ${p.slice(0, 40)} » n'est pas un nom simple typé` };
  const nom = m[1]!;
  let optionnel = Boolean(m[2]);
  let type = m[3]!.replace(/\s+/g, " ").trim();

  if (IDENTITE_ACTEUR.test(nom)) {
    return {
      refus: `« ${nom} » porte l'identité de l'ACTEUR — une action qui reçoit son auteur au lieu `
        + `de le lire dans la session ne s'appelle que depuis un écran`,
    };
  }
  if (/\|\s*undefined$/.test(type)) { type = type.replace(/\|\s*undefined$/, "").trim(); optionnel = true; }
  // `| null` dit qu'on accepte l'ABSENCE DE VALEUR, jamais l'absence d'ARGUMENT : sauter le
  // rang décalerait tous les suivants. Le champ reste donc obligatoire.
  if (/\|\s*null$/.test(type)) type = type.replace(/\|\s*null$/, "").trim();

  const valeurs = litterauxUnion(type);
  const simple = valeurs ? "texte" as const : TYPES_SIMPLES[type];
  if (!simple) return { refus: `« ${nom} » (${type}) n'est pas une valeur simple` };
  // MÊME RÈGLE DE RÉFÉRENCE QUE LE FORMULAIRE : `missionId` désigne une mission des deux
  // côtés. Deux conventions selon la façon d'appeler feraient qu'« arrête la mission de
  // consolidation » se résoudrait dans un cas et exigerait un cuid dans l'autre.
  return {
    champ: {
      nom,
      type: simple === "texte" && !valeurs && estReference(nom) ? "reference" : simple,
      obligatoire: !optionnel,
      valeurs: valeurs ?? null,
      // Le modèle désigné ne se lit pas dans la SIGNATURE : il vient du schéma croisé avec les
      // écritures de l'action, que `decrireAction` seule connaît. Elle le pose juste après.
      modele: null,
    },
  };
}

export function lireArguments(signature: string): LectureArguments {
  const champs: ChampAction[] = [];
  for (const brut of decouperParametres(signature)) {
    const lu = lireUnParametre(brut);
    if (!lu) continue;
    if ("refus" in lu) return { refus: `le paramètre ${lu.refus}` };
    champs.push(lu.champ);
  }
  return champs.length ? { champs } : { refus: "aucun paramètre lisible" };
}

