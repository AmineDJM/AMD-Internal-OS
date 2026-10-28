import { capabilityFor, isReasoningModel } from "./capabilities";
import type { ModelBinding, ModelCallOptions } from "./contract";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CHOIX DU PROTOCOLE — un seul endroit décide PAR QUELLE PORTE on parle à OpenAI.
 *
 * ── LE DÉFAUT QUE CE FICHIER FERME ───────────────────────────────────────────────────────
 *
 * Adam a répondu en production :
 *
 *   « Function tools with reasoning_effort are not supported for gpt-5.6-terra in
 *     /v1/chat/completions. To use function tools, use /v1/responses or set
 *     reasoning_effort to 'none'. »
 *
 * Terra qui raisonne ET qui outille n'existe PAS sur `/v1/chat/completions`. Ce n'est pas un
 * réglage à corriger : c'est une porte qui ne mène pas là où on va. L'adaptateur, lui, ne
 * connaissait qu'une seule porte — l'URL était écrite en dur à deux endroits — et personne ne
 * pouvait donc se tromper de porte, faute d'en avoir une deuxième.
 *
 * ── POURQUOI LE CHOIX EST ICI, ET PAS DANS L'ADAPTATEUR ──────────────────────────────────
 *
 * Un protocole choisi dans le fichier qui l'implémente ne se choisit pas : il se subit. Tant que
 * `openai.ts` était le seul chemin, « quelle API ? » n'était pas une question — et une question
 * qu'on ne pose pas ne se teste pas. En sortant la décision, elle devient un objet qu'on peut
 * interroger sans réseau, geler par un test, et faire échouer FORT quand elle est absurde.
 *
 * ── LES DEUX SORTIES DE RECOURS, ET POURQUOI L'UNE EST BRIDÉE ────────────────────────────
 *
 * `ADAM_OPENAI_PROTOCOL=chat_completions` rebascule sur l'ancienne porte. Le registre pose déjà
 * la règle — « une migration sans marche arrière n'est pas une migration, c'est un pari » — et
 * elle vaut ici aussi.
 *
 * MAIS cette marche arrière NE PEUT PAS servir la combinaison qui a cassé la production. Un
 * levier de secours qui permet de re-choisir la panne n'est pas un levier de secours. Quand la
 * demande est « raisonnement + outils », `protocolFor` rend `responses` quoi qu'en dise
 * l'environnement, et le dit dans les journaux plutôt que de céder en silence.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/**
 * LES PORTES — définies une seule fois, dans le registre des capacités.
 *
 * Elles y sont trois (`realtime` comprise) parce qu'une fiche de modèle doit pouvoir déclarer
 * « je ne me parle QUE en temps réel » : c'est ce qui empêche structurellement le temps réel de
 * traverser le constructeur Responses. La passerelle textuelle, elle, n'en emprunte que deux.
 */

/** Les deux portes qu'un appel TEXTUEL peut emprunter. */
export type TextProtocol = "responses" | "chat_completions";

/**
 * QUELS modèles raisonnent est une connaissance de MODÈLE : elle vit dans le REGISTRE DES
 * CAPACITÉS, qui est désormais la source unique. Ce fichier décide seulement ce qu'il FAUT EN
 * FAIRE. Réexporté ici parce que c'est le vocabulaire du protocole.
 */
export { isReasoningModel } from "./capabilities";

/**
 * LA COMBINAISON INTERDITE, nommée une fois pour toutes.
 *
 * Raisonner (`effort` autre que `none`) ET décrire des outils dans le même appel. C'est
 * exactement ce que la production a essayé de faire, et exactement ce que
 * `/v1/chat/completions` refuse.
 */
export function needsResponses(binding: ModelBinding, opts: ModelCallOptions): boolean {
  const effort = opts.reasoning ?? binding.reasoning;
  const model = opts.modelOverride || binding.model;
  return isReasoningModel(model) && effort !== "none" && Boolean(opts.tools?.length);
}

/**
 * LA PORTE PAR DÉFAUT D'UN MODÈLE, telle que sa fiche la déclare.
 *
 * C'est le registre qui sait — pas ce fichier. Terra et Luna ne déclarent que `responses` ; le
 * temps réel ne déclare que `realtime`, ce qui l'empêche STRUCTURELLEMENT de traverser le
 * constructeur Responses.
 */
export function defaultProtocolOf(model: string) {
  // Les portes RETENUES, pas celles que le fournisseur expose : c'est la politique d'Adam qui
  // choisit, et elle est plus étroite. `capabilities.ts` tient les deux listes séparément.
  const cap = capabilityFor(model);
  return cap.allowedProtocols[0] ?? cap.protocols[0] ?? "responses";
}

/** Le protocole demandé par l'environnement, quand il en demande un. */
function protocoleDemande(): TextProtocol | null {
  const raw = (process.env.ADAM_OPENAI_PROTOCOL ?? "").trim().toLowerCase();
  if (raw === "chat_completions") return "chat_completions";
  if (raw === "responses") return "responses";
  return null;
}

/**
 * PAR QUELLE PORTE CET APPEL PART.
 *
 * `responses` par défaut, pour TOUS les rôles textuels OpenAI — pas seulement pour ceux qui en
 * ont besoin. Maintenir deux moteurs OpenAI, c'est écrire deux fois chaque correctif et n'en
 * vérifier qu'un ; le second finit toujours par diverger, et c'est celui qui casse.
 */
export function protocolFor(binding: ModelBinding, opts: ModelCallOptions = {}): TextProtocol {
  const demande = protocoleDemande();

  // LA MARCHE ARRIÈRE NE REJOUE PAS LA PANNE. Voir l'en-tête : on refuse, et on le DIT.
  if (demande === "chat_completions" && needsResponses(binding, opts)) {
    console.error(
      `[models] ADAM_OPENAI_PROTOCOL=chat_completions ignoré pour ${binding.role}/${binding.model} : `
      + "raisonnement + outils n'existe pas sur /v1/chat/completions (c'est le HTTP 400 de production). "
      + "Appel maintenu sur /v1/responses.",
    );
    return "responses";
  }

  return demande ?? "responses";
}

/**
 * L'INVARIANT, sous forme vérifiable.
 *
 * Rend le motif de la violation, ou `null` quand tout va bien. Un test le passe sur toutes les
 * combinaisons de rôle, d'effort et d'outillage : c'est ce qui empêche de réintroduire le défaut
 * par une troisième porte qu'on n'a pas encore écrite.
 *
 * Il rend une CHAÎNE plutôt que de lever : la passerelle veut pouvoir refuser un appel en
 * rendant un `ModelReply` propre, et une exception qui traverse une boucle d'agent perd l'usage
 * déjà consommé — donc le coût déjà payé.
 */
export function protocolViolation(
  binding: ModelBinding,
  opts: ModelCallOptions,
  protocol: TextProtocol,
): string | null {
  if (protocol === "chat_completions" && needsResponses(binding, opts)) {
    const effort = opts.reasoning ?? binding.reasoning;
    return (
      `${binding.model} avec reasoning=${effort} et ${opts.tools?.length ?? 0} outil(s) ne peut pas `
      + "passer par /v1/chat/completions. Voir src/lib/models/protocol.ts."
    );
  }
  return null;
}
