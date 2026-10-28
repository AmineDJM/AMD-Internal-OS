/**
 * LE MODÈLE DE L'ASSISTANT — MiMo, et lui seul (décision 0006, révision de C4).
 *
 * Pas de modèle de secours : si MiMo échoue ou dépasse le délai, l'assistant le dit plutôt que de
 * répondre avec un autre fournisseur. La clé n'est lue qu'ici, jamais écrite dans le code.
 */
export const MIMO = {
  providerId: "mimo",
  modelId: process.env.MIMO_MODEL?.trim() || "mimo-v2.6-flash",
  url: process.env.MIMO_BASE_URL?.trim() || "https://token-plan-ams.xiaomimimo.com/v1",
} as const;

/** Délai d'un tour complet (mesuré : ~5 s par appel MiMo, 2 à 3 appels par tour avec outils). */
export const DELAI_MIMO_MS = Number(process.env.MIMO_TIMEOUT_MS) || 45_000;

export interface ModeleConfig {
  providerId: string;
  modelId: string;
  url: string;
  apiKey: string;
}

/**
 * LA CLÉ SOUS SON SEUL NOM (IA-ASSISTANT-13). Elle était lue aussi sous `mimo` (minuscules) : une
 * variable qui échappe aux inventaires (`.env.example`, ~200 variables en majuscules) et à
 * `cleModeleRequise()`. Encore posée, elle est IGNORÉE — et on le dit une fois, au lieu de se taire.
 */
let ancienNomDit = false;

export function modeleMimo(env: NodeJS.ProcessEnv = process.env): ModeleConfig | null {
  if (env.mimo && !ancienNomDit) {
    ancienNomDit = true;
    console.warn("[assistant-ia] la variable « mimo » (minuscules) est ignorée : posez la clé sous MIMO_API_KEY.");
  }
  const apiKey = (env.MIMO_API_KEY ?? "").trim();
  return apiKey ? { ...MIMO, apiKey } : null;
}

/** Les modèles à essayer, dans l'ordre. Vide = IA non configurée. */
export function modelesAssistant(): ModeleConfig[] {
  const m = modeleMimo();
  return m ? [m] : [];
}
