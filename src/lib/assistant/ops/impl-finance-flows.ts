import { prisma } from "@/lib/prisma";
import { toNumber } from "@/lib/utils";
import {
  allotPettyCash, confirmPettyCashReceipt, closePettyCash, requestPettyCashTopUp, setPettyCashPlan,
} from "@/lib/actions/petty-cash-actions";
import { requestInvoice, deferExpenseOrder, resumeExpenseOrder } from "@/lib/actions/expense-actions";
import {
  createPaymentRequest, submitPaymentRequest, decidePaymentRequest, cancelPaymentRequest,
  addPaymentComment, commentPaymentPiece, reviewPaymentPiece,
  updatePaymentRequestDetails,
} from "@/lib/actions/payment-request-actions";
import { updateTransaction, deleteTransaction, deleteTreasuryAccount, createPayroll } from "@/lib/actions/finance-actions";
import { updateInvoice, deleteInvoice } from "@/lib/actions/invoice-actions";
import { markSalaryPaid, unmarkSalaryPaid } from "@/lib/actions/payroll-hr-actions";
import { createBudget } from "@/lib/actions/budget-actions";
import { respondToPaymentCentre } from "@/lib/actions/payment-centre-actions";
import type { PaymentMove } from "@/lib/finance/payment-request";
import type { OpImpl, OpProposalDraft } from "./types";
import { opStr } from "./types";
import { runFd, runFd2, dzd, fieldsOf, resolveOne, monthOf, isoDate } from "./helpers";
import { categoryOf, directionOf, methodOf, txStatusOf, CATEGORY_FR, TX_STATUS_FR } from "./impl-finance";

/**
 * OPS FLUX FINANCIERS — caisse d'avance, ordres de dépense (facture/révision), demandes de
 * paiement (dossier + pièces), écritures (modifier/supprimer), factures (modifier/supprimer),
 * paie (bulletins Finances + paie RH + transfert budget), centre de paiement : toujours par les
 * ACTIONS CANONIQUES des écrans. Invariants : résolution par référence/nom (ambiguïté LISTÉE),
 * FUSION pour les updates (l'action REMPLACE — on relit et rejoue les champs absents),
 * suppressions CRITIQUES à ressaisie. Les verrous métier (détentrice seule, Finances seules,
 * Centre de paiement, seuils) restent ceux des actions — jamais recodés ici.
 */

