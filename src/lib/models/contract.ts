/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CONTRAT DE MODÈLE — ce qu'Adam demande à une IA, sans savoir laquelle.
 *
 * ── POURQUOI CE FICHIER EXISTE ───────────────────────────────────────────────────────────
 *
 * Jusqu'ici, `src/lib/ai.ts` n'était pas une abstraction : c'était l'API Anthropic, avec ses
 * noms (`ClaudeToolDef`, `ClaudeMessage`, `tool_use`, `input_schema`, `x-api-key`). Ces noms
 * ont fui dans 23 fichiers. Changer de fournisseur revenait donc à réécrire 23 fichiers — ce
 * qui, en pratique, veut dire ne jamais changer de fournisseur.
 *
 * Ce fichier est la forme NEUTRE. Elle n'est pas un compromis mou entre deux API : elle dit ce
 * dont une boucle d'agent a réellement besoin — des tours, des outils, des appels d'outils, des
 * résultats d'outils, une raison d'arrêt. Tout le reste (en-têtes, noms de champs, le fait que
 * l'un renvoie un objet déjà analysé et l'autre une chaîne JSON) est un détail d'adaptateur.
 *
 * ── LA RÈGLE QUI REND CE FICHIER UTILE ───────────────────────────────────────────────────
 *
 * **Zéro import.** Comme `src/platform/contract.ts`, et pour la même raison : un contrat qui
 * importe quelque chose finit par dépendre de ce quelque chose. Un test gèle cette propriété.
 *
 * ── LES RÔLES, ET POURQUOI PAS DES NOMS DE MODÈLES ───────────────────────────────────────
 *
 * Le code appelant ne demande JAMAIS « gpt-5.6-terra ». Il demande un RÔLE : « j'orchestre »,
 * « je fais une sous-tâche qui demande de comprendre », « j'abats du volume ». Le nom du modèle
 * derrière un rôle est une décision d'exploitation, pas d'architecture — elle se change dans une
 * variable d'environnement, pas dans un `if` au milieu d'une boucle d'agent.
 *
 * C'est aussi ce qui rend mesurable la règle « A/B ne doivent surtout pas appeler l'orchestrateur
 * inutilement » : on compte les appels PAR RÔLE.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

// ─────────────────────────────── Les rôles ───────────────────────────────

/**
 * LES QUATRE RÔLES. Ils ne décrivent pas une puissance, ils décrivent un TRAVAIL — c'est ce qui
 * permet de rebrancher un rôle sur un autre modèle sans rien relire d'autre.
 *
 *   • `realtime`     — écoute, comprend, converse. Il tient le contexte de l'appel et décide.
 *   • `orchestrator` — travaille : investigue, planifie, découpe, synthétise. Coûteux, donc
 *                      appelé seulement quand le plan doit être DÉCOUVERT.
 *   • `worker`       — une sous-tâche qui demande de comprendre ou d'interpréter.
 *   • `bulk`         — une sous-tâche massive et mécanique : extraire, classer, normaliser.
 *
 * Il n'y a délibérément PAS de rôle « pas cher pour discuter » : un modèle qui converse mal
 * coûte un tour de plus, ce qui annule l'économie.
 */
export type ModelRole = "realtime" | "orchestrator" | "worker" | "bulk";

export const MODEL_ROLES: readonly ModelRole[] = ["realtime", "orchestrator", "worker", "bulk"] as const;

/**
 * L'EFFORT DE RAISONNEMENT demandé. `none` n'est pas « bête » : c'est « ne réfléchis pas avant de
 * répondre », ce qui est exactement ce qu'on veut d'un worker qui extrait trente dates.
 *
 * SIX VALEURS, et non quatre. GPT-5.6 accepte `xhigh` et `max` en plus des quatre historiques ;
 * les omettre revenait à interdire dans notre code ce que le fournisseur autorise. Quels efforts
 * un MODÈLE donné accepte réellement est une autre question, et elle se pose dans
 * `capabilities.ts` : ce type dit ce qui est exprimable, la fiche dit ce qui est acceptable.
 */
export type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * LA LONGUEUR ET LE STYLE de la réponse — le remplaçant LÉGITIME de `temperature`.
 *
 * On a longtemps réglé « fais court » avec une température basse. C'était un détournement : la
 * température règle le hasard, pas la concision. GPT-5.6 offre le réglage direct, et il n'a
 * aucun des inconvénients de l'autre — il ne touche ni à la justesse ni au raisonnement.
 */
export type Verbosity = "low" | "medium" | "high";

/** Le fournisseur qui sert un rôle. Le second existe pour pouvoir REVENIR, pas pour hésiter. */
export type ModelProvider = "openai" | "anthropic";

/**
 * CE QUI EST BRANCHÉ DERRIÈRE UN RÔLE. Un enregistrement, pas du code : c'est ce qui permet de
 * changer de modèle sans redéployer une logique.
 */
