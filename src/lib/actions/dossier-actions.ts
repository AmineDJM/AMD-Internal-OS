"use server";

import { revalidatePath } from "next/cache";
import type { Priority, DossierStatus } from "@prisma/client";
import { requireUser } from "@/lib/session";
import { enLecture } from "@/lib/vue-lecture";
import { userCan, hasGlobalView, scopeDossiers, type SessionUser } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { getMyCompanies } from "@/lib/company";
import { recordAudit } from "@/lib/audit";
import { notifyUser } from "@/lib/notify";
import { putBlob, releaseBlob } from "@/lib/drive-storage";
import { createDossierRecord } from "@/lib/dossiers-core";
import { fdStr, fdDate, type ActionResult } from "@/lib/actions/types";
import { sansBloquer } from "@/lib/journal";
import { inscrirePiece } from "@/modules/bibliotheque/api-inscription";

const MAX_MSG_ATTACHMENT = 25 * 1024 * 1024; // 25 Mo par pièce jointe de message (chat)

const PATH = "/dossiers";
const STATUSES: DossierStatus[] = ["OPEN", "IN_PROGRESS", "ON_HOLD", "DONE", "ARCHIVED"];

function revalidate(id?: string) {
  revalidatePath(PATH);
  if (id) revalidatePath(`${PATH}/${id}`);
  revalidatePath("/mon-travail");
}

type DossierMembers = { createdById: string | null; assignedToId: string | null; participantIds: string[] };
function isMember(user: SessionUser, d: DossierMembers): boolean {
  return hasGlobalView(user.role) || d.createdById === user.id || d.assignedToId === user.id || d.participantIds.includes(user.id);
}
function isManager(user: SessionUser, d: DossierMembers): boolean {
  return hasGlobalView(user.role) || d.createdById === user.id || d.assignedToId === user.id;
}

export async function createDossier(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, "DOSSIERS", "CREATE")) return { ok: false, error: "Non autorisé." };
  const title = fdStr(formData, "title");
  if (!title) return { ok: false, error: "L'intitulé du sujet est obligatoire." };
  // L'ENTITÉ (§118.163) : celle qu'on a choisie, et seulement une entité que la personne VOIT —
  // un formulaire forgé ne range pas un sujet chez une société qu'on ne voit pas. Sans choix, le
  // cœur retombe sur celle où l'on travaille, comme avant.
  const companyId = fdStr(formData, "companyId");
  if (companyId !== null && !(await getMyCompanies(user.id)).some((c) => c.id === companyId)) {
    return { ok: false, error: "Cette entité ne vous est pas ouverte : choisissez l'une de celles que vous voyez." };
  }

  const { id } = await createDossierRecord(
    {
      title,
      description: fdStr(formData, "description"),
      category: fdStr(formData, "category"),
      priority: (fdStr(formData, "priority") as Priority) ?? "MEDIUM",
      assignedToId: fdStr(formData, "assignedToId"),
      participantIds: formData.getAll("participantIds").map(String).filter(Boolean),
      dueDate: fdDate(formData, "dueDate"),
      companyId,
    },
    user.id,
  );
  revalidate(id);
  return { ok: true, id };
}

export async function updateDossierStatus(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  const status = fdStr(formData, "status") as DossierStatus | null;
  if (!id || !status || !STATUSES.includes(status)) return { ok: false, error: "Paramètres invalides." };
  const d = await prisma.dossier.findUnique({ where: { id }, select: { createdById: true, assignedToId: true, participantIds: true, reference: true } });
  if (!d) return { ok: false, error: "Sujet introuvable." };
  if (!isManager(user, d)) return { ok: false, error: "Réservé au créateur, au responsable ou à la Direction." };
  await prisma.dossier.update({ where: { id }, data: { status } });
  await recordAudit({ actorId: user.id, action: "UPDATE", module: "Sujets", entityType: "DOSSIER", entityId: id, summary: `Statut → ${status} (${d.reference})` });
  revalidate(id);
  return { ok: true };
}

