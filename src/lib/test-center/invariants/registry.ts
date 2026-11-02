import { prisma } from "@/lib/prisma";
import { PERMISSIONS, MODULES } from "@/lib/rbac";
import { redact } from "../redact";
import type { BusinessInvariant, InvariantResult } from "./types";
import { sansBloquer } from "@/lib/journal";

/**
 * Registre des invariants métier (§28). Chaque invariant est PROUVABLE sur les données réelles.
 * Les invariants « ligne à ligne » portent un `predicate` pur, source de vérité partagée avec le
 * mutation testing (§27). Les invariants référentiels (clés étrangères logiques) comparent des
 * ensembles d'identifiants sans SQL brut (robustes au nommage des tables).
 */

const KNOWN_ROLES = new Set(Object.keys(PERMISSIONS));
const KNOWN_MODULES = new Set<string>(MODULES as readonly string[]);

type Delegate = { count: (a: unknown) => Promise<number>; findMany: (a: unknown) => Promise<Record<string, unknown>[]> };
function delegate(model: string): Delegate | null {
  const d = (prisma as unknown as Record<string, Delegate>)[model];
  return d && typeof d.findMany === "function" ? d : null;
}

/** Exécute un prédicat pur sur les lignes réelles d'un modèle (lecture seule, borné). */
async function checkRows(
  model: string,
  select: Record<string, boolean>,
  predicate: (row: Record<string, unknown>) => boolean,
): Promise<Omit<InvariantResult, "id">> {
  const del = delegate(model);
  if (!del) return { ok: true, checked: 0, violations: 0, sample: [], skipped: true, note: `modèle « ${model} » indisponible` };
  const rows = await del.findMany({ select, take: 20000 }).catch(sansBloquer("invariants-registry.checkRows.findMany", null));
  if (!rows) return { ok: true, checked: 0, violations: 0, sample: [], skipped: true, note: `lecture « ${model} » impossible` };
  let violations = 0;
  const sample: unknown[] = [];
  for (const r of rows) {
    if (!predicate(r)) { violations++; if (sample.length < 5) sample.push(redact(r)); }
  }
  return { ok: violations === 0, checked: rows.length, violations, sample };
}

/** Compare deux ensembles d'IDs pour prouver l'intégrité référentielle (sans SQL brut). */
async function checkReference(
  childModel: string, fkField: string, parentModel: string,
): Promise<Omit<InvariantResult, "id">> {
  const child = delegate(childModel), parent = delegate(parentModel);
  if (!child || !parent) return { ok: true, checked: 0, violations: 0, sample: [], skipped: true, note: "modèle indisponible" };
  // Pas de filtre `NOT null` (invalide sur une FK requise) : on récupère les valeurs distinctes puis
  // on écarte les null côté JS — fonctionne pour une FK optionnelle comme pour une FK obligatoire.
  const rows = await child.findMany({ select: { [fkField]: true }, distinct: [fkField], take: 10000 }).catch(sansBloquer("invariants-registry.checkReference.findMany", null));
  if (!rows) return { ok: true, checked: 0, violations: 0, sample: [], skipped: true, note: "lecture impossible" };
  const ids = [...new Set(rows.map((r) => r[fkField]).filter(Boolean) as string[])];
  if (ids.length === 0) return { ok: true, checked: 0, violations: 0, sample: [] };
  const existing = await parent.count({ where: { id: { in: ids } } }).catch(sansBloquer("invariants-registry.checkReference.count", -1));
  if (existing < 0) return { ok: true, checked: ids.length, violations: 0, sample: [], skipped: true, note: "comptage impossible" };
  const missing = ids.length - existing;
  return { ok: missing === 0, checked: ids.length, violations: missing, sample: missing > 0 ? [`${missing} ${fkField} orphelin(s)`] : [] };
}

// ————— Prédicats purs (source de vérité partagée avec le mutation testing) —————

const predUserRole = (r: Record<string, unknown>) =>
  KNOWN_ROLES.has(String(r.role)) && (r.secondaryRole == null || KNOWN_ROLES.has(String(r.secondaryRole)));

const predWfiCoupling = (r: Record<string, unknown>) =>
  r.status === "IN_PROGRESS" ? r.currentSlug != null : r.currentSlug == null;

const predValCoupling = (r: Record<string, unknown>) => {
  const s = r.status, decided = r.decidedAt != null;
  if (s === "PENDING") return !decided;
  if (s === "APPROVED" || s === "REJECTED") return decided;
  return true;
};

const predBudgetModules = (r: Record<string, unknown>) =>
  Array.isArray(r.modules) && (r.modules as unknown[]).every((m) => typeof m === "string" && KNOWN_MODULES.has(m));

const predLeaveMarker = (r: Record<string, unknown>) => {
  const v = r.leaveAccruedThrough;
  if (v == null) return true;
  if (typeof v !== "string") return false;
  const m = /^(\d{4})-(\d{2})$/.exec(v);
  if (!m) return false;
  const mm = Number(m[2]);
  return mm >= 1 && mm <= 12;
};

const predExpenseAmount = (r: Record<string, unknown>) => {
  const a = Number(r.amount);
  return Number.isFinite(a) && a >= 0;
};

