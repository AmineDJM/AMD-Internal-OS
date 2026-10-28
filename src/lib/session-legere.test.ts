import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient, type Prisma } from "@prisma/client";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA SESSION LÉGÈRE DES SONDAGES DIT LA MÊME CHOSE QUE LA SESSION COMPLÈTE, EN 1 À 2 REQUÊTES
 * (audit performance PERF-06).
 *
 * Sur la base réelle, avec un client Prisma journalisé à la place du singleton (même technique que
 * `messaging-sync-perf.test.ts`) — un test de performance compte le SQL émis, pas des millisecondes.
 *
 *   1. ÉQUIVALENCE : pour chaque cas de révocation (session révoquée, expirée, compte désactivé, rôle
 *      changé en base, Vue exacte honorée, Super Admin rétrogradé), `identiteDuSondage` rend la même
 *      personne (ou le même refus) que `getCurrentUser`, et `peutVoirLaMessagerie` la même réponse que
 *      `userCan(…, "MESSAGING", "VIEW")`.
 *   2. BUDGET : la session complète coûte ~10 requêtes ; la légère au plus 2 (identité + droit).
 * Seuls le JWT et les cookies sont simulés.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const requetes: string[] = [];
const client = new PrismaClient({ log: [{ emit: "event", level: "query" }] });
(client as unknown as { $on: (e: "query", cb: (e: Prisma.QueryEvent) => void) => void }).$on("query", (e) => {
  requetes.push(e.query);
});
vi.mock("@/lib/prisma", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/prisma")>()),
  prisma: client,
}));
const ETAT = vi.hoisted(() => ({ session: null as unknown, vue: undefined as string | undefined }));
vi.mock("@/auth", () => ({ auth: async () => ETAT.session }));
vi.mock("next/headers", () => ({
  cookies: () => ({ get: (n: string) => (n === "amd_impersonate" && ETAT.vue ? { value: ETAT.vue } : undefined) }),
  headers: () => new Headers(),
}));

const { getCurrentUser } = await import("@/lib/session");
const { identiteDuSondage, peutVoirLaMessagerie } = await import("@/lib/session-legere");
const { userCan } = await import("@/lib/rbac");