export async function assignDossier(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Sujet manquant." };
  const d = await prisma.dossier.findUnique({ where: { id }, select: { createdById: true, assignedToId: true, participantIds: true, reference: true, title: true } });
  if (!d) return { ok: false, error: "Sujet introuvable." };
  if (!isManager(user, d)) return { ok: false, error: "Réservé au créateur, au responsable ou à la Direction." };

  const newAssignee = fdStr(formData, "assignedToId");
  const wantedParts = formData.getAll("participantIds").map(String).filter(Boolean);
  const validParts = wantedParts.length
    ? (await prisma.user.findMany({ where: { id: { in: wantedParts }, isActive: true }, select: { id: true } })).map((u) => u.id).filter((pid) => pid !== newAssignee)
    : [];

  await prisma.dossier.update({ where: { id }, data: { assignedToId: newAssignee, participantIds: validParts } });

  // Notifie les NOUVEAUX membres uniquement.
  const before = new Set([...(d.assignedToId ? [d.assignedToId] : []), ...d.participantIds]);
  const after = new Set([...(newAssignee ? [newAssignee] : []), ...validParts]);
  for (const uid of after) {
    if (!before.has(uid) && uid !== user.id) {
      await notifyUser({ userId: uid, type: "ASSIGNMENT", title: "Sujet qui vous concerne", body: `${d.reference} — ${d.title}`, link: `${PATH}/${id}` });
    }
  }
  await recordAudit({ actorId: user.id, action: "UPDATE", module: "Sujets", entityType: "DOSSIER", entityId: id, summary: `Responsable/participants mis à jour (${d.reference})` });
  revalidate(id);
  return { ok: true };
}

/**
 * Poste un message dans le fil « Suivi & discussion » — vrai chat : texte, **pièces jointes**
 * intégrées (stockées chiffrées) et **mentions** (@) d'utilisateurs qui doivent d'abord être
 * membres du dossier (participant / responsable / créateur). Les personnes mentionnées reçoivent
 * une notification dédiée ; les autres membres sont prévenus normalement.
 */
export async function postDossierMessage(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Sujet manquant." };
  const body = (fdStr(formData, "body") ?? "").trim();
  const files = formData.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
  if (!body && files.length === 0) return { ok: false, error: "Écrivez un message ou joignez un fichier." };

  const d = await prisma.dossier.findUnique({ where: { id }, select: { createdById: true, assignedToId: true, participantIds: true, reference: true } });
  if (!d) return { ok: false, error: "Sujet introuvable." };
  if (!isMember(user, d)) return { ok: false, error: "Non autorisé." };

  // Membres du dossier = seuls destinataires possibles d'une mention.
  const memberIds = new Set<string>([...(d.createdById ? [d.createdById] : []), ...(d.assignedToId ? [d.assignedToId] : []), ...d.participantIds]);
  const mentionIds = [...new Set(formData.getAll("mentionIds").map(String).filter((m) => m && memberIds.has(m)))];

  const msg = await prisma.dossierMessage.create({ data: { dossierId: id, authorId: user.id, body, mentionIds } });

  // Pièces jointes (comme la messagerie) — blob chiffré via le backend Drive.
  for (const f of files) {
    if (f.size > MAX_MSG_ATTACHMENT) continue;
    const buf = Buffer.from(await f.arrayBuffer());
    const { blobId, size, sha256 } = await putBlob(buf);
    const pj = await prisma.dossierMessageAttachment.create({
      data: { messageId: msg.id, blobId, name: (f.name || "fichier").slice(0, 200), mime: f.type || "application/octet-stream", size },
      select: { id: true, name: true },
    });
    // La pièce entre à la bibliothèque (J1), ouverte par la règle des pièces de sujet. Ne lève jamais.
    await inscrirePiece({
      blobId, empreinte: sha256, nom: pj.name, mime: f.type || null, taille: size, source: "AUTRE",
      objet: { famille: "SUJET_PIECE", id: pj.id }, proprietaireId: user.id, role: "piece-jointe",
    });
  }

  await prisma.dossier.update({ where: { id }, data: { updatedAt: new Date() } });

  // Notifie les autres membres ; les personnes mentionnées reçoivent un message dédié.
  const recipients = new Set(memberIds);
  recipients.delete(user.id);
  for (const uid of recipients) {
    const mentioned = mentionIds.includes(uid);
    await notifyUser({
      userId: uid,
      type: mentioned ? "ASSIGNMENT" : "GENERIC",
      title: mentioned ? "Vous avez été mentionné sur un sujet" : "Nouveau message sur un sujet",
      body: `${d.reference}${body ? ` — ${body.slice(0, 80)}` : " — pièce jointe"}`,
      link: `${PATH}/${id}`,
    });
  }
  await recordAudit({ actorId: user.id, action: "UPDATE", module: "Sujets", entityType: "DOSSIER", entityId: id, summary: `Message — ${d.reference}` });
  revalidate(id);
  return { ok: true };
}

