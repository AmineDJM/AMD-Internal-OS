"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { genSlug, genPublicToken, canManageMeeting, canViewMeeting, appBaseUrlForMeet, roomUrl } from "@/lib/meetings";
import { summarizeMeetingTranscript, cleModeleRequise } from "@/lib/ai";
import { phraseIaNonConfiguree } from "@/lib/ia/cle-manquante";
import { notifyUser } from "@/lib/notify";
import { putBlob, releaseBlob } from "@/lib/drive-storage";
import { recordAudit } from "@/lib/audit";
import { algiersInputToUtc } from "@/lib/calendar-tz";
import { fdStr, fdBool, fdDate, type ActionResult } from "@/lib/actions/types";
import type { CalendarInviteStatus } from "@prisma/client";
import { lienTache } from "@/lib/chemins/espace";
import { sansBloquer } from "@/lib/journal";
import { inscrirePiece } from "@/modules/bibliotheque/api-inscription";

const DENIED: ActionResult = { ok: false, error: "Non autorisé." };
const MAX_MSG_ATTACHMENT = 25 * 1024 * 1024; // 25 Mo par pièce jointe du fil de réunion

/** Normalise un lien de réunion (ajoute https:// si absent ; null si vide/invalide). */
function normalizeLink(raw: string | null): string | null {
  if (!raw) return null;
  let url = raw.trim();
  if (!url) return null;
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  try { new URL(url); return url.slice(0, 500); } catch { return null; }
}

/** Définit / met à jour le lien de réunion (organisateur). */
export async function setMeetingLink(formData: FormData): Promise<ActionResult> {
  const res = await loadManaged(fdStr(formData, "id") ?? "");
  if ("error" in res) return { ok: false, error: res.error };
  const meetLink = normalizeLink(fdStr(formData, "meetLink"));
  await prisma.meeting.update({ where: { id: res.meeting.id }, data: { meetLink } });
  revalidatePath(`/meetings/${res.meeting.id}`);
  return { ok: true };
}

/** Charge une réunion + ses participants et vérifie le droit de gestion (organisateur/vue globale). */
async function loadManaged(id: string) {
  const user = await requireUser();
  const meeting = await prisma.meeting.findUnique({
    where: { id },
    include: { participants: { select: { userId: true } } },
  });
  if (!meeting) return { error: "Réunion introuvable." as const };
  if (!canManageMeeting(user, meeting)) return { error: "Action réservée à l'organisateur." as const };
  return { user, meeting };
}

/** Crée une réunion planifiée et invite des participants. */
export async function createMeeting(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, "MESSAGING", "CREATE")) return DENIED;
  const title = fdStr(formData, "title");
  if (!title) return { ok: false, error: "Titre de la réunion requis." };
  const description = fdStr(formData, "description");
  // Saisie « datetime-local » interprétée à l'heure d'ALGER (le serveur est en UTC :
  // sans cela, une réunion créée à 10 h s'affichait à 11 h).
  const scheduledAtRaw = fdStr(formData, "scheduledAt");
  const scheduledAt = scheduledAtRaw ? algiersInputToUtc(scheduledAtRaw) ?? fdDate(formData, "scheduledAt") : null;
  const withVideo = formData.get("withVideo") === null ? true : fdBool(formData, "withVideo");
  // Présentiel : réunion physique → pas de lien en ligne, un lieu à la place.
  const inPerson = fdBool(formData, "inPerson");
  const location = fdStr(formData, "location");
  const meetLink = inPerson ? null : normalizeLink(fdStr(formData, "meetLink"));
  const participantIds = [...new Set(formData.getAll("participantIds").map(String).filter(Boolean))].filter((id) => id !== user.id);

  const valid = participantIds.length
    ? (await prisma.user.findMany({ where: { id: { in: participantIds }, isActive: true }, select: { id: true } })).map((u) => u.id)
    : [];

  const meeting = await prisma.meeting.create({
    data: {
      title, description: description ?? null, slug: genSlug(), publicToken: genPublicToken(),
      kind: "MEETING", status: "SCHEDULED", withVideo, inPerson, location: inPerson ? location ?? null : null, scheduledAt, meetLink,
      organizerId: user.id,
      participants: { create: valid.map((userId) => ({ userId })) },
    },
    select: { id: true },
  });

  await Promise.all(valid.map((userId) =>
    notifyUser({ userId, type: "GENERIC", title: "Invitation à une réunion", body: title, link: `/meetings/${meeting.id}` }),
  ));
  await recordAudit({ actorId: user.id, action: "CREATE", module: "Réunions", entityId: meeting.id, summary: `Réunion « ${title} » créée` });
  revalidatePath("/meetings");
  return { ok: true, id: meeting.id };
}

