import { callLuna, lunaConfigured, lunaModel, type LunaResult } from "@/lib/openai-luna";
import { aiFeatureEnabled, interrupteurIaCoupe, logAiUsage } from "@/lib/ai-settings";
import { ecartPct, montantCourt, resumeDiff, LIBELLE_SOURCE, type DiffVersions, type SourceLigne } from "@/lib/budget-campagne/regles";
import { sansBloquer } from "@/lib/journal";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LUNA ET LA CAMPAGNE BUDGÉTAIRE — la part qui PARLE AU FOURNISSEUR (en haut de `src/lib`, comme `kpi-luna.ts` : un
 * domaine ne parle pas aux fournisseurs). Deux services, jamais un montant :
 *   • un BROUILLON DE JUSTIFICATION d'un écart, à partir des seules données de la ligne — le pôle le relit et le garde
 *     ou non ;
 *   • le RÉSUMÉ DES CHANGEMENTS entre deux versions — le repli exact (`resumeDiff`) est TOUJOURS la base : Luna ne peut
 *     que le reformuler, et une réponse qui perd un montant est rejetée.
 * Portes : interrupteur général → bascule (« budget_campagne », suit l'assistant) → clé → appel borné (15 s) → JSON
 * strict → journal (`logAiUsage`). Tout échec retombe sur le repli déterministe.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const FONCTION = "budget_campagne" as const;
const DELAI_MS = 15_000;

async function porteOuverte(): Promise<boolean> {
  try {
    if (await interrupteurIaCoupe()) return false;
    if (!(await aiFeatureEnabled(FONCTION))) return false;
    return lunaConfigured();
  } catch {
    return false;
  }
}

const SCHEMA = {
  name: "budget_campagne_texte",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["texte"],
    properties: { texte: { type: "string" } },
  },
} as const;

async function appeler(system: string, user: string, userId: string | null): Promise<string | null> {
  const t0 = Date.now();
  let r: LunaResult<unknown> | null = null;
  let panne = false;
  try {
    r = await Promise.race([
      callLuna<unknown>({ system, user, jsonSchema: SCHEMA as unknown as { name: string; schema: Record<string, unknown> }, maxOutputTokens: 400, model: lunaModel() }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), DELAI_MS)),
    ]);
  } catch {
    panne = true;
  }
  let data: unknown = r?.data;
  if (r?.ok && data === undefined) { try { data = JSON.parse(r.text); } catch { data = null; } }
  const texte = r?.ok && data && typeof data === "object" && typeof (data as { texte?: unknown }).texte === "string"
    ? (data as { texte: string }).texte.trim().slice(0, 600) : null;
  await logAiUsage({
    feature: FONCTION, provider: "openai", model: lunaModel(), userId, ok: Boolean(texte),
    latencyMs: Date.now() - t0,
    errorCode: panne ? "exception" : r === null ? "timeout" : !r.ok ? (r.error ?? "error").slice(0, 120) : texte ? null : "invalid_json",
    llmCalls: 1, inputTokens: r?.usage.inputTokens ?? null, outputTokens: r?.usage.outputTokens ?? null,
    cachedInputTokens: r?.usage.cachedInputTokens ?? null, costUsd: r?.usage.costUsd ?? null,
  }).catch(sansBloquer("budget-campagne-luna.appeler.logAiUsage"));
  return texte || null;
}

export interface EntreeJustification {
  pole: string; label: string; source: SourceLigne; realise: number; propose: number; contexte?: string | null;
}

/** Le repli : une phrase exacte, construite des seules données. */
export function justificationDeRepli(e: EntreeJustification): string {
  const ecart = ecartPct(e.realise, e.propose);
  const sens = ecart === null ? "Ligne nouvelle" : ecart >= 0 ? `Hausse de ${ecart} %` : `Baisse de ${Math.abs(ecart)} %`;
  const base = e.realise > 0 ? ` par rapport au réalisé projeté (${montantCourt(e.realise)} → ${montantCourt(e.propose)} DZD)` : ` (${montantCourt(e.propose)} DZD)`;
  return `${sens}${base} — source : ${LIBELLE_SOURCE[e.source]}.${e.contexte ? ` ${e.contexte}` : ""}`;
}

/** Un brouillon de justification — Luna si elle répond, le repli sinon. Ne lève jamais. */
export async function brouillonJustification(e: EntreeJustification, userId: string | null): Promise<{ texte: string; parLuna: boolean }> {
  const repli = justificationDeRepli(e);
  if (!(await porteOuverte())) return { texte: repli, parLuna: false };
  const system = "Tu aides le responsable d'un pôle à justifier une ligne de son budget annuel (entreprise pharmaceutique, Algérie, DZD). "
    + "Rédige UNE ou DEUX phrases sobres, en français, à partir UNIQUEMENT des faits donnés. N'invente aucun chiffre, aucun fait. "
    + "Réponds en JSON {\"texte\": \"...\"}.";
  const user = `Pôle : ${e.pole}\nLigne : ${e.label}\nSource du montant : ${LIBELLE_SOURCE[e.source]}\nRéalisé de l'année en cours (projeté) : ${e.realise} DZD\nProposé : ${e.propose} DZD\nFaits connus : ${repli}`;
  const t = await appeler(system, user, userId);
  return t ? { texte: t, parLuna: true } : { texte: repli, parLuna: false };
}

/** Le résumé des changements entre deux versions — le repli exact, reformulé par Luna seulement si elle garde chaque montant. */
export async function resumerVersions(vAvant: number, vApres: number, diff: DiffVersions, userId: string | null): Promise<{ texte: string; parLuna: boolean }> {
  const exact = resumeDiff(vAvant, vApres, diff);
  const rien = diff.modifiees.length + diff.ajoutees.length + diff.retirees.length === 0;
  if (rien || !(await porteOuverte())) return { texte: exact, parLuna: false };
  const system = "Tu résumes en une phrase courte, en français, ce qui a changé entre deux versions d'un budget. "
    + "Garde EXACTEMENT chaque montant tel qu'écrit. Réponds en JSON {\"texte\": \"...\"}.";
  const t = await appeler(system, exact, userId);
  // UNE REFORMULATION QUI PERD UN MONTANT EST REJETÉE : le résumé exact reste la vérité.
  const plat = (s: string) => s.replace(/[\s  ]/g, "");
  const montants = (exact.match(/\d[\d\s  ]*(?:,\d+)?/g) ?? []).map(plat).filter((m) => m.length > 1);
  if (t && montants.every((m) => plat(t).includes(m))) return { texte: t, parLuna: true };
  return { texte: exact, parLuna: false };
}
