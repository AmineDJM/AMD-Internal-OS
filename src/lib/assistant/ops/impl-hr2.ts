import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { toNumber } from "@/lib/utils";
import { HR_REQUEST_TYPE, LEAVE_TYPE, MODULE_LABELS } from "@/lib/labels";
import {
  createEmployee, updateEmployee, requestLeave, updateLeaveRequest, requestAdvance, cancelAdvance,
} from "@/lib/actions/hr-actions";
import {
  addHrRequestComment, decideHrLeave, ackExpenseOriginals, proposeHrMeeting, confirmHrMeeting,
  deleteHrRequest, deleteEmployeeDocument, setEmployeeDocumentVisibility,
} from "@/lib/actions/hr-document-actions";
import { proposeStandIn, decideStandIn } from "@/lib/actions/stand-in-actions";
import { saveAccessMatrix, updateUserProfile, revokeAllSessions, requestOnboarding } from "@/lib/actions/access-actions";
import { MODULES, type Module } from "@/lib/rbac";
import type { OpImpl, OpProposalDraft, OpExecuteResult } from "./types";
import { masquerSensibles } from "@/platform/in-process/capacites";
import { opStr } from "./types";
import { runFd, runFd2, toFd, dzd, fieldsOf, resolveOne, isoDate } from "./helpers";

/**
 * OPS RH 2 — fiche employé en PATCH SEMANTICS, congés/avances, demandes RH (dossier personnel),
 * intérim de congé, et administration des comptes (matrice d'accès, profil, sessions).
 *
 * LE PATCH SEMANTICS (fiche employé) : l'action canonique `updateEmployee` REMPLACE la fiche
 * entière — champ absent = effacé. L'op ne l'appelle donc JAMAIS avec les seuls champs cités :
 * elle relit la fiche, applique les champs demandés (liste blanche explicite), montre le DIFF
 * avant → après, mémorise `updatedAt` et REFUSE à l'exécution si la fiche a changé entre-temps
 * (garde de fraîcheur). Le salaire a son op dédiée (`update_employee_salary`) — un « corrige
 * son téléphone » ne peut pas toucher une rémunération par accident.
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

const day = (d: Date | null): string | null => (d ? d.toISOString().slice(0, 10) : null);

const resolveEmployee = (raw: string) =>
  resolveOne(raw, "l'employé (champ « employee »)",
    (q) => prisma.employee.findMany({ where: { fullName: { contains: q, mode: "insensitive" } }, select: { id: true, fullName: true }, take: 6 }),
    (e) => e.fullName);

const resolveUser = (raw: string) =>
  resolveOne(raw, "la personne (compte)",
    (q) => prisma.user.findMany({ where: { name: { contains: q, mode: "insensitive" } }, select: { id: true, name: true, email: true, isActive: true }, take: 6 }),
    (u) => u.name);

const CONTRACT_FR: Record<string, string> = {
  cdi: "CDI", cdd: "CDD", interim: "INTERIM", "intérim": "INTERIM",
  stage: "STAGE", stagiaire: "STAGE", freelance: "FREELANCE", consulting: "CONSULTING", consultant: "CONSULTING",
};

function contractOf(raw: string): string | null {
  const up = raw.toUpperCase().trim();
  if (["CDI", "CDD", "INTERIM", "STAGE", "FREELANCE", "CONSULTING"].includes(up)) return up;
  return CONTRACT_FR[raw.toLowerCase().trim()] ?? null;
}

function leaveTypeOf(raw: string): string {
  const up = raw.toUpperCase().trim();
  if (LEAVE_TYPE[up]) return up;
  const k = raw.toLowerCase();
  if (/malad|sick/.test(k)) return "SICK";
  if (/sans solde|unpaid/.test(k)) return "UNPAID";
  if (/matern|patern/.test(k)) return "MATERNITY";
  if (/mariage|naissance|d[ée]c[èe]s|exceptionnel|familial/.test(k)) return "SPECIAL";
  if (/r[ée]cup/.test(k)) return "RECOVERY";
  if (/annuel|annual|cong[ée]/.test(k)) return "ANNUAL";
  return "ANNUAL";
}

type EmployeeRow = NonNullable<Awaited<ReturnType<typeof prisma.employee.findUnique>>>;

/**
 * La fiche employé ENTIÈRE sérialisée en args rejouables — la base de tout PATCH : on écrase
 * ensuite les seuls champs demandés, et l'action canonique reçoit une fiche complète.
 * `departmentId` n'est PAS envoyé : absent du formulaire = rattachement inchangé (le
 * rattachement se change par l'op dédiée `assign_department`).
 */
function employeeArgs(e: EmployeeRow): Record<string, string | null> {
  const dec = (v: Prisma.Decimal | number | null): string | null => (v === null ? null : String(toNumber(v)));
  // LE COFFRE (refonte V2-E) : IBAN, NIN et salaires partent MASQUÉS — ni la carte ni le modèle ne les lisent.
  // Rejoué dans `updateEmployee`, un masque garde la valeur en place (`champsNonSaisis`) ; seule une valeur
  // que la personne vient de dicter remplace la colonne.
  return masquerSensibles("Employee", {
    id: e.id,
    fullName: e.fullName,
    position: e.position,
    email: e.email, phone: e.phone, iban: e.iban, address: e.address,
    nationalId: e.nationalId, cnasNumber: e.cnasNumber,
    baseSalary: dec(e.baseSalary),
    retSS9: dec(e.retSS9), retSS35: dec(e.retSS35), tfp: dec(e.tfp), retIrg: dec(e.retIrg),
    expenseRefund: dec(e.expenseRefund), netToPay: dec(e.netToPay),
    grossSalary: dec(e.grossSalary), employerCost: dec(e.employerCost),
    hireDate: day(e.hireDate), birthDate: day(e.birthDate),
    contractType: e.contractType, contractStart: day(e.contractStart), contractEnd: day(e.contractEnd),
    trialStart: day(e.trialStart), trialEnd: day(e.trialEnd),
    trialRenewable: e.trialRenewable ? "1" : null, trialRenewed: e.trialRenewed ? "1" : null,
    trialRenewalStart: day(e.trialRenewalStart), trialRenewalEnd: day(e.trialRenewalEnd),
    leaveBalanceDays: String(toNumber(e.leaveBalanceDays)),
    userId: e.userId, managerId: e.managerId, companyId: e.companyId,
    isActive: e.isActive ? "1" : null,
    // Garde de fraîcheur : consommée par l'EXÉCUTION de l'op, retirée avant l'action canonique.
    expectedUpdatedAt: e.updatedAt.toISOString(),
  });
}

