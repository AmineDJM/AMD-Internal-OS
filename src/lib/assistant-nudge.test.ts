import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR , requireUserAuNomDeLaVue: async () => ACTOR}));

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { getUnreadDigest } from "./assistant-nudge";
import { assistantNudge } from "@/lib/actions/assistant-actions";

// Sans clé IA → l'analyse proactive ne s'exécute pas (chemin gracieux, déterministe).
delete process.env.ANTHROPIC_API_KEY;

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__nudgetest__";
async function actorFor(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false };
}

suite("Assistant flottant — suggestion proactive (digest non lus + coût maîtrisé)", () => {
  // La suggestion proactive EST Adam : depuis §118.153 elle n'est servie qu'au Super Admin. Le
  // délégué garde des non-lus — c'est ce qui rend son refus MESURABLE : sans eux, « refusé » et
  // « rien à suggérer » rendraient la même réponse, et le cas ne prouverait rien.
  let aliceId = "", bobId = "", saId = "", sa2Id = "";
  const convIds: string[] = [];

  beforeAll(async () => {
    const [a, b, sa, sa2] = await Promise.all([
      prisma.user.create({ data: { name: `${TAG}alice`, email: `${TAG}a@t.dz`, role: "MEDICAL_DELEGATE", passwordHash: "x" } }),
      prisma.user.create({ data: { name: `${TAG}bob`, email: `${TAG}b@t.dz`, role: "HEAD_OF_SALES", passwordHash: "x" } }),
      prisma.user.create({ data: { name: `${TAG}sa`, email: `${TAG}sa@t.dz`, role: "SUPER_ADMIN", passwordHash: "x" } }),
      prisma.user.create({ data: { name: `${TAG}sa2`, email: `${TAG}sa2@t.dz`, role: "SUPER_ADMIN", passwordHash: "x" } }),
    ]);
    aliceId = a.id; bobId = b.id; saId = sa.id; sa2Id = sa2.id;
    for (const destinataire of [aliceId, saId]) {
      const conv = await prisma.conversation.create({
        data: { type: "DIRECT", createdById: bobId, members: { create: [{ userId: destinataire }, { userId: bobId }] } },
        select: { id: true },
      });
      convIds.push(conv.id);
      await prisma.message.create({ data: { conversationId: conv.id, senderId: bobId, kind: "TEXT", body: `${TAG} Peux-tu préparer le dossier PCH pour demain ?` } });
    }
  });

  afterAll(async () => {
    await prisma.conversation.deleteMany({ where: { id: { in: convIds } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("le digest repère le message non lu adressé à Alice (pas les siens)", async () => {
    const digest = await getUnreadDigest(aliceId);
    expect(digest.count).toBe(1);
    expect(digest.text).toContain("dossier PCH");
    expect(digest.signature).not.toBe("0");
    // Bob n'a aucun non-lu (le message est de lui).
    expect((await getUnreadDigest(bobId)).count).toBe(0);
  });

  it("assistantNudge : signature reflète le nouveau, sans clé IA aucune suggestion (gracieux)", async () => {
    ACTOR = await actorFor(saId, "SUPER_ADMIN");
    const r = await assistantNudge("");
    expect(r.signature).not.toBe("0");
    expect(r.suggestion).toBeNull(); // pas de clé → pas d'appel IA
  });

  it("coût maîtrisé : signature inchangée → court-circuit (aucune analyse)", async () => {
    ACTOR = await actorFor(saId, "SUPER_ADMIN");
    const digest = await getUnreadDigest(saId);
    const r = await assistantNudge(digest.signature);
    expect(r.suggestion).toBeNull();
    expect(r.signature).toBe(digest.signature);
  });

  it("aucun non-lu → rien à suggérer", async () => {
    ACTOR = await actorFor(sa2Id, "SUPER_ADMIN");
    const r = await assistantNudge("");
    expect(r).toEqual({ signature: "0", suggestion: null });
  });

  it("Adam réservé au Super Admin (§118.153) : le délégué qui A des non-lus n'obtient rien", async () => {
    // PRÉMISSE : elle a bien de quoi recevoir une suggestion — sinon le refus serait invisible.
    expect((await getUnreadDigest(aliceId)).count).toBe(1);
    ACTOR = await actorFor(aliceId, "MEDICAL_DELEGATE");
    expect(await assistantNudge("")).toEqual({ signature: "0", suggestion: null });
  });
});
