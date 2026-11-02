import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/session";
import {
  createMeeting, respondToMeetingInvite, addMeetingParticipants, postMeetingMessage,
  endMeeting, deleteMeeting,
} from "@/lib/actions/meeting-actions";
import type { OpImpl, OpProposalDraft } from "./types";
import { opStr } from "./types";
import { resolvePeopleList } from "./impl-drive";

/**
 * OPS RÉUNIONS — planifier, répondre à une invitation, inviter, écrire dans le fil, terminer,
 * supprimer — par les ACTIONS CANONIQUES de `meeting-actions.ts` (la porte « organisateur »
 * de `loadManaged` reste LE juge des gestes de gestion). La réunion se résout par TITRE, dans
 * le périmètre où le geste est réellement possible (mes invitations, mes réunions organisées…).
 */

export interface MeetingHit { id: string; title: string; scheduledAt: Date | null; organizer: string }

const when = (d: Date | null): string =>
  d ? d.toLocaleString("fr-FR", { timeZone: "Africa/Algiers", dateStyle: "medium", timeStyle: "short" }) : "sans date";

// Exporté pour les ops réunions avancées (impl-wave7b) — même résolution, mêmes périmètres.
export async function resolveMeeting(
  user: CurrentUser,
  raw: string,
  mode: "organizer" | "invited" | "circle",
): Promise<MeetingHit | { error: string }> {
  const q = raw.trim();
  if (!q) return { error: "Précisez le titre (ou un morceau) de la réunion (champ « title »)." };
  const scope =
    mode === "organizer"
      ? user.role === "SUPER_ADMIN" ? {} : { organizerId: user.id }
      : mode === "invited"
        ? { participants: { some: { userId: user.id } } }
        : { OR: [{ organizerId: user.id }, { participants: { some: { userId: user.id } } }] };
  const rows = await prisma.meeting.findMany({
    where: { AND: [{ title: { contains: q, mode: "insensitive" as const }, status: { not: "ENDED" as const } }, scope] },
    select: { id: true, title: true, scheduledAt: true, organizer: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
    take: 6,
  });
  const hits: MeetingHit[] = rows.map((r) => ({ id: r.id, title: r.title, scheduledAt: r.scheduledAt, organizer: r.organizer?.name ?? "—" }));
  if (hits.length === 0) {
    const what = mode === "organizer" ? "réunion que vous organisez" : mode === "invited" ? "réunion où vous êtes invité" : "réunion de votre cercle";
    return { error: `Aucune ${what} (non terminée) ne correspond à « ${q} ».` };
  }
  const exact = hits.filter((h) => h.title.toLowerCase() === q.toLowerCase());
  if (exact.length === 1) return exact[0];
  if (hits.length === 1) return hits[0];
  return { error: `Plusieurs réunions correspondent à « ${q} » : ${hits.map((h) => `« ${h.title} » (${when(h.scheduledAt)}, ${h.organizer})`).join(" ; ")} — préciser le titre.` };
}

const meetingLink = (id: string): string => `/meetings/${id}`;
const MEETING_REVALIDATE = ["/meetings"];

/** « 2026-08-27 » + « 14:30 » → « 2026-08-27T14:30 » (datetime-local, heure d'Alger). */
function scheduledInput(date: string, time: string): string | null {
  if (!date) return null;
  const d = date.trim();
  const t = (time || "09:00").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !/^\d{1,2}:\d{2}$/.test(t)) return null;
  return `${d}T${t.padStart(5, "0")}`;
}

