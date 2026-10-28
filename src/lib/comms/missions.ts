import { MissionStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { sansBloquer } from "@/lib/journal";

/**
 * LE MOTEUR DE MISSIONS — ce qui fait qu'une demande du PDG SURVIT à la conversation.
 *
 * « Demande à Regulatory ce dont ils ont besoin de Deepak » n'est pas une réponse de chat : c'est
 * une boucle qui dure des jours — DEMANDER → ATTENDRE → COLLECTER → RÉCONCILIER → RELANCER →
 * CONSOLIDER → TRANSMETTRE → ATTENDRE ENCORE → CLORE. Sans état persistant, le PDG doit tout
 * réexpliquer à chaque fois, et « qui n'a pas répondu ? » redevient un travail humain.
 *
 * La mission ne DÉCIDE jamais d'envoyer : elle prépare et signale. Le franchissement de la
 * frontière externe reste soumis à la politique d'envoi (`comms/policy.ts`) — une mission de fond
 * peut atteindre « prêt à envoyer », jamais « envoyé », tant que l'approbation est requise.
 */

export interface MissionParticipantInput {
  userId?: string | null;
  email?: string | null;
  name?: string | null;
}

export interface CreateMissionInput {
  ownerId: string;
  title: string;
  objective: string;
  context?: string | null;
  participants?: MissionParticipantInput[];
  entities?: { type: string; id: string; label: string }[];
  dueAt?: Date | null;
}

export async function createMission(input: CreateMissionInput) {
  const mission = await prisma.mission.create({
    data: {
      ownerId: input.ownerId,
      title: input.title.trim(),
      objective: input.objective.trim(),
      context: input.context ?? null,
      status: MissionStatus.DRAFT,
      entities: (input.entities ?? []) as never,
      dueAt: input.dueAt ?? null,
      participants: {
        create: (input.participants ?? []).map((p) => ({
          userId: p.userId ?? null,
          email: p.email ? p.email.toLowerCase() : null,
          name: p.name ?? null,
          state: "ASKED",
        })),
      },
    },
    include: { participants: true },
  });
  await recordMissionEvent(mission.id, "CREATED", `Mission créée : ${mission.title}`, { objective: mission.objective });
  return mission;
}

export async function recordMissionEvent(
  missionId: string,
  kind: string,
  summary: string,
  detail?: Record<string, unknown>,
  actorId?: string,
): Promise<void> {
  await prisma.missionEvent.create({
    data: { missionId, kind, summary: summary.slice(0, 2000), detail: (detail ?? null) as never, actorId: actorId ?? null },
  });
  await prisma.mission.update({ where: { id: missionId }, data: { updatedAt: new Date() } }).catch(sansBloquer("missions.recordMissionEvent.mission"));
}

/** La mission passe en attente : les demandes sont parties, on écoute. */
export async function markMissionAsked(missionId: string, participantIds?: string[]): Promise<void> {
  const at = new Date();
  await prisma.missionParticipant.updateMany({
    where: { missionId, ...(participantIds?.length ? { id: { in: participantIds } } : {}), askedAt: null },
    data: { askedAt: at, state: "ASKED" },
  });
  await prisma.mission.update({ where: { id: missionId }, data: { status: MissionStatus.WAITING } });
  await recordMissionEvent(missionId, "MAIL_SENT", "Demande envoyée — en attente des réponses.");
}

/**
 * UNE RÉPONSE EST ARRIVÉE.
 *
 * Le rapprochement se fait sur l'ADRESSE (le seul identifiant qu'un courriel porte à coup sûr) et,
 * à défaut, sur le compte ERP. Une personne qui répond depuis une autre adresse ne sera pas
 * reconnue : c'est assumé — mieux vaut dire « je ne l'ai pas vue » que compter une réponse qui
 * n'est peut-être pas la sienne.
 */
export async function recordMissionReply(opts: {
  missionId: string;
  fromAddress: string;
  senderUserId?: string | null;
  note?: string | null;
  emailRecordId?: string | null;
}): Promise<{ matched: boolean }> {
  const address = opts.fromAddress.toLowerCase();
  const participant = await prisma.missionParticipant.findFirst({
    where: {
      missionId: opts.missionId,
      OR: [{ email: address }, ...(opts.senderUserId ? [{ userId: opts.senderUserId }] : [])],
    },
  });
  if (!participant) {
    await recordMissionEvent(opts.missionId, "REPLY_RECEIVED", `Réponse reçue de ${address} (hors liste des personnes sollicitées).`, {
      fromAddress: address, emailRecordId: opts.emailRecordId ?? null,
    });
    return { matched: false };
  }
  await prisma.missionParticipant.update({
    where: { id: participant.id },
    data: { state: "RESPONDED", respondedAt: new Date(), responseNote: opts.note?.slice(0, 2000) ?? participant.responseNote },
  });
  await recordMissionEvent(opts.missionId, "REPLY_RECEIVED", `${participant.name ?? address} a répondu.`, {
    participantId: participant.id, emailRecordId: opts.emailRecordId ?? null,
  });
  await recomputeMissionStatus(opts.missionId);
  return { matched: true };
}

/**
 * RECALCULE l'état d'après les participants — jamais d'après ce qu'on croyait.
 *
 * `PARTIAL` existe précisément pour la question « alors ? » : c'est l'état où l'on peut déjà
 * transmettre ce qu'on a tout en sachant qui manque.
 */
export async function recomputeMissionStatus(missionId: string): Promise<MissionStatus> {
  const mission = await prisma.mission.findUnique({
    where: { id: missionId },
    include: { participants: true },
  });
  if (!mission) return MissionStatus.CANCELLED;
  if (mission.status === MissionStatus.COMPLETED || mission.status === MissionStatus.CANCELLED) return mission.status;

  const total = mission.participants.length;
  const responded = mission.participants.filter((p) => p.state === "RESPONDED").length;
  let next: MissionStatus = mission.status;
  if (total === 0) next = mission.status === MissionStatus.DRAFT ? MissionStatus.DRAFT : MissionStatus.ACTIVE;
  else if (responded === 0) next = MissionStatus.WAITING;
  else if (responded < total) next = MissionStatus.PARTIAL;
  else next = MissionStatus.NEEDS_CEO; // tout le monde a répondu : au PDG de dire ce qu'on en fait

  if (next !== mission.status) {
    await prisma.mission.update({ where: { id: missionId }, data: { status: next } });
    await recordMissionEvent(missionId, "STATE_CHANGED", `État : ${mission.status} → ${next}.`, { from: mission.status, to: next });
  }
  return next;
}

export async function setMissionStatus(missionId: string, status: MissionStatus, actorId?: string, note?: string): Promise<void> {
  const cur = await prisma.mission.findUnique({ where: { id: missionId }, select: { status: true } });
  if (!cur) return;
  await prisma.mission.update({
    where: { id: missionId },
    data: { status, ...(status === MissionStatus.COMPLETED || status === MissionStatus.CANCELLED ? { closedAt: new Date() } : {}) },
  });
  await recordMissionEvent(missionId, "STATE_CHANGED", note ?? `État : ${cur.status} → ${status}.`, { from: cur.status, to: status }, actorId);
}

/** Consolide les demandes extraites des réponses — la matière du message à transmettre. */
export async function setMissionExtracted(missionId: string, items: { from: string; request: string }[]): Promise<void> {
  await prisma.mission.update({ where: { id: missionId }, data: { extracted: items as never } });
  await recordMissionEvent(missionId, "CONSOLIDATED", `${items.length} demande(s) consolidée(s).`);
}

export interface MissionSnapshot {
  id: string;
  title: string;
  objective: string;
  status: MissionStatus;
  responded: { name: string; note: string | null }[];
  missing: { name: string; askedAt: Date | null; nudgedAt: Date | null }[];
  extracted: { from: string; request: string }[];
  lastEventAt: Date | null;
  nextAction: string | null;
}

/** L'état d'une mission, prêt à être RACONTÉ — c'est la réponse à « alors ? ». */
export async function missionSnapshot(missionId: string): Promise<MissionSnapshot | null> {
  const m = await prisma.mission.findUnique({
    where: { id: missionId },
    include: { participants: true, events: { orderBy: { at: "desc" }, take: 1 } },
  });
  if (!m) return null;
  const label = (p: { name: string | null; email: string | null }) => p.name ?? p.email ?? "—";
  return {
    id: m.id,
    title: m.title,
    objective: m.objective,
    status: m.status,
    responded: m.participants.filter((p) => p.state === "RESPONDED").map((p) => ({ name: label(p), note: p.responseNote })),
    missing: m.participants.filter((p) => p.state !== "RESPONDED").map((p) => ({ name: label(p), askedAt: p.askedAt, nudgedAt: p.nudgedAt })),
    extracted: (m.extracted as unknown as { from: string; request: string }[]) ?? [],
    lastEventAt: m.events[0]?.at ?? null,
    nextAction: m.nextAction,
  };
}

/** Les missions VIVANTES du PDG — ce que « qu'est-ce que j'attends ? » doit rendre. */
export async function activeMissions(ownerId: string, limit = 20) {
  return prisma.mission.findMany({
    where: { ownerId, status: { notIn: [MissionStatus.COMPLETED, MissionStatus.CANCELLED] } },
    orderBy: { updatedAt: "desc" },
    take: limit,
    include: { participants: true },
  });
}

/**
 * QUI FAUT-IL RELANCER ?
 *
 * Une personne sollicitée il y a plus de `afterHours`, qui n'a pas répondu et qu'on n'a pas déjà
 * relancée récemment. La règle est volontairement conservatrice : relancer trop tôt, ou deux fois,
 * abîme la relation que le PDG entretient avec ses équipes — c'est SON nom sur le message.
 */
export async function nudgeCandidates(ownerId: string, afterHours = 48, now = new Date()) {
  const threshold = new Date(now.getTime() - afterHours * 3_600_000);
  const missions = await prisma.mission.findMany({
    where: { ownerId, status: { in: [MissionStatus.WAITING, MissionStatus.PARTIAL] } },
    include: { participants: true },
  });
  const out: { missionId: string; missionTitle: string; participantId: string; name: string; email: string | null }[] = [];
  for (const m of missions) {
    for (const p of m.participants) {
      if (p.state === "RESPONDED") continue;
      if (!p.askedAt || p.askedAt > threshold) continue;
      if (p.nudgedAt && p.nudgedAt > threshold) continue;
      out.push({
        missionId: m.id,
        missionTitle: m.title,
        participantId: p.id,
        name: p.name ?? p.email ?? "—",
        email: p.email,
      });
    }
  }
  return out;
}

export async function markParticipantNudged(participantId: string): Promise<void> {
  await prisma.missionParticipant.update({
    where: { id: participantId },
    data: { nudgedAt: new Date(), state: "NUDGED" },
  });
}

/**
 * Retrouve la mission concernée par un message entrant.
 *
 * Deux chemins, du plus sûr au plus faible : le FIL de discussion (identifiant Gmail — sans
 * ambiguïté), puis l'adresse de l'expéditeur parmi les personnes sollicitées d'une mission en
 * attente. On ne devine jamais par le sujet : deux missions peuvent parler du même dossier.
 */
export async function findMissionForInbound(opts: {
  ownerId: string;
  threadId: string | null;
  fromAddress: string;
  senderUserId?: string | null;
}): Promise<{ missionId: string; via: "thread" | "participant" } | null> {
  if (opts.threadId) {
    const byThread = await prisma.outboundMailIntent.findFirst({
      where: { userId: opts.ownerId, providerThreadId: opts.threadId, missionId: { not: null } },
      select: { missionId: true },
      orderBy: { createdAt: "desc" },
    });
    if (byThread?.missionId) return { missionId: byThread.missionId, via: "thread" };
  }
  const address = opts.fromAddress.toLowerCase();
  const participant = await prisma.missionParticipant.findFirst({
    where: {
      OR: [{ email: address }, ...(opts.senderUserId ? [{ userId: opts.senderUserId }] : [])],
      mission: { ownerId: opts.ownerId, status: { in: [MissionStatus.WAITING, MissionStatus.PARTIAL, MissionStatus.ACTIVE] } },
    },
    select: { missionId: true },
    orderBy: { createdAt: "desc" },
  });
  return participant ? { missionId: participant.missionId, via: "participant" } : null;
}

/**
 * LES LIBELLÉS DES DEUX FAMILLES DE MISSIONS.
 *
 * Les neuf premiers décrivent une mission de COORDINATION : Adam poursuit des humains et
 * attend leurs réponses. Les suivants décrivent une mission d'EXÉCUTION, qui fait tourner un
 * graphe d'étapes. La table est unique parce que l'enum l'est — mais les mots, eux, disent
 * bien deux choses différentes : « en attente de réponses » et « en attente d'un événement »
 * ne se vivent pas pareil pour celui qui lit l'écran.
 */
export const MISSION_STATUS_LABEL: Record<MissionStatus, string> = {
  DRAFT: "brouillon",
  ACTIVE: "en cours",
  WAITING: "en attente de réponses",
  PARTIAL: "réponses partielles",
  BLOCKED: "bloquée",
  NEEDS_CEO: "attend votre décision",
  READY_TO_SEND: "prête à envoyer",
  COMPLETED: "terminée",
  CANCELLED: "annulée",
  PLANNING: "en cours de planification",
  READY: "prête à démarrer",
  AWAITING_APPROVAL: "attend votre accord",
  RUNNING: "en exécution",
  WAITING_EVENT: "en attente d'un événement",
  WAITING_INPUT: "attend un élément de votre part",
  WAITING_DEPENDENCY: "attend qu'une étape amont se termine",
  RETRYING: "nouvelle tentative en cours",
  FAILED: "en échec",
  // « SUSPENDUE » et non « en pause » : le mot dit qui a décidé. Une mission suspendue l'a été
  // par quelqu'un, et ce qu'on veut lire sur l'écran c'est « elle attend qu'on la relance »,
  // pas « elle se repose ».
  PAUSED: "suspendue",
};
