import { prisma } from "@/lib/prisma";
import { HR_REQUEST_TYPE, LEAVE_TYPE } from "@/lib/labels";
import { toNumber, montantDzd } from "@/lib/utils";
import {
  decideLeave, cancelLeave, decideAdvance, setEmployeeActive,
} from "@/modules/rh/actions";
import { processHrRequest, decideExpenseReport } from "@/modules/rh/actions-documents";
import { decideTraining } from "@/lib/actions/training-actions";
import { decideRecruitmentStep } from "@/lib/actions/recruitment-actions";
import type { OpImpl, OpProposalDraft } from "./types";
import { opStr } from "./types";

/**
 * OPS RH — les DÉCISIONS des circuits (congés, avances, notes de frais, demandes RH,
 * formations, recrutement) et la fiche employé (actif/inactif), par les ACTIONS CANONIQUES.
 * Les chaînes de validateurs (N+1 → RH → direction, chaîne de recrutement) restent LE moteur :
 * ici on résout la cible et on montre où elle en est — l'autorité se vérifie à l'exécution.
 */

const day = (d: Date | null): string => (d ? d.toISOString().slice(0, 10) : "—");

const decisionOf = (raw: string): "APPROVED" | "REJECTED" | null => {
  const k = raw.toLowerCase();
  if (/accord|approuv|valide|oui|ok/.test(k)) return "APPROVED";
  if (/refus|rejet|non/.test(k)) return "REJECTED";
  return null;
};

async function resolveEmployee(raw: string): Promise<{ id: string; fullName: string; isActive: boolean } | { error: string }> {
  const q = raw.trim();
  if (!q) return { error: "Précisez le nom de l'employé (champ « employee »)." };
  const rows = await prisma.employee.findMany({
    where: { fullName: { contains: q, mode: "insensitive" } },
    select: { id: true, fullName: true, isActive: true },
    take: 4,
  });
  if (rows.length === 1) return rows[0];
  if (rows.length === 0) return { error: `Aucun employé « ${q} » au registre RH.` };
  return { error: `Plusieurs employés correspondent à « ${q} » : ${rows.map((r) => r.fullName).join(", ")} — préciser.` };
}

