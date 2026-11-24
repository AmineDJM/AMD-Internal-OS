import { prisma } from "@/lib/prisma";
import { resolveDriveAccess } from "@/lib/drive";
import { createMailEntry, editMailEntry, attachDriveNodeToMail, setMailDate, deleteMailEntry } from "@/lib/actions/mail-register-actions";
import { addEntityLink, removeEntityLink } from "@/lib/actions/link-actions";
import { ENTITY_TYPE_LABELS } from "@/lib/labels";
import { moveMailEntries } from "@/lib/actions/mail-folder-actions";
import type { OpImpl, OpProposalDraft } from "./types";
import { opStr } from "./types";
import { runFd, isoDate } from "./helpers";
import type { CurrentUser } from "@/lib/session";
import type { Prisma } from "@prisma/client";
import { companyScopedWhere } from "@/lib/company";

/**
 * OPS COURRIERS — le registre des plis (créer, corriger, classer, déclarer un fichier Drive
 * en courrier), par les ACTIONS CANONIQUES de `mail-register-actions` / `mail-folder-actions`
 * (cloisonnement par entité et anti-doublon Drive inclus). La correction FUSIONNE : seuls les
 * champs CITÉS partent à l'action, le noyau garde le reste (`updateMailEntryFor`) — corriger un
 * titre ne coûte jamais un expéditeur, un porteur ni une date. La résolution ne cherche que dans
 * les plis que la personne VOIT : une ambiguïté listée ne doit pas réciter le registre du voisin.
 */

interface EntryHit { id: string; title: string; reference: string | null; direction: string }

const dirLabel = (d: string): string => (d === "INCOMING" ? "Entrant" : "Sortant");

async function resolveMailEntry(raw: string, user: CurrentUser): Promise<EntryHit | { error: string }> {
  const q = raw.trim();
  if (!q) return { error: "Précisez le n° de chrono ou le titre du courrier (champ « reference »)." };
  const rows = await prisma.mailEntry.findMany({
    where: await companyScopedWhere<Prisma.MailEntryWhereInput>(user.id, { OR: [{ reference: { equals: q, mode: "insensitive" } }, { title: { contains: q, mode: "insensitive" } }] }),
    select: { id: true, title: true, reference: true, direction: true },
    orderBy: { createdAt: "desc" },
    take: 6,
  });
  if (rows.length === 0) return { error: `Aucun courrier « ${q} » au registre.` };
  const exact = rows.filter((r) => (r.reference ?? "").toLowerCase() === q.toLowerCase());
  if (exact.length === 1) return exact[0];
  if (rows.length === 1) return rows[0];
  return { error: `Plusieurs courriers correspondent à « ${q} » : ${rows.map((r) => `${r.reference ? `${r.reference} — ` : ""}${r.title} (${dirLabel(r.direction)})`).join(" ; ")} — préciser.` };
}

const directionOf = (raw: string): "INCOMING" | "OUTGOING" | null => {
  const k = raw.toLowerCase();
  if (/entrant|arriv|re[çc]u|incoming/.test(k)) return "INCOMING";
  if (/sortant|d[ée]part|envoy|outgoing/.test(k)) return "OUTGOING";
  return null;
};

const MAIL_REVALIDATE = ["/courriers"];

/**
 * LES CIBLES DU « RELIER À… » — la résolution seulement, jamais le flux.
 *
 * Ce décodeur ne décide PAS de ce qui a le droit d'être relié : c'est `lib/links/` qui le fait, à
 * l'écriture, pour l'écran comme pour Adam. Le recopier ici en ferait une seconde règle, qui
 * dériverait au premier changement — et un modèle qui contourne une règle absente ne se voit pas.
 * On reconnaît donc une NATURE et un objet ; la validité de la paire est refusée en aval, avec le
 * chemin à prendre à la place.
 *
 * L'invariant des ops tient : exact → unique → ambiguïté LISTÉE, jamais de choix silencieux.
 */
const MAIL_TARGETS = ["PCH_TENDER", "PCH_ORDER", "INVOICE", "LEGAL_DOCUMENT", "REGULATORY_PRODUCT"] as const;
type MailTarget = (typeof MAIL_TARGETS)[number];

const typeLabel = (t: string): string => ENTITY_TYPE_LABELS[t] ?? t;