/** Modifie les informations et l'horaire d'une réunion (organisateur / vue globale). */
export async function updateMeeting(formData: FormData): Promise<ActionResult> {
  const res = await loadManaged(fdStr(formData, "id") ?? "");
  if ("error" in res) return { ok: false, error: res.error };
  const title = fdStr(formData, "title");
  if (!title) return { ok: false, error: "Titre de la réunion requis." };
  const description = fdStr(formData, "description");
  // Saisie « datetime-local » interprétée à l'heure d'ALGER (serveur en UTC).
  const scheduledAtRaw = fdStr(formData, "scheduledAt");
  const scheduledAt = scheduledAtRaw ? algiersInputToUtc(scheduledAtRaw) ?? fdDate(formData, "scheduledAt") : null;
  const withVideo = formData.get("withVideo") === null ? res.meeting.withVideo : fdBool(formData, "withVideo");
  const inPerson = formData.get("inPerson") === null ? res.meeting.inPerson : fdBool(formData, "inPerson");
  const location = formData.get("location") === null ? res.meeting.location : fdStr(formData, "location");
  const meetLink = inPerson ? null : normalizeLink(fdStr(formData, "meetLink"));
  // Si l'horaire change, on ré-arme le rappel « 30 min avant » (sinon il ne repartirait pas).
  const changedSchedule = (scheduledAt?.getTime() ?? null) !== (res.meeting.scheduledAt?.getTime() ?? null);

  await prisma.meeting.update({
    where: { id: res.meeting.id },
    data: { title, description: description ?? null, scheduledAt, withVideo, inPerson, location: inPerson ? location ?? null : null, meetLink, ...(changedSchedule ? { reminderSentAt: null } : {}) },
  });
  await recordAudit({ actorId: res.user.id, action: "UPDATE", module: "Réunions", entityId: res.meeting.id, summary: `Réunion « ${title} » modifiée` });
  revalidatePath(`/meetings/${res.meeting.id}`);
  revalidatePath("/meetings");
  return { ok: true };
}

/**
 * Réponse d'un INVITÉ à une réunion — accepter / refuser / peut-être (façon agenda).
 * Chacun ne répond que pour lui-même ; l'organisateur est notifié de la réponse.
 */
export async function respondToMeetingInvite(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const meetingId = fdStr(formData, "id");
  const response = fdStr(formData, "response");
  if (!meetingId || !response || !["ACCEPTED", "DECLINED", "TENTATIVE"].includes(response)) {
    return { ok: false, error: "Réponse invalide." };
  }
  const part = await prisma.meetingParticipant.findUnique({
    where: { meetingId_userId: { meetingId, userId: user.id } },
    select: { id: true, meeting: { select: { title: true, organizerId: true } } },
  });
  if (!part) return { ok: false, error: "Vous n'êtes pas invité à cette réunion." };
  await prisma.meetingParticipant.update({ where: { id: part.id }, data: { response: response as CalendarInviteStatus } });
  const verb = response === "ACCEPTED" ? "a accepté" : response === "DECLINED" ? "a décliné" : "est peut-être disponible pour";
  await notifyUser({
    userId: part.meeting.organizerId, type: "GENERIC",
    title: "Réponse à une invitation", body: `${user.name} ${verb} « ${part.meeting.title} »`, link: `/meetings/${meetingId}`,
  }).catch(sansBloquer("meeting-actions.respondToMeetingInvite.notifyUser"));
  revalidatePath(`/meetings/${meetingId}`);
  return { ok: true };
}