export interface ModelBinding {
  role: ModelRole;
  provider: ModelProvider;
  /** L'identifiant exact envoyé au fournisseur. */
  model: string;
  reasoning: ReasoningEffort;
  /**
   * Tarifs en dollars par MILLION de jetons. `null` quand le tarif n'est pas connu de façon
   * fiable — et dans ce cas le coût rapporté vaut `null`, JAMAIS zéro et jamais une estimation
   * inventée. Un coût faux est pire qu'un coût absent : on prend des décisions dessus.
   */
  priceInPerM: number | null;
  priceOutPerM: number | null;
  /**
   * LE TARIF DES JETONS D'ENTRÉE SERVIS DEPUIS LE CACHE de prompt, par million.
   *
   * Optionnel et sans défaut inventé : quand il n'est pas renseigné (`ADAM_PRICE_<ROLE>_CACHED_IN`),
   * les jetons en cache sont facturés au tarif d'entrée PLEIN — une SURESTIMATION assumée, qui
   * vaut mieux qu'une remise devinée. Le jour où le tarif réduit est vérifié, une variable
   * d'environnement suffit et le coût rapporté baisse tout seul.
   */
  priceCachedInPerM?: number | null;
}

// ─────────────────────────────── La conversation ───────────────────────────────

/**
 * UN OUTIL, tel qu'Adam le décrit. `parameters` est un JSON Schema — le seul vocabulaire que les
 * deux fournisseurs partagent réellement.
 */
export interface ModelToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * UN BLOC DE CONTENU. Trois formes, et il n'en faut pas une quatrième :
 *
 *   • `text`        — ce que le modèle dit ;
 *   • `tool_call`   — ce qu'il veut qu'on fasse. `args` est TOUJOURS un objet déjà analysé :
 *                     l'un des deux fournisseurs rend une chaîne JSON, c'est à l'adaptateur de
 *                     l'analyser, pas à la boucle d'agent de s'en souvenir ;
 *   • `tool_result` — ce qu'on a trouvé. `isError` distingue « l'outil a échoué » de « l'outil a
 *                     répondu que non » — deux choses qu'un texte libre confond.
 */
export type ModelBlock =
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; args: Record<string, unknown> }
  | { type: "tool_result"; callId: string; content: string; isError?: boolean }
  /**
   * UNE IMAGE À FAIRE LIRE (§38) — une page rastérisée, une capture, une photo — en base64, avec
   * son type MIME. Portée par un tour UTILISATEUR seulement ; chaque fournisseur la traduit dans
   * sa forme (`image_url`, `input_image`, `source: base64`). Le palier supérieur de la lecture
   * visuelle passe par ici : mêmes portes (rôle, protocole, place, télémétrie) que le texte.
   */
  | { type: "image"; mime: string; data: string; detail?: "low" | "high" };

/** Un tour de conversation. `system` est passé à part : les deux API le traitent à part. */
export interface ModelTurn {
  role: "user" | "assistant";
  content: string | ModelBlock[];
}

/**
 * POURQUOI LE MODÈLE S'EST ARRÊTÉ. Normalisé, parce que `stop_reason: "tool_use"` et
 * `finish_reason: "tool_calls"` disent la même chose et qu'aucune boucle d'agent ne devrait
 * connaître les deux orthographes.
 */
export type ModelStop = "end" | "tools" | "length" | "refusal" | "error";

/**
 * CE QUE COÛTE UN APPEL, et ce qu'il a pris de temps. Mesuré à chaque appel, ventilé par rôle :
 * c'est la seule façon de répondre à « est-ce qu'A/B appelle l'orchestrateur sans raison ? »
 * autrement qu'à l'intuition.
 */