function kindFromWords(raw: string): MailTarget | null {
  const k = raw.trim().toLowerCase();
  return /march|tender|\bao\b|appel/.test(k) ? "PCH_TENDER"
    : /\bbc\b|bon de commande|commande/.test(k) ? "PCH_ORDER"
      : /factur|invoice/.test(k) ? "INVOICE"
        : /contrat|l[ée]gal|convention|avenant|assurance/.test(k) ? "LEGAL_DOCUMENT"
          : /regulatory|dossier|produit/.test(k) ? "REGULATORY_PRODUCT"
            : null;
}

async function resolveLinkTarget(kindRaw: string, raw: string): Promise<{ entityType: MailTarget; entityId: string; label: string } | { error: string }> {
  const q = raw.trim();
  if (!q) return { error: "Précisez la cible (champ « target » — référence ou titre)." };
  const kind = kindFromWords(kindRaw);
  if (!kind) {
    return { error: `Précisez le type de cible (champ « kind ») : ${MAIL_TARGETS.map((t) => typeLabel(t).toLowerCase()).join(", ")}.` };
  }

  if (kind === "PCH_TENDER") {
    const rows = await prisma.pchTender.findMany({
      where: { OR: [{ reference: { contains: q, mode: "insensitive" } }, { title: { contains: q, mode: "insensitive" } }] },
      select: { id: true, reference: true, title: true }, orderBy: { createdAt: "desc" }, take: 6,
    });
    if (rows.length === 1) return { entityType: kind, entityId: rows[0].id, label: `${rows[0].reference}${rows[0].title ? ` — ${rows[0].title}` : ""}` };
    if (rows.length === 0) return { error: `Aucun marché « ${q} ».` };
    return { error: `Plusieurs marchés correspondent : ${rows.map((r) => r.reference).join(" ; ")} — préciser.` };
  }
  if (kind === "PCH_ORDER") {
    const rows = await prisma.pchOrder.findMany({
      where: { OR: [{ reference: { contains: q, mode: "insensitive" } }, { tender: { reference: { contains: q, mode: "insensitive" } } }] },
      select: { id: true, reference: true, tender: { select: { reference: true } } }, orderBy: { createdAt: "desc" }, take: 6,
    });
    if (rows.length === 1) return { entityType: kind, entityId: rows[0].id, label: `BC ${rows[0].reference ?? "s/n"} — ${rows[0].tender.reference}` };
    if (rows.length === 0) return { error: `Aucun bon de commande « ${q} ».` };
    return { error: `Plusieurs bons de commande correspondent : ${rows.map((r) => `BC ${r.reference ?? "s/n"} (${r.tender.reference})`).join(" ; ")} — préciser.` };
  }
  // Une facture est un document légal de nature « facture » : chaque nature ne cherche que la
  // sienne, sinon la même pièce serait reliable sous les deux et le lien s'écrirait deux fois.
  if (kind === "INVOICE") {
    const rows = await prisma.legalDocument.findMany({
      where: { kind: "INVOICE", OR: [{ reference: { contains: q, mode: "insensitive" } }, { title: { contains: q, mode: "insensitive" } }] },
      select: { id: true, reference: true, title: true }, orderBy: { createdAt: "desc" }, take: 6,
    });
    if (rows.length === 1) return { entityType: kind, entityId: rows[0].id, label: `Facture ${rows[0].reference ? `${rows[0].reference} — ` : ""}${rows[0].title}` };
    if (rows.length === 0) return { error: `Aucune facture « ${q} ».` };
    return { error: `Plusieurs factures correspondent : ${rows.map((r) => `${r.reference ? `${r.reference} — ` : ""}${r.title}`).join(" ; ")} — préciser.` };
  }
  if (kind === "LEGAL_DOCUMENT") {
    const rows = await prisma.legalDocument.findMany({
      where: { kind: { not: "INVOICE" }, OR: [{ title: { contains: q, mode: "insensitive" } }, { reference: { contains: q, mode: "insensitive" } }] },
      select: { id: true, title: true, reference: true }, orderBy: { createdAt: "desc" }, take: 6,
    });
    if (rows.length === 1) return { entityType: kind, entityId: rows[0].id, label: `${rows[0].reference ? `${rows[0].reference} — ` : ""}${rows[0].title}` };
    if (rows.length === 0) return { error: `Aucun document légal « ${q} ».` };
    return { error: `Plusieurs documents correspondent : ${rows.map((r) => r.title).join(" ; ")} — préciser.` };
  }
  const rows = await prisma.regulatoryProduct.findMany({
    where: { isLocked: false, OR: [{ reference: { contains: q, mode: "insensitive" } }, { dci: { contains: q, mode: "insensitive" } }, { brandName: { contains: q, mode: "insensitive" } }] },
    select: { id: true, reference: true, dci: true }, orderBy: { updatedAt: "desc" }, take: 6,
  });
  if (rows.length === 1) return { entityType: kind, entityId: rows[0].id, label: `${rows[0].reference} — ${rows[0].dci}` };
  if (rows.length === 0) return { error: `Aucun dossier Regulatory « ${q} ».` };
  return { error: `Plusieurs dossiers correspondent : ${rows.map((r) => `${r.reference} (${r.dci})`).join(" ; ")} — préciser.` };
}