/** Marque la réunion « en cours » (au moment où l'organisateur la démarre). */
export async function setMeetingLive(formData: FormData): Promise<ActionResult> {
  const res = await loadManaged(fdStr(formData, "id") ?? "");
  if ("error" in res) return { ok: false, error: res.error };
  if (res.meeting.status === "ENDED") return { ok: false, error: "Réunion terminée." };
  if (res.meeting.status !== "LIVE") {
    await prisma.meeting.update({ where: { id: res.meeting.id }, data: { status: "LIVE", startedAt: res.meeting.startedAt ?? new Date() } });
  }
  revalidatePath(`/meetings/${res.meeting.id}`);
  return { ok: true };
}

/** Clôt la réunion. */
export async function endMeeting(formData: FormData): Promise<ActionResult> {
  const res = await loadManaged(fdStr(formData, "id") ?? "");
  if ("error" in res) return { ok: false, error: res.error };
  await prisma.meeting.update({ where: { id: res.meeting.id }, data: { status: "ENDED", endedAt: new Date() } });
  await recordAudit({ actorId: res.user.id, action: "UPDATE", module: "Réunions", entityId: res.meeting.id, summary: "Réunion clôturée" });
  revalidatePath(`/meetings/${res.meeting.id}`);
  revalidatePath("/meetings");
  return { ok: true };
}

/**
 * Lance un APPEL depuis une conversation : crée une réunion instantanée avec les membres
 * de la conversation et poste le lien de la salle dans le fil. Renvoie l'id de la réunion.
 */
export async function startCall(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, "MESSAGING", "CREATE")) return DENIED;
  const conversationId = fdStr(formData, "conversationId");
  if (!conversationId) return { ok: false, error: "Conversation introuvable." };
  const withVideo = formData.get("withVideo") === null ? true : fdBool(formData, "withVideo");

  // L'appelant doit être membre de la conversation.
  const me = await prisma.conversationMember.findFirst({ where: { conversationId, userId: user.id, leftAt: null }, select: { id: true } });
  if (!me) return DENIED;
  const members = await prisma.conversationMember.findMany({ where: { conversationId, leftAt: null }, select: { userId: true } });
  const others = members.map((m) => m.userId).filter((id) => id !== user.id);

  const slug = genSlug();
  const meeting = await prisma.meeting.create({
    data: {
      title: withVideo ? "Appel vidéo" : "Appel audio", slug, publicToken: genPublicToken(),
      kind: "CALL", status: "LIVE", withVideo, startedAt: new Date(), conversationId,
      // Les appels gardent Jitsi sous le capot, présenté comme un simple lien « Rejoindre ».
      meetLink: roomUrl(slug, { video: withVideo }),
      organizerId: user.id,
      participants: { create: others.map((userId) => ({ userId })) },
    },
    select: { id: true },
  });

  // Message dans le fil avec le lien interne de la salle.
  const base = appBaseUrlForMeet();
  const link = `${base}/meetings/${meeting.id}`;
  const icon = withVideo ? "📹" : "📞";
  const msg = await prisma.message.create({
    data: {
      conversationId, senderId: user.id, kind: "SYSTEM",
      body: `${icon} ${user.name} a démarré un ${withVideo ? "appel vidéo" : "appel audio"}. Rejoindre : ${link}`,
    },
    select: { createdAt: true },
  });
  await prisma.conversation.update({ where: { id: conversationId }, data: { lastMessageAt: msg.createdAt } });
  await prisma.conversationMember.updateMany({ where: { conversationId, userId: user.id }, data: { lastReadAt: msg.createdAt } });

  // Appel entrant : push qui reste affiché + vibre (façon sonnerie), un tag par appel.
  await Promise.all(others.map((userId) =>
    notifyUser({
      userId, type: "GENERIC",
      title: `${icon} Appel ${withVideo ? "vidéo" : "audio"} entrant`,
      body: `${user.name} vous appelle`,
      link: `/meetings/${meeting.id}`,
      push: { tag: `call-${meeting.id}`, requireInteraction: true },
    }),
  ));
  await recordAudit({ actorId: user.id, action: "CREATE", module: "Réunions", entityId: meeting.id, summary: `Appel ${withVideo ? "vidéo" : "audio"} lancé` });
  revalidatePath("/messages");
  return { ok: true, id: meeting.id };
}

