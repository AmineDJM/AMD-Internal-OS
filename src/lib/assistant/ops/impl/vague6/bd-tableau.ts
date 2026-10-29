/**
 * OPS VAGUE 6a — BUSINESS DEVELOPMENT, tableau stratégique : projets → gammes → produits, FUSION
 * intégrale du produit (19 champs), cellule par liste blanche. Par les actions canoniques.
 */
import { prisma } from "./erp";
import { createBdProject, updateBdProject, deleteBdProject, createBdRange, updateBdRange, deleteBdRange, createBdProduct, updateBdProduct, deleteBdProduct, updateBdCell, addBdProjectComment } from "@/lib/actions/bd-project-actions";
import type { OpImpl, OpProposalDraft } from "../../types";
import { opStr } from "../../types";
import { runFd, runFd2, fieldsOf, resolveOne } from "../../helpers";
import { matchLabel, fold } from "../../impl-regulatory";

// ─────────────────────────── BUSINESS DEVELOPMENT — tableau stratégique ───────────────────────────

const BD_STATUS_FR: [string, string][] = [
  ["IDEA", "Idée"], ["TO_ANALYZE", "À analyser"], ["IN_PROGRESS", "En cours"],
  ["AWAITING_SUPPLIER", "Attente fournisseur"], ["AWAITING_INTERNAL", "Attente interne"],
  ["RECOMMENDATION_READY", "Recommandation prête"], ["VALIDATED", "Validée"],
  ["ABANDONED", "Abandonnée"], ["CLOSED", "Clôturée"],
];
const SOURCING_FR: [string, string][] = [
  ["MANUFACTURED", "Fabrication locale"], ["IMPORTED", "Importation"], ["TO_STUDY", "À étudier"],
];

const resolveBdProject = (raw: string) =>
  resolveOne(raw, "le projet BD (champ « target » — son nom)",
    (q) => prisma.bdProject.findMany({ where: { name: { contains: q, mode: "insensitive" } }, select: { id: true, name: true }, take: 6 }),
    (p) => p.name);

interface BdRangeHit { id: string; name: string; projectId: string; projectName: string }

async function resolveBdRange(raw: string, projectRaw: string): Promise<BdRangeHit | { error: string }> {
  const q = raw.trim();
  if (!q) return { error: "Précisez la gamme (champ « range » — son nom)." };
  const rows = await prisma.bdRange.findMany({
    where: {
      name: { contains: q, mode: "insensitive" },
      ...(projectRaw.trim() ? { project: { name: { contains: projectRaw.trim(), mode: "insensitive" } } } : {}),
    },
    select: { id: true, name: true, projectId: true, project: { select: { name: true } } },
    take: 6,
  });
  if (rows.length === 1) return { id: rows[0].id, name: rows[0].name, projectId: rows[0].projectId, projectName: rows[0].project.name };
  if (rows.length === 0) return { error: `Aucune gamme « ${q} »${projectRaw ? ` sur le projet « ${projectRaw} »` : ""}.` };
  return { error: `Plusieurs gammes correspondent : ${rows.map((r) => `${r.name} (${r.project.name})`).join(" ; ")} — préciser le projet (champ « target »).` };
}

interface BdProductHit { id: string; dci: string; projectId: string; projectName: string }

async function resolveBdProduct(raw: string, projectRaw: string): Promise<BdProductHit | { error: string }> {
  const q = raw.trim();
  if (!q) return { error: "Précisez le produit (champ « product » — DCI ou nom de marque)." };
  const rows = await prisma.bdProduct.findMany({
    where: {
      OR: [{ dci: { contains: q, mode: "insensitive" } }, { brandName: { contains: q, mode: "insensitive" } }],
      ...(projectRaw.trim() ? { range: { project: { name: { contains: projectRaw.trim(), mode: "insensitive" } } } } : {}),
    },
    select: { id: true, dci: true, range: { select: { projectId: true, project: { select: { name: true } } } } },
    take: 6,
  });
  if (rows.length === 1) return { id: rows[0].id, dci: rows[0].dci, projectId: rows[0].range.projectId, projectName: rows[0].range.project.name };
  if (rows.length === 0) return { error: `Aucun produit BD « ${q} »${projectRaw ? ` sur le projet « ${projectRaw} »` : ""}.` };
  return { error: `Plusieurs produits correspondent : ${rows.map((r) => `${r.dci} (${r.range.project.name})`).join(" ; ")} — préciser le projet (champ « target »).` };
}

