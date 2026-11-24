import { prisma } from "@/lib/prisma";
import {
  createDriveSpace, updateDriveSpace, archiveDriveSpace, deleteDriveSpace,
} from "@/lib/actions/drive-space-actions";
import { copyNodes } from "@/lib/actions/drive-actions";
import { postDriveComment, deleteDriveComment } from "@/lib/actions/drive-comment-actions";
import { renameDocument, deleteDocument } from "@/lib/actions/document-actions";
import { updateLetterhead, deleteLetterhead } from "@/lib/actions/letterhead-actions";
import { attachDriveNodeToLegal, deleteLegalDocument } from "@/lib/actions/legal-actions";
import {
  createLegalFolder, updateLegalFolder, deleteLegalFolder, moveLegalDocuments,
} from "@/lib/actions/legal-folder-actions";
import { createMailFolder, updateMailFolder, deleteMailFolder } from "@/lib/actions/mail-folder-actions";
import { createMailPartner, updateMailPartner, deleteMailPartner } from "@/lib/actions/mail-partner-actions";
import { addMailPiece, updateMailPiece, deleteMailPiece } from "@/lib/actions/mail-piece-actions";
import { updateMailSignature } from "@/lib/actions/mail-actions";
import type { OpImpl, OpProposalDraft } from "./types";
import { opStr } from "./types";
import { runFd, runFd2, fieldsOf, resolveOne, isoDate } from "./helpers";

/**
 * OPS VAGUE 3 — DRIVE (catégories/espaces avec FUSION des accès, copie, commentaires, pièces
 * jointes d'entités, papiers en-tête), LEGAL (rattachement Drive sans copie, suppression,
 * dossiers de classement), COURRIERS (dates reçu/accusé, suppression, dossiers, partenaires,
 * pièces référencées du Drive, signature e-mail). Toujours par les ACTIONS CANONIQUES.
 */

const resolveSpace = (raw: string) =>
  resolveOne(raw, "la catégorie Drive (champ « name »)",
    (q) => prisma.driveSpace.findMany({ where: { name: { contains: q, mode: "insensitive" } }, select: { id: true, name: true, isArchived: true }, take: 6 }),
    (s) => s.name);

const resolvePerson = (raw: string) =>
  resolveOne(raw, "la personne",
    (q) => prisma.user.findMany({ where: { name: { contains: q, mode: "insensitive" }, isActive: true }, select: { id: true, name: true }, take: 6 }),
    (u) => u.name);

const resolveDriveNode = (raw: string) =>
  resolveOne(raw, "l'élément du Drive (champ « name »)",
    (q) => prisma.driveNode.findMany({ where: { name: { contains: q, mode: "insensitive" }, isTrashed: false }, select: { id: true, name: true, type: true }, orderBy: { updatedAt: "desc" }, take: 6 }),
    (n) => `${n.name}${n.type === "FOLDER" ? " (dossier)" : ""}`);

/** Une pièce jointe d'entité (modèle Document universel) — libellée avec son entité porteuse. */
const resolveAttachment = (raw: string) =>
  resolveOne(raw, "la pièce jointe (champ « name » — son nom de fichier)",
    (q) => prisma.document.findMany({ where: { name: { contains: q, mode: "insensitive" } }, select: { id: true, name: true, entityType: true, entityId: true }, orderBy: { createdAt: "desc" }, take: 6 }),
    (d) => `${d.name} (${d.entityType})`);

const resolveLetterhead = (raw: string) =>
  resolveOne(raw, "le papier en-tête (champ « name »)",
    (q) => prisma.officeLetterhead.findMany({ where: { name: { contains: q, mode: "insensitive" } }, select: { id: true, name: true, isActive: true }, take: 6 }),
    (l) => l.name);

const resolveLegalDoc = (raw: string) =>
  resolveOne(raw, "le document légal (champ « reference » — titre ou référence)",
    (q) => prisma.legalDocument.findMany({
      where: { OR: [{ title: { contains: q, mode: "insensitive" } }, { reference: { contains: q, mode: "insensitive" } }] },
      select: { id: true, title: true, reference: true, kind: true }, orderBy: { createdAt: "desc" }, take: 6,
    }),
    (d) => `${d.title}${d.reference ? ` (${d.reference})` : ""}`);

const resolveLegalFolder = (raw: string) =>
  resolveOne(raw, "le dossier Legal (champ « folder »)",
    (q) => prisma.legalFolder.findMany({ where: { name: { contains: q, mode: "insensitive" } }, select: { id: true, name: true }, take: 6 }),
    (f) => f.name);