const num = (input: Record<string, unknown>, key: string): number | null => {
  const v = input[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v.replace(/[\s  ]/g, "").replace(",", "."));
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

/** Période « AAAA-MM » depuis une saisie humaine (« août 2026 », « 2026-08 ») — défaut : mois courant. */
function periodOf(raw: string): string | { error: string } {
  const q = raw.trim();
  if (!q) return new Date().toISOString().slice(0, 7);
  if (/^\d{4}-\d{2}$/.test(q)) return q;
  const yearMatch = q.match(/(20\d{2})/);
  const year = yearMatch ? Number(yearMatch[1]) : new Date().getFullYear();
  const m = monthOf(q.replace(/20\d{2}/, "").trim());
  if (!m) return { error: `Période « ${raw} » illisible — attendu un mois (« août 2026 », « 2026-08 »).` };
  return `${year}-${String(m).padStart(2, "0")}`;
}

const resolveDept = (raw: string) =>
  resolveOne(raw, "le département (champ « department »)",
    (q) => prisma.department.findMany({ where: { name: { contains: q, mode: "insensitive" } }, select: { id: true, name: true }, take: 6 }),
    (d) => d.name);

const resolvePerson = (raw: string) =>
  resolveOne(raw, "la personne",
    (q) => prisma.user.findMany({ where: { name: { contains: q, mode: "insensitive" }, isActive: true }, select: { id: true, name: true }, take: 6 }),
    (u) => u.name);

interface CashHit {
  /** La remise que l'action vise. Ce qu'elle en fait — le fond entier, ou elle seule — est SA règle. */
  id: string;
  deptId: string;
  deptName: string;
  period: string;
  status: string;
  amount: number;
  holderName: string | null;
  /** Combien de remises correspondent à la demande (sert à refuser une cible ambiguë). */
  count: number;
  /** Combien de remises composent le fond en cours (sert à DIRE ce que « solder » emporte). */
  openCount: number;
}

/**
 * LA REMISE VISÉE DANS LA CAISSE D'AVANCE D'UN DÉPARTEMENT.
 *
 * La caisse est CONTINUE : plusieurs remises non soldées coexistent, et c'est normal. Le
 * résolveur refusait justement sur cette pluralité (« préciser la période ») — il aurait bloqué
 * Adam dès la deuxième remise. Il rend désormais la plus récente, et la période ne sert plus qu'à
 * viser une remise précise (confirmer SA réception).
 *
 * ── CE QU'IL NE FAIT PAS, ET C'EST VOULU ────────────────────────────────────────────────────
 *
 * Il ne calcule NI le solde du fond, NI ce qui est dépensable. Cette arithmétique appartient à
 * `general-means/continuous-cash.ts`, et l'action la revérifie de toute façon : la recopier ici
 * donnerait deux calculs qui se contrediraient au premier changement de règle — Adam annoncerait
 * un reste, l'action en appliquerait un autre. La proposition dit donc ce que l'action VA FAIRE
 * (« la somme s'ajoute au fond », « le fond entier est arrêté »), sans chiffrer le fond.
 */
async function resolveCash(deptRaw: string, periodRaw: string, statuses?: string[]): Promise<CashHit | { error: string }> {
  const dept = await resolveDept(deptRaw);
  if ("error" in dept) return dept;
  const period = periodRaw ? periodOf(periodRaw) : null;
  if (period && typeof period !== "string") return period;

  const rows = await prisma.pettyCashAllotment.findMany({
    where: { departmentId: dept.id, status: { not: "CLOSED" } },
    select: { id: true, period: true, status: true, amount: true, holder: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
  });
  const eligibles = rows.filter((r) => (
    (!period || r.period === period) && (!statuses || statuses.includes(r.status))
  ));
  if (eligibles.length === 0) {
    return { error: `Aucune remise en caisse${period ? ` de ${period}` : ""} pour ${dept.name}${statuses ? ` (état attendu : ${statuses.join("/")})` : ""}.` };
  }
  const hit = eligibles[0];
  return {
    id: hit.id,
    deptId: dept.id,
    deptName: dept.name,
    period: hit.period,
    status: hit.status,
    amount: toNumber(hit.amount),
    holderName: hit.holder?.name ?? null,
    count: eligibles.length,
    openCount: rows.length,
  };
}

/** Un ordre de dépense par référence OD-… ou libellé (statuts bornés si fournis). */
async function resolveOrder(raw: string, statuses?: string[]) {
  const q = raw.trim();
  if (!q) return { error: "Précisez la référence (OD-…) ou le libellé de l'ordre de dépense." } as const;
  const rows = await prisma.expenseOrder.findMany({
    where: {
      ...(statuses ? { status: { in: statuses as never } } : {}),
      OR: [
        { reference: { equals: q, mode: "insensitive" } },
        { label: { contains: q, mode: "insensitive" } },
        { beneficiary: { contains: q, mode: "insensitive" } },
      ],
    },
    select: {
      id: true, reference: true, label: true, amount: true, beneficiary: true, status: true,
      deferredUntil: true,
    },
    orderBy: { createdAt: "desc" },
    take: 6,
  });
  if (rows.length === 0) return { error: `Aucun ordre de dépense « ${q} »${statuses ? ` à l'état ${statuses.join("/")}` : ""}.` } as const;
  const exact = rows.filter((r) => r.reference.toLowerCase() === q.toLowerCase());
  if (exact.length === 1) return exact[0];
  if (rows.length === 1) return rows[0];
  return { error: `Plusieurs ordres correspondent à « ${q} » : ${rows.map((r) => `${r.reference} — ${r.label} (${dzd(toNumber(r.amount))})`).join(" ; ")} — donner la référence exacte.` } as const;
}

/** Une demande de paiement par référence PAY-… ou titre. */
async function resolvePayment(raw: string) {
  const q = raw.trim();
  if (!q) return { error: "Précisez la référence (PAY-…) ou l'objet de la demande de paiement." } as const;
  const rows = await prisma.paymentRequest.findMany({
    where: { OR: [{ reference: { equals: q, mode: "insensitive" } }, { title: { contains: q, mode: "insensitive" } }, { payee: { contains: q, mode: "insensitive" } }] },
    select: {
      id: true, reference: true, title: true, amount: true, payee: true, status: true,
      contactName: true, contactPhone: true, contactEmail: true, paymentMethodStated: true,
    },
    orderBy: { createdAt: "desc" },
    take: 6,
  });
  if (rows.length === 0) return { error: `Aucune demande de paiement « ${q} ».` } as const;
  const exact = rows.filter((r) => r.reference.toLowerCase() === q.toLowerCase());
  if (exact.length === 1) return exact[0];
  if (rows.length === 1) return rows[0];
  return { error: `Plusieurs demandes correspondent à « ${q} » : ${rows.map((r) => `${r.reference} — ${r.title} (${dzd(toNumber(r.amount))})`).join(" ; ")} — donner la référence exacte.` } as const;
}

/** Une pièce d'une demande de paiement, par le nom de son document. */
async function resolvePiece(requestId: string, reference: string, raw: string) {
  const pieces = await prisma.paymentPiece.findMany({
    where: { requestId },
    select: { id: true, status: true, documentId: true, note: true },
    orderBy: { position: "asc" },
  });
  if (pieces.length === 0) return { error: `Le dossier ${reference} n'a aucune pièce.` } as const;
  const docs = await prisma.document.findMany({
    where: { id: { in: pieces.map((p) => p.documentId) } }, select: { id: true, name: true },
  });
  const nameOf = new Map(docs.map((d) => [d.id, d.name] as const));
  const labeled = pieces.map((p) => ({ ...p, name: nameOf.get(p.documentId) ?? "(sans nom)" }));
  const q = raw.trim().toLowerCase();
  if (!q) {
    if (labeled.length === 1) return labeled[0];
    return { error: `Précisez la pièce (champ « piece ») parmi : ${labeled.map((p) => p.name).join(", ")}.` } as const;
  }
  const hits = labeled.filter((p) => p.name.toLowerCase().includes(q));
  if (hits.length === 1) return hits[0];
  if (hits.length === 0) return { error: `Aucune pièce « ${raw} » dans ${reference} — pièces : ${labeled.map((p) => p.name).join(", ")}.` } as const;
  return { error: `Plusieurs pièces correspondent à « ${raw} » : ${hits.map((p) => p.name).join(", ")} — préciser.` } as const;
}

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

// ── Normalisations FR → énumérations (liste blanche, jamais du texte libre). ──

const MOVE_STEPS: [RegExp, PaymentMove, string][] = [
  [/instrui|examen|examin|review|charge/i, "REVIEW", "Prendre en instruction"],
  [/attente|suspend|hold|gele|gèle/i, "HOLD", "Mettre en attente"],
  [/repren|resume|relanc/i, "RESUME", "Reprendre l'instruction"],
  [/renvoi|revoir|correction|change/i, "REQUEST_CHANGES", "Renvoyer pour corrections"],
  [/refus|rejet/i, "REJECT", "Refuser"],
  [/approuv|accord|bon [àa] payer|\bpayer\b|valide/i, "APPROVE", "Bon à payer"],
];

function moveOf(raw: string): { move: PaymentMove; label: string } | null {
  const up = raw.toUpperCase().trim();
  const direct = MOVE_STEPS.find(([, m]) => m === up);
  if (direct) return { move: direct[1], label: direct[2] };
  const hit = MOVE_STEPS.find(([re]) => re.test(raw));
  return hit ? { move: hit[1], label: hit[2] } : null;
}

function urgencyOf(raw: string): { code: string; label: string } {
  const k = raw.toLowerCase();
  if (/urgent/.test(k)) return { code: "URGENT", label: "Urgent" };
  if (/semaine|week/.test(k)) return { code: "THIS_WEEK", label: "Cette semaine" };
  if (/mois|month/.test(k)) return { code: "THIS_MONTH", label: "Ce mois-ci" };
  return { code: "WHEN_POSSIBLE", label: "Quand possible" };
}

/**
 * CE QUE LA PERSONNE DIT DE SON ÉCHÉANCE, ramené aux trois natures.
 *
 * On ne reconnaît QUE ce dont on est sûr, et `deadlineNatureOf` retombe sur « moyenne » pour tout
 * le reste : deviner « non négociable » derrière une phrase ambiguë ferait passer une demande
 * devant les autres sur un malentendu.
 */
function natureCodeOf(raw: string): string {
  const k = raw.toLowerCase();
  if (/fixe|non n[ée]gociable|imp[ée]rative|ferme|FIXED/i.test(k)) return "FIXED";
  if (/importante|prioritaire|IMPORTANT/i.test(k)) return "IMPORTANT";
  if (/moyenne|souple|indicative|MODERATE/i.test(k)) return "MODERATE";
  return raw;
}

/** Ce qu'on ÉCRIT dans la proposition. Une nature non reconnue n'est simplement pas affichée. */
const NATURE_FR: Record<string, string> = {
  FIXED: "Fixe, non négociable", IMPORTANT: "Importante", MODERATE: "Moyenne",
};

const VERDICT_FR: Record<string, string> = { ACCEPTED: "Acceptée", CHANGES_REQUESTED: "À revoir", REJECTED: "Refusée", PENDING: "Remise en attente" };

function verdictOf(raw: string): string | null {
  const up = raw.toUpperCase().trim();
  if (VERDICT_FR[up]) return up;
  const k = raw.toLowerCase();
  if (/accept|valide|conforme|ok/.test(k)) return "ACCEPTED";
  if (/revoir|corrig|change|reprend/.test(k)) return "CHANGES_REQUESTED";
  if (/refus|rejet/.test(k)) return "REJECTED";
  if (/attente|pending|neutre/.test(k)) return "PENDING";
  return null;
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

export const FINANCE_FLOWS_OPS_IMPL: Record<string, OpImpl> = {
  // ─────────────── Caisse d'avance ───────────────

  allot_petty_cash: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const dept = await resolveDept(opStr(input, "department"));
      if ("error" in dept) return dept;
      const amount = num(input, "amount");
      if (amount === null || amount <= 0) return { error: "Précisez la somme remise (champ « amount »)." };
      const period = periodOf(opStr(input, "period"));
      if (typeof period !== "string") return period;
      // LA CAISSE EST CONTINUE : la remise s'AJOUTE au fond, elle ne rallonge pas « le mois » et
      // n'en ouvre pas un nouveau. Le détenteur se reprend donc du fond en cours (ou du réglage
      // mensuel) : le redemander à chaque remise pour une personne qui n'a pas changé serait un
      // aller-retour de plus à chaque fois.
      const ouvertes = await prisma.pettyCashAllotment.findMany({
        where: { departmentId: dept.id, status: { not: "CLOSED" } },
        select: { holderId: true }, orderBy: { createdAt: "desc" },
      });
      let holderId: string | null = null;
      let holderName: string | null = null;
      const holderRaw = opStr(input, "holder");
      if (holderRaw) {
        const holder = await resolvePerson(holderRaw);
        if ("error" in holder) return holder;
        holderId = holder.id; holderName = holder.name;
      } else {
        const connu = ouvertes.find((r) => r.holderId)?.holderId
          ?? (await prisma.pettyCashPlan.findUnique({ where: { departmentId: dept.id }, select: { holderId: true } }))?.holderId
          ?? null;
        if (!connu) return { error: "Précisez à qui la somme est remise (champ « holder ») — personne ne détient encore cette caisse." };
        holderName = (await prisma.user.findUnique({ where: { id: connu }, select: { name: true } }))?.name ?? null;
      }
      return {
        title: `Remettre ${dzd(amount)} à la caisse de ${dept.name}`,
        fields: fieldsOf([
          ["Département", dept.name], ["Période enregistrée", period],
          ["Somme remise", dzd(amount)],
          ["Remises déjà en cours", ouvertes.length > 0 ? `${ouvertes.length}` : "aucune"],
          ["Détenteur·rice", holderName], ["Note", opStr(input, "note") || null],
        ]),
        warnings: [
          "La remise part d'abord au CENTRE DE PAIEMENT : rien ne sort de la banque avant son autorisation et le versement par les Finances.",
          "Une fois versée, elle S'AJOUTE au fond (aucune remise antérieure n'est close) et la personne détentrice confirme alors la réception.",
        ],
        args: { departmentId: dept.id, holderId, period, amount: String(amount), note: opStr(input, "note") || null },
        successMessage: `Remise de ${dzd(amount)} pour la caisse de ${dept.name} envoyée au centre de paiement.`,
        link: "/moyens-generaux", revalidate: ["/moyens-generaux"],
      };
    },
    execute: (args) => runFd(allotPettyCash, args, "La remise de caisse a été refusée.", { revalidate: ["/moyens-generaux"] }),
  },

  confirm_petty_cash_receipt: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const cash = await resolveCash(opStr(input, "department"), opStr(input, "period"), ["ALLOTTED"]);
      if ("error" in cash) return cash;
      if (cash.count > 1) {
        return { error: `${cash.count} remises attendent une confirmation chez ${cash.deptName} — précisez laquelle par sa période (champ « period »).` };
      }
      return {
        title: `Confirmer la réception d'une remise en caisse — ${cash.deptName}`,
        fields: fieldsOf([
          ["Département", cash.deptName],
          ["Somme remise", dzd(cash.amount)],
          ["Période enregistrée", cash.period],
          ["Détenteur·rice", cash.holderName],
        ]),
        warnings: ["Seule la personne détentrice (ou la Direction) confirme, et seulement une fois la remise VERSÉE (centre de paiement puis Finances) — l'action refusera sinon. La somme devient alors dépensable."],
        args: { id: cash.id },
        successMessage: `Réception confirmée — la somme est en main chez ${cash.deptName}.`,
        revalidate: ["/moyens-generaux"],
      };
    },
    execute: (args) => runFd(confirmPettyCashReceipt, args, "La confirmation a été refusée.", { revalidate: ["/moyens-generaux"] }),
  },

  close_petty_cash: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const cash = await resolveCash(opStr(input, "department"), opStr(input, "period"), ["ALLOTTED", "RECEIVED"]);
      if ("error" in cash) return cash;
      return {
        title: `Solder la caisse d'avance — ${cash.deptName}`,
        fields: fieldsOf([
          ["Département", cash.deptName],
          ["Remises en cours", `${cash.openCount}`],
        ]),
        warnings: [
          `Le fond ENTIER est arrêté d'un bloc : les ${cash.openCount} remise(s) en cours passent en soldé.`,
          "Le reliquat n'est plus disponible. Les dépenses déjà imputées restent.",
        ],
        args: { id: cash.id },
        successMessage: `Caisse d'avance de ${cash.deptName} soldée.`,
        revalidate: ["/moyens-generaux"],
      };
    },
    execute: (args) => runFd(closePettyCash, args, "La clôture a été refusée.", { revalidate: ["/moyens-generaux"] }),
  },

  request_petty_cash_topup: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const cash = await resolveCash(opStr(input, "department"), opStr(input, "period"), ["RECEIVED", "ALLOTTED"]);
      if ("error" in cash) return cash;
      const amount = num(input, "amount");
      if (amount === null || amount <= 0) return { error: "Précisez le montant demandé (champ « amount »)." };
      return {
        title: `Demander une rallonge de ${dzd(amount)} — caisse de ${cash.deptName}`,
        fields: fieldsOf([
          ["Département", cash.deptName],
          ["Montant demandé", dzd(amount)],
          ["Motif", opStr(input, "reason") || null],
        ]),
        args: { cashId: cash.id, amount: String(amount), reason: opStr(input, "reason") || null },
        successMessage: `Rallonge de ${dzd(amount)} demandée pour ${cash.deptName} — à trancher par l'administration.`,
        revalidate: ["/moyens-generaux"],
      };
    },
    execute: (args) => runFd(requestPettyCashTopUp, args, "La demande de rallonge a été refusée.", { revalidate: ["/moyens-generaux"] }),
  },

  set_petty_cash_plan: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const dept = await resolveDept(opStr(input, "department"));
      if ("error" in dept) return dept;
      // FUSION avec le plan existant : l'action REMPLACE le réglage entier — un montant corrigé
      // sans redonner le jour ou la détentrice ne doit pas les effacer.
      const existing = await prisma.pettyCashPlan.findUnique({
        where: { departmentId: dept.id },
        select: { monthlyAmount: true, rechargeDay: true, holderId: true, isActive: true, holder: { select: { name: true } } },
      });
      const amount = num(input, "amount") ?? (existing ? toNumber(existing.monthlyAmount) : null);
      if (amount === null || amount < 0) return { error: "Précisez le montant mensuel (champ « amount »)." };
      const day = num(input, "day") ?? existing?.rechargeDay ?? null;
      const holderRaw = opStr(input, "holder");
      let holderId: string | null = existing?.holderId ?? null;
      let holderName: string | null = existing?.holder?.name ?? null;
      if (holderRaw) {
        const holder = await resolvePerson(holderRaw);
        if ("error" in holder) return holder;
        holderId = holder.id; holderName = holder.name;
      }
      const activeRaw = opStr(input, "active");
      const inactive = activeRaw
        ? /^(0|non|inactif|inactive|d[ée]sactiv|off|stop)/i.test(activeRaw)
        : existing ? !existing.isActive : false;
      return {
        title: `Régler la caisse mensuelle de ${dept.name} : ${dzd(amount)}${day ? ` le ${day} du mois` : ""}`,
        fields: fieldsOf([
          ["Département", dept.name], ["Montant mensuel", dzd(amount)],
          ["Jour de rechargement", day ? String(Math.min(28, Math.max(1, day))) : null],
          ["Détenteur·rice", holderName], ["État", inactive ? "Désactivée" : "Active"],
        ]),
        warnings: ["Un rappel part aux RH 48 h avant chaque rechargement tant que le réglage est actif."],
        args: { departmentId: dept.id, monthlyAmount: String(amount), rechargeDay: day ? String(day) : null, holderId, isActive: inactive ? "0" : "1" },
        successMessage: `Caisse mensuelle de ${dept.name} réglée (${dzd(amount)}).`,
        revalidate: ["/moyens-generaux"],
      };
    },
    execute: (args) => runFd(setPettyCashPlan, args, "Le réglage de la caisse mensuelle a été refusé.", { revalidate: ["/moyens-generaux"] }),
  },

  // ─────────────── Ordres de dépense — facture & révision budget ───────────────

  request_expense_invoice: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const order = await resolveOrder(opStr(input, "reference") || opStr(input, "label"));
      if ("error" in order) return order;
      return {
        title: `Demander la facture de l'ordre ${order.reference}`,
        fields: [
          { label: "Ordre", value: `${order.reference} — ${order.label} (${dzd(toNumber(order.amount))})` },
          ...(order.beneficiary ? [{ label: "Bénéficiaire", value: order.beneficiary }] : []),
        ],
        args: { id: order.id },
        successMessage: `Facture demandée au porteur de l'ordre ${order.reference}.`,
        revalidate: ["/finances/paiements-a-faire"],
      };
    },
    execute: (args) => runFd(requestInvoice, args, "La demande de facture a été refusée.", { revalidate: ["/finances/paiements-a-faire"] }),
  },

  /**
   * REPORTER UN PAIEMENT — le seul geste, avec le règlement, qui reste au décaissement.
   *
   * Les deux ops qui vivaient ici (`request_budget_revision`, `resolve_budget_revision`) ont
   * disparu AVEC leurs actions serveur : l'ordre arrive autorisé par le centre de paiement, et
   * rouvrir le montant à la caisse revenait à défaire une décision prise ailleurs. Les retirer de
   * l'écran sans les retirer d'ici aurait laissé à l'assistant une porte que l'écran refuse
   * (§118-7 : une mission n'est jamais une porte dérobée).
   */
  defer_payment: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const order = await resolveOrder(opStr(input, "reference") || opStr(input, "label"), ["PENDING"]);
      if ("error" in order) return order;
      // ON VÉRIFIE QU'UN ARGUMENT A ÉTÉ DONNÉ — pas que la règle est satisfaite.
      //
      // La règle (« la date doit être à venir », « un motif est exigé sur une échéance fixe »)
      // vit dans `checkDeferral`, côté Finances, et l'action l'applique. La rejouer ici la
      // dédoublerait : deux copies d'une même règle finissent par diverger, et c'est la copie
      // affichée qui ment. Adam propose, l'action tranche — et son refus remonte tel quel.
      const until = isoDate(opStr(input, "date") || opStr(input, "until"));
      if (!until) return { error: "Précisez la date à laquelle le paiement est reporté (champ « date »)." };
      const reason = opStr(input, "reason") || opStr(input, "note");
      return {
        title: `Reporter le paiement de l'ordre ${order.reference}`,
        fields: fieldsOf([
          ["Ordre", `${order.reference} — ${order.label} (${dzd(toNumber(order.amount))})`],
          ["Reporté au", until],
          ["Motif", reason || null],
        ]),
        warnings: [
          "L'ordre reste dû et reste dans la file : il est daté, pas classé. Il redevient « non payé » tout seul à l'échéance du report, et le demandeur en est averti.",
          "La date doit être à venir ; si le demandeur a déclaré son échéance FIXE et non négociable, un motif est exigé — sans quoi le report sera refusé.",
        ],
        args: { id: order.id, until, reason: reason || null },
        successMessage: `Paiement de ${order.reference} reporté.`,
        revalidate: ["/finances/paiements-a-faire", "/finances"],
      };
    },
    execute: (args) => runFd(deferExpenseOrder, args, "Le report a été refusé.", { revalidate: ["/finances/paiements-a-faire", "/finances"] }),
  },

  resume_payment: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const order = await resolveOrder(opStr(input, "reference") || opStr(input, "label"), ["PENDING"]);
      if ("error" in order) return order;
      if (!order.deferredUntil) return { error: `Le paiement de ${order.reference} n'est pas reporté.` };
      return {
        title: `Lever le report — ordre ${order.reference}`,
        fields: fieldsOf([
          ["Ordre", `${order.reference} — ${order.label} (${dzd(toNumber(order.amount))})`],
          ["Report en cours", order.deferredUntil.toLocaleDateString("fr-FR")],
        ]),
        warnings: ["L'ordre redevient simplement « non payé » — l'état par défaut."],
        args: { id: order.id },
        successMessage: `Report levé sur ${order.reference}.`,
        revalidate: ["/finances/paiements-a-faire", "/finances"],
      };
    },
    execute: (args) => runFd(resumeExpenseOrder, args, "La levée du report a été refusée.", { revalidate: ["/finances/paiements-a-faire", "/finances"] }),
  },

  // ─────────────── Demandes de paiement ───────────────

  /**
   * UNE DEMANDE DE PAIEMENT NE SE TRANSMET PAS DEPUIS LA CONVERSATION.
   *
   * Deux raisons, et elles tiennent toutes les deux à la même chose — ce que l'assistant ne peut
   * pas faire à la place d'une personne (§118-15) :
   *
   *   • une demande transmise doit porter un BON DE COMMANDE ou une FACTURE, et l'assistant n'a
   *     pas de fichier à joindre ; la transmettre échouerait à coup sûr, ou pire, exigerait de
   *     contourner la règle ;
   *   • cocher « le moyen de paiement figure sur le document » est une ATTESTATION : elle engage
   *     celui qui a la pièce sous les yeux. Un modèle ne peut pas attester d'un document qu'il
   *     n'a pas lu, et l'audit portera pourtant le nom d'une personne.
   *
   * L'op ouvre donc un BROUILLON, toujours — la personne y joint sa pièce, coche la case et
   * transmet depuis l'écran.
   */
  create_payment_request: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const title = opStr(input, "label") || opStr(input, "title");
      const payee = opStr(input, "payee");
      const amount = num(input, "amount");
      if (!title) return { error: "Précisez l'objet du paiement (champ « label »)." };
      if (!payee) return { error: "Précisez le bénéficiaire — à qui l'argent doit aller (champ « payee »)." };
      if (amount === null || amount <= 0) return { error: "Précisez le montant à payer (champ « amount »)." };
      const urgency = urgencyOf(opStr(input, "urgency"));
      const dueDate = isoDate(opStr(input, "dueDate"));
      // La chaîne part telle quelle : `deadlineNatureOf`, côté Finances, est seul juge de ce
      // qu'elle vaut — et retombe sur « moyenne » pour tout ce qu'il ne reconnaît pas.
      const nature = natureCodeOf(opStr(input, "deadlineNature") || opStr(input, "deadline"));
      return {
        title: `Demande de paiement (brouillon) — ${payee} · ${dzd(amount)}`,
        fields: fieldsOf([
          ["Objet", title], ["Bénéficiaire", payee], ["Montant", dzd(amount)],
          ["Échéance", dueDate], ["Nature de l'échéance", dueDate ? NATURE_FR[nature] ?? null : null],
          ["Urgence", dueDate ? null : urgency.label],
          ["Contact chez le bénéficiaire", opStr(input, "contactName") || null],
          ["Téléphone", opStr(input, "contactPhone") || null],
          ["Description", opStr(input, "description") || null],
        ]),
        warnings: [
          "BROUILLON : joignez le bon de commande ou la facture depuis le dossier, cochez que le moyen de paiement y figure, puis transmettez. Ces deux gestes engagent celui qui a la pièce sous les yeux — ils ne se délèguent pas.",
        ],
        args: {
          title, payee, amount: String(amount), description: opStr(input, "description") || null,
          dueDate, urgency: urgency.code, deadlineNature: nature, submit: "0",
          contactName: opStr(input, "contactName") || null,
          contactPhone: opStr(input, "contactPhone") || null,
          contactEmail: opStr(input, "contactEmail") || null,
        },
        successMessage: `Brouillon de demande de paiement créé (${payee}, ${dzd(amount)}) — joignez la pièce et transmettez depuis le dossier.`,
        link: "/validations/paiements", revalidate: ["/validations", "/validations/paiements"],
      };
    },
    execute: (args) => runFd2(createPaymentRequest, args, "La demande de paiement a été refusée.", { link: "/validations/paiements", revalidate: ["/validations", "/validations/paiements"] }),
  },

  /** Le contact du bénéficiaire — le seul champ de la demande qu'un modèle peut remplir seul. */
  update_payment_contact: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const req = await resolvePayment(opStr(input, "reference") || opStr(input, "label"));
      if ("error" in req) return req;
      const name = opStr(input, "contactName") || opStr(input, "contact");
      const phone = opStr(input, "contactPhone") || opStr(input, "phone");
      const email = opStr(input, "contactEmail") || opStr(input, "email");
      if (!name && !phone && !email) return { error: "Donnez au moins un élément de contact : nom, téléphone ou e-mail." };
      return {
        title: `Contact du bénéficiaire — ${req.reference}`,
        fields: fieldsOf([
          ["Dossier", `${req.reference} — ${req.title} (${req.payee})`],
          ["Nom", name || null], ["Téléphone", phone || null], ["E-mail", email || null],
        ]),
        // L'action REMPLACE les trois champs : on rejoue ceux qu'on ne change pas, sinon donner
        // un téléphone effacerait le nom déjà saisi.
        args: {
          id: req.id,
          contactName: name || req.contactName || null,
          contactPhone: phone || req.contactPhone || null,
          contactEmail: email || req.contactEmail || null,
          paymentMethodStated: req.paymentMethodStated ? "1" : null,
        },
        successMessage: `Contact enregistré sur ${req.reference}.`,
        link: "/validations/paiements", revalidate: ["/validations", "/validations/paiements"],
      };
    },
    execute: (args) => runFd(updatePaymentRequestDetails, args, "Les précisions ont été refusées.", { revalidate: ["/validations", "/validations/paiements"] }),
  },

  submit_payment_request: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const req = await resolvePayment(opStr(input, "reference") || opStr(input, "label"));
      if ("error" in req) return req;
      return {
        title: `Transmettre ${req.reference} aux Finances`,
        fields: [
          { label: "Dossier", value: `${req.reference} — ${req.title} (${dzd(toNumber(req.amount))})` },
          { label: "Bénéficiaire", value: req.payee },
        ],
        args: { id: req.id, note: opStr(input, "note") || null },
        successMessage: `Dossier ${req.reference} transmis aux Finances.`,
        link: "/validations/paiements", revalidate: ["/validations", "/validations/paiements"],
      };
    },
    execute: (args) => runFd(submitPaymentRequest, args, "La transmission a été refusée.", { revalidate: ["/validations", "/validations/paiements"] }),
  },

  decide_payment_request: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const req = await resolvePayment(opStr(input, "reference") || opStr(input, "label"));
      if ("error" in req) return req;
      const mv = moveOf(opStr(input, "decision"));
      if (!mv) return { error: "Précisez le geste (champ « decision ») : instruire | mettre en attente | reprendre | renvoyer pour corrections | bon à payer | refuser." };
      const note = opStr(input, "note");
      if (mv.move === "HOLD" && !note) return { error: "Une mise en attente se motive (champ « note ») — le demandeur doit savoir pourquoi." };
      if (mv.move === "REJECT" && !note) return { error: "Un refus se motive (champ « note ») — c'est ce que lira le demandeur." };
      return {
        title: `${mv.label} — ${req.reference} (${dzd(toNumber(req.amount))})`,
        fields: fieldsOf([
          ["Dossier", `${req.reference} — ${req.title}`],
          ["Bénéficiaire", req.payee],
          ["Geste", mv.label],
          ["Motif / note", note || null],
        ]),
        warnings: mv.move === "APPROVE"
          ? ["BON À PAYER : le paiement passe par le Centre de paiement, qui l'autorise quel que soit son montant ; les Finances le règlent ensuite. Toutes les pièces doivent être acceptées."]
          : mv.move === "REJECT" ? ["Le dossier est clos sur ce refus ; le demandeur est notifié."] : [],
        args: { id: req.id, move: mv.move, note: note || null },
        successMessage: `${mv.label} — ${req.reference}.`,
        link: "/validations/paiements", revalidate: ["/validations", "/validations/paiements", "/centre-paiement"],
      };
    },
    execute: (args) => runFd(decidePaymentRequest, args, "La décision a été refusée.", { revalidate: ["/validations", "/validations/paiements", "/centre-paiement"] }),
  },

  cancel_payment_request: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const req = await resolvePayment(opStr(input, "reference") || opStr(input, "label"));
      if ("error" in req) return req;
      return {
        title: `Retirer la demande de paiement ${req.reference}`,
        fields: [{ label: "Dossier", value: `${req.reference} — ${req.title} (${dzd(toNumber(req.amount))})` }],
        warnings: ["Le dossier est clos sans paiement ; les Finances sont prévenues s'il était chez elles."],
        args: { id: req.id, note: opStr(input, "note") || null },
        successMessage: `Demande ${req.reference} retirée.`,
        revalidate: ["/validations", "/validations/paiements"],
      };
    },
    execute: (args) => runFd(cancelPaymentRequest, args, "Le retrait a été refusé.", { revalidate: ["/validations", "/validations/paiements"] }),
  },

  add_payment_comment: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const req = await resolvePayment(opStr(input, "reference") || opStr(input, "label"));
      if ("error" in req) return req;
      const message = opStr(input, "message") || opStr(input, "note");
      if (!message) return { error: "Écrivez le message (champ « message »)." };
      return {
        title: `Message dans le dossier ${req.reference}`,
        fields: [
          { label: "Dossier", value: `${req.reference} — ${req.title}` },
          { label: "Message", value: message },
        ],
        args: { requestId: req.id, message },
        successMessage: `Message ajouté au dossier ${req.reference}.`,
        revalidate: ["/validations/paiements"],
      };
    },
    execute: (args) => runFd(addPaymentComment, args, "Le message a été refusé.", { revalidate: ["/validations/paiements"] }),
  },

  /**
   * PLUS DE DEMANDE DE VALIDATION SUR UN PAIEMENT — ni sur le dossier, ni sur une pièce.
   *
   * `ask_payment_validation` et `ask_piece_validation` vivaient ici. Elles n'ont plus d'objet : un
   * dossier n'arrive aux Finances QU'AUTORISÉ par le centre de paiement, et faire valider ce qui
   * vient d'être validé n'aboutit nulle part. Elles ont été supprimées à l'écran ET ici — un geste
   * que l'écran ne propose plus mais que l'assistant peut encore poser est une porte dérobée
   * (§118-7). Ce qui reste : réclamer une PIÈCE, qui n'est pas une décision.
   */

  comment_payment_piece: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const req = await resolvePayment(opStr(input, "reference") || opStr(input, "label"));
      if ("error" in req) return req;
      const piece = await resolvePiece(req.id, req.reference, opStr(input, "piece"));
      if ("error" in piece) return piece;
      const note = opStr(input, "note") || opStr(input, "message");
      if (!note) return { error: "Écrivez le commentaire de la pièce (champ « note »)." };
      return {
        title: `Commenter la pièce « ${piece.name} » (${req.reference})`,
        fields: [
          { label: "Pièce", value: piece.name },
          { label: "Commentaire", value: note },
        ],
        args: { pieceId: piece.id, note },
        successMessage: `Commentaire posé sur « ${piece.name} ».`,
        revalidate: ["/validations/paiements"],
      };
    },
    execute: (args) => runFd(commentPaymentPiece, args, "Le commentaire a été refusé.", { revalidate: ["/validations/paiements"] }),
  },

  review_payment_piece: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const req = await resolvePayment(opStr(input, "reference") || opStr(input, "label"));
      if ("error" in req) return req;
      const piece = await resolvePiece(req.id, req.reference, opStr(input, "piece"));
      if ("error" in piece) return piece;
      const verdict = verdictOf(opStr(input, "verdict") || opStr(input, "decision"));
      if (!verdict) return { error: "Précisez le verdict (champ « verdict ») : accepter | à revoir | refuser." };
      const note = opStr(input, "note");
      if ((verdict === "CHANGES_REQUESTED" || verdict === "REJECTED") && !note) {
        return { error: "Dites ce qui ne va pas (champ « note ») — sans motif, la pièce reviendra identique." };
      }
      return {
        title: `${VERDICT_FR[verdict]} — pièce « ${piece.name} » (${req.reference})`,
        fields: fieldsOf([
          ["Dossier", `${req.reference} — ${req.title}`],
          ["Pièce", piece.name],
          ["Verdict", VERDICT_FR[verdict]],
          ["Motif", note || null],
        ]),
        warnings: verdict === "CHANGES_REQUESTED" || verdict === "REJECTED"
          ? ["Le dossier repasse automatiquement chez le demandeur si une pièce est mise en cause."] : [],
        args: { pieceId: piece.id, verdict, note: note || null },
        successMessage: `Pièce « ${piece.name} » : ${VERDICT_FR[verdict].toLowerCase()}.`,
        revalidate: ["/validations/paiements"],
      };
    },
    execute: (args) => runFd(reviewPaymentPiece, args, "Le verdict a été refusé.", { revalidate: ["/validations/paiements"] }),
  },

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
