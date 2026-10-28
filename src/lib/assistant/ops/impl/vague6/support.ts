/**
 * OPS VAGUE 6a — SUPPORT : demande vers une personne ou un rôle, prise en charge, réponse qui
 * clôt, statut. Par les actions canoniques.
 */
import { prisma } from "./erp";
import { createSupportRequest, takeSupportRequest, answerSupportRequest, updateSupportStatus } from "@/lib/actions/support-actions";
import type { OpImpl, OpProposalDraft } from "../../types";
import { opStr } from "../../types";
import { runFd, runFd2, fieldsOf } from "../../helpers";
import { matchLabel } from "../../impl-regulatory";
import { userByName, ROLE_PAIRS } from "./commun";

// ─────────────────────────── SUPPORT ───────────────────────────

const SUPPORT_STATUS_FR: [string, string][] = [
  ["OPEN", "Ouverte"], ["IN_PROGRESS", "En cours"], ["ANSWERED", "Répondue"], ["CLOSED", "Clôturée"],
];
const SUPPORT_CATEGORY_FR: [string, string][] = [
  ["QUESTION", "Question"], ["SUPPORT_MATERIAL", "Support promotionnel"], ["BROCHURE", "Brochure"],
  ["DOCUMENT", "Document"], ["OTHER", "Autre"],
];

interface SupportHit { id: string; reference: string; subject: string }

async function resolveSupport(raw: string): Promise<SupportHit | { error: string }> {
  const q = raw.trim();
  if (!q) return { error: "Précisez la demande de support (champ « target » — référence SUP-… ou objet)." };
  const exact = await prisma.supportRequest.findFirst({
    where: { reference: { equals: q, mode: "insensitive" } },
    select: { id: true, reference: true, subject: true },
  });
  if (exact) return exact;
  const rows = await prisma.supportRequest.findMany({
    where: { OR: [{ subject: { contains: q, mode: "insensitive" } }, { reference: { contains: q, mode: "insensitive" } }] },
    select: { id: true, reference: true, subject: true },
    orderBy: { createdAt: "desc" }, take: 6,
  });
  if (rows.length === 1) return rows[0];
  if (rows.length === 0) return { error: `Aucune demande de support « ${q} ».` };
  return { error: `Plusieurs demandes correspondent : ${rows.map((r) => `${r.reference} — ${r.subject}`).join(" ; ")} — donner la référence.` };
}

export const SUPPORT_OPS_IMPL: Record<string, OpImpl> = {
  create_support_request: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const subject = opStr(input, "label") || opStr(input, "name");
      const body = opStr(input, "message") || opStr(input, "note");
      if (!subject || !body) return { error: "Objet (champ « label ») et message (champ « message ») sont obligatoires." };
      const personRaw = opStr(input, "person");
      const roleRaw = opStr(input, "role");
      let targetUserId: string | null = null; let targetShown = "";
      let targetRole: string | null = null;
      if (personRaw) {
        const u = await userByName(personRaw);
        if ("error" in u) return u;
        targetUserId = u.id; targetShown = u.name;
      } else if (roleRaw) {
        const m = matchLabel(roleRaw, ROLE_PAIRS);
        if (typeof m === "object") return m;
        targetRole = m; targetShown = `rôle « ${ROLE_PAIRS.find(([c]) => c === m)?.[1] ?? m} »`;
      } else {
        return { error: "Choisissez le destinataire : une personne (champ « person ») ou un rôle (champ « role »)." };
      }
      const catRaw = opStr(input, "kind");
      const category = catRaw ? matchLabel(catRaw, SUPPORT_CATEGORY_FR) : null;
      if (category && typeof category === "object") return category;
      return {
        title: `Demande de support « ${subject} » → ${targetShown}`,
        fields: fieldsOf([
          ["Objet", subject],
          ["Destinataire", targetShown],
          ["Catégorie", category ? SUPPORT_CATEGORY_FR.find(([c]) => c === category)?.[1] ?? null : "Question (défaut)"],
          ["Produit", opStr(input, "product") || null],
          ["Message", body],
        ]),
        args: {
          subject, body, targetUserId, targetRole,
          category: category || null, product: opStr(input, "product") || null,
        },
        successMessage: `Demande de support « ${subject} » envoyée (${targetShown}).`,
        revalidate: ["/support", "/mon-travail"],
      };
    },
    execute: (args) => runFd2(createSupportRequest, args, "La demande de support a été refusée.", { revalidate: ["/support"] }),
  },

  take_support_request: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const r = await resolveSupport(opStr(input, "target"));
      if ("error" in r) return r;
      return {
        title: `Prendre en charge ${r.reference} — ${r.subject}`,
        fields: [{ label: "Demande", value: `${r.reference} — ${r.subject}` }],
        warnings: ["Réservé au DESTINATAIRE (personne ciblée, rôle ciblé ou assigné) — le demandeur est prévenu."],
        args: { id: r.id },
        successMessage: `${r.reference} pris en charge.`,
        revalidate: ["/support"],
      };
    },
    execute: (args) => runFd(takeSupportRequest, args, "La prise en charge a été refusée.", { revalidate: ["/support"] }),
  },

  answer_support_request: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const r = await resolveSupport(opStr(input, "target"));
      if ("error" in r) return r;
      const body = opStr(input, "message") || opStr(input, "note");
      if (!body) return { error: "Écrivez la réponse (champ « message »)." };
      return {
        title: `Répondre à ${r.reference} — ${r.subject}`,
        fields: [{ label: "Demande", value: `${r.reference} — ${r.subject}` }, { label: "Réponse", value: body }],
        warnings: ["La réponse d'un DESTINATAIRE passe la demande « Répondue » (et la lui assigne) ; le demandeur, lui, relance simplement le fil."],
        args: { id: r.id, body },
        successMessage: `Réponse posée sur ${r.reference}.`,
        revalidate: ["/support"],
      };
    },
    execute: (args) => runFd(answerSupportRequest, args, "La réponse a été refusée.", { revalidate: ["/support"] }),
  },

  set_support_status: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const r = await resolveSupport(opStr(input, "target"));
      if ("error" in r) return r;
      const m = matchLabel(opStr(input, "status"), SUPPORT_STATUS_FR);
      if (typeof m === "object") return m;
      return {
        title: `${r.reference} — ${r.subject} → ${SUPPORT_STATUS_FR.find(([c]) => c === m)?.[1]}`,
        fields: [{ label: "Demande", value: `${r.reference} — ${r.subject}` }, { label: "Statut", value: SUPPORT_STATUS_FR.find(([c]) => c === m)?.[1] ?? m }],
        warnings: [m === "CLOSED"
          ? "La clôture est ouverte au demandeur ET au répondant."
          : "Les autres statuts sont réservés au répondant (revérifié par l'action)."],
        args: { id: r.id, status: m },
        successMessage: `${r.reference} : ${SUPPORT_STATUS_FR.find(([c]) => c === m)?.[1]}.`,
        revalidate: ["/support"],
      };
    },
    execute: (args) => runFd(updateSupportStatus, args, "Le changement de statut a été refusé.", { revalidate: ["/support"] }),
  },
};
