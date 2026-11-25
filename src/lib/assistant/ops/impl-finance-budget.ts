import { prisma } from "@/lib/prisma";
import { toNumber } from "@/lib/utils";
import {
  setBudgetTotal, createEnvelope, updateEnvelope, deleteEnvelope,
  createBudgetCategory, updateBudgetCategory, deleteBudgetCategory,
  attributeTransaction, addBudgetExpense, updateBudgetExpense, deleteBudgetExpense,
} from "@/lib/actions/budget-envelope-actions";
import {
  setDepartmentBudgetAccess, setDepartmentBudget, requestDepartmentBudget,
  addDepartmentExpense, updateDepartmentExpense, deleteDepartmentExpense,
} from "@/lib/actions/department-budget-actions";
import type { OpImpl, OpProposalDraft } from "./types";
import { opStr } from "./types";
import { runFd, dzd, fieldsOf, resolveOne } from "./helpers";

/**
 * OPS BUDGETS — enveloppes, catégories, dépenses imputées, budgets départementaux : par les
 * ACTIONS CANONIQUES des écrans Budgets. Invariants : résolution par NOM (ambiguïté LISTÉE),
 * FUSION pour les updates partiels (l'action canonique REMPLACE — l'op relit et rejoue les
 * champs absents), suppressions CRITIQUES à ressaisie.
 */

