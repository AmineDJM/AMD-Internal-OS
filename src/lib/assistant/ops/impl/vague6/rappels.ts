/**
 * OPS VAGUE 6a — RAPPELS personnels : création datée, terminer, reporter (+1 j par défaut),
 * annuler. Par les actions canoniques.
 */
import { prisma } from "./erp";
import { createReminder, completeReminder, cancelReminder, snoozeReminder } from "@/lib/actions/reminder-actions";
import type { OpImpl, OpProposalDraft } from "../../types";
import { opStr } from "../../types";
import { runFd, fieldsOf } from "../../helpers";

// ─────────────────────────── RAPPELS PERSONNELS ───────────────────────────

async function resolveReminder(userId: string, raw: string): Promise<{ id: string; title: string } | { error: string }> {
  const q = raw.trim();
  if (!q) return { error: "Précisez le rappel (champ « label » — son objet)." };
  const rows = await prisma.reminder.findMany({
    where: { userId, title: { contains: q, mode: "insensitive" } },
    select: { id: true, title: true, status: true, remindAt: true },
    orderBy: { remindAt: "desc" }, take: 6,
  });
  const pending = rows.filter((r) => r.status === "PENDING");
  const pick = pending.length === 1 ? pending[0] : rows.length === 1 ? rows[0] : null;
  if (pick) return { id: pick.id, title: pick.title };
  if (rows.length === 0) return { error: `Aucun rappel « ${q} » dans votre espace.` };
  return { error: `Plusieurs rappels correspondent : ${rows.map((r) => `${r.title} (${r.remindAt.toISOString().slice(0, 10)})`).join(" ; ")} — préciser.` };
}

export const REMINDER_OPS_IMPL: Record<string, OpImpl> = {
  create_reminder: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const title = opStr(input, "label") || opStr(input, "name") || opStr(input, "title");
      if (!title) return { error: "Donnez l'objet du rappel (champ « label »)." };
      const date = opStr(input, "date");
      if (!date) return { error: "Donnez la date du rappel (champ « date » — AAAA-MM-JJ, heure en option AAAA-MM-JJTHH:MM)." };
      return {
        title: `Rappel « ${title} »`,
        fields: fieldsOf([
          ["Objet", title],
          ["Quand", date],
          ["Note", opStr(input, "note") || null],
        ]),
        warnings: ["Rappel PERSONNEL : il n'appartient qu'à vous — à l'échéance, la plateforme vous notifie."],
        args: { title, remindAt: date, note: opStr(input, "note") || null },
        successMessage: `Rappel « ${title} » posé pour le ${date}.`,
        revalidate: ["/mon-espace"],
      };
    },
    execute: (args) => runFd(createReminder, args, "La création du rappel a été refusée (date passée ?).", { revalidate: ["/mon-espace"] }),
  },

  complete_reminder: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const r = await resolveReminder(user.id, opStr(input, "label") || opStr(input, "name"));
      if ("error" in r) return r;
      return {
        title: `Terminer le rappel « ${r.title} »`,
        fields: [{ label: "Rappel", value: r.title }],
        args: { id: r.id },
        successMessage: `Rappel « ${r.title} » terminé.`,
        revalidate: ["/mon-espace"],
      };
    },
    execute: (args) => runFd(completeReminder, args, "Le rappel n'a pas pu être terminé.", { revalidate: ["/mon-espace"] }),
  },

  cancel_reminder: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const r = await resolveReminder(user.id, opStr(input, "label") || opStr(input, "name"));
      if ("error" in r) return r;
      return {
        title: `Annuler le rappel « ${r.title} »`,
        fields: [{ label: "Rappel", value: r.title }],
        args: { id: r.id },
        successMessage: `Rappel « ${r.title} » annulé.`,
        revalidate: ["/mon-espace"],
      };
    },
    execute: (args) => runFd(cancelReminder, args, "Le rappel n'a pas pu être annulé.", { revalidate: ["/mon-espace"] }),
  },

  snooze_reminder: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const r = await resolveReminder(user.id, opStr(input, "label") || opStr(input, "name"));
      if ("error" in r) return r;
      const date = opStr(input, "date");
      return {
        title: `Reporter le rappel « ${r.title} »`,
        fields: [
          { label: "Rappel", value: r.title },
          { label: "Nouvelle échéance", value: date || "demain, même heure (défaut +1 jour)" },
        ],
        args: { id: r.id, remindAt: date || null },
        successMessage: `Rappel « ${r.title} » reporté${date ? ` au ${date}` : " à demain"}.`,
        revalidate: ["/mon-espace"],
      };
    },
    execute: (args) => runFd(snoozeReminder, args, "Le report a été refusé.", { revalidate: ["/mon-espace"] }),
  },
};