export const MEETING_OPS_IMPL: Record<string, OpImpl> = {
  create: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const title = opStr(input, "title");
      if (!title) return { error: "Donnez le titre de la réunion (champ « title »)." };
      const scheduled = scheduledInput(opStr(input, "date"), opStr(input, "time"));
      const rawPeople = opStr(input, "people");
      const { people, problems } = rawPeople ? await resolvePeopleList(rawPeople, user.id) : { people: [], problems: [] };
      const inPerson = /pr[ée]sentiel|physique|salle|bureau/i.test(opStr(input, "mode"));
      const location = opStr(input, "location");
      return {
        title: `Planifier la réunion « ${title} »`,
        fields: [
          { label: "Réunion", value: title },
          { label: "Quand", value: scheduled ? `${scheduled.replace("T", " à ")} (heure d'Alger)` : "sans créneau (à caler)" },
          { label: "Mode", value: inPerson ? `Présentiel${location ? ` — ${location}` : ""}` : "Visio (salle intégrée)" },
          { label: "Invités", value: people.length ? people.map((p) => p.name).join(", ") : "aucun (vous seul)" },
        ],
        warnings: [
          ...(people.length ? ["Chaque invité est notifié et répond (accepter / décliner / peut-être)."] : []),
          ...problems.map((p) => `Non invité : ${p}.`),
        ],
        args: {
          title, description: opStr(input, "description"),
          scheduledAt: scheduled,
          inPerson: inPerson ? "1" : "", location,
          userIds: people.map((p) => p.id).join(","),
          names: people.map((p) => p.name).join(", "),
        },
        successMessage: `Réunion « ${title} » planifiée${people.length ? ` — ${people.length} invité(s) notifié(s)` : ""}.`,
        revalidate: MEETING_REVALIDATE,
      };
    },
    async execute(args) {
      const fd = new FormData();
      fd.set("title", args.title ?? "");
      if (args.description) fd.set("description", args.description);
      if (args.scheduledAt) fd.set("scheduledAt", args.scheduledAt);
      if (args.inPerson) {
        fd.set("inPerson", "on");
        if (args.location) fd.set("location", args.location);
      }
      for (const id of (args.userIds ?? "").split(",").filter(Boolean)) fd.append("participantIds", id);
      const r = await createMeeting(undefined, fd);
      if (!r.ok) return { ok: false, error: r.error ?? "La création de la réunion a été refusée." };
      return { ok: true, createdId: r.id, link: r.id ? meetingLink(r.id) : "/meetings", revalidate: MEETING_REVALIDATE };
    },
  },

  respond_invite: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const raw = opStr(input, "response").toLowerCase();
      const response = /accept|oui|ok|présent|present/.test(raw) ? "ACCEPTED"
        : /d[ée]clin|refus|non|absent/.test(raw) ? "DECLINED"
          : /peut|tentative|incertain/.test(raw) ? "TENTATIVE" : null;
      if (!response) return { error: "Précisez la réponse : accepter, décliner ou peut-être (champ « response »)." };
      const meeting = await resolveMeeting(user, opStr(input, "title"), "invited");
      if ("error" in meeting) return meeting;
      const RESPONSE_FR: Record<string, string> = { ACCEPTED: "Accepter", DECLINED: "Décliner", TENTATIVE: "Peut-être" };
      return {
        title: `${RESPONSE_FR[response]} l'invitation « ${meeting.title} »`,
        fields: [
          { label: "Réunion", value: `${meeting.title} (${when(meeting.scheduledAt)})` },
          { label: "Organisée par", value: meeting.organizer },
          { label: "Réponse", value: RESPONSE_FR[response] },
        ],
        warnings: ["L'organisateur est notifié de votre réponse."],
        args: { id: meeting.id, response, title: meeting.title },
        successMessage: `Réponse envoyée pour « ${meeting.title} » : ${RESPONSE_FR[response].toLowerCase()}.`,
        link: meetingLink(meeting.id),
        revalidate: MEETING_REVALIDATE,
      };
    },
    async execute(args) {
      const fd = new FormData();
      fd.set("id", args.id ?? "");
      fd.set("response", args.response ?? "");
      const r = await respondToMeetingInvite(fd);
      if (!r.ok) return { ok: false, error: r.error ?? "La réponse à l'invitation a été refusée." };
      return { ok: true, revalidate: MEETING_REVALIDATE };
    },
  },

  add_participants: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const meeting = await resolveMeeting(user, opStr(input, "title"), "organizer");
      if ("error" in meeting) return meeting;
      const rawPeople = opStr(input, "people");
      if (!rawPeople) return { error: "Donnez les personnes à inviter (champ « people », noms séparés par des virgules)." };
      const { people, problems } = await resolvePeopleList(rawPeople, user.id);
      if (people.length === 0) return { error: `Aucune personne résolue : ${problems.join(" ; ")}.` };
      return {
        title: `Inviter ${people.map((p) => p.name).join(", ")} à « ${meeting.title} »`,
        fields: [
          { label: "Réunion", value: `${meeting.title} (${when(meeting.scheduledAt)})` },
          { label: "Nouveaux invités", value: people.map((p) => p.name).join(", ") },
        ],
        warnings: ["Chaque personne est notifiée de l'invitation.", ...problems.map((p) => `Non invité : ${p}.`)],
        args: { id: meeting.id, userIds: people.map((p) => p.id).join(","), title: meeting.title },
        successMessage: `${people.length} personne(s) invitée(s) à « ${meeting.title} ».`,
        link: meetingLink(meeting.id),
        revalidate: MEETING_REVALIDATE,
      };
    },
    async execute(args) {
      const fd = new FormData();
      fd.set("id", args.id ?? "");
      for (const id of (args.userIds ?? "").split(",").filter(Boolean)) fd.append("participantIds", id);
      const r = await addMeetingParticipants(fd);
      if (!r.ok) return { ok: false, error: r.error ?? "L'ajout de participants a été refusé." };
      return { ok: true, revalidate: MEETING_REVALIDATE };
    },
  },

  post_message: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const body = opStr(input, "comment");
      if (!body) return { error: "Donnez le message à poster (champ « comment »)." };
      const meeting = await resolveMeeting(user, opStr(input, "title"), "circle");
      if ("error" in meeting) return meeting;
      return {
        title: `Écrire dans le fil de « ${meeting.title} »`,
        fields: [
          { label: "Réunion", value: meeting.title },
          { label: "Message", value: body.slice(0, 300) },
        ],
        args: { id: meeting.id, body, title: meeting.title },
        successMessage: `Message posté dans « ${meeting.title} ».`,
        link: meetingLink(meeting.id),
        revalidate: MEETING_REVALIDATE,
      };
    },
    async execute(args) {
      const fd = new FormData();
      fd.set("id", args.id ?? "");
      fd.set("body", args.body ?? "");
      const r = await postMeetingMessage(fd);
      if (!r.ok) return { ok: false, error: r.error ?? "Le message a été refusé." };
      return { ok: true, revalidate: MEETING_REVALIDATE };
    },
  },

  end: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const meeting = await resolveMeeting(user, opStr(input, "title"), "organizer");
      if ("error" in meeting) return meeting;
      return {
        title: `Terminer la réunion « ${meeting.title} »`,
        fields: [{ label: "Réunion", value: `${meeting.title} (${when(meeting.scheduledAt)})` }],
        warnings: ["La réunion passe TERMINÉE — le compte rendu peut ensuite être rédigé depuis sa fiche."],
        args: { id: meeting.id, title: meeting.title },
        successMessage: `Réunion « ${meeting.title} » terminée.`,
        link: meetingLink(meeting.id),
        revalidate: MEETING_REVALIDATE,
      };
    },
    async execute(args) {
      const fd = new FormData();
      fd.set("id", args.id ?? "");
      const r = await endMeeting(fd);
      if (!r.ok) return { ok: false, error: r.error ?? "La clôture de la réunion a été refusée." };
      return { ok: true, revalidate: MEETING_REVALIDATE };
    },
  },

  delete: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const meeting = await resolveMeeting(user, opStr(input, "title"), "organizer");
      if ("error" in meeting) return meeting;
      return {
        title: `Supprimer la réunion « ${meeting.title} »`,
        fields: [{ label: "Réunion", value: `${meeting.title} (${when(meeting.scheduledAt)})` }],
        warnings: ["Les invités la voient disparaître de leur agenda — pour un simple report, modifier plutôt le créneau à l'écran."],
        args: { id: meeting.id, title: meeting.title },
        successMessage: `Réunion « ${meeting.title} » supprimée.`,
        revalidate: MEETING_REVALIDATE,
      };
    },
    async execute(args) {
      const fd = new FormData();
      fd.set("id", args.id ?? "");
      const r = await deleteMeeting(fd);
      if (!r.ok) return { ok: false, error: r.error ?? "La suppression de la réunion a été refusée." };
      return { ok: true, revalidate: MEETING_REVALIDATE };
    },
  },
};