/** Exécution commune des deux PATCH : fraîcheur vérifiée, puis l'action canonique rejoue tout. */
async function executeEmployeePatch(args: Record<string, string | null>): Promise<OpExecuteResult> {
  const { expectedUpdatedAt, ...rest } = args;
  const current = await prisma.employee.findUnique({ where: { id: rest.id ?? "" }, select: { updatedAt: true, fullName: true } });
  if (!current) return { ok: false, error: "Fiche employé introuvable." };
  if (expectedUpdatedAt && current.updatedAt.toISOString() !== expectedUpdatedAt) {
    return { ok: false, error: `La fiche de ${current.fullName} a été modifiée entre-temps (par quelqu'un d'autre ou un autre écran) : redemandez la modification pour repartir de la fiche à jour.` };
  }
  const r = await updateEmployee(toFd(rest));
  if (!r.ok) return { ok: false, error: r.error ?? "La modification de la fiche a été refusée." };
  return { ok: true, revalidate: ["/rh", `/rh/${rest.id}`] };
}

/** Une demande RH (dossier personnel) par employé + type/mots-clés, bornée aux statuts utiles. */
async function resolveHrRequest(input: Record<string, unknown>, opts: { types?: string[]; statuses?: string[] } = {}) {
  const empRaw = opStr(input, "employee");
  let employeeId: string | null = null; let employeeName: string | null = null;
  if (empRaw) {
    const emp = await resolveEmployee(empRaw);
    if ("error" in emp) return emp;
    employeeId = emp.id; employeeName = emp.fullName;
  }
  const typeRaw = opStr(input, "type").toLowerCase();
  const wantedTypes = opts.types
    ?? (typeRaw
      ? Object.keys(HR_REQUEST_TYPE).filter((t) => (HR_REQUEST_TYPE[t] ?? "").toLowerCase().includes(typeRaw) || t.toLowerCase() === typeRaw)
      : undefined);
  const rows = await prisma.hrDocumentRequest.findMany({
    where: {
      ...(employeeId ? { employeeId } : {}),
      ...(wantedTypes && wantedTypes.length > 0 ? { type: { in: wantedTypes as never } } : {}),
      status: { in: (opts.statuses ?? ["PENDING", "IN_PROGRESS", "READY"]) as never },
    },
    include: { employee: { select: { fullName: true } } },
    orderBy: { createdAt: "desc" },
    take: 6,
  });
  if (rows.length === 0) return { error: `Aucune demande RH en cours${employeeName ? ` pour ${employeeName}` : ""}${typeRaw ? ` (type « ${typeRaw} »)` : ""}.` } as const;
  if (rows.length > 1) {
    return { error: `Plusieurs demandes RH en cours : ${rows.map((r) => `${r.employee.fullName} — ${HR_REQUEST_TYPE[r.type] ?? r.type}`).join(" ; ")} — préciser l'employé et le type.` } as const;
  }
  return rows[0];
}

interface LeaveHit { id: string; startDate: Date; endDate: Date; type: string; days: number; standInId: string | null; employeeName: string }

/** La demande de congé (LeaveRequest) d'un employé — pour l'intérim. */
async function resolveLeave(input: Record<string, unknown>, statuses: string[]): Promise<LeaveHit | { error: string }> {
  const emp = await resolveEmployee(opStr(input, "employee"));
  if ("error" in emp) return emp;
  const rows = await prisma.leaveRequest.findMany({
    where: { employeeId: emp.id, status: { in: statuses as never } },
    orderBy: { startDate: "desc" },
    take: 4,
  });
  if (rows.length === 0) return { error: `Aucune demande de congé en cours pour ${emp.fullName}.` };
  if (rows.length > 1) return { error: `Plusieurs congés en cours pour ${emp.fullName} : ${rows.map((r) => `${day(r.startDate)} → ${day(r.endDate)} (${LEAVE_TYPE[r.type] ?? r.type})`).join(" ; ")} — préciser les dates n'est pas encore supporté, traiter depuis l'écran RH.` };
  const hit = rows[0];
  return { id: hit.id, startDate: hit.startDate, endDate: hit.endDate, type: hit.type, days: toNumber(hit.days), standInId: hit.standInId, employeeName: emp.fullName };
}

