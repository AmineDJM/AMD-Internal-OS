import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { callLuna, lunaModel, type LunaResult, portesLunaOuvertes } from "@/lib/openai-luna";
import { logAiUsage } from "@/lib/ai-settings";
import {
  CONSIGNE_ESSENTIEL, SCHEMA_ESSENTIEL, faitsPourLuna, lireReponseEssentiel, essentielDeterministe, empreinteFaits,
  type Fait360, type Essentiel360,
} from "@/lib/products/essentiel-360";
import { sansBloquer } from "@/lib/journal";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * « LUNA — L'ESSENTIEL CE MOIS » d'un produit (Produits 360) — la part qui PARLE AU FOURNISSEUR. En haut de `src/lib`,
 * hors de tout domaine (comme `voix-terrain-luna.ts`) : un domaine ne parle pas aux fournisseurs (`platform/domains.test.ts`).
 *
 * L'ordre des portes : cache du jour → interrupteur général → bascule (« produit_360 », celle de l'assistant) → clé →
 * appel borné (15 s) → relecture stricte (faits cités, aucun nombre étranger aux faits) → journal (`logAiUsage`).
 * Chaque échec retombe sur le repli DÉTERMINISTE (les trois faits les plus urgents).
 *
 * LE CACHE D'UN JOUR réutilise la table `VoixTerrainCache` (clé préfixée « produit360| », ménage par jour identique) :
 * la clé porte l'empreinte des faits — une personne qui voit d'autres modules a d'autres faits, donc une autre entrée,
 * et Luna ne lit jamais qu'un fait que la personne voit déjà.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const FONCTION = "produit_360" as const;
const DELAI_MS = 15_000;

async function lireCache(cle: string): Promise<Essentiel360 | null> {
  try {
    const c = await prisma.voixTerrainCache.findUnique({ where: { cle }, select: { contenu: true } });
    const v = c?.contenu as unknown as Essentiel360 | undefined;
    return v && Array.isArray(v.points) ? v : null;
  } catch {
    return null;
  }
}

async function ecrireCache(cle: string, jour: string, v: Essentiel360): Promise<void> {
  try {
    const contenu = v as unknown as Prisma.InputJsonValue;
    await prisma.voixTerrainCache.upsert({ where: { cle }, update: { contenu, parLuna: v.parLuna, jour }, create: { cle, jour, contenu, parLuna: v.parLuna } });
  } catch {
    // Un cache est un confort : son échec ne casse pas la fiche.
  }
}

async function demanderALuna(faits: readonly Fait360[], userId: string | null): Promise<Essentiel360["points"] | null> {
  const t0 = Date.now();
  let r: LunaResult<unknown> | null = null;
  let panne = false;
  try {
    r = await Promise.race([
      callLuna<unknown>({
        system: CONSIGNE_ESSENTIEL, user: `FAITS (${faits.length}) :\n${faitsPourLuna(faits)}`,
        jsonSchema: SCHEMA_ESSENTIEL as unknown as { name: string; schema: Record<string, unknown> }, maxOutputTokens: 600, model: lunaModel(),
      }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), DELAI_MS)),
    ]);
  } catch {
    panne = true;
  }
  let data: unknown = r?.data;
  if (r?.ok && data === undefined) { try { data = JSON.parse(r.text); } catch { data = null; } }
  const lu = r?.ok ? lireReponseEssentiel(data, faits) : null;
  await logAiUsage({
    feature: FONCTION, provider: "openai", model: lunaModel(), userId, ok: Boolean(lu),
    latencyMs: Date.now() - t0,
    errorCode: panne ? "exception" : r === null ? "timeout" : !r.ok ? (r.error ?? "error").slice(0, 120) : lu ? null : "invalid_json",
    llmCalls: 1, inputTokens: r?.usage.inputTokens ?? null, outputTokens: r?.usage.outputTokens ?? null,
    cachedInputTokens: r?.usage.cachedInputTokens ?? null, costUsd: r?.usage.costUsd ?? null,
  }).catch(sansBloquer("produit-360-luna.demanderALuna.logAiUsage"));
  return lu;
}

/** L'ESSENTIEL d'un produit à partir de ses faits calculés. Ne lève jamais ; aucun fait : aucun point, aucun appel. */
export async function essentielDuProduit(input: { productId: string; faits: readonly Fait360[]; userId: string | null; maintenant?: Date }): Promise<Essentiel360> {
  const maintenant = input.maintenant ?? new Date();
  if (input.faits.length === 0) return { points: [], parLuna: false, calculeLe: maintenant.toISOString() };
  const jour = maintenant.toISOString().slice(0, 10);
  const cle = `produit360|${input.productId}|${empreinteFaits(input.faits)}|${jour}`;
  const cache = await lireCache(cle);
  if (cache) return cache;
  const parLuna = (await portesLunaOuvertes(FONCTION)) ? await demanderALuna(input.faits, input.userId) : null;
  const v: Essentiel360 = { points: parLuna ?? essentielDeterministe(input.faits), parLuna: Boolean(parLuna), calculeLe: maintenant.toISOString() };
  await ecrireCache(cle, jour, v);
  return v;
}
