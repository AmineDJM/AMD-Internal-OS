import type { EntityType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ROLE_LABELS } from "@/lib/labels";
import {
  CATEGORY_ENTITY, CATEGORY_LABELS, SCOPE_LABELS, POWER_LABELS, WORKFLOW_CATEGORIES,
  type WorkflowCategory, type ActorScope, type WorkflowPower,
} from "@/platform/in-process/demandes";

/**
 * ADMINISTRATION DES CIRCUITS pour le Chief of Staff — lectures et résolutions au service des
 * outils `read_workflow`, `configure_workflow` et `advance_workflow`. Les ÉCRITURES, elles,
 * passent toujours par les actions canoniques (`saveWorkflowDefinition`, `advanceWorkflow`) :
 * ce module ne fait que LIRE l'état et RÉSOUDRE des références humaines — jamais deux logiques.
 */

export interface WorkflowStepView {
  slug: string;
  title: string;
  actorScope: string;
  actorScopeLabel: string;
  /** Libellés FR (affichage) ET codes exacts (pour recomposer un circuit valide). */
  actorRoles: string[];
  actorRoleCodes: string[];
  powers: string[];
  powerCodes: string[];
  optional: boolean;
  autoSkipMaxAmount: number | null;
  autoApproveIfRequester: boolean;
  notifyRoles: string[];
}

export interface WorkflowStateView {
  category: WorkflowCategory;
  categoryLabel: string;
  name: string | null;
  isActive: boolean;
  /** null = aucune définition personnalisée (le circuit par défaut codé s'applique). */
  steps: WorkflowStepView[] | null;
}

const roleLabel = (code: string): string => ROLE_LABELS[code as keyof typeof ROLE_LABELS] ?? code;

/** L'état ACTUEL du circuit d'une catégorie — ce que le builder de l'écran affiche. */
export async function readWorkflowState(category: WorkflowCategory): Promise<WorkflowStateView> {
  const def = await prisma.workflowDefinition.findUnique({
    where: { category },
    include: { steps: { orderBy: { position: "asc" } } },
  });
  if (!def) {
    return { category, categoryLabel: CATEGORY_LABELS[category], name: null, isActive: true, steps: null };
  }
  return {
    category,
    categoryLabel: CATEGORY_LABELS[category],
    name: def.name,
    isActive: def.isActive,
    steps: def.steps.map((s) => ({
      slug: s.slug,
      title: s.title,
      actorScope: s.actorScope,
      actorScopeLabel: SCOPE_LABELS[s.actorScope as ActorScope] ?? s.actorScope,
      actorRoles: s.actorRoles.map(roleLabel),
      actorRoleCodes: s.actorRoles,
      powers: s.powers.map((p) => POWER_LABELS[p as WorkflowPower] ?? p),
      powerCodes: s.powers,
      optional: s.optional,
      autoSkipMaxAmount: s.autoSkipMaxAmount ? Number(s.autoSkipMaxAmount) : null,
      autoApproveIfRequester: s.autoApproveIfRequester,
      notifyRoles: s.notifyRoles.map(roleLabel),
    })),
  };
}

/** Une demande engagée dans un circuit, résolue par référence/nom pour `advance_workflow`. */
export type WorkflowRequestResolution =
  | {
      status: "resolved";
      entityType: EntityType;
      entityId: string;
      display: string;
      instanceStatus: string;
      currentSlug: string | null;
      currentStepTitle: string | null;
      currentStepActors: string | null;
    }
  | { status: "ambiguous"; candidates: string[] }
  | { status: "none" };

/**
 * Résout « la demande X » d'une catégorie par sa référence (sponsoring) ou son nom (congrès,
 * événement) — même politique que partout : exact/unique/ambigu, jamais un choix silencieux.
 * Rend aussi l'ÉTAPE COURANTE de son circuit (titre + acteurs) pour que la carte de
 * confirmation dise précisément sur quoi porte la décision.
 */