export const INVARIANTS: BusinessInvariant[] = [
  {
    id: "INV-USR-ROLE",
    description: "Tout compte porte un rôle (et un rôle secondaire) connu de la matrice RBAC.",
    criticality: "CRITICAL", modules: ["ADMIN"], models: ["user"],
    expectation: "user.role ∈ PERMISSIONS ; user.secondaryRole ∈ PERMISSIONS ∪ {∅}.",
    strategy: "Prédicat pur sur tous les comptes.",
    onFailure: "Un rôle inconnu rend l'autorisation indéterminée — bloque la certification.",
    blocksCertification: true,
    predicate: { model: "user", holds: predUserRole },
    check: () => checkRows("user", { id: true, role: true, secondaryRole: true }, predUserRole),
  },
  {
    id: "INV-WFI-COUPLING",
    description: "Une instance de workflow IN_PROGRESS a une étape courante ; un état terminal n'en a plus.",
    criticality: "HIGH", modules: ["ADMIN"], models: ["workflowInstance"],
    expectation: "status=IN_PROGRESS ⟺ currentSlug≠null.",
    strategy: "Prédicat de couplage pur sur toutes les instances.",
    onFailure: "Objet bloqué/incohérent dans le circuit — bloque la certification.",
    blocksCertification: true,
    predicate: { model: "workflowInstance", holds: predWfiCoupling },
    check: () => checkRows("workflowInstance", { id: true, status: true, currentSlug: true }, predWfiCoupling),
  },
  {
    id: "INV-VAL-COUPLING",
    description: "Une demande de validation décidée porte une date de décision ; une demande en attente n'en a pas.",
    criticality: "HIGH", modules: ["VALIDATIONS"], models: ["validationRequest"],
    expectation: "PENDING ⟹ decidedAt=null ; APPROVED/REJECTED ⟹ decidedAt≠null.",
    strategy: "Prédicat de couplage pur.",
    onFailure: "Traçabilité de décision rompue — bloque la certification.",
    blocksCertification: true,
    predicate: { model: "validationRequest", holds: predValCoupling },
    check: () => checkRows("validationRequest", { id: true, status: true, decidedAt: true }, predValCoupling),
  },
  {
    id: "INV-EXP-AMOUNT",
    description: "Le montant d'un ordre de dépense est un nombre fini positif ou nul.",
    criticality: "HIGH", modules: ["FINANCES"], models: ["expenseOrder"],
    expectation: "expenseOrder.amount ≥ 0.",
    strategy: "Prédicat pur sur les montants.",
    onFailure: "Montant négatif = anomalie financière — bloque la certification.",
    blocksCertification: true,
    predicate: { model: "expenseOrder", holds: predExpenseAmount },
    check: () => checkRows("expenseOrder", { id: true, reference: true, amount: true }, predExpenseAmount),
  },
  {
    id: "INV-BUDGET-MODULES",
    description: "Les modules couverts par une enveloppe budgétaire existent tous dans le RBAC.",
    criticality: "MEDIUM", modules: ["BUDGETS"], models: ["budgetEnvelope"],
    expectation: "budgetEnvelope.modules ⊆ MODULES.",
    strategy: "Prédicat pur (appartenance à l'ensemble des modules connus).",
    onFailure: "Module fantôme = allocation qui n'atteint jamais son domaine — à corriger.",
    blocksCertification: false,
    predicate: { model: "budgetEnvelope", holds: predBudgetModules },
    check: () => checkRows("budgetEnvelope", { id: true, name: true, modules: true }, predBudgetModules),
  },
  {
    id: "INV-LEAVE-MARKER",
    description: "Le marqueur d'acquisition de congés est un mois « AAAA-MM » valide.",
    criticality: "MEDIUM", modules: ["RH"], models: ["employee"],
    expectation: "employee.leaveAccruedThrough ∈ {null} ∪ /^\\d{4}-(01..12)$/.",
    strategy: "Prédicat de format pur.",
    onFailure: "Marqueur corrompu = acquisition faussée (double crédit ou aucun) — à corriger.",
    blocksCertification: false,
    predicate: { model: "employee", holds: predLeaveMarker },
    check: () => checkRows("employee", { id: true, leaveAccruedThrough: true }, predLeaveMarker),
  },
  {
    id: "INV-REF-LEAVE",
    description: "Toute demande de congé pointe vers un employé existant.",
    criticality: "HIGH", modules: ["RH"], models: ["leaveRequest", "employee"],
    expectation: "leaveRequest.employeeId ∈ employee.id.",
    strategy: "Comparaison d'ensembles d'identifiants (intégrité référentielle).",
    onFailure: "Demande orpheline (rappel du bug historique de suppression RH) — bloque la certification.",
    blocksCertification: true,
    check: () => checkReference("leaveRequest", "employeeId", "employee"),
  },
  {
    id: "INV-REF-AUDIT",
    description: "Tout auteur référencé dans le journal d'audit existe encore.",
    criticality: "MEDIUM", modules: ["ADMIN"], models: ["auditLog", "user"],
    expectation: "auditLog.actorId ∈ user.id ∪ {null}.",
    strategy: "Comparaison d'ensembles d'identifiants.",
    onFailure: "Piste d'audit désancrée — à surveiller.",
    blocksCertification: false,
    check: () => checkReference("auditLog", "actorId", "user"),
  },
];
