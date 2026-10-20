import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/session";
import { resolveDriveAccess, canCreateInSpace, type DriveAccessLevel } from "@/lib/drive";
import { convertConfigured } from "@/lib/office-convert";
import type { OfficeKind } from "@/lib/office-templates";
import {
  createFolder, renameNode, moveNode, trashNode, restoreNode, deleteNode,
  shareNodeWithMany, unshareNode, createOfficeNode, convertNodeToPdf,
} from "@/lib/actions/drive-actions";
import type { OpImpl, OpProposalDraft } from "./types";
import { opStr } from "./types";

/**
 * OPS DRIVE — résolution par NOM (l'utilisateur dit « le dossier Campagne », jamais un id),
 * ACL RÉELLE par nœud (`resolveDriveAccess`, la même que l'écran), exécution par les ACTIONS
 * CANONIQUES de `drive-actions.ts`. Jamais un `prisma.update` improvisé : les gardes, cascades
 * (sous-arbres), notifications et audits de l'écran s'appliquent tels quels.
 *
 * Résolution : correspondance exacte d'abord, sinon un candidat UNIQUE, sinon la liste des
 * candidats avec leur emplacement — jamais un choix silencieux à la place de l'humain.
 */

interface DriveHit { id: string; name: string; type: string; where: string; access: DriveAccessLevel }

async function resolveDriveNode(
  user: CurrentUser,
  raw: string,
  opts: { type?: "FILE" | "FOLDER"; trashed?: boolean | "any"; need: "VIEW" | "EDIT" },
): Promise<DriveHit | { error: string }> {
  const q = raw.trim();
  if (!q) return { error: "Précisez le nom de l'élément Drive visé (champ « name »)." };
  const trashed = opts.trashed ?? false;
  const rows = await prisma.driveNode.findMany({
    where: {
      name: { contains: q, mode: "insensitive" },
      ...(trashed === "any" ? {} : { isTrashed: trashed }),
      ...(opts.type ? { type: opts.type } : {}),
    },
    select: { id: true, name: true, type: true, isTrashed: true, parent: { select: { name: true } } },
    orderBy: { updatedAt: "desc" },
    take: 8,
  });
  // L'ACL se vérifie nœud par nœud — la liste ne montre JAMAIS un élément que la personne
  // ne verrait pas à l'écran, et une écriture exige le niveau ÉDITEUR dès la proposition.
  const visible: DriveHit[] = [];
  let seenButDenied = 0;
  for (const r of rows) {
    const access = await resolveDriveAccess(user, r.id);
    if (access === "NONE" || (opts.need === "EDIT" && access !== "EDIT")) {
      if (access !== "NONE") seenButDenied += 1;
      continue;
    }
    visible.push({
      id: r.id, name: r.name, type: r.type,
      where: r.isTrashed ? "corbeille Drive" : r.parent?.name ? `dans « ${r.parent.name} »` : "à la racine",
      access,
    });
    if (visible.length >= 6) break;
  }
  if (visible.length === 0) {
    if (seenButDenied > 0) {
      return { error: `« ${q} » existe mais vous n'avez pas le droit d'ÉDITION dessus — demandez le partage en modification à son propriétaire.` };
    }
    return { error: `Aucun élément Drive « ${q} »${trashed === true ? " dans la corbeille" : ""}${opts.type === "FOLDER" ? " (dossier)" : ""} accessible. Vérifier le nom (find_documents peut aider).` };
  }
  const exact = visible.filter((v) => v.name.toLowerCase() === q.toLowerCase());
  if (exact.length === 1) return exact[0];
  if (visible.length === 1) return visible[0];
  return {
    error: `Plusieurs éléments correspondent à « ${q} » : ${visible.map((v) => `${v.name} (${v.where})`).join(" ; ")} — préciser le nom exact.`,
  };
}

