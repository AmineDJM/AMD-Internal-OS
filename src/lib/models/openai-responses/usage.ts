/**
 * Adaptateur Responses — LA CONSOMMATION : lecture de l'`usage` du fournisseur (jetons, cache,
 * raisonnement, recherches web) et journal du budget de sortie.
 */
import { webSearchPricePerCall } from "../registry";
import { type ModelBinding, type ModelReply, costOf } from "../contract";
import { budgetEpuise, type RespPayload, type RespUsage } from "./format";

/**
 * L'USAGE D'UN APPEL — avec, désormais, DE QUOI JUGER LE BUDGET.
 *
 * Quatre nombres voyagent ensemble et n'ont de sens qu'ensemble : le plafond qu'on a fixé, ce qui
 * en a été consommé, la part partie en réflexion, et la raison d'un arrêt prématuré. Isolés, ils
 * ne répondent à rien ; réunis, ils répondent à la seule question qui compte ici — « la réserve de
 * raisonnement est-elle bien calibrée ? » — sans qu'on ait à la deviner.
 */
export function usageDe(
  binding: ModelBinding,
  u: RespUsage | undefined,
  started: number,
  attempts: number,
  contexte: { maxOutputTokens?: number | null; incompleteReason?: string | null; webSearchCalls?: number } = {},
): ModelReply["usage"] {
  const inputTokens = u?.input_tokens ?? 0;
  const outputTokens = u?.output_tokens ?? 0;
  const enCache = u?.input_tokens_details?.cached_tokens ?? 0;
  const recherches = contexte.webSearchCalls ?? 0;

  // LE COÛT COMPLET : jetons (part en cache au tarif réduit quand il est renseigné) + recherches.
  // La règle « un tarif manquant rend le total inconnu » tient : si le tarif des jetons manque,
  // ajouter les recherches fabriquerait un total partiel avec l'air d'un total — on rend `null`.
  const coutJetons = costOf(binding, inputTokens, outputTokens, enCache);
  const costUsd = coutJetons == null
    ? null
    : Math.round((coutJetons + recherches * webSearchPricePerCall()) * 1_000_000) / 1_000_000;

  return {
    role: binding.role,
    model: binding.model,
    provider: "openai",
    inputTokens,
    outputTokens,
    cachedInputTokens: u?.input_tokens_details?.cached_tokens ?? 0,
    reasoningTokens: u?.output_tokens_details?.reasoning_tokens ?? 0,
    ...(recherches > 0 ? { webSearchCalls: recherches } : {}),
    maxOutputTokens: contexte.maxOutputTokens ?? null,
    incompleteReason: contexte.incompleteReason ?? null,
    costUsd,
    ms: Date.now() - started,
    attempts,
  };
}

/**
 * LA LIGNE DE JOURNAL DU BUDGET. Expurgée par construction : elle ne porte QUE des nombres — pas
 * un mot de la question, pas un mot de la réponse. C'est ce qui permet de la laisser allumée en
 * production sans faire fuir le contenu d'un dossier réglementaire dans les journaux.
 */
export function journaliserBudget(
  binding: ModelBinding,
  plafond: number | null,
  u: RespUsage | undefined,
  payload: Pick<RespPayload, "status" | "incomplete_details">,
): void {
  const sortie = u?.output_tokens ?? 0;
  const raisonnement = u?.output_tokens_details?.reasoning_tokens ?? 0;
  const ligne = {
    role: binding.role,
    model: binding.model,
    max_output_tokens: plafond,
    output_tokens: sortie,
    reasoning_tokens: raisonnement,
    // La part effectivement lisible — le reste a servi à penser.
    visible_tokens: Math.max(0, sortie - raisonnement),
    status: payload.status ?? null,
    incomplete_details: payload.incomplete_details?.reason ?? null,
  };

  if (budgetEpuise(payload)) {
    // PAS un `info`. Un plafond atteint est une erreur de NOTRE réglage, payée au prix fort ; la
    // noyer dans le journal courant reviendrait à ne jamais la corriger.
    console.warn(`[models] BUDGET DE SORTIE ÉPUISÉ — ${JSON.stringify(ligne)}`);
    return;
  }
  if (process.env.ADAM_MODEL_DEBUG === "1") console.info("[models] budget", JSON.stringify(ligne));
}
