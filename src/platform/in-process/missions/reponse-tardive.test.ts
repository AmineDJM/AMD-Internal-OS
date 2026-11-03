import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { assurerCompteAgent } from "@/lib/missions/agent/account";
import { relancerAttente } from "@/platform/in-process/missions/relance";
import { emettreMessageRecu } from "@/lib/events/messaging-events";

/**
 * LA RÉPONSE TARDIVE, par le vrai registre : Adam a relancé Raihana pour une attente qui s'est
 * ensuite réglée par le temps ; Raihana répond alors qu'aucune étape n'attend plus. La réponse
 * rejoint le journal de la mission (`LATE_REPLY`) et le dirigeant en est informé (INFO, une fois) ;
 * un second envoi du même fait ne double rien ; une mission terminée n'est plus concernée.
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `tard${Date.now().toString(36)}`;
let ownerId = "", raihanaId = "", missionId = "", companyId = "";

suite("réponse tardive après relance — rien ne se perd, rien n'est interprété", () => {
  beforeAll(async () => {
    await assurerCompteAgent();
    const c = await prisma.company.create({ data: { name: `${TAG} Pharma`, shortName: TAG.slice(0, 12) }, select: { id: true } });
    companyId = c.id;
    const owner = await prisma.user.create({ data: { name: `${TAG} PDG`, email: `${TAG}pdg@amd.dz`, passwordHash: "x", role: "SUPER_ADMIN" }, select: { id: true } });
    ownerId = owner.id;
    const r = await prisma.user.create({ data: { name: `Raihana ${TAG}`, email: `${TAG}r@amd.dz`, passwordHash: "x", role: "REGULATORY_ASSISTANT" }, select: { id: true } });
    raihanaId = r.id;
    await prisma.employee.create({ data: { fullName: `Raihana ${TAG}`, email: `${TAG}r@amd.dz`, position: "Assistante", isActive: true, companyId, userId: raihanaId } });
    const m = await prisma.mission.create({ data: { kind: "RUNTIME", status: "RUNNING", title: `${TAG} Débloquer le CPP`, objective: "x", goalRaw: "x", ownerId, planVersion: 1 }, select: { id: true } });
    missionId = m.id;
    // L'attente a existé, s'est réglée par le temps : elle est DONE, plus rien n'attend Raihana.
    await prisma.missionStep.create({ data: { missionId, key: "attente:raihana", title: "Retour de Raihana", nodeType: "WAIT_EVENT", status: "DONE", waitFor: { event: "MESSAGE_RECEIVED", from: `Raihana ${TAG}` }, result: { reveillePar: "TEMPS" } } });
  }, 120_000);
  afterAll(async () => {
    await prisma.message.deleteMany({ where: { conversation: { members: { some: { userId: raihanaId } } } } }).catch(() => {});
    await prisma.conversation.deleteMany({ where: { members: { some: { userId: raihanaId } } } }).catch(() => {});
    await prisma.businessEvent.deleteMany({ where: { actorId: { in: [raihanaId] } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: { in: [ownerId, raihanaId] } } }).catch(() => {});
    await prisma.mission.deleteMany({ where: { ownerId } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { id: { in: [ownerId, raihanaId] } } }).catch(() => {});
    await prisma.company.deleteMany({ where: { id: companyId } }).catch(() => {});
  }, 120_000);

  it("la réponse après relance est journalisée sur la mission et dite au dirigeant, une fois", async () => {
    // 1. Adam a relancé Raihana pour cette attente (barreau 1) — le journal porte NUDGED { destinataire }.
    const r1 = await relancerAttente({
      missionId, ownerId, missionTitle: `${TAG} Débloquer le CPP`, stepKey: "attente:raihana", stepTitle: "Retour de Raihana",
      attente: { event: "MESSAGE_RECEIVED", from: `Raihana ${TAG}`, withinDays: 2 }, depuis: new Date(Date.now() - 5 * 86_400_000),
    }, new Date(Date.now() - 2 * 86_400_000));
    expect(r1.geste).toBe("RELANCE");
    const avant = await prisma.notification.count({ where: { userId: ownerId } });

    // 2. Raihana répond, alors que plus rien ne l'attend — par le VRAI registre.
    await emettreMessageRecu({ conversationId: `${TAG}-conv`, messageId: `${TAG}-m1`, senderId: raihanaId, senderName: `Raihana ${TAG}`, body: "Désolée du retard, le CPP est signé, je l'envoie demain.", recipientIds: [ownerId] });

    const tardives = await prisma.missionEvent.findMany({ where: { missionId, kind: "LATE_REPLY" }, select: { summary: true, detail: true } });
    expect(tardives).toHaveLength(1);
    expect(tardives[0].summary).toMatch(/a répondu après la relance/);
    expect(tardives[0].summary).toMatch(/CPP est signé/);
    expect((tardives[0].detail as { stepKey?: string }).stepKey).toBe("attente:raihana");
    const notifs = await prisma.notification.findMany({ where: { userId: ownerId }, orderBy: { createdAt: "desc" }, select: { title: true, body: true, type: true } });
    expect(notifs.length).toBe(avant + 1);
    expect(notifs[0].title).toMatch(/^Réponse après relance — /);
    expect(notifs[0].body).toMatch(/CPP est signé/);

    // 3. Le MÊME fait rejoué ne double rien.
    await emettreMessageRecu({ conversationId: `${TAG}-conv`, messageId: `${TAG}-m1`, senderId: raihanaId, senderName: `Raihana ${TAG}`, body: "Désolée du retard, le CPP est signé, je l'envoie demain.", recipientIds: [ownerId] });
    expect(await prisma.missionEvent.count({ where: { missionId, kind: "LATE_REPLY" } })).toBe(1);

    // 4. Une mission terminée n'est plus concernée.
    await prisma.mission.update({ where: { id: missionId }, data: { status: "COMPLETED" } });
    await emettreMessageRecu({ conversationId: `${TAG}-conv`, messageId: `${TAG}-m2`, senderId: raihanaId, senderName: `Raihana ${TAG}`, body: "Encore moi.", recipientIds: [ownerId] });
    expect(await prisma.missionEvent.count({ where: { missionId, kind: "LATE_REPLY" } })).toBe(1);
  }, 120_000);
});
