/**
 * OPS FLUX FINANCIERS — ÉCRITURES & comptes de trésorerie, FACTURES, PAIE (bulletins Finances et
 * masse salariale RH), LIGNE BUDGÉTAIRE annuelle et réponse au CENTRE DE PAIEMENT, par les actions
 * canoniques.
 */
import { prisma } from "./erp";
import { toNumber } from "@/lib/utils";
import { updateTransaction, deleteTransaction, deleteTreasuryAccount, createPayroll } from "@/lib/actions/finance-actions";
import { updateInvoice, deleteInvoice } from "@/lib/actions/invoice-actions";
import { markSalaryPaid, unmarkSalaryPaid } from "@/modules/rh/actions-paie";
import { createBudget } from "@/lib/actions/budget-actions";
import { respondToPaymentCentre } from "@/lib/actions/payment-centre-actions";
import type { OpImpl, OpProposalDraft } from "../../types";
import { opStr } from "../../types";
import { runFd, runFd2, dzd, fieldsOf, resolveOne, monthOf, isoDate } from "../../helpers";
import { categoryOf, directionOf, methodOf, txStatusOf, CATEGORY_FR, TX_STATUS_FR } from "../../impl-finance";
import { num, resolveOrder } from "./commun";

/** Un employé (registre de paie) par nom. */
const resolveEmployee = (raw: string) =>
  resolveOne(raw, "l'employé (champ « employee »)",
    (q) => prisma.employee.findMany({ where: { fullName: { contains: q, mode: "insensitive" } }, select: { id: true, fullName: true }, take: 6 }),
    (e) => e.fullName);

interface PayrollHit { id: string; year: number; month: number; net: number; gross: number; status: string; employeeName: string }

/** Le bulletin de paie d'un employé pour un mois (états bornés). */
async function resolvePayrollEntry(input: Record<string, unknown>, statuses: string[], transferred?: false): Promise<PayrollHit | { error: string }> {
  const emp = await resolveEmployee(opStr(input, "employee"));
  if ("error" in emp) return emp;
  const year = num(input, "year") ?? new Date().getFullYear();
  const month = opStr(input, "month") ? monthOf(opStr(input, "month")) : null;
  const rows = await prisma.payrollEntry.findMany({
    where: {
      employeeId: emp.id, year,
      ...(month ? { month } : {}),
      status: { in: statuses as never },
      ...(transferred === false ? { budgetTransferredAt: null } : {}),
    },
    select: { id: true, year: true, month: true, net: true, gross: true, status: true },
    orderBy: { month: "desc" },
    take: 4,
  });
  if (rows.length === 0) return { error: `Aucun bulletin ${statuses.join("/")}${month ? ` ${month}/${year}` : ` en ${year}`} pour ${emp.fullName}${transferred === false ? " (non transféré au budget)" : ""}.` };
  if (rows.length > 1) return { error: `Plusieurs bulletins pour ${emp.fullName} : ${rows.map((r) => `${r.month}/${r.year} (${r.status})`).join(", ")} — préciser le mois (champ « month »).` };
  const hit = rows[0];
  return { id: hit.id, year: hit.year, month: hit.month, net: toNumber(hit.net), gross: toNumber(hit.gross), status: hit.status, employeeName: emp.fullName };
}

const resolveTreasuryAccount = (raw: string) =>
  resolveOne(raw, "le compte de trésorerie (champ « account »)",
    (q) => prisma.treasuryAccount.findMany({ where: { name: { contains: q, mode: "insensitive" } }, select: { id: true, name: true, openingBalance: true }, take: 6 }),
    (a) => a.name);

async function resolveTx(raw: string) {
  const q = raw.trim();
  if (!q) return { error: "Précisez la référence (FIN-…) ou le libellé de l'écriture." } as const;
  const rows = await prisma.financeTransaction.findMany({
    where: { OR: [{ reference: { equals: q, mode: "insensitive" } }, { label: { contains: q, mode: "insensitive" } }] },
    orderBy: { date: "desc" },
    take: 6,
  });
  if (rows.length === 0) return { error: `Aucune écriture « ${q} ».` } as const;
  const exact = rows.filter((r) => r.reference.toLowerCase() === q.toLowerCase());
  if (exact.length === 1) return exact[0];
  if (rows.length === 1) return rows[0];
  return { error: `Plusieurs écritures correspondent à « ${q} » : ${rows.map((r) => `${r.reference} — ${r.label} (${dzd(toNumber(r.amount))})`).join(" ; ")} — donner la référence exacte.` } as const;
}

