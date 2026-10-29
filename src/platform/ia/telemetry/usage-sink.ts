/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE PUITS D'USAGE — chaque appel de modèle devient une ligne, sans ralentir personne.
 *
 * ── POURQUOI UN PUITS, ET PAS UNE ÉCRITURE DANS LA PASSERELLE ──────────────────────────
 *
 * `src/lib/models/` ne connaît ni Prisma ni le produit (un test le gèle) : c'est ce qui la rend
 * portable. Elle REMET chaque usage à un puits ; ce module EST le puits, branché au chargement
 * d'`assistant.ts`, du raisonneur des missions et des modules du socle IA qui appellent un modèle
 * (`web-research.ts`, `media/assistant-files.ts` — l'Assistant IA les charge sans charger Adam,
 * lot J0). Un appel qui partirait d'ailleurs serait quand même compté : le puits est global au
 * processus, il ne dépend pas d'un tour.
 *
 * ── POURQUOI UN TAMPON ───────────────────────────────────────────────────────────────────
 *
 * Une écriture SQL par appel de modèle ajouterait un aller-retour base au chemin critique de
 * chaque tour. Les lignes s'accumulent et partent en UN `createMany` toutes les 1,5 s ou dès
 * 40 lignes ; un échec d'écriture se dit une fois par minute et ne remonte jamais vers l'appel.
 * En test (VITEST), le tampon écrit aussi : c'est ce qui permet de prouver le branchement.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
import { prisma } from "@/lib/prisma";
import { setModelCallSink, type TurnTrace } from "@/lib/models/telemetry";
import type { ModelUsage } from "@/lib/models/contract";
import { ROLE_VOIX } from "@/lib/models/registry";

type Ligne = {
  turnId: string | null; route: string | null; feature: string | null;
  userId: string | null; threadId: string | null; missionId: string | null;
  role: string; provider: string; model: string;
  inputTokens: number; outputTokens: number; cachedInputTokens: number; reasoningTokens: number; webSearchCalls: number;
  costUsd: number | null; ms: number; attempts: number; incompleteReason: string | null;
};

const DELAI_MS = 1_500;
const LOT_MAX = 40;

let tampon: Ligne[] = [];
let minuteur: NodeJS.Timeout | null = null;
let dernierEchecDit = 0;
let installe = false;
/** Ce que le puits a effectivement écrit — un compteur de PREUVE pour les tests et le doctor. */
export const compteurs = { recues: 0, ecrites: 0, echecs: 0 };

function ligneDe(u: ModelUsage, t: TurnTrace | undefined): Ligne {
  return {
    turnId: t?.turnId ?? null,
    route: t?.route ?? null,
    feature: t?.context.feature ?? null,
    userId: t?.context.userId ?? null,
    threadId: t?.context.threadId ?? null,
    missionId: t?.context.missionId ?? null,
    role: u.role,
    provider: u.provider,
    model: u.model,
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    cachedInputTokens: u.cachedInputTokens ?? 0,
    reasoningTokens: u.reasoningTokens ?? 0,
    webSearchCalls: u.webSearchCalls ?? 0,
    costUsd: u.costUsd ?? null,
    ms: u.ms ?? 0,
    attempts: u.attempts ?? 1,
    incompleteReason: u.incompleteReason ?? null,
  };
}

/** Écrit ce qui attend. Rendue publique pour les tests et l'arrêt propre — jamais lève. */
export async function viderTampon(): Promise<number> {
  if (minuteur) { clearTimeout(minuteur); minuteur = null; }
  if (tampon.length === 0) return 0;
  const lot = tampon;
  tampon = [];
  try {
    const r = await prisma.modelCallLog.createMany({ data: lot });
    compteurs.ecrites += r.count;
    return r.count;
  } catch (err) {
    compteurs.echecs += lot.length;
    const maintenant = Date.now();
    if (maintenant - dernierEchecDit > 60_000) {
      dernierEchecDit = maintenant;
      console.warn(`[usage] ${lot.length} appel(s) de modèle non journalisés (base indisponible ?) : ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`);
    }
    return 0;
  }
}

function recevoir(u: ModelUsage, t: TurnTrace | undefined): void {
  // Un appel qui n'a rien consommé (refus local, erreur avant réseau) ne vaut pas une ligne.
  if (u.inputTokens === 0 && u.outputTokens === 0 && (u.attempts ?? 0) === 0) return;
  compteurs.recues += 1;
  tampon.push(ligneDe(u, t));
  if (tampon.length >= LOT_MAX) { void viderTampon(); return; }
  if (!minuteur) {
    minuteur = setTimeout(() => { minuteur = null; void viderTampon(); }, DELAI_MS);
    minuteur.unref?.();
  }
}

/**
 * UNE SESSION VOCALE = UNE LIGNE. La voix ne passe pas par `callModel` (WebRTC direct), donc le
 * puits ne la voit pas passer : le point de fin de session la lui REMET, avec les totaux que le
 * client a comptés sur les `response.done` du fournisseur. Même tampon, même table : le coût
 * par modèle et par personne compte la voix comme le texte.
 */
export function journaliserSessionVocale(e: {
  userId: string; model: string; inputTokens: number; outputTokens: number; cachedInputTokens: number;
  costUsd: number | null; ms: number; responses: number;
}): void {
  if (e.responses <= 0) return;
  compteurs.recues += 1;
  tampon.push({
    turnId: null, route: "voice-direct", feature: "voice_realtime",
    userId: e.userId, threadId: null, missionId: null,
    role: ROLE_VOIX, provider: "openai", model: e.model,
    inputTokens: e.inputTokens, outputTokens: e.outputTokens, cachedInputTokens: e.cachedInputTokens,
    reasoningTokens: 0, webSearchCalls: 0,
    costUsd: e.costUsd, ms: e.ms, attempts: e.responses, incompleteReason: null,
  });
  if (tampon.length >= LOT_MAX) { void viderTampon(); return; }
  if (!minuteur) {
    minuteur = setTimeout(() => { minuteur = null; void viderTampon(); }, DELAI_MS);
    minuteur.unref?.();
  }
}

/** Branche le puits — idempotent, appelé par effet d'import. */
export function installerPuitsUsage(): void {
  if (installe) return;
  installe = true;
  setModelCallSink(recevoir);
  process.once("beforeExit", () => { void viderTampon(); });
}

installerPuitsUsage();
