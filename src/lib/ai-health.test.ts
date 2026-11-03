import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { performAiHealthCheck } from "@/lib/ai-health";
import type { AiHealthResult } from "@/lib/ai";

/**
 * Sonde de santé IA : gating quotidien, journalisation, ET alerte des Super Admins avec le
 * message EXACT en cas de panne (+ message de rétablissement). La sonde réseau est injectée
 * pour tester la logique sans appeler l'API.
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__aihealth__";
const fail = (error: string): (() => Promise<AiHealthResult>) => async () => ({ ok: false, configured: true, model: "test-model", latencyMs: 12, status: 401, error });
const pass = (): (() => Promise<AiHealthResult>) => async () => ({ ok: true, configured: true, model: "test-model", latencyMs: 8, status: 200 });

suite("performAiHealthCheck — gating + alerte Super Admin", () => {
  let adminId = "";

  beforeEach(async () => {
    await prisma.aiHealthCheck.deleteMany({});
    await prisma.notification.deleteMany({ where: { user: { email: { startsWith: TAG } } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
    adminId = (await prisma.user.create({ data: { name: `${TAG}sa`, email: `${TAG}sa@t.dz`, passwordHash: "x", role: "SUPER_ADMIN" } })).id;
  });

  afterAll(async () => {
    await prisma.aiHealthCheck.deleteMany({});
    await prisma.notification.deleteMany({ where: { user: { email: { startsWith: TAG } } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("échec → journalise + ALERTE le Super Admin avec le message EXACT", async () => {
    const r = await performAiHealthCheck({ selfTest: fail("HTTP 401 — invalid x-api-key") });
    expect(r.ok).toBe(false);
    const logs = await prisma.aiHealthCheck.findMany();
    expect(logs).toHaveLength(1);
    expect(logs[0].notifiedAt).not.toBeNull();
    const notifs = await prisma.notification.findMany({ where: { userId: adminId } });
    expect(notifs).toHaveLength(1);
    expect(notifs[0].body).toContain("HTTP 401 — invalid x-api-key"); // message exact transmis
  });

  it("débounce quotidien : un 2ᵉ appel non forcé ne relance rien", async () => {
    await performAiHealthCheck({ selfTest: fail("erreur A") });
    const again = await performAiHealthCheck({ selfTest: fail("erreur B") });
    expect(again.skipped).toBe(true);
    expect(await prisma.aiHealthCheck.count()).toBe(1); // pas de nouvelle sonde
  });

  it("force=true ignore le débounce ; rétablissement → notifie le retour à la normale", async () => {
    await performAiHealthCheck({ selfTest: fail("panne") });
    const back = await performAiHealthCheck({ force: true, selfTest: pass() });
    expect(back.ok).toBe(true);
    expect(await prisma.aiHealthCheck.count()).toBe(2);
    const notifs = await prisma.notification.findMany({ where: { userId: adminId }, orderBy: { createdAt: "asc" } });
    expect(notifs).toHaveLength(2);
    expect(notifs[1].title).toContain("rétabli");
  });
});
