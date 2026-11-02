/**
 * OPS VAGUE 4a — PCH / MARCHÉS : appels d'offres et bons de commande en FUSION intégrale,
 * lignes-produits, analyse IA d'un texte d'AO, enrichissement marché, suivi d'arrivée. Les
 * résolutions d'AO et de bon de commande servent aussi au Marché 360. Par les actions canoniques.
 */
import { prisma } from "./erp";
import { createTender, updateTender, deleteTender, createOrder, updateOrder, deleteOrder } from "@/lib/actions/pch-actions";
import { addTenderLine, updateTenderLine, deleteTenderLine, analyzeTenderText, createOrderFromLine, enrichTenderLine, enrichAllTenderLines, setOrderArrival } from "@/lib/actions/pch-tender-line-actions";
import type { OpImpl, OpProposalDraft } from "../../types";
import { opStr } from "../../types";
import { runFd, runFd2, fieldsOf, isoDate, dzd } from "../../helpers";
import { fold } from "../../impl-regulatory";
import { day, statusIn } from "./commun";

const numStr = (v: unknown): string | null => (v == null ? null : String(Number(v)));

// ─────────────────────────── PCH / MARCHÉS ───────────────────────────

export interface TenderHit { id: string; reference: string; title: string | null }

export async function resolveTender(raw: string): Promise<TenderHit | { error: string }> {
  const q = raw.trim();
  if (!q) return { error: "Précisez l'appel d'offres (champ « reference » — AO-AAAA-NNN, titre ou produits)." };
  const exact = await prisma.pchTender.findFirst({
    where: { reference: { equals: q, mode: "insensitive" } },
    select: { id: true, reference: true, title: true },
  });
  if (exact) return exact;
  const rows = await prisma.pchTender.findMany({
    where: { OR: [{ reference: { contains: q, mode: "insensitive" } }, { title: { contains: q, mode: "insensitive" } }, { products: { contains: q, mode: "insensitive" } }] },
    select: { id: true, reference: true, title: true },
    orderBy: { createdAt: "desc" }, take: 6,
  });
  if (rows.length === 1) return rows[0];
  if (rows.length === 0) return { error: `Aucun appel d'offres « ${q} ».` };
  return { error: `Plusieurs appels d'offres correspondent : ${rows.map((t) => `${t.reference}${t.title ? ` — ${t.title}` : ""}`).join(" ; ")} — donner la référence exacte.` };
}

export const tenderLabel = (t: TenderHit): string => `${t.reference}${t.title ? ` — ${t.title}` : ""}`;

async function resolveTenderLine(tenderId: string, tenderRef: string, raw: string) {
  const rows = await prisma.pchTenderLine.findMany({
    where: { tenderId }, select: { id: true, designation: true, dci: true, status: true },
    orderBy: { sortOrder: "asc" }, take: 40,
  });
  if (rows.length === 0) return { error: `L'appel d'offres ${tenderRef} n'a aucune ligne-produit.` } as const;
  const q = fold(raw);
  if (!q) {
    if (rows.length === 1) return rows[0];
    return { error: `Précisez la ligne (champ « line ») parmi : ${rows.slice(0, 10).map((l) => l.designation).join(" ; ")}${rows.length > 10 ? " ; …" : ""}.` } as const;
  }
  const hits = rows.filter((l) => fold(l.designation).includes(q) || (l.dci && fold(l.dci).includes(q)));
  if (hits.length === 1) return hits[0];
  if (hits.length === 0) return { error: `Aucune ligne « ${raw} » sur ${tenderRef} — lignes : ${rows.slice(0, 10).map((l) => l.designation).join(" ; ")}.` } as const;
  return { error: `Plusieurs lignes correspondent : ${hits.map((l) => l.designation).join(" ; ")} — préciser.` } as const;
}

