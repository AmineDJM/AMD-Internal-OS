import { facturer, GRILLE_RELEVEE_LE, tarifDuModele, type UsageAppel } from "@/lib/models/tarifs";
import type { ModelUsage } from "@/lib/models/contract";

/**
 * LE COÛT D'UNE LIGNE DU JOURNAL — calculé UNE fois, au même endroit, pour tous les écrivains de
 * `ModelCallLog` (le puits de la passerelle, le budget de l'Assistant IA, les visuels) — lot K8,
 * décision 0035.
 *
 *   1. Un tarif POSÉ dans l'environnement par l'exploitation (`ADAM_PRICE_<RÔLE>_IN`,
 *      `ASSISTANT_IA_PRICE_IN`…) prime : l'appelant a calculé le coût avec, il est gardé (`priceGrid` = « env »).
 *   2. Sinon, la GRILLE datée (`src/lib/models/tarifs.ts`) calcule le coût poste par poste, en entiers
 *      (`priceGrid` = la date de la grille).
 *   3. Un modèle hors grille sans tarif posé : `null` — « tarif inconnu », jamais 0 $.
 */

export interface ColonnesK8 {
  audioInputTokens: number;
  cachedAudioInputTokens: number;
  audioOutputTokens: number;
  imageInputTokens: number;
  cachedImageInputTokens: number;
  imageOutputTokens: number;
  durationMs: number;
  pages: number;
  estimated: boolean;
  batch: boolean;
}

type UsageLigne = Pick<ModelUsage, "model" | "inputTokens" | "outputTokens" | "cachedInputTokens" | "costUsd"> &
  Partial<Pick<ModelUsage, "role" | "reasoningTokens" | "webSearchCalls" | "audioInputTokens" | "cachedAudioInputTokens" | "audioOutputTokens"
    | "imageInputTokens" | "cachedImageInputTokens" | "imageOutputTokens" | "durationMs" | "pages" | "estimated" | "batch">> & {
    /** Les jetons sont des équivalents de durée (10/s) : seule la durée se facture. */
    equivalents?: boolean;
  };

const n = (v: number | undefined | null) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0);

/** Un tarif de la passerelle est-il posé pour ce rôle (`ADAM_PRICE_ORCHESTRATOR_IN`…) ? */
export function tarifPasserellePose(role: string | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!role) return false;
  const r = role.toUpperCase();
  // C1 (décision 0041) : MiMo n'est pas sur la grille (tarif non publié) — son tarif se pose par `MIMO_PRICE_IN` / `_OUT`.
  if (r === "MIMO") return !!(env.MIMO_PRICE_IN?.trim() && env.MIMO_PRICE_OUT?.trim());
  return !!(env[`ADAM_PRICE_${r}_IN`]?.trim() || env[`ADAM_PRICE_${r}_OUT`]?.trim());
}

export function usageAppelDe(u: UsageLigne): UsageAppel {
  return {
    entree: n(u.inputTokens), entreeCache: n(u.cachedInputTokens), sortie: n(u.outputTokens), raisonnement: n(u.reasoningTokens),
    audioEntree: n(u.audioInputTokens), audioEntreeCache: n(u.cachedAudioInputTokens), audioSortie: n(u.audioOutputTokens),
    imageEntree: n(u.imageInputTokens), imageEntreeCache: n(u.cachedImageInputTokens), imageSortie: n(u.imageOutputTokens),
    dureeMs: n(u.durationMs), pages: n(u.pages), recherchesWeb: n(u.webSearchCalls), equivalents: !!u.equivalents, lot: !!u.batch,
  };
}

export function coutJournal(u: UsageLigne, opts: { tarifPose?: boolean } = {}): { costUsd: string | null; priceGrid: string | null; colonnes: ColonnesK8 } {
  const colonnes: ColonnesK8 = {
    audioInputTokens: n(u.audioInputTokens), cachedAudioInputTokens: n(u.cachedAudioInputTokens), audioOutputTokens: n(u.audioOutputTokens),
    imageInputTokens: n(u.imageInputTokens), cachedImageInputTokens: n(u.cachedImageInputTokens), imageOutputTokens: n(u.imageOutputTokens),
    durationMs: n(u.durationMs), pages: n(u.pages), estimated: !!u.estimated || !!u.equivalents, batch: !!u.batch,
  };
  const pose = opts.tarifPose ?? tarifPasserellePose(u.role);
  if (pose && u.costUsd != null) return { costUsd: u.costUsd.toFixed(6), priceGrid: "env", colonnes };
  const tarif = tarifDuModele(u.model);
  if (!tarif) return { costUsd: u.costUsd != null && pose ? u.costUsd.toFixed(6) : null, priceGrid: null, colonnes };
  return { costUsd: facturer(usageAppelDe(u), tarif).usd, priceGrid: tarif.verifieLe, colonnes };
}

export { GRILLE_RELEVEE_LE };