const resolveMailEntry = (raw: string) =>
  resolveOne(raw, "le courrier (champ « reference » — n° de chrono ou objet)",
    (q) => prisma.mailEntry.findMany({
      where: { OR: [{ reference: { equals: q, mode: "insensitive" } }, { title: { contains: q, mode: "insensitive" } }] },
      select: { id: true, reference: true, title: true, direction: true }, orderBy: { createdAt: "desc" }, take: 6,
    }),
    (m) => `${m.reference ?? "s/n"} — ${m.title}`);

const resolveMailFolder = (raw: string) =>
  resolveOne(raw, "le dossier de classement (champ « folder »)",
    (q) => prisma.mailEntryFolder.findMany({ where: { name: { contains: q, mode: "insensitive" } }, select: { id: true, name: true }, take: 6 }),
    (f) => f.name);

const resolveMailPartner = (raw: string) =>
  resolveOne(raw, "le partenaire (champ « name »)",
    (q) => prisma.mailPartner.findMany({ where: { name: { contains: q, mode: "insensitive" } }, select: { id: true, name: true, kind: true, contact: true, isActive: true }, take: 6 }),
    (p) => p.name);

async function resolveMailPiece(entryId: string, entryLabel: string, raw: string) {
  const pieces = await prisma.mailEntryPiece.findMany({
    where: { entryId }, select: { id: true, label: true, recipient: true }, take: 12,
  });
  if (pieces.length === 0) return { error: `Le courrier ${entryLabel} n'a aucune pièce.` } as const;
  const q = raw.trim().toLowerCase();
  if (!q) {
    if (pieces.length === 1) return pieces[0];
    return { error: `Précisez la pièce (champ « piece ») parmi : ${pieces.map((p) => p.label).join(", ")}.` } as const;
  }
  const hits = pieces.filter((p) => p.label.toLowerCase().includes(q));
  if (hits.length === 1) return hits[0];
  if (hits.length === 0) return { error: `Aucune pièce « ${raw} » dans ${entryLabel} — pièces : ${pieces.map((p) => p.label).join(", ")}.` } as const;
  return { error: `Plusieurs pièces correspondent : ${hits.map((p) => p.label).join(", ")} — préciser.` } as const;
}