export const HR_OPS_IMPL: Record<string, OpImpl> = {
  decide_leave: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const decision = decisionOf(opStr(input, "decision"));
      if (!decision) return { error: "Précisez la décision : approuver ou refuser (champ « decision »)." };
      const q = opStr(input, "employee");
      const rows = await prisma.leaveRequest.findMany({
        where: {
          status: "PENDING",
          ...(q ? { employee: { fullName: { contains: q, mode: "insensitive" } } } : {}),
        },
        include: { employee: { select: { fullName: true } } },
        orderBy: { createdAt: "desc" },
        take: 6,
      });
      if (rows.length === 0) return { error: `Aucune demande de congé EN ATTENTE${q ? ` pour « ${q} »` : ""}.` };
      if (rows.length > 1) {
        return { error: `Plusieurs congés en attente : ${rows.map((r) => `${r.employee.fullName} (${day(r.startDate)} → ${day(r.endDate)})`).join(" ; ")} — préciser l'employé.` };
      }
      const leave = rows[0];
      return {
        title: `${decision === "APPROVED" ? "Approuver" : "Refuser"} le congé de ${leave.employee.fullName}`,
        fields: [
          { label: "Employé", value: leave.employee.fullName },
          { label: "Congé", value: `${LEAVE_TYPE[leave.type] ?? leave.type} — ${day(leave.startDate)} → ${day(leave.endDate)} (${toNumber(leave.days)} j)` },
          { label: "Décision", value: decision === "APPROVED" ? "Approuvé" : "Refusé" },
        ],
        warnings: ["Le CIRCUIT congés décide qui signe cette marche (N+1 → RH → direction) : si ce n'est pas votre tour, l'exécution refusera en le disant. Le demandeur est notifié."],
        args: { id: leave.id, decision, note: opStr(input, "note"), employee: leave.employee.fullName },
        successMessage: `Congé de ${leave.employee.fullName} : ${decision === "APPROVED" ? "marche approuvée" : "refusé"}.`,
        link: "/rh",
        revalidate: ["/rh"],
      };
    },
    async execute(args) {
      const fd = new FormData();
      fd.set("id", args.id ?? "");
      fd.set("decision", args.decision ?? "");
      if (args.note) fd.set("note", args.note);
      const r = await decideLeave(fd);
      if (!r.ok) return { ok: false, error: r.error ?? "La décision sur le congé a été refusée." };
      return { ok: true, revalidate: ["/rh"] };
    },
  },

  cancel_leave: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const q = opStr(input, "employee");
      const rows = await prisma.leaveRequest.findMany({
        where: {
          status: { in: ["PENDING", "APPROVED"] },
          ...(q ? { employee: { fullName: { contains: q, mode: "insensitive" } } } : {}),
        },
        include: { employee: { select: { fullName: true } } },
        orderBy: { createdAt: "desc" },
        take: 6,
      });
      if (rows.length === 0) return { error: `Aucun congé annulable${q ? ` pour « ${q} »` : ""}.` };
      if (rows.length > 1) {
        return { error: `Plusieurs congés annulables : ${rows.map((r) => `${r.employee.fullName} (${day(r.startDate)} → ${day(r.endDate)}, ${r.status === "APPROVED" ? "accordé" : "en attente"})`).join(" ; ")} — préciser.` };
      }
      const leave = rows[0];
      return {
        title: `Annuler le congé de ${leave.employee.fullName}`,
        fields: [
          { label: "Employé", value: leave.employee.fullName },
          { label: "Congé", value: `${day(leave.startDate)} → ${day(leave.endDate)} (${leave.status === "APPROVED" ? "accordé" : "en attente"})` },
        ],
        warnings: ["Si le congé était accordé, les jours décomptés reviennent au solde."],
        args: { id: leave.id, employee: leave.employee.fullName },
        successMessage: `Congé de ${leave.employee.fullName} annulé.`,
        link: "/rh",
        revalidate: ["/rh"],
      };
    },
    async execute(args) {
      const fd = new FormData();
      fd.set("id", args.id ?? "");
      const r = await cancelLeave(fd);
      if (!r.ok) return { ok: false, error: r.error ?? "L'annulation du congé a été refusée." };
      return { ok: true, revalidate: ["/rh"] };
    },
  },

  decide_advance: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const decision = decisionOf(opStr(input, "decision"));
      if (!decision) return { error: "Précisez la décision : accorder ou refuser (champ « decision »)." };
      const q = opStr(input, "employee");
      const rows = await prisma.salaryAdvance.findMany({
        where: {
          status: "PENDING",
          ...(q ? { employee: { fullName: { contains: q, mode: "insensitive" } } } : {}),
        },
        include: { employee: { select: { fullName: true } } },
        orderBy: { createdAt: "desc" },
        take: 6,
      });
      if (rows.length === 0) return { error: `Aucune avance sur salaire EN ATTENTE${q ? ` pour « ${q} »` : ""}.` };
      if (rows.length > 1) {
        return { error: `Plusieurs avances en attente : ${rows.map((r) => `${r.employee.fullName} (${montantDzd(toNumber(r.amount))})`).join(" ; ")} — préciser l'employé.` };
      }
      const adv = rows[0];
      return {
        title: `${decision === "APPROVED" ? "Accorder" : "Refuser"} l'avance de ${adv.employee.fullName} (${montantDzd(toNumber(adv.amount))})`,
        fields: [
          { label: "Employé", value: adv.employee.fullName },
          { label: "Montant", value: montantDzd(toNumber(adv.amount)) },
          ...(adv.reason ? [{ label: "Motif", value: adv.reason }] : []),
          { label: "Décision", value: decision === "APPROVED" ? "Accordée" : "Refusée" },
        ],
        warnings: decision === "APPROVED" ? ["Le versement suivra le circuit Finances — rien n'est décaissé ici."] : [],
        args: { id: adv.id, decision, note: opStr(input, "note"), employee: adv.employee.fullName },
        successMessage: `Avance de ${adv.employee.fullName} ${decision === "APPROVED" ? "accordée" : "refusée"}.`,
        link: "/rh",
        revalidate: ["/rh"],
      };
    },
    async execute(args) {
      const fd = new FormData();
      fd.set("id", args.id ?? "");
      fd.set("decision", args.decision ?? "");
      if (args.note) fd.set("note", args.note);
      const r = await decideAdvance(fd);
      if (!r.ok) return { ok: false, error: r.error ?? "La décision sur l'avance a été refusée." };
      return { ok: true, revalidate: ["/rh"] };
    },
  },

  set_employee_active: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const emp = await resolveEmployee(opStr(input, "employee"));
      if ("error" in emp) return emp;
      const wantsActive = !/d[ée]sactiv|inactif|quitt|parti|false|non/i.test(opStr(input, "status") || opStr(input, "decision"));
      if (emp.isActive === wantsActive) return { error: `La fiche de ${emp.fullName} est déjà ${wantsActive ? "active" : "inactive"}.` };
      return {
        title: `${wantsActive ? "Réactiver" : "Désactiver"} la fiche employé de ${emp.fullName}`,
        fields: [
          { label: "Employé", value: emp.fullName },
          { label: "Fiche", value: `${emp.isActive ? "active" : "inactive"} → ${wantsActive ? "active" : "inactive"}` },
        ],
        warnings: [wantsActive ? "La fiche revient dans les listes actives (paie, effectifs)." : "La fiche sort des listes actives — rien n'est effacé, réversible à tout moment."],
        args: { id: emp.id, isActive: wantsActive ? "on" : "", employee: emp.fullName },
        successMessage: `Fiche de ${emp.fullName} ${wantsActive ? "réactivée" : "désactivée"}.`,
        link: "/rh",
        revalidate: ["/rh"],
      };
    },
    async execute(args) {
      const fd = new FormData();
      fd.set("id", args.id ?? "");
      if (args.isActive) fd.set("isActive", args.isActive);
      const r = await setEmployeeActive(fd);
      if (!r.ok) return { ok: false, error: r.error ?? "Le changement d'état de la fiche a été refusé." };
      return { ok: true, revalidate: ["/rh"] };
    },
  },

  process_hr_request: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const rawStatus = opStr(input, "status").toLowerCase();
      const status = /pr[êe]te|ready|disponible/.test(rawStatus) ? "READY"
        : /remis|delivr|livr/.test(rawStatus) ? "DELIVERED"
          : /pr[ée]paration|en cours|in progress/.test(rawStatus) ? "IN_PROGRESS"
            : /accord|approuv/.test(rawStatus) ? "APPROVED"
              : /refus|rejet/.test(rawStatus) ? "REJECTED" : null;
      if (!status) return { error: "Précisez le statut visé : en préparation, prête, remise, accordée ou refusée (champ « status »)." };
      const q = opStr(input, "employee");
      const rows = await prisma.hrDocumentRequest.findMany({
        where: {
          status: { in: ["PENDING", "IN_PROGRESS", "READY"] },
          ...(q ? { employee: { fullName: { contains: q, mode: "insensitive" } } } : {}),
        },
        include: { employee: { select: { fullName: true } } },
        orderBy: { createdAt: "desc" },
        take: 6,
      });
      if (rows.length === 0) return { error: `Aucune demande RH en cours${q ? ` pour « ${q} »` : ""}.` };
      const STATUS_FR: Record<string, string> = { IN_PROGRESS: "En préparation", READY: "Prête", DELIVERED: "Remise", APPROVED: "Accordée", REJECTED: "Refusée" };
      if (rows.length > 1) {
        return { error: `Plusieurs demandes RH en cours : ${rows.map((r) => `${r.employee.fullName} — ${HR_REQUEST_TYPE[r.type] ?? r.type}`).join(" ; ")} — préciser l'employé (ou le type).` };
      }
      const req = rows[0];
      return {
        title: `Demande RH de ${req.employee.fullName} → ${STATUS_FR[status]}`,
        fields: [
          { label: "Demande", value: `${HR_REQUEST_TYPE[req.type] ?? req.type} — ${req.employee.fullName}` },
          { label: "Statut", value: STATUS_FR[status] },
        ],
        warnings: ["Le demandeur est notifié du changement de statut."],
        args: { id: req.id, status, hrNote: opStr(input, "note"), employee: req.employee.fullName },
        successMessage: `Demande RH de ${req.employee.fullName} passée « ${STATUS_FR[status]} ».`,
        link: "/rh",
        revalidate: ["/rh"],
      };
    },
    async execute(args) {
      const fd = new FormData();
      fd.set("id", args.id ?? "");
      fd.set("status", args.status ?? "");
      if (args.hrNote) fd.set("hrNote", args.hrNote);
      const r = await processHrRequest(fd);
      if (!r.ok) return { ok: false, error: r.error ?? "Le traitement de la demande a été refusé." };
      return { ok: true, revalidate: ["/rh"] };
    },
  },

  decide_expense_report: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const raw = opStr(input, "decision").toLowerCase();
      const decision = /suivant|next/.test(raw) ? "APPROVE_NEXT" : /accord|approuv|valide/.test(raw) ? "APPROVE" : /refus|rejet/.test(raw) ? "REJECT" : null;
      if (!decision) return { error: "Précisez la décision : approuver (sur son mois), approuver sur le mois SUIVANT, ou refuser (champ « decision »)." };
      const q = opStr(input, "employee");
      const rows = await prisma.hrDocumentRequest.findMany({
        where: {
          type: "EXPENSE_REPORT",
          status: { in: ["PENDING", "IN_PROGRESS"] },
          ...(q ? { employee: { fullName: { contains: q, mode: "insensitive" } } } : {}),
        },
        include: { employee: { select: { fullName: true } } },
        orderBy: { createdAt: "desc" },
        take: 6,
      });
      if (rows.length === 0) return { error: `Aucune note de frais EN ATTENTE${q ? ` pour « ${q} »` : ""}.` };
      if (rows.length > 1) {
        return { error: `Plusieurs notes de frais en attente : ${rows.map((r) => `${r.employee.fullName}${r.expenseMonth ? ` (${r.expenseMonth})` : ""}`).join(" ; ")} — préciser l'employé.` };
      }
      const req = rows[0];
      const DECISION_FR: Record<string, string> = { APPROVE: "Approuvée (sur son mois)", APPROVE_NEXT: "Approuvée — mois suivant", REJECT: "Refusée" };
      return {
        title: `Note de frais de ${req.employee.fullName} : ${DECISION_FR[decision]}`,
        fields: [
          { label: "Employé", value: req.employee.fullName },
          ...(req.expenseMonth ? [{ label: "Mois concerné", value: req.expenseMonth }] : []),
          { label: "Décision", value: DECISION_FR[decision] },
        ],
        warnings: ["L'imputation de paie suit la décision ; le demandeur est notifié."],
        args: { id: req.id, decision, hrNote: opStr(input, "note"), employee: req.employee.fullName },
        successMessage: `Note de frais de ${req.employee.fullName} : ${DECISION_FR[decision].toLowerCase()}.`,
        link: "/rh",
        revalidate: ["/rh"],
      };
    },
    async execute(args) {
      const fd = new FormData();
      fd.set("id", args.id ?? "");
      fd.set("decision", args.decision ?? "");
      if (args.hrNote) fd.set("hrNote", args.hrNote);
      const r = await decideExpenseReport(fd);
      if (!r.ok) return { ok: false, error: r.error ?? "La décision sur la note de frais a été refusée." };
      return { ok: true, revalidate: ["/rh"] };
    },
  },

  decide_training: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const decision = decisionOf(opStr(input, "decision"));
      if (!decision) return { error: "Précisez la décision : approuver ou refuser (champ « decision »)." };
      const q = opStr(input, "employee") || opStr(input, "label");
      const rows = await prisma.training.findMany({
        where: {
          status: "PENDING",
          ...(q ? { OR: [{ title: { contains: q, mode: "insensitive" } }, { requester: { name: { contains: q, mode: "insensitive" } } }] } : {}),
        },
        include: { requester: { select: { name: true } } },
        orderBy: { createdAt: "desc" },
        take: 6,
      });
      if (rows.length === 0) return { error: `Aucune demande de formation EN ATTENTE${q ? ` pour « ${q} »` : ""}.` };
      if (rows.length > 1) {
        return { error: `Plusieurs formations en attente : ${rows.map((r) => `« ${r.title} » (${r.requester?.name ?? "—"})`).join(" ; ")} — préciser.` };
      }
      const training = rows[0];
      return {
        title: `${decision === "APPROVED" ? "Approuver" : "Refuser"} la formation « ${training.title} »`,
        fields: [
          { label: "Formation", value: training.title },
          { label: "Demandeur", value: training.requester?.name ?? "—" },
          { label: "Décision", value: decision === "APPROVED" ? "Approuvée" : "Refusée" },
        ],
        warnings: ["La chaîne de validation décide qui signe cette marche — si ce n'est pas votre tour, l'exécution refusera en le disant."],
        args: { id: training.id, decision, note: opStr(input, "note"), label: training.title },
        successMessage: `Formation « ${training.title} » : ${decision === "APPROVED" ? "marche approuvée" : "refusée"}.`,
        link: "/rh",
        revalidate: ["/rh"],
      };
    },
    async execute(args) {
      const fd = new FormData();
      fd.set("id", args.id ?? "");
      fd.set("decision", args.decision ?? "");
      if (args.note) fd.set("note", args.note);
      const r = await decideTraining(fd);
      if (!r.ok) return { ok: false, error: r.error ?? "La décision sur la formation a été refusée." };
      return { ok: true, revalidate: ["/rh"] };
    },
  },

  decide_recruitment_step: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const decision = decisionOf(opStr(input, "decision"));
      if (!decision) return { error: "Précisez la décision : approuver ou refuser (champ « decision »)." };
      const q = opStr(input, "label") || opStr(input, "reference");
      const rows = await prisma.recruitmentRequest.findMany({
        where: {
          // La décision par étape ne vit que pendant la CHAÎNE de validation — après (sourcing,
          // onboarding…), l'étape ne se « tranche » plus, elle s'exécute.
          stage: "CHAIN",
          ...(q ? { OR: [{ reference: { equals: q, mode: "insensitive" } }, { position: { contains: q, mode: "insensitive" } }] } : {}),
        },
        select: { id: true, reference: true, position: true, stage: true },
        orderBy: { createdAt: "desc" },
        take: 6,
      });
      if (rows.length === 0) return { error: `Aucune demande de recrutement en cours${q ? ` pour « ${q} »` : ""}.` };
      if (rows.length > 1) {
        return { error: `Plusieurs recrutements en cours : ${rows.map((r) => `${r.reference} — ${r.position}`).join(" ; ")} — préciser la référence ou le poste.` };
      }
      const req = rows[0];
      // Un refus se motive — l'action l'exige (§118.192) : la carte ne propose pas un refus que l'exécution refuserait.
      if (decision === "REJECTED" && !opStr(input, "note")) return { error: "Un refus se motive : dites pourquoi (c'est ce que lira le demandeur)." };
      return {
        title: `${decision === "APPROVED" ? "Approuver" : "Refuser"} l'étape du recrutement ${req.reference} — ${req.position}`,
        fields: [
          { label: "Recrutement", value: `${req.reference} — ${req.position}` },
          { label: "Décision", value: decision === "APPROVED" ? "Étape approuvée" : "Refusé (clôt la demande)" },
        ],
        warnings: ["La chaîne des validateurs décide qui signe l'étape courante — si ce n'est pas votre tour, l'exécution refusera en le disant."],
        args: { id: req.id, decision, reason: opStr(input, "note"), label: `${req.reference} — ${req.position}` },
        successMessage: `Recrutement ${req.reference} : ${decision === "APPROVED" ? "étape approuvée" : "refusé"}.`,
        link: "/rh",
        revalidate: ["/rh"],
      };
    },
    async execute(args) {
      const fd = new FormData();
      fd.set("id", args.id ?? "");
      fd.set("decision", args.decision ?? "");
      if (args.reason) fd.set("reason", args.reason);
      const r = await decideRecruitmentStep(fd);
      if (!r.ok) return { ok: false, error: r.error ?? "La décision sur le recrutement a été refusée." };
      return { ok: true, revalidate: ["/rh"] };
    },
  },
};
