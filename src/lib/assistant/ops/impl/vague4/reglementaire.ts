/**
 * OPS VAGUE 4a — RÉGLEMENTAIRE (reste) : fournisseurs, déverrouillage global, notes d'étapes du
 * workflow, variations, rapprochement des catalogues. Par les actions canoniques.
 */
import { prisma } from "./erp";
import { MANUFACTURING_STATUS, VARIATION_STATUS } from "@/lib/labels";
import { REG_STEPS } from "@/lib/regulatory-workflow";
import { createRegulatorySupplier, unlockAllRegulatory, setRegulatoryStepNote, deleteVariation } from "@/lib/actions/regulatory-actions";
import { linkProductToDossier, unlinkProductFromDossier } from "@/lib/actions/product-catalog-actions";
import type { OpImpl, OpProposalDraft } from "../../types";
import { opStr } from "../../types";
import { runFd, fieldsOf } from "../../helpers";
import { resolveRegProduct, matchLabel, fold } from "../../impl-regulatory";

// ─────────────────────────── REGULATORY (reste) ───────────────────────────

/** Les étapes du WORKFLOW JSON (chronologie du dossier) — « 5 » ou un bout du libellé. */
function matchWorkflowStep(raw: string): { key: string; label: string } | { error: string } {
  const q = raw.trim();
  if (!q) return { error: `Précisez l'étape (champ « step ») : son numéro (1 à ${REG_STEPS.length}) ou son libellé.` };
  const byNumber = REG_STEPS.find((s) => String(s.n) === q.replace(/^étape\s*/i, "").trim());
  if (byNumber) return { key: byNumber.key, label: `${byNumber.n}. ${byNumber.label}` };
  const m = matchLabel(q, REG_STEPS.map((s) => [s.key, s.label] as [string, string]));
  if (typeof m === "object") return m;
  const step = REG_STEPS.find((s) => s.key === m)!;
  return { key: step.key, label: `${step.n}. ${step.label}` };
}