const num = (input: Record<string, unknown>, key: string): number | null => {
  const v = input[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v.replace(/[\s  ]/g, "").replace(",", "."));
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

const resolveEnvelope = (raw: string) =>
  resolveOne(raw, "l'enveloppe budgétaire (champ « envelope »)",
    (q) => prisma.budgetEnvelope.findMany({ where: { name: { contains: q, mode: "insensitive" } }, select: { id: true, name: true }, take: 6 }),
    (e) => e.name);

const resolveCategory = (raw: string) =>
  resolveOne(raw, "la catégorie budgétaire (champ « category »)",
    (q) => prisma.budgetCategoryLine.findMany({ where: { name: { contains: q, mode: "insensitive" } }, select: { id: true, name: true, envelope: { select: { name: true } } }, take: 6 }),
    (c) => `${c.name} (${c.envelope.name})`);

const resolveBudgetExpense = (raw: string) =>
  resolveOne(raw, "la dépense imputée (champ « expense » — sa référence)",
    (q) => prisma.budgetExpenseLine.findMany({ where: { reference: { contains: q, mode: "insensitive" } }, select: { id: true, reference: true, amount: true, notes: true, category: { select: { name: true } } }, take: 6 }),
    (e) => `${e.reference} (${e.category.name}, ${dzd(toNumber(e.amount))})`);

const resolveDept = (raw: string) =>
  resolveOne(raw, "le département (champ « department »)",
    (q) => prisma.department.findMany({ where: { name: { contains: q, mode: "insensitive" } }, select: { id: true, name: true }, take: 6 }),
    (d) => d.name);

const resolvePerson = (raw: string) =>
  resolveOne(raw, "la personne",
    (q) => prisma.user.findMany({ where: { name: { contains: q, mode: "insensitive" }, isActive: true }, select: { id: true, name: true }, take: 6 }),
    (u) => u.name);

const resolveDeptExpense = (raw: string) =>
  resolveOne(raw, "la dépense départementale (champ « expense » — son libellé)",
    (q) => prisma.departmentBudgetExpense.findMany({ where: { label: { contains: q, mode: "insensitive" } }, select: { id: true, label: true, amount: true, kind: true, notes: true, year: true, department: { select: { name: true } } }, take: 6 }),
    (e) => `${e.label} (${e.department.name}, ${dzd(toNumber(e.amount))})`);

const DEPT_BUDGET_KINDS = ["OPERATING", "HR", "ACTIVITY"] as const;
const kindOf = (raw: string): string | null => {
  const q = raw.toUpperCase().trim();
  if ((DEPT_BUDGET_KINDS as readonly string[]).includes(q)) return q;
  const map: Record<string, string> = {
    "moyens generaux": "OPERATING", "moyens généraux": "OPERATING", fonctionnement: "OPERATING",
    "masse salariale": "HR", rh: "HR", salaires: "HR",
    activite: "ACTIVITY", "activité": "ACTIVITY", metier: "ACTIVITY", "métier": "ACTIVITY",
  };
  return map[raw.toLowerCase().trim()] ?? null;
};

export const FINANCE_BUDGET_OPS_IMPL: Record<string, OpImpl> = {
  set_budget_total: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const mode = opStr(input, "mode").toUpperCase() === "FIXED" ? "FIXED" : "FLEXIBLE";
      const total = num(input, "total");
      if (mode === "FIXED" && (total === null || total <= 0)) return { error: "En mode FIXE, précisez le total annuel (champ « total »)." };
      return {
        title: mode === "FIXED" ? `Budget global FIXE : ${dzd(total ?? 0)}` : "Budget global FLEXIBLE (somme des enveloppes)",
        fields: fieldsOf([["Mode", mode === "FIXED" ? "Fixe" : "Flexible"], ["Total", total !== null ? dzd(total) : null]]),
        args: { mode, budgetFixedTotal: total !== null ? String(total) : null },
        successMessage: "Réglage du budget global enregistré.",
        revalidate: ["/budgets"],
      };
    },
    execute: (args) => runFd(setBudgetTotal, args, "Le réglage du budget global a été refusé.", { revalidate: ["/budgets"] }),
  },

  create_envelope: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const name = opStr(input, "name");
      const amount = num(input, "amount");
      if (!name) return { error: "Précisez le nom de l'enveloppe (champ « name »)." };
      return {
        title: `Créer l'enveloppe « ${name} »${amount !== null ? ` — ${dzd(amount)}` : ""}`,
        fields: fieldsOf([["Enveloppe", name], ["Montant", amount !== null ? dzd(amount) : null], ["Notes", opStr(input, "notes") || null]]),
        args: { name, totalAmount: amount !== null ? String(amount) : "0", notes: opStr(input, "notes") || null },
        successMessage: `Enveloppe « ${name} » créée.`,
        link: "/budgets", revalidate: ["/budgets"],
      };
    },
    execute: (args) => runFd(createEnvelope, args, "La création de l'enveloppe a été refusée.", { revalidate: ["/budgets"] }),
  },

  update_envelope: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const env = await resolveEnvelope(opStr(input, "envelope") || opStr(input, "name"));
      if ("error" in env) return env;
      // FUSION INTÉGRALE : updateEnvelope REMPLACE aussi les modules, les listes d'accès /
      // de gestion et le drapeau actif — un simple renommage qui ne les rejouerait pas
      // viderait les accès et désactiverait l'enveloppe.
      const current = await prisma.budgetEnvelope.findUnique({
        where: { id: env.id },
        select: {
          name: true, totalAmount: true, notes: true, isActive: true, modules: true,
          accessRoles: true, accessUserIds: true, managerRoles: true, managerUserIds: true,
        },
      });
      if (!current) return { error: "Enveloppe introuvable." };
      const newName = opStr(input, "newName") || current.name;
      const amount = num(input, "amount");
      const notes = opStr(input, "notes");
      return {
        title: `Modifier l'enveloppe « ${current.name} »`,
        fields: fieldsOf([
          ["Nom", newName !== current.name ? `${current.name} → ${newName}` : current.name],
          ["Montant", amount !== null ? `${dzd(toNumber(current.totalAmount))} → ${dzd(amount)}` : dzd(toNumber(current.totalAmount))],
          ["Notes", notes || null],
          ["Accès", "inchangés (rejoués à l'identique)"],
        ]),
        args: {
          id: env.id, name: newName, totalAmount: String(amount ?? toNumber(current.totalAmount)),
          notes: notes || current.notes || null, isActive: current.isActive ? "1" : null,
          modules: current.modules.join(","), accessRoles: current.accessRoles.join(","),
          accessUserIds: current.accessUserIds.join(","), managerRoles: current.managerRoles.join(","),
          managerUserIds: current.managerUserIds.join(","),
        },
        successMessage: `Enveloppe « ${newName} » mise à jour.`,
        revalidate: ["/budgets"],
      };
    },
    async execute(args) {
      const fd = new FormData();
      for (const k of ["id", "name", "totalAmount", "notes", "isActive"]) {
        if (args[k]) fd.set(k, args[k] as string);
      }
      for (const k of ["modules", "accessRoles", "accessUserIds", "managerRoles", "managerUserIds"]) {
        for (const v of (args[k] ?? "").split(",").filter(Boolean)) fd.append(k, v);
      }
      const r = await updateEnvelope(fd);
      if (!r.ok) return { ok: false, error: r.error ?? "La modification de l'enveloppe a été refusée." };
      return { ok: true, revalidate: ["/budgets"] };
    },
  },

  delete_envelope: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const env = await resolveEnvelope(opStr(input, "envelope") || opStr(input, "name"));
      if ("error" in env) return env;
      return {
        title: `SUPPRIMER l'enveloppe « ${env.name} »`,
        fields: [{ label: "Enveloppe", value: env.name }],
        warnings: ["Mise à la corbeille avec ses catégories : ses dépenses redeviennent « à imputer » (elles s'y rattachent de nouveau si le Super Admin la restaure)."],
        confirmText: env.name,
        // Le nom retapé : la même confirmation que l'écran (`deleteEnvelope` la revérifie).
        args: { id: env.id, nom: env.name },
        successMessage: `Enveloppe « ${env.name} » supprimée.`,
        revalidate: ["/budgets"],
      };
    },
    execute: (args) => runFd(deleteEnvelope, args, "La suppression de l'enveloppe a été refusée.", { revalidate: ["/budgets"] }),
  },

  create_budget_category: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const env = await resolveEnvelope(opStr(input, "envelope"));
      if ("error" in env) return env;
      const name = opStr(input, "name");
      if (!name) return { error: "Précisez le nom de la catégorie (champ « name »)." };
      const allocated = num(input, "allocated") ?? num(input, "amount");
      let parentId: string | null = null;
      const parentRaw = opStr(input, "parent");
      if (parentRaw) {
        const parent = await resolveCategory(parentRaw);
        if ("error" in parent) return parent;
        parentId = parent.id;
      }
      return {
        title: `Créer la catégorie « ${name} » dans « ${env.name} »`,
        fields: fieldsOf([["Catégorie", name], ["Enveloppe", env.name], ["Alloué", allocated !== null ? dzd(allocated) : null], ["Sous-catégorie de", parentRaw || null]]),
        args: { envelopeId: env.id, name, allocated: allocated !== null ? String(allocated) : "0", parentId, module: opStr(input, "module") || null, notes: opStr(input, "notes") || null },
        successMessage: `Catégorie « ${name} » créée.`,
        revalidate: ["/budgets"],
      };
    },
    execute: (args) => runFd(createBudgetCategory, args, "La création de la catégorie a été refusée.", { revalidate: ["/budgets"] }),
  },

  update_budget_category: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const cat = await resolveCategory(opStr(input, "category") || opStr(input, "name"));
      if ("error" in cat) return cat;
      const current = await prisma.budgetCategoryLine.findUnique({ where: { id: cat.id }, select: { name: true, allocated: true, color: true, notes: true, module: true, parentId: true } });
      if (!current) return { error: "Catégorie introuvable." };
      const newName = opStr(input, "newName") || current.name;
      const allocated = num(input, "allocated") ?? num(input, "amount");
      return {
        title: `Modifier la catégorie « ${current.name} »`,
        fields: fieldsOf([
          ["Nom", newName !== current.name ? `${current.name} → ${newName}` : current.name],
          ["Alloué", allocated !== null ? `${dzd(toNumber(current.allocated))} → ${dzd(allocated)}` : dzd(toNumber(current.allocated))],
        ]),
        args: {
          id: cat.id, name: newName, allocated: String(allocated ?? toNumber(current.allocated)),
          color: current.color, notes: opStr(input, "notes") || current.notes || null,
          module: current.module, parentId: current.parentId,
        },
        successMessage: `Catégorie « ${newName} » mise à jour.`,
        revalidate: ["/budgets"],
      };
    },
    execute: (args) => runFd(updateBudgetCategory, args, "La modification de la catégorie a été refusée.", { revalidate: ["/budgets"] }),
  },

  delete_budget_category: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const cat = await resolveCategory(opStr(input, "category") || opStr(input, "name"));
      if ("error" in cat) return cat;
      return {
        title: `SUPPRIMER la catégorie « ${cat.name} »`,
        fields: [{ label: "Catégorie", value: `${cat.name} (${cat.envelope.name})` }],
        warnings: ["Suppression définitive de la catégorie et de ses imputations."],
        confirmText: cat.name,
        args: { id: cat.id },
        successMessage: `Catégorie « ${cat.name} » supprimée.`,
        revalidate: ["/budgets"],
      };
    },
    execute: (args) => runFd(deleteBudgetCategory, args, "La suppression de la catégorie a été refusée.", { revalidate: ["/budgets"] }),
  },

  attribute_transaction: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const tx = await resolveOne(opStr(input, "transaction"), "l'écriture (champ « transaction » — son libellé)",
        (q) => prisma.financeTransaction.findMany({ where: { label: { contains: q, mode: "insensitive" } }, orderBy: { date: "desc" }, select: { id: true, label: true, amount: true }, take: 6 }),
        (t) => `${t.label} (${dzd(toNumber(t.amount))})`);
      if ("error" in tx) return tx;
      const catRaw = opStr(input, "category");
      const none = /^(aucune?|retirer|null|)$/i.test(catRaw);
      let catId: string | null = null; let catLabel = "— retirée (plus d'imputation)";
      if (!none) {
        const cat = await resolveCategory(catRaw);
        if ("error" in cat) return cat;
        catId = cat.id; catLabel = `${cat.name} (${cat.envelope.name})`;
      }
      return {
        title: `Imputer « ${tx.label} » → ${none ? "aucune catégorie" : catLabel}`,
        fields: [{ label: "Écriture", value: `${tx.label} (${dzd(toNumber(tx.amount))})` }, { label: "Catégorie", value: catLabel }],
        args: { transactionId: tx.id, budgetCategoryId: catId },
        successMessage: "Imputation enregistrée.",
        revalidate: ["/budgets", "/finances"],
      };
    },
    execute: (args) => runFd(attributeTransaction, args, "L'imputation a été refusée.", { revalidate: ["/budgets", "/finances"] }),
  },

  add_budget_expense: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const cat = await resolveCategory(opStr(input, "category"));
      if ("error" in cat) return cat;
      const reference = opStr(input, "reference") || opStr(input, "label");
      const amount = num(input, "amount");
      if (!reference || amount === null) return { error: "Précisez la référence (« reference ») et le montant (« amount ») de la dépense." };
      return {
        title: `Dépense « ${reference} » — ${dzd(amount)} sur « ${cat.name} »`,
        fields: fieldsOf([["Catégorie", `${cat.name} (${cat.envelope.name})`], ["Référence", reference], ["Montant", dzd(amount)], ["Notes", opStr(input, "notes") || null]]),
        args: { budgetCategoryId: cat.id, reference, amount: String(amount), notes: opStr(input, "notes") || null },
        successMessage: `Dépense « ${reference} » imputée (${dzd(amount)}).`,
        revalidate: ["/budgets"],
      };
    },
    execute: (args) => runFd(addBudgetExpense, args, "L'ajout de la dépense a été refusé.", { revalidate: ["/budgets"] }),
  },

  update_budget_expense: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const exp = await resolveBudgetExpense(opStr(input, "expense") || opStr(input, "reference"));
      if ("error" in exp) return exp;
      const reference = opStr(input, "newReference") || exp.reference;
      const amount = num(input, "amount");
      return {
        title: `Modifier la dépense « ${exp.reference} »`,
        fields: fieldsOf([
          ["Référence", reference !== exp.reference ? `${exp.reference} → ${reference}` : exp.reference],
          ["Montant", amount !== null ? `${dzd(toNumber(exp.amount))} → ${dzd(amount)}` : dzd(toNumber(exp.amount))],
        ]),
        args: { id: exp.id, reference, amount: String(amount ?? toNumber(exp.amount)), notes: opStr(input, "notes") || exp.notes || null },
        successMessage: `Dépense « ${reference} » mise à jour.`,
        revalidate: ["/budgets"],
      };
    },
    execute: (args) => runFd(updateBudgetExpense, args, "La modification de la dépense a été refusée.", { revalidate: ["/budgets"] }),
  },

  delete_budget_expense: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const exp = await resolveBudgetExpense(opStr(input, "expense") || opStr(input, "reference"));
      if ("error" in exp) return exp;
      return {
        title: `SUPPRIMER la dépense « ${exp.reference} »`,
        fields: [{ label: "Dépense", value: `${exp.reference} (${exp.category.name}, ${dzd(toNumber(exp.amount))})` }],
        warnings: ["Suppression définitive : le consommé de la catégorie est recalculé."],
        confirmText: exp.reference,
        args: { id: exp.id },
        successMessage: `Dépense « ${exp.reference} » supprimée.`,
        revalidate: ["/budgets"],
      };
    },
    execute: (args) => runFd(deleteBudgetExpense, args, "La suppression de la dépense a été refusée.", { revalidate: ["/budgets"] }),
  },

  // ─────────────── Budgets DÉPARTEMENTAUX ───────────────

  set_department_budget_access: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      void user;
      const deptRaw = opStr(input, "department");
      const general = /^(general|général|tous|tout)$/i.test(deptRaw);
      const dept = general ? null : await resolveDept(deptRaw);
      if (dept && "error" in dept) return dept;
      const person = await resolvePerson(opStr(input, "person"));
      if ("error" in person) return person;
      const nature = kindOf(opStr(input, "nature") || "ACTIVITY") ?? (opStr(input, "nature").toLowerCase() === "acces" || opStr(input, "nature").toLowerCase() === "accès" ? "ACCESS" : null);
      const natureKey = opStr(input, "nature").toLowerCase().startsWith("acc") ? "access"
        : nature === "OPERATING" ? "operating" : nature === "HR" ? "hr" : nature === "ACTIVITY" ? "activity" : null;
      if (!natureKey) return { error: "Précisez la nature (champ « nature ») : accès | moyens généraux | masse salariale | activité." };
      const remove = /^(retire|retirer|remove|enleve|enlève)/i.test(opStr(input, "mode"));

      // FUSION : la matrice existante est relue, la personne AJOUTÉE ou RETIRÉE de la seule
      // liste visée, tout le reste rejoué à l'identique (l'action canonique REMPLACE la matrice).
      const existing = await prisma.departmentBudgetAccess.findFirst({
        where: dept ? { departmentId: dept.id } : { departmentId: null },
      });
      const lists = {
        accessRoles: existing?.accessRoles ?? [], accessUserIds: existing?.accessUserIds ?? [],
        operatingRoles: existing?.operatingRoles ?? [], operatingUserIds: existing?.operatingUserIds ?? [],
        hrRoles: existing?.hrRoles ?? [], hrUserIds: existing?.hrUserIds ?? [],
        activityRoles: existing?.activityRoles ?? [], activityUserIds: existing?.activityUserIds ?? [],
      };
      const key = `${natureKey}UserIds` as keyof typeof lists;
      const set = new Set(lists[key]);
      if (remove) set.delete(person.id); else set.add(person.id);
      lists[key] = [...set];

      const args: Record<string, string | null> = { departmentId: dept ? dept.id : "__GENERAL__" };
      for (const [k, v] of Object.entries(lists)) args[k] = v.join(",");
      return {
        title: `${remove ? "Retirer" : "Donner"} l'accès budget (${natureKey}) ${remove ? "à" : "à"} ${person.name} — ${dept ? dept.name : "tous les départements"}`,
        fields: [
          { label: "Département", value: dept ? dept.name : "Règle générale (tous)" },
          { label: "Personne", value: person.name },
          { label: "Nature", value: natureKey },
          { label: "Après le geste", value: `${set.size} personne(s) sur cette nature` },
        ],
        warnings: ["La matrice d'accès est REMPLACÉE par la version affichée (les autres natures sont rejouées à l'identique)."],
        args,
        successMessage: `Accès budget (${natureKey}) ${remove ? "retiré à" : "donné à"} ${person.name}.`,
        revalidate: ["/budgets/departements"],
      };
    },
    async execute(args) {
      const fd = new FormData();
      fd.set("departmentId", args.departmentId ?? "__GENERAL__");
      for (const k of ["accessRoles", "accessUserIds", "operatingRoles", "operatingUserIds", "hrRoles", "hrUserIds", "activityRoles", "activityUserIds"]) {
        for (const v of (args[k] ?? "").split(",").filter(Boolean)) fd.append(k, v);
      }
      const r = await setDepartmentBudgetAccess(fd);
      if (!r.ok) return { ok: false, error: r.error ?? "Le réglage des accès a été refusé." };
      return { ok: true, revalidate: ["/budgets/departements"] };
    },
  },

  set_department_budget: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const dept = await resolveDept(opStr(input, "department"));
      if ("error" in dept) return dept;
      const kind = kindOf(opStr(input, "kind"));
      const amount = num(input, "amount");
      if (!kind) return { error: "Précisez la nature (champ « kind ») : moyens généraux (OPERATING) | masse salariale (HR) | activité (ACTIVITY)." };
      if (amount === null) return { error: "Précisez le montant (champ « amount »)." };
      const year = num(input, "year");
      return {
        title: `Budget ${kind} de ${dept.name} : ${dzd(amount)}${year ? ` (${year})` : ""}`,
        fields: fieldsOf([["Département", dept.name], ["Nature", kind], ["Montant", dzd(amount)], ["Année", year ? String(year) : null]]),
        args: { departmentId: dept.id, kind, amount: String(amount), year: year ? String(year) : null, notes: opStr(input, "notes") || null },
        successMessage: `Budget ${kind} de ${dept.name} réglé à ${dzd(amount)}.`,
        revalidate: ["/budgets/departements"],
      };
    },
    execute: (args) => runFd(setDepartmentBudget, args, "Le réglage du budget départemental a été refusé.", { revalidate: ["/budgets/departements"] }),
  },

  request_department_budget: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const dept = await resolveDept(opStr(input, "department"));
      if ("error" in dept) return dept;
      const kind = kindOf(opStr(input, "kind"));
      const amount = num(input, "amount");
      const reason = opStr(input, "reason");
      if (!kind || amount === null) return { error: "Précisez la nature (« kind ») et le montant (« amount »)." };
      if (!reason) return { error: "Précisez le motif (champ « reason ») — une demande de budget se justifie." };
      return {
        title: `Demander ${dzd(amount)} (${kind}) pour ${dept.name}`,
        fields: fieldsOf([["Département", dept.name], ["Nature", kind], ["Montant", dzd(amount)], ["Motif", reason]]),
        args: { departmentId: dept.id, kind, amount: String(amount), year: num(input, "year") ? String(num(input, "year")) : null, reason },
        successMessage: `Demande de budget ${kind} (${dzd(amount)}) envoyée pour ${dept.name}.`,
        revalidate: ["/budgets/departements"],
      };
    },
    execute: (args) => runFd(requestDepartmentBudget, args, "La demande de budget a été refusée.", { revalidate: ["/budgets/departements"] }),
  },

  add_department_expense: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const dept = await resolveDept(opStr(input, "department"));
      if ("error" in dept) return dept;
      const kind = kindOf(opStr(input, "kind") || "OPERATING");
      const label = opStr(input, "label");
      const amount = num(input, "amount");
      if (!label || amount === null) return { error: "Précisez le libellé (« label ») et le montant (« amount ») de la dépense." };
      const source = opStr(input, "paymentSource").toUpperCase() === "CASH" ? "CASH" : opStr(input, "paymentSource") ? "OUT" : null;
      return {
        title: `Dépense « ${label} » — ${dzd(amount)} (${dept.name}, ${kind})`,
        fields: fieldsOf([["Département", dept.name], ["Nature", kind], ["Libellé", label], ["Montant", dzd(amount)], ["Règlement", source === "CASH" ? "caisse d'avance" : source === "OUT" ? "hors caisse" : null]]),
        args: { departmentId: dept.id, kind: kind ?? "OPERATING", label, amount: String(amount), paymentSource: source, year: num(input, "year") ? String(num(input, "year")) : null, notes: opStr(input, "notes") || null },
        successMessage: `Dépense « ${label} » (${dzd(amount)}) enregistrée pour ${dept.name}.`,
        revalidate: ["/budgets/departements", "/moyens-generaux"],
      };
    },
    execute: (args) => runFd(addDepartmentExpense, args, "L'enregistrement de la dépense a été refusé.", { revalidate: ["/budgets/departements", "/moyens-generaux"] }),
  },

  update_department_expense: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const exp = await resolveDeptExpense(opStr(input, "expense") || opStr(input, "label"));
      if ("error" in exp) return exp;
      const label = opStr(input, "newLabel") || exp.label;
      const amount = num(input, "amount");
      return {
        title: `Modifier la dépense « ${exp.label} » (${exp.department.name})`,
        fields: fieldsOf([
          ["Libellé", label !== exp.label ? `${exp.label} → ${label}` : exp.label],
          ["Montant", amount !== null ? `${dzd(toNumber(exp.amount))} → ${dzd(amount)}` : dzd(toNumber(exp.amount))],
        ]),
        args: { id: exp.id, kind: exp.kind, label, amount: String(amount ?? toNumber(exp.amount)), notes: opStr(input, "notes") || exp.notes || null },
        successMessage: `Dépense « ${label} » mise à jour.`,
        revalidate: ["/budgets/departements", "/moyens-generaux"],
      };
    },
    execute: (args) => runFd(updateDepartmentExpense, args, "La modification de la dépense a été refusée.", { revalidate: ["/budgets/departements", "/moyens-generaux"] }),
  },

  delete_department_expense: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const exp = await resolveDeptExpense(opStr(input, "expense") || opStr(input, "label"));
      if ("error" in exp) return exp;
      return {
        title: `SUPPRIMER la dépense « ${exp.label} » (${exp.department.name})`,
        fields: [{ label: "Dépense", value: `${exp.label} — ${dzd(toNumber(exp.amount))} (${exp.department.name}, ${exp.year})` }],
        warnings: ["Suppression définitive : le consommé du département est recalculé."],
        confirmText: exp.label,
        args: { id: exp.id },
        successMessage: `Dépense « ${exp.label} » supprimée.`,
        revalidate: ["/budgets/departements", "/moyens-generaux"],
      };
    },
    execute: (args) => runFd(deleteDepartmentExpense, args, "La suppression de la dépense a été refusée.", { revalidate: ["/budgets/departements", "/moyens-generaux"] }),
  },
};
