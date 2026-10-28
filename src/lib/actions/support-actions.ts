"use server";

import { revalidatePath } from "next/cache";
import type { SupportCategory, SupportStatus, Priority, UserRole } from "@prisma/client";
import { requireUser } from "@/lib/session";
import { userCan, hasGlobalView, type SessionUser } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { referenceDeSerie } from "@/lib/refs";
import { companyIdForNew } from "@/lib/company";
import { recordAudit } from "@/lib/audit";
import { notifyUser, notifyRoles } from "@/lib/notify";
import { fdStr, type ActionResult } from "@/lib/actions/types";

const PATH = "/support";
const CATEGORIES: SupportCategory[] = ["QUESTION", "SUPPORT_MATERIAL", "BROCHURE", "DOCUMENT", "OTHER"];
const STATUSES: SupportStatus[] = ["OPEN", "IN_PROGRESS", "ANSWERED", "CLOSED"];

type SupportLike = { requesterId: string | null; targetUserId: string | null; targetRole: UserRole | null; assignedToId: string | null };
function isResponder(user: SessionUser, r: SupportLike): boolean {
  return hasGlobalView(user.role) || r.targetUserId === user.id || r.targetRole === user.role || r.assignedToId === user.id;
}
function isRequester(user: SessionUser, r: SupportLike): boolean {
  return r.requesterId === user.id;
}

function revalidate(id?: string) {
  revalidatePath(PATH);
  if (id) revalidatePath(`${PATH}/${id}`);
  revalidatePath("/mon-espace");
}

async function nextRef(): Promise<string> {
  const year = new Date().getFullYear();
  return referenceDeSerie({
    modele: "SupportRequest", prefixe: "SUP", annee: year,
    existantes: async () => (await prisma.supportRequest.findMany({ where: { reference: { startsWith: `SUP-${year}-` } }, select: { reference: true } })).map((r) => r.reference),
  });
}

async function notifyResponders(r: { targetUserId: string | null; targetRole: UserRole | null }, reference: string, subject: string, id: string) {
  const payload = { type: "ASSIGNMENT" as const, title: "Nouvelle demande de support", body: `${reference} — ${subject}`, link: `${PATH}/${id}` };
  if (r.targetUserId) await notifyUser({ userId: r.targetUserId, ...payload });
  else if (r.targetRole) await notifyRoles([r.targetRole], payload);
}

// ───────────── Création (tout employé) ─────────────

export async function createSupportRequest(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, "SUPPORT", "CREATE")) return { ok: false, error: "Non autorisé." };

  const subject = fdStr(formData, "subject");
  const body = fdStr(formData, "body");
  if (!subject || !body) return { ok: false, error: "L'objet et le message sont obligatoires." };

  const targetUserId = fdStr(formData, "targetUserId");
  const targetRole = fdStr(formData, "targetRole") as UserRole | null;
  if (!targetUserId && !targetRole) return { ok: false, error: "Choisissez un destinataire (fonction ou personne)." };

  const category = (fdStr(formData, "category") as SupportCategory) ?? "QUESTION";
  if (!CATEGORIES.includes(category)) return { ok: false, error: "Catégorie invalide." };

  const reference = await nextRef();
  const created = await prisma.supportRequest.create({
    data: {
      reference, subject, body, category,
      priority: (fdStr(formData, "priority") as Priority) ?? "MEDIUM",
      product: fdStr(formData, "product"),
      targetUserId: targetUserId ?? null,
      targetRole: targetUserId ? null : targetRole,
      requesterId: user.id,
      companyId: await companyIdForNew(user.id),
    },
  });
  await notifyResponders(created, reference, subject, created.id);
  await recordAudit({ actorId: user.id, action: "CREATE", module: "Support", entityType: "SUPPORT_REQUEST", entityId: created.id, summary: `Demande de support ${reference} — ${subject}` });
  revalidate(created.id);
  return { ok: true, id: created.id };
}

// ───────────── Prise en charge (répondant) ─────────────