/** Champs produit rejoués tels quels par la FUSION (l'action REMPLACE tout). */
const BD_PRODUCT_FIELDS = [
  "brandName", "dosage", "form", "competitors", "competitorShares", "competitorVolume", "competitorPrice", "comment",
] as const;
const BD_PRODUCT_NUMS = [
  "marketSizeDzd", "marketSizeUsd", "unitPrice", "totalMarketVolume",
  "investmentY1", "investmentY2", "investmentY3", "revenueY1", "revenueY2", "revenueY3",
] as const;

/** Liste blanche des cellules éditables (libellés FR → clé technique de l'action). */
const BD_CELL_PROJECT_FR: [string, string][] = [
  ["name", "Nom"], ["description", "Description"], ["comment", "Commentaire"], ["status", "Statut"],
];
const BD_CELL_PRODUCT_FR: [string, string][] = [
  ["dci", "DCI"], ["brandName", "Nom de marque"], ["dosage", "Dosage"], ["form", "Forme"],
  ["sourcing", "Sourcing"], ["marketSizeDzd", "Taille de marché DZD"], ["marketSizeUsd", "Taille de marché USD"],
  ["unitPrice", "Prix unitaire"], ["totalMarketVolume", "Volume de marché"], ["competitors", "Concurrents"],
  ["competitorShares", "Parts des concurrents"], ["competitorVolume", "Volumes des concurrents"],
  ["competitorPrice", "Prix des concurrents"], ["investmentY1", "Investissement A1"], ["investmentY2", "Investissement A2"],
  ["investmentY3", "Investissement A3"], ["revenueY1", "Revenus A1"], ["revenueY2", "Revenus A2"],
  ["revenueY3", "Revenus A3"], ["comment", "Commentaire"],
];