export async function resolvePchOrder(tenderId: string, tenderRef: string, raw: string) {
  const rows = await prisma.pchOrder.findMany({
    where: { tenderId }, select: { id: true, reference: true, products: true },
    orderBy: { createdAt: "desc" }, take: 20,
  });
  if (rows.length === 0) return { error: `Aucun bon de commande sur ${tenderRef}.` } as const;
  const q = fold(raw);
  const label = (o: { reference: string | null; products: string | null }) => o.reference ?? o.products ?? "s/n";
  if (!q) {
    if (rows.length === 1) return rows[0];
    return { error: `Précisez le bon de commande (champ « order ») parmi : ${rows.map(label).join(" ; ")}.` } as const;
  }
  const hits = rows.filter((o) => fold(o.reference ?? "").includes(q) || fold(o.products ?? "").includes(q));
  if (hits.length === 1) return hits[0];
  if (hits.length === 0) return { error: `Aucun bon de commande « ${raw} » sur ${tenderRef} — présents : ${rows.map(label).join(" ; ")}.` } as const;
  return { error: `Plusieurs bons de commande correspondent : ${hits.map(label).join(" ; ")} — préciser.` } as const;
}

const TENDER_STATUS_FR: [string, string][] = [
  ["NOT_STARTED", "Non commencé"], ["IN_PROGRESS", "En cours"], ["COMPLETED", "Terminé"], ["CANCELLED", "Annulé"],
];
const ORDER_STATUS_FR: [string, string][] = [
  ["PENDING", "En attente"], ["VALIDATED", "Validé"], ["DELIVERED", "Livré"], ["PAID", "Payé"], ["CANCELLED", "Annulé"],
];
const LINE_STATUS_FR: [string, string][] = [
  ["PENDING", "En attente"], ["QUOTED", "Chiffré"], ["SUBMITTED", "Soumis"], ["WON", "Gagné"], ["LOST", "Perdu"],
];

