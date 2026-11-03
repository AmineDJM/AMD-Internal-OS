import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { assurerCompteAgent, idCompteAgent } from "@/lib/missions/agent/account";
import { BARREAUX_AVANT_DIRIGEANT, relancerAttente } from "@/platform/in-process/missions/relance";

/**
 * L'ÉCHELLE DE RELANCES, par l'entrée du battement : une attente échue est relancée par Adam
 * lui-même (message interne signé du compte système), une fois par jour, la hiérarchie au
 * troisième barreau, le dirigeant seulement quand l'échelle est épuisée. Rappelée dix fois dans
 * la journée, elle ne fait rien neuf fois. Une personne externe va directement au dirigeant.
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `rel${Date.now().toString(36)}`;
let ownerId = "", raihanaId = "", managerId = "", missionId = "", companyId = "";

suite("échelle de relances — Adam relance, monte d'un cran, puis seulement prévient", () => {
  beforeAll(async () => {
    await assurerCompteAgent();
    const c = await prisma.company.create({ data: { name: `${TAG} Pharma`, shortName: TAG.slice(0, 12) }, select: { id: true } });
    companyId = c.id;
    const owner = await prisma.user.create({ data: { name: `${TAG} PDG`, email: `${TAG}pdg@amd.dz`, passwordHash: "x", role: "SUPER_ADMIN" }, select: { id: true } });
    ownerId = owner.id;
    const mgr = await prisma.user.create({ data: { name: `Amel ${TAG}`, email: `${TAG}mgr@amd.dz`, passwordHash: "x", role: "HEAD_OF_REGULATORY" }, select: { id: true } });
    managerId = mgr.id;
    const r = await prisma.user.create({ data: { name: `Raihana ${TAG}`, email: `${TAG}r@amd.dz`, passwordHash: "x", role: "REGULATORY_ASSISTANT" }, select: { id: true } });
    raihanaId = r.id;
    const eMgr = await prisma.employee.create({ data: { fullName: `Amel ${TAG}`, email: `${TAG}mgr@amd.dz`, position: "Resp.", isActive: true, companyId, userId: managerId }, select: { id: true } });
    await prisma.employee.create({ data: { fullName: `Raihana ${TAG}`, email: `${TAG}r@amd.dz`, position: "Assistante", isActive: true, companyId, userId: raihanaId, managerId: eMgr.id } });
    const m = await prisma.mission.create({ data: { kind: "RUNTIME", status: "WAITING_EVENT", title: `${TAG} Débloquer Pembrolix`, objective: "x", goalRaw: "x", ownerId, planVersion: 1 }, select: { id: true } });
    missionId = m.id;
  }, 120_000);
  afterAll(async () => {
    const agent = await idCompteAgent();
    await prisma.message.deleteMany({ where: { conversation: { members: { some: { userId: { in: [raihanaId, managerId] } } } } } }).catch(() => {});
    await prisma.conversation.deleteMany({ where: { members: { some: { userId: { in: [raihanaId, managerId] } } } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: { in: [ownerId, raihanaId, managerId] } } }).catch(() => {});
    await prisma.mission.deleteMany({ where: { ownerId } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { id: { in: [ownerId, raihanaId, managerId] } } }).catch(() => {});
    await prisma.company.deleteMany({ where: { id: companyId } }).catch(() => {});
    void agent;
  }, 120_000);

  const attente = () => ({
    missionId, ownerId, missionTitle: `${TAG} Débloquer Pembrolix`, stepKey: "attente:raihana", stepTitle: "Retour de Raihana sur le CPP",
    attente: { event: "MESSAGE_RECEIVED", from: `Raihana ${TAG}`, withinDays: 2 }, depuis: new Date(Date.now() - 5 * 86_400_000),
  });
  const messagesVers = (userId: string) => prisma.message.count({ where: { conversation: { members: { some: { userId } } }, senderId: { not: null } } });

  it("barreau 1 : relance interne signée Adam ; le même jour, silence ; barreau 2 le lendemain ; barreau 3 la hiérarchie ; puis le dirigeant", async () => {
    const t0 = new Date();
    const r1 = await relancerAttente(attente(), t0);
    expect(r1.geste).toBe("RELANCE");
    expect(r1.barreau).toBe(1);
    expect(await messagesVers(raihanaId)).toBe(1);
    const agent = await idCompteAgent();
    const msg = await prisma.message.findFirst({ where: { conversation: { members: { some: { userId: raihanaId } } } }, select: { senderId: true, body: true } });
    expect(msg?.senderId).toBe(agent);
    expect(msg?.body).toContain("Retour de Raihana sur le CPP");
    expect(msg?.body).toContain("— Adam");
    // Un fait MESSAGE_RECEIVED a été inscrit pour cette relance (les missions qui attendent Adam s'en servent).
    expect(await prisma.businessEvent.count({ where: { type: "MESSAGE_RECEIVED", actorId: agent ?? "-" } })).toBeGreaterThanOrEqual(1);

    const r1bis = await relancerAttente(attente(), new Date(t0.getTime() + 3 * 3600_000));
    expect(r1bis.geste).toBe("SILENCE");
    expect(await messagesVers(raihanaId)).toBe(1);

    const r2 = await relancerAttente(attente(), new Date(t0.getTime() + 25 * 3600_000));
    expect(r2.geste).toBe("RELANCE");
    expect(r2.barreau).toBe(2);
    expect(await messagesVers(raihanaId)).toBe(2);

    const r3 = await relancerAttente(attente(), new Date(t0.getTime() + 50 * 3600_000));
    expect(r3.geste).toBe("MANAGER");
    expect(r3.barreau).toBe(BARREAUX_AVANT_DIRIGEANT);
    expect(await messagesVers(managerId)).toBe(1);
    expect(await prisma.notification.count({ where: { userId: ownerId } })).toBe(0);

    const r4 = await relancerAttente(attente(), new Date(t0.getTime() + 75 * 3600_000));
    expect(r4.geste).toBe("DIRIGEANT");
    const notif = await prisma.notification.findFirst({ where: { userId: ownerId }, orderBy: { createdAt: "desc" } });
    expect(notif?.title).toMatch(/^Sans réponse — /);
    expect(notif?.body).toContain("3 relance(s)");
    const journal = await prisma.missionEvent.findMany({ where: { missionId, kind: "NUDGED" }, select: { detail: true }, orderBy: { at: "asc" } });
    expect(journal.map((e) => (e.detail as { geste: string }).geste)).toEqual(["RELANCE", "RELANCE", "MANAGER", "DIRIGEANT"]);
  }, 120_000);

  it("une personne externe : aucune relance automatique, le dirigeant décide tout de suite", async () => {
    const autre = await prisma.mission.create({ data: { kind: "RUNTIME", status: "WAITING_EVENT", title: `${TAG} Hetero`, objective: "x", goalRaw: "x", ownerId, planVersion: 1 }, select: { id: true } });
    const r = await relancerAttente({ ...attente(), missionId: autre.id, stepKey: "attente:hetero", attente: { event: "EMAIL_RECEIVED", from: "contact@hetero-labs.example", withinDays: 3 } });
    expect(r.geste).toBe("EXTERNE");
    const notif = await prisma.notification.findFirst({ where: { userId: ownerId }, orderBy: { createdAt: "desc" } });
    expect(notif?.body).toContain("hors de l'entreprise");
  }, 60_000);
});
