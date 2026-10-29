/**
 * OPS VAGUE 2b — DEMANDES DE DOCUMENTS transverses, par les actions canoniques.
 */
import { prisma } from "./erp";
import { requestDocument as requestEntityDocument, submitDocumentRequest, decideDocumentRequest, cancelDocumentRequest } from "@/lib/actions/document-request-actions";
import type { OpImpl, OpProposalDraft } from "../../types";
import { opStr } from "../../types";
import { runFd, fieldsOf, isoDate } from "../../helpers";
import { resolvePerson } from "./commun";
import { resolveMissionParent } from "./missions";

export const DOCREQ_OPS_IMPL: Record<string, OpImpl> = {
  request_document: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const person = await resolvePerson(opStr(input, "person"));
      if ("error" in person) return person;
      const label = opStr(input, "label");
      if (!label) return { error: "Précisez la pièce demandée (champ « label » — ex. « Devis signé », « Facture originale »)." };
      // L'action canonique EXIGE l'entité de rattachement : une pièce se demande toujours
      // SUR quelque chose (événement, congrès, sponsoring) — jamais dans le vide.
      const parent = await resolveMissionParent(opStr(input, "kind"), opStr(input, "target"));
      if ("error" in parent) return parent;
      const entityType = parent.entityType; const entityId = parent.entityId; const parentLabel = parent.label;
      return {
        title: `Demander « ${label} » à ${person.name}`,
        fields: fieldsOf([
          ["Pièce", label], ["À", person.name], ["Rattachée à", parentLabel],
          ["Échéance", isoDate(opStr(input, "dueDate"))], ["Note", opStr(input, "note") || null],
        ]),
        args: {
          askedToId: person.id, label, entityType, entityId,
          dueDate: isoDate(opStr(input, "dueDate")), note: opStr(input, "note") || null,
        },
        successMessage: `Pièce « ${label} » demandée à ${person.name}.`,
        revalidate: ["/mon-espace"],
      };
    },
    execute: (args) => runFd(requestEntityDocument, args, "La demande de pièce a été refusée.", { revalidate: ["/mon-espace"] }),
  },

  submit_document_request: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const rows = await prisma.documentRequest.findMany({
        where: { askedToId: user.id, status: "PENDING", ...(opStr(input, "label") ? { label: { contains: opStr(input, "label"), mode: "insensitive" } } : {}) },
        select: { id: true, reference: true, label: true, askedBy: { select: { name: true } } },
        orderBy: { createdAt: "desc" }, take: 6,
      });
      if (rows.length === 0) return { error: `Aucune demande de pièce EN ATTENTE qui vous est adressée${opStr(input, "label") ? ` (« ${opStr(input, "label")} »)` : ""}.` };
      if (rows.length > 1) return { error: `Plusieurs demandes en attente : ${rows.map((r) => `${r.label} (par ${r.askedBy?.name ?? "—"})`).join(" ; ")} — préciser (champ « label »).` };
      return {
        title: `Marquer « ${rows[0].label} » comme transmise`,
        fields: fieldsOf([
          ["Pièce", rows[0].label], ["Demandée par", rows[0].askedBy?.name ?? null],
          ["Note de réponse", opStr(input, "note") || null],
        ]),
        warnings: ["Le demandeur tranchera : pièce acceptée ou refusée."],
        args: { id: rows[0].id, note: opStr(input, "note") || null },
        successMessage: `Pièce « ${rows[0].label} » marquée transmise.`,
        revalidate: ["/mon-espace"],
      };
    },
    execute: (args) => runFd(submitDocumentRequest, args, "La transmission a été refusée.", { revalidate: ["/mon-espace"] }),
  },

  decide_document_request: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const rows = await prisma.documentRequest.findMany({
        where: { askedById: user.id, status: "SUBMITTED", ...(opStr(input, "label") ? { label: { contains: opStr(input, "label"), mode: "insensitive" } } : {}) },
        select: { id: true, label: true, askedTo: { select: { name: true } } },
        orderBy: { createdAt: "desc" }, take: 6,
      });
      if (rows.length === 0) return { error: "Aucune pièce TRANSMISE en attente de votre décision." };
      if (rows.length > 1) return { error: `Plusieurs pièces transmises : ${rows.map((r) => `${r.label} (par ${r.askedTo?.name ?? "—"})`).join(" ; ")} — préciser (champ « label »).` };
      const reject = /refus|rejet|non/i.test(opStr(input, "decision"));
      return {
        title: `${reject ? "Refuser" : "Accepter"} la pièce « ${rows[0].label} »`,
        fields: fieldsOf([
          ["Pièce", rows[0].label], ["Transmise par", rows[0].askedTo?.name ?? null],
          ["Décision", reject ? "Refusée (à reprendre)" : "Acceptée"],
          ["Note", opStr(input, "note") || null],
        ]),
        args: { id: rows[0].id, accept: reject ? "0" : "1", note: opStr(input, "note") || null },
        successMessage: `Pièce « ${rows[0].label} » ${reject ? "refusée" : "acceptée"}.`,
        revalidate: ["/mon-espace"],
      };
    },
    execute: (args) => runFd(decideDocumentRequest, args, "La décision a été refusée.", { revalidate: ["/mon-espace"] }),
  },

  cancel_document_request: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const rows = await prisma.documentRequest.findMany({
        where: { askedById: user.id, status: { in: ["PENDING", "SUBMITTED"] }, ...(opStr(input, "label") ? { label: { contains: opStr(input, "label"), mode: "insensitive" } } : {}) },
        select: { id: true, label: true, askedTo: { select: { name: true } } },
        orderBy: { createdAt: "desc" }, take: 6,
      });
      if (rows.length === 0) return { error: "Aucune demande de pièce en cours de votre part." };
      if (rows.length > 1) return { error: `Plusieurs demandes en cours : ${rows.map((r) => `${r.label} (à ${r.askedTo?.name ?? "—"})`).join(" ; ")} — préciser (champ « label »).` };
      return {
        title: `Annuler la demande « ${rows[0].label} »`,
        fields: [{ label: "Pièce", value: `${rows[0].label} — demandée à ${rows[0].askedTo?.name ?? "—"}` }],
        args: { id: rows[0].id },
        successMessage: `Demande « ${rows[0].label} » annulée.`,
        revalidate: ["/mon-espace"],
      };
    },
    execute: (args) => runFd(cancelDocumentRequest, args, "L'annulation a été refusée.", { revalidate: ["/mon-espace"] }),
  },
};
