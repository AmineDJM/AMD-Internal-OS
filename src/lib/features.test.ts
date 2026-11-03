import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { featureEnabled, listFeatures, FEATURES } from "./features";

/**
 * Version de TEST → version de PRODUCTION.
 *
 * La règle à ne jamais casser : une nouveauté au stade TEST est **invisible** de tous les
 * comptes ordinaires ; seule sa validation (stade PROD) la rend visible de l'entreprise.
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__feat__${Date.now()}`;
const KEY = `${TAG}_demo`;
let normalUser = "", testerUser = "";

suite("Drapeaux de version — cloisonnement test / production", () => {
  beforeAll(async () => {
    const mk = (s: string, testMode: boolean) =>
      prisma.user.create({ data: { name: `${TAG}${s}`, email: `${TAG}${s}@t.dz`, passwordHash: "x", role: "SALES_USER", testMode } });
    const [n, t] = await Promise.all([mk("normal", false), mk("tester", true)]);
    normalUser = n.id; testerUser = t.id;
  });

  afterAll(async () => {
    await prisma.featureFlag.deleteMany({ where: { key: { startsWith: TAG } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("une nouveauté inconnue est créée AU STADE TEST (jamais livrée par accident)", async () => {
    expect(await featureEnabled(KEY, normalUser)).toBe(false);
    const created = await prisma.featureFlag.findUnique({ where: { key: KEY } });
    expect(created?.stage).toBe("TEST");
  });

  it("en TEST : visible du seul compte en mode test", async () => {
    expect(await featureEnabled(KEY, testerUser)).toBe(true);
    expect(await featureEnabled(KEY, normalUser)).toBe(false);
  });

  it("validée en PRODUCTION : visible de TOUT LE MONDE", async () => {
    await prisma.featureFlag.update({ where: { key: KEY }, data: { stage: "PROD" } });
    expect(await featureEnabled(KEY, normalUser)).toBe(true);
    expect(await featureEnabled(KEY, testerUser)).toBe(true);
  });

  it("retour arrière : elle redevient invisible du grand public", async () => {
    await prisma.featureFlag.update({ where: { key: KEY }, data: { stage: "TEST" } });
    expect(await featureEnabled(KEY, normalUser)).toBe(false);
  });

  it("désactivée (OFF) : invisible même en mode test", async () => {
    await prisma.featureFlag.update({ where: { key: KEY }, data: { stage: "OFF" } });
    expect(await featureEnabled(KEY, normalUser)).toBe(false);
    expect(await featureEnabled(KEY, testerUser)).toBe(false);
  });

  it("le catalogue référence les nouveautés annoncées", async () => {
    const rows = await listFeatures();
    const keys = rows.map((r) => r.key);
    for (const f of Object.values(FEATURES)) expect(keys).toContain(f.key);
  });
});
