import { prisma } from "@/lib/prisma";
import {
  requestApproval, decideApproval, toggleMissionStop, updateMission,
  editOwnRequest, deleteOwnRequest, deleteRequests, restoreRequest,
  startRequestProcessing, requestFinanceValidation, requestInternalValidation, finishRequest,
  submitAttachmentValidation, cancelAttachmentValidation,
} from "@/lib/actions/admin-request-actions";
import { createPurchaseRequest, withdrawPurchaseRequest } from "@/lib/actions/purchase-request-actions";
import type { OpImpl, OpProposalDraft } from "./types";
import { opStr } from "./types";
import { runFd, fieldsOf, isoDate, dzd } from "./helpers";
import { matchLabel, fold } from "./impl-regulatory";

/**
 * OPS VAGUE 7 — DEMANDES ADMINISTRATIVES de bout en bout : validation hiérarchique (demande +
 * décision qui émet l'ordre de dépense au montant accordé), missions chauffeur DÉJÀ posées (points de
 * passage, statuts, preuve — on n'en crée plus, ni de lot de demandes : Direction, 10/2026), fenêtre demandeur 30 min (édition
 * FUSION, retrait), suppression TRAÇABLE à motif + restauration, flux assistante (traitement,
 * validation Finances / interne, FIN de demande avec facture exigée et imputation moyens
 * généraux), pièces jointes soumises à validation UNE PAR UNE (retirables), et l'ACHAT depuis
 * les Moyens généraux (validateur = N+1 d'organigramme, jamais choisi ; retrait avant décision).
 * Par les ACTIONS CANONIQUES.
 */

const APPROVAL_DECISION_FR: [string, string][] = [
  ["APPROVED", "Approuver"], ["REJECTED", "Refuser"], ["CHANGES_REQUESTED", "Demander une modification"],
];
const MISSION_STATUS_FR: [string, string][] = [
  ["NEW", "Nouvelle"], ["ACCEPTED", "Acceptée"], ["EN_ROUTE", "En route"],
  ["DONE", "Terminée"], ["PROBLEM", "Problème"], ["CANCELLED", "Annulée"],
];

async function wave7User(raw: string): Promise<{ id: string; name: string } | { error: string }> {
  const q = raw.trim();
  if (!q) return { error: "Précisez la personne (nom)." };
  const rows = await prisma.user.findMany({
    where: { name: { contains: q, mode: "insensitive" }, isActive: true },
    select: { id: true, name: true }, take: 6,
  });
  if (rows.length === 1) return rows[0];
  if (rows.length === 0) return { error: `Aucun utilisateur actif « ${q} ».` };
  return { error: `Plusieurs personnes correspondent : ${rows.map((u) => u.name).join(", ")} — préciser.` };
}

interface AdminReqHit { id: string; reference: string; title: string }

async function resolveAdminRequest(raw: string, opts?: { deleted?: boolean }): Promise<AdminReqHit | { error: string }> {
  const q = raw.trim();
  if (!q) return { error: "Précisez la demande (champ « target » — référence REQ-… ou objet)." };
  const deletedFilter = opts?.deleted ? { deletedAt: { not: null } } : { deletedAt: null };
  const exact = await prisma.administrativeRequest.findFirst({
    where: { reference: { equals: q, mode: "insensitive" }, ...deletedFilter },
    select: { id: true, reference: true, title: true },
  });
  if (exact) return exact;
  const rows = await prisma.administrativeRequest.findMany({
    where: {
      OR: [{ title: { contains: q, mode: "insensitive" } }, { reference: { contains: q, mode: "insensitive" } }],
      ...deletedFilter,
    },
    select: { id: true, reference: true, title: true },
    orderBy: { createdAt: "desc" }, take: 6,
  });
  if (rows.length === 1) return rows[0];
  if (rows.length === 0) return { error: `Aucune demande${opts?.deleted ? " supprimée" : ""} « ${q} ».` };
  return { error: `Plusieurs demandes correspondent : ${rows.map((r) => `${r.reference} — ${r.title}`).join(" ; ")} — donner la référence.` };
}

interface MissionHit { id: string; title: string }

