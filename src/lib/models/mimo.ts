import { recordProviderCall } from "./telemetry";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * MIMO 2.6 PRO (Xiaomi) — l'EXÉCUTANT bon marché des chantiers (lot C1, décision 0041 ; CHANTIERS-DEV.md § 2).
 *
 * API OpenAI-compatible (`POST {base}/chat/completions`), dans la PASSERELLE (`src/lib/models/`) pour qu'aucun appel
 * n'échappe au journal K8 : chaque appel passe par `recordProviderCall`, et l'imputation courante
 * (`sousImputation({ missionId })`) le rattache au chantier qui paie.
 *
 *   clé     `process.env.mimo` (la variable déjà posée sur Render), sinon `MIMO`, sinon `MIMO_API_KEY` — jamais lue
 *           par un modèle, jamais journalisée, jamais renvoyée ;
 *   base    `MIMO_BASE_URL`, défaut `https://token-plan-ams.xiaomimimo.com/v1` (repris de l'ancien code de l'ERP) ;
 *   modèle  `MIMO_MODEL`, défaut `mimo-v2.6-pro` — À CONFIRMER par la sonde `/v1/models` (`sonderMimo`, page
 *           Développement de C2) ;
 *   tarif   non publié au 01/11/2026 : `MIMO_PRICE_IN` / `MIMO_PRICE_OUT` (dollars le million) s'ils sont posés,
 *           sinon le coût est INCONNU (`null`), jamais deviné.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const MIMO_BASE_DEFAUT = "https://token-plan-ams.xiaomimimo.com/v1";
export const MIMO_MODELE_DEFAUT = "mimo-v2.6-pro";

export interface ConfigMimo {
  cle: string | null;
  base: string;
  modele: string;
  prixEntreeParM: number | null;
  prixSortieParM: number | null;
}

const prix = (v: string | undefined): number | null => {
  const n = Number(v?.trim().replace(",", "."));
  return v?.trim() && Number.isFinite(n) && n >= 0 ? n : null;
};

export function configMimo(env: Record<string, string | undefined> = process.env): ConfigMimo {
  const cle = (env.mimo ?? env.MIMO ?? env.MIMO_API_KEY)?.trim() || null;
  return {
    cle,
    base: (env.MIMO_BASE_URL?.trim() || MIMO_BASE_DEFAUT).replace(/\/+$/, ""),
    modele: env.MIMO_MODEL?.trim() || MIMO_MODELE_DEFAUT,
    prixEntreeParM: prix(env.MIMO_PRICE_IN),
    prixSortieParM: prix(env.MIMO_PRICE_OUT),
  };
}

export const mimoDisponible = (env: Record<string, string | undefined> = process.env): boolean => configMimo(env).cle !== null;

export type ReponseMimo =
  | { ok: true; texte: string; usage: { entree: number; sortie: number; coutUsd: number | null; modele: string; ms: number } }
  | { ok: false; erreur: string; configure: boolean; reessayable: boolean };

export interface DepsMimo { fetch?: typeof fetch; env?: Record<string, string | undefined>; delaiMs?: number }

/** Le coût d'un appel au tarif posé — `null` sans tarif (jamais zéro, jamais une estimation inventée). */
export function coutMimo(entree: number, sortie: number, c: Pick<ConfigMimo, "prixEntreeParM" | "prixSortieParM">): number | null {
  if (c.prixEntreeParM === null || c.prixSortieParM === null) return null;
  return Math.round(((entree * c.prixEntreeParM + sortie * c.prixSortieParM) / 1_000_000) * 1e6) / 1e6;
}

/** Une erreur dite SANS la clé : on retire tout ce qui ressemble à un jeton avant de la rendre. */
const expurger = (t: string) => t.replace(/(sk|tp|mimo)[-_][A-Za-z0-9_-]{8,}/gi, "«clé»").replace(/Bearer\s+\S+/gi, "Bearer «clé»").slice(0, 300);

export async function appelerMimo(
  d: { systeme: string; texte: string; maxSortie?: number },
  deps: DepsMimo = {},
): Promise<ReponseMimo> {
  const c = configMimo(deps.env);
  if (!c.cle) return { ok: false, erreur: "MiMo non configuré (variable « mimo » absente)", configure: false, reessayable: false };
  const debut = Date.now();
  const f = deps.fetch ?? fetch;
  let r: Response;
  try {
    r = await f(`${c.base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${c.cle}` },
      body: JSON.stringify({
        model: c.modele,
        messages: [{ role: "system", content: d.systeme }, { role: "user", content: d.texte }],
        max_tokens: d.maxSortie ?? 1_200,
        stream: false,
      }),
      signal: AbortSignal.timeout(deps.delaiMs ?? 90_000),
    });
  } catch (e) {
    return { ok: false, erreur: `MiMo injoignable : ${expurger(e instanceof Error ? e.message : String(e))}`, configure: true, reessayable: true };
  }
  const corps = (await r.json().catch(() => null)) as {
    choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
    error?: { message?: string };
  } | null;
  const ms = Date.now() - debut;
  const entree = corps?.usage?.prompt_tokens ?? 0;
  const sortie = corps?.usage?.completion_tokens ?? 0;
  const coutUsd = coutMimo(entree, sortie, c);
  // TOUJOURS AU JOURNAL, même en échec facturé : le compteur voit tout ce qui a été payé.
  recordProviderCall({
    provider: "mimo", role: "mimo", model: c.modele, inputTokens: entree, outputTokens: sortie,
    cachedInputTokens: corps?.usage?.prompt_tokens_details?.cached_tokens ?? 0, costUsd: coutUsd, ms, attempts: 1,
  });
  if (!r.ok) {
    return { ok: false, erreur: `MiMo HTTP ${r.status}${corps?.error?.message ? ` : ${expurger(corps.error.message)}` : ""}`, configure: true, reessayable: r.status === 429 || r.status >= 500 };
  }
  const texte = corps?.choices?.[0]?.message?.content?.trim() ?? "";
  if (!texte) return { ok: false, erreur: "MiMo a rendu une réponse vide", configure: true, reessayable: true };
  return { ok: true, texte, usage: { entree, sortie, coutUsd, modele: c.modele, ms } };
}

/** LA SONDE `/v1/models` — l'identifiant exact du modèle, à confirmer avant tout branchement (page Développement, C2). */
export async function sonderMimo(deps: DepsMimo = {}): Promise<{ ok: true; modeles: string[]; configure: string; present: boolean } | { ok: false; erreur: string }> {
  const c = configMimo(deps.env);
  if (!c.cle) return { ok: false, erreur: "MiMo non configuré (variable « mimo » absente)" };
  try {
    const r = await (deps.fetch ?? fetch)(`${c.base}/models`, { headers: { Authorization: `Bearer ${c.cle}` }, signal: AbortSignal.timeout(deps.delaiMs ?? 15_000) });
    if (!r.ok) return { ok: false, erreur: `HTTP ${r.status}` };
    const j = (await r.json().catch(() => null)) as { data?: { id?: string }[] } | null;
    const modeles = (j?.data ?? []).map((m) => m.id).filter((x): x is string => typeof x === "string");
    return { ok: true, modeles, configure: c.modele, present: modeles.includes(c.modele) };
  } catch (e) {
    return { ok: false, erreur: expurger(e instanceof Error ? e.message : String(e)) };
  }
}