/** Destination d'une création / d'un déplacement : dossier par nom, catégorie par nom, ou racine. */
async function resolveDestination(
  user: CurrentUser,
  raw: string,
): Promise<{ parentId: string | null; spaceId: string | null; label: string } | { error: string }> {
  const q = raw.trim();
  if (!q || /^(racine|root|mon drive|drive personnel|chez moi)$/i.test(q)) {
    return { parentId: null, spaceId: null, label: "Racine personnelle" };
  }
  const folder = await resolveDriveNode(user, q, { type: "FOLDER", need: "EDIT" });
  if (!("error" in folder)) return { parentId: folder.id, spaceId: null, label: `Dossier « ${folder.name} »` };
  // Pas un dossier éditable — peut-être la RACINE d'une CATÉGORIE partagée (gestionnaires seuls).
  const spaces = await prisma.driveSpace.findMany({
    where: { name: { contains: q, mode: "insensitive" }, isArchived: false },
    select: { id: true, name: true },
    take: 3,
  });
  if (spaces.length === 1) {
    if (!(await canCreateInSpace(user, spaces[0].id))) {
      return { error: `La racine de la catégorie « ${spaces[0].name} » est réservée à ses gestionnaires — visez un dossier de la catégorie où vous êtes éditeur.` };
    }
    return { parentId: null, spaceId: spaces[0].id, label: `Catégorie « ${spaces[0].name} » (racine)` };
  }
  if (spaces.length > 1) {
    return { error: `Plusieurs catégories correspondent à « ${q} » : ${spaces.map((s) => s.name).join(", ")} — préciser.` };
  }
  return { error: folder.error };
}

/** Personnes par NOMS séparés par des virgules — introuvable/ambigu se DIT, jamais deviné.
 *  (Partagé avec les autres domaines d'ops — Regulatory s'en sert pour les participants.) */
export async function resolvePeopleList(
  raw: string,
  excludeId: string,
): Promise<{ people: { id: string; name: string }[]; problems: string[] }> {
  const parts = raw.split(/[;,]|\bet\b/i).map((s) => s.trim()).filter(Boolean);
  const people: { id: string; name: string }[] = [];
  const problems: string[] = [];
  for (const p of parts) {
    const matches = await prisma.user.findMany({
      where: { name: { contains: p, mode: "insensitive" }, isActive: true },
      select: { id: true, name: true },
      take: 4,
    });
    if (matches.length === 1) {
      if (matches[0].id === excludeId) problems.push(`« ${p} » : c'est vous — inutile de se partager à soi-même`);
      else people.push(matches[0]);
    } else if (matches.length === 0) {
      problems.push(`« ${p} » introuvable dans l'annuaire`);
    } else {
      problems.push(`plusieurs « ${p} » : ${matches.map((m) => m.name).join(", ")}`);
    }
  }
  return { people, problems };
}

function officeKindOf(raw: string): OfficeKind | null {
  const k = raw.toLowerCase();
  if (/excel|xlsx|tableur|feuille|classeur|cell/.test(k)) return "cell";
  if (/power ?point|pptx|présentation|presentation|slide|diapo/.test(k)) return "slide";
  if (/word|docx|doc\b|texte|courrier|lettre/.test(k)) return "word";
  return null;
}

const OFFICE_LABEL: Record<OfficeKind, string> = { word: "Word (docx)", cell: "Excel (xlsx)", slide: "PowerPoint (pptx)" };

const nodeLabel = (h: DriveHit): string => `${h.type === "FOLDER" ? "Dossier" : "Fichier"} « ${h.name} » (${h.where})`;