async function resolveMission(raw: string): Promise<MissionHit | { error: string }> {
  const q = raw.trim();
  if (!q) return { error: "Précisez la course (champ « target » — son titre)." };
  const rows = await prisma.driverMission.findMany({
    where: { title: { contains: q, mode: "insensitive" } },
    select: { id: true, title: true, status: true },
    orderBy: { createdAt: "desc" }, take: 6,
  });
  const open = rows.filter((m) => m.status !== "DONE" && m.status !== "CANCELLED");
  const pick = open.length === 1 ? open[0] : rows.length === 1 ? rows[0] : null;
  if (pick) return { id: pick.id, title: pick.title };
  if (rows.length === 0) return { error: `Aucune course « ${q} ».` };
  return { error: `Plusieurs courses correspondent : ${rows.map((m) => m.title).join(" ; ")} — préciser.` };
}

export const ADMIN_REQUEST_OPS_IMPL: Record<string, OpImpl> = {
  request_approval: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const req = await resolveAdminRequest(opStr(input, "target"));
      if ("error" in req) return req;
      const validator = await wave7User(opStr(input, "person"));
      if ("error" in validator) return validator;
      return {
        title: `Demander la validation de ${req.reference} à ${validator.name}`,
        fields: fieldsOf([
          ["Demande", `${req.reference} — ${req.title}`],
          ["Validateur", validator.name],
          ["Montant", opStr(input, "amount") ? dzd(Number(opStr(input, "amount"))) : null],
          ["Commentaire", opStr(input, "note") || null],
        ]),
        warnings: ["La demande passe « en attente de validation » — à l'approbation, un MONTANT saisi émettra l'ordre de dépense correspondant."],
        args: { requestId: req.id, validatorId: validator.id, amount: opStr(input, "amount") || null, comment: opStr(input, "note") || null },
        successMessage: `Validation de ${req.reference} demandée à ${validator.name}.`,
        revalidate: ["/demandes", "/demandes/approvals"],
      };
    },
    execute: (args) => runFd(requestApproval, args, "La demande de validation a été refusée.", { revalidate: ["/demandes"] }),
  },

  decide_approval: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const req = await resolveAdminRequest(opStr(input, "target"));
      if ("error" in req) return req;
      const m = matchLabel(opStr(input, "decision"), APPROVAL_DECISION_FR);
      if (typeof m === "object") return m;
      const approvals = await prisma.adminApproval.findMany({
        where: { requestId: req.id, status: "PENDING" },
        select: { id: true, amount: true, validator: { select: { name: true } } },
        orderBy: { createdAt: "desc" }, take: 3,
      });
      if (approvals.length === 0) return { error: `${req.reference} n'a aucune validation en attente.` };
      // L'action exige le motif d'un refus ou d'une demande de modification (lot E5, M15) : une carte sans lui
      // serait refusée après le clic (§118.83).
      if (m !== "APPROVED" && !opStr(input, "note")) return { error: "Un refus ou une demande de modification se motive (champ « note ») : c'est ce que lira le demandeur." };
      const pick = approvals[0];
      void user;
      return {
        title: `${APPROVAL_DECISION_FR.find(([c]) => c === m)?.[1]} — ${req.reference}`,
        fields: fieldsOf([
          ["Demande", `${req.reference} — ${req.title}`],
          ["Validateur saisi", pick.validator?.name ?? "—"],
          ["Montant en jeu", pick.amount != null ? dzd(Number(pick.amount)) : null],
          ["Commentaire", opStr(input, "note") || null],
        ]),
        warnings: m === "APPROVED" && pick.amount != null && Number(pick.amount) > 0
          ? [`L'APPROBATION émet l'ordre de dépense de ${dzd(Number(pick.amount))} vers les Finances et passe la demande « en attente de paiement ».`]
          : m === "REJECTED"
            ? ["Le refus BLOQUE la demande — le demandeur et le traitant sont notifiés."]
            : ["Réservé au validateur saisi, au droit Valider du module, ou à la vue globale (revérifié par l'action)."],
        args: { approvalId: pick.id, decision: m, comment: opStr(input, "note") || null },
        successMessage: `${req.reference} : ${APPROVAL_DECISION_FR.find(([c]) => c === m)?.[1]}.`,
        revalidate: ["/demandes", "/demandes/approvals", "/finances/paiements-a-faire"],
      };
    },
    execute: (args) => runFd(decideApproval, args, "La décision a été refusée.", { revalidate: ["/demandes"] }),
  },

  toggle_mission_stop: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const mission = await resolveMission(opStr(input, "target") || opStr(input, "label"));
      if ("error" in mission) return mission;
      const q = fold(opStr(input, "location") || opStr(input, "name"));
      const stops = await prisma.driverMissionStop.findMany({
        where: { missionId: mission.id },
        select: { id: true, location: true, done: true },
        orderBy: { position: "asc" },
      });
      if (stops.length === 0) return { error: `« ${mission.title} » n'a aucun point de passage.` };
      const hits = q ? stops.filter((s) => fold(s.location).includes(q)) : stops;
      if (hits.length === 0) return { error: `Aucun point « ${opStr(input, "location")} » — points : ${stops.map((s) => s.location).join(" → ")}.` };
      if (hits.length > 1) return { error: `Plusieurs points correspondent : ${hits.map((s) => s.location).join(", ")} — préciser (champ « location »).` };
      return {
        title: `${hits[0].done ? "Décocher" : "Cocher"} le point « ${hits[0].location} » (${mission.title})`,
        fields: [{ label: "Point", value: `${hits[0].location} — ${hits[0].done ? "fait → à faire" : "à faire → fait"}` }],
        args: { id: hits[0].id },
        successMessage: `Point « ${hits[0].location} » ${hits[0].done ? "décoché" : "coché"}.`,
        revalidate: ["/demandes/driver", "/demandes/courses"],
      };
    },
    execute: (args) => runFd(toggleMissionStop, args, "Le point n'a pas pu être basculé.", { revalidate: ["/demandes/driver"] }),
  },

  update_mission: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const mission = await resolveMission(opStr(input, "target") || opStr(input, "label"));
      if ("error" in mission) return mission;
      const m = matchLabel(opStr(input, "status"), MISSION_STATUS_FR);
      if (typeof m === "object") return m;
      return {
        title: `Course « ${mission.title} » → ${MISSION_STATUS_FR.find(([c]) => c === m)?.[1]}`,
        fields: fieldsOf([
          ["Course", mission.title],
          ["Statut", MISSION_STATUS_FR.find(([c]) => c === m)?.[1] ?? m],
          ["Commentaire / preuve", opStr(input, "note") || null],
        ]),
        warnings: m === "DONE" || m === "PROBLEM"
          ? ["Le traitant de la demande liée est prévenu — la preuve (commentaire) reste sur la course."]
          : ["Geste du chauffeur assigné ou d'un gestionnaire (revérifié par l'action)."],
        args: { id: mission.id, status: m, proofComment: opStr(input, "note") || null },
        successMessage: `Course « ${mission.title} » : ${MISSION_STATUS_FR.find(([c]) => c === m)?.[1]}.`,
        revalidate: ["/demandes/driver", "/demandes/courses"],
      };
    },
    execute: (args) => runFd(updateMission, args, "Le changement de statut a été refusé.", { revalidate: ["/demandes/driver"] }),
  },

  edit_own_request: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const req = await resolveAdminRequest(opStr(input, "target"));
      if ("error" in req) return req;
      const cur = await prisma.administrativeRequest.findUnique({
        where: { id: req.id },
        select: { title: true, description: true, priority: true, deadline: true, requesterId: true, createdAt: true },
      });
      if (!cur) return { error: "Demande introuvable." };
      if (cur.requesterId !== user.id) return { error: `${req.reference} n'est pas votre demande — seule la vôtre se modifie.` };
      // FUSION : titre, description, priorité et échéance sont REMPLACÉS — rejoués si non donnés.
      return {
        title: `Modifier MA demande ${req.reference}`,
        fields: fieldsOf([
          ["Demande", `${req.reference} — ${cur.title}`],
          ["Nouveau titre", opStr(input, "newName") || null],
          ["Description", opStr(input, "notes") || (cur.description ? "(rejouée)" : null)],
          ["Règle", "tant qu'elle n'est ni terminée ni annulée ; après 30 minutes, l'assistante est prévenue"],
        ]),
        args: {
          id: req.id,
          title: opStr(input, "newName") || cur.title,
          description: opStr(input, "notes") || cur.description || null,
          priority: cur.priority,
          deadline: isoDate(opStr(input, "date")) || (cur.deadline ? cur.deadline.toISOString().slice(0, 10) : null),
        },
        successMessage: `${req.reference} modifiée.`,
        revalidate: ["/demandes"],
      };
    },
    execute: (args) => runFd(editOwnRequest, args, "La modification a été refusée.", { revalidate: ["/demandes"] }),
  },

  delete_own_request: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const req = await resolveAdminRequest(opStr(input, "target"));
      if ("error" in req) return req;
      const cur = await prisma.administrativeRequest.findUnique({ where: { id: req.id }, select: { requesterId: true } });
      if (cur?.requesterId !== user.id) return { error: `${req.reference} n'est pas votre demande.` };
      return {
        title: `Retirer MA demande ${req.reference}`,
        fields: [{ label: "Demande", value: `${req.reference} — ${req.title}` }],
        warnings: ["Dans les 30 minutes et avant traitement : suppression douce TRACÉE. Au-delà : la demande est ANNULÉE avec son motif (à donner), l'assistante prévenue."],
        args: { id: req.id, motif: opStr(input, "notes") || null },
        successMessage: `${req.reference} retirée.`,
        revalidate: ["/demandes"],
      };
    },
    execute: (args) => runFd(deleteOwnRequest, args, "Le retrait a été refusé.", { revalidate: ["/demandes"] }),
  },

  delete_requests: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const reason = opStr(input, "note") || opStr(input, "reason");
      if (!reason) return { error: "Le MOTIF de suppression est obligatoire (champ « note ») — traçabilité." };
      const refs = (opStr(input, "target") || opStr(input, "cells")).split(/[;,\n]/).map((s) => s.trim()).filter(Boolean);
      if (refs.length === 0) return { error: "Listez les demandes à supprimer (champ « target » — références, virgules)." };
      const ids: string[] = []; const shown: string[] = [];
      for (const ref of refs) {
        const req = await resolveAdminRequest(ref);
        if ("error" in req) return req;
        if (!ids.includes(req.id)) { ids.push(req.id); shown.push(req.reference); }
      }
      return {
        title: `Supprimer ${ids.length} demande(s) — motif tracé`,
        fields: [
          { label: "Demandes", value: shown.join(", ") },
          { label: "Motif", value: reason },
        ],
        warnings: ["Suppression DOUCE (restaurable par restore_request) — le motif est journalisé sur chaque demande."],
        confirmText: `${ids.length} demandes`,
        args: { ids: ids.join(","), reason },
        successMessage: `${ids.length} demande(s) supprimée(s) (motif tracé).`,
        revalidate: ["/demandes", "/demandes/assistant"],
      };
    },
    execute: (args) => runFd(deleteRequests, args, "La suppression a été refusée.", { revalidate: ["/demandes"] }),
  },

  restore_request: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const req = await resolveAdminRequest(opStr(input, "target"), { deleted: true });
      if ("error" in req) return req;
      return {
        title: `Restaurer la demande ${req.reference}`,
        fields: [{ label: "Demande", value: `${req.reference} — ${req.title}` }],
        warnings: ["La demande revient « nouvelle » (motif de suppression effacé) — assistante / vue globale."],
        args: { id: req.id },
        successMessage: `${req.reference} restaurée.`,
        revalidate: ["/demandes", "/demandes/assistant"],
      };
    },
    execute: (args) => runFd(restoreRequest, args, "La restauration a été refusée.", { revalidate: ["/demandes"] }),
  },

  start_request_processing: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const req = await resolveAdminRequest(opStr(input, "target"));
      if ("error" in req) return req;
      return {
        title: `Commencer le traitement de ${req.reference}`,
        fields: [{ label: "Demande", value: `${req.reference} — ${req.title}` }],
        warnings: ["Passe la demande « en cours » et FIGE la fenêtre de modification du demandeur."],
        args: { id: req.id },
        successMessage: `Traitement de ${req.reference} démarré.`,
        revalidate: ["/demandes", "/demandes/assistant"],
      };
    },
    execute: (args) => runFd(startRequestProcessing, args, "Le démarrage a été refusé.", { revalidate: ["/demandes"] }),
  },

  request_finance_validation: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const req = await resolveAdminRequest(opStr(input, "target"));
      if ("error" in req) return req;
      let v1: { id: string; name: string } | null = null;
      let v2: { id: string; name: string } | null = null;
      if (opStr(input, "person")) {
        const u = await wave7User(opStr(input, "person"));
        if ("error" in u) return u;
        v1 = u;
      }
      if (opStr(input, "person2")) {
        const u = await wave7User(opStr(input, "person2"));
        if ("error" in u) return u;
        v2 = u;
      }
      return {
        title: `Validation FINANCES pour ${req.reference} (flux achat)`,
        fields: fieldsOf([
          ["Demande", `${req.reference} — ${req.title}`],
          ["Validateurs", v1 ? [v1.name, v2?.name].filter(Boolean).join(", ") : "tous les responsables Finances (défaut)"],
          ["Montant estimé", opStr(input, "amount") ? dzd(Number(opStr(input, "amount"))) : null],
          ["Note", opStr(input, "note") || null],
        ]),
        warnings: ["Va-et-vient possible : après un refus ou une demande de modification, une NOUVELLE validation peut repartir."],
        args: {
          id: req.id, validatorId: v1?.id ?? null, validator2Id: v2?.id ?? null,
          amount: opStr(input, "amount") || null, comment: opStr(input, "note") || null,
        },
        successMessage: `Validation Finances demandée pour ${req.reference}.`,
        revalidate: ["/demandes", "/validations"],
      };
    },
    execute: (args) => runFd(requestFinanceValidation, args, "La demande de validation Finances a été refusée.", { revalidate: ["/demandes"] }),
  },

  request_internal_validation: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const req = await resolveAdminRequest(opStr(input, "target"));
      if ("error" in req) return req;
      const v1 = await wave7User(opStr(input, "person"));
      if ("error" in v1) return { error: `Validateur : ${v1.error} (champ « person » — obligatoire hors flux achat)` };
      let v2: { id: string; name: string } | null = null;
      if (opStr(input, "person2")) {
        const u = await wave7User(opStr(input, "person2"));
        if ("error" in u) return u;
        v2 = u;
      }
      return {
        title: `Validation interne pour ${req.reference} → ${[v1.name, v2?.name].filter(Boolean).join(", ")}`,
        fields: fieldsOf([
          ["Demande", `${req.reference} — ${req.title}`],
          ["Validateurs", [v1.name, v2?.name].filter(Boolean).join(", ")],
          ["Note", opStr(input, "note") || null],
        ]),
        args: { id: req.id, validatorId: v1.id, validator2Id: v2?.id ?? null, comment: opStr(input, "note") || null },
        successMessage: `Validation interne demandée pour ${req.reference}.`,
        revalidate: ["/demandes", "/validations"],
      };
    },
    execute: (args) => runFd(requestInternalValidation, args, "La demande de validation interne a été refusée.", { revalidate: ["/demandes"] }),
  },

  finish_request: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const req = await resolveAdminRequest(opStr(input, "target"));
      if ("error" in req) return req;
      const cur = await prisma.administrativeRequest.findUnique({ where: { id: req.id }, select: { type: true } });
      let departmentId: string | null = null; let deptShown: string | null = null;
      const deptRaw = opStr(input, "department");
      if (deptRaw) {
        const rows = await prisma.department.findMany({
          where: { name: { contains: deptRaw, mode: "insensitive" } },
          select: { id: true, name: true }, take: 6,
        });
        if (rows.length === 0) return { error: `Aucun département « ${deptRaw} ».` };
        if (rows.length > 1) return { error: `Plusieurs départements correspondent : ${rows.map((d) => d.name).join(", ")} — préciser.` };
        departmentId = rows[0].id; deptShown = rows[0].name;
      }
      const amount = opStr(input, "amount");
      return {
        title: `FIN de la demande ${req.reference}`,
        fields: fieldsOf([
          ["Demande", `${req.reference} — ${req.title}`],
          ["Budget débité", deptShown ? `Moyens généraux de ${deptShown}` : null],
          ["Montant réel", amount ? dzd(Number(amount)) : null],
        ]),
        warnings: cur?.type === "PURCHASE"
          ? ["Pour un ACHAT : la facture finale doit être jointe — fichier « Facture » sur la demande, facture au registre (Pièces liées → Facture, ou qui suit un bon de commande de la demande) avec son PDF, ou facture de l'un de ses ordres —, et l'IMPUTATION aux moyens généraux (département + montant réel) est exigée — sauf demande déjà imputée ou issue d'Ad & Pro (déjà portée par son budget)."]
          : ["Clôt la demande (statut Terminée, horodaté)."],
        args: { id: req.id, budgetDepartmentId: departmentId, budgetAmount: amount || null, budgetNote: opStr(input, "note") || null },
        successMessage: `${req.reference} terminée.`,
        revalidate: ["/demandes", "/moyens-generaux", "/budgets/departements"],
      };
    },
    execute: (args) => runFd(finishRequest, args, "La clôture a été refusée.", { revalidate: ["/demandes"] }),
  },

  submit_attachment_validation: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const req = await resolveAdminRequest(opStr(input, "target"));
      if ("error" in req) return req;
      const pieceRaw = opStr(input, "label");
      const docs = await prisma.document.findMany({
        where: { entityType: "ADMIN_REQUEST", entityId: req.id },
        select: { id: true, name: true }, take: 20,
      });
      if (docs.length === 0) return { error: `${req.reference} n'a aucune pièce jointe.` };
      const hits = pieceRaw ? docs.filter((d) => fold(d.name).includes(fold(pieceRaw))) : docs;
      if (hits.length === 0) return { error: `Aucune pièce « ${pieceRaw} » — pièces : ${docs.map((d) => d.name).join(" ; ")}.` };
      if (hits.length > 1) return { error: `Plusieurs pièces correspondent : ${hits.map((d) => d.name).join(" ; ")} — préciser (champ « label »).` };
      const names = (opStr(input, "people") || opStr(input, "person")).split(/[;,]/).map((s) => s.trim()).filter(Boolean);
      if (names.length === 0) return { error: "Choisissez le(s) validateur(s) (champ « people » — noms, virgules)." };
      const ids: string[] = []; const shown: string[] = [];
      for (const n of names) {
        const u = await wave7User(n);
        if ("error" in u) return u;
        if (!ids.includes(u.id)) { ids.push(u.id); shown.push(u.name); }
      }
      return {
        title: `Soumettre la pièce « ${hits[0].name} » à validation (${req.reference})`,
        fields: fieldsOf([
          ["Pièce", hits[0].name],
          ["Validateurs (parallèle)", shown.join(", ")],
          ["Montant", opStr(input, "amount") ? dzd(Number(opStr(input, "amount"))) : null],
          ["Note", opStr(input, "note") || null],
        ]),
        warnings: ["Chaque pièce se soumet À PART, en PARALLÈLE — être validateur d'une pièce ouvre l'accès à toute la demande ; avec un MONTANT, l'approbation émettra l'ordre de dépense. Une pièce déjà en cours de validation est refusée."],
        args: {
          requestId: req.id, documentId: hits[0].id, validatorIds: ids.join(","),
          note: opStr(input, "note") || null, amount: opStr(input, "amount") || null,
        },
        successMessage: `Pièce « ${hits[0].name} » soumise à ${ids.length} validateur(s).`,
        revalidate: ["/demandes", "/validations", "/mon-travail"],
      };
    },
    async execute(args) {
      const fd = new FormData();
      fd.set("requestId", args.requestId ?? "");
      fd.set("documentId", args.documentId ?? "");
      if (args.note) fd.set("note", args.note);
      if (args.amount) fd.set("amount", args.amount);
      for (const vid of (args.validatorIds ?? "").split(",").filter(Boolean)) fd.append("validatorIds", vid);
      const r = await submitAttachmentValidation(fd);
      if (!r.ok) return { ok: false, error: r.error ?? "La soumission de la pièce a été refusée." };
      return { ok: true, revalidate: ["/demandes", "/validations"] };
    },
  },

  cancel_attachment_validation: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const req = await resolveAdminRequest(opStr(input, "target"));
      if ("error" in req) return req;
      const rows = await prisma.validationRequest.findMany({
        where: { entityType: "ADMIN_REQUEST", entityId: req.id, status: "PENDING", documentId: { not: null } },
        select: { id: true, reference: true, documentId: true },
        take: 10,
      });
      if (rows.length === 0) return { error: `${req.reference} n'a aucune validation de pièce en cours.` };
      // documentId est un scalaire SANS relation Prisma : les noms des pièces se résolvent à part.
      const docIds = rows.map((v) => v.documentId).filter((x): x is string => Boolean(x));
      const docNames = new Map(
        (await prisma.document.findMany({ where: { id: { in: docIds } }, select: { id: true, name: true } })).map((d) => [d.id, d.name]),
      );
      const pending = rows.map((v) => ({ ...v, docName: (v.documentId ? docNames.get(v.documentId) : null) ?? null }));
      const q = fold(opStr(input, "label"));
      const hits = q ? pending.filter((v) => fold(v.docName ?? "").includes(q)) : pending;
      if (hits.length === 0) return { error: `Aucune validation en cours sur une pièce « ${opStr(input, "label")} » — en cours : ${pending.map((v) => v.docName ?? v.reference).join(" ; ")}.` };
      if (hits.length > 1) return { error: `Plusieurs validations en cours : ${hits.map((v) => v.docName ?? v.reference).join(" ; ")} — préciser (champ « label »).` };
      return {
        title: `Retirer la validation de la pièce « ${hits[0].docName ?? hits[0].reference} »`,
        fields: [{ label: "Pièce", value: `${hits[0].docName ?? "—"} (${hits[0].reference} · ${req.reference})` }],
        warnings: ["Statut ANNULÉ (trace conservée) — les validateurs encore saisis sont prévenus, la pièce redevient soumissible."],
        args: { validationId: hits[0].id },
        successMessage: "Validation de pièce retirée.",
        revalidate: ["/demandes", "/validations"],
      };
    },
    async execute(args) {
      const fd = new FormData();
      fd.set("validationId", args.validationId ?? "");
      const r = await cancelAttachmentValidation(fd);
      if (!r.ok) return { ok: false, error: r.error ?? "Le retrait a été refusé." };
      return { ok: true, revalidate: ["/demandes", "/validations"] };
    },
  },

  // ───────── Achat depuis les Moyens généraux ─────────
  create_purchase_request: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const raw = opStr(input, "cells") || opStr(input, "notes") || opStr(input, "label");
      const lines = raw.split(/[;\n]/).map((s) => s.trim()).filter(Boolean).map((l) => {
        // « article x3 » ou « article ×3 » — la quantité colle à la fin, défaut 1.
        const m = l.match(/^(.*?)\s*[x×]\s*(\d+)$/i);
        return { label: (m ? m[1] : l).trim(), quantity: m ? Number(m[2]) : 1 };
      });
      if (lines.length === 0) return { error: "Listez les articles (champ « cells » — « ramette A4 x3 ; toner » )." };
      void user;
      return {
        title: `Demande d'achat — ${lines.length} article(s)`,
        fields: fieldsOf([
          ["Articles", lines.map((l) => `${l.label} ×${l.quantity}`).join(" ; ")],
          ["Objet", opStr(input, "name") || null],
          ["Description", opStr(input, "message") || null],
        ]),
        warnings: ["Le validateur NE SE CHOISIT PAS : c'est votre responsable hiérarchique (organigramme) — sans responsable rattaché à votre fiche, la demande est refusée."],
        args: { lines: JSON.stringify(lines), title: opStr(input, "name") || null, description: opStr(input, "message") || null },
        successMessage: "Demande d'achat envoyée à votre responsable.",
        revalidate: ["/moyens-generaux", "/demandes"],
      };
    },
    async execute(args) {
      const fd = new FormData();
      fd.set("lines", args.lines ?? "[]");
      if (args.title) fd.set("title", args.title);
      if (args.description) fd.set("description", args.description);
      const r = await createPurchaseRequest(undefined, fd);
      if (!r.ok) return { ok: false, error: r.error ?? "La demande d'achat a été refusée." };
      return { ok: true, revalidate: ["/moyens-generaux"] };
    },
  },

  withdraw_purchase_request: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const req = await resolveAdminRequest(opStr(input, "target"));
      if ("error" in req) return req;
      const cur = await prisma.administrativeRequest.findUnique({ where: { id: req.id }, select: { requesterId: true } });
      if (cur?.requesterId !== user.id) return { error: `${req.reference} n'est pas votre demande — seul l'auteur retire son achat.` };
      return {
        title: `Retirer MA demande d'achat ${req.reference}`,
        fields: [{ label: "Demande", value: `${req.reference} — ${req.title}` }],
        warnings: ["Possible tant que le directeur n'a PAS tranché — ensuite, la demande appartient au circuit (l'action refuse)."],
        args: { id: req.id },
        successMessage: `${req.reference} retirée (annulée).`,
        revalidate: ["/moyens-generaux", "/demandes/approvals"],
      };
    },
    execute: (args) => runFd(withdrawPurchaseRequest, args, "Le retrait a été refusé (déjà tranché ?).", { revalidate: ["/moyens-generaux"] }),
  },
};
