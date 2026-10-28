/**
 * DEMANDES ADMINISTRATIVES — la DEMANDE lue par les actions du secrétariat : qui la gère, si elle se traite encore,
 * sa référence, ses participants, la fiche à rafraîchir, l'archive d'une demande terminée, et le dossier promotionnel
 * qui suit le retrait d'une demande de devis.
 *
 * Sorti de `actions/admin-request-actions.ts` (lot V4). Lectures et règles ; deux suites d'écriture « au mieux »
 * (l'archive, le retour du dossier promotionnel) que les actions appellent après leur propre écriture.
 */
import { revalidatePath } from "next/cache";
import type { AdminRequestStatus, Prisma } from "@prisma/client";
import { userCan, hasGlobalView, type SessionUser } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { formatAlgiers } from "@/lib/calendar-tz";
import { archiveProcessedRequest } from "@/lib/archive";
import { ADMIN_REQUEST_TYPE } from "@/lib/labels";
import { buildRef } from "@/lib/refs";
import type { ActionResult } from "@/lib/actions/types";
import { ramenerSiPlusDeDemandeDevis } from "@/lib/promo-material/retrait-devis";

export const DENIED: ActionResult = { ok: false, error: "Non autorisé." };

/**
 * Archive une demande administrative TERMINÉE dans le Drive du traitant
 * (« Dossier traité / Bureau du secrétariat ») : récapitulatif + copie des pièces.
 * Une seule fois par demande ; ne fait jamais échouer le traitement.
 */
export async function archiveAdminRequestIfDone(id: string, actorId: string): Promise<void> {
  const req = await prisma.administrativeRequest.findUnique({
    where: { id },
    include: { requester: { select: { name: true } }, assignedTo: { select: { name: true } } },
  });
  if (!req || req.archivedNodeId || req.status !== "DONE") return;

  const docs = await prisma.document.findMany({
    where: { entityType: "ADMIN_REQUEST", entityId: id },
    select: { name: true, fileKey: true, mimeType: true },
  });
  const lines = [
    `Demande administrative — ${req.reference}`,
    `Titre : ${req.title}`,
    `Type : ${ADMIN_REQUEST_TYPE[req.type] ?? req.type}${req.subtype ? ` (${req.subtype})` : ""}`,
    req.requester?.name ? `Demandeur : ${req.requester.name}` : null,
    req.assignedTo?.name ? `Traitée par : ${req.assignedTo.name}` : null,
    req.description ? `Description : ${req.description}` : null,
    `Créée le : ${formatAlgiers(req.createdAt, { day: "2-digit", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" })}`,
    `Terminée le : ${formatAlgiers(req.completedAt ?? new Date(), { day: "2-digit", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" })}`,
  ].filter(Boolean).join("\n");

  const day = new Date().toISOString().slice(0, 10);
  const nodeId = await archiveProcessedRequest({
    bureau: "Bureau du secrétariat",
    folderName: `${day} — ${req.reference} — ${req.title}`,
    summary: lines,
    attachments: docs.map((d) => ({ name: d.name, fileKey: d.fileKey, mimeType: d.mimeType })),
    ownerId: actorId,
  });
  if (nodeId) {
    await prisma.administrativeRequest.update({ where: { id }, data: { archivedNodeId: nodeId } });
    revalidatePath("/drive");
  }
}

/** Référence robuste (dérivée du maximum réel, pas de `count()+1` fragile). */
export async function nextRequestRef(): Promise<string> {
  const year = new Date().getFullYear();
  const refs = await prisma.administrativeRequest.findMany({
    where: { reference: { startsWith: `REQ-${year}-` } },
    select: { reference: true },
  });
  return buildRef("REQ", year, refs.map((r) => r.reference));
}

/**
 * UNE DEMANDE TERMINÉE OU ANNULÉE NE SE TRAITE PLUS (§118.187 — audit 360°, R08). Depuis qu'un demandeur
 * peut annuler sa demande au-delà de trente minutes, une demande annulée reste VISIBLE au bureau (elle
 * n'est plus effacée) : « Commencer », « Demander une validation » et « Fin de la demande » l'auraient
 * ressuscitée, ou payée. Une demande TERMINÉE se rouvre par `rouvrirDemande`, avec son motif ; une
 * demande ANNULÉE ne se rouvre pas (§118.191) — ce qui en dépendait a été retiré avec elle.
 */
/** Une demande qui se TRAITE encore — la condition de toute écriture qui la fait avancer (§118.187). */
export const OUVERTE = { deletedAt: null, status: { notIn: ["DONE", "CANCELLED"] as AdminRequestStatus[] } } satisfies Prisma.AdministrativeRequestWhereInput;
export const DEMANDE_CHANGEE = "Cette demande vient d'être annulée ou terminée : rouvrez-la pour voir où elle en est.";

export function refusDemandeClose(status: AdminRequestStatus): string | null {
  if (status === "CANCELLED") return "Cette demande a été annulée : elle ne se traite plus, et ne se rouvre pas — déposez-en une nouvelle.";
  if (status === "DONE") return "Cette demande est terminée : elle ne se traite plus. Si elle doit reprendre, rouvrez-la (« Rouvrir », avec son motif).";
  return null;
}

export function isManager(user: SessionUser, assignedToId: string | null): boolean {
  return hasGlobalView(user.role) || userCan(user, "ADMIN_REQUESTS", "UPDATE") || assignedToId === user.id;
}

/**
 * UNE DEMANDE DE DEVIS DE MATÉRIEL PROMOTIONNEL RETIRÉE D'ICI (audit du 04/10, constat 35) : annulée par le
 * secrétariat, par son demandeur, ou supprimée — et que plus aucune demande de devis ne vit pour ce dossier,
 * il revient à l'étape d'avant au lieu de rester « devis demandés » pour toujours. Toutes les portes qui
 * retirent une demande d'ici l'appellent : en oublier une rouvrirait la porte d'à côté (§118.71).
 */
export async function apresRetraitDevisPromo(
  req: { linkedEntityType: string | null; linkedEntityId: string | null; type: string }, auteurId: string, motif: string,
): Promise<void> {
  if (req.linkedEntityType !== "PROMO_MATERIAL" || !req.linkedEntityId || req.type !== "QUOTE") return;
  const r = await ramenerSiPlusDeDemandeDevis(req.linkedEntityId, auteurId, motif);
  if (r.ramene) revalidatePath(`/promo-material/${req.linkedEntityId}`);
}

/** La phrase d'une validation dont la demande a été annulée — dite avant comme après la prise. */
export const VALIDATION_SANS_OBJET = "Cette demande a été annulée : la validation n'a plus d'objet.";

export const jour = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
export const enTexte = (f: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(f).filter(([, v]) => typeof v === "string" || typeof v === "number").map(([k, v]) => [k, String(v)]));

/** La fiche, la liste et le bureau de l'assistante : ce qu'un geste sur une demande rafraîchit. */
export function rafraichirLaDemande(id: string): void {
  revalidatePath(`/demandes/${id}`);
  revalidatePath("/demandes");
  revalidatePath("/demandes/assistant");
}

/** Les participants ajoutés par le demandeur, ceux qui sont encore actifs. */
export async function participantsActifs(participantIds: string[]): Promise<string[]> {
  return participantIds.length
    ? (await prisma.user.findMany({ where: { id: { in: participantIds }, isActive: true }, select: { id: true } })).map((u) => u.id)
    : [];
}