export const DRIVE_OPS_IMPL: Record<string, OpImpl> = {
  create_folder: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const name = opStr(input, "name");
      if (!name) return { error: "Donnez le nom du dossier à créer (champ « name »)." };
      const dest = await resolveDestination(user, opStr(input, "folder"));
      if ("error" in dest) return dest;
      return {
        title: `Créer le dossier « ${name} »`,
        fields: [
          { label: "Dossier", value: name },
          { label: "Emplacement", value: dest.label },
        ],
        args: { name, parentId: dest.parentId, spaceId: dest.spaceId },
        successMessage: `Dossier « ${name} » créé (${dest.label}).`,
        revalidate: ["/drive"],
      };
    },
    async execute(args) {
      const fd = new FormData();
      fd.set("name", args.name ?? "");
      if (args.parentId) fd.set("parentId", args.parentId);
      if (args.spaceId) fd.set("spaceId", args.spaceId);
      const r = await createFolder(undefined, fd);
      if (!r.ok) return { ok: false, error: r.error ?? "La création du dossier a été refusée." };
      return { ok: true, createdId: r.id, link: r.id ? `/drive/${r.id}` : "/drive", revalidate: ["/drive"] };
    },
  },

  rename: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const newName = opStr(input, "newName");
      if (!newName) return { error: "Donnez le nouveau nom (champ « newName »)." };
      const node = await resolveDriveNode(user, opStr(input, "name"), { need: "EDIT" });
      if ("error" in node) return node;
      return {
        title: `Renommer « ${node.name} » en « ${newName} »`,
        fields: [
          { label: "Élément", value: nodeLabel(node) },
          { label: "Nouveau nom", value: newName },
        ],
        args: { id: node.id, newName },
        successMessage: `« ${node.name} » renommé en « ${newName} ».`,
        link: `/drive/${node.id}`,
        revalidate: ["/drive"],
      };
    },
    async execute(args) {
      const fd = new FormData();
      fd.set("id", args.id ?? "");
      fd.set("name", args.newName ?? "");
      const r = await renameNode(fd);
      if (!r.ok) return { ok: false, error: r.error ?? "Le renommage a été refusé." };
      return { ok: true, revalidate: ["/drive"] };
    },
  },

  move: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const node = await resolveDriveNode(user, opStr(input, "name"), { need: "EDIT" });
      if ("error" in node) return node;
      const dest = await resolveDestination(user, opStr(input, "folder"));
      if ("error" in dest) return dest;
      if (dest.parentId === node.id) return { error: "Un dossier ne se déplace pas dans lui-même." };
      return {
        title: `Déplacer « ${node.name} » vers ${dest.label}`,
        fields: [
          { label: "Élément", value: nodeLabel(node) },
          { label: "Destination", value: dest.label },
        ],
        warnings: node.type === "FOLDER" ? ["Tout le contenu du dossier suit (le sous-arbre adopte la catégorie de destination)."] : [],
        args: { id: node.id, targetId: dest.parentId, spaceId: dest.spaceId },
        successMessage: `« ${node.name} » déplacé vers ${dest.label}.`,
        link: `/drive/${node.id}`,
        revalidate: ["/drive"],
      };
    },
    async execute(args) {
      const fd = new FormData();
      fd.set("id", args.id ?? "");
      fd.set("targetId", args.targetId ?? "");
      if (args.spaceId) fd.set("spaceId", args.spaceId);
      const r = await moveNode(fd);
      if (!r.ok) return { ok: false, error: r.error ?? "Le déplacement a été refusé." };
      return { ok: true, revalidate: ["/drive"] };
    },
  },

  share: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const node = await resolveDriveNode(user, opStr(input, "name"), { need: "EDIT" });
      if ("error" in node) return node;
      const rawPeople = opStr(input, "people");
      if (!rawPeople) return { error: "Donnez les personnes (champ « people », noms séparés par des virgules)." };
      const { people, problems } = await resolvePeopleList(rawPeople, user.id);
      if (people.length === 0) return { error: `Aucune personne résolue : ${problems.join(" ; ")}.` };
      const access = /modif|edit|écri|ecri/i.test(opStr(input, "access")) ? "EDIT" : "VIEW";
      return {
        title: `Partager « ${node.name} » avec ${people.map((p) => p.name).join(", ")}`,
        fields: [
          { label: "Élément", value: nodeLabel(node) },
          { label: "Personnes", value: people.map((p) => p.name).join(", ") },
          { label: "Droit", value: access === "EDIT" ? "Modification" : "Lecture" },
        ],
        warnings: [
          "Chaque personne est notifiée du partage.",
          ...(node.type === "FOLDER" ? ["Le partage d'un dossier ouvre aussi tout son contenu (héritage)."] : []),
          ...problems.map((p) => `Non partagé : ${p}.`),
        ],
        args: { nodeId: node.id, userIds: people.map((p) => p.id).join(","), access, names: people.map((p) => p.name).join(", ") },
        successMessage: `« ${node.name} » partagé avec ${people.map((p) => p.name).join(", ")} (${access === "EDIT" ? "modification" : "lecture"}).`,
        link: `/drive/${node.id}`,
        revalidate: ["/drive"],
      };
    },
    async execute(args) {
      const fd = new FormData();
      fd.set("nodeId", args.nodeId ?? "");
      fd.set("access", args.access ?? "VIEW");
      for (const id of (args.userIds ?? "").split(",").filter(Boolean)) fd.append("userId", id);
      const r = await shareNodeWithMany(fd);
      if (!r.ok) return { ok: false, error: r.error ?? "Le partage a été refusé." };
      return { ok: true, message: r.message, revalidate: ["/drive"] };
    },
  },

  unshare: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const node = await resolveDriveNode(user, opStr(input, "name"), { need: "EDIT" });
      if ("error" in node) return node;
      const rawPeople = opStr(input, "people");
      if (!rawPeople) return { error: "Donnez la ou les personnes dont retirer l'accès (champ « people »)." };
      const { people, problems } = await resolvePeopleList(rawPeople, "");
      if (people.length === 0) return { error: `Aucune personne résolue : ${problems.join(" ; ")}.` };
      return {
        title: `Retirer l'accès à « ${node.name} » de ${people.map((p) => p.name).join(", ")}`,
        fields: [
          { label: "Élément", value: nodeLabel(node) },
          { label: "Accès retiré à", value: people.map((p) => p.name).join(", ") },
        ],
        warnings: [
          "Seul le partage NOMINATIF direct sur cet élément est retiré — un accès hérité d'un dossier parent ou d'une catégorie subsiste.",
          ...problems.map((p) => `Ignoré : ${p}.`),
        ],
        args: { nodeId: node.id, userIds: people.map((p) => p.id).join(","), names: people.map((p) => p.name).join(", ") },
        successMessage: `Partage de « ${node.name} » retiré pour ${people.map((p) => p.name).join(", ")}.`,
        link: `/drive/${node.id}`,
        revalidate: ["/drive"],
      };
    },
    async execute(args) {
      const ids = (args.userIds ?? "").split(",").filter(Boolean);
      for (const userId of ids) {
        const fd = new FormData();
        fd.set("nodeId", args.nodeId ?? "");
        fd.set("userId", userId);
        const r = await unshareNode(fd);
        if (!r.ok) return { ok: false, error: r.error ?? "Le retrait du partage a été refusé." };
      }
      return { ok: true, revalidate: ["/drive"] };
    },
  },

  trash: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const node = await resolveDriveNode(user, opStr(input, "name"), { need: "EDIT" });
      if ("error" in node) return node;
      return {
        title: `Mettre « ${node.name} » à la corbeille`,
        fields: [{ label: "Élément", value: nodeLabel(node) }],
        warnings: [
          "RESTAURABLE : l'élément part à la corbeille Drive, rien n'est effacé.",
          ...(node.type === "FOLDER" ? ["Tout le contenu du dossier suit."] : []),
        ],
        args: { id: node.id, name: node.name },
        successMessage: `« ${node.name} » mis à la corbeille (restaurable).`,
        revalidate: ["/drive"],
      };
    },
    async execute(args) {
      const fd = new FormData();
      fd.set("id", args.id ?? "");
      const r = await trashNode(fd);
      if (!r.ok) return { ok: false, error: r.error ?? "La mise à la corbeille a été refusée." };
      return { ok: true, revalidate: ["/drive"] };
    },
  },

  restore: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const node = await resolveDriveNode(user, opStr(input, "name"), { need: "EDIT", trashed: true });
      if ("error" in node) return node;
      return {
        title: `Restaurer « ${node.name} » de la corbeille Drive`,
        fields: [{ label: "Élément", value: `${node.type === "FOLDER" ? "Dossier" : "Fichier"} « ${node.name} »` }],
        warnings: ["Si son dossier d'origine a disparu, l'élément revient à la racine."],
        args: { id: node.id, name: node.name },
        successMessage: `« ${node.name} » restauré.`,
        link: `/drive/${node.id}`,
        revalidate: ["/drive"],
      };
    },
    async execute(args) {
      const fd = new FormData();
      fd.set("id", args.id ?? "");
      const r = await restoreNode(fd);
      if (!r.ok) return { ok: false, error: r.error ?? "La restauration a été refusée." };
      return { ok: true, revalidate: ["/drive"] };
    },
  },

  delete: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const node = await resolveDriveNode(user, opStr(input, "name"), { need: "EDIT", trashed: "any" });
      if ("error" in node) return node;
      return {
        title: `SUPPRIMER DÉFINITIVEMENT « ${node.name} » du Drive`,
        fields: [
          { label: "Élément", value: nodeLabel(node) },
          // LA PHRASE SUIT LE CODE (10/2026) : l'élément quitte le Drive pour la corbeille du Super Admin, versions et
          // partages compris, d'où il se restaure. Seule la destruction, chez le Super Admin, efface les fichiers.
          { label: "Impact", value: "Retiré du Drive — restaurable par le Super Admin (Administration → Corbeille), versions et partages compris." },
        ],
        warnings: [
          `NIVEAU CRITIQUE : la confirmation exige de RESSAISIR « ${node.name} ».`,
          "Plus visible dans le Drive, ni dans sa corbeille : seul le Super Admin pourra le restaurer.",
          ...(node.type === "FOLDER" ? ["Tout le contenu du dossier part avec lui (et revient avec lui)."] : []),
        ],
        confirmText: node.name,
        args: { id: node.id, name: node.name },
        successMessage: `« ${node.name} » supprimé définitivement du Drive.`,
        revalidate: ["/drive"],
      };
    },
    async execute(args) {
      const fd = new FormData();
      fd.set("id", args.id ?? "");
      const r = await deleteNode(fd);
      if (!r.ok) return { ok: false, error: r.error ?? "La suppression a été refusée." };
      return { ok: true, revalidate: ["/drive"] };
    },
  },

  create_office: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const kind = officeKindOf(opStr(input, "kind") || opStr(input, "name"));
      if (!kind) return { error: "Précisez le type (champ « kind ») : word, excel ou powerpoint." };
      const name = opStr(input, "name") || "Document";
      const dest = await resolveDestination(user, opStr(input, "folder"));
      if ("error" in dest) return dest;
      return {
        title: `Créer un document ${OFFICE_LABEL[kind]} « ${name} »`,
        fields: [
          { label: "Type", value: OFFICE_LABEL[kind] },
          { label: "Nom", value: name },
          { label: "Emplacement", value: dest.label },
        ],
        args: { kind, name, parentId: dest.parentId, spaceId: dest.spaceId },
        successMessage: `Document ${OFFICE_LABEL[kind]} « ${name} » créé — éditable dans l'app.`,
        revalidate: ["/drive"],
      };
    },
    async execute(args) {
      const fd = new FormData();
      fd.set("kind", args.kind ?? "");
      fd.set("name", args.name ?? "Document");
      if (args.parentId) fd.set("parentId", args.parentId);
      if (args.spaceId) fd.set("spaceId", args.spaceId);
      const r = await createOfficeNode(fd);
      if (!r.ok) return { ok: false, error: r.error ?? "La création du document a été refusée." };
      return { ok: true, createdId: r.id, link: r.id ? `/drive/${r.id}` : "/drive", revalidate: ["/drive"] };
    },
  },

  to_pdf: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      if (!convertConfigured()) return { error: "Conversion PDF indisponible (éditeur Office non configuré sur ce serveur)." };
      const node = await resolveDriveNode(user, opStr(input, "name"), { need: "VIEW", type: "FILE" });
      if ("error" in node) return node;
      return {
        title: `Convertir « ${node.name} » en PDF`,
        fields: [
          { label: "Fichier", value: nodeLabel(node) },
          { label: "Résultat", value: "Un PDF créé À CÔTÉ — l'original reste intact." },
        ],
        args: { id: node.id, name: node.name },
        successMessage: `PDF généré depuis « ${node.name} ».`,
        revalidate: ["/drive"],
      };
    },
    async execute(args) {
      const fd = new FormData();
      fd.set("id", args.id ?? "");
      const r = await convertNodeToPdf(fd);
      if (!r.ok) return { ok: false, error: r.error ?? "La conversion a échoué." };
      return { ok: true, createdId: r.id, link: r.id ? `/drive/${r.id}` : "/drive", revalidate: ["/drive"] };
    },
  },
};
