/**
 * OPS VAGUE 6a — DIRECTIVES : émission Direction vers une personne OU un rôle, statut dont
 * archivage réservé, fil. Par les actions canoniques.
 */
import { prisma } from "./erp";
import { createDirective, updateDirectiveStatus, postDirectiveMessage } from "@/lib/actions/directive-actions";
import type { OpImpl, OpProposalDraft } from "../../types";
import { opStr } from "../../types";
import { runFd, runFd2, fieldsOf, isoDate } from "../../helpers";
import { matchLabel } from "../../impl-regulatory";
import { userByName, ROLE_PAIRS } from "./commun";

const PRIORITY_FR: [string, string][] = [
  ["LOW", "Basse"], ["MEDIUM", "Moyenne"], ["HIGH", "Haute"], ["CRITICAL", "Critique"],
];

// ─────────────────────────── DIRECTIVES ───────────────────────────

const DIRECTIVE_STATUS_FR: [string, string][] = [
  ["OPEN", "Ouverte"], ["ACKNOWLEDGED", "Prise en compte"], ["IN_PROGRESS", "En cours"],
  ["DONE", "Terminée"], ["ARCHIVED", "Archivée"],
];

interface DirectiveHit { id: string; reference: string; title: string }

async function resolveDirective(raw: string): Promise<DirectiveHit | { error: string }> {
  const q = raw.trim();
  if (!q) return { error: "Précisez la directive (champ « target » — référence DIR-… ou titre)." };
  const exact = await prisma.directive.findFirst({
    where: { reference: { equals: q, mode: "insensitive" } },
    select: { id: true, reference: true, title: true },
  });
  if (exact) return exact;
  const rows = await prisma.directive.findMany({
    where: { OR: [{ title: { contains: q, mode: "insensitive" } }, { reference: { contains: q, mode: "insensitive" } }] },
    select: { id: true, reference: true, title: true },
    orderBy: { createdAt: "desc" }, take: 6,
  });
  if (rows.length === 1) return rows[0];
  if (rows.length === 0) return { error: `Aucune directive « ${q} ».` };
  return { error: `Plusieurs directives correspondent : ${rows.map((d) => `${d.reference} — ${d.title}`).join(" ; ")} — donner la référence.` };
}

export const DIRECTIVE_OPS_IMPL: Record<string, OpImpl> = {
  create_directive: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const title = opStr(input, "label") || opStr(input, "name");
      const body = opStr(input, "message") || opStr(input, "note");
      if (!title || !body) return { error: "Titre (champ « label ») et contenu (champ « message ») sont obligatoires." };
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
      const priorityRaw = opStr(input, "priority") || opStr(input, "mode");
      const priority = priorityRaw ? matchLabel(priorityRaw, PRIORITY_FR) : null;
      if (priority && typeof priority === "object") return priority;
      return {
        title: `Émettre la directive « ${title} » → ${targetShown}`,
        fields: fieldsOf([
          ["Titre", title],
          ["Destinataire", targetShown],
          ["Priorité", priority ? PRIORITY_FR.find(([c]) => c === priority)?.[1] ?? null : null],
          ["Échéance", isoDate(opStr(input, "date"))],
          ["Contenu", body],
        ]),
        warnings: ["Émission réservée à la Direction. La note part SEULEMENT après validation du Directeur Général (ou du Super Admin) — sauf s'il en est l'auteur, auquel cas elle part aussitôt."],
        args: {
          title, body, targetUserId, targetRole, priority: priority || null,
          dueDate: isoDate(opStr(input, "date")),
        },
        successMessage: `Directive « ${title} » soumise (${targetShown}) — elle partira à la validation de la direction générale.`,
        revalidate: ["/directives", "/mon-travail"],
      };
    },
    execute: (args) => runFd2(createDirective, args, "L'émission de la directive a été refusée.", { revalidate: ["/directives"] }),
  },

  set_directive_status: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const d = await resolveDirective(opStr(input, "target"));
      if ("error" in d) return d;
      const m = matchLabel(opStr(input, "status"), DIRECTIVE_STATUS_FR);
      if (typeof m === "object") return m;
      return {
        title: `${d.reference} — ${d.title} → ${DIRECTIVE_STATUS_FR.find(([c]) => c === m)?.[1]}`,
        fields: [{ label: "Directive", value: `${d.reference} — ${d.title}` }, { label: "Statut", value: DIRECTIVE_STATUS_FR.find(([c]) => c === m)?.[1] ?? m }],
        warnings: m === "ARCHIVED"
          ? ["L'ARCHIVAGE est réservé à la Direction — l'émetteur est informé de chaque avancement."]
          : ["Geste du destinataire, de l'émetteur ou de la Direction — « prise en compte » horodate l'accusé."],
        args: { id: d.id, status: m },
        successMessage: `${d.reference} : ${DIRECTIVE_STATUS_FR.find(([c]) => c === m)?.[1]}.`,
        revalidate: ["/directives", "/mon-travail"],
      };
    },
    execute: (args) => runFd(updateDirectiveStatus, args, "Le changement de statut a été refusé.", { revalidate: ["/directives"] }),
  },

  post_directive_message: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const d = await resolveDirective(opStr(input, "target"));
      if ("error" in d) return d;
      const body = opStr(input, "message") || opStr(input, "note");
      if (!body) return { error: "Écrivez le message (champ « message »)." };
      return {
        title: `Message sur la directive ${d.reference}`,
        fields: [{ label: "Directive", value: `${d.reference} — ${d.title}` }, { label: "Message", value: body }],
        warnings: ["Fil émetteur ↔ destinataire : l'autre partie est notifiée."],
        args: { id: d.id, body },
        successMessage: `Message posé sur ${d.reference}.`,
        revalidate: ["/directives"],
      };
    },
    execute: (args) => runFd(postDirectiveMessage, args, "Le message a été refusé.", { revalidate: ["/directives"] }),
  },
};