export const MAIL_OPS_IMPL: Record<string, OpImpl> = {
  set_date: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const entry = await resolveMailEntry(opStr(input, "reference") || opStr(input, "label"), user);
      if ("error" in entry) return entry;
      const fieldRaw = opStr(input, "kind");
      const ack = /accus/i.test(fieldRaw);
      const received = /re[çc]u|r[ée]ception|arriv/i.test(fieldRaw);
      if (!ack && !received) return { error: "Précisez la date visée (champ « kind ») : « reçu le » ou « accusé de réception »." };
      const value = isoDate(opStr(input, "date"));
      const clearing = /^(aucune?|retire|efface)$/i.test(opStr(input, "date"));
      if (!value && !clearing) return { error: "Précisez la date (champ « date », AAAA-MM-JJ) — ou « aucune » pour l'effacer." };
      return {
        title: `${ack ? "Accusé de réception" : "Date de réception"} — courrier ${entry.reference ?? entry.title}`,
        fields: [
          { label: "Courrier", value: `${entry.reference ?? "s/n"} — ${entry.title}` },
          { label: ack ? "Accusé le" : "Reçu le", value: clearing ? "— (effacée)" : value! },
        ],
        args: { id: entry.id, field: ack ? "acknowledgedAt" : "receivedAt", value: clearing ? null : value },
        successMessage: `${ack ? "Accusé" : "Réception"} du courrier ${entry.reference ?? ""} ${clearing ? "effacé" : "daté"}.`,
        revalidate: ["/courriers"],
      };
    },
    async execute(args) {
      const r = await setMailDate({ id: args.id ?? "", field: (args.field ?? "receivedAt") as "receivedAt" | "acknowledgedAt", value: args.value ?? null });
      if (!r.ok) return { ok: false, error: r.error ?? "La date a été refusée." };
      return { ok: true, revalidate: ["/courriers"] };
    },
  },

  delete_entry: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const entry = await resolveMailEntry(opStr(input, "reference") || opStr(input, "label"), user);
      if ("error" in entry) return entry;
      return {
        title: `SUPPRIMER le courrier ${entry.reference ?? ""} — ${entry.title}`,
        fields: [{ label: "Courrier", value: `${entry.reference ?? "s/n"} — ${entry.title}` }],
        // LE MÊME GESTE QUE LA FICHE (`deleteOwnRecord`) — la corbeille, pas la destruction. Ce qui
        // revient et ce qui ne revient pas est dit tel quel : les pièces nominatives sont des lignes
        // filles du pli, supprimées avec lui, et la restauration ne les recrée pas.
        warnings: [
          "Le courrier part à la CORBEILLE : l'administrateur peut le restaurer, avec ses pièces jointes et ses commentaires.",
          "Ses pièces nominatives (« qui a reçu quoi ») ne reviennent pas à la restauration. Les fichiers du Drive qu'il référence restent dans le Drive.",
        ],
        confirmText: entry.reference ?? entry.title,
        args: { id: entry.id },
        successMessage: `Courrier ${entry.reference ?? ""} mis à la corbeille — restaurable par l'administrateur.`,
        revalidate: ["/courriers"],
      };
    },
    execute: (args) => runFd(deleteMailEntry, args, "La suppression a été refusée.", { revalidate: ["/courriers"] }),
  },

  link_record: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const entry = await resolveMailEntry(opStr(input, "reference"), user);
      if ("error" in entry) return entry;
      const cible = await resolveLinkTarget(opStr(input, "kind"), opStr(input, "target"));
      if ("error" in cible) return cible;
      const cibleLabel = typeLabel(cible.entityType);
      return {
        title: `Relier le courrier à ${cibleLabel.toLowerCase()}`,
        fields: [
          { label: "Courrier", value: `${entry.reference ? `${entry.reference} — ` : ""}${entry.title}` },
          { label: cibleLabel, value: cible.label },
        ],
        args: { fromType: "MAIL_ENTRY", fromId: entry.id, toType: cible.entityType, toId: cible.entityId },
        successMessage: `Courrier « ${entry.title} » relié à « ${cible.label} » — visible des deux côtés.`,
        link: `/courriers/${entry.id}`, revalidate: MAIL_REVALIDATE,
      };
    },
    execute: (args) => runFd(addEntityLink, args, "Le lien a été refusé."),
  },

  unlink_record: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const entry = await resolveMailEntry(opStr(input, "reference"), user);
      if ("error" in entry) return entry;
      // Le registre range chaque paire dans l'ordre du flux : le courrier peut être de l'un OU
      // l'autre côté. On regarde les deux, et l'on n'affiche que l'AUTRE bout.
      const rows = await prisma.entityLink.findMany({
        where: {
          OR: [
            { fromType: "MAIL_ENTRY", fromId: entry.id },
            { toType: "MAIL_ENTRY", toId: entry.id },
          ],
        },
        select: { id: true, fromType: true, fromId: true, fromLabel: true, toType: true, toId: true, toLabel: true },
        orderBy: { createdAt: "asc" },
      });
      const links = rows.map((r) => {
        const estDepart = r.fromType === "MAIL_ENTRY" && r.fromId === entry.id;
        return {
          id: r.id,
          label: (estDepart ? r.toLabel : r.fromLabel) ?? (estDepart ? r.toId : r.fromId),
          typeLabel: typeLabel(String(estDepart ? r.toType : r.fromType)),
        };
      });
      if (links.length === 0) return { error: `Le courrier « ${entry.title} » n'a aucun lien à retirer.` };
      const q = opStr(input, "target").trim().toLowerCase();
      const hits = q ? links.filter((l) => l.label.toLowerCase().includes(q)) : links;
      if (hits.length === 0) return { error: `Aucun lien « ${opStr(input, "target")} » — présents : ${links.map((l) => l.label).join(" ; ")}.` };
      if (hits.length > 1) return { error: `Précisez le lien à retirer (champ « target ») parmi : ${hits.map((l) => `${l.typeLabel} · ${l.label}`).join(" ; ")}.` };
      return {
        title: `Retirer le lien « ${hits[0].label} »`,
        fields: [
          { label: "Courrier", value: `${entry.reference ? `${entry.reference} — ` : ""}${entry.title}` },
          { label: "Lien retiré", value: `${hits[0].typeLabel} · ${hits[0].label}` },
        ],
        args: { id: hits[0].id },
        successMessage: `Lien « ${hits[0].label} » retiré du courrier.`,
        link: `/courriers/${entry.id}`, revalidate: MAIL_REVALIDATE,
      };
    },
    execute: (args) => runFd(removeEntityLink, args, "Le retrait du lien a été refusé."),
  },

  create_entry: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const title = opStr(input, "label");
      if (!title) return { error: "Donnez l'objet du courrier (champ « label »)." };
      const direction = directionOf(opStr(input, "direction")) ?? "INCOMING";
      const sender = opStr(input, "sender");
      const recipient = opStr(input, "recipient");
      const reference = opStr(input, "reference");
      return {
        title: `Enregistrer le courrier ${direction === "INCOMING" ? "entrant" : "sortant"} — ${title}`,
        fields: [
          { label: "Objet", value: title },
          { label: "Sens", value: dirLabel(direction) },
          ...(sender ? [{ label: "Expéditeur", value: sender }] : []),
          ...(recipient ? [{ label: "Destinataire", value: recipient }] : []),
          ...(reference ? [{ label: "N° de chrono", value: reference }] : []),
        ],
        args: { title, direction, sender, recipient, reference, notes: opStr(input, "notes") },
        successMessage: `Courrier « ${title} » enregistré au registre.`,
        link: "/courriers",
        revalidate: MAIL_REVALIDATE,
      };
    },
    async execute(args) {
      const fd = new FormData();
      fd.set("title", args.title ?? "");
      fd.set("direction", args.direction ?? "INCOMING");
      if (args.sender) fd.set("sender", args.sender);
      if (args.recipient) fd.set("recipient", args.recipient);
      if (args.reference) fd.set("reference", args.reference);
      if (args.notes) fd.set("notes", args.notes);
      const r = await createMailEntry(undefined, fd);
      if (!r.ok) return { ok: false, error: r.error ?? "L'enregistrement du courrier a été refusé." };
      return { ok: true, createdId: r.id, link: r.id ? `/courriers/${r.id}` : "/courriers", revalidate: MAIL_REVALIDATE };
    },
  },

  edit_entry: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const entry = await resolveMailEntry(opStr(input, "reference") || opStr(input, "label"), user);
      if ("error" in entry) return entry;
      const current = await prisma.mailEntry.findUnique({
        where: { id: entry.id },
        select: { title: true, reference: true, direction: true },
      });
      if (!current) return { error: "Courrier introuvable." };
      // FUSION : seuls les champs CITÉS partent à l'action ; le noyau garde tout le reste — les
      // dates, le porteur, l'expéditeur qu'on ne cite pas. Rejouer l'existant ne suffisait pas : les
      // champs que la carte ne relisait pas (dates, porteur) étaient effacés à chaque correction.
      const args: Record<string, string> = { id: entry.id };
      const changes: string[] = [];
      const titre = opStr(input, "newLabel");
      if (titre && titre !== current.title) { args.title = titre; changes.push(`objet → ${titre}`); }
      const direction = directionOf(opStr(input, "direction"));
      if (direction && direction !== current.direction) { args.direction = direction; changes.push(`sens → ${dirLabel(direction)}`); }
      if (opStr(input, "sender")) { args.sender = opStr(input, "sender"); changes.push(`expéditeur → ${args.sender}`); }
      if (opStr(input, "recipient")) { args.recipient = opStr(input, "recipient"); changes.push(`destinataire → ${args.recipient}`); }
      if (opStr(input, "newReference")) { args.reference = opStr(input, "newReference"); changes.push(`chrono → ${args.reference}`); }
      if (opStr(input, "notes")) { args.notes = opStr(input, "notes"); changes.push("notes"); }
      if (changes.length === 0) return { error: "Rien à corriger : donnez newLabel, direction, sender, recipient, newReference ou notes." };
      const title = args.title ?? current.title;
      return {
        title: `Corriger le courrier « ${current.title} »`,
        fields: [
          { label: "Courrier", value: `${current.reference ? `${current.reference} — ` : ""}${current.title}` },
          { label: "Corrections", value: changes.join(" · ") },
        ],
        args,
        successMessage: `Courrier « ${title} » corrigé (${changes.join(", ")}).`,
        link: `/courriers/${entry.id}`,
        revalidate: MAIL_REVALIDATE,
      };
    },
    async execute(args) {
      // Seuls les champs cités sont posés : un champ absent du formulaire est INCHANGÉ (`readFields`).
      const fd = new FormData();
      for (const k of ["title", "direction", "sender", "recipient", "reference", "notes"] as const) {
        if (args[k]) fd.set(k, args[k]!);
      }
      const r = await editMailEntry(args.id ?? "", undefined, fd);
      if (!r.ok) return { ok: false, error: r.error ?? "La correction du courrier a été refusée." };
      return { ok: true, revalidate: MAIL_REVALIDATE };
    },
  },

  move_entries: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const raw = opStr(input, "reference") || opStr(input, "label");
      const targets = raw.split(/[;,]/).map((s) => s.trim()).filter(Boolean);
      if (targets.length === 0) return { error: "Donnez le ou les courriers à classer (champ « reference », séparés par des virgules)." };
      const entries: EntryHit[] = [];
      for (const t of targets) {
        const e = await resolveMailEntry(t, user);
        if ("error" in e) return e;
        entries.push(e);
      }
      const folderName = opStr(input, "folder");
      let folderId = "";
      let folderLabel = "Non classés";
      if (folderName && !/^non class/i.test(folderName)) {
        // Les dossiers que la personne VOIT — ceux de la liste (`companyScopedWhere`), pas ceux du voisin.
        const folders = await prisma.mailEntryFolder.findMany({
          where: await companyScopedWhere<Prisma.MailEntryFolderWhereInput>(user.id, { name: { contains: folderName, mode: "insensitive" } }),
          select: { id: true, name: true },
          take: 4,
        });
        if (folders.length === 0) return { error: `Aucun dossier de courriers « ${folderName} ».` };
        if (folders.length > 1) return { error: `Plusieurs dossiers correspondent à « ${folderName} » : ${folders.map((f) => f.name).join(", ")} — préciser.` };
        folderId = folders[0].id;
        folderLabel = folders[0].name;
      }
      return {
        title: `Classer ${entries.length} courrier(s) dans « ${folderLabel} »`,
        fields: [
          { label: "Courriers", value: entries.map((e) => e.reference || e.title).join(", ") },
          { label: "Dossier", value: folderLabel },
        ],
        args: { entryIds: entries.map((e) => e.id).join(","), folderId, folderLabel },
        successMessage: `${entries.length} courrier(s) classé(s) dans « ${folderLabel} ».`,
        link: "/courriers",
        revalidate: MAIL_REVALIDATE,
      };
    },
    async execute(args) {
      const fd = new FormData();
      for (const id of (args.entryIds ?? "").split(",").filter(Boolean)) fd.append("entryId", id);
      if (args.folderId) fd.set("folderId", args.folderId);
      const r = await moveMailEntries(fd);
      if (!r.ok) return { ok: false, error: r.error ?? "Le classement a été refusé." };
      return { ok: true, revalidate: MAIL_REVALIDATE };
    },
  },

  attach_drive: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const q = opStr(input, "name");
      if (!q) return { error: "Précisez le nom du fichier Drive à déclarer (champ « name »)." };
      // Résolution locale : fichier NON à la corbeille, accessible en lecture (l'action revérifie).
      const rows = await prisma.driveNode.findMany({
        where: { name: { contains: q, mode: "insensitive" }, type: "FILE", isTrashed: false },
        select: { id: true, name: true },
        orderBy: { updatedAt: "desc" },
        take: 6,
      });
      const visible: { id: string; name: string }[] = [];
      for (const r of rows) {
        if ((await resolveDriveAccess(user, r.id)) !== "NONE") visible.push(r);
      }
      if (visible.length === 0) return { error: `Aucun fichier Drive « ${q} » accessible.` };
      if (visible.length > 1 && !visible.some((v) => v.name.toLowerCase() === q.toLowerCase())) {
        return { error: `Plusieurs fichiers correspondent à « ${q} » : ${visible.map((v) => v.name).join(" ; ")} — préciser le nom exact.` };
      }
      const node = visible.find((v) => v.name.toLowerCase() === q.toLowerCase()) ?? visible[0];
      const direction = directionOf(opStr(input, "direction")) ?? "INCOMING";
      return {
        title: `Déclarer « ${node.name} » en courrier ${direction === "INCOMING" ? "entrant" : "sortant"}`,
        fields: [
          { label: "Fichier Drive", value: node.name },
          { label: "Sens", value: dirLabel(direction) },
          ...(opStr(input, "sender") ? [{ label: "Expéditeur", value: opStr(input, "sender") }] : []),
        ],
        warnings: ["Le fichier est RÉFÉRENCÉ, jamais copié — un fichier déjà déclaré n'est pas doublonné."],
        args: {
          driveNodeId: node.id, name: node.name, direction,
          sender: opStr(input, "sender"), recipient: opStr(input, "recipient"), reference: opStr(input, "reference"),
        },
        successMessage: `« ${node.name} » déclaré au registre des courriers.`,
        link: "/courriers",
        revalidate: MAIL_REVALIDATE,
      };
    },
    async execute(args) {
      const r = await attachDriveNodeToMail({
        driveNodeId: args.driveNodeId ?? "",
        direction: args.direction ?? undefined,
        sender: args.sender ?? undefined,
        recipient: args.recipient ?? undefined,
        reference: args.reference ?? undefined,
      });
      if (!r.ok) return { ok: false, error: r.error ?? "La déclaration en courrier a été refusée." };
      return { ok: true, createdId: r.id, link: r.id ? `/courriers/${r.id}` : "/courriers", revalidate: MAIL_REVALIDATE };
    },
  },
};
