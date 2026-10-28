/**
 * OPS FLUX FINANCIERS — CAISSE D'AVANCE (dotation, réception, clôture, réassort, plan) et ORDRES
 * DE DÉPENSE (facture demandée, paiement différé / repris), par les actions canoniques.
 */
import { prisma } from "./erp";
import { toNumber } from "@/lib/utils";
import { allotPettyCash, confirmPettyCashReceipt, closePettyCash, requestPettyCashTopUp, setPettyCashPlan } from "@/lib/actions/petty-cash-actions";
import { requestInvoice, deferExpenseOrder, resumeExpenseOrder } from "@/lib/actions/expense-actions";
import type { OpImpl, OpProposalDraft } from "../../types";
import { opStr } from "../../types";
import { runFd, dzd, fieldsOf, resolveOne, monthOf, isoDate } from "../../helpers";
import { num, resolveOrder } from "./commun";

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

export const CAISSE_DEPENSES_OPS_IMPL: Record<string, OpImpl> = {
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
};