/** Une facture est un DOCUMENT LÉGAL de nature « facture » — son n° est sa `reference`. */
async function resolveInvoiceFull(raw: string) {
  const q = raw.trim();
  if (!q) return { error: "Précisez le numéro ou le titre de la facture." } as const;
  const rows = await prisma.legalDocument.findMany({
    where: { kind: "INVOICE", OR: [{ reference: { equals: q, mode: "insensitive" } }, { title: { contains: q, mode: "insensitive" } }] },
    orderBy: { createdAt: "desc" },
    take: 6,
  });
  if (rows.length === 0) return { error: `Aucune facture « ${q} ».` } as const;
  const exact = rows.filter((r) => (r.reference ?? "").toLowerCase() === q.toLowerCase());
  if (exact.length === 1) return exact[0];
  if (rows.length === 1) return rows[0];
  return { error: `Plusieurs factures correspondent à « ${q} » : ${rows.map((r) => `${r.reference ? `${r.reference} — ` : ""}${r.title}`).join(" ; ")} — préciser.` } as const;
}

const BUDGET_LINE_DEPTS: Record<string, string> = {
  REGULATORY: "Regulatory", SPONSORING: "Sponsoring", CONGRESS_INTERNATIONAL: "Congrès international",
  CONGRESS_NATIONAL: "Congrès national", MEDICAL_PROMOTION: "Promotion médicale", LOGISTICS: "Logistique",
  BUSINESS_DEVELOPMENT: "Business Development", MARKETING: "Marketing",
};

function budgetLineDeptOf(raw: string): string | null {
  const up = raw.toUpperCase().trim().replace(/\s+/g, "_");
  if (BUDGET_LINE_DEPTS[up]) return up;
  const k = raw.toLowerCase();
  if (/regulat/.test(k)) return "REGULATORY";
  if (/sponsor/.test(k)) return "SPONSORING";
  if (/congr.s.*inter/.test(k)) return "CONGRESS_INTERNATIONAL";
  if (/congr/.test(k)) return "CONGRESS_NATIONAL";
  if (/promotion|m[ée]dical/.test(k)) return "MEDICAL_PROMOTION";
  if (/logisti/.test(k)) return "LOGISTICS";
  if (/business|bd/.test(k)) return "BUSINESS_DEVELOPMENT";
  if (/marketing/.test(k)) return "MARKETING";
  return null;
}