export async function resolveWorkflowRequest(category: WorkflowCategory, rawQuery: string): Promise<WorkflowRequestResolution> {
  const query = rawQuery.trim();
  if (!query) return { status: "none" };
  const entityType = CATEGORY_ENTITY[category];

  let rows: { id: string; display: string }[] = [];
  if (category === "SPONSORING") {
    const found = await prisma.sponsoringRequest.findMany({
      where: { OR: [{ reference: { contains: query, mode: "insensitive" } }, { institution: { contains: query, mode: "insensitive" } }] },
      select: { id: true, reference: true, institution: true },
      take: 6,
    });
    rows = found.map((r) => ({ id: r.id, display: `${r.reference} — ${r.institution}` }));
  } else if (category === "CONGRESS_INTERNATIONAL") {
    const found = await prisma.congressInternational.findMany({
      where: { name: { contains: query, mode: "insensitive" } }, select: { id: true, name: true }, take: 6,
    });
    rows = found.map((r) => ({ id: r.id, display: r.name }));
  } else if (category === "CONGRESS_NATIONAL") {
    const found = await prisma.congressNational.findMany({
      where: { name: { contains: query, mode: "insensitive" } }, select: { id: true, name: true }, take: 6,
    });
    rows = found.map((r) => ({ id: r.id, display: r.name }));
  } else if (category === "OTHER") {
    // LA DEMANDE « AUTRE » (27/10/2026) : sa référence (AUT-…) ou son objet.
    const found = await prisma.adProOtherRequest.findMany({
      where: { OR: [{ reference: { contains: query, mode: "insensitive" } }, { title: { contains: query, mode: "insensitive" } }] },
      select: { id: true, reference: true, title: true },
      take: 6,
    });
    rows = found.map((r) => ({ id: r.id, display: `${r.reference} — ${r.title}` }));
  } else {
    const found = await prisma.event.findMany({
      where: { name: { contains: query, mode: "insensitive" } }, select: { id: true, name: true }, take: 6,
    });
    rows = found.map((r) => ({ id: r.id, display: r.name }));
  }

  if (rows.length === 0) return { status: "none" };
  let target = rows[0];
  if (rows.length > 1) {
    const q = query.toLowerCase();
    const exact = rows.filter((r) => {
      const n = r.display.toLowerCase();
      return n === q || n.startsWith(`${q} — `);
    });
    if (exact.length === 1) target = exact[0];
    else return { status: "ambiguous", candidates: rows.map((r) => r.display) };
  }

  const instance = await prisma.workflowInstance.findUnique({
    where: { entityType_entityId: { entityType, entityId: target.id } },
    select: {
      status: true, currentSlug: true,
      definition: { select: { steps: { orderBy: { position: "asc" }, select: { slug: true, title: true, actorScope: true, actorRoles: true } } } },
    },
  });
  const step = instance?.currentSlug
    ? instance.definition.steps.find((s) => s.slug === instance.currentSlug) ?? null
    : null;
  return {
    status: "resolved",
    entityType,
    entityId: target.id,
    display: target.display,
    instanceStatus: instance?.status ?? "SANS_CIRCUIT",
    currentSlug: instance?.currentSlug ?? null,
    currentStepTitle: step?.title ?? null,
    currentStepActors: step
      ? (step.actorRoles.length ? step.actorRoles.map(roleLabel).join(", ") : (SCOPE_LABELS[step.actorScope as ActorScope] ?? step.actorScope))
      : null,
  };
}

/** Résout un libellé français de catégorie (« sponsoring », « événements »…) vers son code. */
export function resolveWorkflowCategory(raw: string): WorkflowCategory | null {
  const s = raw.trim().toUpperCase().replace(/[\s-]+/g, "_");
  if ((WORKFLOW_CATEGORIES as readonly string[]).includes(s)) return s as WorkflowCategory;
  const folded = raw.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  if (folded.includes("sponso")) return "SPONSORING";
  if (folded.includes("international")) return "CONGRESS_INTERNATIONAL";
  if (folded.includes("national")) return "CONGRESS_NATIONAL";
  if (folded.includes("evenement") || folded.includes("event")) return "EVENTS";
  if (folded.includes("autre")) return "OTHER";
  return null;
}
