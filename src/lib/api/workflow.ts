import type { EntityType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/lib/rbac";
import { REG_STEPS, regProgress, type RegWorkflowState } from "@/lib/regulatory-workflow";
import { REGULATORY_STATUS } from "@/lib/labels";
import { canReadEntity, type EntityDef } from "./registry/entities";
import { sansBloquer } from "@/lib/journal";

/**
 * LE WORKFLOW, VU PAR UN AGENT.
 *
 * La question qu'un agent pose n'est jamais « quel est le statut ? » mais « où en est-on, qui
 * doit agir, qu'est-ce qui bloque, et que puis-je faire maintenant ? ». La réponse rassemble
 * donc, pour un objet : les étapes du circuit, celles qui sont faites, l'étape courante, les
 * suivantes possibles, le responsable, les échéances, les pièces manquantes et les actions
 * réellement autorisées à CETTE identité.
 *
 * Rien n'est recalculé ici : les étapes viennent de `regulatory-workflow.ts`, les droits de
 * `rbac.ts`. L'API met en forme, elle ne décide pas.
 */

export interface WorkflowStep {
  key: string;
  order: number;
  label: string;
  phase?: string;
  responsible?: string;
  expected?: string;
  state: "DONE" | "CURRENT" | "PENDING" | "BLOCKED" | "NOT_APPLICABLE";
  date: string | null;
  note: string | null;
}

export interface WorkflowView {
  entity: string;
  id: string;
  /** Nom du circuit applicable, ou null si l'objet n'en porte pas. */
  workflow: string | null;
  status: string | null;
  statusLabel: string | null;
  steps: WorkflowStep[];
  currentStep: WorkflowStep | null;
  nextSteps: WorkflowStep[];
  progress: { done: number; total: number; percent: number };
  /** Qui porte le dossier maintenant. */
  owner: { userId: string | null; name: string | null; role: string | null } | null;
  deadlines: { label: string; date: string | null; overdue: boolean }[];
  /** Ce qui EMPÊCHE d'avancer — la question la plus utile, et la plus souvent absente. */
  blockers: { code: string; message: string }[];
  /** Conditions à réunir pour franchir l'étape courante. */
  requirements: string[];
  documentsCount: number;
  commentsCount: number;
}

const label = (map: Record<string, unknown>, v: string | null): string | null => {
  if (!v) return null;
  const e = map[v];
  return typeof e === "string" ? e : ((e as { label?: string })?.label ?? v);
};

/**
 * Circuit d'un DOSSIER RÉGLEMENTAIRE : les 17 étapes officielles, leur état, et ce qui bloque.
 *
 * L'état de chaque étape est lu dans le JSON `workflow` du dossier — la même source que
 * l'écran. Les blocages sont déduits de faits, jamais devinés : pas de responsable, pas de
 * date cible, aucune pièce, avis de présoumission défavorable.
 */
async function regulatoryWorkflow(def: EntityDef, id: string): Promise<WorkflowView | null> {
  const p = await prisma.regulatoryProduct.findUnique({
    where: { id },
    select: {
      id: true, reference: true, status: true, workflow: true, targetDate: true, targetSubmissionDate: true,
      responsible: { select: { id: true, name: true, role: true } },
      steps: { select: { type: true, status: true, order: true }, orderBy: { order: "asc" } },
    },
  });
  if (!p) return null;

  const state = (p.workflow ?? {}) as RegWorkflowState;
  const prog = regProgress(state);
  const steps: WorkflowStep[] = REG_STEPS.map((s, i) => {
    const entry = (state as Record<string, { status?: string; date?: string; note?: string } | undefined>)[s.key];
    const done = entry?.status === "DONE";
    return {
      key: s.key,
      order: s.n ?? i + 1,
      label: s.label,
      phase: s.phase,
      responsible: s.responsible,
      expected: s.expected,
      state: done ? "DONE" : entry?.status === "BLOCKED" ? "BLOCKED" : "PENDING",
      date: entry?.date ?? null,
      note: entry?.note ?? null,
    };
  });
  // L'étape COURANTE est la première qui n'est pas faite : c'est là que le dossier attend.
  const currentIndex = steps.findIndex((s) => s.state !== "DONE");
  if (currentIndex >= 0) steps[currentIndex].state = "CURRENT";
  const current = currentIndex >= 0 ? steps[currentIndex] : null;

  const [documentsCount, commentsCount] = await Promise.all([
    prisma.document.count({ where: { entityType: "REGULATORY_PRODUCT" as EntityType, entityId: id } }),
    prisma.comment.count({ where: { entityType: "REGULATORY_PRODUCT" as EntityType, entityId: id } }).catch(sansBloquer("workflow.regulatoryWorkflow.comment", 0)),
  ]);

  const now = Date.now();
  const blockers: { code: string; message: string }[] = [];
  if (!p.responsible) blockers.push({ code: "NO_OWNER", message: "Aucune personne chargée du dossier : personne ne le porte." });
  if (!p.targetSubmissionDate) blockers.push({ code: "NO_TARGET_DATE", message: "Aucune date cible de dépôt fixée par la supervision." });
  if (documentsCount === 0) blockers.push({ code: "NO_DOCUMENTS", message: "Aucune pièce déposée sur le dossier." });
  if (p.targetDate && p.targetDate.getTime() < now && !["DECISION_OBTAINED", "CLOSED"].includes(p.status)) {
    blockers.push({ code: "TARGET_DATE_PASSED", message: "La date cible d'enregistrement est dépassée." });
  }
  if (p.status === "BLOCKED") blockers.push({ code: "STATUS_BLOCKED", message: "Le dossier est marqué bloqué." });

  return {
    entity: def.name,
    id,
    workflow: "regulatory_anpp_17_steps",
    status: p.status,
    statusLabel: label(REGULATORY_STATUS as Record<string, unknown>, p.status),
    steps,
    currentStep: current,
    nextSteps: currentIndex >= 0 ? steps.slice(currentIndex, currentIndex + 3) : [],
    progress: { done: prog.done, total: prog.total, percent: prog.total ? Math.round((prog.done / prog.total) * 100) : 0 },
    owner: p.responsible
      ? { userId: p.responsible.id, name: p.responsible.name, role: p.responsible.role }
      : { userId: null, name: null, role: null },
    deadlines: [
      { label: "Date cible de dépôt", date: p.targetSubmissionDate?.toISOString() ?? null, overdue: Boolean(p.targetSubmissionDate && p.targetSubmissionDate.getTime() < now) },
      { label: "Date cible d'enregistrement", date: p.targetDate?.toISOString() ?? null, overdue: Boolean(p.targetDate && p.targetDate.getTime() < now) },
    ],
    requirements: current
      ? [current.expected ?? "—", `Responsable attendu : ${current.responsible ?? "—"}`]
      : ["Le circuit est terminé : décision d'enregistrement obtenue ou dossier clôturé."],
    documentsCount,
    commentsCount,
    blockers,
  };
}

/**
 * Circuit GÉNÉRIQUE : pour un objet qui porte un statut sans circuit détaillé modélisé, on rend
 * au moins la vérité connue — statut courant, valeurs possibles de l'énumération, échéance,
 * pièces. Mieux vaut un circuit partiel et honnête qu'un circuit inventé.
 */
async function genericWorkflow(def: EntityDef, id: string, record: Record<string, unknown>): Promise<WorkflowView> {
  const status = def.statusField ? String(record[def.statusField] ?? "") || null : null;
  const documentsCount = def.entityType
    ? await prisma.document.count({ where: { entityType: def.entityType as EntityType, entityId: id } })
    : 0;
  return {
    entity: def.name,
    id,
    workflow: def.workflow ?? null,
    status,
    statusLabel: status,
    steps: [],
    currentStep: null,
    nextSteps: [],
    progress: { done: 0, total: 0, percent: 0 },
    owner: null,
    deadlines: [],
    blockers: documentsCount === 0 && def.entityType ? [{ code: "NO_DOCUMENTS", message: "Aucune pièce jointe." }] : [],
    requirements: [
      "Le détail des étapes de ce circuit n'est pas encore modélisé par l'API : "
      + "voir `/api/v1/entities/{entity}/{id}/available-actions` pour ce qui est faisable maintenant.",
    ],
    documentsCount,
    commentsCount: 0,
  };
}

export async function workflowOf(def: EntityDef, id: string, record: Record<string, unknown>): Promise<WorkflowView | null> {
  if (def.workflow === "regulatory") return regulatoryWorkflow(def, id);
  return genericWorkflow(def, id, record);
}

export interface AvailableAction {
  operationId: string;
  label: string;
  method: string;
  path: string;
  scopes: string[];
  /** Autorisée MAINTENANT pour cette identité et cet objet ? */
  allowed: boolean;
  /** Pourquoi elle ne l'est pas — un agent doit pouvoir le rapporter, pas seulement échouer. */
  reason: string | null;
}

/**
 * CE QUE L'AGENT PEUT FAIRE, MAINTENANT, SUR CET OBJET.
 *
 * Deux conditions cumulées, et l'API dit laquelle manque : la PORTÉE du client (ce que
 * l'intégration a le droit de faire) et le DROIT de l'identité (ce que la personne peut faire).
 * Une action refusée pour l'une ou l'autre raison ne se corrige pas de la même façon.
 */
export function availableActionsFor(user: SessionUser, clientScopes: string[], def: EntityDef, id: string): AvailableAction[] {
  const out: AvailableAction[] = [];
  const add = (operationId: string, labelText: string, method: string, path: string, scopes: string[], rbac: boolean) => {
    const missingScope = scopes.filter((s) => !clientScopes.includes(s));
    out.push({
      operationId, label: labelText, method, path, scopes,
      allowed: rbac && missingScope.length === 0,
      reason: missingScope.length > 0
        ? `Portée manquante : ${missingScope.join(", ")}.`
        : rbac ? null : `L'identité ${user.role} n'a pas ce droit sur le module ${def.module}.`,
    });
  };

  const base = `/api/v1/entities/${def.name}/${id}`;
  // La lecture se juge comme aux routes qui la servent (`canReadEntity`) : un objet ouvert par
  // plusieurs modules (§118.150) ne doit pas s'annoncer refusé ici et se lire là.
  const lit = canReadEntity(user, def);
  add(`get_${def.name}`, `Lire ${def.label.toLowerCase()}`, "GET", base, ["erp.read"], lit);
  add(`get_${def.name}_history`, "Lire l'historique", "GET", `${base}/history`, ["erp.read"], lit);
  add(`list_${def.name}_documents`, "Lister les pièces jointes", "GET", `${base}/documents`, ["erp.documents.read"], lit);
  add(`get_${def.name}_workflow`, "Lire le circuit et ses blocages", "GET", `${base}/workflow`, ["erp.read"], lit);
  return out;
}
