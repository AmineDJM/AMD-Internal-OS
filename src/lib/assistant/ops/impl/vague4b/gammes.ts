/**
 * OPS VAGUE 4b — GAMMES (ADMIN) : la clé de lecture de la plateforme, par les actions canoniques
 * des gammes de produits.
 */
import { prisma } from "./erp";
import { createProductRange, updateProductRange, deleteProductRange, setProductsRange, setUserRanges, removeProductFromRange } from "@/lib/actions/product-range-actions";
import type { OpImpl, OpProposalDraft } from "../../types";
import { opStr } from "../../types";
import { runFd, runFd2, fieldsOf, resolveOne } from "../../helpers";
import { resolveRegProduct } from "../../impl-regulatory";
import { resolvePerson } from "./commun";

const resolveCompany = (raw: string) =>
  resolveOne(raw, "l'entité (champ « entity »)",
    (q) => prisma.company.findMany({ where: { name: { contains: q, mode: "insensitive" }, isActive: true }, select: { id: true, name: true }, take: 4 }),
    (c) => c.name);

const resolveRange = (raw: string) =>
  resolveOne(raw, "la gamme (champ « range »)",
    (q) => prisma.productRange.findMany({
      where: { name: { contains: q, mode: "insensitive" } },
      select: { id: true, name: true, companyId: true, company: { select: { name: true } } }, take: 6,
    }),
    (r) => `${r.company.name} › ${r.name}`);

// ─────────────────────────── GAMMES (ADMIN) ───────────────────────────

