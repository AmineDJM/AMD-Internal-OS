import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient, type Prisma } from "@prisma/client";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE BADGE DE LA BARRE SUPÉRIEURE NE CALCULE PAS LA LISTE DU MESSENGER (audit performance, PERF-02).
 *
 * `MessagesIndicator` est monté dans la coque de TOUTES les pages et interroge `/api/messaging/sync`
 * toutes les 12 s, onglet en arrière-plan compris. Il ne lit que `totalUnread`. La route calculait
 * pourtant, à chaque fois, la liste complète des conversations : adhésions, membres et leurs
 * fiches, dernier message, pièces jointes, comptage par conversation — puis la sérialisait.
 *
 * `?portee=badge` répond le total seul, par la requête de comptage que la coque utilise déjà au
 * rendu (`getTotalUnread`). Ce banc tient : le même total, AUCUNE lecture de conversations ni de
 * messages hors comptage, et l'indicateur qui demande bien cette portée.
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
let ACTEUR: unknown = null;
vi.mock("@/lib/session", () => ({ getCurrentUser: async () => ACTEUR }));
vi.mock("@/lib/scheduled", () => ({ runScheduledJobs: async () => undefined }));

const { NextRequest } = await import("next/server");
const { GET } = await import("./route");
const { getAccess } = await import("@/lib/rbac");

let dbOk = false;
try { await client.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__badgesync__";
const appel = (url: string) => GET(new NextRequest(`http://localhost${url}`));

suite("/api/messaging/sync?portee=badge — le total, sans la liste", () => {
  let moi = "";
  let conv = "";

  beforeAll(async () => {
    await client.user.deleteMany({ where: { email: { startsWith: TAG } } });
    moi = (await client.user.create({ data: { name: `${TAG}moi`, email: `${TAG}moi@t.dz`, passwordHash: "x", role: "SUPER_ADMIN" } })).id;
    const autre = (await client.user.create({ data: { name: `${TAG}autre`, email: `${TAG}autre@t.dz`, passwordHash: "x" } })).id;
    conv = (await client.conversation.create({
      data: { type: "GROUP", title: `${TAG}c`, createdById: moi, members: { create: [{ userId: moi }, { userId: autre }] } },
    })).id;
    await client.message.createMany({ data: [1, 2, 3].map((k) => ({ conversationId: conv, senderId: autre, body: `m${k}` })) });
    ACTEUR = { id: moi, role: "SUPER_ADMIN", mustChangePassword: false, access: await getAccess(moi, "SUPER_ADMIN") };
  });

  afterAll(async () => {
    await client.conversation.deleteMany({ where: { id: conv } });
    await client.user.deleteMany({ where: { email: { startsWith: TAG } } });
    await client.$disconnect();
  });

  it("répond le même total que la liste complète, sans la liste", async () => {
    const complet = await (await appel("/api/messaging/sync")).json();
    expect(complet.totalUnread).toBe(3);
    expect(Array.isArray(complet.conversations)).toBe(true);

    requetes.length = 0;
    const badge = await (await appel("/api/messaging/sync?portee=badge")).json();
    expect(badge).toEqual({ totalUnread: 3 });
    // Ni adhésions avec leurs conversations, ni messages hors comptage.
    const lourdes = requetes.filter((q) => /FROM\s+"(public"\.")?(Conversation|Message|MessageAttachment)"/.test(q) && !/COUNT\(/i.test(q));
    expect(lourdes, lourdes.join("\n")).toEqual([]);
  });

  it("l'indicateur de la coque demande la portée « badge »", () => {
    const src = readFileSync(join(process.cwd(), "src/components/layout/messages-indicator.tsx"), "utf8");
    expect(src).toMatch(/\/api\/messaging\/sync\?portee=badge/);
  });
});
