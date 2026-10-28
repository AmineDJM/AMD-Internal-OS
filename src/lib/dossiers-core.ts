/**
 * Cœur (sans "use server") de la création d'un dossier de suivi. Isolé ici pour
 * être réutilisable par l'action de formulaire (dossier-actions, "use server")
 * ET par l'assistant IA, sans tirer `@/lib/session`/auth dans leurs graphes
 * d'import (sinon les tests ne chargent plus). Ne lit jamais la session : l'auteur
 * est passé explicitement (`actorId`).
 */
import type { Priority } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { companyIdForNew } from "@/lib/company";
import { buildRef, createWithRetry } from "@/lib/refs";
import { recordAudit } from "@/lib/audit";
import { notifyUser } from "@/lib/notify";

export interface DossierInput {
  title: string;
  description?: string | null;
  category?: string | null;
  priority?: Priority;
  assignedToId?: string | null;
  participantIds?: string[];
  dueDate?: Date | null;
  /** Demande Ad & Pro d'origine (implication de tierce personne) — pour remonter la conversation. */
  sourceType?: string | null;
  sourceId?: string | null;
  /**
   * L'ENTITÉ CHOISIE (§118.163) — déjà vérifiée par l'appelant contre ce que la personne voit.
   * Absente : celle sur laquelle l'auteur travaille (`companyIdForNew`), comme avant.
   */
  companyId?: string | null;
}

export async function nextDossierRef(): Promise<string> {
  const year = new Date().getFullYear();
  const refs = await prisma.dossier.findMany({ where: { reference: { startsWith: `DOS-${year}-` } }, select: { reference: true } });
  return buildRef("DOS", year, refs.map((r) => r.reference));
}

/**
 * Crée un dossier de suivi. Réutilisable par l'action de formulaire ET par
 * l'assistant IA (après confirmation). Notifie le responsable + les participants.
 */
export async function createDossierRecord(input: DossierInput, actorId: string): Promise<{ id: string; reference: string }> {
  // On ne garde que des participants valides et actifs, hors responsable/créateur.
  const wanted = (input.participantIds ?? []).filter((id) => id && id !== input.assignedToId && id !== actorId);
  const participantIds = wanted.length
    ? (await prisma.user.findMany({ where: { id: { in: wanted }, isActive: true }, select: { id: true } })).map((u) => u.id)
    : [];

  let assignedToId = input.assignedToId ?? null;
  if (assignedToId) {
    const a = await prisma.user.findUnique({ where: { id: assignedToId }, select: { isActive: true } });
    if (!a?.isActive) assignedToId = null;
  }

  // LA RÉFÉRENCE SE RECALCULE À CHAQUE ESSAI (§118.175) : dérivée du maximum, deux sujets ouverts à
  // la même seconde — une demande de réservation et un sujet ouvert à la main — lisaient le même,
  // et le second échouait sur la contrainte d'unicité. L'entité se lit UNE fois, hors de l'essai.
  const companyId = input.companyId ?? (await companyIdForNew(actorId));
  const created = await createWithRetry(async () => prisma.dossier.create({
    data: {
      reference: await nextDossierRef(),
      companyId,
      title: input.title.trim(),
      description: input.description?.trim() || null,
      category: input.category?.trim() || null,
      priority: input.priority ?? "MEDIUM",
      assignedToId,
      participantIds,
      dueDate: input.dueDate ?? null,
      sourceType: (input.sourceType ?? null) as never,
      sourceId: input.sourceId ?? null,
      createdById: actorId,
    },
    select: { id: true, reference: true, title: true },
  }));

  const recipients = new Set<string>([...(assignedToId ? [assignedToId] : []), ...participantIds]);
  recipients.delete(actorId);
  for (const userId of recipients) {
    await notifyUser({ userId, type: "ASSIGNMENT", title: "Nouveau sujet", body: `${created.reference} — ${created.title}`, link: `/dossiers/${created.id}` });
  }
  await recordAudit({ actorId, action: "CREATE", module: "Sujets", entityType: "DOSSIER", entityId: created.id, summary: `Sujet ${created.reference} — ${created.title}` });
  return { id: created.id, reference: created.reference };
}

/**
 * ÉCRIRE DANS UN SUJET au nom d'un geste métier (§118.175) — une demande de réservation mise à
 * jour, un voyageur décalé. Le message vient de l'auteur du geste, et les AUTRES membres du sujet
 * sont prévenus : c'est la même chose que ce que `postDossierMessage` fait pour un message tapé,
 * sans ses mentions ni ses pièces jointes. Rend `false` si le sujet n'existe plus — l'appelant le
 * DIT au lieu de croire le message parti.
 */
export async function ecrireDansLeSujet(input: { dossierId: string; authorId: string; body: string }): Promise<boolean> {
  const d = await prisma.dossier.findUnique({
    where: { id: input.dossierId },
    select: { id: true, reference: true, createdById: true, assignedToId: true, participantIds: true },
  });
  if (!d) return false;
  await prisma.dossierMessage.create({ data: { dossierId: d.id, authorId: input.authorId, body: input.body } });
  await prisma.dossier.update({ where: { id: d.id }, data: { updatedAt: new Date() } });
  const membres = new Set<string>([...(d.createdById ? [d.createdById] : []), ...(d.assignedToId ? [d.assignedToId] : []), ...d.participantIds]);
  membres.delete(input.authorId);
  for (const userId of membres) {
    await notifyUser({ userId, type: "GENERIC", title: "Nouveau message sur un sujet", body: `${d.reference} — ${input.body.slice(0, 80)}`, link: `/dossiers/${d.id}` });
  }
  return true;
}
