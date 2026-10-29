/**
 * OPS VAGUE 6a — PROJETS DE SUIVI (dossiers) : statut, équipe REJOUÉE, fil avec mentions membres,
 * e-mail lié, ouverture depuis une tâche, messages édités / supprimés par extrait. Par les actions
 * canoniques.
 */
import { prisma } from "./erp";
import { updateDossierStatus, assignDossier, postDossierMessage, linkEmailToDossier, createDossierFromTask, archiveDossier, deleteDossierMessage, editDossierMessage } from "@/lib/actions/dossier-actions";
import type { OpImpl, OpProposalDraft } from "../../types";
import { opStr } from "../../types";
import { runFd, fieldsOf, isoDate } from "../../helpers";
import { matchLabel, fold } from "../../impl-regulatory";
import { userByName } from "./commun";

// ─────────────────────────── PROJETS DE SUIVI (dossiers) ───────────────────────────

const DOSSIER_STATUS_FR: [string, string][] = [
  ["OPEN", "Ouvert"], ["IN_PROGRESS", "En cours"], ["ON_HOLD", "En attente"], ["DONE", "Terminé"], ["ARCHIVED", "Archivé"],
];

interface DossierHit { id: string; reference: string; title: string }

async function resolveDossier(raw: string): Promise<DossierHit | { error: string }> {
  const q = raw.trim();
  if (!q) return { error: "Précisez le projet (champ « target » — référence ou intitulé)." };
  const exact = await prisma.dossier.findFirst({
    where: { reference: { equals: q, mode: "insensitive" } },
    select: { id: true, reference: true, title: true },
  });
  if (exact) return exact;
  const rows = await prisma.dossier.findMany({
    where: { OR: [{ title: { contains: q, mode: "insensitive" } }, { reference: { contains: q, mode: "insensitive" } }] },
    select: { id: true, reference: true, title: true },
    orderBy: { updatedAt: "desc" }, take: 6,
  });
  if (rows.length === 1) return rows[0];
  if (rows.length === 0) return { error: `Aucun sujet « ${q} ».` };
  return { error: `Plusieurs sujets correspondent : ${rows.map((d) => `${d.reference} — ${d.title}`).join(" ; ")} — donner la référence.` };
}

async function resolveDossierMessage(dossier: DossierHit, excerptRaw: string): Promise<{ id: string; excerpt: string } | { error: string }> {
  const rows = await prisma.dossierMessage.findMany({
    where: { dossierId: dossier.id },
    select: { id: true, body: true, createdAt: true },
    orderBy: { createdAt: "desc" }, take: 10,
  });
  if (rows.length === 0) return { error: `${dossier.reference} n'a aucun message.` };
  const excerpt = (m: (typeof rows)[number]) => `« ${m.body.slice(0, 60)}${m.body.length > 60 ? "…" : ""} »`;
  const q = fold(excerptRaw);
  if (!q || /^dernier/.test(q)) {
    if (rows.length === 1 || /^dernier/.test(q)) return { id: rows[0].id, excerpt: excerpt(rows[0]) };
    return { error: `Précisez le message (champ « message » — un extrait, ou « dernier ») parmi : ${rows.slice(0, 5).map(excerpt).join(" ; ")}.` };
  }
  const hits = rows.filter((m) => fold(m.body).includes(q));
  if (hits.length === 1) return { id: hits[0].id, excerpt: excerpt(hits[0]) };
  if (hits.length === 0) return { error: `Aucun message contenant « ${excerptRaw} » — messages : ${rows.slice(0, 5).map(excerpt).join(" ; ")}.` };
  return { error: `Plusieurs messages correspondent : ${hits.map(excerpt).join(" ; ")} — préciser l'extrait.` };
}