export const BD6_OPS_IMPL: Record<string, OpImpl> = {
  create_bd_project: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const name = opStr(input, "name") || opStr(input, "label");
      if (!name) return { error: "Nommez le projet BD (champ « name »)." };
      const statusRaw = opStr(input, "status");
      const status = statusRaw ? matchLabel(statusRaw, BD_STATUS_FR) : null;
      if (status && typeof status === "object") return status;
      return {
        title: `Créer le projet BD « ${name} »`,
        fields: fieldsOf([
          ["Projet", name],
          ["Stade", status ? BD_STATUS_FR.find(([c]) => c === status)?.[1] ?? null : "Idée (défaut)"],
          ["Description", opStr(input, "notes") || null],
        ]),
        args: { name, status: status || null, description: opStr(input, "notes") || null, comment: opStr(input, "note") || null },
        successMessage: `Projet BD « ${name} » créé.`,
        revalidate: ["/business-development"],
      };
    },
    execute: (args) => runFd2(createBdProject, args, "La création du projet a été refusée.", { revalidate: ["/business-development"] }),
  },

  update_bd_project: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const hit = await resolveBdProject(opStr(input, "target") || opStr(input, "name"));
      if ("error" in hit) return hit;
      const current = await prisma.bdProject.findUnique({
        where: { id: hit.id }, select: { name: true, description: true, comment: true, status: true },
      });
      if (!current) return { error: "Projet introuvable." };
      const statusRaw = opStr(input, "status");
      const status = statusRaw ? matchLabel(statusRaw, BD_STATUS_FR) : null;
      if (status && typeof status === "object") return status;
      const newName = opStr(input, "newName") || current.name;
      // FUSION : l'action REMPLACE nom, description et commentaire — l'existant est relu et rejoué.
      return {
        title: `Modifier le projet BD « ${current.name} »`,
        fields: fieldsOf([
          ["Projet", newName !== current.name ? `${current.name} → ${newName}` : current.name],
          ["Stade", status ? BD_STATUS_FR.find(([c]) => c === status)?.[1] ?? null : `${BD_STATUS_FR.find(([c]) => c === current.status)?.[1] ?? current.status} (inchangé)`],
          ["Le reste", "description et commentaire rejoués à l'identique"],
        ]),
        args: {
          id: hit.id, name: newName, status: status || null,
          description: opStr(input, "notes") || current.description || null,
          comment: opStr(input, "note") || current.comment || null,
        },
        successMessage: `Projet « ${newName} » modifié.`,
        revalidate: ["/business-development"],
      };
    },
    execute: (args) => runFd(updateBdProject, args, "La modification du projet a été refusée.", { revalidate: ["/business-development"] }),
  },

  delete_bd_project: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const hit = await resolveBdProject(opStr(input, "target") || opStr(input, "name"));
      if ("error" in hit) return hit;
      const [ranges, products] = await Promise.all([
        prisma.bdRange.count({ where: { projectId: hit.id } }),
        prisma.bdProduct.count({ where: { range: { projectId: hit.id } } }),
      ]);
      return {
        title: `SUPPRIMER le projet BD « ${hit.name} »`,
        fields: [
          { label: "Projet", value: hit.name },
          { label: "Emporté en cascade", value: `${ranges} gamme(s), ${products} produit(s)` },
        ],
        warnings: ["Suppression DÉFINITIVE du projet ET de toutes ses gammes et produits — le tableau stratégique perd ces lignes."],
        confirmText: hit.name,
        args: { id: hit.id },
        successMessage: `Projet « ${hit.name} » supprimé (gammes et produits compris).`,
        revalidate: ["/business-development"],
      };
    },
    execute: (args) => runFd(deleteBdProject, args, "La suppression du projet a été refusée.", { revalidate: ["/business-development"] }),
  },

  create_bd_range: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const hit = await resolveBdProject(opStr(input, "target"));
      if ("error" in hit) return hit;
      const name = opStr(input, "name") || opStr(input, "range");
      if (!name) return { error: "Nommez la gamme (champ « name »)." };
      return {
        title: `Ajouter la gamme « ${name} » au projet « ${hit.name} »`,
        fields: fieldsOf([["Projet", hit.name], ["Gamme", name], ["Commentaire", opStr(input, "note") || null]]),
        args: { projectId: hit.id, name, comment: opStr(input, "note") || null },
        successMessage: `Gamme « ${name} » ajoutée à « ${hit.name} ».`,
        revalidate: ["/business-development"],
      };
    },
    execute: (args) => runFd(createBdRange, args, "L'ajout de la gamme a été refusé.", { revalidate: ["/business-development"] }),
  },

  update_bd_range: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const hit = await resolveBdRange(opStr(input, "range") || opStr(input, "name"), opStr(input, "target"));
      if ("error" in hit) return hit;
      const current = await prisma.bdRange.findUnique({ where: { id: hit.id }, select: { comment: true } });
      const newName = opStr(input, "newName") || hit.name;
      // FUSION : nom et commentaire sont REMPLACÉS — le commentaire existant est rejoué s'il n'est pas donné.
      return {
        title: `Modifier la gamme « ${hit.name} » (${hit.projectName})`,
        fields: fieldsOf([
          ["Gamme", newName !== hit.name ? `${hit.name} → ${newName}` : hit.name],
          ["Commentaire", opStr(input, "note") || (current?.comment ? `${current.comment} (rejoué)` : null)],
        ]),
        args: { id: hit.id, name: newName, comment: opStr(input, "note") || current?.comment || null },
        successMessage: `Gamme « ${newName} » modifiée.`,
        revalidate: ["/business-development"],
      };
    },
    execute: (args) => runFd(updateBdRange, args, "La modification de la gamme a été refusée.", { revalidate: ["/business-development"] }),
  },

  delete_bd_range: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const hit = await resolveBdRange(opStr(input, "range") || opStr(input, "name"), opStr(input, "target"));
      if ("error" in hit) return hit;
      const products = await prisma.bdProduct.count({ where: { rangeId: hit.id } });
      return {
        title: `Supprimer la gamme « ${hit.name} » (${hit.projectName})`,
        fields: [{ label: "Gamme", value: hit.name }, { label: "Produits emportés", value: String(products) }],
        warnings: ["Suppression définitive de la gamme ET de ses produits (cascade)."],
        args: { id: hit.id },
        successMessage: `Gamme « ${hit.name} » supprimée.`,
        revalidate: ["/business-development"],
      };
    },
    execute: (args) => runFd(deleteBdRange, args, "La suppression de la gamme a été refusée.", { revalidate: ["/business-development"] }),
  },

  create_bd_product: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const range = await resolveBdRange(opStr(input, "range"), opStr(input, "target"));
      if ("error" in range) return range;
      const dci = opStr(input, "dci") || opStr(input, "name");
      if (!dci) return { error: "Précisez le DCI / produit (champ « dci »)." };
      const sourcingRaw = opStr(input, "mode");
      const sourcing = sourcingRaw ? matchLabel(sourcingRaw, SOURCING_FR) : null;
      if (sourcing && typeof sourcing === "object") return sourcing;
      return {
        title: `Ajouter le produit « ${dci} » à la gamme « ${range.name} »`,
        fields: fieldsOf([
          ["Gamme", `${range.name} (${range.projectName})`],
          ["DCI", dci],
          ["Nom de marque", opStr(input, "label") || null],
          ["Sourcing", sourcing ? SOURCING_FR.find(([c]) => c === sourcing)?.[1] ?? null : null],
        ]),
        args: {
          rangeId: range.id, dci,
          brandName: opStr(input, "label") || null, dosage: opStr(input, "dosage") || null,
          form: opStr(input, "form") || null, sourcing: sourcing || null,
          comment: opStr(input, "note") || null,
        },
        successMessage: `Produit « ${dci} » ajouté à « ${range.name} ».`,
        revalidate: ["/business-development"],
      };
    },
    execute: (args) => runFd(createBdProduct, args, "L'ajout du produit a été refusé.", { revalidate: ["/business-development"] }),
  },

  update_bd_product: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const hit = await resolveBdProduct(opStr(input, "product") || opStr(input, "dci"), opStr(input, "target"));
      if ("error" in hit) return hit;
      const current = await prisma.bdProduct.findUnique({ where: { id: hit.id } });
      if (!current) return { error: "Produit introuvable." };
      const sourcingRaw = opStr(input, "mode");
      const sourcing = sourcingRaw ? matchLabel(sourcingRaw, SOURCING_FR) : null;
      if (sourcing && typeof sourcing === "object") return sourcing;
      // FUSION INTÉGRALE : l'action REMPLACE les 19 champs de l'étude produit — tout
      // l'existant est relu et rejoué ; seuls les champs donnés changent.
      const args: Record<string, string | null> = { id: hit.id, dci: opStr(input, "dci") || current.dci };
      for (const f of BD_PRODUCT_FIELDS) args[f] = (current[f] as string | null) ?? null;
      for (const f of BD_PRODUCT_NUMS) args[f] = current[f] != null ? String(Number(current[f])) : null;
      if (opStr(input, "label")) args.brandName = opStr(input, "label");
      if (opStr(input, "dosage")) args.dosage = opStr(input, "dosage");
      if (opStr(input, "form")) args.form = opStr(input, "form");
      if (opStr(input, "note")) args.comment = opStr(input, "note");
      args.sourcing = sourcing || ((current.sourcing as string | null) ?? null);
      return {
        title: `Modifier le produit BD « ${hit.dci} » (${hit.projectName})`,
        fields: fieldsOf([
          ["Produit", hit.dci],
          ["Sourcing", sourcing ? SOURCING_FR.find(([c]) => c === sourcing)?.[1] ?? null : null],
          ["Le reste", "les 19 champs de l'étude sont rejoués à l'identique (FUSION) — pour UNE cellule chiffrée, préférer set_bd_cell"],
        ]),
        args,
        successMessage: `Produit « ${hit.dci} » modifié.`,
        revalidate: ["/business-development"],
      };
    },
    execute: (args) => runFd(updateBdProduct, args, "La modification du produit a été refusée.", { revalidate: ["/business-development"] }),
  },

  delete_bd_product: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const hit = await resolveBdProduct(opStr(input, "product") || opStr(input, "dci"), opStr(input, "target"));
      if ("error" in hit) return hit;
      return {
        title: `Supprimer le produit BD « ${hit.dci} » (${hit.projectName})`,
        fields: [{ label: "Produit", value: hit.dci }],
        warnings: ["Suppression définitive de la ligne produit du tableau stratégique."],
        args: { id: hit.id },
        successMessage: `Produit « ${hit.dci} » supprimé.`,
        revalidate: ["/business-development"],
      };
    },
    execute: (args) => runFd(deleteBdProduct, args, "La suppression du produit a été refusée.", { revalidate: ["/business-development"] }),
  },

  set_bd_cell: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const kindRaw = fold(opStr(input, "kind") || opStr(input, "mode"));
      const isProduct = /produit|product/.test(kindRaw);
      const isProject = /projet|project/.test(kindRaw);
      if (!isProduct && !isProject) return { error: "Précisez la cible (champ « kind ») : projet ou produit." };
      const value = opStr(input, "value") || opStr(input, "note");
      const fieldRaw = opStr(input, "field") || opStr(input, "label");
      if (isProject) {
        const hit = await resolveBdProject(opStr(input, "target") || opStr(input, "name"));
        if ("error" in hit) return hit;
        const field = matchLabel(fieldRaw, BD_CELL_PROJECT_FR);
        if (typeof field === "object") return field;
        const shown = field === "status" ? (() => { const s = matchLabel(value, BD_STATUS_FR); return typeof s === "string" ? s : value; })() : value;
        if (field === "status" && !BD_STATUS_FR.some(([c]) => c === shown)) return { error: "Statut de projet inconnu — stades : " + BD_STATUS_FR.map(([, l]) => l).join(", ") + "." };
        return {
          title: `${hit.name} : ${BD_CELL_PROJECT_FR.find(([c]) => c === field)?.[1]} → ${shown || "(vide)"}`,
          fields: [{ label: "Projet", value: hit.name }, { label: "Cellule", value: `${BD_CELL_PROJECT_FR.find(([c]) => c === field)?.[1]} = ${shown || "(vide)"}` }],
          args: { kind: "project", id: hit.id, field, value: shown },
          successMessage: `Cellule mise à jour sur « ${hit.name} ».`,
          revalidate: ["/business-development"],
        };
      }
      const hit = await resolveBdProduct(opStr(input, "product") || opStr(input, "name"), opStr(input, "target"));
      if ("error" in hit) return hit;
      const field = matchLabel(fieldRaw, BD_CELL_PRODUCT_FR);
      if (typeof field === "object") return field;
      const shown = field === "sourcing" ? (() => { const s = matchLabel(value, SOURCING_FR); return typeof s === "string" ? s : value; })() : value;
      return {
        title: `${hit.dci} : ${BD_CELL_PRODUCT_FR.find(([c]) => c === field)?.[1]} → ${shown || "(vide)"}`,
        fields: [{ label: "Produit", value: `${hit.dci} (${hit.projectName})` }, { label: "Cellule", value: `${BD_CELL_PRODUCT_FR.find(([c]) => c === field)?.[1]} = ${shown || "(vide)"}` }],
        args: { kind: "product", id: hit.id, field, value: shown },
        successMessage: `Cellule mise à jour sur « ${hit.dci} ».`,
        revalidate: ["/business-development"],
      };
    },
    execute: (args) => runFd(updateBdCell, args, "L'édition de la cellule a été refusée.", { revalidate: ["/business-development"] }),
  },

  comment_bd_project: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const hit = await resolveBdProject(opStr(input, "target") || opStr(input, "name"));
      if ("error" in hit) return hit;
      const body = opStr(input, "message") || opStr(input, "note");
      if (!body) return { error: "Écrivez le commentaire (champ « message »)." };
      return {
        title: `Commenter le projet BD « ${hit.name} »`,
        fields: [{ label: "Projet", value: hit.name }, { label: "Commentaire", value: body }],
        args: { projectId: hit.id, body },
        successMessage: `Commentaire posé sur « ${hit.name} ».`,
        revalidate: ["/business-development"],
      };
    },
    execute: (args) => runFd(addBdProjectComment, args, "Le commentaire a été refusé.", { revalidate: ["/business-development"] }),
  },
};