export const DRIVE3_OPS_IMPL: Record<string, OpImpl> = {
  create_space: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const name = opStr(input, "name");
      if (!name) return { error: "Précisez le nom de la catégorie (champ « name »)." };
      return {
        title: `Créer la catégorie Drive « ${name} »`,
        fields: fieldsOf([["Catégorie", name], ["Icône", opStr(input, "icon") || null]]),
        warnings: ["Les accès (lecture / gestion) se règlent ensuite — la catégorie naît visible de ses gestionnaires."],
        args: { name, icon: opStr(input, "icon") || null },
        successMessage: `Catégorie Drive « ${name} » créée.`,
        link: "/drive", revalidate: ["/drive"],
      };
    },
    execute: (args) => runFd(createDriveSpace, args, "La création de la catégorie a été refusée.", { revalidate: ["/drive"] }),
  },

  update_space: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const space = await resolveSpace(opStr(input, "name"));
      if ("error" in space) return space;
      // FUSION : l'action REMPLACE nom, icône et les QUATRE listes d'accès — tout est relu
      // et rejoué, seuls le nom/l'icône demandés et l'ajout/retrait ciblé d'une personne changent.
      const current = await prisma.driveSpace.findUnique({
        where: { id: space.id },
        select: { name: true, icon: true, accessRoles: true, accessUserIds: true, managerRoles: true, managerUserIds: true },
      });
      if (!current) return { error: "Catégorie introuvable." };
      const newName = opStr(input, "newName") || current.name;
      let access = [...current.accessUserIds];
      let personLabel: string | null = null;
      const personRaw = opStr(input, "person");
      if (personRaw) {
        const person = await resolvePerson(personRaw);
        if ("error" in person) return person;
        const remove = /retire|enl[èe]ve|remove/i.test(opStr(input, "mode"));
        access = remove ? access.filter((id) => id !== person.id) : [...new Set([...access, person.id])];
        personLabel = `${remove ? "Retirer" : "Donner"} la lecture à ${person.name}`;
      }
      return {
        title: `Modifier la catégorie Drive « ${current.name} »`,
        fields: fieldsOf([
          ["Nom", newName !== current.name ? `${current.name} → ${newName}` : current.name],
          ["Accès", personLabel],
          ["Le reste", "rejoué à l'identique (rôles, gestionnaires, icône)"],
        ]),
        args: {
          id: space.id, name: newName, icon: opStr(input, "icon") || current.icon,
          accessRoles: current.accessRoles.join(","), accessUserIds: access.join(","),
          managerRoles: current.managerRoles.join(","), managerUserIds: current.managerUserIds.join(","),
        },
        successMessage: `Catégorie « ${newName} » mise à jour.`,
        revalidate: ["/drive"],
      };
    },
    async execute(args) {
      const fd = new FormData();
      for (const k of ["id", "name", "icon"]) if (args[k]) fd.set(k, args[k] as string);
      for (const k of ["accessRoles", "accessUserIds", "managerRoles", "managerUserIds"]) {
        for (const v of (args[k] ?? "").split(",").filter(Boolean)) fd.append(k, v);
      }
      const r = await updateDriveSpace(fd);
      if (!r.ok) return { ok: false, error: r.error ?? "La modification de la catégorie a été refusée." };
      return { ok: true, revalidate: ["/drive"] };
    },
  },

  archive_space: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const space = await resolveSpace(opStr(input, "name"));
      if ("error" in space) return space;
      const unarchive = /d[ée]sarchive|r[ée]active|r[ée]affiche/i.test(opStr(input, "mode")) || space.isArchived;
      return {
        title: `${unarchive ? "Désarchiver" : "Archiver"} la catégorie « ${space.name} »`,
        fields: [{ label: "Catégorie", value: space.name }, { label: "État", value: unarchive ? "Réaffichée dans les onglets" : "Masquée des onglets (rien n'est supprimé)" }],
        args: { id: space.id, archived: unarchive ? "0" : "1" },
        successMessage: `Catégorie « ${space.name} » ${unarchive ? "désarchivée" : "archivée"}.`,
        revalidate: ["/drive"],
      };
    },
    execute: (args) => runFd(archiveDriveSpace, args, "L'archivage a été refusé.", { revalidate: ["/drive"] }),
  },

  delete_space: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const space = await resolveSpace(opStr(input, "name"));
      if ("error" in space) return space;
      return {
        title: `SUPPRIMER la catégorie Drive « ${space.name} »`,
        fields: [{ label: "Catégorie", value: space.name }],
        warnings: ["La catégorie ET tout son contenu partent à la corbeille du Super Admin — restaurables ensemble, jusqu'à destruction réelle."],
        confirmText: space.name,
        args: { id: space.id },
        successMessage: `Catégorie « ${space.name} » mise à la corbeille.`,
        revalidate: ["/drive"],
      };
    },
    execute: (args) => runFd(deleteDriveSpace, args, "La suppression de la catégorie a été refusée.", { revalidate: ["/drive"] }),
  },

  copy: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const node = await resolveDriveNode(opStr(input, "name"));
      if ("error" in node) return node;
      const targetRaw = opStr(input, "folder");
      if (!targetRaw) return { error: "Précisez le dossier de destination (champ « folder »)." };
      const target = await resolveDriveNode(targetRaw);
      if ("error" in target) return target;
      if (target.type !== "FOLDER") return { error: `« ${target.name} » n'est pas un dossier.` };
      return {
        title: `Copier « ${node.name} » dans « ${target.name} »`,
        fields: [
          { label: "Élément", value: node.name },
          { label: "Destination", value: target.name },
        ],
        warnings: ["COPIE (l'original reste en place) — l'ACL du dossier de destination s'applique à la copie."],
        args: { id: node.id, targetId: target.id },
        successMessage: `« ${node.name} » copié dans « ${target.name} ».`,
        link: "/drive", revalidate: ["/drive"],
      };
    },
    async execute(args) {
      const fd = new FormData();
      fd.append("id", args.id ?? "");
      fd.set("targetId", args.targetId ?? "");
      const r = await copyNodes(fd);
      if (!r.ok) return { ok: false, error: r.error ?? "La copie a été refusée." };
      return { ok: true, revalidate: ["/drive"] };
    },
  },

  comment: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const node = await resolveDriveNode(opStr(input, "name"));
      if ("error" in node) return node;
      const body = opStr(input, "comment") || opStr(input, "message");
      if (!body) return { error: "Écrivez le commentaire (champ « comment »)." };
      return {
        title: `Commenter « ${node.name} »`,
        fields: [{ label: "Élément", value: node.name }, { label: "Commentaire", value: body }],
        args: { nodeId: node.id, body },
        successMessage: `Commentaire posé sur « ${node.name} ».`,
        revalidate: ["/drive"],
      };
    },
    execute: (args) => runFd(postDriveComment, args, "Le commentaire a été refusé.", { revalidate: ["/drive"] }),
  },

  delete_comment: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const node = await resolveDriveNode(opStr(input, "name"));
      if ("error" in node) return node;
      const needle = opStr(input, "comment") || opStr(input, "message");
      const rows = await prisma.driveComment.findMany({
        where: { nodeId: node.id, ...(needle ? { body: { contains: needle, mode: "insensitive" } } : {}) },
        select: { id: true, body: true, author: { select: { name: true } } },
        orderBy: { createdAt: "desc" }, take: 6,
      });
      if (rows.length === 0) return { error: `Aucun commentaire${needle ? ` contenant « ${needle} »` : ""} sur « ${node.name} ».` };
      if (rows.length > 1) return { error: `Plusieurs commentaires correspondent : ${rows.map((r) => `« ${r.body.slice(0, 40)} » (${r.author?.name ?? "—"})`).join(" ; ")} — préciser (champ « comment »).` };
      return {
        title: `Supprimer le commentaire sur « ${node.name} »`,
        fields: [{ label: "Commentaire", value: `« ${rows[0].body.slice(0, 120)} » — ${rows[0].author?.name ?? "—"}` }],
        warnings: ["Suppression définitive (auteur du commentaire, ou gestionnaire de l'élément)."],
        args: { id: rows[0].id },
        successMessage: "Commentaire supprimé.",
        revalidate: ["/drive"],
      };
    },
    execute: (args) => runFd(deleteDriveComment, args, "La suppression du commentaire a été refusée.", { revalidate: ["/drive"] }),
  },

  rename_attachment: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const doc = await resolveAttachment(opStr(input, "name"));
      if ("error" in doc) return doc;
      const newName = opStr(input, "newName");
      if (!newName) return { error: "Précisez le nouveau nom (champ « newName »)." };
      return {
        title: `Renommer la pièce « ${doc.name} »`,
        fields: [
          { label: "Pièce", value: `${doc.name} (${doc.entityType})` },
          { label: "Nouveau nom", value: newName },
        ],
        args: { id: doc.id, newName },
        successMessage: `Pièce renommée « ${newName} ».`,
        revalidate: [],
      };
    },
    async execute(args) {
      const r = await renameDocument(args.id ?? "", args.newName ?? "");
      if (!r.ok) return { ok: false, error: r.error ?? "Le renommage a été refusé." };
      return { ok: true };
    },
  },

  delete_attachment: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const doc = await resolveAttachment(opStr(input, "name"));
      if ("error" in doc) return doc;
      return {
        title: `SUPPRIMER la pièce « ${doc.name} »`,
        fields: [{ label: "Pièce", value: `${doc.name} (${doc.entityType})` }],
        warnings: ["La pièce part à la corbeille (restaurable par le Super Admin) ; elle est refusée si elle justifie un paiement ou une étape terminée."],
        confirmText: doc.name,
        args: { id: doc.id },
        successMessage: `Pièce « ${doc.name} » mise à la corbeille.`,
        revalidate: [],
      };
    },
    async execute(args) {
      const r = await deleteDocument(args.id ?? "");
      if (!r.ok) return { ok: false, error: r.error ?? "La suppression a été refusée." };
      return { ok: true };
    },
  },

  update_letterhead: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const lh = await resolveLetterhead(opStr(input, "name"));
      if ("error" in lh) return lh;
      const newName = opStr(input, "newName");
      const modeRaw = opStr(input, "mode");
      const deactivate = /d[ée]sactiv|inactif/i.test(modeRaw);
      const activate = /^activ|r[ée]activ/i.test(modeRaw);
      if (!newName && !deactivate && !activate) return { error: "Précisez ce qui change : « newName », ou « mode » (activer / désactiver)." };
      return {
        title: `Modifier le papier en-tête « ${lh.name} »`,
        fields: fieldsOf([
          ["En-tête", lh.name],
          ["Nouveau nom", newName || null],
          ["État", deactivate ? "Désactivé (plus proposé à la création)" : activate ? "Réactivé" : null],
        ]),
        args: { id: lh.id, name: newName || null, isActive: deactivate ? "0" : activate ? "1" : null },
        successMessage: `Papier en-tête « ${newName || lh.name} » mis à jour.`,
        revalidate: ["/drive"],
      };
    },
    execute: (args) => runFd(updateLetterhead, args, "La modification de l'en-tête a été refusée.", { revalidate: ["/drive"] }),
  },

  delete_letterhead: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const lh = await resolveLetterhead(opStr(input, "name"));
      if ("error" in lh) return lh;
      return {
        title: `SUPPRIMER le papier en-tête « ${lh.name} »`,
        fields: [{ label: "En-tête", value: lh.name }],
        warnings: ["Le modèle et son binaire disparaissent — les documents DÉJÀ créés dessus ne bougent pas (ils portent leur propre copie)."],
        confirmText: lh.name,
        args: { id: lh.id },
        successMessage: `Papier en-tête « ${lh.name} » supprimé.`,
        revalidate: ["/drive"],
      };
    },
    execute: (args) => runFd(deleteLetterhead, args, "La suppression de l'en-tête a été refusée.", { revalidate: ["/drive"] }),
  },
};