export const ECRITURES_PAIE_OPS_IMPL: Record<string, OpImpl> = {
  // ─────────────── Écritures & comptes de trésorerie ───────────────

  update_transaction: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const tx = await resolveTx(opStr(input, "reference") || opStr(input, "transaction"));
      if ("error" in tx) return tx;
      // FUSION : l'action canonique REMPLACE l'écriture entière — on relit l'existant et on
      // rejoue chaque champ non modifié à l'identique.
      const label = opStr(input, "label") || tx.label;
      const amount = num(input, "amount");
      const category = opStr(input, "category") ? categoryOf(opStr(input, "category")) : tx.category;
      const direction = opStr(input, "direction") ? directionOf(opStr(input, "direction"), category) : tx.direction;
      const status = txStatusOf(opStr(input, "status")) ?? tx.status;
      const method = opStr(input, "method") ? methodOf(opStr(input, "method")) : tx.method;
      const date = isoDate(opStr(input, "date"));
      const counterparty = opStr(input, "counterparty") || tx.counterparty;
      const notes = opStr(input, "notes") || tx.notes;
      return {
        title: `Modifier l'écriture ${tx.reference}`,
        fields: fieldsOf([
          ["Écriture", tx.reference],
          ["Libellé", label !== tx.label ? `${tx.label} → ${label}` : label],
          ["Montant", amount !== null ? `${dzd(toNumber(tx.amount))} → ${dzd(amount)}` : dzd(toNumber(tx.amount))],
          ["Catégorie", CATEGORY_FR[category] ?? category],
          ["Sens", direction === "IN" ? "Encaissement" : "Décaissement"],
          ["Statut", TX_STATUS_FR[status] ?? status],
          ["Date", date],
          ["Contrepartie", counterparty],
        ]),
        args: {
          id: tx.id, label, amount: String(amount ?? toNumber(tx.amount)), category, direction, status, method,
          date, account: tx.account, counterparty, invoiceRef: opStr(input, "invoiceRef") || tx.invoiceRef, notes,
        },
        successMessage: `Écriture ${tx.reference} mise à jour.`,
        link: "/finances", revalidate: ["/finances"],
      };
    },
    execute: (args) => runFd(updateTransaction, args, "La modification de l'écriture a été refusée.", { revalidate: ["/finances"] }),
  },

  delete_transaction: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const tx = await resolveTx(opStr(input, "reference") || opStr(input, "transaction"));
      if ("error" in tx) return tx;
      return {
        title: `SUPPRIMER l'écriture ${tx.reference}`,
        fields: [
          { label: "Écriture", value: `${tx.reference} — ${tx.label}` },
          { label: "Montant", value: `${tx.direction === "IN" ? "+" : "−"}${dzd(toNumber(tx.amount))}` },
        ],
        warnings: [
          "Suppression DÉFINITIVE du livre : la trésorerie est recalculée sans cette écriture.",
          "Un bulletin de paie réglé qui pointait cette écriture repasse « validé, non réglé ».",
        ],
        confirmText: tx.reference,
        args: { id: tx.id },
        successMessage: `Écriture ${tx.reference} supprimée.`,
        revalidate: ["/finances"],
      };
    },
    execute: (args) => runFd(deleteTransaction, args, "La suppression a été refusée.", { revalidate: ["/finances"] }),
  },

  delete_treasury_account: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const account = await resolveTreasuryAccount(opStr(input, "account") || opStr(input, "name"));
      if ("error" in account) return account;
      return {
        title: `SUPPRIMER le compte de trésorerie « ${account.name} »`,
        fields: [
          { label: "Compte", value: account.name },
          { label: "Solde d'ouverture", value: dzd(toNumber(account.openingBalance)) },
        ],
        warnings: ["Le point de départ des soldes de ce compte disparaît — les écritures du livre, elles, restent."],
        confirmText: account.name,
        args: { id: account.id },
        successMessage: `Compte « ${account.name} » supprimé.`,
        revalidate: ["/finances"],
      };
    },
    execute: (args) => runFd(deleteTreasuryAccount, args, "La suppression du compte a été refusée.", { revalidate: ["/finances"] }),
  },

  // ─────────────── Factures ───────────────

  update_invoice: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const inv = await resolveInvoiceFull(opStr(input, "reference") || opStr(input, "label"));
      if ("error" in inv) return inv;
      // FUSION : updateInvoice REMPLACE la fiche — chaque champ absent est rejoué à l'identique.
      const title = opStr(input, "newLabel") || inv.title;
      const amount = num(input, "amount");
      const number = opStr(input, "reference") || opStr(input, "number") || inv.reference;
      const issueDate = isoDate(opStr(input, "date")) ?? (inv.startDate ? inv.startDate.toISOString().slice(0, 10) : null);
      const dueDate = isoDate(opStr(input, "dueDate")) ?? (inv.endDate ? inv.endDate.toISOString().slice(0, 10) : null);
      const paidDate = inv.paidDate ? inv.paidDate.toISOString().slice(0, 10) : null;
      const counterparty = opStr(input, "counterparty") || inv.counterparty;
      return {
        title: `Modifier la facture « ${inv.title} »`,
        fields: fieldsOf([
          ["Facture", inv.reference ? `${inv.reference} — ${inv.title}` : inv.title],
          ["Objet", title !== inv.title ? `${inv.title} → ${title}` : title],
          ["Montant", amount !== null ? `${inv.amount !== null ? dzd(toNumber(inv.amount)) : "—"} → ${dzd(amount)}` : (inv.amount !== null ? dzd(toNumber(inv.amount)) : null)],
          ["Échéance", dueDate],
          ["Règlement", paidDate ? `payée le ${paidDate} (inchangé — passer par « facture payée » pour y toucher)` : null],
        ]),
        args: {
          id: inv.id, title, number,
          amount: amount !== null ? String(amount) : (inv.amount !== null ? String(toNumber(inv.amount)) : null),
          issueDate, dueDate,
          // LE RÈGLEMENT EST REJOUÉ À L'IDENTIQUE : sans lui, renommer une facture réglée
          // l'effacerait, et l'écriture comptable serait retirée du livre par un renommage.
          paidDate,
          direction: inv.direction, counterparty,
          notes: opStr(input, "notes") || inv.notes,
        },
        successMessage: `Facture « ${title} » mise à jour.`,
        link: `/legal/${inv.id}`, revalidate: ["/legal", "/finances"],
      };
    },
    execute: (args) => runFd(updateInvoice, args, "La modification de la facture a été refusée.", { revalidate: ["/legal", "/finances"] }),
  },

  delete_invoice: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const inv = await resolveInvoiceFull(opStr(input, "reference") || opStr(input, "label"));
      if ("error" in inv) return inv;
      const key = inv.reference || inv.title;
      return {
        title: `SUPPRIMER la facture « ${inv.title} »`,
        fields: [
          { label: "Facture", value: `${inv.reference ? `${inv.reference} — ` : ""}${inv.title}${inv.amount !== null ? ` (${dzd(toNumber(inv.amount))})` : ""}` },
        ],
        warnings: ["Suppression définitive de la pièce dans le registre Legal — l'écriture de règlement éventuelle reste au livre."],
        confirmText: key,
        args: { id: inv.id },
        successMessage: `Facture « ${inv.title} » supprimée.`,
        revalidate: ["/legal", "/finances"],
      };
    },
    execute: (args) => runFd(deleteInvoice, args, "La suppression de la facture a été refusée.", { revalidate: ["/legal", "/finances"] }),
  },

  // ─────────────── Paie (bulletins Finances) ───────────────

  create_payroll: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const emp = await resolveEmployee(opStr(input, "employee"));
      if ("error" in emp) return emp;
      const gross = num(input, "gross") ?? num(input, "amount");
      if (gross === null || gross <= 0) return { error: "Précisez le salaire brut (champ « gross »)." };
      const bonuses = num(input, "bonuses") ?? 0;
      const deductions = num(input, "deductions") ?? 0;
      const year = num(input, "year") ?? new Date().getFullYear();
      const month = (opStr(input, "month") ? monthOf(opStr(input, "month")) : null) ?? new Date().getMonth() + 1;
      const net = gross + bonuses - deductions;
      return {
        title: `Bulletin ${month}/${year} — ${emp.fullName} (net ${dzd(net)})`,
        fields: fieldsOf([
          ["Employé", emp.fullName], ["Mois", `${month}/${year}`],
          ["Brut", dzd(gross)], ["Primes", bonuses ? dzd(bonuses) : null],
          ["Retenues", deductions ? dzd(deductions) : null], ["Net", dzd(net)],
        ]),
        warnings: ["Le bulletin naît en brouillon — le règlement (écriture SALAIRE) est un geste séparé."],
        args: { employeeId: emp.id, gross: String(gross), bonuses: bonuses ? String(bonuses) : null, deductions: deductions ? String(deductions) : null, year: String(year), month: String(month) },
        successMessage: `Bulletin ${month}/${year} créé pour ${emp.fullName}.`,
        link: "/finances", revalidate: ["/finances"],
      };
    },
    execute: (args) => runFd2(createPayroll, args, "La création du bulletin a été refusée.", { revalidate: ["/finances"] }),
  },

  // ─────────────── Paie RH (masse salariale) ───────────────

  mark_salary_paid: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const emp = await resolveEmployee(opStr(input, "employee"));
      if ("error" in emp) return emp;
      const employerCost = num(input, "employerCost");
      const net = num(input, "net");
      if (employerCost === null || employerCost <= 0) return { error: "Précisez le coût employeur (champ « employerCost » — brut + charges patronales, c'est lui qui pèse sur le budget)." };
      if (net === null || net <= 0) return { error: "Précisez le salaire net (champ « net » — le montant affiché au salarié)." };
      if (net > employerCost) return { error: "Le net ne peut pas dépasser le coût employeur." };
      const gross = num(input, "gross");
      const year = num(input, "year") ?? new Date().getFullYear();
      const month = (opStr(input, "month") ? monthOf(opStr(input, "month")) : null) ?? new Date().getMonth() + 1;
      return {
        title: `Marquer payé ${month}/${year} — ${emp.fullName}`,
        fields: fieldsOf([
          ["Employé", emp.fullName], ["Mois", `${month}/${year}`],
          ["Coût employeur", dzd(employerCost)], ["Brut", gross !== null ? dzd(gross) : null], ["Net (salarié)", dzd(net)],
        ]),
        warnings: [
          "Le salaire du mois est SAISI pour cet employé (sans fiche de paie jointe — elle peut être déposée depuis l'écran RH).",
          "Il n'est VERSÉ qu'au virement de la paie de son entité : un envoi au centre de paiement, depuis RH › Paie, avec la somme des salaires à virer.",
        ],
        args: { employeeId: emp.id, year: String(year), month: String(month), employerCost: String(employerCost), net: String(net), gross: gross !== null ? String(gross) : null },
        successMessage: `Salaire ${month}/${year} de ${emp.fullName} saisi — versé au prochain virement de la paie de son entité.`,
        link: "/rh", revalidate: ["/rh"],
      };
    },
    execute: (args) => runFd(markSalaryPaid, args, "Le marquage n'a pas été accepté.", { revalidate: ["/rh"] }),
  },

  unmark_salary_paid: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const entry = await resolvePayrollEntry(input, ["PAID"], false);
      if ("error" in entry) return entry;
      return {
        title: `Annuler le « payé » ${entry.month}/${entry.year} — ${entry.employeeName}`,
        fields: [
          { label: "Ligne", value: `${entry.employeeName} · ${entry.month}/${entry.year}` },
          { label: "Net", value: dzd(entry.net) },
        ],
        warnings: ["Correction d'erreur de saisie : la ligne repasse en brouillon et la fiche de paie déposée est retirée. Impossible une fois la paie de son entité partie au centre de paiement (ou transférée par l'ancien circuit)."],
        args: { id: entry.id },
        successMessage: `Paiement ${entry.month}/${entry.year} de ${entry.employeeName} annulé (correction).`,
        revalidate: ["/rh"],
      };
    },
    execute: (args) => runFd(unmarkSalaryPaid, args, "L'annulation a été refusée.", { revalidate: ["/rh"] }),
  },

  // ─────────────── Ligne budgétaire (suivi annuel) ───────────────

  create_budget_line: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const label = opStr(input, "label");
      if (!label) return { error: "Précisez le libellé de la ligne budgétaire (champ « label »)." };
      const dept = budgetLineDeptOf(opStr(input, "department"));
      if (!dept) return { error: "Précisez le domaine (champ « department ») : Regulatory | Sponsoring | Congrès international | Congrès national | Promotion médicale | Logistique | Business Development | Marketing." };
      const initial = num(input, "amount") ?? num(input, "initialBudget");
      const year = num(input, "year") ?? new Date().getFullYear();
      const month = opStr(input, "month") ? monthOf(opStr(input, "month")) : null;
      return {
        title: `Ligne budgétaire « ${label} » (${BUDGET_LINE_DEPTS[dept]}, ${year})`,
        fields: fieldsOf([
          ["Ligne", label], ["Domaine", BUDGET_LINE_DEPTS[dept]],
          ["Budget initial", initial !== null ? dzd(initial) : null],
          ["Année", String(year)], ["Mois", month ? String(month) : null],
          ["Commentaires", opStr(input, "notes") || null],
        ]),
        args: { label, department: dept, initialBudget: initial !== null ? String(initial) : null, year: String(year), month: month ? String(month) : null, comments: opStr(input, "notes") || null },
        successMessage: `Ligne budgétaire « ${label} » créée (${BUDGET_LINE_DEPTS[dept]}, ${year}).`,
        link: "/budgets", revalidate: ["/budgets"],
      };
    },
    execute: (args) => runFd2(createBudget, args, "La création de la ligne budgétaire a été refusée.", { revalidate: ["/budgets"] }),
  },

  // ─────────────── Centre de paiement — réponse du demandeur ───────────────

  respond_payment_centre: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const order = await resolveOrder(opStr(input, "reference") || opStr(input, "label"));
      if ("error" in order) return order;
      const body = opStr(input, "message") || opStr(input, "note");
      if (!body) return { error: "Écrivez la réponse (champ « message ») — c'est l'argumentaire qui retourne au centre." };
      return {
        title: `Répondre au Centre de paiement — ${order.reference}`,
        fields: [
          { label: "Ordre", value: `${order.reference} — ${order.label} (${dzd(toNumber(order.amount))})` },
          { label: "Réponse", value: body },
        ],
        warnings: ["Le dossier retourne au Centre de paiement pour reprendre l'autorisation."],
        args: { id: order.id, body },
        successMessage: `Réponse envoyée — ${order.reference} retourne au Centre de paiement.`,
        revalidate: ["/centre-paiement"],
      };
    },
    execute: (args) => runFd(respondToPaymentCentre, args, "La réponse a été refusée.", { revalidate: ["/centre-paiement"] }),
  },
};
