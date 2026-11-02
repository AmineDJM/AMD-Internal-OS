import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { attendreBloques, poserBarriere } from "@/lib/actions/internes/bancs-concurrents";
import { snapshotMonth } from "@/lib/sfe-sweep";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * CLORE UN MOIS UNE FOIS, ET NE L'ANNONCER QU'UNE FOIS (§118.185 — audit 360°, I16).
 *
 * Le 1er du mois, le battement fige le mois écoulé puis envoie la revue aux superviseurs. Deux
 * instances (ou deux battements) qui passaient le même matin clôturaient chacune « le mois » —
 * l'écriture n'était pas conditionnelle — et chacune envoyait sa revue : deux revues identiques par
 * superviseur, et un instantané figé réécrit par le second passage. La clôture ne se fait plus que
 * par le passage qui trouve le mois ENCORE OUVERT, et la revue ne part que pour les superviseurs
 * dont CE passage a clos au moins un KAM.
 *
 * Joué sur un KAM du banc et un mois lointain : aucune ligne d'un autre banc ne peut être touchée.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const TAG = `__sfeclos${Date.now()}__`;
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

suite("la clôture d'un mois SFE — une seule fois, par un seul passage", () => {
  let rep = "";

  async function nettoyer() {
    const comptes = (await prisma.user.findMany({ where: { email: { startsWith: "__sfeclos" } }, select: { id: true } })).map((u) => u.id);
    await prisma.salesRepMonthlyKpi.deleteMany({ where: { repId: { in: comptes } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: comptes } } }).catch(() => {});
  }

  beforeAll(async () => {
    await nettoyer();
    rep = (await prisma.user.create({ data: { name: `${TAG} kam`, email: `${TAG}kam@t.dz`, role: "MEDICAL_DELEGATE", passwordHash: "x", isActive: true } })).id;
  });
  afterAll(nettoyer);

  /**
   * FORCER L'ENTRELACEMENT (§118.65, §118.164e). Deux clôtures lancées « en même temps » se
   * succédaient : la seconde lisait le mois déjà clos et s'arrêtait d'elle-même — le banc passait
   * au vert sans la condition qu'il prétendait éprouver (mesuré : les deux sabotages de la série
   * restaient verts). La barrière bloque les ÉCRITURES de la table sans bloquer ses lectures, attend
   * que les deux passages aient LU et soient bloqués sur leur écriture, puis relâche.
   */
  async function sousBarriere<T>(lancer: () => Promise<T>[]): Promise<T[]> {
    let gestes: Promise<T>[] = [];
    await prisma.$transaction(async (tx) => {
      await poserBarriere(tx, "SalesRepMonthlyKpi");
      gestes = lancer();
      for (const g of gestes) g.catch(() => undefined);
      await attendreBloques(tx, "%SalesRepMonthlyKpi%", 2);
    }, { timeout: 20_000 });
    return Promise.all(gestes);
  }

  const kpi = (year: number, month: number) =>
    prisma.salesRepMonthlyKpi.findUnique({ where: { repId_year_month: { repId: rep, year, month } }, select: { closedAt: true, computedAt: true } });

  it("le premier passage clôt et NOMME le KAM clos ; le second ne trouve plus rien à clore", async () => {
    const a = await snapshotMonth(2001, 2, true, [rep]);
    expect(a.closedRepIds).toEqual([rep]);
    expect(a.closed).toBe(1);
    const fige = await kpi(2001, 2);
    expect(fige?.closedAt, "prémisse : le mois est figé").not.toBeNull();
    const b = await snapshotMonth(2001, 2, true, [rep]);
    expect(b.closedRepIds).toEqual([]);
    expect(b.closed).toBe(0);
    // Le mois figé n'est pas réécrit : sa date de calcul est celle de la clôture.
    expect((await kpi(2001, 2))?.computedAt.toISOString()).toBe(fige?.computedAt.toISOString());
  });

  it("un mois ouvert par l'instantané vivant se clôt par l'écriture CONDITIONNELLE, puis ne bouge plus", async () => {
    const vivant = await snapshotMonth(2001, 3, false, [rep]);
    expect(vivant.written).toBe(1);
    expect((await kpi(2001, 3))?.closedAt, "prémisse : l'instantané vivant ne clôt rien").toBeNull();
    const clos = await snapshotMonth(2001, 3, true, [rep]);
    expect(clos.closedRepIds).toEqual([rep]);
    // L'instantané vivant ne réécrit pas un mois clos.
    expect((await snapshotMonth(2001, 3, false, [rep])).written).toBe(0);
  });

  it("deux clôtures SIMULTANÉES : une seule clôt, une seule le dit", async () => {
    // Les deux lisent « pas de ligne » avant que l'une écrive (la barrière y veille) : l'une crée,
    // l'autre heurte la clé unique — `ON CONFLICT DO NOTHING` lui rend 0 ligne, et elle ne compte rien.
    const [x, y] = await sousBarriere(() => [snapshotMonth(2001, 4, true, [rep]), snapshotMonth(2001, 4, true, [rep])]);
    expect([...x.closedRepIds, ...y.closedRepIds]).toEqual([rep]);
    expect(x.closed + y.closed).toBe(1);
  });

  it("deux clôtures SIMULTANÉES d'un mois DÉJÀ OUVERT : l'écriture conditionnelle n'en laisse passer qu'une", async () => {
    // L'autre chemin : la ligne existe (l'instantané vivant l'a écrite), les deux passages la
    // lisent ouverte, et c'est la condition `closedAt: null` de l'écriture qui départage.
    expect((await snapshotMonth(2001, 5, false, [rep])).written).toBe(1);
    const [x, y] = await sousBarriere(() => [snapshotMonth(2001, 5, true, [rep]), snapshotMonth(2001, 5, true, [rep])]);
    expect([...x.closedRepIds, ...y.closedRepIds]).toEqual([rep]);
  });

  it("la revue ne part que pour les superviseurs dont CE passage a clos un KAM (point d'appel)", () => {
    // Le balayage complet parcourt toute la force de vente de la base et notifie ses superviseurs :
    // le rejouer ici écrirait chez les autres bancs. On tient donc le POINT D'APPEL (§118.49) — la
    // revue lit la liste que la clôture RENVOIE, pas « le mois est clos » relu en base, qui serait
    // vrai pour les deux passages.
    const src = readFileSync("src/lib/sfe-sweep.ts", "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
    expect(src).toMatch(/const clos = await snapshotMonth\(prev\.year, prev\.month, true\);/);
    expect(src).toMatch(/const closIci = new Set\(clos\.closedRepIds\);/);
    expect(src).toMatch(/if \(!\[\.\.\.info\.repIds\]\.some\(\(id\) => closIci\.has\(id\)\)\) continue;/);
  });
});
