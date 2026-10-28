import { RESUME_POUR_PLANNER } from "@/lib/events/catalogue";
import { COMPLEXITIES, SCALES, APPROVAL_STRATEGIES } from "@/lib/missions/planner/contract";
import { EFFECT_RANK, type Effect } from "@/lib/missions/registry/capability-meta";
import { EFFET_NOEUD } from "@/lib/missions/registry/node-effect";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE SCHÉMA IMPOSÉ AU PLANNER (§2) — une sortie structurée STRICTE, pas de la prose analysée.
 *
 * ── POURQUOI UN SCHÉMA PLUTÔT QU'UN « RÉPONDS EN JSON » ──────────────────────────────────
 *
 * « Réponds en JSON » produit du JSON neuf fois sur dix, et la dixième fois produit du JSON
 * précédé d'une phrase polie. On passe alors sa vie à écrire des rattrapages : couper avant la
 * première accolade, retirer les blocs de code, réparer une virgule. Chacun de ces rattrapages
 * est une invitation à accepter une réponse à moitié valide.
 *
 * Ici la conformité est imposée par le FOURNISSEUR (`strict: true`). Une réponse non conforme
 * n'arrive pas : elle échoue. Et un échec franc est infiniment plus exploitable qu'un objet
 * plausible auquel il manque un champ.
 *
 * ── LES TROIS CONTRAINTES DU MODE STRICT, ET CE QU'ELLES NOUS ONT FAIT CHANGER ───────────
 *
 *   1. tout objet doit porter `additionalProperties: false` ;
 *   2. `required` doit lister TOUTES les propriétés — l'optionnel se dit `["string","null"]` ;
 *   3. aucun objet libre n'est permis.
 *
 * La troisième a une conséquence de fond, et c'est une BONNE conséquence : le planner ne peut
 * pas nous rendre un « objet quelconque ». Ni l'entrée d'une étape, ni le schéma de sortie d'un
 * worker. Il les décrit donc en LISTES DE CHAMPS TYPÉS, et c'est le CODE qui en fabrique
 * l'objet et le JSON Schema. Le modèle décide QUOI ; le code décide COMMENT — littéralement.
 *
 * ── CE QUI N'EST PAS DANS CE SCHÉMA, VOLONTAIREMENT ──────────────────────────────────────
 *
 * Aucun champ ne permet de nommer un modèle, d'accorder un droit, de désigner un rôle ERP ou
 * de lever un garde-fou. Le vocabulaire du planner est CLOS : ce qu'il ne peut pas dire, il ne
 * peut pas le demander. C'est le premier des trois verrous, avant `policy/guard.ts` et la
 * seconde garde du moteur.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Le type d'une valeur d'entrée, pour reconstruire un objet sans jamais accepter d'objet libre. */
export const INPUT_KINDS = ["TEXT", "NUMBER", "BOOLEAN", "JSON"] as const;
export type InputKind = (typeof INPUT_KINDS)[number];