export const HR2_OPS_IMPL: Record<string, OpImpl> = {
  // ─────────────── Fiche employé : création + PATCH SEMANTICS ───────────────

  create_employee: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const fullName = opStr(input, "name") || opStr(input, "employee");
      if (!fullName) return { error: "Précisez le nom complet du nouvel employé (champ « name »)." };
      const contract = opStr(input, "contractType") ? contractOf(opStr(input, "contractType")) : null;
      if (opStr(input, "contractType") && !contract) return { error: "Type de contrat inconnu — attendu : CDI, CDD, intérim, stage, freelance, consulting." };
      const salary = num(input, "baseSalary") ?? num(input, "amount");
      return {
        title: `Créer la fiche employé de ${fullName}`,
        fields: fieldsOf([
          ["Nom complet", fullName], ["Poste", opStr(input, "position") || null],
          ["E-mail", opStr(input, "email") || null], ["Téléphone", opStr(input, "phone") || null],
          ["Contrat", contract], ["Embauche", isoDate(opStr(input, "hireDate"))],
          ["Salaire de base", salary !== null ? dzd(salary) : null],
        ]),
        warnings: ["La fiche naît avec 30 jours de solde de congés (défaut de l'écran RH) ; le rattachement au département et au compte applicatif se règlent ensuite."],
        args: {
          fullName, position: opStr(input, "position") || null, email: opStr(input, "email") || null,
          phone: opStr(input, "phone") || null, hireDate: isoDate(opStr(input, "hireDate")),
          contractType: contract, contractStart: isoDate(opStr(input, "contractStart")), contractEnd: isoDate(opStr(input, "contractEnd")),
          baseSalary: salary !== null ? String(salary) : null,
        },
        successMessage: `Fiche employé de ${fullName} créée.`,
        link: "/rh", revalidate: ["/rh"],
      };
    },
    execute: (args) => runFd2(createEmployee, args, "La création de la fiche a été refusée.", { link: "/rh", revalidate: ["/rh"] }),
  },

  update_employee: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const emp = await resolveEmployee(opStr(input, "employee"));
      if ("error" in emp) return emp;
      const before = await prisma.employee.findUnique({ where: { id: emp.id } });
      if (!before) return { error: "Fiche employé introuvable." };

      // Salaire → op dédiée, sans exception : la frontière est le garde-fou.
      for (const k of ["baseSalary", "grossSalary", "employerCost", "netToPay", "net", "gross", "salary", "amount"]) {
        if (opStr(input, k)) return { error: "La rémunération se modifie par l'op « update_employee_salary » (jamais mêlée aux champs administratifs)." };
      }

      const args = employeeArgs(before);
      const changes: { label: string; value: string }[] = [];
      const apply = (key: string, label: string, next: string | null, display?: (v: string | null) => string) => {
        if (next === null) return;
        const show = display ?? ((v: string | null) => v ?? "—");
        if ((args[key] ?? "") !== next) changes.push({ label, value: `${show(args[key])} → ${show(next)}` });
        args[key] = next;
      };

      apply("fullName", "Nom complet", opStr(input, "newName") || null);
      apply("position", "Poste", opStr(input, "position") || null);
      apply("email", "E-mail", opStr(input, "email") || null);
      apply("phone", "Téléphone", opStr(input, "phone") || null);
      apply("iban", "RIB / IBAN", opStr(input, "iban") || null);
      apply("address", "Adresse", opStr(input, "address") || null);
      apply("nationalId", "N° pièce d'identité", opStr(input, "nationalId") || null);
      apply("cnasNumber", "N° CNAS", opStr(input, "cnasNumber") || null);
      apply("hireDate", "Date d'embauche", isoDate(opStr(input, "hireDate")));
      apply("birthDate", "Date de naissance", isoDate(opStr(input, "birthDate")));
      if (opStr(input, "contractType")) {
        const contract = contractOf(opStr(input, "contractType"));
        if (!contract) return { error: "Type de contrat inconnu — attendu : CDI, CDD, intérim, stage, freelance, consulting." };
        apply("contractType", "Contrat", contract);
      }
      apply("contractStart", "Début de contrat", isoDate(opStr(input, "contractStart")));
      apply("contractEnd", "Fin de contrat", isoDate(opStr(input, "contractEnd")));
      apply("trialStart", "Début d'essai", isoDate(opStr(input, "trialStart")));
      apply("trialEnd", "Fin d'essai", isoDate(opStr(input, "trialEnd")));
      const leaveBalance = num(input, "leaveBalance");
      if (leaveBalance !== null) apply("leaveBalanceDays", "Solde de congés", String(leaveBalance), (v) => `${v ?? "—"} j`);

      if (changes.length === 0) {
        return { error: "Aucun champ à modifier — donnez le ou les champs (poste, e-mail, téléphone, contrat, dates, solde de congés…). Le rattachement se change par « assign_department », la rémunération par « update_employee_salary »." };
      }
      return {
        title: `Modifier la fiche de ${before.fullName} (${changes.length} champ·s)`,
        fields: [
          { label: "Employé", value: before.fullName },
          ...changes,
        ],
        warnings: ["Seuls les champs listés changent — TOUT le reste de la fiche est rejoué à l'identique. Si la fiche bouge entre-temps, l'exécution refusera (garde de fraîcheur)."],
        args,
        successMessage: `Fiche de ${before.fullName} mise à jour (${changes.map((c) => c.label.toLowerCase()).join(", ")}).`,
        link: `/rh/${before.id}`, revalidate: ["/rh", `/rh/${before.id}`],
      };
    },
    execute: executeEmployeePatch,
  },

  update_employee_salary: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const emp = await resolveEmployee(opStr(input, "employee"));
      if ("error" in emp) return emp;
      const before = await prisma.employee.findUnique({ where: { id: emp.id } });
      if (!before) return { error: "Fiche employé introuvable." };

      const args = employeeArgs(before);
      const changes: { label: string; value: string }[] = [];
      const money = (v: string | null) => (v === null || v === "" ? "—" : v.includes("•") ? v : dzd(Number(v)));
      const apply = (key: string, label: string, next: number | null) => {
        if (next === null) return;
        if ((args[key] ?? "") !== String(next)) changes.push({ label, value: `${money(args[key])} → ${money(String(next))}` });
        args[key] = String(next);
      };
      apply("baseSalary", "Salaire de base", num(input, "baseSalary") ?? num(input, "amount"));
      apply("grossSalary", "Brut (bulletin)", num(input, "gross"));
      apply("employerCost", "Coût employeur", num(input, "employerCost"));
      apply("netToPay", "Net à payer", num(input, "net"));
      apply("retSS9", "Retenue SS 9 %", num(input, "retSS9"));
      apply("retSS35", "Retenue SS 35 %", num(input, "retSS35"));
      apply("tfp", "TFP", num(input, "tfp"));
      apply("retIrg", "Retenue IRG", num(input, "retIrg"));
      apply("expenseRefund", "Remboursement de frais", num(input, "expenseRefund"));

      if (changes.length === 0) return { error: "Aucun montant à modifier — donnez le ou les éléments (salaire de base, brut, coût employeur, net, retenues…)." };
      return {
        title: `Rémunération de ${before.fullName} (${changes.length} élément·s)`,
        fields: [{ label: "Employé", value: before.fullName }, ...changes],
        warnings: [
          "RÉMUNÉRATION : seuls les éléments listés changent, le reste de la fiche est rejoué à l'identique (garde de fraîcheur à l'exécution).",
          "La fiche ne règle rien : les bulletins et la paie du mois restent les gestes qui font sortir l'argent.",
        ],
        args,
        successMessage: `Rémunération de ${before.fullName} mise à jour.`,
        link: `/rh/${before.id}`, revalidate: ["/rh", `/rh/${before.id}`],
      };
    },
    execute: executeEmployeePatch,
  },

  // ─────────────── Congés & avances (demandes et corrections) ───────────────

  request_leave: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const startDate = isoDate(opStr(input, "startDate"));
      const endDate = isoDate(opStr(input, "endDate"));
      if (!startDate || !endDate) return { error: "Précisez les dates de début et de fin (champs « startDate », « endDate »)." };
      const type = leaveTypeOf(opStr(input, "type"));
      const empRaw = opStr(input, "employee");
      let employeeId: string | null = null; let forWho = "vous-même (la fiche liée à votre compte)";
      if (empRaw) {
        const emp = await resolveEmployee(empRaw);
        if ("error" in emp) return emp;
        employeeId = emp.id; forWho = emp.fullName;
      }
      void user;
      return {
        title: `Demande de congé — ${forWho} (${startDate} → ${endDate})`,
        fields: fieldsOf([
          ["Pour", forWho], ["Type", LEAVE_TYPE[type] ?? type],
          ["Du", startDate], ["Au", endDate],
          ["Jours", num(input, "days") !== null ? String(num(input, "days")) : null],
          ["Motif", opStr(input, "reason") || null],
        ]),
        warnings: ["La demande entre dans le circuit N+1 → RH → Direction — rien n'est accordé avant la dernière marche. (Déposer pour un autre employé exige le droit RH.)"],
        args: { employeeId, startDate, endDate, type, days: num(input, "days") !== null ? String(num(input, "days")) : null, reason: opStr(input, "reason") || null },
        successMessage: `Demande de congé (${startDate} → ${endDate}) déposée pour ${forWho}.`,
        revalidate: ["/rh", "/mon-espace"],
      };
    },
    execute: (args) => runFd2(requestLeave, args, "La demande de congé a été refusée.", { revalidate: ["/rh", "/mon-espace"] }),
  },

  update_leave: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const leave = await resolveLeave(input, ["PENDING", "APPROVED"]);
      if ("error" in leave) return leave;
      const startDate = isoDate(opStr(input, "startDate"));
      const endDate = isoDate(opStr(input, "endDate"));
      const days = num(input, "days");
      const type = opStr(input, "type") ? leaveTypeOf(opStr(input, "type")) : null;
      if (!startDate && !endDate && days === null && !type) {
        return { error: "Précisez ce qui change : dates (« startDate »/« endDate »), nombre de jours (« days ») ou type." };
      }
      return {
        title: `Corriger le congé de ${leave.employeeName}`,
        fields: fieldsOf([
          ["Congé", `${day(leave.startDate)} → ${day(leave.endDate)} (${LEAVE_TYPE[leave.type] ?? leave.type}, ${toNumber(leave.days)} j)`],
          ["Nouvelles dates", startDate || endDate ? `${startDate ?? day(leave.startDate)} → ${endDate ?? day(leave.endDate)}` : null],
          ["Nouveaux jours", days !== null ? `${toNumber(leave.days)} → ${days}` : null],
          ["Nouveau type", type ? (LEAVE_TYPE[type] ?? type) : null],
        ]),
        warnings: ["Geste RH : si le congé était accordé, le solde annuel est réajusté de la différence."],
        args: { id: leave.id, startDate, endDate, days: days !== null ? String(days) : null, type },
        successMessage: `Congé de ${leave.employeeName} corrigé.`,
        revalidate: ["/rh"],
      };
    },
    execute: (args) => runFd(updateLeaveRequest, args, "La correction du congé a été refusée.", { revalidate: ["/rh"] }),
  },

  request_advance: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const amount = num(input, "amount");
      if (amount === null || amount <= 0) return { error: "Précisez le montant de l'avance (champ « amount »)." };
      const empRaw = opStr(input, "employee");
      let employeeId: string | null = null; let forWho = "vous-même (la fiche liée à votre compte)";
      if (empRaw) {
        const emp = await resolveEmployee(empRaw);
        if ("error" in emp) return emp;
        employeeId = emp.id; forWho = emp.fullName;
      }
      return {
        title: `Demande d'avance sur salaire — ${forWho} (${dzd(amount)})`,
        fields: fieldsOf([["Pour", forWho], ["Montant", dzd(amount)], ["Motif", opStr(input, "reason") || null]]),
        warnings: ["Les RH tranchent ; une avance approuvée ouvre un ordre de dépense chez le comptable."],
        args: { employeeId, amount: String(amount), reason: opStr(input, "reason") || null },
        successMessage: `Demande d'avance (${dzd(amount)}) déposée pour ${forWho}.`,
        revalidate: ["/rh", "/mon-espace"],
      };
    },
    execute: (args) => runFd2(requestAdvance, args, "La demande d'avance a été refusée.", { revalidate: ["/rh", "/mon-espace"] }),
  },

  cancel_advance: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const emp = await resolveEmployee(opStr(input, "employee"));
      if ("error" in emp) return emp;
      const rows = await prisma.salaryAdvance.findMany({
        where: { employeeId: emp.id, status: "PENDING" },
        orderBy: { createdAt: "desc" }, take: 4,
      });
      if (rows.length === 0) return { error: `Aucune demande d'avance EN ATTENTE pour ${emp.fullName}.` };
      if (rows.length > 1) return { error: `Plusieurs avances en attente pour ${emp.fullName} : ${rows.map((r) => dzd(toNumber(r.amount))).join(", ")} — traiter depuis l'écran RH.` };
      return {
        title: `Annuler la demande d'avance de ${emp.fullName} (${dzd(toNumber(rows[0].amount))})`,
        fields: [{ label: "Avance", value: `${emp.fullName} — ${dzd(toNumber(rows[0].amount))}` }],
        args: { id: rows[0].id },
        successMessage: `Demande d'avance de ${emp.fullName} annulée.`,
        revalidate: ["/rh", "/mon-espace"],
      };
    },
    execute: (args) => runFd(cancelAdvance, args, "L'annulation a été refusée.", { revalidate: ["/rh", "/mon-espace"] }),
  },

  // ─────────────── Demandes RH du dossier personnel ───────────────

  comment_hr_request: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const req = await resolveHrRequest(input);
      if ("error" in req) return req;
      const body = opStr(input, "message") || opStr(input, "note");
      if (!body) return { error: "Écrivez le message (champ « message »)." };
      return {
        title: `Message sur la demande « ${HR_REQUEST_TYPE[req.type] ?? req.type} » de ${req.employee.fullName}`,
        fields: [
          { label: "Demande", value: `${HR_REQUEST_TYPE[req.type] ?? req.type} — ${req.employee.fullName}` },
          { label: "Message", value: body },
        ],
        args: { requestId: req.id, body },
        successMessage: `Message ajouté à la demande de ${req.employee.fullName}.`,
        revalidate: ["/rh", "/mon-dossier"],
      };
    },
    execute: (args) => runFd(addHrRequestComment, args, "Le message a été refusé.", { revalidate: ["/rh", "/mon-dossier"] }),
  },

  decide_hr_leave: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const req = await resolveHrRequest(input, { statuses: ["PENDING", "IN_PROGRESS"] });
      if ("error" in req) return req;
      const raw = opStr(input, "decision");
      const approve = /accord|approuv|oui|valide/i.test(raw);
      const reject = /refus|rejet|non/i.test(raw);
      if (!approve && !reject) return { error: "Précisez la décision (champ « decision ») : accorder ou refuser." };
      return {
        title: `${approve ? "Accorder" : "Refuser"} — ${HR_REQUEST_TYPE[req.type] ?? req.type} de ${req.employee.fullName}`,
        fields: fieldsOf([
          ["Demande", `${HR_REQUEST_TYPE[req.type] ?? req.type} — ${req.employee.fullName}`],
          ["Période", req.periodStart ? `${day(req.periodStart)}${req.periodEnd ? ` → ${day(req.periodEnd)}` : ""}` : null],
          ["Décision", approve ? "Accordée" : "Refusée"],
          ["Note RH", opStr(input, "note") || null],
        ]),
        warnings: approve ? ["Un congé annuel accordé débite le solde de l'employé (idempotent)."] : ["L'employé est notifié du refus."],
        args: { id: req.id, decision: approve ? "APPROVE" : "REJECT", hrNote: opStr(input, "note") || null },
        successMessage: `Demande de ${req.employee.fullName} ${approve ? "accordée" : "refusée"}.`,
        revalidate: ["/rh", "/mon-dossier"],
      };
    },
    execute: (args) => runFd(decideHrLeave, args, "La décision a été refusée.", { revalidate: ["/rh", "/mon-dossier"] }),
  },

  ack_expense_originals: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const req = await resolveHrRequest(input, { types: ["EXPENSE_REPORT"], statuses: ["PENDING", "IN_PROGRESS", "READY", "APPROVED"] });
      if ("error" in req) return req;
      return {
        title: `Accuser réception des originaux — note de frais de ${req.employee.fullName}`,
        fields: [{ label: "Note de frais", value: `${req.employee.fullName}${req.expenseMonth ? ` — ${req.expenseMonth}` : ""}` }],
        warnings: ["L'accusé atteste que les originaux papier sont physiquement au bureau du secrétariat."],
        args: { id: req.id },
        successMessage: `Originaux de la note de frais de ${req.employee.fullName} réceptionnés.`,
        revalidate: ["/rh"],
      };
    },
    execute: (args) => runFd(ackExpenseOriginals, args, "L'accusé de réception a été refusé.", { revalidate: ["/rh"] }),
  },

  propose_hr_meeting: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const req = await resolveHrRequest(input, { types: ["HR_INTERVIEW"], statuses: ["PENDING", "IN_PROGRESS"] });
      if ("error" in req) return req;
      const when = opStr(input, "date");
      const time = opStr(input, "time") || "09:00";
      if (!when) return { error: "Précisez la date proposée (champ « date », AAAA-MM-JJ) — et l'heure (« time », HH:MM, heure d'Alger)." };
      const at = `${isoDate(when) ?? when}T${time}`;
      return {
        title: `Proposer une date d'entrevue RH — ${req.employee.fullName}`,
        fields: [
          { label: "Entrevue", value: `${req.employee.fullName}` },
          { label: "Date proposée", value: `${isoDate(when) ?? when} à ${time} (heure d'Alger)` },
        ],
        warnings: ["L'autre partie devra ACCEPTER la date pour que l'entrevue soit confirmée (et posée aux deux agendas)."],
        args: { id: req.id, meetingAt: at },
        successMessage: `Date d'entrevue proposée à ${req.employee.fullName}.`,
        revalidate: ["/rh", "/mon-dossier"],
      };
    },
    execute: (args) => runFd(proposeHrMeeting, args, "La proposition de date a été refusée.", { revalidate: ["/rh", "/mon-dossier"] }),
  },

  confirm_hr_meeting: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const req = await resolveHrRequest(input, { types: ["HR_INTERVIEW"], statuses: ["PENDING", "IN_PROGRESS"] });
      if ("error" in req) return req;
      if (!req.meetingAt) return { error: `Aucune date proposée sur l'entrevue de ${req.employee.fullName} — proposez-en une d'abord.` };
      return {
        title: `Confirmer l'entrevue RH — ${req.employee.fullName}`,
        fields: [
          { label: "Entrevue", value: req.employee.fullName },
          { label: "Date proposée", value: req.meetingAt.toISOString().replace("T", " ").slice(0, 16) + " (UTC)" },
        ],
        warnings: ["Seule L'AUTRE partie (pas celle qui a proposé) peut confirmer — l'action refusera sinon. Le rendez-vous est posé aux deux agendas."],
        args: { id: req.id },
        successMessage: `Entrevue avec ${req.employee.fullName} confirmée.`,
        revalidate: ["/rh", "/mon-dossier"],
      };
    },
    execute: (args) => runFd(confirmHrMeeting, args, "La confirmation a été refusée.", { revalidate: ["/rh", "/mon-dossier"] }),
  },

  delete_hr_request: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const req = await resolveHrRequest(input, { statuses: ["PENDING", "IN_PROGRESS", "READY", "DELIVERED", "APPROVED", "REJECTED"] });
      if ("error" in req) return req;
      return {
        title: `SUPPRIMER la demande « ${HR_REQUEST_TYPE[req.type] ?? req.type} » de ${req.employee.fullName}`,
        fields: [{ label: "Demande", value: `${HR_REQUEST_TYPE[req.type] ?? req.type} — ${req.employee.fullName}` }],
        warnings: ["Suppression définitive de la demande et de son fil — l'historique du dossier personnel la perd."],
        args: { id: req.id },
        successMessage: `Demande de ${req.employee.fullName} supprimée.`,
        revalidate: ["/rh", "/mon-dossier"],
      };
    },
    execute: (args) => runFd(deleteHrRequest, args, "La suppression a été refusée.", { revalidate: ["/rh", "/mon-dossier"] }),
  },

  delete_employee_document: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const emp = await resolveEmployee(opStr(input, "employee"));
      if ("error" in emp) return emp;
      const nameRaw = opStr(input, "name") || opStr(input, "label");
      if (!nameRaw) return { error: "Précisez le nom du document (champ « name »)." };
      const docs = await prisma.employeeDocument.findMany({
        where: { employeeId: emp.id, name: { contains: nameRaw, mode: "insensitive" } },
        select: { id: true, name: true, category: true }, take: 6,
      });
      if (docs.length === 0) return { error: `Aucun document « ${nameRaw} » dans le dossier de ${emp.fullName}.` };
      if (docs.length > 1) return { error: `Plusieurs documents correspondent : ${docs.map((d) => d.name).join(", ")} — préciser.` };
      return {
        title: `SUPPRIMER le document « ${docs[0].name} » (${emp.fullName})`,
        fields: [{ label: "Document", value: `${docs[0].name} — dossier de ${emp.fullName}` }],
        warnings: ["Suppression DÉFINITIVE : le fichier chiffré est libéré, AUCUN retour possible."],
        confirmText: docs[0].name,
        args: { id: docs[0].id },
        successMessage: `Document « ${docs[0].name} » supprimé du dossier de ${emp.fullName}.`,
        revalidate: ["/rh"],
      };
    },
    execute: (args) => runFd(deleteEmployeeDocument, args, "La suppression du document a été refusée.", { revalidate: ["/rh"] }),
  },

  set_employee_document_visibility: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const emp = await resolveEmployee(opStr(input, "employee"));
      if ("error" in emp) return emp;
      const nameRaw = opStr(input, "name") || opStr(input, "label");
      if (!nameRaw) return { error: "Précisez le nom du document (champ « name »)." };
      const docs = await prisma.employeeDocument.findMany({
        where: { employeeId: emp.id, name: { contains: nameRaw, mode: "insensitive" } },
        select: { id: true, name: true, visibleToEmployee: true }, take: 6,
      });
      if (docs.length === 0) return { error: `Aucun document « ${nameRaw} » dans le dossier de ${emp.fullName}.` };
      if (docs.length > 1) return { error: `Plusieurs documents correspondent : ${docs.map((d) => d.name).join(", ")} — préciser.` };
      const hide = /masqu|cach|invisible|retir/i.test(opStr(input, "mode"));
      return {
        title: `${hide ? "Masquer" : "Rendre visible"} « ${docs[0].name} » ${hide ? "à" : "pour"} ${emp.fullName}`,
        fields: [
          { label: "Document", value: docs[0].name },
          { label: "Visibilité", value: hide ? "Masqué à l'employé (RH seulement)" : "Visible par l'employé (Mon dossier)" },
        ],
        args: { id: docs[0].id, visible: hide ? "0" : "1" },
        successMessage: `« ${docs[0].name} » ${hide ? "masqué à" : "rendu visible pour"} ${emp.fullName}.`,
        revalidate: ["/rh"],
      };
    },
    execute: (args) => runFd(setEmployeeDocumentVisibility, args, "Le réglage de visibilité a été refusé.", { revalidate: ["/rh"] }),
  },

  // ─────────────── Intérim de congé ───────────────

  propose_stand_in: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const leave = await resolveLeave(input, ["PENDING", "APPROVED"]);
      if ("error" in leave) return leave;
      const standRaw = opStr(input, "standIn") || opStr(input, "person");
      const remove = /^(aucun|retire|retirer|personne|remove)$/i.test(standRaw) || (!standRaw && /retire/i.test(opStr(input, "mode")));
      let standInId: string | null = null; let standName = "— retiré (plus d'intérimaire)";
      if (!remove) {
        if (!standRaw) return { error: "Précisez l'intérimaire (champ « standIn ») — ou « aucun » pour le retirer." };
        const stand = await resolveOne(standRaw, "l'intérimaire",
          (q) => prisma.user.findMany({ where: { name: { contains: q, mode: "insensitive" }, isActive: true }, select: { id: true, name: true }, take: 6 }),
          (u) => u.name);
        if ("error" in stand) return stand;
        standInId = stand.id; standName = stand.name;
      }
      return {
        title: remove
          ? `Retirer l'intérimaire du congé de ${leave.employeeName}`
          : `Proposer ${standName} comme intérimaire — congé de ${leave.employeeName}`,
        fields: [
          { label: "Congé", value: `${leave.employeeName} · ${day(leave.startDate)} → ${day(leave.endDate)}` },
          { label: "Intérimaire", value: standName },
        ],
        warnings: remove ? [] : ["Les RH valideront l'intérim ; la délégation d'accès ne prend effet qu'à leur validation."],
        args: { id: leave.id, standInId },
        successMessage: remove ? `Intérimaire retiré (congé de ${leave.employeeName}).` : `${standName} proposé comme intérimaire de ${leave.employeeName}.`,
        revalidate: ["/rh", "/mon-espace"],
      };
    },
    execute: (args) => runFd(proposeStandIn, args, "La désignation d'intérimaire a été refusée.", { revalidate: ["/rh", "/mon-espace"] }),
  },

  decide_stand_in: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const leave = await resolveLeave(input, ["PENDING", "APPROVED"]);
      if ("error" in leave) return leave;
      if (!leave.standInId) return { error: `Aucun intérimaire n'est proposé sur le congé de ${leave.employeeName}.` };
      const raw = opStr(input, "decision");
      const reject = /refus|rejet|non/i.test(raw);
      const note = opStr(input, "note");
      if (reject && !note) return { error: "Un refus d'intérim se motive (champ « note ») — l'intéressé doit savoir quoi proposer d'autre." };
      return {
        title: `${reject ? "Refuser" : "Valider"} l'intérimaire — congé de ${leave.employeeName}`,
        fields: fieldsOf([
          ["Congé", `${leave.employeeName} · ${day(leave.startDate)} → ${day(leave.endDate)}`],
          ["Décision", reject ? "Refusé" : "Validé — la délégation d'accès prend effet pendant l'absence"],
          ["Note", note || null],
        ]),
        args: { id: leave.id, decision: reject ? "REJECTED" : "APPROVED", note: note || null },
        successMessage: `Intérim du congé de ${leave.employeeName} ${reject ? "refusé" : "validé"}.`,
        revalidate: ["/rh"],
      };
    },
    execute: (args) => runFd(decideStandIn, args, "La décision d'intérim a été refusée.", { revalidate: ["/rh"] }),
  },
};

