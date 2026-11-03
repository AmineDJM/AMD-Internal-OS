import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MailSendPolicy, MissionStatus, OutboundMailStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import {
  createMission, markMissionAsked, recordMissionReply, recomputeMissionStatus,
  missionSnapshot, activeMissions, nudgeCandidates, setMissionExtracted,
} from "./missions";
import { createOutboundIntent, approveOutboundIntent, sendOutboundIntent, pendingApprovals, type MailTransport } from "./outbound";
import { setMailSendPolicy } from "./policy";

/**
 * UNE JOURNÉE DE PDG, DU DÉBUT À LA FIN.
 *
 * Les tests unitaires prouvent que chaque pièce marche. Celui-ci prouve qu'elles marchent
 * ENSEMBLE, et surtout QUE L'ÉTAT SURVIT : une mission qui disparaît au redémarrage n'est pas
 * une mission, c'est une conversation. Tout ce qui est vérifié ici est relu DEPUIS LA BASE,
 * jamais depuis une variable gardée en mémoire — c'est la seule façon de simuler honnêtement
 * un serveur qui redémarre entre deux moments de la journée.
 *
 * Le scénario est celui que le PDG a décrit : demander à Regulatory ce qu'il faut de Deepak,
 * attendre, constater qui manque, relancer, consolider, transmettre — chaque envoi passant par
 * son accord.
 *
 * CE QUI N'EST PAS COUVERT ICI, et pourquoi : l'aller-retour réel avec Google (OAuth, Gmail,
 * Pub/Sub) exige des identifiants de production. Le transport est donc un espion, et la partie
 * Google se vérifie par `npm run adam:doctor` une fois les secrets posés. Le reste — missions,
 * frontière d'envoi, persistance — est ici exercé pour de vrai, sur une vraie base.
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__day__${Date.now()}`;

const sentMessages: { subject: string; to: string[] }[] = [];
const transport: MailTransport = {
  async send(msg) {
    sentMessages.push({ subject: msg.subject, to: msg.recipients });
    return { providerMessageId: `gmail-${sentMessages.length}`, providerThreadId: "thread-1" };
  },
};

suite("une journée de PDG — de la demande à la consolidation, et l'état qui survit", () => {
  let ceoId = "";
  let connectionId = "";
  let amelId = "";
  let raihanaId = "";
  let missionId = "";

  beforeAll(async () => {
    const [ceo, amel, raihana] = await Promise.all([
      prisma.user.create({ data: { name: `${TAG} Amine`, email: `${TAG}ceo@t.dz`, passwordHash: "x", role: "SUPER_ADMIN" } }),
      prisma.user.create({ data: { name: `${TAG} Amel`, email: `${TAG}amel@t.dz`, passwordHash: "x", role: "REGULATORY_ASSISTANT" } }),
      prisma.user.create({ data: { name: `${TAG} Raihana`, email: `${TAG}raihana@t.dz`, passwordHash: "x", role: "REGULATORY_ASSISTANT" } }),
    ]);
    ceoId = ceo.id; amelId = amel.id; raihanaId = raihana.id;

    const c = await prisma.googleConnection.create({
      data: { userId: ceo.id, address: `${TAG}@gmail.com`, accessTokenEnc: "x", grantedScopes: "", status: "connected" },
    });
    connectionId = c.id;
    await setMailSendPolicy(MailSendPolicy.REQUIRE_APPROVAL, ceoId);
  });

  afterAll(async () => {
    await prisma.outboundMailIntent.deleteMany({ where: { connectionId } }).catch(() => {});
    await prisma.missionEvent.deleteMany({ where: { mission: { ownerId: ceoId } } }).catch(() => {});
    await prisma.missionParticipant.deleteMany({ where: { mission: { ownerId: ceoId } } }).catch(() => {});
    await prisma.mission.deleteMany({ where: { ownerId: ceoId } }).catch(() => {});
    await prisma.googleConnection.deleteMany({ where: { userId: ceoId } }).catch(() => {});
    await prisma.communicationPolicy.deleteMany({ where: { updatedById: ceoId } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("MATIN — « demande à Regulatory ce qu'il leur faut de Deepak » : une mission naît, rien n'est envoyé", async () => {
    const mission = await createMission({
      ownerId: ceoId,
      title: "Besoins Regulatory auprès de Deepak",
      objective: "Recenser ce que l'équipe Regulatory attend de Deepak",
      participants: [
        { userId: amelId, email: `${TAG}amel@t.dz`, name: "Amel" },
        { userId: raihanaId, email: `${TAG}raihana@t.dz`, name: "Raihana" },
      ],
    });
    missionId = mission.id;

    const intent = await createOutboundIntent({
      connectionId, userId: ceoId,
      recipients: [`${TAG}amel@t.dz`, `${TAG}raihana@t.dz`],
      subject: `${TAG} Vos besoins auprès de Deepak`,
      bodyText: "Bonjour, que vous faut-il de Deepak pour avancer ?",
      missionId: mission.id,
      generatedBy: "chief",
    });

    // La mission existe, le message est PRÊT — et il n'est pas parti.
    expect(intent.status).toBe(OutboundMailStatus.AWAITING_APPROVAL);
    expect(sentMessages).toHaveLength(0);

    const waiting = await pendingApprovals(ceoId);
    expect(waiting.map((w) => w.id)).toContain(intent.id);
  });

  it("« Envoie. » — un seul message part, la mission passe en attente", async () => {
    const waiting = await pendingApprovals(ceoId);
    const intent = waiting.find((w) => w.missionId === missionId)!;
    expect(intent).toBeTruthy();

    await approveOutboundIntent(intent.id, ceoId);
    const r = await sendOutboundIntent(intent.id, transport);
    expect(r.ok).toBe(true);
    expect(sentMessages).toHaveLength(1);

    await markMissionAsked(missionId);
    const status = await recomputeMissionStatus(missionId);
    expect([MissionStatus.WAITING, MissionStatus.ACTIVE]).toContain(status);
  });

  it("PENDANT LA JOURNÉE — une réponse arrive : Adam la range SANS qu'on lui demande", async () => {
    await recordMissionReply({
      missionId,
      fromAddress: `${TAG}amel@t.dz`,
      senderUserId: amelId,
      note: "Il nous faut les données de stabilité 24 mois et le certificat GMP.",
    });

    // Relu DEPUIS LA BASE, par l'API que le Chief consomme vraiment pour répondre « alors ? ».
    const snap = await missionSnapshot(missionId);
    expect(snap).toBeTruthy();
    expect(snap!.responded.map((r) => r.name)).toContain("Amel");
    expect(snap!.responded[0].note).toMatch(/stabilité/);
    // Partiel : une réponse sur deux.
    expect(snap!.status).toBe(MissionStatus.PARTIAL);
  });

  it("« Alors ? » — Adam sait qui a répondu et qui manque, sans rien recalculer à l'aveugle", async () => {
    const snap = await missionSnapshot(missionId);
    expect(snap!.responded).toHaveLength(1);
    expect(snap!.missing).toHaveLength(1);
    expect(snap!.missing[0].name).toMatch(/Raihana|raihana/);
    // Et la personne manquante a bien été SOLLICITÉE : sans cela, « il manque X » serait injuste.
    expect(snap!.missing[0].askedAt).toBeTruthy();
  });

  it("« Relance celle qui manque. » — la relance est PRÉPARÉE, jamais envoyée d'office", async () => {
    const before = sentMessages.length;

    // Exactement ce que produirait le battement de fond, sans personne devant l'écran.
    const followUp = await createOutboundIntent({
      connectionId, userId: ceoId,
      recipients: [`${TAG}raihana@t.dz`],
      subject: `${TAG} Relance — vos besoins auprès de Deepak`,
      bodyText: "Bonjour Raihana, un rappel au sujet de ma question précédente.",
      missionId,
      generatedBy: "mission",
      reason: "relance : réponse attendue non reçue",
    });

    expect(followUp.status).toBe(OutboundMailStatus.AWAITING_APPROVAL);
    const blocked = await sendOutboundIntent(followUp.id, transport);
    expect(blocked.ok).toBe(false);
    expect(sentMessages).toHaveLength(before); // rien n'a bougé

    // Le PDG approuve : là, et là seulement, ça part.
    await approveOutboundIntent(followUp.id, ceoId);
    const ok = await sendOutboundIntent(followUp.id, transport);
    expect(ok.ok).toBe(true);
    expect(sentMessages).toHaveLength(before + 1);
  });

  it("la seconde réponse arrive — la mission se complète toute seule", async () => {
    await recordMissionReply({
      missionId,
      fromAddress: `${TAG}raihana@t.dz`,
      senderUserId: raihanaId,
      note: "De mon côté : le rapport de validation du procédé.",
    });
    const snap = await missionSnapshot(missionId);
    expect(snap!.missing).toHaveLength(0);
    expect(snap!.responded).toHaveLength(2);
  });

  it("« Transmets le consolidé à Deepak. » — le consolidé se construit sur les VRAIES réponses", async () => {
    await setMissionExtracted(missionId, [
      { from: "Amel", request: "Données de stabilité 24 mois + certificat GMP" },
      { from: "Raihana", request: "Rapport de validation du procédé" },
    ]);

    const snap = await missionSnapshot(missionId);
    expect(snap!.extracted).toHaveLength(2);

    const before = sentMessages.length;
    const consolidated = await createOutboundIntent({
      connectionId, userId: ceoId,
      recipients: ["deepak@fournisseur.example"],
      subject: `${TAG} Besoins consolidés de l'équipe Regulatory`,
      bodyText: snap!.extracted.map((e) => `- ${e.from} : ${e.request}`).join("\n"),
      missionId,
      generatedBy: "chief",
    });

    expect(consolidated.status).toBe(OutboundMailStatus.AWAITING_APPROVAL);
    await approveOutboundIntent(consolidated.id, ceoId);
    await sendOutboundIntent(consolidated.id, transport);

    expect(sentMessages).toHaveLength(before + 1);
    expect(sentMessages.at(-1)!.to).toEqual(["deepak@fournisseur.example"]);
  });

  it("REDÉMARRAGE — tout l'état de la journée est en base, rien n'était en mémoire", async () => {
    // On ne réutilise AUCUNE variable du test : on interroge comme le ferait un processus neuf.
    const missions = await activeMissions(ceoId);
    const found = missions.find((m) => m.id === missionId);
    expect(found, "la mission n'a pas survécu").toBeTruthy();

    const snap = await missionSnapshot(missionId);
    expect(snap!.responded).toHaveLength(2);
    expect(snap!.extracted).toHaveLength(2);

    // Les trois envois de la journée sont tracés, avec leur reçu fournisseur.
    const sentRows = await prisma.outboundMailIntent.findMany({
      where: { connectionId, status: OutboundMailStatus.SENT },
      orderBy: { sentAt: "asc" },
    });
    expect(sentRows).toHaveLength(3);
    for (const row of sentRows) {
      expect(row.providerMessageId, "un envoi sans reçu fournisseur").toBeTruthy();
      expect(row.approvedById, "un envoi sans approbateur humain").toBeTruthy();
    }
  });

  it("BILAN DE LA JOURNÉE — trois messages, trois accords, aucun envoi non approuvé", async () => {
    const total = await prisma.outboundMailIntent.count({ where: { connectionId } });
    const sent = await prisma.outboundMailIntent.count({ where: { connectionId, status: OutboundMailStatus.SENT } });

    expect(total).toBe(3);
    expect(sent).toBe(3);
    expect(sentMessages).toHaveLength(3);

    // L'invariant de toute la journée, vérifié une dernière fois de bout en bout.
    const sansAccord = await prisma.outboundMailIntent.count({
      where: { connectionId, status: OutboundMailStatus.SENT, approvedById: null },
    });
    expect(sansAccord).toBe(0);
  });

  it("la détection des relances ne réveille personne à tort — elle attend un vrai délai", async () => {
    // Une mission close ne doit plus produire de candidats à la relance.
    const candidates = await nudgeCandidates(ceoId, 48, new Date());
    const forThisMission = candidates.filter((c) => c.missionId === missionId);
    expect(forThisMission).toHaveLength(0);
  });
});