/** Ajoute des participants à une réunion. */
export async function addMeetingParticipants(formData: FormData): Promise<ActionResult> {
  const res = await loadManaged(fdStr(formData, "id") ?? "");
  if ("error" in res) return { ok: false, error: res.error };
  const ids = [...new Set(formData.getAll("participantIds").map(String).filter(Boolean))].filter((id) => id !== res.meeting.organizerId);
  if (ids.length === 0) return { ok: false, error: "Aucun participant à ajouter." };
  const valid = (await prisma.user.findMany({ where: { id: { in: ids }, isActive: true }, select: { id: true } })).map((u) => u.id);
  await prisma.meetingParticipant.createMany({ data: valid.map((userId) => ({ meetingId: res.meeting.id, userId })), skipDuplicates: true });
  await Promise.all(valid.map((userId) =>
    notifyUser({ userId, type: "GENERIC", title: "Invitation à une réunion", body: res.meeting.title, link: `/meetings/${res.meeting.id}` }),
  ));
  revalidatePath(`/meetings/${res.meeting.id}`);
  return { ok: true };
}

/** Retire un participant. */
export async function removeMeetingParticipant(formData: FormData): Promise<ActionResult> {
  const res = await loadManaged(fdStr(formData, "id") ?? "");
  if ("error" in res) return { ok: false, error: res.error };
  const userId = fdStr(formData, "userId");
  if (userId) await prisma.meetingParticipant.deleteMany({ where: { meetingId: res.meeting.id, userId } });
  revalidatePath(`/meetings/${res.meeting.id}`);
  return { ok: true };
}

/** Enregistre une transcription saisie/collée manuellement (sans audio). */
export async function saveMeetingTranscript(formData: FormData): Promise<ActionResult> {
  const res = await loadManaged(fdStr(formData, "id") ?? "");
  if ("error" in res) return { ok: false, error: res.error };
  const transcript = fdStr(formData, "transcript");
  if (!transcript) return { ok: false, error: "Transcription vide." };
  await prisma.meeting.update({ where: { id: res.meeting.id }, data: { transcript } });
  revalidatePath(`/meetings/${res.meeting.id}`);
  return { ok: true };
}

/**
 * Génère le compte rendu IA + des tâches proposées à partir de la transcription stockée.
 * Les noms de personnes désignées sont rapprochés des participants (jamais inventés).
 */