export async function takeSupportRequest(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Identifiant manquant." };
  const r = await prisma.supportRequest.findUnique({ where: { id } });
  if (!r) return { ok: false, error: "Demande introuvable." };
  if (!isResponder(user, r)) return { ok: false, error: "Réservé au destinataire de la demande." };

  await prisma.supportRequest.update({ where: { id }, data: { assignedToId: user.id, status: r.status === "OPEN" ? "IN_PROGRESS" : r.status } });
  if (r.requesterId && r.requesterId !== user.id) await notifyUser({ userId: r.requesterId, type: "GENERIC", title: "Support — pris en charge", body: `${r.reference} — ${r.subject}`, link: `${PATH}/${id}` });
  await recordAudit({ actorId: user.id, action: "UPDATE", module: "Support", entityType: "SUPPORT_REQUEST", entityId: id, summary: `Prise en charge — ${r.reference}` });
  revalidate(id);
  return { ok: true };
}

// ───────────── Réponse / échange (fil) ─────────────

export async function answerSupportRequest(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  const body = fdStr(formData, "body");
  if (!id || !body) return { ok: false, error: "Message vide." };
  const r = await prisma.supportRequest.findUnique({ where: { id } });
  if (!r) return { ok: false, error: "Demande introuvable." };

  const responder = isResponder(user, r);
  if (!responder && !isRequester(user, r)) return { ok: false, error: "Non autorisé." };

  await prisma.supportMessage.create({ data: { requestId: id, authorId: user.id, body } });

  // Quand un répondant répond : il prend la demande (s'il n'y a pas d'assigné) et le statut passe à « Répondu ».
  if (responder) {
    // `resolvedAt` : posé à la PREMIÈRE réponse, jamais écrasé (brique KPI « demandes traitées »).
    await prisma.supportRequest.update({ where: { id }, data: { status: "ANSWERED", ...(r.assignedToId ? {} : { assignedToId: user.id }), ...(r.resolvedAt ? {} : { resolvedAt: new Date() }) } });
    if (r.requesterId && r.requesterId !== user.id) await notifyUser({ userId: r.requesterId, type: "GENERIC", title: "Support — réponse reçue", body: `${r.reference} — ${r.subject}`, link: `${PATH}/${id}` });
  } else {
    // Relance du demandeur : notifie le répondant assigné (ou le pool ciblé).
    if (r.assignedToId) await notifyUser({ userId: r.assignedToId, type: "GENERIC", title: "Support — message du demandeur", body: `${r.reference} — ${r.subject}`, link: `${PATH}/${id}` });
    else await notifyResponders(r, r.reference, r.subject, id);
  }
  await recordAudit({ actorId: user.id, action: "UPDATE", module: "Support", entityType: "SUPPORT_REQUEST", entityId: id, summary: `Message — ${r.reference}` });
  revalidate(id);
  return { ok: true };
}

// ───────────── Changement de statut ─────────────

export async function updateSupportStatus(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  const status = fdStr(formData, "status") as SupportStatus | null;
  if (!id || !status || !STATUSES.includes(status)) return { ok: false, error: "Statut invalide." };
  const r = await prisma.supportRequest.findUnique({ where: { id } });
  if (!r) return { ok: false, error: "Demande introuvable." };

  const responder = isResponder(user, r);
  const requester = isRequester(user, r);
  if (!responder && !requester) return { ok: false, error: "Non autorisé." };
  // La clôture est ouverte au demandeur et au répondant ; les autres statuts au répondant.
  if (status !== "CLOSED" && !responder) return { ok: false, error: "Réservé au destinataire de la demande." };

  // Traitée = répondue, ou clôturée PAR LE RÉPONDANT (une clôture du seul demandeur n'est pas un traitement).
  const traite = !r.resolvedAt && (status === "ANSWERED" || (status === "CLOSED" && responder));
  await prisma.supportRequest.update({ where: { id }, data: { status, ...(traite ? { resolvedAt: new Date() } : {}) } });
  await recordAudit({ actorId: user.id, action: "UPDATE", module: "Support", entityType: "SUPPORT_REQUEST", entityId: id, summary: `Statut → ${status} (${r.reference})` });
  revalidate(id);
  return { ok: true };
}
