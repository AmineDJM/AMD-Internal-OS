import { afterAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { attendreBloques, compterBloques, poserBarriere } from "./bancs-concurrents";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA BARRIÈRE NE COMPTE QUE LES GESTES DE SON BANC — jamais l'écriture d'un autre processus qu'elle arrête au passage.
 *
 * Un verrou de table arrête TOUTES les écritures de la table, celles des fichiers voisins comprises. Comptée, une
 * insertion voisine ouvrait la barrière avant que le geste du banc n'y soit : le geste concurrent passait trop tôt, et le
 * croisement que le banc prétend forcer n'avait pas lieu (signalé : « R2 — UNE ANNULATION APRÈS LA PRISE, AVANT
 * L'ORDRE », approbation-achat-flow, sous `npm test`). L'« autre processus » est ici un second client signé d'un autre
 * nom (`application_name`) — exactement ce que voit Postgres d'un autre fichier de la suite.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__barriere__${Date.now().toString(36)}`;
const base = process.env.DATABASE_URL?.replace(/([?&])application_name=[^&]*/, "$1").replace(/[?&]$/, "") ?? "";
const autre = new PrismaClient({ datasourceUrl: `${base}${base.includes("?") ? "&" : "?"}application_name=autre-processus-${process.pid}` });
const drapeau = (n: string) => ({ data: { key: `${TAG}${n}`, label: `${TAG}${n}`, stage: "TEST" as const } });

suite("la barrière de concurrence ne compte que les gestes de son processus", () => {
  afterAll(async () => {
    await prisma.featureFlag.deleteMany({ where: { key: { startsWith: TAG } } }).catch(() => {});
    await autre.$disconnect();
  });

  it("les connexions de ce processus sont signées — sans quoi rien ne les distingue d'un voisin", async () => {
    const [{ nom }] = await prisma.$queryRaw<{ nom: string }[]>`SELECT current_setting('application_name') AS nom`;
    expect(nom).toBe(`banc-${process.pid}`);
  });

  it("une écriture d'un AUTRE processus arrêtée par la barrière ne compte pas ; celle du banc, si", async () => {
    let voisine!: Promise<unknown>, geste!: Promise<unknown>;
    await prisma.$transaction(async (tx) => {
      await poserBarriere(tx, "FeatureFlag");
      voisine = autre.featureFlag.create(drapeau("voisin"));
      voisine.catch(() => undefined);
      // L'écriture voisine est bel et bien ARRÊTÉE par la barrière : sinon ce cas ne prouverait rien.
      const debut = Date.now();
      for (;;) {
        await tx.$executeRawUnsafe("SELECT pg_stat_clear_snapshot()");
        const [{ n }] = await tx.$queryRaw<{ n: number }[]>`
          SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE application_name = ${`autre-processus-${process.pid}`} AND wait_event_type = 'Lock' AND pg_backend_pid() = ANY(pg_blocking_pids(pid))`;
        if (n === 1) break;
        expect(Date.now() - debut, "l'écriture voisine n'a jamais atteint la barrière").toBeLessThan(10_000);
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(await compterBloques(tx, "FeatureFlag"), "la voisine compterait pour le geste du banc").toBe(0);
      expect(await attendreBloques(tx, "FeatureFlag", 1, { delaiMs: 300, exiger: false }), "la barrière s'ouvrirait sans le geste").toBe(0);
      geste = prisma.featureFlag.create(drapeau("banc"));
      geste.catch(() => undefined);
      expect(await attendreBloques(tx, "FeatureFlag", 1)).toBe(1);
    }, { timeout: 30_000 });
    await Promise.all([voisine, geste]);
    expect(await prisma.featureFlag.count({ where: { key: { startsWith: TAG } } })).toBe(2);
  });
});
