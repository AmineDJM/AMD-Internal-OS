import { recordProviderCall } from "./telemetry";
import { emptyUsage, type ModelCallOptions, type ModelReply, type ModelRole, type ModelTurn } from "./contract";
import { attendu } from "@/lib/journal";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * MIMO 2.6 PRO (Xiaomi) — l'EXÉCUTANT bon marché des chantiers (lot C1, décision 0042 ; CHANTIERS-DEV.md § 2).
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

/** Le secours MiMo est-il possible ? Sa clé posée, et `ADAM_SECOURS=0` pas posé. */
export const secoursMimoActif = (env: Record<string, string | undefined> = process.env): boolean =>
  mimoDisponible(env) && (env.ADAM_SECOURS ?? "").trim() !== "0";

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
  const corps = (await r.json().catch(attendu("réponse MiMo non JSON : traitée comme vide", null))) as {
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

/**
 * LE SECOURS DE LA PASSERELLE (Direction, 09/11/2026 : « utilise l'autre IA de la plateforme ») — le crédit OpenAI
 * épuisé, la demande repart chez MiMo, au format de la passerelle : tours de conversation, images (`image_url`, comme
 * OpenAI), et JSON quand un schéma est demandé. MiMo n'impose pas de schéma : la consigne le donne, et la passerelle
 * relit la réponse (`jsonDuTexte`). Les OUTILS ne partent pas : un tour à outils n'a pas de secours (l'appelant le dit).
 */
export function messagesMimo(turns: ModelTurn[], opts: ModelCallOptions): { role: string; content: unknown }[] {
  const consigneJson = opts.jsonSchema
    ? `Réponds UNIQUEMENT par un objet JSON conforme à ce schéma, sans texte autour ni bloc de code :\n${JSON.stringify(opts.jsonSchema.schema)}`
    : "";
  const systeme = [opts.system ?? "", consigneJson].filter(Boolean).join("\n\n");
  const out: { role: string; content: unknown }[] = systeme ? [{ role: "system", content: systeme }] : [];
  for (const t of turns) {
    if (typeof t.content === "string") { out.push({ role: t.role, content: t.content }); continue; }
    const parts = t.content.flatMap((b): unknown[] => {
      if (b.type === "text") return [{ type: "text", text: b.text }];
      if (b.type === "image") return [{ type: "image_url", image_url: { url: `data:${b.mime};base64,${b.data}` } }];
      return [];
    });
    out.push({ role: t.role, content: parts });
  }
  return out;
}

const AVEC_OUTILS = (turns: ModelTurn[], opts: ModelCallOptions) =>
  Boolean(opts.tools?.length) || turns.some((t) => typeof t.content !== "string" && t.content.some((b) => b.type === "tool_call" || b.type === "tool_result"));

export async function appelerMimoTours(
  role: ModelRole, turns: ModelTurn[], opts: ModelCallOptions = {}, deps: DepsMimo = {},
): Promise<ModelReply> {
  const c = configMimo(deps.env);
  const debut = Date.now();
  const echec = (erreur: string, configure = true): ModelReply => ({
    ok: false, configured: configure, stop: "error", blocks: [], error: erreur,
    usage: { ...emptyUsage(role, c.modele, "mimo"), ms: Date.now() - debut },
  });
  if (!c.cle) return echec("MiMo non configuré (variable « mimo » absente)", false);
  if (AVEC_OUTILS(turns, opts)) return echec("Le secours MiMo ne porte pas les outils.");
  let r: Response;
  try {
    r = await (deps.fetch ?? fetch)(`${c.base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${c.cle}` },
      body: JSON.stringify({ model: c.modele, messages: messagesMimo(turns, opts), max_tokens: opts.maxOutputTokens ?? 4_000, stream: false }),
      signal: opts.signal ?? AbortSignal.timeout(deps.delaiMs ?? opts.timeoutMs ?? 120_000),
    });
  } catch (e) {
    return echec(`MiMo injoignable : ${expurger(e instanceof Error ? e.message : String(e))}`);
  }
  const corps = (await r.json().catch(attendu("réponse MiMo non JSON : traitée comme vide", null))) as {
    choices?: { message?: { content?: string }; finish_reason?: string }[]; usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
    error?: { message?: string };
  } | null;
  const ms = Date.now() - debut;
  const entree = corps?.usage?.prompt_tokens ?? 0;
  const sortie = corps?.usage?.completion_tokens ?? 0;
  const cache = corps?.usage?.prompt_tokens_details?.cached_tokens ?? 0;
  const coutUsd = coutMimo(entree, sortie, c);
  if (!r.ok) return echec(`MiMo HTTP ${r.status}${corps?.error?.message ? ` : ${expurger(corps.error.message)}` : ""}`);
  const texte = corps?.choices?.[0]?.message?.content?.trim() ?? "";
  if (!texte) return echec("MiMo a rendu une réponse vide");
  return {
    ok: true, configured: true, stop: corps?.choices?.[0]?.finish_reason === "length" ? "length" : "end",
    blocks: [{ type: "text", text: texte }],
    usage: { role, model: c.modele, provider: "mimo", inputTokens: entree, outputTokens: sortie, cachedInputTokens: cache, costUsd: coutUsd, ms, attempts: 1 },
  };
}

/** LA SONDE `/v1/models` — l'identifiant exact du modèle, à confirmer avant tout branchement (page Développement, C2). */
export async function sonderMimo(deps: DepsMimo = {}): Promise<{ ok: true; modeles: string[]; configure: string; present: boolean } | { ok: false; erreur: string }> {
  const c = configMimo(deps.env);
  if (!c.cle) return { ok: false, erreur: "MiMo non configuré (variable « mimo » absente)" };
  try {
    const r = await (deps.fetch ?? fetch)(`${c.base}/models`, { headers: { Authorization: `Bearer ${c.cle}` }, signal: AbortSignal.timeout(deps.delaiMs ?? 15_000) });
    if (!r.ok) return { ok: false, erreur: `HTTP ${r.status}` };
    const j = (await r.json().catch(attendu("liste des modèles non JSON", null))) as { data?: { id?: string }[] } | null;
    const modeles = (j?.data ?? []).map((m) => m.id).filter((x): x is string => typeof x === "string");
    return { ok: true, modeles, configure: c.modele, present: modeles.includes(c.modele) };
  } catch (e) {
    return { ok: false, erreur: expurger(e instanceof Error ? e.message : String(e)) };
  }
}