/** Les types que le planner peut demander dans un schéma de sortie de worker. */
export const FIELD_TYPES = ["string", "number", "boolean", "string[]"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

const str = (description: string) => ({ type: "string", description });
const nullableStr = (description: string) => ({ type: ["string", "null"], description });
const enumOf = (values: readonly string[], description: string) => ({
  type: "string",
  enum: [...values],
  description,
});

/** Un objet strict : toutes les propriétés requises, aucune propriété libre. */
function objet(properties: Record<string, unknown>, description?: string) {
  return {
    type: "object",
    ...(description ? { description } : {}),
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

const PAIRE_ENTREE = objet(
  {
    key: str("Le nom du champ attendu (« to », « subject »)."),
    kind: enumOf(INPUT_KINDS, "JSON pour une liste ou un objet écrit en JSON."),
    value: str(
      "La valeur, TOUJOURS en texte. Sortie d'une étape : {{cle_etape.chemin}} ; "
        + "valeur courante d'un éventail : {{alias.champ}}.",
    ),
  },
  "Un champ d'entrée. Les objets libres n'existent pas : on décrit, le code reconstruit.",
);

const CHAMP_SORTIE = objet(
  {
    name: str("Nom du champ attendu en sortie du worker."),
    type: enumOf(FIELD_TYPES, "Le type du champ."),
    description: str("Ce que ce champ doit contenir, en une phrase."),
  },
  "Un champ du résultat attendu d'un WORKER.",
);

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'ÉTAPE, EN VARIANTES — parce qu'un appel de capacité n'a rien à dire d'une attente.
 *
 * ── CE QUE LA MESURE A MONTRÉ ────────────────────────────────────────────────────────────
 *
 * Un run réel a chiffré le coût de l'étape unique : 265 jetons de SORTIE VISIBLE par étape,
 * sur des plans de 8 à 15 étapes, pour un planificateur qui pesait 79 % du temps total. Le
 * schéma imposait 21 champs obligatoires à CHAQUE étape — le mode strict exige que tous soient
 * écrits — dont huit valaient `null` dans une étape CAPABILITY ordinaire : les cinq `wait*` et
 * les trois `forEach*`. Le modèle écrivait donc, pour chaque appel de capacité, cinq champs
 * d'attente d'événement et trois champs d'éventail, tous vides.
 *
 * ── LA CORRECTION, ET SA SEULE VRAIE DIFFICULTÉ ──────────────────────────────────────────
 *
 * Le sous-ensemble strict admet `anyOf` imbriqué. Une étape est donc décrite par la variante
 * de son `nodeType`, discriminée par un `const` : une CAPABILITY porte `capability`, `inputs`
 * et son éventail ; une WAIT_EVENT porte ce qu'elle attend ; une JOIN ne porte que le tronc
 * commun. Personne n'écrit plus les champs d'un autre type.
 *
 * La difficulté n'est pas d'écrire les variantes, c'est de ne rien PERDRE : un champ oublié
 * dans une variante devient un champ que le planificateur ne peut plus exprimer, et le manque
 * ne se verrait qu'à l'exécution. `schema.test.ts` compare donc l'union des variantes au
 * vocabulaire du contrat, champ par champ.
 *
 * ── CE QUI RESTE COMMUN, ET POURQUOI ─────────────────────────────────────────────────────
 *
 * Cinq champs valent pour TOUTE étape et ne peuvent pas descendre dans une variante sans être
 * recopiés huit fois : l'identité (`key`, `title`), la place dans le graphe (`workstream`,
 * `dependsOn`) et la condition de fin (`completionCondition`), qui est ce que le contrôle
 * qualité relit — une étape sans elle serait invérifiable, quel que soit son type.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/**
 * LE TRONC COMMUN — ce qu'une étape est, indépendamment de ce qu'elle fait.
 *
 * ── LES DESCRIPTIONS SONT COURTES ICI, ET C'EST MESURÉ ───────────────────────────────────
 *
 * Ces cinq champs sont recopiés dans les HUIT variantes : chaque mot y est payé huit fois, en
 * jetons d'ENTRÉE, à chaque appel de planification. La première écriture des variantes portait
 * les descriptions longues du schéma unique et faisait passer le schéma de 2 113 à 4 711
 * jetons — on avait gagné 24 % en sortie pour en perdre 2 600 en entrée.
 *
 * Le raisonnement derrière chaque règle (« jamais un numéro : un numéro change au moindre
 * replan ») vit dans la CONSIGNE, envoyée UNE fois et mise en cache par le fournisseur. Le
 * schéma, lui, dit le format. C'est le bon partage : l'un explique, l'autre contraint.
 */
const COMMUN = {
  key: str("Identité stable et lisible (« liste:salaries »), jamais un numéro."),
  title: str("Ce que fait l'étape, en français."),
  workstream: nullableStr("L'axe de travail, ou null."),
  dependsOn: {
    type: "array",
    items: { type: "string" },
    description: "Les clés des étapes à terminer AVANT celle-ci.",
  },
  completionCondition: str("La condition VÉRIFIABLE de fin. « 33 reçus », pas « bien fait »."),
  when: {
    type: ["object", "null"],
    description: "Étape CONDITIONNELLE : ne part que si l'issue (outcome) ou la sortie (path/op/value) de l'étape amont `step` répond ; sinon elle est ignorée. null pour une étape inconditionnelle.",
    properties: {
      step: str("La clé de l'étape amont observée."),
      outcome: nullableStr("EVENT (attente réglée par un fait), TIMEOUT (réglée par le temps), DONE, FAILED ou SKIPPED. null si seule la sortie compte."),
      path: nullableStr("Le champ de la sortie amont à tester (« prix », « payload.montant »). null sinon."),
      op: nullableStr("eq, ne, gt, gte, lt, lte, contains, exists ou empty. null sinon."),
      value: nullableStr("La valeur comparée, en texte. null pour exists/empty."),
    },
    required: ["step", "outcome", "path", "op", "value"],
    additionalProperties: false,
  },
};

/**
 * LE DISCRIMINANT — un `enum` à une seule valeur.
 *
 * Sans description : elle ne dirait que ce que la valeur dit déjà, et serait payée huit fois.
 */
const typeConst = (n: string, description?: string) =>
  (description ? { type: "string", enum: [n], description } : { type: "string", enum: [n] });

/**
 * L'ÉVENTAIL, EN UN SEUL CHAMP AU LIEU DE TROIS.
 *
 * Trois chaînes nullables obligeaient à écrire trois `null` sur chaque étape non répétée. Un
 * objet nullable en écrit un — et rend impossible l'état incohérent « deux champs sur trois »,
 * que le code devait auparavant détecter à la reconstruction.
 */
const EVENTAIL = {
  type: ["object", "null"],
  description: "Pour une étape RÉPÉTÉE sur une collection. null sinon.",
  properties: {
    from: str("La clé de l'étape amont qui produit la collection."),
    path: str("Le chemin de la collection dans sa sortie (« salaries »)."),
    as: str("Le nom sous lequel chaque élément est injecté (« salarie »)."),
  },
  required: ["from", "path", "as"],
  additionalProperties: false,
};

const ENTREES = {
  type: "array",
  items: PAIRE_ENTREE,
  description: "Les champs d'entrée. Liste vide si aucun.",
};

const MAX_ESSAIS = { type: ["integer", "null"], description: "Essais avant échec, ou null." };

// Le niveau d'accord PROPOSÉ : la politique de la maison tranche ensuite, et proposer NONE ne
// dispense de rien. Le dire dans la CONSIGNE plutôt qu'ici, où c'est payé deux fois.
const APPROBATION = enumOf(["NONE", "NORMAL", "SENSITIVE", "CRITICAL"], "Le niveau d'accord proposé.");

const DELAI = { type: ["integer", "null"], description: "Jours avant relance, ou null." };

/** Un appel de capacité — le cas courant, et le plus fréquent de loin. */
const ETAPE_CAPABILITY = objet({
  ...COMMUN,
  nodeType: typeConst("CAPABILITY"),
  capability: str("Le nom EXACT d'une capacité de la liste fournie. Ne jamais inventer un nom."),
  inputs: ENTREES,
  forEach: EVENTAIL,
  approvalRequirement: APPROBATION,
  maxAttempts: MAX_ESSAIS,
});

/** Un travail de modèle : rédiger, résumer, classer. Sortie structurée, jamais du texte libre. */
const ETAPE_WORKER = objet({
  ...COMMUN,
  nodeType: typeConst("WORKER"),
  inputs: ENTREES,
  forEach: EVENTAIL,
  outputFields: {
    type: "array",
    items: CHAMP_SORTIE,
    description: "Les champs EXACTS attendus en retour. Au moins un.",
  },
  reasoningRequirement: enumOf(
    ["NONE", "LIGHT", "HEAVY"],
    "NONE = extraire/classer/reformuler ; LIGHT = rédiger court ; HEAVY = arbitrer, juger, rédiger ce qu'on signe.",
  ),
  maxAttempts: MAX_ESSAIS,
});

/**
 * UNE BRANCHE D'ATTENTE COMPOSÉE — les mêmes champs qu'une attente simple, à plat.
 *
 * Tout est nullable : une branche « e-mail de Sarah » n'écrit que `from`, une branche « au plus
 * tard vendredi » n'écrit que `until`. Une branche entièrement nulle est écartée à la
 * reconstruction.
 */
const BRANCHE_ATTENTE = {
  type: "object",
  properties: {
    event: nullableStr(`Le type de fait — un type du catalogue (${RESUME_POUR_PLANNER}). null si seule l'échéance compte.`),
    from: nullableStr("De qui. null si indifférent."),
    entity: nullableStr("L'entité concernée, en TYPE:id. null sinon."),
    until: nullableStr("Échéance ISO 8601 (calculée depuis la date du jour du contexte). null sinon."),
    threadId: nullableStr("E-mail : le FIL exact — toujours le préférer quand on répond à un fil connu. null sinon."),
    subject: nullableStr("E-mail : fragment d'objet attendu. null sinon."),
    attachment: {
      type: ["boolean", "string", "null"],
      description: "E-mail : pièce jointe EXIGÉE — true (n'importe laquelle) ou un motif de nom (« contrat », « *.pdf »). "
        + "null si aucune pièce n'est requise. Un e-mail SANS la pièce attendue ne règle PAS l'attente.",
    },
  },
  required: ["event", "from", "entity", "until", "threadId", "subject", "attachment"],
  additionalProperties: false,
};

const BRANCHES = (sens: string) => ({
  type: ["array", "null"],
  items: BRANCHE_ATTENTE,
  description: sens,
});

/** Une attente d'ÉVÉNEMENT métier : la mission dort sans consommer de modèle. */
const ETAPE_WAIT_EVENT = objet({
  ...COMMUN,
  nodeType: typeConst("WAIT_EVENT"),
  waitEvent: str(`Le type de fait attendu — un type du catalogue : ${RESUME_POUR_PLANNER}. Les faits externes (signature DocuSign ou e-signature, commande ou facture SAP, appel d'offres PCH, transaction CRM, données IQVIA, webhook) arrivent par l'ingestion universelle. « TEMPS » si seule l'échéance waitUntil compte.`),
  waitFrom: nullableStr("De qui l'on attend le fait (nom, identifiant ou adresse). null si indifférent."),
  waitEntity: nullableStr(
    "L'entité concernée, en TYPE:id — UNIQUEMENT un identifiant déjà CONNU (ENTITÉS ACTIVES, SUJET EN COURS, ou l'identifiant "
    + "rendu par une étape qui CRÉE ou LIT un dossier précis). JAMAIS un gabarit vers une étape de RECHERCHE (search_*, find_*, "
    + "list_*) : une recherche rend une liste, pas un identifiant sûr — l'attente échouerait. Sans identifiant connu : null, et "
    + "cibler l'attente par waitSubject (fragment du titre / de l'objet) et waitFrom.",
  ),
  waitWithinDays: DELAI,
  waitUntil: nullableStr(
    "RÉVEIL TEMPOREL, ISO 8601 : « attends jusqu'à demain 9h » → calcule l'instant depuis la date du jour "
    + "du contexte. Se COMBINE avec un fait : fait OU échéance, le premier arrivé. null sinon.",
  ),
  waitThreadId: nullableStr("E-mail : le FIL exact attendu (threadId) — le préférer aux heuristiques. null sinon."),
  waitSubject: nullableStr("Fragment du TITRE ou de l'OBJET attendu, insensible à la casse — l'objet d'un e-mail, le titre d'une enveloppe de signature, d'un document, d'un appel d'offres (« Contrat Consulting Mouffok »). C'est le bon ciblage quand l'identifiant n'est pas connu. null sinon."),
  waitAttachment: {
    type: ["boolean", "string", "null"],
    description: "E-mail : pièce jointe EXIGÉE — true ou un motif de nom (« *.pdf »). Un e-mail sans la pièce ne règle pas l'attente. null sinon.",
  },
  waitAnyOf: BRANCHES("OU : l'attente se règle dès qu'UNE branche est satisfaite (« sa réponse, ou vendredi 18h »). null sinon."),
  waitAllOf: BRANCHES("ET : l'attente se règle quand TOUTES les branches le sont (« le contrat ET le devis ») — la progression survit aux redémarrages. null sinon."),
});

/** Une attente d'une PERSONNE qui doit fournir quelque chose. */
const ETAPE_WAIT_INPUT = objet({
  ...COMMUN,
  nodeType: typeConst("WAIT_INPUT"),
  waitAsk: str("Ce qu'on demande à la personne, en français."),
  waitFrom: nullableStr("À qui on le demande. null si le propriétaire de la mission."),
  waitWithinDays: DELAI,
});

/** Une porte d'approbation. */
const ETAPE_APPROVAL = objet({
  ...COMMUN,
  nodeType: typeConst("APPROVAL"),
  approvalRequirement: APPROBATION,
});

/**
 * LES NŒUDS DE STRUCTURE — QA et JOIN, réunis parce qu'ils ont la MÊME forme.
 *
 * Un contrôle compte, une jonction attend : ni l'un ni l'autre ne porte de capacité, d'entrée
 * ou d'attente. Leur donner deux variantes recopierait le tronc commun une huitième fois pour
 * une distinction que le seul `nodeType` exprime déjà.
 */
const ETAPE_STRUCTURE = objet({
  ...COMMUN,
  nodeType: enumOf(["QA", "JOIN"], "QA contrôle et compte ; JOIN attend ses dépendances."),
});

/**
 * La production d'un fichier : le modèle décrit, le code fabrique.
 *
 * ── POURQUOI CETTE VARIANTE PORTE UNE DESCRIPTION, ET PAS LES SIX AUTRES ────────────────
 *
 * WORKER, WAIT_EVENT, JOIN, APPROVAL sont expliqués dans les RÈGLES du prompt. ARTIFACT ne
 * l'était NULLE PART : ni règle, ni description de schéma — `typeConst` n'en portait pas.
 * MESURÉ sur la chaîne humaine live : la demande dit « fais-moi un fichier Excel et une
 * présentation PowerPoint », le contexte dit « cette demande EXIGE DOCUMENT », et le plan
 * revient sans une seule étape qui produise un fichier. Deux fois. Le modèle savait QUOI on
 * lui demandait ; personne ne lui avait dit AVEC QUOI le faire.
 *
 * Le compilateur, lui, comptait déjà ce nœud comme portant DOCUMENT. L'exigence et le moyen
 * de la satisfaire vivaient dans le même code sans jamais se rencontrer chez le modèle.
 */
const ETAPE_ARTIFACT = objet({
  ...COMMUN,
  nodeType: typeConst("ARTIFACT",
    "L'étape qui PRODUIT UN FICHIER livrable (classeur Excel, présentation PowerPoint, document Word, PDF, CSV). "
    + "Tu décris la pièce et ce qu'elle doit contenir dans `title` et `inputs` ; le code la fabrique et la dépose "
    + "dans le Drive. C'est la SEULE forme d'étape qui rend un fichier : une étape WORKER rédige un contenu, "
    + "elle ne produit aucune pièce. Chaque fichier demandé = une étape ARTIFACT."),
  inputs: ENTREES,
});

const ETAPE = {
  description:
    "Une étape. Choisis la forme qui correspond à son nodeType : n'écris que les champs de ce type.",
  anyOf: [
    ETAPE_CAPABILITY, ETAPE_WORKER, ETAPE_WAIT_EVENT, ETAPE_WAIT_INPUT,
    ETAPE_APPROVAL, ETAPE_STRUCTURE, ETAPE_ARTIFACT,
  ],
};

/** Les variantes, exposées pour que le banc puisse vérifier qu'aucun champ n'a été perdu. */
export const VARIANTES_ETAPE: Record<string, Record<string, unknown>> = {
  CAPABILITY: ETAPE_CAPABILITY, WORKER: ETAPE_WORKER, WAIT_EVENT: ETAPE_WAIT_EVENT,
  WAIT_INPUT: ETAPE_WAIT_INPUT, APPROVAL: ETAPE_APPROVAL, STRUCTURE: ETAPE_STRUCTURE,
  ARTIFACT: ETAPE_ARTIFACT,
};

const AXE = objet({
  id: str("Identifiant court de l'axe (« voeux », « classement-drive »)."),
  title: str("Le nom de l'axe, en français."),
  outcome: str("Ce que cet axe doit avoir produit quand il est fini."),
});

const LIVRABLE = objet({
  key: str("Identifiant du livrable."),
  format: enumOf(["XLSX", "DOCX", "PDF", "PPTX", "CSV", "ZIP"], "Le format du fichier."),
  title: str("Le nom du fichier attendu, en français."),
  fromStep: nullableStr("La clé de l'étape qui le produit. null si aucune ne le produit encore."),
});

/**
 * LE SCHÉMA COMPLET.
 *
 * `acceptanceCriteria` et `completionCriteria` ne sont PAS deux façons de dire la même chose :
 * le premier est ce qu'on exigeait AVANT de commencer (il sert au juge), le second est le
 * critère arithmétique de fin (il sert au contrôle qualité). Les fusionner ferait disparaître
 * la distinction qui compte : « toutes les étapes ont tourné » n'est pas « l'objectif est
 * atteint » (§10 de la doctrine).
 */
export const MISSION_PLAN_SCHEMA: Record<string, unknown> = objet({
  goal: str("L'objectif reformulé, tel que tu l'as compris, en une ou deux phrases."),
  reasoningComplexity: enumOf(
    COMPLEXITIES,
    "A = le chemin est évident ; B = il demande de la méthode ; C = il demande un arbitrage. " +
      "N'ESTIME PAS d'après le nombre d'étapes : envoyer le même message à trois cents personnes reste A ou B.",
  ),
  executionScale: enumOf(
    SCALES,
    "La QUANTITÉ de travail : S (quelques actions), M, L, XL, MASSIVE (des centaines). " +
      "Indépendant de la difficulté.",
  ),
  acceptanceCriteria: {
    type: "array",
    items: { type: "string" },
    description:
      "Ce qui devra être VRAI pour que la personne considère l'objectif atteint. Écrits pour être vérifiés, " +
      "avec des nombres quand il y en a. Au moins un. PRÉFÈRE la grammaire de RÈGLES vérifiées par le " +
      "logiciel sur les reçus d'exécution quand elle s'applique — un critère-règle se vérifie sans jugement " +
      "et ne peut pas rester « sans preuve » : " +
      "'[REGLE:RECHERCHES_AVEC_REQUETE:clé1,clé2] texte' (chaque étape citée a exécuté la requête PRÉVUE " +
      "dans son input.query du plan ; le terme entre « » du texte sert de repli si une étape n'a pas de " +
      "requête au plan), '[REGLE:AUCUNE_ECRITURE] texte' (aucun effet au-delà d'ANALYZE), " +
      "'[REGLE:SORTIE_STRUCTUREE:cléEtape:champ1,champ2] texte' (l'étape a rendu ces champs non vides). " +
      "Un critère qui exige un JUGEMENT (fidélité d'une synthèse, pertinence) reste en texte libre — mais " +
      "n'exige JAMAIS ce que les étapes du plan ne peuvent pas prouver.",
  },
  workstreams: { type: "array", items: AXE, description: "Les axes de travail. Un seul suffit pour une mission simple." },
  steps: { type: "array", items: ETAPE, description: "Les étapes. Utiliser l'éventail plutôt que de répéter une étape N fois." },
  expectedArtifacts: { type: "array", items: LIVRABLE, description: "Les fichiers attendus. Liste vide si la mission n'en produit aucun." },
  approvalStrategy: enumOf(
    APPROVAL_STRATEGIES,
    "NONE si aucun effet externe ; BUNDLE pour un accord unique sur un lot cohérent ; " +
      "PER_EFFECT_CLASS pour un accord par famille d'effet ; PER_STEP seulement pour un effet irréversible isolé.",
  ),
  completionCriteria: str("La règle ARITHMÉTIQUE de fin : ce qu'il faut compter et à quoi le comparer."),
  gaps: {
    type: "array",
    items: { type: "string" },
    description: "Ce que tu n'as PAS su faire avec les capacités fournies. Vide si tout est couvert. Ne jamais inventer une capacité pour combler un manque.",
  },
  rationale: str("Pourquoi ce plan, en deux phrases. Pour la relecture humaine."),
});

export const MISSION_PLAN_SCHEMA_NAME = "mission_plan";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE SCHÉMA SOUS PLAFOND — le modèle ne peut pas ÉCRIRE ce que la mission ne peut pas FAIRE.
 *
 * ── LE DÉFAUT MESURÉ ────────────────────────────────────────────────────────────────────
 *
 * Run Render, scénario SATISFIABLE, mission plafonnée à ANALYZE. Le catalogue était filtré —
 * aucune capacité d'écriture visible — mais un nœud ARTIFACT ne porte AUCUNE capacité : le
 * filtre ne le touchait pas, et rien ne disait au planner qu'un plafond existait. À la
 * replanification, il a donc proposé « Produire le point de situation » en ARTIFACT. Le
 * compilateur a refusé (FORBIDDEN_EFFECT, correctement), la mission est morte BLOCKED sans
 * jamais atteindre le juge, et deux appels de planification ont payé un plan impossible.
 *
 * ── LA CORRECTION EST STRUCTURELLE, PAS UNE CONSIGNE ────────────────────────────────────
 *
 * Sous plafond, la variante ARTIFACT est RETIRÉE du `anyOf` : le mode strict du fournisseur
 * refuse alors toute étape de ce type à la GÉNÉRATION. Ce n'est pas une prière dans le prompt
 * qu'un document lu en route pourrait contredire — c'est la même philosophie que le catalogue
 * filtré (§ « la sûreté ne vient pas d'une phrase »), appliquée aux nœuds sans capacité.
 *
 * Le compilateur garde son contrôle FORBIDDEN_EFFECT : il couvre les plans qui n'arrivent pas
 * par ce schéma (un plan scripté, une insertion directe). Deux gardes, une par chemin.
 */
export function schemaPlanPour(effetMax?: Effect | null): Record<string, unknown> {
  if (!effetMax) return MISSION_PLAN_SCHEMA;
  const plafond = EFFECT_RANK[effetMax];
  const variantes = [
    { forme: ETAPE_CAPABILITY, effet: EFFET_NOEUD.CAPABILITY },
    { forme: ETAPE_WORKER, effet: EFFET_NOEUD.WORKER },
    { forme: ETAPE_WAIT_EVENT, effet: EFFET_NOEUD.WAIT_EVENT },
    { forme: ETAPE_WAIT_INPUT, effet: EFFET_NOEUD.WAIT_INPUT },
    { forme: ETAPE_APPROVAL, effet: EFFET_NOEUD.APPROVAL },
    // QA et JOIN partagent la variante STRUCTURE ; leurs effets sont identiques (READ).
    { forme: ETAPE_STRUCTURE, effet: EFFET_NOEUD.QA },
    { forme: ETAPE_ARTIFACT, effet: EFFET_NOEUD.ARTIFACT },
  ].filter((v) => EFFECT_RANK[v.effet] <= plafond);

  // LE SCHÉMA EST RECONSTRUIT, PAS MUTÉ : `MISSION_PLAN_SCHEMA` reste la vérité sans plafond,
  // et deux missions concurrentes sous plafonds différents ne se marchent pas dessus.
  const base = MISSION_PLAN_SCHEMA as { properties?: Record<string, unknown> };
  return {
    ...MISSION_PLAN_SCHEMA,
    properties: {
      ...base.properties,
      steps: {
        type: "array",
        items: { ...(ETAPE as { description: string }), anyOf: variantes.map((v) => v.forme) },
        description: "Les étapes. Utiliser l'éventail plutôt que de répéter une étape N fois.",
      },
    },
  };
}

/** Le poids du schéma en jetons — mesuré, pas estimé au doigt mouillé (§3 `plannerSchemaTokens`). */
export function tailleSchemaJetons(schema: Record<string, unknown> = MISSION_PLAN_SCHEMA): number {
  return Math.ceil(JSON.stringify(schema).length / 3.6);
}
