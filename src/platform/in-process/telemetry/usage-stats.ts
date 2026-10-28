/**
 * LES CHIFFRES DU COÛT — lus dans `ModelCallLog` et `AiUsageLog`, jamais recalculés à la main.
 *
 * Tout est agrégé EN BASE (sommes, percentiles) : le tableau de bord lit quelques lignes, pas
 * des milliers d'appels. Un coût inconnu (tarif absent) est COMPTÉ À PART et affiché comme tel :
 * la somme des coûts connus n'est jamais présentée comme « le » total quand des appels sans
 * tarif existent (§78 — un total partiel se lit comme un total).
 */
import { prisma } from "@/lib/prisma";
import { sansBloquer } from "@/lib/journal";

export interface CoutParCle {
  cle: string;
  appels: number;
  entree: number;
  sortie: number;
  cache: number;
  /** Somme des coûts CONNUS. */
  coutUsd: number;
  /** Appels dont le tarif était inconnu — le total au-dessus n'est complet que s'il vaut zéro. */
  sansTarif: number;
}

export interface StatistiquesCout {
  periode: { depuis: Date; jours: number };
  total: CoutParCle;
  aujourdHui: CoutParCle;
  parModele: CoutParCle[];
  parUsage: CoutParCle[];
  parPersonne: (CoutParCle & { userId: string })[];
  /** Coût PAR TOUR de conversation (AiUsageLog, feature assistant) : moyenne, médiane, P95, part inconnue. */
  parTour: { tours: number; moyenUsd: number | null; p50Usd: number | null; p95Usd: number | null; toursSansTarif: number; partCache: number | null };
  missions: { missions: number; coutUsd: number; sansTarif: number; moyenUsd: number | null };
}

type Ligne = { cle: string; appels: bigint | number; entree: bigint | number | null; sortie: bigint | number | null; cache: bigint | number | null; cout: unknown; sansTarif: bigint | number | null };

const n = (v: unknown): number => (v == null ? 0 : Number(v));

function ligneVersCle(l: Ligne): CoutParCle {
  return { cle: l.cle, appels: n(l.appels), entree: n(l.entree), sortie: n(l.sortie), cache: n(l.cache), coutUsd: Math.round(n(l.cout) * 1_000_000) / 1_000_000, sansTarif: n(l.sansTarif) };
}

async function agreger(colonne: "model" | "feature" | "userId", depuis: Date, limite = 12): Promise<CoutParCle[]> {
  // La colonne est choisie parmi trois littéraux connus : jamais une chaîne venue de l'extérieur.
  const col = colonne === "model" ? "model" : colonne === "feature" ? "feature" : "userId";
  const rows = await prisma.$queryRawUnsafe<Ligne[]>(
    `SELECT COALESCE("${col}", '—') AS "cle", COUNT(*) AS "appels",
            SUM("inputTokens") AS "entree", SUM("outputTokens") AS "sortie", SUM("cachedInputTokens") AS "cache",
            SUM(COALESCE("costUsd", 0)) AS "cout", SUM(CASE WHEN "costUsd" IS NULL THEN 1 ELSE 0 END) AS "sansTarif"
     FROM "ModelCallLog" WHERE "at" >= $1
     GROUP BY COALESCE("${col}", '—') ORDER BY "cout" DESC LIMIT $2`,
    depuis, limite,
  ).catch(sansBloquer("usage-stats.agreger.$queryRawUnsafe", [] as Ligne[]));
  return rows.map(ligneVersCle);
}