let dbOk = false;
try { await client.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__sesslegere${Date.now()}__`;
const ids = { admin: "", cible: "", delegue: "", sidAdmin: "", sidDelegue: "" };

/** Les deux lectures, côte à côte, sur le même état. */
async function lesDeux() {
  const complet = await getCurrentUser();
  const leger = await identiteDuSondage();
  return {
    complet: complet && { id: complet.id, role: complet.role, secondaryRole: complet.secondaryRole ?? null, mustChangePassword: complet.mustChangePassword },
    leger,
    messagerieComplet: complet ? userCan(complet, "MESSAGING", "VIEW") : null,
    messagerieLeger: leger ? await peutVoirLaMessagerie(leger) : null,
  };
}

suite("Session légère des sondages — mêmes réponses, une fraction des requêtes", () => {
  beforeAll(async () => {
    const [a, c, d] = await Promise.all([
      client.user.create({ data: { name: `${TAG}admin`, email: `${TAG}a@t.dz`, passwordHash: "x", role: "SUPER_ADMIN" } }),
      client.user.create({ data: { name: `${TAG}cible`, email: `${TAG}c@t.dz`, passwordHash: "x", role: "MEDICAL_DELEGATE", secondaryRole: "SALES_USER" } }),
      client.user.create({ data: { name: `${TAG}delegue`, email: `${TAG}d@t.dz`, passwordHash: "x", role: "MEDICAL_DELEGATE" } }),
    ]);
    Object.assign(ids, { admin: a.id, cible: c.id, delegue: d.id });
    const demain = new Date(Date.now() + 86_400_000);
    const [sa, sd] = await Promise.all([
      client.userSession.create({ data: { userId: a.id, expiresAt: demain } }),
      client.userSession.create({ data: { userId: d.id, expiresAt: demain } }),
    ]);
    Object.assign(ids, { sidAdmin: sa.id, sidDelegue: sd.id });
  }, 60_000);

  beforeEach(async () => {
    ETAT.session = { user: { id: ids.delegue, role: "MEDICAL_DELEGATE", name: "Délégué", email: `${TAG}d@t.dz`, sid: ids.sidDelegue, mustChangePassword: false } };
    ETAT.vue = undefined;
    await Promise.all([
      client.user.updateMany({ where: { id: { in: [ids.delegue, ids.admin] } }, data: { isActive: true } }),
      client.user.update({ where: { id: ids.delegue }, data: { role: "MEDICAL_DELEGATE" } }),
      client.user.update({ where: { id: ids.admin }, data: { role: "SUPER_ADMIN" } }),
      client.userSession.updateMany({ where: { id: { in: [ids.sidAdmin, ids.sidDelegue] } }, data: { revokedAt: null, expiresAt: new Date(Date.now() + 86_400_000) } }),
      client.userAccess.deleteMany({ where: { userId: { in: [ids.delegue, ids.cible] } } }),
    ]);
  });

  afterAll(async () => {
    await client.userAccess.deleteMany({ where: { userId: { in: [ids.delegue, ids.cible] } } });
    await client.userSession.deleteMany({ where: { userId: { in: [ids.admin, ids.delegue] } } });
    await client.user.deleteMany({ where: { email: { startsWith: TAG } } });
    await client.$disconnect();
  }, 60_000);

  it("cas ordinaire : même personne, même droit à la messagerie", async () => {
    const r = await lesDeux();
    expect(r.leger).toEqual(r.complet);
    expect(r.leger?.id).toBe(ids.delegue);
    expect(r.messagerieLeger).toBe(true);
    expect(r.messagerieLeger).toBe(r.messagerieComplet);
  });

  it("session révoquée, puis expirée : refusée par les deux", async () => {
    await client.userSession.update({ where: { id: ids.sidDelegue }, data: { revokedAt: new Date() } });
    expect(await lesDeux()).toMatchObject({ complet: null, leger: null });
    await client.userSession.update({ where: { id: ids.sidDelegue }, data: { revokedAt: null, expiresAt: new Date(Date.now() - 1000) } });
    expect(await lesDeux()).toMatchObject({ complet: null, leger: null });
  });

  it("compte désactivé (sans révocation des sessions) : refusé dès le sondage suivant", async () => {
    await client.user.update({ where: { id: ids.delegue }, data: { isActive: false } });
    expect(await lesDeux()).toMatchObject({ complet: null, leger: null });
  });

  it("rôle changé en base : les deux lisent le rôle réel, pas celui du jeton", async () => {
    await client.user.update({ where: { id: ids.delegue }, data: { role: "VIEWER" } });
    const r = await lesDeux();
    expect(r.leger?.role).toBe("VIEWER");
    expect(r.leger).toEqual(r.complet);
  });

  it("messagerie BLOQUÉE par la console : non pour les deux", async () => {
    await client.userAccess.create({ data: { userId: ids.delegue, module: "MESSAGING", canView: false } });
    const r = await lesDeux();
    expect(r.messagerieLeger).toBe(false);
    expect(r.messagerieLeger).toBe(r.messagerieComplet);
  });

  it("Vue exacte : le sondage rend la personne visualisée (rôles compris), comme la page", async () => {
    ETAT.session = { user: { id: ids.admin, role: "SUPER_ADMIN", name: "Admin", email: `${TAG}a@t.dz`, sid: ids.sidAdmin } };
    ETAT.vue = ids.cible;
    const r = await lesDeux();
    expect(r.leger?.id).toBe(ids.cible);
    expect(r.leger).toEqual(r.complet);
    expect(r.leger?.secondaryRole).toBe("SALES_USER");
    expect(r.messagerieLeger).toBe(r.messagerieComplet);
  });

  it("Super Admin rétrogradé : le cookie de vue ne vaut plus, pour les deux", async () => {
    await client.user.update({ where: { id: ids.admin }, data: { role: "VIEWER" } });
    ETAT.session = { user: { id: ids.admin, role: "SUPER_ADMIN", name: "Admin", email: `${TAG}a@t.dz`, sid: ids.sidAdmin } };
    ETAT.vue = ids.cible;
    const r = await lesDeux();
    expect(r.leger?.id).toBe(ids.admin);
    expect(r.leger).toEqual(r.complet);
  });

  it("BUDGET : la session complète ≈ 10 requêtes, la légère ≤ 2 (identité + droit)", async () => {
    // Session déjà « touchée » dans la minute par les cas précédents : aucune écriture de `lastSeenAt`.
    requetes.length = 0;
    await getCurrentUser();
    const complet = requetes.length;
    requetes.length = 0;
    const qui = await identiteDuSondage();
    const identite = requetes.length;
    await peutVoirLaMessagerie(qui!);
    const total = requetes.length;
    console.info(`[PERF-06] getCurrentUser : ${complet} requêtes ; identiteDuSondage : ${identite} ; + peutVoirLaMessagerie : ${total}`);
    expect(complet).toBeGreaterThanOrEqual(8);
    expect(identite).toBe(1);
    expect(total).toBe(2);
  });
});
