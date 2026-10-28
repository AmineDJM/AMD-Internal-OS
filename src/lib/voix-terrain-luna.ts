import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { callLuna, lunaConfigured, lunaModel, type LunaResult } from "@/lib/openai-luna";
import { aiFeatureEnabled, interrupteurIaCoupe, logAiUsage } from "@/lib/ai-settings";
import { wrapUntrusted } from "@/lib/comms/untrusted";
import { CONSIGNE_VOIX, SCHEMA_VOIX, lireReponseVoix, regrouperParMotsCles, type RapportTerrain, type VoixTerrain } from "@/lib/voix-terrain/pur";
import { sansBloquer } from "@/lib/journal";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA VOIX DU TERRAIN — la part qui PARLE AU FOURNISSEUR. Elle vit en haut de `src/lib`, hors de tout domaine (comme
 * `kpi-luna.ts`) : un domaine ne parle pas aux fournisseurs (`platform/domains.test.ts`). Consigne, schéma, relecture
 * et repli sont purs, dans `voix-terrain/pur.ts`.
 *
 * L'ordre des portes : cache du jour → interrupteur général → bascule (« rapports terrain ») → clé → appel borné
 * (20 s) → relecture stricte (citations vérifiées MOT POUR MOT) → journal (`logAiUsage`, fonction « voix_terrain »).
 * Chaque échec retombe sur le repli DÉTERMINISTE par mots-clés. Le résultat est gardé UNE JOURNÉE par périmètre
 * (`VoixTerrainCache`) : un cockpit rouvert ne rappelle pas le modèle.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const FONCTION = "voix_terrain" as const;
const DELAI_MS = 20_000;
const MAX_RAPPORTS_LUNA = 120;

async function porteOuverte(): Promise<boolean> {
  try {
    if (await interrupteurIaCoupe()) return false;
    if (!(await aiFeatureEnabled(FONCTION))) return false;
    return lunaConfigured();
  } catch {
    return false;
  }
}

async function lireCache(cle: string): Promise<VoixTerrain | null> {
  try {
    const c = await prisma.voixTerrainCache.findUnique({ where: { cle }, select: { contenu: true } });
    const v = c?.contenu as unknown as VoixTerrain | undefined;
    return v && Array.isArray(v.groupes) ? v : null;
  } catch {
    return null;
  }
}

async function ecrireCache(cle: string, jour: string, v: VoixTerrain): Promise<void> {
  try {
    const contenu = v as unknown as Prisma.InputJsonValue;
    await prisma.voixTerrainCache.upsert({ where: { cle }, update: { contenu, parLuna: v.parLuna, jour }, create: { cle, jour, contenu, parLuna: v.parLuna } });
    // Le ménage : les jours passés ne servent plus.
    await prisma.voixTerrainCache.deleteMany({ where: { jour: { lt: jour } } });
  } catch {
    // Un cache est un confort : son échec ne casse pas l'écran.
  }
}

async function classerParLuna(rapports: readonly RapportTerrain[], jours: number, maintenant: Date, userId: string | null): Promise<VoixTerrain | null> {
  const lot = rapports.slice(0, MAX_RAPPORTS_LUNA);
  const user = lot.map((r) => `[${r.id}]\n${wrapUntrusted(r.texte, { source: r.id, kind: "compte rendu de visite", maxChars: 900 })}`).join("\n\n");
  const t0 = Date.now();
  let r: LunaResult<unknown> | null = null;
  let panne = false;
  try {
    r = await Promise.race([
      callLuna<unknown>({ system: CONSIGNE_VOIX, user: `COMPTES RENDUS (${lot.length}) :\n\n${user}`, jsonSchema: SCHEMA_VOIX as unknown as { name: string; schema: Record<string, unknown> }, maxOutputTokens: 2500, model: lunaModel() }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), DELAI_MS)),
    ]);
  } catch {
    panne = true;
  }
  let data: unknown = r?.data;
  if (r?.ok && data === undefined) { try { data = JSON.parse(r.text); } catch { data = null; } }
  const lu = r?.ok ? lireReponseVoix(data, lot, jours, maintenant) : null;
  await logAiUsage({
    feature: FONCTION, provider: "openai", model: lunaModel(), userId, ok: Boolean(lu),
    latencyMs: Date.now() - t0,
    errorCode: panne ? "exception" : r === null ? "timeout" : !r.ok ? (r.error ?? "error").slice(0, 120) : lu ? null : "invalid_json",
    llmCalls: 1, inputTokens: r?.usage.inputTokens ?? null, outputTokens: r?.usage.outputTokens ?? null,
    cachedInputTokens: r?.usage.cachedInputTokens ?? null, costUsd: r?.usage.costUsd ?? null,
  }).catch(sansBloquer("voix-terrain-luna.classerParLuna.logAiUsage"));
  if (!lu) return null;
  // Les rapports au-delà du lot envoyé ne sont pas perdus : le comptage total reste celui de la fenêtre.
  return { ...lu, rapports: rapports.length };
}

/**
 * LA VOIX DU TERRAIN d'un périmètre (`perimetre` : « mkt:bu:… », « ops:all »…) sur `jours` jours. Ne lève jamais.
 * Aucun rapport : un résultat vide (l'écran dit « aucun rapport »), jamais un appel au modèle.
 */
export async function voixDuTerrain(input: {
  perimetre: string;
  jours: number;
  rapports: readonly RapportTerrain[];
  userId: string | null;
  maintenant?: Date;
}): Promise<VoixTerrain> {
  const maintenant = input.maintenant ?? new Date();
  const jour = maintenant.toISOString().slice(0, 10);
  const cle = `${input.perimetre}|${input.jours}j|${jour}`;
  const vide: VoixTerrain = { jours: input.jours, rapports: 0, groupes: [], objectionsPrixAo: 0, parLuna: false, calculeLe: maintenant.toISOString() };
  if (input.rapports.length === 0) return vide;
  const cache = await lireCache(cle);
  if (cache) return cache;
  const parLuna = (await porteOuverte()) ? await classerParLuna(input.rapports, input.jours, maintenant, input.userId) : null;
  const v = parLuna ?? regrouperParMotsCles(input.rapports, input.jours, maintenant);
  await ecrireCache(cle, jour, v);
  return v;
}