export async function summarizeMeeting(formData: FormData): Promise<ActionResult> {
  const res = await loadManaged(fdStr(formData, "id") ?? "");
  if ("error" in res) return { ok: false, error: res.error };
  const full = await prisma.meeting.findUnique({
    where: { id: res.meeting.id },
    select: { transcript: true, participants: { select: { user: { select: { id: true, name: true } } } }, organizer: { select: { id: true, name: true } } },
  });
  const transcript = full?.transcript?.trim();
  if (!transcript) return { ok: false, error: "Aucune transcription à analyser. Enregistrez l'audio ou collez le texte d'abord." };

  const r = await summarizeMeetingTranscript(transcript);
  if (!r.ok || !r.data) return { ok: false, error: r.configured ? (r.error ?? "Compte rendu impossible.") : phraseIaNonConfiguree(cleModeleRequise(), "le compte rendu automatique") };

  // Annuaire des personnes connues de la réunion pour rapprocher un nom → un compte.
  const people = [full?.organizer, ...(full?.participants ?? []).map((p) => p.user)].filter(Boolean) as { id: string; name: string }[];
  const matchPerson = (name?: string): string | null => {
    if (!name) return null;
    const n = name.trim().toLowerCase();
    if (!n) return null;
    return people.find((p) => p.name.toLowerCase() === n)?.id
      ?? people.find((p) => p.name.toLowerCase().includes(n) || n.includes(p.name.toLowerCase()))?.id
      ?? null;
  };

  await prisma.$transaction([
    prisma.meeting.update({ where: { id: res.meeting.id }, data: { summary: r.data.summary } }),
    prisma.meetingTaskProposal.deleteMany({ where: { meetingId: res.meeting.id, status: "PROPOSED" } }),
    ...(r.data.tasks.length
      ? [prisma.meetingTaskProposal.createMany({
          data: r.data.tasks.map((t) => ({ meetingId: res.meeting.id, title: t.title, description: t.description ?? null, assigneeId: matchPerson(t.assignee) })),
        })]
      : []),
  ]);
  await recordAudit({ actorId: res.user.id, action: "UPDATE", module: "Réunions", entityId: res.meeting.id, summary: `Compte rendu IA généré (${r.data.tasks.length} tâche(s) proposée(s))` });
  revalidatePath(`/meetings/${res.meeting.id}`);
  return { ok: true, message: `Compte rendu généré — ${r.data.tasks.length} tâche(s) proposée(s).` };
}

/** Transforme une tâche proposée en vraie tâche (Mon espace) assignée. */
export async function acceptMeetingProposal(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const proposalId = fdStr(formData, "proposalId");
  if (!proposalId) return { ok: false, error: "Proposition introuvable." };
  const proposal = await prisma.meetingTaskProposal.findUnique({
    where: { id: proposalId },
    include: { meeting: { include: { participants: { select: { userId: true } } } } },
  });
  if (!proposal) return { ok: false, error: "Proposition introuvable." };
  if (!canManageMeeting(user, proposal.meeting)) return DENIED;
  if (proposal.status === "ACCEPTED") return { ok: false, error: "Déjà transformée en tâche." };

  const assignedToId = proposal.assigneeId ?? proposal.meeting.organizerId;
  const task = await prisma.task.create({
    data: { title: proposal.title, description: proposal.description, assignedToId, createdById: user.id },
    select: { id: true },
  });
  await prisma.meetingTaskProposal.update({ where: { id: proposalId }, data: { status: "ACCEPTED", createdTaskId: task.id } });
  if (assignedToId !== user.id) {
    await notifyUser({ userId: assignedToId, type: "ASSIGNMENT", title: "Nouvelle tâche (réunion)", body: proposal.title, link: lienTache(task.id) });
  }
  await recordAudit({ actorId: user.id, action: "CREATE", module: "Réunions", entityType: "TASK", entityId: task.id, summary: `Tâche « ${proposal.title} » créée depuis une réunion` });
  revalidatePath(`/meetings/${proposal.meetingId}`);
  revalidatePath("/mon-espace");
  return { ok: true };
}

/** Écarte une tâche proposée. */
export async function dismissMeetingProposal(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const proposalId = fdStr(formData, "proposalId");
  if (!proposalId) return { ok: false, error: "Proposition introuvable." };
  const proposal = await prisma.meetingTaskProposal.findUnique({ where: { id: proposalId }, include: { meeting: { include: { participants: { select: { userId: true } } } } } });
  if (!proposal) return { ok: false, error: "Proposition introuvable." };
  if (!canManageMeeting(user, proposal.meeting)) return DENIED;
  await prisma.meetingTaskProposal.update({ where: { id: proposalId }, data: { status: "DISMISSED" } });
  revalidatePath(`/meetings/${proposal.meetingId}`);
  return { ok: true };
}