/** Liste des dossiers auxquels l'utilisateur peut rattacher quelque chose (non archivés). */
export async function listLinkableDossiers(): Promise<{ id: string; reference: string; title: string }[]> {
  const user = await enLecture(requireUser);
  if (!userCan(user, "DOSSIERS", "VIEW")) return [];
  return prisma.dossier.findMany({
    where: { AND: [scopeDossiers(user), { status: { not: "ARCHIVED" } }] },
    select: { id: true, reference: true, title: true },
    orderBy: { updatedAt: "desc" },
    take: 100,
  });
}

export interface LinkEmailInput {
  dossierId?: string | null;
  newTitle?: string | null;
  from?: string | null;
  subject?: string | null;
  date?: string | null;
  body?: string | null;
}

/**
 * Rattache un e-mail (depuis le Courrier) à un dossier — existant ou créé à la
 * volée. L'e-mail est journalisé dans le fil du dossier (expéditeur, objet, date,
 * corps), pour que tout le suivi du sujet reste au même endroit.
 */
export async function linkEmailToDossier(
  input: LinkEmailInput,
): Promise<{ ok: boolean; error?: string; dossierId?: string; reference?: string }> {
  const user = await requireUser();
  if (!userCan(user, "DOSSIERS", "VIEW")) return { ok: false, error: "Non autorisé." };

  let dossierId = input.dossierId ?? null;
  let reference = "";

  if (!dossierId) {
    const title = (input.newTitle || input.subject || "").trim();
    if (!title) return { ok: false, error: "Donnez un intitulé au sujet." };
    if (!userCan(user, "DOSSIERS", "CREATE")) return { ok: false, error: "Vous ne pouvez pas créer de sujet." };
    const created = await createDossierRecord({ title, category: "E-mail" }, user.id);
    dossierId = created.id;
    reference = created.reference;
  } else {
    const d = await prisma.dossier.findUnique({ where: { id: dossierId }, select: { createdById: true, assignedToId: true, participantIds: true, reference: true } });
    if (!d) return { ok: false, error: "Sujet introuvable." };
    if (!isMember(user, d)) return { ok: false, error: "Vous n'êtes pas membre de ce sujet." };
    reference = d.reference;
  }

  const subject = (input.subject || "(sans objet)").trim();
  const from = (input.from || "—").trim();
  const when = input.date ? new Date(input.date).toLocaleString("fr-FR") : "";
  const body = (input.body || "").trim().slice(0, 6000);
  const message = `📧 E-mail lié\nDe : ${from}\nObjet : ${subject}${when ? `\nReçu le : ${when}` : ""}\n\n${body || "(corps non disponible)"}`;

  await prisma.dossierMessage.create({ data: { dossierId, authorId: user.id, body: message } });
  await prisma.dossier.update({ where: { id: dossierId }, data: { updatedAt: new Date() } });
  await recordAudit({ actorId: user.id, action: "UPDATE", module: "Sujets", entityType: "DOSSIER", entityId: dossierId, summary: `E-mail lié — ${subject}` });
  revalidate(dossierId);
  return { ok: true, dossierId, reference };
}