export const PCH_OPS_IMPL: Record<string, OpImpl> = {
  create_tender: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const title = opStr(input, "name") || opStr(input, "label");
      const products = opStr(input, "products");
      if (!title && !products) return { error: "Précisez au moins le titre du marché (champ « name ») ou ses produits (champ « products »)." };
      const status = statusIn(opStr(input, "status"), TENDER_STATUS_FR);
      if (status && typeof status === "object") return status;
      const amount = opStr(input, "amount");
      return {
        title: `Nouvel appel d'offres PCH${title ? ` « ${title} »` : ""}`,
        fields: fieldsOf([
          ["Titre", title || null], ["Produits", products || null],
          ["Fournisseur", opStr(input, "supplier") || null], ["Pays", opStr(input, "country") || null],
          ["Quantité", opStr(input, "quantity") || null],
          ["Valeur", amount ? dzd(Number(amount)) : null],
          ["Attribution", isoDate(opStr(input, "date"))],
          ["Notes", opStr(input, "notes") || null],
        ]),
        warnings: ["La référence AO-AAAA-NNN est numérotée automatiquement."],
        args: {
          title: title || null, products: products || null,
          supplier: opStr(input, "supplier") || null, supplierCountry: opStr(input, "country") || null,
          quantity: opStr(input, "quantity") || null, value: amount || null,
          status: (status as string | null), awardDate: isoDate(opStr(input, "date")),
          notes: opStr(input, "notes") || null,
        },
        successMessage: `Appel d'offres${title ? ` « ${title} »` : ""} créé.`,
        link: "/pch", revalidate: ["/pch"],
      };
    },
    execute: (args) => runFd2(createTender, args, "La création de l'appel d'offres a été refusée.", { revalidate: ["/pch"] }),
  },

  update_tender: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const tender = await resolveTender(opStr(input, "reference"));
      if ("error" in tender) return tender;
      const t = await prisma.pchTender.findUnique({ where: { id: tender.id } });
      if (!t) return { error: "Appel d'offres introuvable." };
      const status = statusIn(opStr(input, "status"), TENDER_STATUS_FR);
      if (status && typeof status === "object") return status;
      // FUSION : l'action REMPLACE tous les champs (texte absent → null, quantité absente → 0,
      // caution absente → décochée) — l'existant est relu et rejoué là où rien n'est demandé.
      const changes: string[] = [];
      const pick = (key: string, current: string | null, label: string): string | null => {
        const v = opStr(input, key);
        if (v) { changes.push(label); return v; }
        return current;
      };
      const title = pick("name", t.title, "titre");
      const products = pick("products", t.products, "produits");
      const supplier = pick("supplier", t.supplier, "fournisseur");
      const country = pick("country", t.supplierCountry, "pays");
      const quantity = opStr(input, "quantity") ? (changes.push("quantité"), opStr(input, "quantity")) : String(t.quantity);
      const value = opStr(input, "amount") ? (changes.push("valeur"), opStr(input, "amount")) : numStr(t.value);
      const awardDate = isoDate(opStr(input, "date")) ? (changes.push("date d'attribution"), isoDate(opStr(input, "date"))) : day(t.awardDate);
      const notes = pick("notes", t.notes, "notes");
      // LA RÉFÉRENCE se corrige comme le reste — elle est saisie à la main, donc faillible. Elle
      // reste UNIQUE : l'action refuse en nommant le marché qui la porte déjà.
      const nouvelleRef = opStr(input, "newReference").trim();
      if (nouvelleRef && nouvelleRef !== t.reference) changes.push(`référence → ${nouvelleRef}`);
      if (status) changes.push(`statut → ${TENDER_STATUS_FR.find(([c]) => c === status)?.[1] ?? status}`);
      if (changes.length === 0) return { error: "Rien à changer : donnez name, newReference, products, supplier, country, quantity, amount, status, date ou notes." };
      return {
        title: `Modifier l'appel d'offres ${tender.reference}`,
        fields: [
          { label: "Marché", value: tenderLabel(tender) },
          { label: "Modifications", value: changes.join(" · ") },
          { label: "Le reste", value: "rejoué à l'identique (caution comprise)" },
        ],
        args: {
          id: tender.id, title, products, supplier, supplierCountry: country,
          quantity, value, client: t.client, status: (status as string | null),
          awardDate, notes,
          cautionAmount: numStr(t.cautionAmount), cautionDeposited: t.cautionDeposited ? "1" : null,
          cautionStart: day(t.cautionStart), cautionEnd: day(t.cautionEnd),
          reference: nouvelleRef || tender.reference,
        },
        successMessage: `Appel d'offres ${tender.reference} mis à jour (${changes.join(", ")}).`,
        link: `/pch/${tender.id}`, revalidate: ["/pch"],
      };
    },
    execute: (args) => runFd(updateTender, args, "La modification de l'appel d'offres a été refusée.", { revalidate: ["/pch"] }),
  },

  delete_tender: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const tender = await resolveTender(opStr(input, "reference"));
      if ("error" in tender) return tender;
      const [orders, lines] = await Promise.all([
        prisma.pchOrder.count({ where: { tenderId: tender.id } }),
        prisma.pchTenderLine.count({ where: { tenderId: tender.id } }),
      ]);
      return {
        title: `SUPPRIMER l'appel d'offres ${tender.reference}`,
        fields: [
          { label: "Marché", value: tenderLabel(tender) },
          { label: "Emporte avec lui", value: `${orders} bon(s) de commande, ${lines} ligne(s)-produit` },
        ],
        warnings: ["Suppression définitive EN CASCADE : les bons de commande et lignes-produits du marché disparaissent avec lui."],
        confirmText: tender.reference,
        args: { id: tender.id },
        successMessage: `Appel d'offres ${tender.reference} supprimé (cascade comprise).`,
        revalidate: ["/pch"],
      };
    },
    execute: (args) => runFd(deleteTender, args, "La suppression a été refusée.", { revalidate: ["/pch"] }),
  },

  create_order: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const tender = await resolveTender(opStr(input, "reference"));
      if ("error" in tender) return tender;
      const status = statusIn(opStr(input, "status"), ORDER_STATUS_FR);
      if (status && typeof status === "object") return status;
      const amount = opStr(input, "amount");
      return {
        title: `Bon de commande sur ${tender.reference}`,
        fields: fieldsOf([
          ["Marché", tenderLabel(tender)],
          ["N° du bon", opStr(input, "order") || null],
          ["Produits", opStr(input, "products") || null],
          ["Quantité", opStr(input, "quantity") || null],
          ["Valeur", amount ? dzd(Number(amount)) : null],
          ["Reçu le", isoDate(opStr(input, "date"))],
          ["Notes", opStr(input, "notes") || null],
        ]),
        args: {
          tenderId: tender.id, reference: opStr(input, "order") || null,
          products: opStr(input, "products") || null, quantity: opStr(input, "quantity") || null,
          value: amount || null, status: (status as string | null),
          receivedDate: isoDate(opStr(input, "date")), notes: opStr(input, "notes") || null,
        },
        successMessage: `Bon de commande créé sur ${tender.reference}.`,
        link: `/pch/${tender.id}`, revalidate: ["/pch"],
      };
    },
    execute: (args) => runFd(createOrder, args, "La création du bon de commande a été refusée.", { revalidate: ["/pch"] }),
  },

  update_order: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const tender = await resolveTender(opStr(input, "reference"));
      if ("error" in tender) return tender;
      const hit = await resolvePchOrder(tender.id, tender.reference, opStr(input, "order"));
      if ("error" in hit) return hit;
      const o = await prisma.pchOrder.findUnique({ where: { id: hit.id } });
      if (!o) return { error: "Bon de commande introuvable." };
      const status = statusIn(opStr(input, "status"), ORDER_STATUS_FR);
      if (status && typeof status === "object") return status;
      const changes: string[] = [];
      const orderRef = opStr(input, "newName") ? (changes.push("n°"), opStr(input, "newName")) : o.reference;
      const products = opStr(input, "products") ? (changes.push("produits"), opStr(input, "products")) : o.products;
      const quantity = opStr(input, "quantity") ? (changes.push("quantité"), opStr(input, "quantity")) : String(o.quantity);
      const value = opStr(input, "amount") ? (changes.push("valeur"), opStr(input, "amount")) : numStr(o.value);
      const receivedDate = isoDate(opStr(input, "date")) ? (changes.push("reçu le"), isoDate(opStr(input, "date"))) : day(o.receivedDate);
      const paymentDate = isoDate(opStr(input, "paymentDate")) ? (changes.push("payé le"), isoDate(opStr(input, "paymentDate"))) : day(o.paymentDate);
      const notes = opStr(input, "notes") ? (changes.push("notes"), opStr(input, "notes")) : o.notes;
      if (status) changes.push(`statut → ${ORDER_STATUS_FR.find(([c]) => c === status)?.[1] ?? status}`);
      if (changes.length === 0) return { error: "Rien à changer : donnez newName, products, quantity, amount, status, date, paymentDate ou notes." };
      return {
        title: `Modifier le bon de commande ${hit.reference ?? hit.products ?? ""} (${tender.reference})`,
        fields: [
          { label: "Bon de commande", value: `${hit.reference ?? "s/n"} — ${tender.reference}` },
          { label: "Modifications", value: changes.join(" · ") },
          { label: "Le reste", value: "rejoué à l'identique" },
        ],
        args: {
          id: hit.id, reference: orderRef, products, quantity, value,
          status: (status as string | null), receivedDate, paymentDate, notes,
        },
        successMessage: `Bon de commande mis à jour (${changes.join(", ")}).`,
        link: `/pch/${tender.id}`, revalidate: ["/pch"],
      };
    },
    execute: (args) => runFd(updateOrder, args, "La modification du bon de commande a été refusée.", { revalidate: ["/pch"] }),
  },

  delete_order: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const tender = await resolveTender(opStr(input, "reference"));
      if ("error" in tender) return tender;
      const hit = await resolvePchOrder(tender.id, tender.reference, opStr(input, "order"));
      if ("error" in hit) return hit;
      const label = hit.reference ?? hit.products ?? "s/n";
      return {
        title: `SUPPRIMER le bon de commande ${label} (${tender.reference})`,
        fields: [{ label: "Bon de commande", value: `${label} — ${tenderLabel(tender)}` }],
        warnings: ["Suppression définitive du bon de commande — le marché, lui, reste."],
        confirmText: label,
        args: { id: hit.id },
        successMessage: `Bon de commande ${label} supprimé.`,
        revalidate: ["/pch"],
      };
    },
    execute: (args) => runFd(deleteOrder, args, "La suppression du bon de commande a été refusée.", { revalidate: ["/pch"] }),
  },

  add_line: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const tender = await resolveTender(opStr(input, "reference"));
      if ("error" in tender) return tender;
      const designation = opStr(input, "line") || opStr(input, "name");
      if (!designation) return { error: "Précisez le produit demandé (champ « line »)." };
      return {
        title: `Ajouter la ligne « ${designation} » à ${tender.reference}`,
        fields: [
          { label: "Marché", value: tenderLabel(tender) },
          { label: "Produit", value: designation },
        ],
        args: { tenderId: tender.id, designation },
        successMessage: `Ligne « ${designation} » ajoutée à ${tender.reference}.`,
        link: `/pch/${tender.id}`, revalidate: ["/pch"],
      };
    },
    execute: (args) => runFd(addTenderLine, args, "L'ajout de la ligne a été refusé.", { revalidate: ["/pch"] }),
  },

  update_line: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const tender = await resolveTender(opStr(input, "reference"));
      if ("error" in tender) return tender;
      const hit = await resolveTenderLine(tender.id, tender.reference, opStr(input, "line"));
      if ("error" in hit) return hit;
      const l = await prisma.pchTenderLine.findUnique({ where: { id: hit.id } });
      if (!l) return { error: "Ligne introuvable." };
      const status = statusIn(opStr(input, "status"), LINE_STATUS_FR);
      if (status && typeof status === "object") return status;
      const changes: string[] = [];
      const pick = (key: string, current: string | null, label: string): string | null => {
        const v = opStr(input, key);
        if (v) { changes.push(label); return v; }
        return current;
      };
      const designation = pick("newName", l.designation, "désignation") ?? l.designation;
      const dci = pick("dci", l.dci, "DCI");
      const dosage = pick("dosage", l.dosage, "dosage");
      const form = pick("form", l.form, "forme");
      const quantityUnits = opStr(input, "quantity") ? (changes.push("quantité"), opStr(input, "quantity")) : String(l.quantityUnits);
      const unitPrice = opStr(input, "amount") ? (changes.push("notre prix"), opStr(input, "amount")) : numStr(l.unitPriceDzd);
      const awardedPrice = opStr(input, "awardedPrice") ? (changes.push("prix attribué"), opStr(input, "awardedPrice")) : numStr(l.awardedUnitPriceDzd);
      const note = pick("note", l.note, "note");
      if (status && status !== l.status) changes.push(`statut → ${LINE_STATUS_FR.find(([c]) => c === status)?.[1] ?? status}`);
      if (changes.length === 0) return { error: "Rien à changer : donnez newName, dci, dosage, form, quantity, amount, awardedPrice, status ou note." };
      return {
        title: `Modifier la ligne « ${l.designation} » (${tender.reference})`,
        fields: [
          { label: "Ligne", value: `${l.designation} — ${tender.reference}` },
          { label: "Modifications", value: changes.join(" · ") },
          { label: "Le reste", value: "rejoué à l'identique (conditionnement, enrichissement marché compris)" },
        ],
        args: {
          id: hit.id, tenderId: tender.id, designation, dci, dosage, form,
          quantityUnits, unitsPerBox: l.unitsPerBox != null ? String(l.unitsPerBox) : null,
          unitLabel: l.unitLabel, haveProduct: l.haveProduct ? "on" : null,
          unitPriceDzd: unitPrice, suppliersInfo: l.suppliersInfo,
          status: (status as string | null) ?? l.status, awardedUnitPriceDzd: awardedPrice, note,
        },
        successMessage: `Ligne « ${designation} » mise à jour (${changes.join(", ")}).`,
        link: `/pch/${tender.id}`, revalidate: ["/pch"],
      };
    },
    execute: (args) => runFd(updateTenderLine, args, "La modification de la ligne a été refusée.", { revalidate: ["/pch"] }),
  },

  delete_line: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const tender = await resolveTender(opStr(input, "reference"));
      if ("error" in tender) return tender;
      const hit = await resolveTenderLine(tender.id, tender.reference, opStr(input, "line"));
      if ("error" in hit) return hit;
      return {
        title: `Retirer la ligne « ${hit.designation} » de ${tender.reference}`,
        fields: [{ label: "Ligne", value: `${hit.designation} — ${tenderLabel(tender)}` }],
        // Ce que l'action FAIT depuis la vague « restes » : la corbeille, et un refus quand quelque chose découle du lot.
        warnings: ["Le lot part à la corbeille, restaurable avec ses affectations aux BU. Refusé si un bon de commande, une ligne de contrat de marché, une vente sous marché ou une répartition Ad & Pro en découle : passez-le alors à « Lot annulé »."],
        args: { id: hit.id, tenderId: tender.id },
        successMessage: `Ligne « ${hit.designation} » retirée.`,
        revalidate: ["/pch"],
      };
    },
    execute: (args) => runFd(deleteTenderLine, args, "Le retrait de la ligne a été refusé.", { revalidate: ["/pch"] }),
  },

  analyze_tender_text: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const tender = await resolveTender(opStr(input, "reference"));
      if ("error" in tender) return tender;
      const text = opStr(input, "text") || opStr(input, "notes");
      if (!text || text.trim().length < 10) return { error: "Collez le texte du document d'appel d'offres (champ « text »)." };
      return {
        title: `Analyser le texte de l'AO ${tender.reference} (extraction IA des produits)`,
        fields: [
          { label: "Marché", value: tenderLabel(tender) },
          { label: "Texte", value: `${text.slice(0, 160)}${text.length > 160 ? "…" : ""} (${text.length} caractères)` },
        ],
        warnings: ["L'IA extrait les produits demandés puis chaque ligne est ENRICHIE automatiquement (prix de référence PCH, nomenclature, notre catalogue, analyse de marché) — une nouvelle lecture REMPLACE les lignes des lectures précédentes que personne n'a touchées."],
        args: { tenderId: tender.id, text },
        successMessage: `Produits extraits du texte et enrichis sur ${tender.reference}.`,
        link: `/pch/${tender.id}`, revalidate: ["/pch"],
      };
    },
    execute: (args) => runFd(analyzeTenderText, args, "L'analyse du texte a été refusée.", { revalidate: ["/pch"] }),
  },

  create_order_from_line: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const tender = await resolveTender(opStr(input, "reference"));
      if ("error" in tender) return tender;
      const hit = await resolveTenderLine(tender.id, tender.reference, opStr(input, "line"));
      if ("error" in hit) return hit;
      if (hit.status !== "WON") return { error: `La ligne « ${hit.designation} » n'est pas GAGNÉE (statut ${LINE_STATUS_FR.find(([c]) => c === hit.status)?.[1] ?? hit.status}) — marquez-la « Gagné » d'abord.` };
      const qty = opStr(input, "quantity");
      if (!qty || Number(qty) <= 0) return { error: "Indiquez la quantité vendue (champ « quantity »)." };
      return {
        title: `Bon de commande (vente réelle) — « ${hit.designation} » × ${qty}`,
        fields: fieldsOf([
          ["Marché", tenderLabel(tender)],
          ["Ligne gagnée", hit.designation],
          ["Quantité", qty],
          ["N° du bon", opStr(input, "order") || null],
        ]),
        warnings: ["La valeur est calculée au prix attribué de la ligne (ou à notre prix unitaire à défaut)."],
        args: { lineId: hit.id, tenderId: tender.id, quantity: qty, reference: opStr(input, "order") || null },
        successMessage: `Bon de commande créé — « ${hit.designation} » × ${qty}.`,
        link: `/pch/${tender.id}`, revalidate: ["/pch"],
      };
    },
    execute: (args) => runFd(createOrderFromLine, args, "La création du bon de commande a été refusée.", { revalidate: ["/pch"] }),
  },

  enrich_line: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const tender = await resolveTender(opStr(input, "reference"));
      if ("error" in tender) return tender;
      const hit = await resolveTenderLine(tender.id, tender.reference, opStr(input, "line"));
      if ("error" in hit) return hit;
      return {
        title: `Enrichir « ${hit.designation} » par l'intelligence marché`,
        fields: [{ label: "Ligne", value: `${hit.designation} — ${tenderLabel(tender)}` }],
        warnings: ["Apports : prix de référence Réceptions PCH, nomenclature, notre produit, concurrents / parts de marché — rien n'est écrit si aucune correspondance."],
        args: { id: hit.id, tenderId: tender.id },
        successMessage: `Ligne « ${hit.designation} » enrichie.`,
        revalidate: ["/pch"],
      };
    },
    execute: (args) => runFd(enrichTenderLine, args, "L'enrichissement a été refusé.", { revalidate: ["/pch"] }),
  },

  enrich_all_lines: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const tender = await resolveTender(opStr(input, "reference"));
      if ("error" in tender) return tender;
      const count = await prisma.pchTenderLine.count({ where: { tenderId: tender.id } });
      if (count === 0) return { error: `Aucune ligne à enrichir sur ${tender.reference}.` };
      return {
        title: `Enrichir les ${count} lignes de ${tender.reference} d'un geste`,
        fields: [{ label: "Marché", value: tenderLabel(tender) }, { label: "Lignes", value: String(count) }],
        args: { tenderId: tender.id },
        successMessage: `Enrichissement lancé sur les ${count} lignes de ${tender.reference}.`,
        revalidate: ["/pch"],
      };
    },
    execute: (args) => runFd(enrichAllTenderLines, args, "L'enrichissement a été refusé.", { revalidate: ["/pch"] }),
  },

  set_order_arrival: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const tender = await resolveTender(opStr(input, "reference"));
      if ("error" in tender) return tender;
      const hit = await resolvePchOrder(tender.id, tender.reference, opStr(input, "order"));
      if ("error" in hit) return hit;
      const o = await prisma.pchOrder.findUnique({ where: { id: hit.id }, select: { expectedArrival: true, arrivedDate: true } });
      if (!o) return { error: "Bon de commande introuvable." };
      const expected = isoDate(opStr(input, "date")) ?? day(o.expectedArrival);
      const arrived = isoDate(opStr(input, "arrivedDate")) ?? day(o.arrivedDate);
      if (!isoDate(opStr(input, "date")) && !isoDate(opStr(input, "arrivedDate"))) {
        return { error: "Donnez la date d'arrivée prévue (champ « date ») et/ou réelle (champ « arrivedDate »), AAAA-MM-JJ." };
      }
      return {
        title: `Suivi d'arrivée — bon ${hit.reference ?? "s/n"} (${tender.reference})`,
        fields: fieldsOf([
          ["Bon de commande", `${hit.reference ?? "s/n"} — ${tender.reference}`],
          ["Arrivée prévue", expected], ["Arrivée réelle", arrived],
        ]),
        args: { id: hit.id, tenderId: tender.id, expectedArrival: expected, arrivedDate: arrived },
        successMessage: "Dates d'arrivée du bon de commande mises à jour.",
        revalidate: ["/pch"],
      };
    },
    execute: (args) => runFd(setOrderArrival, args, "Le suivi d'arrivée a été refusé.", { revalidate: ["/pch"] }),
  },
};