export const RANGE_OPS_IMPL: Record<string, OpImpl> = {
  create_range: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const name = opStr(input, "range") || opStr(input, "name");
      if (!name) return { error: "Précisez le nom de la gamme (champ « range »)." };
      const company = await resolveCompany(opStr(input, "entity"));
      if ("error" in company) return company;
      return {
        title: `Créer la gamme ${company.name} › ${name}`,
        fields: fieldsOf([
          ["Entité", company.name], ["Gamme", name],
          ["Description", opStr(input, "notes") || null], ["Couleur", opStr(input, "color") || null],
        ]),
        warnings: ["Une gamme est une CLÉ DE LECTURE de la plateforme : le rattachement des personnes en découle."],
        args: { companyId: company.id, name, description: opStr(input, "notes") || null, color: opStr(input, "color") || null },
        successMessage: `Gamme ${company.name} › ${name} créée.`,
        revalidate: ["/admin/gammes"],
      };
    },
    execute: (args) => runFd2(createProductRange, args, "La création de la gamme a été refusée.", { revalidate: ["/admin/gammes"] }),
  },

  update_range: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const range = await resolveRange(opStr(input, "range") || opStr(input, "name"));
      if ("error" in range) return range;
      const current = await prisma.productRange.findUnique({ where: { id: range.id }, select: { description: true, color: true, isActive: true } });
      const newName = opStr(input, "newName");
      const modeRaw = opStr(input, "mode");
      const deactivate = /d[ée]sactiv/i.test(modeRaw);
      const activate = /^activ|r[ée]activ/i.test(modeRaw);
      if (!newName && !opStr(input, "notes") && !opStr(input, "color") && !deactivate && !activate) {
        return { error: "Rien à changer : donnez newName, notes (description), color, ou mode (activer / désactiver)." };
      }
      return {
        title: `Modifier la gamme « ${range.name} »`,
        fields: fieldsOf([
          ["Gamme", newName ? `${range.name} → ${newName}` : range.name],
          ["État", deactivate ? "Désactivée" : activate ? "Réactivée" : null],
          ["Le reste", "rejoué à l'identique (description, couleur)"],
        ]),
        args: {
          id: range.id, name: newName || null,
          description: opStr(input, "notes") || current?.description || null,
          color: opStr(input, "color") || current?.color || null,
          isActive: deactivate ? "false" : activate ? "true" : null,
        },
        successMessage: `Gamme « ${newName || range.name} » mise à jour.`,
        revalidate: ["/admin/gammes"],
      };
    },
    execute: (args) => runFd(updateProductRange, args, "La modification de la gamme a été refusée.", { revalidate: ["/admin/gammes"] }),
  },

  delete_range: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const range = await resolveRange(opStr(input, "range") || opStr(input, "name"));
      if ("error" in range) return range;
      const counts = await prisma.productRange.findUnique({
        where: { id: range.id }, select: { _count: { select: { products: true, userAccess: true } } },
      });
      return {
        title: `Supprimer la gamme « ${range.name} »`,
        fields: [
          { label: "Gamme", value: range.name },
          { label: "Effet", value: `${counts?._count.products ?? 0} produit(s) rendus « sans gamme », ${counts?._count.userAccess ?? 0} rattachement(s) levés` },
        ],
        warnings: ["AUCUN dossier n'est supprimé : les produits restent, simplement sans gamme — les rattachements de personnes tombent avec elle."],
        args: { id: range.id },
        successMessage: `Gamme « ${range.name} » supprimée (produits conservés).`,
        revalidate: ["/admin/gammes"],
      };
    },
    execute: (args) => runFd(deleteProductRange, args, "La suppression de la gamme a été refusée.", { revalidate: ["/admin/gammes"] }),
  },

  set_products_range: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const raw = opStr(input, "products") || opStr(input, "reference");
      if (!raw) return { error: "Précisez le ou les produits (champ « products », références REG-… ou DCI, virgules)." };
      const ids: string[] = []; const names: string[] = [];
      for (const part of raw.split(/[;,]/).map((p) => p.trim()).filter(Boolean)) {
        const product = await resolveRegProduct(user, part);
        if ("error" in product) return product;
        ids.push(product.id); names.push(product.reference);
      }
      const rangeRaw = opStr(input, "range");
      const removing = /^(aucune?|sans gamme|sortir|retirer)$/i.test(rangeRaw);
      let rangeId: string | null = null; let rangeName = "Sans gamme";
      if (!removing) {
        if (!rangeRaw) return { error: "Précisez la gamme (champ « range » — « aucune » pour les sortir)." };
        const range = await resolveRange(rangeRaw);
        if ("error" in range) return range;
        rangeId = range.id; rangeName = range.name;
      }
      return {
        title: `Ranger ${names.length} produit(s) dans « ${rangeName} »`,
        fields: [{ label: "Produits", value: names.join(", ") }, { label: "Gamme", value: rangeName }],
        warnings: removing ? [] : ["Un produit ne relève que d'une gamme DE SON ENTITÉ — un produit d'une autre société est refusé."],
        args: { rangeId, productIds: ids.join(",") },
        successMessage: `${names.length} produit(s) rangé(s) dans « ${rangeName} ».`,
        revalidate: ["/admin/gammes"],
      };
    },
    async execute(args) {
      const fd = new FormData();
      if (args.rangeId) fd.set("rangeId", args.rangeId);
      for (const id of (args.productIds ?? "").split(",").filter(Boolean)) fd.append("productId", id);
      const r = await setProductsRange(fd);
      if (!r.ok) return { ok: false, error: r.error ?? "Le rangement a été refusé." };
      return { ok: true, message: r.message, revalidate: ["/admin/gammes"] };
    },
  },

  set_user_ranges: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const person = await resolvePerson(opStr(input, "person"), "la personne (champ « person »)");
      if ("error" in person) return person;
      const raw = opStr(input, "range") || opStr(input, "ranges");
      const detaching = /^(aucune?|toutes? lev[ée]es?|d[ée]tache)/i.test(raw);
      const ids: string[] = []; const names: string[] = [];
      if (!detaching && raw) {
        for (const part of raw.split(/[;,]/).map((p) => p.trim()).filter(Boolean)) {
          const range = await resolveRange(part);
          if ("error" in range) return range;
          ids.push(range.id); names.push(range.name);
        }
      }
      if (!detaching && ids.length === 0) return { error: "Donnez les gammes (champ « range », virgules) — ou « aucune » pour tout détacher." };
      return {
        title: detaching ? `Détacher ${person.name} de toutes les gammes` : `Rattacher ${person.name} à ${names.length} gamme(s)`,
        fields: [
          { label: "Personne", value: person.name },
          { label: "Gammes", value: detaching ? "— (elle relève de ses seules entités)" : names.join(", ") },
        ],
        warnings: ["La liste REMPLACE la précédente — le rattachement gouverne ce que la personne VOIT."],
        args: { userId: person.id, rangeIds: ids.join(",") },
        successMessage: detaching ? `${person.name} détaché(e) de toutes les gammes.` : `${person.name} rattaché(e) à ${names.length} gamme(s).`,
        revalidate: ["/admin/gammes"],
      };
    },
    async execute(args) {
      const fd = new FormData();
      fd.set("userId", args.userId ?? "");
      for (const id of (args.rangeIds ?? "").split(",").filter(Boolean)) fd.append("rangeId", id);
      const r = await setUserRanges(fd);
      if (!r.ok) return { ok: false, error: r.error ?? "Le rattachement a été refusé." };
      return { ok: true, message: r.message, revalidate: ["/admin/gammes"] };
    },
  },

  remove_product_from_range: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const product = await resolveRegProduct(user, opStr(input, "products") || opStr(input, "reference"));
      if ("error" in product) return product;
      return {
        title: `Sortir ${product.reference} de sa gamme`,
        fields: [{ label: "Produit", value: `${product.reference} — ${product.dci}` }],
        warnings: ["Le dossier reste exactement où il est, simplement sans gamme."],
        args: { productId: product.id },
        successMessage: `${product.reference} sorti de sa gamme.`,
        revalidate: ["/admin/gammes"],
      };
    },
    execute: (args) => runFd(removeProductFromRange, args, "Le retrait a été refusé.", { revalidate: ["/admin/gammes"] }),
  },
};
