/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE REGISTRE DES CAPACITÉS — ce que chaque modèle accepte, SU AVANT LE RÉSEAU.
 *
 * ── LES DEUX 400 QUI ONT PAYÉ CE FICHIER ─────────────────────────────────────────────────
 *
 *   1. « Function tools with reasoning_effort are not supported for gpt-5.6-terra in
 *        /v1/chat/completions. »
 *   2. « Unsupported parameter: 'temperature' is not supported with this model. »
 *
 * Deux corrections séparées auraient suivi. Elles auraient été suivies d'une troisième, puis
 * d'une quatrième — parce que la méthode était la même à chaque fois : assembler un objet
 * générique, l'envoyer, et laisser OpenAI nous dire ce qu'il refuse. Une architecture qui
 * apprend ses contraintes par les pannes de production n'apprend jamais assez vite.
 *
 * ── LE RENVERSEMENT : LISTE BLANCHE, PAS LISTE NOIRE ─────────────────────────────────────
 *
 * `parameters` n'énumère pas ce qui est interdit : il énumère ce qui est PERMIS. Tout ce qui
 * n'y figure pas explicitement n'est jamais construit, donc jamais envoyé, donc ne peut pas
 * être refusé.
 *
 * C'est ce qui rend l'incertitude SÛRE. La documentation d'OpenAI n'est pas joignable depuis cet
 * environnement (proxy d'egress) ; une liste noire écrite de mémoire aurait donc été un pari sur
 * ce dont on se souvient. Une liste blanche transforme le doute en simple abstention : au pire on
 * n'envoie pas un paramètre facultatif, jamais on n'en envoie un qui casse.
 *
 * ── GÉNÉRIQUE ≠ SUPPORTÉ, ET C'EST TOUT LE PIÈGE ─────────────────────────────────────────
 *
 * Le type Responses du SDK PORTE `temperature`. Ce n'est pas une preuve que Terra l'accepte :
 * l'endpoint est générique, le modèle ne l'est pas. La validation croise donc TROIS choses —
 * le protocole, le MODÈLE, et l'effort de raisonnement demandé — et jamais une seule.
 *
 * ── SOURCES, ET CE QU'ELLES VALENT ───────────────────────────────────────────────────────
 *
 *   • les deux HTTP 400 RÉELS ci-dessus — la preuve la plus forte, observée en production ;
 *   • la documentation officielle, lue par recherche (platform.openai.com et
 *     developers.openai.com sont bloqués en accès direct depuis cet environnement) :
 *     les modèles de raisonnement refusent `temperature`, `top_p`, `presence_penalty`,
 *     `frequency_penalty`, `logprobs`, `top_logprobs`, `logit_bias`, `max_tokens` ;
 *     GPT-5.6 accepte les efforts `none | low | medium | high | xhigh | max` ;
 *     `text.verbosity` (`low | medium | high`) n'existe QUE sur Responses ;
 *     `max_output_tokens` couvre AUSSI les jetons de raisonnement.
 *
 * Quand un 400 réel contredit ce fichier, c'est ce fichier qui a tort : il manque une contrainte,
 * et on l'ajoute ICI — jamais un `delete` de rattrapage dans un adaptateur.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import type { ReasoningEffort } from "./contract";

/** Les portes. Le temps réel a la sienne et ne partage aucun constructeur avec les deux autres. */
export type WireProtocol = "responses" | "chat_completions" | "realtime";

// Les deux vocabulaires viennent du CONTRAT — une seule définition, sinon les listes divergent
// et l'une des deux finit par autoriser ce que l'autre refuse.
export type { ReasoningEffort };

/**
 * TOUS LES PARAMÈTRES QUE NOTRE CONSTRUCTEUR SAIT ÉMETTRE.
 *
 * Cette liste est FERMÉE, et c'est ce qui donne sa force au garde-fou : ajouter un paramètre au
 * produit oblige à l'ajouter ici, donc à décider modèle par modèle s'il est permis. On ne peut
 * plus « glisser » un champ dans un payload sans que le registre en ait connaissance.
 */
export const PARAM_NAMES = [
  // — Les quatre qui ont cassé, ou qui casseraient —
  "temperature", "topP", "logprobs", "topLogprobs",
  // — Le socle Responses —
  "reasoning", "textVerbosity", "textFormat", "maxOutputTokens",
  "tools", "toolChoice", "parallelToolCalls",
  "store", "previousResponseId", "include", "stream",
  "serviceTier", "promptCacheKey", "safetyIdentifier", "metadata",
] as const;

export type ParamName = (typeof PARAM_NAMES)[number];

/**
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * DEUX QUESTIONS DIFFÉRENTES, DEUX TABLES DIFFÉRENTES.
 *
 * On les avait fondues, et c'était une faute de description : le registre annonçait que Terra
 * « ne se parle qu'en Responses », comme s'il s'agissait d'une incapacité du modèle. C'est faux.
 * OpenAI expose Terra sur les DEUX portes. Ce qui n'existe pas, c'est la COMBINAISON
 * « raisonnement + outils » sur Chat Completions — une contrainte croisée, pas une porte fermée.
 *
 * Le reste — « Adam n'emprunte que Responses » — est une DÉCISION QUI NOUS APPARTIENT. La
 * confondre avec une limite du fournisseur rend la décision irrévisable : personne n'ose
 * toucher à ce qu'il croit être une contrainte externe.
 *
 *   PROVIDER_CAPABILITIES — ce que le fournisseur SAIT faire. Constaté (400 réels, doc).
 *   ADAM_POLICY           — ce qu'Adam S'AUTORISE. Décidé, avec un motif écrit, révisable.
 *
 * `capabilityFor()` rend leur INTERSECTION, qui est ce que le constructeur doit respecter.
 * ─────────────────────────────────────────────────────────────────────────────────────────
 */

/** CE QUE LE FOURNISSEUR SAIT FAIRE. Aucune préférence Adam ici — que du constaté. */
export interface ProviderCapability {
  /** Les portes sur lesquelles OpenAI expose ce modèle. */
  protocols: readonly WireProtocol[];
  /** Les efforts acceptés. `null` = ce modèle ne raisonne pas. */
  reasoning: readonly ReasoningEffort[] | null;
  functionCalling: boolean;
  structuredOutputs: boolean;
  parallelToolCalls: boolean;
  /**
   * L'OUTIL `web_search` DE RESPONSES — un outil FOURNISSEUR, pas une fonction à nous.
   *
   * `false` par prudence quand on ne sait pas : offrir la recherche web à un modèle qui ne la
   * porte pas est un 400 assuré, et c'est exactement le genre de contrainte que ce registre
   * existe pour connaître AVANT le réseau.
   */
  webSearchTool: boolean;
  /** LISTE BLANCHE des paramètres. Absent = le modèle le refuse (ou nous ne le savons pas). */
  parameters: Partial<Record<ParamName, boolean>>;
  /**
   * LES COMBINAISONS QUI N'EXISTENT PAS, porte par porte.
   *
   * C'est ICI que vit « raisonnement + outils impossible sur Chat Completions » : ce n'est ni
   * une porte fermée, ni un paramètre refusé, c'est un CROISEMENT. Le distinguer permet de dire
   * la vérité — Terra existe bien sur Chat Completions, mais pas pour cet usage-là.
   */
  reasoningWithToolsOn?: readonly WireProtocol[];
}

/** CE QU'ADAM S'AUTORISE — plus strict que le fournisseur, et pour des raisons à nous. */
export interface AdamPolicy {
  /** Les portes qu'Adam emprunte, parmi celles que le fournisseur offre. */
  allowedProtocols: readonly WireProtocol[];
  /** POURQUOI. Une restriction sans motif écrit devient une superstition en six mois. */
  reason: string;
}

/** La fiche EFFECTIVE : ce que le fournisseur permet ∩ ce qu'Adam s'autorise. */
export interface ModelCapability extends ProviderCapability {
  /** Les portes réellement empruntables. Peut être plus étroit que `protocols`. */
  allowedProtocols: readonly WireProtocol[];
  /** Le motif de la restriction, quand Adam en pose une. */
  policyReason: string | null;
}

/**
 * LE SOCLE COMMUN AUX MODÈLES DE RAISONNEMENT GPT-5.6 — CÔTÉ FOURNISSEUR.
 *
 * `protocols` porte les DEUX portes, parce que c'est la vérité. Les quatre paramètres
 * d'échantillonnage, eux, sont ABSENTS — pas mis à `false` par politesse : absents. Un lecteur
 * qui cherche `temperature` ici ne le trouve pas, et c'est le message.
 */
const FOURNISSEUR_5_6: Omit<ProviderCapability, "reasoning"> = {
  protocols: ["responses", "chat_completions"],
  functionCalling: true,
  structuredOutputs: true,
  parallelToolCalls: true,
  // La recherche web est documentée sur les modèles GPT-5.x via Responses (facturée à la
  // recherche). Elle n'existe QUE sur cette porte — comme raisonnement + outils.
  webSearchTool: true,
  // Raisonner ET outiller n'existe que sur Responses — c'est le HTTP 400 nº 1, mot pour mot.
  reasoningWithToolsOn: ["responses"],
  parameters: {
    reasoning: true,
    textVerbosity: true,
    textFormat: true,
    maxOutputTokens: true,
    tools: true,
    toolChoice: true,
    parallelToolCalls: true,
    store: true,
    previousResponseId: true,
    include: true,
    stream: true,
    serviceTier: true,
    promptCacheKey: true,
    safetyIdentifier: true,
    metadata: true,
  },
};

/** Les six efforts de GPT-5.6. */
const EFFORTS_5_6: readonly ReasoningEffort[] = ["none", "low", "medium", "high", "xhigh", "max"];

/** CE QUE LE FOURNISSEUR OFFRE. */
export const PROVIDER_CAPABILITIES: Readonly<Record<string, ProviderCapability>> = {
  "gpt-5.6-terra": { ...FOURNISSEUR_5_6, reasoning: EFFORTS_5_6 },
  "gpt-5.6-luna": { ...FOURNISSEUR_5_6, reasoning: EFFORTS_5_6 },

  /**
   * LE TEMPS RÉEL N'A RIEN À VOIR — et ce n'est pas une politique, c'est un fait. Sa session se
   * négocie, sa configuration passe par un `session.update` sur le canal, et aucun des champs
   * ci-dessus n'y a de sens. Il n'existe PAS sur les portes textuelles.
   */
  "gpt-realtime-2.1": {
    protocols: ["realtime"],
    reasoning: null,
    functionCalling: true,
    structuredOutputs: false,
    parallelToolCalls: true,
    webSearchTool: false,
    parameters: {},
  },
};

/**
 * CE QU'ADAM S'AUTORISE — et pourquoi.
 *
 * Une seule règle, et elle n'a rien d'une limite technique : maintenir DEUX moteurs OpenAI, ce
 * serait écrire deux fois chaque correctif et n'en vérifier qu'un. Le second diverge toujours,
 * et c'est celui qui casse. Terra pourrait parler Chat Completions ; Adam préfère ne pas.
 */
export const ADAM_POLICY: Readonly<Record<string, AdamPolicy>> = {
  "gpt-5.6-terra": {
    allowedProtocols: ["responses"],
    reason: "Adam n'entretient qu'un moteur OpenAI hors temps réel. Le fournisseur, lui, expose "
      + "aussi Chat Completions — mais pas pour raisonnement + outils.",
  },
  "gpt-5.6-luna": {
    allowedProtocols: ["responses"],
    reason: "Même politique que Terra : une seule porte à maintenir, et les mêmes correctifs.",
  },
};

/** La table effective, exposée pour les tests et l'écran d'administration. */
export const MODEL_CAPABILITIES: Readonly<Record<string, ModelCapability>> = Object.fromEntries(
  Object.entries(PROVIDER_CAPABILITIES).map(([nom, cap]) => [nom, fusionner(nom, cap)]),
);

/** Croise ce que le fournisseur offre avec ce qu'Adam s'autorise. */
function fusionner(nom: string, cap: ProviderCapability): ModelCapability {
  const politique = ADAM_POLICY[nom];
  if (!politique) return { ...cap, allowedProtocols: cap.protocols, policyReason: null };
  // L'intersection, jamais l'union : une politique ne peut qu'ÉTRANGLER, jamais élargir. Sans
  // cela, on « autoriserait » un jour une porte que le fournisseur n'expose pas.
  const permises = politique.allowedProtocols.filter((p) => cap.protocols.includes(p));
  return { ...cap, allowedProtocols: permises, policyReason: politique.reason };
}

/**
 * LES FAMILLES, reconnues par préfixe — du plus précis au plus général.
 *
 * Un suffixe de date (`gpt-5.6-terra-2026-03-01`) ne doit pas faire perdre la fiche. Et la
 * famille large `gpt-5` attrape les versions à venir : le jour où l'on branche `gpt-5.7`, il
 * hérite des contraintes de raisonnement au lieu de tomber dans l'inconnu — où il aurait perdu
 * son `reasoning` EN SILENCE, ce qui est précisément la dégradation qu'on refuse.
 */
const FAMILLES: [string, () => ModelCapability][] = [
  ["gpt-5.6-terra", () => MODEL_CAPABILITIES["gpt-5.6-terra"]],
  ["gpt-5.6-luna", () => MODEL_CAPABILITIES["gpt-5.6-luna"]],
  ["gpt-realtime", () => MODEL_CAPABILITIES["gpt-realtime-2.1"]],
  ["gpt-5", () => MODEL_CAPABILITIES["gpt-5.6-terra"]],
  ["o1", () => MODEL_CAPABILITIES["gpt-5.6-terra"]],
  ["o3", () => MODEL_CAPABILITIES["gpt-5.6-terra"]],
  ["o4", () => MODEL_CAPABILITIES["gpt-5.6-terra"]],
];

/**
 * LE REPLI D'UN MODÈLE INCONNU — délibérément pauvre, et SANS RAISONNEMENT.
 *
 * `reasoning: null` ne dit pas « ce modèle est bête » : il dit « nous ne savons pas s'il
 * raisonne ». La conséquence est voulue — demander un effort à un modèle inconnu fait ÉCHOUER
 * la validation avec un message clair, au lieu d'envoyer un champ au hasard ou de le retirer en
 * douce. Un modèle qu'on branche sans l'avoir décrit doit se signaler, pas se débrouiller.
 *
 * Les familles ci-dessus couvrent les modèles OpenAI plausibles, suffixes de version compris ;
 * ce repli sert surtout à un identifiant d'un autre fournisseur qui arriverait ici par erreur.
 */
const INCONNU: ModelCapability = {
  protocols: ["responses"],
  allowedProtocols: ["responses"],
  policyReason: null,
  reasoning: null,
  functionCalling: true,
  structuredOutputs: false,
  parallelToolCalls: true,
  // Un modèle inconnu ne se voit pas offrir la recherche web « au cas où » : même abstention
  // prudente que pour le raisonnement.
  webSearchTool: false,
  parameters: { maxOutputTokens: true, tools: true, toolChoice: true, store: true, stream: true },
};

/** La fiche d'un modèle : exacte, puis par famille, puis le repli prudent. */
export function capabilityFor(model: string): ModelCapability {
  const m = (model ?? "").trim().toLowerCase();
  const exact = MODEL_CAPABILITIES[m];
  if (exact) return exact;
  for (const [prefixe, fiche] of FAMILLES) if (m.startsWith(prefixe)) return fiche();
  return INCONNU;
}

/** Ce modèle accepte-t-il ce paramètre ? La question se pose AVANT de le construire. */
export function supportsParam(model: string, param: ParamName): boolean {
  return capabilityFor(model).parameters[param] === true;
}

/** Ce modèle raisonne-t-il ? (`reasoning` non nul) */
export function isReasoningModel(model: string): boolean {
  return capabilityFor(model).reasoning !== null;
}

/** Ce modèle porte-t-il l'outil `web_search` du fournisseur ? Se pose AVANT de le poser. */
export function supportsWebSearch(model: string): boolean {
  return capabilityFor(model).webSearchTool === true;
}

// ─────────────────────────── Le contrôle avant réseau ───────────────────────────

/** Ce qu'on s'apprête à demander, décrit dans NOS termes — pas encore dans ceux d'OpenAI. */
export interface ModelRequestShape {
  model: string;
  protocol: WireProtocol;
  reasoning?: ReasoningEffort;
  /** Les paramètres que l'appelant veut réellement voir partir. */
  params: Partial<Record<ParamName, unknown>>;
  toolCount?: number;
  /** L'appelant veut-il offrir l'outil `web_search` du fournisseur ? */
  webSearch?: boolean;
}

export interface RequestProblem {
  /**
   * `capacite`  — le FOURNISSEUR ne sait pas faire. On ne peut pas passer outre.
   * `politique` — ADAM s'interdit. On pourrait, on a décidé que non — le motif est rendu.
   *
   * Les distinguer n'est pas cosmétique : lire « ce modèle ne le fait pas » quand c'est nous qui
   * l'interdisons rend la décision irrévisable, parce que plus personne n'ose la rouvrir.
   */
  kind: "protocole" | "parametre" | "effort" | "capacite" | "politique";
  param?: ParamName;
  message: string;
}

/**
 * LE CONTRÔLE LOCAL — il doit échouer ICI, pas chez OpenAI.
 *
 * Il ne « nettoie » rien : il REFUSE. Nettoyer en silence, c'est reproduire le défaut qu'on
 * vient de retirer (un `delete` discret qui dégrade la demande sans le dire). Le constructeur,
 * lui, ne fabrique jamais un champ interdit — si bien qu'en marche normale cette fonction ne
 * trouve rien. Elle existe pour le jour où quelqu'un contournera le constructeur.
 */
export function validateModelRequest(req: ModelRequestShape): RequestProblem[] {
  const cap = capabilityFor(req.model);
  const problemes: RequestProblem[] = [];

  // 1) LE FOURNISSEUR l'expose-t-il ? C'est un fait, il n'y a rien à négocier.
  if (!cap.protocols.includes(req.protocol)) {
    problemes.push({
      kind: "protocole",
      message: `${req.model} n'existe pas sur ${req.protocol} chez le fournisseur `
        + `(portes réelles : ${cap.protocols.join(", ")}).`,
    });
  } else if (!cap.allowedProtocols.includes(req.protocol)) {
    // 2) ADAM se l'autorise-t-il ? C'est une décision, et elle se dit comme telle.
    problemes.push({
      kind: "politique",
      message: `${req.model} EXISTE sur ${req.protocol}, mais Adam ne l'emprunte pas. `
        + `Motif : ${cap.policyReason ?? "non consigné"}. Portes retenues : ${cap.allowedProtocols.join(", ")}.`,
    });
  }

  // 3) LA COMBINAISON existe-t-elle sur cette porte ? Ni une porte fermée, ni un paramètre
  //    refusé : un croisement. C'est le HTTP 400 nº 1, et il mérite son propre message.
  const raisonne = req.reasoning !== undefined && req.reasoning !== "none";
  if (raisonne && (req.toolCount ?? 0) > 0 && cap.reasoningWithToolsOn
      && !cap.reasoningWithToolsOn.includes(req.protocol)) {
    problemes.push({
      kind: "capacite",
      message: `${req.model} accepte le raisonnement ET les outils, mais pas ensemble sur `
        + `${req.protocol} — uniquement sur ${cap.reasoningWithToolsOn.join(", ")}.`,
    });
  }

  if (req.reasoning !== undefined) {
    if (cap.reasoning === null) {
      problemes.push({ kind: "effort", message: `${req.model} ne prend pas de niveau de raisonnement.` });
    } else if (!cap.reasoning.includes(req.reasoning)) {
      problemes.push({
        kind: "effort",
        message: `reasoning.effort="${req.reasoning}" inconnu de ${req.model} (accepté : ${cap.reasoning.join(", ")}).`,
      });
    }
  }

  for (const [nom, valeur] of Object.entries(req.params) as [ParamName, unknown][]) {
    if (valeur === undefined || valeur === null) continue;
    if (cap.parameters[nom] === true) continue;
    problemes.push({
      kind: "parametre",
      param: nom,
      // Le message NOMME les trois termes de la décision : c'est ce qui rend le diagnostic
      // possible sans relire le code.
      message:
        `${nom} n'est pas supporté par ${req.model}`
        + `${req.reasoning ? ` avec reasoning=${req.reasoning}` : ""}`
        + ` sur ${req.protocol}. Voir src/lib/models/capabilities.ts.`,
    });
  }

  if ((req.toolCount ?? 0) > 0 && !cap.functionCalling) {
    problemes.push({ kind: "capacite", message: `${req.model} n'appelle pas d'outils.` });
  }

  // La recherche web est un outil FOURNISSEUR : un modèle qui ne le porte pas refuserait la
  // requête entière. Même règle que le reste — on échoue ici, jamais chez OpenAI.
  if (req.webSearch && !cap.webSearchTool) {
    problemes.push({
      kind: "capacite",
      message: `${req.model} ne porte pas l'outil web_search (Responses).`,
    });
  }

  return problemes;
}

/**
 * LE JOURNAL DE MISE AU POINT, expurgé.
 *
 * Ce qu'on veut voir d'un appel : le modèle, la porte, l'effort, COMBIEN d'outils — jamais leur
 * contenu —, et surtout le compte des paramètres douteux, qui doit valoir zéro. Aucun contenu
 * de conversation, aucun corps de document, aucune clé : un journal qui recopie ce qu'il
 * transporte finit par publier ce qu'on lui a confié.
 */
export function describeRequest(req: ModelRequestShape): Record<string, unknown> {
  const problemes = validateModelRequest(req);
  const p = req.params;
  return {
    model: req.model,
    endpoint: req.protocol === "responses" ? "/v1/responses" : req.protocol === "chat_completions" ? "/v1/chat/completions" : "realtime",
    reasoningEffort: req.reasoning ?? null,
    toolCount: req.toolCount ?? 0,
    toolChoice: p.toolChoice ?? null,
    parallelToolCalls: p.parallelToolCalls ?? null,
    textVerbosity: p.textVerbosity ?? null,
    maxOutputTokens: p.maxOutputTokens ?? null,
    store: p.store ?? null,
    stream: p.stream ?? null,
    serviceTier: p.serviceTier ?? null,
    unsupportedParameterCandidates: problemes.filter((x) => x.kind === "parametre").length,
  };
}