async function totalDepuis(depuis: Date): Promise<CoutParCle> {
  const rows = await prisma.$queryRaw<Ligne[]>`
    SELECT 'total' AS "cle", COUNT(*) AS "appels",
           SUM("inputTokens") AS "entree", SUM("outputTokens") AS "sortie", SUM("cachedInputTokens") AS "cache",
           SUM(COALESCE("costUsd", 0)) AS "cout", SUM(CASE WHEN "costUsd" IS NULL THEN 1 ELSE 0 END) AS "sansTarif"
    FROM "ModelCallLog" WHERE "at" >= ${depuis}`.catch(sansBloquer("usage-stats.totalDepuis", [] as Ligne[]));
  return rows[0] ? ligneVersCle(rows[0]) : { cle: "total", appels: 0, entree: 0, sortie: 0, cache: 0, coutUsd: 0, sansTarif: 0 };
}

export async function statistiquesCout(jours = 30): Promise<StatistiquesCout> {
  const depuis = new Date(Date.now() - jours * 86_400_000);
  const debutJour = new Date(); debutJour.setUTCHours(0, 0, 0, 0);
  const [total, aujourdHui, parModele, parUsage, parPersonne, tour, missions] = await Promise.all([
    totalDepuis(depuis),
    totalDepuis(debutJour),
    agreger("model", depuis),
    agreger("feature", depuis),
    agreger("userId", depuis, 8),
    prisma.$queryRaw<{ tours: bigint; moyen: unknown; p50: unknown; p95: unknown; sansTarif: bigint; entree: unknown; cache: unknown }[]>`
      SELECT COUNT(*) AS "tours",
             AVG("costUsd") AS "moyen",
             percentile_cont(0.5) WITHIN GROUP (ORDER BY "costUsd") AS "p50",
             percentile_cont(0.95) WITHIN GROUP (ORDER BY "costUsd") AS "p95",
             SUM(CASE WHEN "costUsd" IS NULL AND "llmCalls" > 0 THEN 1 ELSE 0 END) AS "sansTarif",
             SUM("inputTokens") AS "entree", SUM("cachedInputTokens") AS "cache"
      FROM "AiUsageLog" WHERE "createdAt" >= ${depuis} AND "feature" = 'assistant' AND "llmCalls" IS NOT NULL`.catch(sansBloquer("usage-stats.statistiquesCout", [])),
    prisma.$queryRaw<{ missions: bigint; cout: unknown; sansTarif: bigint }[]>`
      SELECT COUNT(DISTINCT "missionId") AS "missions", SUM(COALESCE("costUsd", 0)) AS "cout",
             SUM(CASE WHEN "costUsd" IS NULL THEN 1 ELSE 0 END) AS "sansTarif"
      FROM "ModelCallLog" WHERE "at" >= ${depuis} AND "missionId" IS NOT NULL`.catch(sansBloquer("usage-stats.statistiquesCout", [])),
  ]);
  const t = tour[0];
  const entreeTours = n(t?.entree);
  const m = missions[0];
  const nbMissions = n(m?.missions);
  return {
    periode: { depuis, jours },
    total, aujourdHui, parModele, parUsage,
    parPersonne: parPersonne.map((p) => ({ ...p, userId: p.cle })),
    parTour: {
      tours: n(t?.tours),
      moyenUsd: t?.moyen == null ? null : Number(t.moyen),
      p50Usd: t?.p50 == null ? null : Number(t.p50),
      p95Usd: t?.p95 == null ? null : Number(t.p95),
      toursSansTarif: n(t?.sansTarif),
      partCache: entreeTours > 0 ? n(t?.cache) / entreeTours : null,
    },
    missions: { missions: nbMissions, coutUsd: Math.round(n(m?.cout) * 1_000_000) / 1_000_000, sansTarif: n(m?.sansTarif), moyenUsd: nbMissions > 0 ? n(m?.cout) / nbMissions : null },
  };
}

/** « 0,0876 $ » — quatre décimales : un tour se compte en centièmes de centime. */
export function fmtUsd(v: number | null | undefined, decimales = 4): string {
  if (v == null || !Number.isFinite(v)) return "inconnu";
  return `${v.toLocaleString("fr-FR", { minimumFractionDigits: decimales, maximumFractionDigits: decimales })} $`;
}