export const LEGAL3_OPS_IMPL: Record<string, OpImpl> = {
  attach_drive: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const node = await resolveDriveNode(opStr(input, "name"));
      if ("error" in node) return node;
      if (node.type === "FOLDER") return { error: "Un DOSSIER ne se déclare pas en Legal — visez un fichier." };
      const title = opStr(input, "label") || node.name;
      return {
        title: `Déclarer « ${node.name} » comme document légal`,
        fields: fieldsOf([
          ["Fichier Drive", node.name],
          ["Titre Legal", title],
          ["Type", opStr(input, "kind") || "Contrat (défaut)"],
          ["Début", isoDate(opStr(input, "startDate"))], ["Fin", isoDate(opStr(input, "endDate"))],
        ]),
        warnings: ["SANS COPIE : Legal pointe sur le fichier du Drive — supprimer la fiche Legal ne supprimera jamais le fichier."],
        args: {
          nodeId: node.id, title, kind: opStr(input, "kind") || null,
          startDate: isoDate(opStr(input, "startDate")), endDate: isoDate(opStr(input, "endDate")),
          counterparty: opStr(input, "counterparty") || null, notes: opStr(input, "notes") || null,
        },
        successMessage: `« ${title} » déclaré en Legal (fichier référencé, jamais copié).`,
        link: "/legal", revalidate: ["/legal", "/drive"],
      };
    },
    async execute(args) {
      const r = await attachDriveNodeToLegal({
        driveNodeId: args.nodeId ?? "",
        title: args.title ?? undefined,
        kind: args.kind ?? undefined,
        startDate: args.startDate ?? undefined,
        endDate: args.endDate ?? undefined,
        // Le nom est RÉSOLU contre l'annuaire par l'action : introuvable ou ambigu, elle refuse
        // et le dit. Un modèle propose un nom, il ne crée pas une partie.
        counterpartyName: args.counterparty ?? undefined,
        notes: args.notes ?? undefined,
      });
      if (!r.ok) return { ok: false, error: r.error ?? "Le rattachement a été refusé." };
      return { ok: true, link: "/legal", revalidate: ["/legal", "/drive"] };
    },
  },

  delete_document: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const doc = await resolveLegalDoc(opStr(input, "reference") || opStr(input, "label"));
      if ("error" in doc) return doc;
      return {
        title: `SUPPRIMER le document légal « ${doc.title} »`,
        fields: [{ label: "Document", value: `${doc.title}${doc.reference ? ` (${doc.reference})` : ""}` }],
        warnings: ["Suppression définitive de la FICHE Legal — un fichier Drive référencé, lui, reste intact."],
        confirmText: doc.title,
        args: { id: doc.id },
        successMessage: `Document légal « ${doc.title} » supprimé.`,
        revalidate: ["/legal"],
      };
    },
    execute: (args) => runFd(deleteLegalDocument, args, "La suppression a été refusée.", { revalidate: ["/legal"] }),
  },

  create_folder: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const name = opStr(input, "folder") || opStr(input, "name");
      if (!name) return { error: "Précisez le nom du dossier (champ « folder »)." };
      let parentId: string | null = null; let parentName: string | null = null;
      if (opStr(input, "parent")) {
        const parent = await resolveLegalFolder(opStr(input, "parent"));
        if ("error" in parent) return parent;
        parentId = parent.id; parentName = parent.name;
      }
      return {
        title: `Créer le dossier Legal « ${name} »`,
        fields: fieldsOf([["Dossier", name], ["Dans", parentName]]),
        args: { name, parentId, description: opStr(input, "notes") || null },
        successMessage: `Dossier Legal « ${name} » créé.`,
        revalidate: ["/legal"],
      };
    },
    execute: (args) => runFd2(createLegalFolder, args, "La création du dossier a été refusée.", { revalidate: ["/legal"] }),
  },

  rename_folder: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const folder = await resolveLegalFolder(opStr(input, "folder") || opStr(input, "name"));
      if ("error" in folder) return folder;
      const newName = opStr(input, "newName");
      if (!newName) return { error: "Précisez le nouveau nom (champ « newName »)." };
      return {
        title: `Renommer le dossier Legal « ${folder.name} » → « ${newName} »`,
        fields: [{ label: "Dossier", value: `${folder.name} → ${newName}` }],
        args: { id: folder.id, name: newName },
        successMessage: `Dossier renommé « ${newName} ».`,
        revalidate: ["/legal"],
      };
    },
    execute: (args) => runFd(updateLegalFolder, args, "Le renommage a été refusé.", { revalidate: ["/legal"] }),
  },

  delete_folder: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const folder = await resolveLegalFolder(opStr(input, "folder") || opStr(input, "name"));
      if ("error" in folder) return folder;
      return {
        title: `Supprimer le dossier Legal « ${folder.name} »`,
        fields: [{ label: "Dossier", value: folder.name }],
        warnings: ["Les documents du dossier repassent « non classés » — aucun document n'est supprimé."],
        args: { id: folder.id },
        successMessage: `Dossier « ${folder.name} » supprimé (documents déclassés).`,
        revalidate: ["/legal"],
      };
    },
    execute: (args) => runFd(deleteLegalFolder, args, "La suppression du dossier a été refusée.", { revalidate: ["/legal"] }),
  },

  move_documents: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const refsRaw = opStr(input, "reference") || opStr(input, "label");
      if (!refsRaw) return { error: "Précisez le ou les documents (champ « reference », séparés par des virgules)." };
      const ids: string[] = []; const names: string[] = [];
      for (const part of refsRaw.split(/[;,]/).map((p) => p.trim()).filter(Boolean)) {
        const doc = await resolveLegalDoc(part);
        if ("error" in doc) return doc;
        ids.push(doc.id); names.push(doc.title);
      }
      const folderRaw = opStr(input, "folder");
      const unclassify = /^(aucun|non class[ée]s?|sortir|retirer)$/i.test(folderRaw);
      let folderId: string | null = null; let folderName = "Non classés";
      if (!unclassify) {
        if (!folderRaw) return { error: "Précisez le dossier de destination (champ « folder » — « aucun » pour déclasser)." };
        const folder = await resolveLegalFolder(folderRaw);
        if ("error" in folder) return folder;
        folderId = folder.id; folderName = folder.name;
      }
      return {
        title: `Classer ${names.length} document·s Legal dans « ${folderName} »`,
        fields: [
          { label: "Documents", value: names.join(", ") },
          { label: "Destination", value: folderName },
        ],
        args: { documentIds: ids.join(","), folderId },
        successMessage: `${names.length} document·s classé·s dans « ${folderName} ».`,
        revalidate: ["/legal"],
      };
    },
    async execute(args) {
      const fd = new FormData();
      for (const id of (args.documentIds ?? "").split(",").filter(Boolean)) fd.append("documentId", id);
      if (args.folderId) fd.set("folderId", args.folderId);
      const r = await moveLegalDocuments(fd);
      if (!r.ok) return { ok: false, error: r.error ?? "Le classement a été refusé." };
      return { ok: true, revalidate: ["/legal"] };
    },
  },
};