export const DOSSIER_OPS_IMPL: Record<string, OpImpl> = {
  set_dossier_status: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const d = await resolveDossier(opStr(input, "target"));
      if ("error" in d) return d;
      const m = matchLabel(opStr(input, "status"), DOSSIER_STATUS_FR);
      if (typeof m === "object") return m;
      return {
        title: `${d.reference} — ${d.title} → ${DOSSIER_STATUS_FR.find(([c]) => c === m)?.[1]}`,
        fields: [{ label: "Sujet", value: `${d.reference} — ${d.title}` }, { label: "Statut", value: DOSSIER_STATUS_FR.find(([c]) => c === m)?.[1] ?? m }],
        warnings: ["Geste du créateur, du responsable ou de la Direction (revérifié par l'action)."],
        args: { id: d.id, status: m },
        successMessage: `${d.reference} : ${DOSSIER_STATUS_FR.find(([c]) => c === m)?.[1]}.`,
        revalidate: ["/dossiers", "/mon-travail"],
      };
    },
    execute: (args) => runFd(updateDossierStatus, args, "Le changement de statut a été refusé.", { revalidate: ["/dossiers"] }),
  },

  assign_dossier: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const d = await resolveDossier(opStr(input, "target"));
      if ("error" in d) return d;
      const current = await prisma.dossier.findUnique({
        where: { id: d.id }, select: { assignedToId: true, participantIds: true },
      });
      if (!current) return { error: "Sujet introuvable." };
      // FUSION : l'action REMPLACE responsable ET participants — l'existant est relu :
      // responsable absent → conservé ; participants absents → rejoués ; « aucun » vide.
      let assigneeId = current.assignedToId;
      let assigneeShown = "(inchangé)";
      const personRaw = opStr(input, "person");
      if (/^aucun/i.test(personRaw)) { assigneeId = null; assigneeShown = "— (retiré)"; }
      else if (personRaw) {
        const u = await userByName(personRaw);
        if ("error" in u) return u;
        assigneeId = u.id; assigneeShown = u.name;
      }
      let partIds = current.participantIds;
      let partsShown = `${current.participantIds.length} rejoué(s)`;
      const peopleRaw = opStr(input, "people");
      if (/^aucun/i.test(peopleRaw)) { partIds = []; partsShown = "— (liste vidée)"; }
      else if (peopleRaw) {
        const names = peopleRaw.split(/[;,]/).map((s) => s.trim()).filter(Boolean);
        const ids: string[] = []; const shown: string[] = [];
        for (const n of names) {
          const u = await userByName(n);
          if ("error" in u) return u;
          if (!ids.includes(u.id)) { ids.push(u.id); shown.push(u.name); }
        }
        partIds = ids; partsShown = shown.join(", ") + " (liste REMPLACÉE)";
      }
      const fd: Record<string, string | null> = { id: d.id, assignedToId: assigneeId, participantIds: partIds.join(",") };
      return {
        title: `Équipe du projet ${d.reference}`,
        fields: [
          { label: "Sujet", value: `${d.reference} — ${d.title}` },
          { label: "Responsable", value: assigneeShown },
          { label: "Participants", value: partsShown },
        ],
        warnings: ["Les NOUVEAUX membres sont notifiés — les personnes retirées ne le sont pas."],
        args: fd,
        successMessage: `Équipe de ${d.reference} mise à jour.`,
        revalidate: ["/dossiers", "/mon-travail"],
      };
    },
    async execute(args) {
      const fd = new FormData();
      fd.set("id", args.id ?? "");
      if (args.assignedToId) fd.set("assignedToId", args.assignedToId);
      for (const pid of (args.participantIds ?? "").split(",").filter(Boolean)) fd.append("participantIds", pid);
      const r = await assignDossier(fd);
      if (!r.ok) return { ok: false, error: r.error ?? "La mise à jour de l'équipe a été refusée." };
      return { ok: true, revalidate: ["/dossiers"] };
    },
  },

  post_dossier_message: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const d = await resolveDossier(opStr(input, "target"));
      if ("error" in d) return d;
      const body = opStr(input, "message") || opStr(input, "note");
      if (!body) return { error: "Écrivez le message (champ « message »)." };
      const mentionsRaw = opStr(input, "people");
      const mentionIds: string[] = []; const mentioned: string[] = [];
      if (mentionsRaw && !/^aucun/i.test(mentionsRaw)) {
        for (const n of mentionsRaw.split(/[;,]/).map((s) => s.trim()).filter(Boolean)) {
          const u = await userByName(n);
          if ("error" in u) return u;
          if (!mentionIds.includes(u.id)) { mentionIds.push(u.id); mentioned.push(u.name); }
        }
      }
      return {
        title: `Message sur ${d.reference}`,
        fields: fieldsOf([
          ["Sujet", `${d.reference} — ${d.title}`],
          ["Message", body],
          ["Mentions", mentioned.length ? mentioned.join(", ") : null],
        ]),
        warnings: mentionIds.length ? ["Une mention ne touche que les MEMBRES du projet — un non-membre mentionné est ignoré par l'action."] : [],
        args: { id: d.id, body, mentionIds: mentionIds.join(",") },
        successMessage: `Message posé sur ${d.reference}.`,
        revalidate: ["/dossiers"],
      };
    },
    async execute(args) {
      const fd = new FormData();
      fd.set("id", args.id ?? "");
      fd.set("body", args.body ?? "");
      for (const mid of (args.mentionIds ?? "").split(",").filter(Boolean)) fd.append("mentionIds", mid);
      const r = await postDossierMessage(fd);
      if (!r.ok) return { ok: false, error: r.error ?? "Le message a été refusé." };
      return { ok: true, revalidate: ["/dossiers"] };
    },
  },

  link_email_to_dossier: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const targetRaw = opStr(input, "target");
      const newTitle = opStr(input, "name");
      const subject = opStr(input, "label");
      if (!subject) return { error: "Précisez l'objet de l'e-mail (champ « label »)." };
      let dossierShown = "";
      let dossierId: string | null = null;
      if (targetRaw) {
        const d = await resolveDossier(targetRaw);
        if ("error" in d) return d;
        dossierId = d.id; dossierShown = `${d.reference} — ${d.title}`;
      } else if (newTitle) {
        dossierShown = `« ${newTitle} » (créé à la volée)`;
      } else {
        return { error: "Donnez le projet cible (champ « target ») OU l'intitulé du projet à créer (champ « name »)." };
      }
      return {
        title: `Lier l'e-mail « ${subject} » à ${dossierShown}`,
        fields: fieldsOf([
          ["Sujet", dossierShown],
          ["Objet", subject],
          ["Expéditeur", opStr(input, "person") || null],
          ["Reçu le", isoDate(opStr(input, "date"))],
        ]),
        args: {
          dossierId, newTitle: dossierId ? null : newTitle, subject,
          from: opStr(input, "person") || null, date: isoDate(opStr(input, "date")), body: opStr(input, "message") || null,
        },
        successMessage: `E-mail « ${subject} » journalisé dans ${dossierShown}.`,
        revalidate: ["/dossiers"],
      };
    },
    async execute(args) {
      const r = await linkEmailToDossier({
        dossierId: args.dossierId, newTitle: args.newTitle, subject: args.subject,
        from: args.from, date: args.date, body: args.body,
      });
      if (!r.ok) return { ok: false, error: r.error ?? "Le rattachement de l'e-mail a été refusé." };
      return { ok: true, revalidate: ["/dossiers"] };
    },
  },

  create_dossier_from_task: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const q = (opStr(input, "label") || opStr(input, "target")).trim();
      if (!q) return { error: "Précisez la tâche d'origine (champ « label » — son titre)." };
      const rows = await prisma.task.findMany({
        where: { title: { contains: q, mode: "insensitive" } },
        select: { id: true, title: true, status: true },
        orderBy: { createdAt: "desc" }, take: 6,
      });
      if (rows.length === 0) return { error: `Aucune tâche « ${q} ».` };
      if (rows.length > 1) return { error: `Plusieurs tâches correspondent : ${rows.map((t) => t.title).join(" ; ")} — préciser.` };
      return {
        title: `Ouvrir un sujet depuis la tâche « ${rows[0].title} »`,
        fields: [{ label: "Tâche", value: rows[0].title }],
        warnings: ["Le sujet reprend titre, description, responsable, priorité et échéance de la tâche."],
        args: { taskId: rows[0].id },
        successMessage: `Sujet ouvert depuis « ${rows[0].title} ».`,
        revalidate: ["/dossiers"],
      };
    },
    async execute(args) {
      const r = await createDossierFromTask(args.taskId ?? "");
      if (!r.ok) return { ok: false, error: r.error ?? "L'ouverture du projet a été refusée." };
      return { ok: true, revalidate: ["/dossiers"] };
    },
  },

  archive_dossier: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const d = await resolveDossier(opStr(input, "target"));
      if ("error" in d) return d;
      return {
        title: `ARCHIVER le projet ${d.reference} — ${d.title}`,
        fields: [{ label: "Sujet", value: `${d.reference} — ${d.title}` }],
        warnings: ["Le projet sort des listes actives (statut Archivé) — il reste consultable, rien n'est supprimé."],
        args: { id: d.id },
        successMessage: `${d.reference} archivé.`,
        revalidate: ["/dossiers", "/mon-travail"],
      };
    },
    execute: (args) => runFd(archiveDossier, args, "L'archivage a été refusé.", { revalidate: ["/dossiers"] }),
  },

  delete_dossier_message: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const d = await resolveDossier(opStr(input, "target"));
      if ("error" in d) return d;
      const msg = await resolveDossierMessage(d, opStr(input, "message") || opStr(input, "label"));
      if ("error" in msg) return msg;
      return {
        title: `Supprimer un message du fil de ${d.reference}`,
        fields: [{ label: "Sujet", value: `${d.reference} — ${d.title}` }, { label: "Message", value: msg.excerpt }],
        warnings: ["Suppression définitive du message ET de ses pièces jointes — réservé à l'auteur, au responsable ou à la Direction."],
        args: { id: msg.id },
        successMessage: `Message supprimé du fil de ${d.reference}.`,
        revalidate: ["/dossiers"],
      };
    },
    execute: (args) => runFd(deleteDossierMessage, args, "La suppression du message a été refusée.", { revalidate: ["/dossiers"] }),
  },

  edit_dossier_message: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const d = await resolveDossier(opStr(input, "target"));
      if ("error" in d) return d;
      const msg = await resolveDossierMessage(d, opStr(input, "message") || opStr(input, "label"));
      if ("error" in msg) return msg;
      const body = opStr(input, "note") || opStr(input, "newName");
      if (!body) return { error: "Donnez le NOUVEAU texte du message (champ « note »)." };
      return {
        title: `Modifier un message du fil de ${d.reference}`,
        fields: [
          { label: "Message actuel", value: msg.excerpt },
          { label: "Nouveau texte", value: body },
        ],
        warnings: ["Réservé à l'auteur, au responsable ou à la Direction (revérifié par l'action)."],
        args: { id: msg.id, body },
        successMessage: `Message modifié sur ${d.reference}.`,
        revalidate: ["/dossiers"],
      };
    },
    execute: (args) => runFd(editDossierMessage, args, "La modification du message a été refusée.", { revalidate: ["/dossiers"] }),
  },
};
