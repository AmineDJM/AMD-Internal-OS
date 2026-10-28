import type { HrRequestStatus } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { formatAlgiers } from "@/lib/calendar-tz";
import { formatMonth } from "@/lib/utils";
import { archiveProcessedRequest } from "@/lib/archive";
import { getBlob } from "@/lib/drive-storage";
import { HR_REQUEST_TYPE, HR_REQUEST_STATUS } from "@/lib/labels";

/**
 * L'ARCHIVE D'UNE DEMANDE RH TRAITÉE — sortie de `actions-documents.ts` (clé `hr-document-actions`)
 * sans rien y changer : six actions l'appellent après avoir posé l'état, et un fichier `"use server"`
 * n'exporte que des actions. Pas de contrôle d'accès ici : ses appelants l'ont fait.
 */

/** Statuts « traités » : la demande part alors dans la boîte « Dossier traité » du Drive. */
const DONE_STATUSES: HrRequestStatus[] = ["READY", "DELIVERED", "APPROVED", "REJECTED"];

/**
 * Archive une demande RH TRAITÉE dans le Drive du traitant (« Dossier traité / RH ») :
 * récapitulatif + copie des pièces jointes + document déposé en réponse. Une seule fois
 * par demande ; ne fait jamais échouer le traitement.
 */
export async function archiveHrRequestIfDone(id: string, actorId: string): Promise<void> {
  const req = await prisma.hrDocumentRequest.findUnique({
    where: { id },
    include: { employee: { select: { fullName: true } }, fulfilment: { select: { name: true, mime: true, blobId: true } } },
  });
  if (!req || req.archivedNodeId || !DONE_STATUSES.includes(req.status)) return;

  const docs = await prisma.document.findMany({
    where: { entityType: "HR_REQUEST", entityId: id },
    select: { name: true, fileKey: true, mimeType: true },
  });
  const lines = [
    `Demande RH — ${HR_REQUEST_TYPE[req.type] ?? req.type}`,
    `Employé : ${req.employee.fullName}`,
    `Statut : ${HR_REQUEST_STATUS[req.status]?.label ?? req.status}`,
    `Demandée le : ${formatAlgiers(req.createdAt, { day: "2-digit", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" })}`,
    req.details ? `Précisions : ${req.details}` : null,
    req.hrNote ? `Note RH : ${req.hrNote}` : null,
    req.expenseMonth ? `Mois concerné : ${formatMonth(req.expenseMonth)}` : null,
    req.approvedMonth ? `Validée pour : ${formatMonth(req.approvedMonth)}` : null,
    req.periodStart ? `Période : du ${formatAlgiers(req.periodStart, { day: "2-digit", month: "long", year: "numeric" })}${req.periodEnd ? ` au ${formatAlgiers(req.periodEnd, { day: "2-digit", month: "long", year: "numeric" })}` : ""}${req.periodDays ? ` (${Number(req.periodDays)} j)` : ""}` : null,
    req.originalsAckAt ? `Originaux réceptionnés le : ${formatAlgiers(req.originalsAckAt, { day: "2-digit", month: "long", year: "numeric" })}` : null,
    req.meetingAt ? `Entrevue : ${formatAlgiers(req.meetingAt, { weekday: "long", day: "2-digit", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" })}${req.meetingConfirmedAt ? " (confirmée)" : ""}` : null,
    `Traitée le : ${formatAlgiers(new Date(), { day: "2-digit", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" })}`,
  ].filter(Boolean).join("\n");

  // Document RH déposé en réponse (stockage chiffré du Drive RH).
  const extraFiles: { name: string; content: Buffer; mimeType?: string | null }[] = [];
  if (req.fulfilment) {
    try {
      const buf = await getBlob(req.fulfilment.blobId);
      if (buf) extraFiles.push({ name: req.fulfilment.name, content: buf, mimeType: req.fulfilment.mime });
    } catch { /* pièce illisible : le récapitulatif suffit */ }
  }

  const day = new Date().toISOString().slice(0, 10);
  const nodeId = await archiveProcessedRequest({
    bureau: "RH",
    folderName: `${day} — ${HR_REQUEST_TYPE[req.type] ?? req.type} — ${req.employee.fullName}`,
    summary: lines,
    attachments: docs.map((d) => ({ name: d.name, fileKey: d.fileKey, mimeType: d.mimeType })),
    extraFiles,
    ownerId: actorId,
  });
  if (nodeId) {
    await prisma.hrDocumentRequest.update({ where: { id }, data: { archivedNodeId: nodeId } });
    revalidatePath("/drive");
  }
}