/**
 * Ce qui reste ici du registre des courriers : les DOSSIERS de classement, les PARTENAIRES, les
 * PIÈCES nominatives et la signature. Les ops qui écrivent le pli lui-même (dater, supprimer)
 * ont rejoint `impl-mail.ts`, avec créer / corriger / classer / relier — un seul fichier pour
 * les gestes du registre, au lieu de deux qui se partageaient la même action serveur.
 */
export const MAIL3_OPS_IMPL: Record<string, OpImpl> = {
  create_folder: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const name = opStr(input, "folder") || opStr(input, "name");
      if (!name) return { error: "Précisez le nom du dossier (champ « folder »)." };
      let parentId: string | null = null; let parentName: string | null = null;
      if (opStr(input, "parent")) {
        const parent = await resolveMailFolder(opStr(input, "parent"));
        if ("error" in parent) return parent;
        parentId = parent.id; parentName = parent.name;
      }
      return {
        title: `Créer le dossier de classement « ${name} »`,
        fields: fieldsOf([["Dossier", name], ["Dans", parentName]]),
        args: { name, parentId, description: opStr(input, "notes") || null },
        successMessage: `Dossier « ${name} » créé (registre des courriers).`,
        revalidate: ["/courriers"],
      };
    },
    execute: (args) => runFd2(createMailFolder, args, "La création du dossier a été refusée.", { revalidate: ["/courriers"] }),
  },

  rename_folder: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const folder = await resolveMailFolder(opStr(input, "folder") || opStr(input, "name"));
      if ("error" in folder) return folder;
      const newName = opStr(input, "newName");
      if (!newName) return { error: "Précisez le nouveau nom (champ « newName »)." };
      return {
        title: `Renommer le dossier « ${folder.name} » → « ${newName} »`,
        fields: [{ label: "Dossier", value: `${folder.name} → ${newName}` }],
        args: { id: folder.id, name: newName },
        successMessage: `Dossier renommé « ${newName} ».`,
        revalidate: ["/courriers"],
      };
    },
    execute: (args) => runFd(updateMailFolder, args, "Le renommage a été refusé.", { revalidate: ["/courriers"] }),
  },

  delete_folder: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const folder = await resolveMailFolder(opStr(input, "folder") || opStr(input, "name"));
      if ("error" in folder) return folder;
      return {
        title: `Supprimer le dossier « ${folder.name} »`,
        fields: [{ label: "Dossier", value: folder.name }],
        warnings: ["Les courriers du dossier repassent « non classés » — aucun courrier n'est supprimé."],
        args: { id: folder.id },
        successMessage: `Dossier « ${folder.name} » supprimé (courriers déclassés).`,
        revalidate: ["/courriers"],
      };
    },
    execute: (args) => runFd(deleteMailFolder, args, "La suppression du dossier a été refusée.", { revalidate: ["/courriers"] }),
  },

  create_partner: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const name = opStr(input, "name");
      if (!name) return { error: "Précisez le nom du partenaire (champ « name »)." };
      return {
        title: `Nouveau partenaire courrier « ${name} »`,
        fields: fieldsOf([
          ["Partenaire", name], ["Nature", opStr(input, "kind") || null],
          ["Contact", opStr(input, "contact") || null], ["Notes", opStr(input, "notes") || null],
        ]),
        args: { name, kind: opStr(input, "kind") || null, contact: opStr(input, "contact") || null, notes: opStr(input, "notes") || null },
        successMessage: `Partenaire « ${name} » ajouté au registre.`,
        revalidate: ["/courriers"],
      };
    },
    execute: (args) => runFd2(createMailPartner, args, "La création du partenaire a été refusée.", { revalidate: ["/courriers"] }),
  },

  update_partner: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const partner = await resolveMailPartner(opStr(input, "name"));
      if ("error" in partner) return partner;
      const newName = opStr(input, "newName") || partner.name;
      const deactivate = /d[ée]sactiv|inactif/i.test(opStr(input, "mode"));
      const activate = /^activ|r[ée]activ/i.test(opStr(input, "mode"));
      return {
        title: `Modifier le partenaire « ${partner.name} »`,
        fields: fieldsOf([
          ["Nom", newName !== partner.name ? `${partner.name} → ${newName}` : partner.name],
          ["Nature", opStr(input, "kind") || partner.kind],
          ["Contact", opStr(input, "contact") || partner.contact],
          ["État", deactivate ? "Désactivé" : activate ? "Réactivé" : null],
        ]),
        // FUSION : nature et contact existants rejoués si non fournis (l'action REMPLACE).
        args: {
          id: partner.id, name: newName, kind: opStr(input, "kind") || partner.kind,
          contact: opStr(input, "contact") || partner.contact, notes: opStr(input, "notes") || null,
          isActive: deactivate ? "0" : activate ? "1" : (partner.isActive ? "1" : "0"),
        },
        successMessage: `Partenaire « ${newName} » mis à jour.`,
        revalidate: ["/courriers"],
      };
    },
    execute: (args) => runFd(updateMailPartner, args, "La modification du partenaire a été refusée.", { revalidate: ["/courriers"] }),
  },

  delete_partner: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const partner = await resolveMailPartner(opStr(input, "name"));
      if ("error" in partner) return partner;
      return {
        title: `Supprimer le partenaire « ${partner.name} »`,
        fields: [{ label: "Partenaire", value: partner.name }],
        warnings: ["Les courriers déjà enregistrés gardent leur libellé — seule l'entrée du registre des partenaires disparaît."],
        args: { id: partner.id },
        successMessage: `Partenaire « ${partner.name} » supprimé.`,
        revalidate: ["/courriers"],
      };
    },
    execute: (args) => runFd(deleteMailPartner, args, "La suppression du partenaire a été refusée.", { revalidate: ["/courriers"] }),
  },

  add_piece: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const entry = await resolveMailEntry(opStr(input, "reference") || opStr(input, "label"));
      if ("error" in entry) return entry;
      const node = await resolveDriveNode(opStr(input, "name"));
      if ("error" in node) return node;
      if (node.type === "FOLDER") return { error: "Une pièce de courrier est un FICHIER — visez un fichier du Drive." };
      const label = opStr(input, "piece") || node.name;
      return {
        title: `Joindre « ${node.name} » au courrier ${entry.reference ?? entry.title}`,
        fields: fieldsOf([
          ["Courrier", `${entry.reference ?? "s/n"} — ${entry.title}`],
          ["Pièce (fichier Drive)", node.name],
          ["Libellé", label !== node.name ? label : null],
          ["Destinataire de la pièce", opStr(input, "recipient") || null],
        ]),
        warnings: ["RÉFÉRENCE SANS COPIE : la pièce pointe sur le fichier du Drive."],
        args: { entryId: entry.id, driveNodeId: node.id, label, recipient: opStr(input, "recipient") || null, notes: opStr(input, "notes") || null },
        successMessage: `Pièce « ${label} » jointe au courrier ${entry.reference ?? ""}.`,
        revalidate: ["/courriers"],
      };
    },
    execute: (args) => runFd(addMailPiece, args, "L'ajout de la pièce a été refusé.", { revalidate: ["/courriers"] }),
  },

  update_piece: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const entry = await resolveMailEntry(opStr(input, "reference") || opStr(input, "label"));
      if ("error" in entry) return entry;
      const piece = await resolveMailPiece(entry.id, entry.reference ?? entry.title, opStr(input, "piece"));
      if ("error" in piece) return piece;
      const newLabel = opStr(input, "newName") || piece.label;
      const recipient = opStr(input, "recipient") || piece.recipient;
      return {
        title: `Modifier la pièce « ${piece.label} » (${entry.reference ?? entry.title})`,
        fields: fieldsOf([
          ["Pièce", newLabel !== piece.label ? `${piece.label} → ${newLabel}` : piece.label],
          ["Destinataire", recipient],
        ]),
        args: { id: piece.id, label: newLabel, recipient },
        successMessage: `Pièce « ${newLabel} » mise à jour.`,
        revalidate: ["/courriers"],
      };
    },
    execute: (args) => runFd(updateMailPiece, args, "La modification de la pièce a été refusée.", { revalidate: ["/courriers"] }),
  },

  delete_piece: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const entry = await resolveMailEntry(opStr(input, "reference") || opStr(input, "label"));
      if ("error" in entry) return entry;
      const piece = await resolveMailPiece(entry.id, entry.reference ?? entry.title, opStr(input, "piece"));
      if ("error" in piece) return piece;
      return {
        title: `Retirer la pièce « ${piece.label} » du courrier ${entry.reference ?? entry.title}`,
        fields: [{ label: "Pièce", value: `${piece.label} — ${entry.reference ?? entry.title}` }],
        warnings: ["La référence est retirée du courrier — un fichier Drive référencé reste intact."],
        args: { id: piece.id },
        successMessage: `Pièce « ${piece.label} » retirée.`,
        revalidate: ["/courriers"],
      };
    },
    execute: (args) => runFd(deleteMailPiece, args, "Le retrait de la pièce a été refusé.", { revalidate: ["/courriers"] }),
  },

  set_signature: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const signature = opStr(input, "message") || opStr(input, "notes");
      const clearing = /^(aucune?|retire|efface|vide)$/i.test(opStr(input, "mode")) || (!signature && /retire|efface/i.test(opStr(input, "message")));
      if (!signature && !clearing) return { error: "Donnez la signature (champ « message ») — ou « mode » = retirer pour l'effacer." };
      return {
        title: clearing ? "Retirer ma signature e-mail" : "Régler ma signature e-mail",
        fields: [{ label: "Signature", value: clearing ? "— (retirée)" : signature.slice(0, 200) }],
        warnings: ["La signature s'applique à VOTRE boîte connectée (elle est ajoutée aux envois)."],
        args: { signature: clearing ? null : signature },
        successMessage: clearing ? "Signature retirée." : "Signature e-mail mise à jour.",
        revalidate: ["/courrier"],
      };
    },
    execute: (args) => runFd(updateMailSignature, args, "Le réglage de la signature a été refusé.", { revalidate: ["/courrier"] }),
  },
};