/** Supprime une réunion (et libère l'audio éventuel). */
export async function deleteMeeting(formData: FormData): Promise<ActionResult> {
  const res = await loadManaged(fdStr(formData, "id") ?? "");
  if ("error" in res) return { ok: false, error: res.error };
  const full = await prisma.meeting.findUnique({ where: { id: res.meeting.id }, select: { audioBlobId: true, title: true } });
  await prisma.meeting.delete({ where: { id: res.meeting.id } });
  if (full?.audioBlobId) await releaseBlob(full.audioBlobId).catch(sansBloquer("meeting-actions.deleteMeeting.releaseBlob"));
  await recordAudit({ actorId: res.user.id, action: "DELETE", module: "Réunions", entityId: res.meeting.id, summary: `Réunion « ${full?.title ?? ""} » supprimée` });
  revalidatePath("/meetings");
  return { ok: true };
}

/**
 * Poste un message dans le fil de discussion d'une réunion — vrai chat : texte + **pièces jointes**
 * intégrées (stockées chiffrées via le backend Drive), comme le chat des dossiers. Ouvert à
 * l'organisateur et aux participants ; les autres membres reçoivent une notification.
 */
export async function postMeetingMessage(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Réunion manquante." };
  const body = (fdStr(formData, "body") ?? "").trim();
  const files = formData.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
  if (!body && files.length === 0) return { ok: false, error: "Écrivez un message ou joignez un fichier." };

  const meeting = await prisma.meeting.findUnique({
    where: { id },
    select: { id: true, title: true, organizerId: true, participants: { select: { userId: true } } },
  });
  if (!meeting) return { ok: false, error: "Réunion introuvable." };
  if (!canViewMeeting(user, meeting)) return DENIED;

  const msg = await prisma.meetingMessage.create({ data: { meetingId: id, authorId: user.id, body } });

  // Pièces jointes (comme la messagerie) — blob chiffré via le backend Drive.
  for (const f of files) {
    if (f.size > MAX_MSG_ATTACHMENT) continue;
    const buf = Buffer.from(await f.arrayBuffer());
    const { blobId, size, sha256 } = await putBlob(buf);
    const pj = await prisma.meetingMessageAttachment.create({
      data: { messageId: msg.id, blobId, name: (f.name || "fichier").slice(0, 200), mime: f.type || "application/octet-stream", size },
      select: { id: true, name: true },
    });
    // La pièce entre à la bibliothèque (J1), ouverte par la règle des pièces de réunion. Ne lève jamais.
    await inscrirePiece({
      blobId, empreinte: sha256, nom: pj.name, mime: f.type || null, taille: size, source: "CONVERSATION",
      objet: { famille: "REUNION_PIECE", id: pj.id }, proprietaireId: user.id, role: "piece-jointe",
    });
  }

  // Notifie les autres membres (organisateur + participants).
  const recipients = new Set<string>([meeting.organizerId, ...meeting.participants.map((p) => p.userId)]);
  recipients.delete(user.id);
  for (const uid of recipients) {
    await notifyUser({
      userId: uid, type: "GENERIC",
      title: "Nouveau message sur une réunion",
      body: `${meeting.title}${body ? ` — ${body.slice(0, 80)}` : " — pièce jointe"}`,
      link: `/meetings/${id}`,
    }).catch(sansBloquer("meeting-actions.postMeetingMessage.notifyUser"));
  }
  revalidatePath(`/meetings/${id}`);
  return { ok: true };
}

/** Supprime un message du fil d'une réunion (auteur ou organisateur/vue globale). */
export async function deleteMeetingMessage(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Message introuvable." };
  const msg = await prisma.meetingMessage.findUnique({
    where: { id },
    select: { authorId: true, meetingId: true, attachments: { select: { blobId: true } }, meeting: { select: { organizerId: true } } },
  });
  if (!msg) return { ok: false, error: "Message introuvable." };
  const allowed = msg.authorId === user.id || canManageMeeting(user, msg.meeting);
  if (!allowed) return { ok: false, error: "Suppression non autorisée." };
  await prisma.meetingMessage.delete({ where: { id } }); // pièces jointes supprimées en cascade
  for (const a of msg.attachments) await releaseBlob(a.blobId).catch(sansBloquer("meeting-actions.deleteMeetingMessage.releaseBlob")); // libère le stockage
  revalidatePath(`/meetings/${msg.meetingId}`);
  return { ok: true };
}