/** Ouvre un dossier de suivi à partir d'une tâche (reprend titre, description, responsable…). */
export async function createDossierFromTask(taskId: string): Promise<{ ok: boolean; error?: string; dossierId?: string }> {
  const user = await requireUser();
  if (!userCan(user, "DOSSIERS", "CREATE")) return { ok: false, error: "Vous ne pouvez pas créer de sujet." };
  const t = await prisma.task.findUnique({
    where: { id: taskId },
    select: { id: true, title: true, description: true, assignedToId: true, createdById: true, priority: true, dueDate: true, module: true },
  });
  if (!t) return { ok: false, error: "Tâche introuvable." };
  if (!(hasGlobalView(user.role) || t.assignedToId === user.id || t.createdById === user.id)) {
    return { ok: false, error: "Non autorisé." };
  }
  const { id } = await createDossierRecord(
    {
      title: t.title,
      description: t.description ? `Ouvert à partir d'une tâche.\n\n${t.description}` : "Ouvert à partir d'une tâche.",
      category: t.module ?? null,
      priority: t.priority,
      assignedToId: t.assignedToId ?? null,
      dueDate: t.dueDate ?? null,
    },
    user.id,
  );
  revalidate(id);
  return { ok: true, dossierId: id };
}

export async function archiveDossier(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Sujet manquant." };
  const d = await prisma.dossier.findUnique({ where: { id }, select: { createdById: true, assignedToId: true, participantIds: true, reference: true } });
  if (!d) return { ok: false, error: "Sujet introuvable." };
  if (!isManager(user, d)) return { ok: false, error: "Réservé au créateur, au responsable ou à la Direction." };
  await prisma.dossier.update({ where: { id }, data: { status: "ARCHIVED" } });
  await recordAudit({ actorId: user.id, action: "UPDATE", module: "Sujets", entityType: "DOSSIER", entityId: id, summary: `Sujet archivé (${d.reference})` });
  revalidate(id);
  return { ok: true };
}

/** Supprime un message du fil d'un dossier (auteur, responsable du dossier ou admin). */
export async function deleteDossierMessage(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Message introuvable." };
  const msg = await prisma.dossierMessage.findUnique({
    where: { id },
    select: { authorId: true, dossierId: true, attachments: { select: { blobId: true } }, dossier: { select: { createdById: true, assignedToId: true, participantIds: true } } },
  });
  if (!msg) return { ok: false, error: "Message introuvable." };
  const allowed = msg.authorId === user.id || isManager(user, msg.dossier);
  if (!allowed) return { ok: false, error: "Suppression non autorisée." };
  await prisma.dossierMessage.delete({ where: { id } }); // pièces jointes supprimées en cascade
  for (const a of msg.attachments) await releaseBlob(a.blobId).catch(sansBloquer("dossier-actions.deleteDossierMessage.releaseBlob")); // libère le stockage

  await recordAudit({ actorId: user.id, action: "DELETE", module: "Sujets", entityType: "DOSSIER", entityId: msg.dossierId, summary: "Message de sujet supprimé" });
  revalidate(msg.dossierId);
  return { ok: true };
}

/** Modifie un message du fil (auteur, responsable/créateur ou Super Admin/Direction). */
export async function editDossierMessage(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  const body = fdStr(formData, "body");
  if (!id) return { ok: false, error: "Message introuvable." };
  if (!body || !body.trim()) return { ok: false, error: "Le message ne peut pas être vide." };
  const msg = await prisma.dossierMessage.findUnique({
    where: { id },
    select: { authorId: true, dossierId: true, dossier: { select: { createdById: true, assignedToId: true, participantIds: true } } },
  });
  if (!msg) return { ok: false, error: "Message introuvable." };
  const allowed = msg.authorId === user.id || isManager(user, msg.dossier);
  if (!allowed) return { ok: false, error: "Modification non autorisée." };
  await prisma.dossierMessage.update({ where: { id }, data: { body: body.trim() } });
  await recordAudit({ actorId: user.id, action: "UPDATE", module: "Sujets", entityType: "DOSSIER", entityId: msg.dossierId, summary: "Message de sujet modifié" });
  revalidate(msg.dossierId);
  return { ok: true };
}