// ─────────────── Comptes & accès (Super Admin) — portés par org_operation ───────────────

const ACCESS_ACTIONS = ["CREATE", "UPDATE", "DELETE", "VALIDATE", "EXPORT", "UPLOAD"] as const;

function moduleOf(raw: string): Module | null {
  const up = raw.toUpperCase().trim().replace(/\s+/g, "_");
  if ((MODULES as readonly string[]).includes(up)) return up as Module;
  const k = raw.toLowerCase().trim();
  const hit = (MODULES as readonly Module[]).find((m) => (MODULE_LABELS[m] ?? "").toLowerCase() === k)
    ?? (MODULES as readonly Module[]).find((m) => (MODULE_LABELS[m] ?? "").toLowerCase().includes(k));
  return hit ?? null;
}

export const ACCESS_OPS_IMPL: Record<string, OpImpl> = {
  set_module_access: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const person = await resolveUser(opStr(input, "person") || opStr(input, "name"));
      if ("error" in person) return person;
      const module = moduleOf(opStr(input, "module"));
      if (!module) return { error: `Module inconnu — donnez le nom du module (champ « module », ex. « Finances », « Drive »).` };

      const modeRaw = opStr(input, "mode").toLowerCase();
      const mode = /bloqu|interdit/.test(modeRaw) ? "BLOCKED"
        : /d[ée]faut|r[ôo]le|standard/.test(modeRaw) ? "DEFAULT"
        : "CUSTOM";
      const give = opStr(input, "give").toUpperCase().split(/[;,\s]+/).filter((a) => (ACCESS_ACTIONS as readonly string[]).includes(a));
      const take = opStr(input, "take").toUpperCase().split(/[;,\s]+/).filter((a) => (ACCESS_ACTIONS as readonly string[]).includes(a));
      if (mode === "CUSTOM" && give.length === 0 && take.length === 0 && !opStr(input, "scope")) {
        return { error: "Précisez le réglage : « mode » (défaut | bloqué), des droits à donner (« give » : CREATE, UPDATE, DELETE, VALIDATE, EXPORT, UPLOAD), à retirer (« take »), ou la portée (« scope » : tout | assigné)." };
      }

      // FUSION : la matrice de LA PERSONNE est relue module par module et rejouée à l'identique —
      // seule la case (personne, module) visée change. L'action canonique remplace TOUT (mode
      // absent = réglage supprimé), donc l'op reconstruit l'état complet.
      const existing = await prisma.userAccess.findMany({ where: { userId: person.id } });
      const args: Record<string, string | null> = { userId: person.id };
      for (const row of existing) {
        if (row.module === module) continue;
        args[`mode_${row.module}`] = row.canView ? "CUSTOM" : "BLOCKED";
        args[`scope_${row.module}`] = row.scope;
        const acts: [string, boolean][] = [["CREATE", row.canCreate], ["UPDATE", row.canUpdate], ["DELETE", row.canDelete], ["VALIDATE", row.canValidate], ["EXPORT", row.canExport], ["UPLOAD", row.canUpload]];
        for (const [a, on] of acts) if (on) args[`actlist_${row.module}`] = `${args[`actlist_${row.module}`] ?? ""}${a},`;
      }

      const current = existing.find((r) => r.module === module);
      let summary = "";
      if (mode === "DEFAULT") {
        summary = "Retour au DÉFAUT du rôle (le réglage individuel est retiré).";
      } else if (mode === "BLOCKED") {
        args[`mode_${module}`] = "BLOCKED";
        summary = "Module BLOQUÉ pour cette personne (aucun accès, quel que soit le rôle).";
      } else {
        const set = new Set<string>();
        if (current?.canView) {
          if (current.canCreate) set.add("CREATE");
          if (current.canUpdate) set.add("UPDATE");
          if (current.canDelete) set.add("DELETE");
          if (current.canValidate) set.add("VALIDATE");
          if (current.canExport) set.add("EXPORT");
          if (current.canUpload) set.add("UPLOAD");
        }
        for (const a of give) set.add(a);
        for (const a of take) set.delete(a);
        args[`mode_${module}`] = "CUSTOM";
        args[`actlist_${module}`] = [...set].map((a) => `${a},`).join("");
        const scopeRaw = opStr(input, "scope").toLowerCase();
        args[`scope_${module}`] = /tout|all|global/.test(scopeRaw) ? "ALL" : scopeRaw ? "ASSIGNED" : (current?.scope ?? "ASSIGNED");
        summary = `Droits personnalisés : ${[...set].join(", ") || "lecture seule"} (portée ${args[`scope_${module}`] === "ALL" ? "TOUT" : "assigné"}).`;
      }

      return {
        title: `Accès de ${person.name} au module « ${MODULE_LABELS[module] ?? module} »`,
        fields: [
          { label: "Personne", value: person.name },
          { label: "Module", value: MODULE_LABELS[module] ?? module },
          { label: "Réglage", value: summary },
          { label: "Autres modules", value: "rejoués à l'identique (aucun autre réglage ne bouge)" },
        ],
        warnings: ["CONTRÔLE D'ACCÈS : le changement prend effet immédiatement pour cette personne."],
        args,
        successMessage: `Accès de ${person.name} à « ${MODULE_LABELS[module] ?? module} » réglé.`,
        revalidate: ["/admin/users"],
      };
    },
    async execute(args) {
      const fd = new FormData();
      fd.set("userId", args.userId ?? "");
      for (const [k, v] of Object.entries(args)) {
        if (!v || k === "userId") continue;
        if (k.startsWith("mode_") || k.startsWith("scope_")) fd.set(k, v);
        else if (k.startsWith("actlist_")) {
          const module = k.slice("actlist_".length);
          for (const a of v.split(",").filter(Boolean)) fd.set(`act_${module}_${a}`, "on");
        }
      }
      const r = await saveAccessMatrix(fd);
      if (!r.ok) return { ok: false, error: r.error ?? "Le réglage d'accès a été refusé." };
      return { ok: true, revalidate: ["/admin/users"] };
    },
  },

  update_user_profile: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const person = await resolveUser(opStr(input, "person") || opStr(input, "name"));
      if ("error" in person) return person;
      const current = await prisma.user.findUnique({ where: { id: person.id }, select: { name: true, email: true, title: true, region: true } });
      if (!current) return { error: "Compte introuvable." };
      const newName = opStr(input, "newName");
      const email = opStr(input, "email").toLowerCase();
      const title = opStr(input, "title");
      const region = opStr(input, "region");
      if (!newName && !email && !title && !region) {
        return { error: "Précisez ce qui change : « newName », « email » (identifiant de connexion), « title » (fonction) ou « region ». (Le rôle passe par set_account_role, l'activation par set_account_active.)" };
      }
      return {
        title: `Profil du compte de ${current.name}`,
        fields: fieldsOf([
          ["Compte", `${current.name} (${current.email})`],
          ["Nom", newName ? `${current.name} → ${newName}` : null],
          ["E-mail de connexion", email ? `${current.email} → ${email}` : null],
          ["Fonction", title ? `${current.title ?? "—"} → ${title}` : null],
          ["Région", region ? `${current.region ?? "—"} → ${region}` : null],
        ]),
        warnings: email ? ["L'e-mail est l'IDENTIFIANT DE CONNEXION : la personne se connectera désormais avec la nouvelle adresse (unicité vérifiée par l'action)."] : [],
        // FUSION : title/region sont REMPLACÉS par l'action — les valeurs existantes sont rejouées.
        args: { userId: person.id, name: newName || null, email: email || null, title: title || current.title, region: region || current.region },
        successMessage: `Profil de ${newName || current.name} mis à jour.`,
        revalidate: ["/admin/users"],
      };
    },
    execute: (args) => runFd(updateUserProfile, args, "La mise à jour du profil a été refusée.", { revalidate: ["/admin/users"] }),
  },

  revoke_sessions: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const person = await resolveUser(opStr(input, "person") || opStr(input, "name"));
      if ("error" in person) return person;
      const open = await prisma.userSession.count({ where: { userId: person.id, revokedAt: null } });
      return {
        title: `Déconnecter ${person.name} de partout (${open} session·s active·s)`,
        fields: [
          { label: "Personne", value: person.name },
          { label: "Sessions actives", value: String(open) },
        ],
        warnings: ["Toutes les sessions ouvertes sont révoquées : la personne devra se reconnecter sur chaque appareil. Le compte reste actif."],
        args: { userId: person.id },
        successMessage: `${person.name} déconnecté·e de toutes ses sessions.`,
        revalidate: ["/admin/users"],
      };
    },
    execute: (args) => runFd(revokeAllSessions, args, "La révocation a été refusée.", { revalidate: ["/admin/users"] }),
  },

  request_user_onboarding: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const person = await resolveUser(opStr(input, "person") || opStr(input, "name"));
      if ("error" in person) return person;
      return {
        title: `Relancer le setup guidé de ${person.name}`,
        fields: [{ label: "Personne", value: person.name }],
        warnings: ["À sa prochaine navigation, la personne sera redirigée vers le parcours de configuration guidé."],
        args: { userId: person.id },
        successMessage: `Setup guidé demandé pour ${person.name}.`,
        revalidate: ["/admin/users"],
      };
    },
    execute: (args) => runFd(requestOnboarding, args, "La demande de setup a été refusée.", { revalidate: ["/admin/users"] }),
  },
};