export interface ModelUsage {
  role: ModelRole;
  model: string;
  provider: ModelProvider;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  /** `null` si le tarif du modèle n'est pas connu — voir `ModelBinding`. */
  costUsd: number | null;
  ms: number;
  /** Nombre de tentatives réseau réellement consommées (1 = du premier coup). */
  attempts: number;
  /**
   * COMBIEN DES JETONS DE SORTIE ONT SERVI À RÉFLÉCHIR, et non à répondre.
   *
   * Le chiffre le plus important de tout ce contrat, et celui qui manquait. `outputTokens` seul ne
   * dit pas si un appel a rendu 300 mots ou a passé son budget entier à penser pour ne rien dire :
   * ces deux appels ont la même facture et le même compteur. Sans cette ventilation, la question
   * « le budget de raisonnement est-il bien calibré ? » ne se répond qu'à l'intuition — et c'est
   * ainsi que la boucle d'agent a tourné avec 1 400 jetons totaux sur un modèle qui raisonne.
   *
   * OPTIONNEL PARCE QUE TOUS LES PROTOCOLES NE LE RENDENT PAS. Absent = « ce protocole ne le
   * rapporte pas », ce qui est un fait, pas une mesure ratée. À zéro = le modèle n'a pas réfléchi.
   */
  reasoningTokens?: number;
  /**
   * COMBIEN DE RECHERCHES WEB le fournisseur a exécutées pendant cet appel.
   *
   * Facturées À LA RECHERCHE, pas au jeton — un compteur de jetons seul rendrait ce coût
   * invisible. Optionnel pour la même raison que `reasoningTokens` : absent = « ce protocole ne
   * le rapporte pas », zéro = « l'outil était offert et le modèle n'a pas cherché ».
   */
  webSearchCalls?: number;
  /** Le plafond de sortie réellement envoyé — sans lui, `reasoningTokens` ne se juge pas. */
  maxOutputTokens?: number | null;
  /**
   * POURQUOI LA RÉPONSE S'EST ARRÊTÉE AVANT LA FIN (`incomplete_details.reason`), quand c'est le
   * cas. `"max_output_tokens"` ici veut dire « nous avons payé un appel coupé par NOTRE plafond » :
   * c'est notre erreur de réglage, pas une limite du modèle, et il faut pouvoir la compter.
   */
  incompleteReason?: string | null;
}

export interface ModelReply {
  ok: boolean;
  /** false = pas de clé pour ce fournisseur. À distinguer d'une panne : ça se règle en config. */
  configured: boolean;
  stop: ModelStop;
  blocks: ModelBlock[];
  usage: ModelUsage;
  error?: string;
  /**
   * L'IDENTIFIANT DE LA RÉPONSE, quand le protocole en rend un (Responses).
   *
   * Il n'est utile qu'à une chose : le rendre en `previousResponseId` au tour suivant pour
   * reprendre sans réexpédier tout l'historique. Absent partout ailleurs — et son absence n'est
   * pas une panne, c'est un protocole qui ne chaîne pas.
   */
  responseId?: string;
  /**
   * LES SOURCES WEB CITÉES, quand l'appel a cherché (`webSearch: true`).
   *
   * Une réponse fondée sur le web SANS ses sources est une rumeur avec de l'aplomb : l'appelant
   * doit pouvoir montrer d'où vient chaque affirmation, et distinguer une preuve INTERNE (l'ERP)
   * d'une preuve EXTERNE (une page web, à la fraîcheur incertaine). `title` vaut `null` quand le
   * fournisseur n'en donne pas — jamais un titre inventé.
   */
  webSources?: { url: string; title: string | null }[];
}

export interface ModelCallOptions {
  system?: string;
  tools?: ModelToolDef[];
  /**
   * LE BUDGET DE LA RÉPONSE VISIBLE — pas le plafond envoyé au fournisseur.
   *
   * La distinction n'est pas un détail de vocabulaire. `max_output_tokens` couvre la réflexion
   * INTERNE en plus de la réponse : un appelant qui demande 1 400 « pour une réponse de 1 400 »
   * obtient, sur un modèle qui raisonne, une réponse VIDE. Tous les budgets du produit ayant été
   * écrits quand le nombre voulait dire « longueur de la réponse », c'est ce sens-là qui est
   * conservé ici — et la passerelle ajoute la réserve de raisonnement (voir `budget.ts`).
   *
   * Autrement dit : demandez ce que vous voulez LIRE. Combien le modèle doit penser pour y arriver
   * n'est pas votre affaire, et dépend de l'effort, pas de la question.
   */
  maxOutputTokens?: number;
  temperature?: number;
  /** Surcharge ponctuelle de l'effort du rôle. À n'utiliser que si le rôle ne suffit pas. */
  reasoning?: ReasoningEffort;
  /**
   * La concision demandée. Surcharge celle du rôle — une lecture opérationnelle veut `low`,
   * une synthèse analytique peut mériter `medium`.
   */
  verbosity?: Verbosity;
  /**
   * COMMENT LE MODÈLE CHOISIT D'APPELER UN OUTIL. `auto` par défaut, et c'est presque toujours
   * le bon : forcer un outil précis fait passer à côté des tours où il ne faut en appeler aucun.
   */
  toolChoice?: "auto" | "none" | "required";
  /**
   * IDENTIFIANT DE SÛRETÉ, transmis au fournisseur pour la détection d'abus.
   *
   * DOIT ÊTRE UN CONDENSAT, jamais une adresse e-mail ni rien d'identifiant en clair : ce champ
   * sort de l'entreprise à chaque appel, et sa raison d'être ne justifie pas d'exporter l'état
   * civil de qui que ce soit. `safetyIdentifierFor` s'en charge.
   */
  safetyIdentifier?: string;
  /** Clé de cache de prompt — regroupe les appels qui partagent le même contexte stable. */
  promptCacheKey?: string;
  /** Éléments supplémentaires demandés dans la réponse (ex. le raisonnement chiffré). */
  include?: string[];
  timeoutMs?: number;
  /**
   * OFFRIR LA RECHERCHE WEB au modèle pour cet appel (outil `web_search` de Responses).
   *
   * Un booléen et non une configuration : l'appelant dit « cette question peut nécessiter le
   * web », le fournisseur décide s'il cherche et combien de fois. Les recherches exécutées
   * remontent dans `usage.webSearchCalls` (facturées à l'unité) et les pages citées dans
   * `reply.webSources` — une réponse web sans sources ne doit pas exister.
   */
  webSearch?: boolean;
  /** Forcer une sortie JSON conforme à un schéma. */
  jsonSchema?: { name: string; schema: Record<string, unknown> };
  /** Coupe l'appel proprement quand l'appelant abandonne (client parti, tour vocal annulé). */
  signal?: AbortSignal;
  /**
   * ÉCHAPPATOIRE : forcer un modèle précis pour CET appel, sans toucher au rôle.
   *
   * Réservée aux essais d'administration et aux appels historiques qui portaient déjà un modèle.
   * Ce n'est PAS la façon normale de choisir un modèle — un appelant qui nomme un modèle
   * réintroduit exactement le couplage que les rôles suppriment.
   */
  modelOverride?: string;
  /**
   * REPRENDRE LA RÉPONSE PRÉCÉDENTE plutôt que de renvoyer tout l'historique (Responses).
   *
   * Économise des jetons sur une conversation longue — et demande que le fournisseur ait
   * CONSERVÉ le tour précédent. C'est pourquoi c'est un choix de l'appelant et pas un défaut :
   * voir `openai-responses.ts`, qui n'entrepose rien tant que personne ne l'a demandé.
   */
  previousResponseId?: string;
}

