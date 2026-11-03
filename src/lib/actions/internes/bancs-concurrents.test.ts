import { afterAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { prisma } from "@/lib/prisma";
import { attendreBloques, compterBloques, poserBarriere } from "./bancs-concurrents";
import { ecartsDesGestesSousBarriere } from "./surveillance-sous-barriere";

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
    await autre.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
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

  it("SOUS LA BARRIÈRE, une notification à un compte VOISIN est relevée ; au compte du banc, non (R2)", async () => {
    // Le voisin est créé par l'AUTRE processus : ce processus ne l'a jamais vu naître — exactement un compte d'un banc voisin.
    const voisin = await autre.user.create({ data: { email: `${TAG}voisin@t.dz`, name: `${TAG}voisin`, passwordHash: "x", role: "DIRECTION_ASSISTANT" } });
    const duBanc = await prisma.user.create({ data: { email: `${TAG}banc@t.dz`, name: `${TAG}banc`, passwordHash: "x", role: "DIRECTION_ASSISTANT" } });
    await prisma.notification.create({ data: { userId: voisin.id, title: `${TAG} hors barrière` } });
    expect(ecartsDesGestesSousBarriere(), "hors barrière, rien à relever").toEqual([]);
    await prisma.$transaction(async (tx) => {
      await poserBarriere(tx, "FeatureFlag");
      await prisma.notification.create({ data: { userId: duBanc.id, title: `${TAG} au banc` } });
      expect(ecartsDesGestesSousBarriere(), "le compte du banc ne noue rien").toEqual([]);
      await prisma.notification.createMany({ data: [{ userId: voisin.id, title: `${TAG} au voisin` }] });
    }, { timeout: 30_000 });
    expect(ecartsDesGestesSousBarriere()).toEqual([`${TAG}voisin@t.dz (DIRECTION_ASSISTANT)`]);
  });
});

/**
 * CLIQUET — UN BANC NE COMPTE PAS LUI-MÊME LES SESSIONS « EN ATTENTE DE VERROU ». Sept bancs avaient leur propre boucle
 * (`wait_event_type = 'Lock' AND query ILIKE …`) : elle comptait TOUTE session de la suite arrêtée sur la table — une
 * écriture voisine ouvrait leur barrière avant leur geste, et le croisement prétendu n'avait pas lieu (la faille de R2,
 * corrigée dans la porte commune au début de F1, restée vive dans les boucles locales). La porte : `attendreBloques`.
 * Un banc qui rattache lui-même l'attente à sa transaction (`pg_blocking_pids`) est juste, et passe.
 */
describe("cliquet — les barrières passent par la porte commune", () => {
  const bancs = execFileSync("git", ["ls-files", "src/**/*.test.ts"], { encoding: "utf8" }).split("\n")
    .filter((f) => f && f !== "src/lib/actions/internes/bancs-concurrents.test.ts");
  it("aucune boucle locale ne compte les attentes de verrou de toute la suite", () => {
    const sansCommentaires = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const fautifs = bancs.filter((f) => {
      const t = sansCommentaires(readFileSync(f, "utf8"));
      return /wait_event_type\s*=\s*'Lock'/.test(t) && !/pg_blocking_pids/.test(t);
    });
    expect(bancs.length).toBeGreaterThan(1000);
    expect(fautifs, "compter par `attendreBloques` (bancs-concurrents.ts) : seuls les gestes que la barrière arrête, et de ce processus").toEqual([]);
  });
});

