import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { emettreMessageRecu } from "@/lib/events/messaging-events";

/**
 * UN MESSAGE INTERNE RÉVEILLE LA MISSION QUI L'ATTENDAIT. Avant ce lot, `MESSAGE_RECEIVED`
 * n'existait pas dans le registre : une attente ainsi nommée dormait pour toujours.
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `wake${Date.now().toString(36)}`;
let ownerId = "", raihanaId = "", missionId = "", convId = "";

suite("réveil par message interne", () => {
  beforeAll(async () => {
    const owner = await prisma.user.create({ data: { name: `${TAG} PDG`, email: `${TAG}pdg@amd.dz`, passwordHash: "x", role: "SUPER_ADMIN" }, select: { id: true } });
    ownerId = owner.id;
    const r = await prisma.user.create({ data: { name: `Raihana ${TAG}`, email: `${TAG}r@amd.dz`, passwordHash: "x", role: "REGULATORY_ASSISTANT" }, select: { id: true } });
    raihanaId = r.id;
    const conv = await prisma.conversation.create({ data: { type: "DIRECT", createdById: ownerId, members: { create: [{ userId: ownerId }, { userId: raihanaId }] } }, select: { id: true } });
    convId = conv.id;
    const m = await prisma.mission.create({ data: { kind: "RUNTIME", status: "WAITING_EVENT", title: `${TAG} attente`, objective: "x", goalRaw: "x", ownerId, planVersion: 1 }, select: { id: true } });
    missionId = m.id;
    await prisma.missionStep.create({
      data: {
        missionId, key: "attente:raihana", title: "Retour de Raihana", nodeType: "WAIT_EVENT", status: "WAITING",
        input: {}, waitFor: { event: "MESSAGE_RECEIVED", from: `Raihana ${TAG}`, withinDays: 3 }, attempt: 0, maxAttempts: 3,
      } as never,
    });
  }, 60_000);
  afterAll(async () => {
    await prisma.businessEvent.deleteMany({ where: { actorId: { in: [ownerId, raihanaId] } } }).catch(() => {});
    await prisma.message.deleteMany({ where: { conversationId: convId } }).catch(() => {});
    await prisma.conversation.deleteMany({ where: { id: convId } }).catch(() => {});
    await prisma.mission.deleteMany({ where: { ownerId } }).catch(() => {});
    await retirerComptesEtSemis({ where: { id: { in: [ownerId, raihanaId] } } }).catch(() => {});
  }, 60_000);

  it("un message de quelqu'un d'autre ne réveille pas ; le message de Raihana règle l'attente", async () => {
    await emettreMessageRecu({ conversationId: convId, senderId: ownerId, senderName: `${TAG} PDG`, body: "Où en est-on ?", recipientIds: [raihanaId] });
    let step = await prisma.missionStep.findFirst({ where: { missionId, key: "attente:raihana" }, select: { status: true, result: true } });
    expect(step?.status).toBe("WAITING");

    await emettreMessageRecu({ conversationId: convId, senderId: raihanaId, senderName: `Raihana ${TAG}`, senderEmail: `${TAG}r@amd.dz`, body: "Le CPP légalisé arrive lundi.", recipientIds: [ownerId] });
    step = await prisma.missionStep.findFirst({ where: { missionId, key: "attente:raihana" }, select: { status: true, result: true } });
    expect(step?.status).toBe("DONE");
    expect((step?.result as { reveillePar?: string }).reveillePar).toBe("MESSAGE_RECEIVED");
    const payload = (step?.result as { payload?: { text?: string; from?: string } }).payload;
    expect(payload?.from).toBe(`Raihana ${TAG}`);
    expect(payload?.text).toContain("CPP légalisé");
  }, 60_000);
});