/** Le texte concaténé des blocs `text` — ce dont l'appelant a besoin neuf fois sur dix. */
export function textOf(blocks: ModelBlock[]): string {
  return blocks
    .filter((b): b is Extract<ModelBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

/** Les appels d'outils demandés — la condition de poursuite d'une boucle d'agent. */
export function toolCallsOf(blocks: ModelBlock[]): Extract<ModelBlock, { type: "tool_call" }>[] {
  return blocks.filter((b): b is Extract<ModelBlock, { type: "tool_call" }> => b.type === "tool_call");
}

/**
 * LE COÛT D'UN APPEL. Rend `null` dès qu'un des deux tarifs manque — voir `ModelBinding` : on
 * préfère ne rien annoncer plutôt qu'annoncer faux.
 *
 * Les jetons EN CACHE sont déduits du tarif plein SEULEMENT si leur tarif réduit est renseigné ;
 * sinon ils restent au tarif d'entrée — surestimer un coût connu vaut mieux qu'inventer une
 * remise. `cachedInputTokens` est une PART de `inputTokens`, jamais un supplément.
 */
export function costOf(
  binding: Pick<ModelBinding, "priceInPerM" | "priceOutPerM" | "priceCachedInPerM">,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens = 0,
): number | null {
  if (binding.priceInPerM == null || binding.priceOutPerM == null) return null;
  const enCache = binding.priceCachedInPerM != null
    ? Math.max(0, Math.min(cachedInputTokens, inputTokens))
    : 0;
  const usd =
    ((inputTokens - enCache) / 1_000_000) * binding.priceInPerM
    + (enCache / 1_000_000) * (binding.priceCachedInPerM ?? 0)
    + (outputTokens / 1_000_000) * binding.priceOutPerM;
  return Math.round(usd * 1_000_000) / 1_000_000; // au millionième de dollar
}

/** Usage vide — pour les retours d'erreur, qui doivent quand même porter un usage lisible. */
export function emptyUsage(role: ModelRole, model: string, provider: ModelProvider): ModelUsage {
  return {
    role,
    model,
    provider,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    costUsd: null,
    ms: 0,
    attempts: 0,
  };
}

/** La clé du fournisseur n'est pas posée : l'appel n'est pas parti (`configured: false`). */
export function reponseSansCle(binding: ModelBinding, provider: ModelProvider, cle: string): ModelReply {
  return {
    ok: false,
    configured: false,
    stop: "error",
    blocks: [],
    usage: emptyUsage(binding.role, binding.model, provider),
    error: `Clé ${cle} non configurée.`,
  };
}

/** L'appel est parti et n'a rien rendu : aucun bloc, l'usage à zéro sauf la durée, et la raison. */
export function reponseEnEchec(binding: ModelBinding, provider: ModelProvider, started: number, error: string): ModelReply {
  return {
    ok: false,
    configured: true,
    stop: "error",
    blocks: [],
    usage: { ...emptyUsage(binding.role, binding.model, provider), ms: Date.now() - started },
    error,
  };
}
