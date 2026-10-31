import { urlOpenAI } from "@/lib/models/openai-acces";

/**
 * LA FACTURE D'OPENAI — l'API « Costs » (`/v1/organization/costs`), lue avec une clé ADMINISTRATEUR de l'organisation
 * (`OPENAI_ADMIN_KEY`). Lot K8, décision 0035. Rend la somme EXACTE (au micro-dollar, chaîne) de la période, ou dit
 * pourquoi elle n'a pas pu être lue. Sans clé : `non_configure` — rien n'est inventé.
 */
export const CLE_ADMIN_OPENAI = "OPENAI_ADMIN_KEY";

type Seau = { results?: { amount?: { value?: number | string; currency?: string } }[] };
export type PageCouts = { data?: Seau[]; has_more?: boolean; next_page?: string | null };

/** Les montants en dollars d'une suite de pages, chacun au micro-dollar (« 0.123457 »). */
export function montantsFactures(pages: PageCouts[]): string[] {
  const out: string[] = [];
  for (const p of pages) for (const s of p.data ?? []) for (const r of s.results ?? []) {
    const v = Number(r.amount?.value ?? 0);
    if (Number.isFinite(v) && v > 0 && (r.amount?.currency ?? "usd").toLowerCase() === "usd") out.push(v.toFixed(6));
  }
  return out;
}

export async function lireFactureOpenAI(
  debut: Date, fin: Date, opts: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch } = {},
): Promise<{ etat: "non_configure" } | { etat: "erreur"; raison: string } | { etat: "ok"; montants: string[] }> {
  const env = opts.env ?? process.env;
  const cle = (env[CLE_ADMIN_OPENAI] ?? "").trim();
  if (!cle) return { etat: "non_configure" };
  const f = opts.fetchImpl ?? fetch;
  const pages: PageCouts[] = [];
  try {
    let suite: string | null = null;
    for (let i = 0; i < 12; i++) {
      const q = new URLSearchParams({
        start_time: String(Math.floor(debut.getTime() / 1000)), end_time: String(Math.floor(fin.getTime() / 1000)), bucket_width: "1d", limit: "180",
      });
      if (suite) q.set("page", suite);
      const r = await f(`${urlOpenAI("/organization/costs", env)}?${q}`, { headers: { authorization: `Bearer ${cle}` }, signal: AbortSignal.timeout(20_000) });
      if (!r.ok) {
        return { etat: "erreur", raison: `l'API Costs d'OpenAI a répondu ${r.status}${r.status === 401 || r.status === 403 ? " (la clé posée n'est pas une clé administrateur valide)" : ""}` };
      }
      const p = (await r.json()) as PageCouts;
      pages.push(p);
      if (!p.has_more || !p.next_page) break;
      suite = p.next_page;
    }
  } catch (e) {
    return { etat: "erreur", raison: e instanceof Error ? e.message.slice(0, 160) : String(e) };
  }
  return { etat: "ok", montants: montantsFactures(pages) };
}