export const REG4_OPS_IMPL: Record<string, OpImpl> = {
  create_supplier: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const name = opStr(input, "name");
      if (!name) return { error: "Précisez le nom du fournisseur (champ « name »)." };
      const dup = await prisma.supplier.findFirst({ where: { name: { equals: name, mode: "insensitive" } }, select: { id: true } });
      return {
        title: `Nouveau fournisseur « ${name} »`,
        fields: fieldsOf([
          ["Fournisseur", name], ["Pays", opStr(input, "country") || null],
          ["Contact", opStr(input, "contact") || null], ["Notes", opStr(input, "notes") || null],
        ]),
        warnings: dup ? [`Un fournisseur « ${name} » existe DÉJÀ — confirmer créera un doublon.`] : [],
        args: { name, country: opStr(input, "country") || null, contactEmail: opStr(input, "contact") || null, notes: opStr(input, "notes") || null },
        successMessage: `Fournisseur « ${name} » créé.`,
        revalidate: ["/regulatory"],
      };
    },
    execute: (args) => runFd(createRegulatorySupplier, args, "La création du fournisseur a été refusée.", { revalidate: ["/regulatory"] }),
  },

  unlock_all: {
    async propose(): Promise<OpProposalDraft | { error: string }> {
      const count = await prisma.regulatoryProduct.count({ where: { isLocked: true } });
      if (count === 0) return { error: "Aucun dossier verrouillé — rien à déverrouiller." };
      return {
        title: `Déverrouiller les ${count} dossiers réglementaires d'un coup`,
        fields: [{ label: "Dossiers cadenassés", value: String(count) }],
        warnings: ["TOUS les dossiers verrouillés deviennent visibles de l'équipe (portefeuille confidentiel exposé) — geste réservé au détenteur du cadenas."],
        args: {},
        successMessage: `${count} dossier(s) déverrouillé(s) — visibles par l'équipe.`,
        revalidate: ["/regulatory"],
      };
    },
    async execute() {
      const r = await unlockAllRegulatory();
      if (!r.ok) return { ok: false, error: r.error ?? "Le déverrouillage a été refusé." };
      return { ok: true, revalidate: ["/regulatory"] };
    },
  },

  set_step_note: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const product = await resolveRegProduct(user, opStr(input, "reference"));
      if ("error" in product) return product;
      const step = matchWorkflowStep(opStr(input, "step"));
      if ("error" in step) return step;
      const note = opStr(input, "note");
      const clearing = /^(aucune?|retire|efface|vide)$/i.test(note);
      if (!note) return { error: "Donnez la note (champ « note ») — ou « aucune » pour l'effacer." };
      return {
        title: `Note d'étape — ${product.reference}`,
        fields: [
          { label: "Dossier", value: `${product.reference} — ${product.dci}` },
          { label: "Étape", value: step.label },
          { label: "Note", value: clearing ? "— (effacée)" : note },
        ],
        args: { productId: product.id, stepKey: step.key, note: clearing ? null : note, reference: product.reference },
        successMessage: `Note ${clearing ? "effacée" : "posée"} sur « ${step.label} » (${product.reference}).`,
        link: `/regulatory/${product.id}`, revalidate: ["/regulatory"],
      };
    },
    execute: (args) => runFd(setRegulatoryStepNote, args, "La note d'étape a été refusée.", { revalidate: ["/regulatory"] }),
  },

  delete_variation: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const product = await resolveRegProduct(user, opStr(input, "reference"));
      if ("error" in product) return product;
      const variations = await prisma.regulatoryVariation.findMany({
        where: { productId: product.id },
        select: { id: true, toStatus: true, status: true },
        orderBy: { createdAt: "desc" }, take: 6,
      });
      if (variations.length === 0) return { error: `Aucune variation sur ${product.reference}.` };
      const wanted = fold(opStr(input, "target"));
      const hits = wanted
        ? variations.filter((v) => fold(MANUFACTURING_STATUS[v.toStatus] ?? v.toStatus).includes(wanted))
        : variations;
      const pick = hits.length === 1 ? hits[0] : variations.length === 1 ? variations[0] : null;
      if (!pick) {
        return { error: `Plusieurs variations sur ${product.reference} : ${variations.map((v) => `${MANUFACTURING_STATUS[v.toStatus] ?? v.toStatus} (${VARIATION_STATUS[v.status]?.label ?? v.status})`).join(" ; ")} — préciser la cible (champ « target »).` };
      }
      return {
        title: `SUPPRIMER la variation ${MANUFACTURING_STATUS[pick.toStatus] ?? pick.toStatus} de ${product.reference}`,
        fields: [
          { label: "Dossier", value: `${product.reference} — ${product.dci}` },
          { label: "Variation", value: `${MANUFACTURING_STATUS[pick.toStatus] ?? pick.toStatus} (${VARIATION_STATUS[pick.status]?.label ?? pick.status})` },
        ],
        warnings: ["Suppression définitive de la variation (dates de dépôt / décision comprises) — le statut de fabrication du produit, lui, ne bouge pas."],
        confirmText: product.reference,
        args: { id: pick.id, reference: product.reference },
        successMessage: `Variation de ${product.reference} supprimée.`,
        link: `/regulatory/${product.id}`, revalidate: ["/regulatory"],
      };
    },
    execute: (args) => runFd(deleteVariation, args, "La suppression de la variation a été refusée.", { revalidate: ["/regulatory"] }),
  },

  link_catalog_product: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const raw = opStr(input, "name");
      if (!raw) return { error: "Précisez le produit du catalogue à rattacher (champ « name »)." };
      const wantPromo = /promo|promu/i.test(opStr(input, "kind"));
      const wantBd = /bd|business|d[ée]veloppement/i.test(opStr(input, "kind"));
      const [bd, promo] = await Promise.all([
        wantPromo ? [] : prisma.bdProduct.findMany({ where: { dci: { contains: raw, mode: "insensitive" } }, select: { id: true, dci: true, regulatoryProductId: true }, take: 4 }),
        wantBd ? [] : prisma.promoProduct.findMany({ where: { name: { contains: raw, mode: "insensitive" } }, select: { id: true, name: true, regulatoryProductId: true }, take: 4 }),
      ]);
      const total = bd.length + promo.length;
      if (total === 0) return { error: `Aucun produit « ${raw} » dans les catalogues BD / promotion.` };
      if (total > 1) {
        const list = [...bd.map((p) => `${p.dci} (BD)`), ...promo.map((p) => `${p.name} (promotion)`)];
        return { error: `Plusieurs produits correspondent : ${list.join(" ; ")} — préciser (champ « kind » : BD ou promotion).` };
      }
      const kind = bd.length === 1 ? "BD" as const : "PROMO" as const;
      const item = bd.length === 1 ? { id: bd[0].id, label: `${bd[0].dci} (catalogue BD)`, linked: bd[0].regulatoryProductId } : { id: promo[0].id, label: `${promo[0].name} (catalogue promotion)`, linked: promo[0].regulatoryProductId };
      const dossier = await resolveRegProduct(user, opStr(input, "reference"));
      if ("error" in dossier) return dossier;
      return {
        title: `Rattacher « ${item.label} » au dossier ${dossier.reference}`,
        fields: [
          { label: "Produit", value: item.label },
          { label: "Dossier réglementaire", value: `${dossier.reference} — ${dossier.dci}` },
        ],
        warnings: item.linked ? ["Ce produit est DÉJÀ rattaché à un dossier — le rattachement sera remplacé."] : [],
        args: { kind, id: item.id, regulatoryProductId: dossier.id },
        successMessage: `« ${item.label} » rattaché à ${dossier.reference}.`,
        revalidate: ["/produits/rapprocher", "/produits"],
      };
    },
    async execute(args) {
      const r = await linkProductToDossier({ kind: (args.kind ?? "BD") as "BD" | "PROMO", id: args.id ?? "", regulatoryProductId: args.regulatoryProductId ?? "" });
      if (!r.ok) return { ok: false, error: r.error ?? "Le rattachement a été refusé." };
      return { ok: true, revalidate: ["/produits/rapprocher", "/produits"] };
    },
  },

  unlink_catalog_product: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const raw = opStr(input, "name");
      if (!raw) return { error: "Précisez le produit du catalogue (champ « name »)." };
      const [bd, promo] = await Promise.all([
        prisma.bdProduct.findMany({ where: { dci: { contains: raw, mode: "insensitive" }, regulatoryProductId: { not: null } }, select: { id: true, dci: true }, take: 4 }),
        prisma.promoProduct.findMany({ where: { name: { contains: raw, mode: "insensitive" }, regulatoryProductId: { not: null } }, select: { id: true, name: true }, take: 4 }),
      ]);
      const total = bd.length + promo.length;
      if (total === 0) return { error: `Aucun produit RATTACHÉ « ${raw} » dans les catalogues.` };
      if (total > 1) {
        const list = [...bd.map((p) => `${p.dci} (BD)`), ...promo.map((p) => `${p.name} (promotion)`)];
        return { error: `Plusieurs produits rattachés correspondent : ${list.join(" ; ")} — préciser.` };
      }
      const kind = bd.length === 1 ? "BD" as const : "PROMO" as const;
      const label = bd.length === 1 ? `${bd[0].dci} (catalogue BD)` : `${promo[0].name} (catalogue promotion)`;
      return {
        title: `Défaire le rattachement de « ${label} »`,
        fields: [{ label: "Produit", value: label }],
        warnings: ["Le produit n'est plus rattaché à aucun dossier réglementaire (le dossier, lui, reste)."],
        args: { kind, id: bd.length === 1 ? bd[0].id : promo[0].id },
        successMessage: `Rattachement de « ${label} » défait.`,
        revalidate: ["/produits/rapprocher", "/produits"],
      };
    },
    async execute(args) {
      const r = await unlinkProductFromDossier({ kind: (args.kind ?? "BD") as "BD" | "PROMO", id: args.id ?? "" });
      if (!r.ok) return { ok: false, error: r.error ?? "Le détachement a été refusé." };
      return { ok: true, revalidate: ["/produits/rapprocher", "/produits"] };
    },
  },
};
