import { prisma } from "@/lib/prisma";
import {
  createTransaction, updateTransactionStatus, createQuickIncome, setTreasuryOpeningBalance,
} from "@/lib/actions/finance-actions";
import { settleExpenseOrder } from "@/lib/actions/expense-actions";
import { createInvoice, setInvoicePaid, setInvoiceOrder } from "@/lib/actions/invoice-actions";
import { decidePettyCashTopUp } from "@/lib/actions/petty-cash-actions";
import { decideDepartmentBudgetRequest } from "@/lib/actions/department-budget-actions";
import { toNumber, montantDzd } from "@/lib/utils";
import { invoiceSettlementState } from "@/lib/labels";
import type { OpImpl, OpProposalDraft } from "./types";
import { opStr } from "./types";

/**
 * OPS FINANCES — écritures du livre, règlements, factures, rallonges de caisse et budgets de
 * département, par les ACTIONS CANONIQUES des écrans Finances/Budgets. Les entrées humaines
 * (« règle l'ordre OD-2026-014 », « accorde la rallonge du marketing ») sont résolues ici ;
 * les verrous de fond (Centre de paiement, facture obligatoire, portes RH/Budgets) restent
 * ceux des actions — jamais recodés.
 */

/** Montant humain : « 1 500 000 », « 1500000,50 » — jamais deviné, refusé si illisible. */
function opAmount(input: Record<string, unknown>, key: string): number | null {
  const v = input[key];
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) return null;
  const n = Number(s.replace(/[\s ]/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

const iso = (raw: string): string | null => {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};

// ── Normalisations FR → énumérations du schéma (liste blanche, jamais du texte libre). ──

export const CATEGORY_FR: Record<string, string> = {
  RECETTE: "Recette / vente", CCA: "Compte courant associé", PRET: "Emprunt reçu",
  REMBOURSEMENT: "Remboursement d'emprunt", SALAIRE: "Salaires", AVANCE: "Avance sur salaire",
  LOYER: "Loyer", VOYAGE: "Déplacements / missions", EVENEMENT: "Événementiel",
  BUREAUTIQUE: "Bureautique / matériel", FOURNISSEUR: "Fournisseurs", CHARGES: "Charges diverses",
  IMPOT: "Impôts & taxes", BANQUE: "Frais bancaires", AUTRE: "Autre",
};

export function categoryOf(raw: string): string {
  const up = raw.trim().toUpperCase();
  if (CATEGORY_FR[up]) return up;
  const k = raw.toLowerCase();
  if (/loyer/.test(k)) return "LOYER";
  if (/avance/.test(k)) return "AVANCE";
  if (/salaire|paie|personnel/.test(k)) return "SALAIRE";
  if (/voyage|mission|d[ée]placement|billet/.test(k)) return "VOYAGE";
  if (/congr[èe]s|[ée]v[ée]nement|sponsoring|table ronde/.test(k)) return "EVENEMENT";
  if (/bureau|mobilier|mat[ée]riel|informatique/.test(k)) return "BUREAUTIQUE";
  if (/fournisseur|achat|marchandise/.test(k)) return "FOURNISSEUR";
  if (/imp[oô]t|taxe|fiscal/.test(k)) return "IMPOT";
  if (/banc|banque|agios/.test(k)) return "BANQUE";
  if (/recette|vente|client|encaissement/.test(k)) return "RECETTE";
  if (/emprunt|pr[êe]t re[çc]u/.test(k)) return "PRET";
  if (/remboursement/.test(k)) return "REMBOURSEMENT";
  if (/charge|electricit|électricit|eau|internet|assurance/.test(k)) return "CHARGES";
  if (/apport|associ[ée]/.test(k)) return "CCA";
  return "AUTRE";
}

const IN_CATEGORIES = new Set(["RECETTE", "CCA", "PRET"]);

export function directionOf(raw: string, category: string): "IN" | "OUT" {
  const k = raw.toLowerCase();
  if (/encaiss|recette|entr[ée]e|\bin\b/.test(k)) return "IN";
  if (/d[ée]caiss|d[ée]pense|sortie|\bout\b/.test(k)) return "OUT";
  return IN_CATEGORIES.has(category) ? "IN" : "OUT";
}

export function methodOf(raw: string): string {
  const k = raw.toLowerCase();
  if (/esp[èe]ce|cash|liquide/.test(k)) return "CASH";
  if (/ch[èe]que/.test(k)) return "CHEQUE";
  if (/carte|card/.test(k)) return "CARD";
  if (/virement|transfer/.test(k)) return "BANK_TRANSFER";
  return "BANK_TRANSFER";
}

export const TX_STATUS_FR: Record<string, string> = { PENDING: "Prévu (à régler)", SETTLED: "Réalisé", CANCELLED: "Annulé" };

export function txStatusOf(raw: string): "PENDING" | "SETTLED" | "CANCELLED" | null {
  const k = raw.toLowerCase();
  if (!k) return null;
  if (/pr[ée]vu|attente|r[ée]gler|pending|planifi/.test(k)) return "PENDING";
  if (/r[ée]alis|settled|pay|fait|encaiss/.test(k)) return "SETTLED";
  if (/annul|cancel/.test(k)) return "CANCELLED";
  return null;
}

// ── Résolutions par référence / libellé (exact → unique → ambigu listé). ──

interface TxHit { id: string; reference: string; label: string; amount: number; direction: string; status: string }

async function resolveTransaction(raw: string): Promise<TxHit | { error: string }> {
  const q = raw.trim();
  if (!q) return { error: "Précisez la référence (FIN-…) ou le libellé de l'écriture." };
  const rows = await prisma.financeTransaction.findMany({
    where: { OR: [{ reference: { equals: q, mode: "insensitive" } }, { label: { contains: q, mode: "insensitive" } }] },
    select: { id: true, reference: true, label: true, amount: true, direction: true, status: true },
    orderBy: { date: "desc" },
    take: 6,
  });
  const hits: TxHit[] = rows.map((r) => ({ ...r, amount: toNumber(r.amount) }));
  if (hits.length === 0) return { error: `Aucune écriture « ${q} ».` };
  const exact = hits.filter((h) => h.reference.toLowerCase() === q.toLowerCase());
  if (exact.length === 1) return exact[0];
  if (hits.length === 1) return hits[0];
  return { error: `Plusieurs écritures correspondent à « ${q} » : ${hits.map((h) => `${h.reference} — ${h.label} (${montantDzd(h.amount)})`).join(" ; ")} — donner la référence exacte.` };
}

interface OrderHit { id: string; reference: string; label: string; amount: number; beneficiary: string | null; status: string }

async function resolveExpenseOrder(raw: string, statuses: string[]): Promise<OrderHit | { error: string }> {
  const q = raw.trim();
  if (!q) return { error: "Précisez la référence (OD-…) ou le libellé de l'ordre de dépense." };
  const rows = await prisma.expenseOrder.findMany({
    where: {
      status: { in: statuses as never },
      OR: [
        { reference: { equals: q, mode: "insensitive" } },
        { label: { contains: q, mode: "insensitive" } },
        { beneficiary: { contains: q, mode: "insensitive" } },
      ],
    },
    select: { id: true, reference: true, label: true, amount: true, beneficiary: true, status: true },
    orderBy: { createdAt: "desc" },
    take: 6,
  });
  const hits: OrderHit[] = rows.map((r) => ({ ...r, amount: toNumber(r.amount) }));
  if (hits.length === 0) return { error: `Aucun ordre de dépense EN ATTENTE « ${q} ».` };
  const exact = hits.filter((h) => h.reference.toLowerCase() === q.toLowerCase());
  if (exact.length === 1) return exact[0];
  if (hits.length === 1) return hits[0];
  return { error: `Plusieurs ordres correspondent à « ${q} » : ${hits.map((h) => `${h.reference} — ${h.label} (${montantDzd(h.amount)})`).join(" ; ")} — donner la référence exacte.` };
}

interface InvoiceHit { id: string; title: string; number: string | null; amount: number | null; status: string }

async function resolveInvoice(raw: string): Promise<InvoiceHit | { error: string }> {
  const q = raw.trim();
  if (!q) return { error: "Précisez le numéro ou le titre de la facture." };
  // Une facture est un document légal de nature « facture » : son n° est sa `reference`.
  const rows = await prisma.legalDocument.findMany({
    where: { kind: "INVOICE", OR: [{ reference: { equals: q, mode: "insensitive" } }, { title: { contains: q, mode: "insensitive" } }] },
    select: { id: true, title: true, reference: true, amount: true, status: true, kind: true, paidDate: true, expenseOrderId: true },
    orderBy: { createdAt: "desc" },
    take: 6,
  });
  const hits: InvoiceHit[] = rows.map((r) => ({
    id: r.id, title: r.title, number: r.reference,
    amount: r.amount === null ? null : toNumber(r.amount),
    // Le STATUT d'une facture, pour Adam, c'est son RÈGLEMENT : « en vigueur » ne dit rien à
    // qui demande où en est son paiement.
    status: r.status === "CANCELLED" ? "CANCELLED" : invoiceSettlementState(r),
  }));
  if (hits.length === 0) return { error: `Aucune facture « ${q} ».` };
  const exact = hits.filter((h) => (h.number ?? "").toLowerCase() === q.toLowerCase());
  if (exact.length === 1) return exact[0];
  if (hits.length === 1) return hits[0];
  return { error: `Plusieurs factures correspondent à « ${q} » : ${hits.map((h) => `${h.number ? `${h.number} — ` : ""}${h.title}${h.amount !== null ? ` (${montantDzd(h.amount)})` : ""}`).join(" ; ")} — préciser.` };
}

/**
 * BC PCH pour rattacher une facture à sa naissance (sourceType = PCH_ORDER) : par n° de bon,
 * produits ou référence du marché. Exact → unique → ambiguïté LISTÉE, jamais devinée.
 */
async function resolvePchOrderSource(raw: string): Promise<{ id: string; label: string } | { error: string }> {
  const q = raw.trim().toLowerCase();
  if (!q) return { error: "Précisez le bon de commande (champ « order » : n° de BC ou marché)." };
  const rows = await prisma.pchOrder.findMany({
    select: { id: true, reference: true, products: true, tender: { select: { reference: true } } },
    orderBy: { createdAt: "desc" },
    take: 300,
  });
  const label = (o: (typeof rows)[number]) => `BC ${o.reference ?? o.products ?? "s/n"} — ${o.tender.reference}`;
  const exact = rows.filter((o) => (o.reference ?? "").toLowerCase() === q);
  if (exact.length === 1) return { id: exact[0].id, label: label(exact[0]) };
  const hits = rows.filter((o) =>
    (o.reference ?? "").toLowerCase().includes(q)
    || (o.products ?? "").toLowerCase().includes(q)
    || o.tender.reference.toLowerCase().includes(q));
  if (hits.length === 1) return { id: hits[0].id, label: label(hits[0]) };
  if (hits.length === 0) return { error: `Aucun bon de commande PCH ne correspond à « ${raw} ».` };
  return { error: `Plusieurs bons correspondent à « ${raw} » : ${hits.slice(0, 8).map(label).join(" ; ")} — préciser.` };
}

const decisionOf = (raw: string): "APPROVED" | "REJECTED" | null => {
  const k = raw.toLowerCase();
  if (/accord|approuv|valide|oui|ok/.test(k)) return "APPROVED";
  if (/refus|rejet|non/.test(k)) return "REJECTED";
  return null;
};

export const FINANCE_OPS_IMPL: Record<string, OpImpl> = {
  create_transaction: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const label = opStr(input, "label");
      const amount = opAmount(input, "amount");
      if (!label) return { error: "Donnez le libellé de l'écriture (champ « label »)." };
      if (amount === null || amount <= 0) return { error: "Donnez un montant en DZD strictement positif (champ « amount »)." };
      const category = categoryOf(opStr(input, "category"));
      const direction = directionOf(opStr(input, "direction"), category);
      const status = txStatusOf(opStr(input, "status")) ?? "SETTLED";
      const method = methodOf(opStr(input, "method"));
      const date = iso(opStr(input, "date"));
      const counterparty = opStr(input, "counterparty");
      const notes = opStr(input, "notes");
      return {
        title: `${direction === "IN" ? "Encaissement" : "Décaissement"} — ${label} (${montantDzd(amount)})`,
        fields: [
          { label: "Sens", value: direction === "IN" ? "Encaissement (entrée)" : "Décaissement (sortie)" },
          { label: "Libellé", value: label },
          { label: "Montant", value: montantDzd(amount) },
          { label: "Catégorie", value: CATEGORY_FR[category] },
          { label: "Statut", value: TX_STATUS_FR[status] },
          ...(date ? [{ label: "Date", value: date }] : []),
          ...(counterparty ? [{ label: "Contrepartie", value: counterparty }] : []),
        ],
        warnings: status === "SETTLED" ? ["Écriture RÉALISÉE : elle impacte la trésorerie dès la confirmation."] : [],
        args: { label, amount: String(amount), category, direction, status, method, date, counterparty, notes },
        successMessage: `Écriture « ${label} » (${montantDzd(amount)}) enregistrée.`,
        link: "/finances",
        revalidate: ["/finances"],
      };
    },
    async execute(args) {
      const fd = new FormData();
      for (const key of ["label", "amount", "category", "direction", "status", "method", "date", "counterparty", "notes"]) {
        if (args[key]) fd.set(key, args[key] as string);
      }
      const r = await createTransaction(undefined, fd);
      if (!r.ok) return { ok: false, error: r.error ?? "L'écriture a été refusée." };
      return { ok: true, createdId: r.id, link: "/finances", revalidate: ["/finances"] };
    },
  },

  quick_income: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const label = opStr(input, "label");
      const amount = opAmount(input, "amount");
      if (!label) return { error: "Donnez le libellé de l'encaissement (champ « label »)." };
      if (amount === null || amount <= 0) return { error: "Donnez un montant en DZD strictement positif (champ « amount »)." };
      const client = opStr(input, "counterparty");
      const date = iso(opStr(input, "date"));
      return {
        title: `Encaissement simple — ${label} (${montantDzd(amount)})`,
        fields: [
          { label: "Libellé", value: label },
          { label: "Montant", value: montantDzd(amount) },
          ...(client ? [{ label: "Client", value: client }] : []),
          ...(date ? [{ label: "Date", value: date }] : []),
        ],
        warnings: ["Recette RÉALISÉE : elle impacte la trésorerie dès la confirmation."],
        args: { label, amount: String(amount), client, date },
        successMessage: `Encaissement « ${label} » (${montantDzd(amount)}) enregistré.`,
        link: "/finances",
        revalidate: ["/finances"],
      };
    },
    async execute(args) {
      const fd = new FormData();
      fd.set("label", args.label ?? "");
      fd.set("amount", args.amount ?? "");
      if (args.client) fd.set("client", args.client);
      if (args.date) fd.set("date", args.date);
      const r = await createQuickIncome(undefined, fd);
      if (!r.ok) return { ok: false, error: r.error ?? "L'encaissement a été refusé." };
      return { ok: true, createdId: r.id, link: "/finances", revalidate: ["/finances"] };
    },
  },

  set_transaction_status: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const status = txStatusOf(opStr(input, "status"));
      if (!status) return { error: "Précisez le statut visé : prévu, réalisé ou annulé (champ « status »)." };
      const tx = await resolveTransaction(opStr(input, "reference") || opStr(input, "label"));
      if ("error" in tx) return tx;
      if (tx.status === status) return { error: `L'écriture ${tx.reference} est déjà « ${TX_STATUS_FR[status]} ».` };
      return {
        title: `Écriture ${tx.reference} → ${TX_STATUS_FR[status]}`,
        fields: [
          { label: "Écriture", value: `${tx.reference} — ${tx.label} (${montantDzd(tx.amount)})` },
          { label: "Statut", value: `${TX_STATUS_FR[tx.status] ?? tx.status} → ${TX_STATUS_FR[status]}` },
        ],
        warnings: status === "SETTLED"
          ? ["RÉALISÉ : l'écriture compte dans la trésorerie dès la confirmation."]
          : status === "CANCELLED" ? ["ANNULÉ : l'écriture sort des soldes."] : [],
        args: { id: tx.id, status, reference: tx.reference },
        successMessage: `Écriture ${tx.reference} passée « ${TX_STATUS_FR[status]} ».`,
        link: "/finances",
        revalidate: ["/finances"],
      };
    },
    async execute(args) {
      const fd = new FormData();
      fd.set("id", args.id ?? "");
      fd.set("status", args.status ?? "");
      const r = await updateTransactionStatus(fd);
      if (!r.ok) return { ok: false, error: r.error ?? "Le changement de statut a été refusé." };
      return { ok: true, revalidate: ["/finances"] };
    },
  },

  set_opening_balance: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const name = opStr(input, "account") || opStr(input, "label");
      const amount = opAmount(input, "amount");
      if (!name) return { error: "Donnez le nom du compte de trésorerie (champ « account », ex. « Banque BNA »)." };
      if (amount === null) return { error: "Donnez le solde du relevé en DZD (champ « amount » — 0 accepté)." };
      const date = iso(opStr(input, "date"));
      // L'ANCRAGE EXIGE SA DATE (§118.176) : un solde sans jour ne dit pas quelles écritures il contient.
      if (!date) return { error: "Donnez la date du relevé (champ « date ») : le solde s'entend en fin de cette journée." };
      return {
        title: `Ouvrir le compte « ${name} », ancré à ${montantDzd(amount)} au ${date}`,
        fields: [
          { label: "Compte", value: name },
          { label: "Solde du relevé", value: montantDzd(amount) },
          { label: "Date du relevé", value: date },
        ],
        warnings: ["Refusé si le compte existe déjà : un ancrage existant se corrige depuis l'écran, avec un motif."],
        args: { name, amount: String(amount), date, notes: opStr(input, "notes") },
        successMessage: `Compte « ${name} » ouvert, ancré à ${montantDzd(amount)}.`,
        link: "/finances",
        revalidate: ["/finances"],
      };
    },
    async execute(args) {
      const fd = new FormData();
      fd.set("name", args.name ?? "");
      fd.set("openingBalance", args.amount ?? "");
      if (args.date) fd.set("openingDate", args.date);
      if (args.notes) fd.set("notes", args.notes);
      const r = await setTreasuryOpeningBalance(undefined, fd);
      if (!r.ok) return { ok: false, error: r.error ?? "Le réglage du solde a été refusé." };
      return { ok: true, revalidate: ["/finances"] };
    },
  },

  settle_expense_order: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const order = await resolveExpenseOrder(opStr(input, "reference") || opStr(input, "label"), ["PENDING"]);
      if ("error" in order) return order;
      return {
        title: `Régler l'ordre ${order.reference} — ${montantDzd(order.amount)}`,
        fields: [
          { label: "Ordre", value: `${order.reference} — ${order.label}` },
          { label: "Montant", value: montantDzd(order.amount) },
          ...(order.beneficiary ? [{ label: "Bénéficiaire", value: order.beneficiary }] : []),
        ],
        warnings: [
          "L'ARGENT SORT à la confirmation : écriture de décaissement générée, budget imputé.",
          "Le verrou du Centre de paiement et la facture obligatoire (dépenses événementielles) s'appliquent : si l'ordre n'est pas autorisé, l'exécution refusera en le disant.",
        ],
        args: { id: order.id, reference: order.reference },
        successMessage: `Ordre ${order.reference} réglé — décaissement enregistré.`,
        link: "/finances",
        revalidate: ["/finances"],
      };
    },
    async execute(args) {
      const fd = new FormData();
      fd.set("id", args.id ?? "");
      const r = await settleExpenseOrder(fd);
      if (!r.ok) return { ok: false, error: r.error ?? "Le règlement a été refusé." };
      return { ok: true, revalidate: ["/finances"] };
    },
  },

  create_invoice: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const title = opStr(input, "label");
      if (!title) return { error: "Donnez le titre de la facture (champ « label »)." };
      const amount = opAmount(input, "amount");
      const received = !/[ée]mise|in\b|encaisse/i.test(opStr(input, "direction")); // défaut : facture REÇUE (la société paie)
      const number = opStr(input, "reference");
      const issueDate = iso(opStr(input, "date"));
      const dueDate = iso(opStr(input, "dueDate"));
      // Rattachement de naissance à un BC PCH : la facture apparaît alors sur la fiche marché.
      let bon: { id: string; label: string } | null = null;
      if (opStr(input, "order")) {
        const r = await resolvePchOrderSource(opStr(input, "order"));
        if ("error" in r) return r;
        bon = r;
      }
      return {
        title: `Enregistrer la facture ${received ? "reçue" : "émise"} — ${title}`,
        fields: [
          { label: "Facture", value: title },
          { label: "Sens", value: received ? "REÇUE — la société paie" : "ÉMISE — la société encaisse" },
          ...(bon ? [{ label: "Rattachée au bon", value: bon.label }] : []),
          ...(number ? [{ label: "Numéro", value: number }] : []),
          ...(amount !== null ? [{ label: "Montant", value: montantDzd(amount) }] : []),
          ...(issueDate ? [{ label: "Émise le", value: issueDate }] : []),
          ...(dueDate ? [{ label: "Échéance", value: dueDate }] : []),
        ],
        warnings: ["L'enregistrement ne paie rien — le règlement se marque ensuite (facture payée)."],
        args: {
          title, number, direction: received ? "OUT" : "IN",
          amount: amount !== null ? String(amount) : null,
          issueDate, dueDate,
          counterparty: opStr(input, "counterparty"), notes: opStr(input, "notes"),
          sourceId: bon?.id ?? null,
        },
        successMessage: bon ? `Facture « ${title} » enregistrée et rattachée au bon (${bon.label}).` : `Facture « ${title} » enregistrée.`,
        link: "/legal?nature=INVOICE",
        revalidate: ["/legal", "/finances"],
      };
    },
    async execute(args) {
      const fd = new FormData();
      fd.set("title", args.title ?? "");
      fd.set("direction", args.direction ?? "OUT");
      if (args.number) fd.set("number", args.number);
      if (args.amount) fd.set("amount", args.amount);
      if (args.issueDate) fd.set("issueDate", args.issueDate);
      if (args.dueDate) fd.set("dueDate", args.dueDate);
      if (args.counterparty) fd.set("counterparty", args.counterparty);
      if (args.notes) fd.set("notes", args.notes);
      if (args.sourceId) { fd.set("sourceType", "PCH_ORDER"); fd.set("sourceId", args.sourceId); }
      const r = await createInvoice(undefined, fd);
      if (!r.ok) return { ok: false, error: r.error ?? "L'enregistrement de la facture a été refusé." };
      // Une facture est un document légal : c'est SA fiche qu'on ouvre au retour.
      return { ok: true, createdId: r.id, link: r.id ? `/legal/${r.id}` : "/legal?nature=INVOICE", revalidate: ["/legal", "/finances"] };
    },
  },

  attach_invoice_order: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const inv = await resolveInvoice(opStr(input, "reference") || opStr(input, "label"));
      if ("error" in inv) return inv;
      const detach = /d[ée]tach|retire|aucun|enl[èe]ve/i.test(opStr(input, "order"));
      const bon = detach ? null : await resolvePchOrderSource(opStr(input, "order"));
      if (bon && "error" in bon) return bon;
      return {
        title: detach
          ? `Détacher la facture « ${inv.title} » de son bon de commande`
          : `Rattacher la facture « ${inv.title} » à un bon de commande`,
        fields: [
          { label: "Facture", value: `${inv.number ? `${inv.number} — ` : ""}${inv.title}${inv.amount !== null ? ` (${montantDzd(inv.amount)})` : ""}` },
          { label: "Bon de commande", value: detach ? "— détachée —" : (bon as { label: string }).label },
        ],
        args: { id: inv.id, orderId: detach ? null : (bon as { id: string }).id, title: inv.title },
        successMessage: detach
          ? `Facture « ${inv.title} » détachée de son bon.`
          : `Facture « ${inv.title} » rattachée au bon (${(bon as { label: string }).label}) — visible sur la fiche marché.`,
        link: `/legal/${inv.id}`,
        revalidate: ["/legal", "/finances", "/pch"],
      };
    },
    async execute(args) {
      const fd = new FormData();
      fd.set("id", args.id ?? "");
      if (args.orderId) fd.set("pchOrderId", args.orderId);
      const r = await setInvoiceOrder(fd);
      if (!r.ok) return { ok: false, error: r.error ?? "Le rattachement a été refusé." };
      return { ok: true, revalidate: ["/legal", "/finances", "/pch"] };
    },
  },

  set_invoice_paid: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const unpay = /impay|non pay|annule le paiement/i.test(opStr(input, "status"));
      const inv = await resolveInvoice(opStr(input, "reference") || opStr(input, "label"));
      if ("error" in inv) return inv;
      const paidDate = unpay ? null : (iso(opStr(input, "date")) ?? new Date().toISOString().slice(0, 10));
      return {
        title: unpay ? `Repasser la facture « ${inv.title} » impayée` : `Marquer la facture « ${inv.title} » payée`,
        fields: [
          { label: "Facture", value: `${inv.number ? `${inv.number} — ` : ""}${inv.title}${inv.amount !== null ? ` (${montantDzd(inv.amount)})` : ""}` },
          { label: "Paiement", value: unpay ? "retiré (impayée)" : `payée le ${paidDate}` },
        ],
        args: { id: inv.id, paidDate, title: inv.title },
        successMessage: unpay ? `Facture « ${inv.title} » repassée impayée.` : `Facture « ${inv.title} » marquée payée.`,
        link: `/legal/${inv.id}`,
        revalidate: ["/legal", "/finances"],
      };
    },
    async execute(args) {
      const r = await setInvoicePaid({ id: args.id ?? "", paidDate: args.paidDate ?? null });
      if (!r.ok) return { ok: false, error: r.error ?? "La mise à jour de la facture a été refusée." };
      return { ok: true, revalidate: ["/legal", "/finances"] };
    },
  },

  decide_petty_topup: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const decision = decisionOf(opStr(input, "decision"));
      if (!decision) return { error: "Précisez la décision : accorder ou refuser (champ « decision »)." };
      const q = opStr(input, "department");
      const rows = await prisma.pettyCashTopUpRequest.findMany({
        where: {
          status: "PENDING",
          ...(q ? { allotment: { department: { name: { contains: q, mode: "insensitive" } } } } : {}),
        },
        include: { allotment: { include: { department: { select: { name: true } } } } },
        orderBy: { createdAt: "desc" },
        take: 6,
      });
      if (rows.length === 0) return { error: `Aucune demande de rallonge EN ATTENTE${q ? ` pour « ${q} »` : ""}.` };
      if (rows.length > 1) {
        return { error: `Plusieurs rallonges en attente : ${rows.map((r) => `${r.allotment.department.name} (${montantDzd(toNumber(r.amountRequested))}, ${r.allotment.period})`).join(" ; ")} — préciser le département.` };
      }
      const req = rows[0];
      const asked = toNumber(req.amountRequested);
      const granted = decision === "APPROVED" ? (opAmount(input, "amount") ?? asked) : 0;
      if (decision === "APPROVED" && granted < 0) return { error: "Le montant accordé ne peut pas être négatif." };
      return {
        title: `${decision === "APPROVED" ? "Accorder" : "Refuser"} la rallonge de caisse — ${req.allotment.department.name}`,
        fields: [
          { label: "Caisse", value: `${req.allotment.department.name} · ${req.allotment.period}` },
          { label: "Montant demandé", value: montantDzd(asked) },
          { label: "Décision", value: decision === "APPROVED" ? `Accordée — ${montantDzd(granted)}` : "Refusée" },
        ],
        warnings: decision === "APPROVED" ? ["Le fonds du mois est augmenté d'autant ; le titulaire est notifié."] : ["Le titulaire est notifié du refus."],
        args: { id: req.id, decision, amountGranted: decision === "APPROVED" ? String(granted) : null, note: opStr(input, "note") },
        successMessage: decision === "APPROVED"
          ? `Rallonge accordée (${montantDzd(granted)}) — ${req.allotment.department.name}.`
          : `Rallonge refusée — ${req.allotment.department.name}.`,
        link: "/budgets",
        revalidate: ["/budgets"],
      };
    },
    async execute(args) {
      const fd = new FormData();
      fd.set("id", args.id ?? "");
      fd.set("decision", args.decision ?? "");
      if (args.amountGranted) fd.set("amountGranted", args.amountGranted);
      if (args.note) fd.set("note", args.note);
      const r = await decidePettyCashTopUp(fd);
      if (!r.ok) return { ok: false, error: r.error ?? "La décision a été refusée." };
      return { ok: true, revalidate: ["/budgets"] };
    },
  },

  decide_department_budget: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const decision = decisionOf(opStr(input, "decision"));
      if (!decision) return { error: "Précisez la décision : approuver ou refuser (champ « decision »)." };
      const q = opStr(input, "department");
      const rows = await prisma.departmentBudgetRequest.findMany({
        where: {
          status: "PENDING",
          ...(q ? { department: { name: { contains: q, mode: "insensitive" } } } : {}),
        },
        include: { department: { select: { name: true } } },
        orderBy: { createdAt: "desc" },
        take: 6,
      });
      if (rows.length === 0) return { error: `Aucune demande de budget de département EN ATTENTE${q ? ` pour « ${q} »` : ""}.` };
      if (rows.length > 1) {
        return { error: `Plusieurs demandes en attente : ${rows.map((r) => `${r.department.name} (${montantDzd(toNumber(r.amount))}, ${r.year})`).join(" ; ")} — préciser le département.` };
      }
      const req = rows[0];
      return {
        title: `${decision === "APPROVED" ? "Approuver" : "Refuser"} la demande de budget — ${req.department.name}`,
        fields: [
          { label: "Département", value: `${req.department.name} (${req.year})` },
          { label: "Montant demandé", value: montantDzd(toNumber(req.amount)) },
          ...(req.reason ? [{ label: "Motif", value: req.reason }] : []),
          { label: "Décision", value: decision === "APPROVED" ? "Approuvée" : "Refusée" },
        ],
        warnings: decision === "APPROVED" ? ["La rallonge s'AJOUTE au budget de l'année du département ; le demandeur est notifié."] : ["Le demandeur est notifié du refus."],
        args: { id: req.id, decision, note: opStr(input, "note") },
        successMessage: `Demande de budget ${decision === "APPROVED" ? "approuvée" : "refusée"} — ${req.department.name}.`,
        link: "/budgets",
        revalidate: ["/budgets"],
      };
    },
    async execute(args) {
      const fd = new FormData();
      fd.set("id", args.id ?? "");
      fd.set("decision", args.decision ?? "");
      if (args.note) fd.set("note", args.note);
      const r = await decideDepartmentBudgetRequest(fd);
      if (!r.ok) return { ok: false, error: r.error ?? "La décision a été refusée." };
      return { ok: true, revalidate: ["/budgets"] };
    },
  },
};
