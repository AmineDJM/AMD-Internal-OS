/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'ADAPTATEUR RESPONSES — la porte par laquelle Terra et Luna parlent désormais.
 *
 * ── CE QUI CHANGE VRAIMENT PAR RAPPORT À CHAT COMPLETIONS ────────────────────────────────
 *
 * Changer l'URL n'aurait rien réglé : les deux API ne décrivent pas la même chose.
 *
 *   `messages`             → `input`, une SUITE D'ÉLÉMENTS et non une suite de messages. Un appel
 *                            d'outil et son résultat sont des éléments à part entière, plus des
 *                            messages déguisés (`role: "tool"`) portant un identifiant en douce.
 *   `system`               → `instructions`, au sommet de la requête.
 *   `tools[].function.*`   → `tools[].*` — la fonction n'est plus emboîtée d'un cran.
 *   `reasoning_effort: x`  → `reasoning: { effort: x }`.
 *   `max_completion_tokens`→ `max_output_tokens`.
 *   `choices[0].message`   → `output[]`, un TABLEAU d'éléments hétérogènes : du raisonnement, un
 *                            message, et zéro à N appels d'outils, chacun avec son `call_id`.
 *   `finish_reason`        → `status` + `incomplete_details.reason`.
 *
 * Le dernier point est celui qui compte pour la boucle d'agent : `output` porte NATURELLEMENT
 * plusieurs appels d'outils. Ils remontent tels quels, et la boucle les exécute déjà de front
 * (`Promise.all` dans `assistant.ts`) — la parallélisation ne demandait pas de code neuf, elle
 * demandait de ne pas perdre les appels en route.
 *
 * ── LE CHAÎNAGE `previous_response_id`, ET POURQUOI IL EST FERMÉ PAR DÉFAUT ──────────────
 *
 * Responses sait reprendre une réponse précédente par son identifiant — à condition qu'OpenAI
 * l'ait CONSERVÉE (`store: true`). C'est un vrai gain de jetons, et c'est aussi de la donnée
 * d'entreprise qui reste chez un tiers.
 *
 * Le défaut est donc `store: false` : on n'entrepose rien sans qu'on l'ait demandé. Le chaînage
 * s'active appel par appel (`previousResponseId`), et n'active la conservation que pour les
 * appels concernés. L'inverse — tout conserver au cas où — aurait marché aussi, et aurait fait
 * sortir l'historique complet de l'ERP sans que personne ait eu à le décider.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Découpé par responsabilité — voir le dossier `openai-responses/` : `format.ts` (traduction
 * tours ↔ éléments Responses), `usage.ts` (consommation et journal du budget), `appel.ts` (l'appel
 * non streamé et la mémoire des coupures réseau), `flux.ts` (l'accumulateur et l'appel en flux).
 */

export { toResponsesInput, PLANCHER_SORTIE_RESPONSES, buildResponsesBody, budgetEpuise, safetyIdentifierFor, fromResponsesOutput, lireRecherchesWeb, stopOfResponse } from "./openai-responses/format";
export { oublierCoupures, callOpenAiResponses } from "./openai-responses/appel";
export { ResponsesStreamAssembler, streamOpenAiResponses } from "./openai-responses/flux";
