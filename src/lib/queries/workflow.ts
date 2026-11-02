import type { EntityType } from "@prisma/client";
import type { UserRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { toNumber } from "@/lib/utils";
import { anyRoleFilter, hasGlobalView, hasRole, userCan, type Module, type SessionUser } from "@/lib/rbac";
import { getBudgetCategoryOptions, type BudgetCategoryOption } from "@/lib/queries/budget";
import { ensureInstance, getDefinition, orderedSteps, canActOnStep, stepBySlug, lectureDeLApprobation } from "@/lib/workflow/engine";
import { estDecisionnaire, etapesNonAtteintes, ROLE_DIRECTION_MARKETING } from "@/lib/workflow/parcours";
import { motifVisible, peutResoumettre, type MotifVisible } from "@/lib/workflow/renvoi";
import {
  entityToCategory, WORKFLOW_CATEGORIES, CATEGORY_LABELS,
  type ActorScope, type WorkflowCategory, type WorkflowPower,
} from "@/lib/workflow/types";
import { sansBloquer } from "@/lib/journal";

export interface WorkflowStepView {
  slug: string;
  title: string;
  description: string | null;
  actorRoles: string[];
  actorScope: ActorScope;
  powers: WorkflowPower[];
  assignRole: string | null;
  requireAmount: boolean;
  autoSkipMaxAmount: number | null;
  autoApproveIfRequester: boolean;
  requireCategory: boolean;
  requireNote: boolean;
  optional: boolean;
  confidential: boolean;
  emitDeclaration: boolean;
  emitExpenseOrder: boolean;
  notifyRoles: string[];
  legacyStatus: string | null;
  state: "done" | "current" | "todo" | "rejected";
}

export interface WorkflowEventView {
  stepTitle: string;
  action: string;
  actorName: string | null;
  note: string | null;
  amount: number | null;
  createdAt: string;
}

export interface WorkflowActionView {
  slug: string;
  title: string;
  description: string | null;
  powers: WorkflowPower[];
  requireAmount: boolean;
  requireCategory: boolean;
  requireNote: boolean;
  assignRole: string | null;
  assigneeCandidates: { id: string; name: string }[];
  suggestedAmount: number | null;
}

export interface WorkflowOutcome {
  grantedAmount: number | null;
  expenseOrder: { reference: string; status: string; amount: number } | null;
  /**
   * SPONSORING sous la règle de la tenue (§118.151) : le circuit se termine sur une TENUE
   * pré-validée, et l'argent se fixe à la clôture, poste par poste. Sans ce fait, le panneau disait
   * « Approuvé — en cours de traitement (information médicale / Finances) », c'est-à-dire l'étape
   * suivante d'un accord à montant global, qui n'existe plus ici.
   */
  tenue?: "PRE_VALIDEE" | "CLOTUREE" | null;
}

export interface WorkflowView {
  category: WorkflowCategory;
  definitionName: string;
  status: string; // IN_PROGRESS | RETURNED | APPROVED | REJECTED | CANCELLED
  currentSlug: string | null;
  steps: WorkflowStepView[];
  events: WorkflowEventView[];
  assigneeName: string | null;
  action: WorkflowActionView | null; // ce que le spectateur peut faire MAINTENANT
  budgetCategories: BudgetCategoryOption[];
  outcome: WorkflowOutcome | null;
  /** Les détails techniques du circuit (rôles/portées/pouvoirs) ne sont montrés
   *  qu'au Super Admin. */
  isSuperAdmin: boolean;
  /** L'HISTORIQUE complet (dont l'avis confidentiel de la Direction Marketing + montant
   *  révisé) est réservé aux spectateurs « privilégiés » : Super Admin, Direction /
   *  Directeur des opérations (vue globale), National Sales et la Direction Marketing
   *  désigné. Pour les autres (ex. délégué demandeur) il reste masqué. */
  canViewHistory: boolean;
  /**
   * LE MOTIF QUE LE DEMANDEUR DOIT LIRE (audit 360°, R03 — §118.186) : le renvoi pour correction qui
   * l'attend, ou le refus qui a clos sa demande. Montré à tout spectateur du panneau — la fiche a
   * déjà vérifié qu'il peut la lire —, demandeur en premier, même hors de l'historique privilégié.
   */
  motif: MotifVisible | null;
  /** Le spectateur peut-il resoumettre la demande renvoyée ? (le demandeur, la vue globale) */
  peutResoumettre: boolean;
  /** Le spectateur peut-il retirer la demande non tranchée ? (le demandeur, qui tranche, la vue globale) */
  peutRetirer: boolean;
  /**
   * FAIRE APPEL D'UN REFUS (décision #12, 27/10/2026) — prise en charge et événement (le sponsoring a son
   * propre appel) : le demandeur, ou la vue globale, une fois le refus définitif rendu.
   */
  peutFaireAppel: boolean;
}

/** Une dépense Ad & Pro accordée peut être imputée à n'importe quelle enveloppe
 *  couvrant la famille Ad & Pro — pas seulement le module exact de la demande. */
const AD_PRO_BUDGET_MODULES = ["SPONSORING", "CONGRESS_INTERNATIONAL", "CONGRESS_NATIONAL", "EVENTS", "AD_PRO_OTHER", "PROMO_MATERIAL"];

/**
 * LE MODULE QUI « TRANCHE » CHAQUE CATÉGORIE — la catégorie n'est un nom de module que par coïncidence
 * pour les quatre premières ; la demande « autre » (`OTHER`) relève du module `AD_PRO_OTHER`.
 */
const MODULE_DE_LA_CATEGORIE: Record<WorkflowCategory, Module> = {
  SPONSORING: "SPONSORING",
  CONGRESS_INTERNATIONAL: "CONGRESS_INTERNATIONAL",
  CONGRESS_NATIONAL: "CONGRESS_NATIONAL",
  EVENTS: "EVENTS",
  OTHER: "AD_PRO_OTHER",
};

async function loadOutcome(entityType: EntityType, entityId: string): Promise<WorkflowOutcome> {
  let grantedAmount: number | null = null;
  let orderId: string | null = null;
  let tenue: WorkflowOutcome["tenue"] = null;
  if (entityType === "SPONSORING") {
    const r = await prisma.sponsoringRequest.findUnique({ where: { id: entityId }, select: { amountGranted: true, expenseOrderId: true, status: true, closedAt: true } });
    grantedAmount = r?.amountGranted != null ? toNumber(r.amountGranted) : null;
    orderId = r?.expenseOrderId ?? null;
    tenue = r?.status === "PRE_VALIDATED" ? "PRE_VALIDEE" : r?.status === "CLOSED" && r.closedAt ? "CLOTUREE" : null;
  } else if (entityType === "AD_PRO_OTHER") {
    // LA DEMANDE « AUTRE » (27/10/2026) n'a ni montant accordé global ni ordre global : son argent se
    // décide poste par poste (le panneau des postes et la porte du DG sur le total le disent).
  } else {
    const sel = { finalAmount: true, expenseOrderId: true } as const;
    const r =
      entityType === "CONGRESS_INTERNATIONAL" ? await prisma.congressInternational.findUnique({ where: { id: entityId }, select: sel })
        : entityType === "CONGRESS_NATIONAL" ? await prisma.congressNational.findUnique({ where: { id: entityId }, select: sel })
          : await prisma.event.findUnique({ where: { id: entityId }, select: sel });
    grantedAmount = r?.finalAmount != null ? toNumber(r.finalAmount) : null;
    orderId = r?.expenseOrderId ?? null;
  }
  const order = orderId ? await prisma.expenseOrder.findUnique({ where: { id: orderId }, select: { reference: true, status: true, amount: true } }) : null;
  return { grantedAmount, expenseOrder: order ? { reference: order.reference, status: order.status, amount: toNumber(order.amount) } : null, tenue };
}

/**
 * Reconstitue la ligne « demande créée » d'une demande ouverte avant que le moteur ne
 * l'inscrive. Rend `null` si l'instant de création est introuvable : mieux vaut un historique
 * qui commence à la première validation qu'une ligne datée d'aujourd'hui, qui ferait croire que
 * la demande vient d'être déposée.
 */
async function synthesizeCreationEvent(
  entityType: EntityType, entityId: string, requesterId: string | null,
): Promise<{ stepSlug: string; stepTitle: string; action: string; actorName: string | null; note: string | null; amount: null; createdAt: Date } | null> {
  const sel = { createdAt: true } as const;
  const row =
    entityType === "SPONSORING" ? await prisma.sponsoringRequest.findUnique({ where: { id: entityId }, select: sel })
      : entityType === "CONGRESS_INTERNATIONAL" ? await prisma.congressInternational.findUnique({ where: { id: entityId }, select: sel })
        : entityType === "CONGRESS_NATIONAL" ? await prisma.congressNational.findUnique({ where: { id: entityId }, select: sel })
          : entityType === "EVENT" ? await prisma.event.findUnique({ where: { id: entityId }, select: sel })
            : entityType === "AD_PRO_OTHER" ? await prisma.adProOtherRequest.findUnique({ where: { id: entityId }, select: sel })
              : null;
  if (!row) return null;
  const requester = requesterId
    ? await prisma.user.findUnique({ where: { id: requesterId }, select: { name: true } }).catch(sansBloquer("workflow.synthesizeCreationEvent.user", null))
    : null;
  return {
    stepSlug: "__created__", stepTitle: "Demande créée", action: "CREATE",
    actorName: requester?.name ?? null, note: null, amount: null, createdAt: row.createdAt,
  };
}

/**
 * Vue « workflow » d'une demande pour un spectateur : frise dynamique dérivée de la
 * définition + historique + l'action éventuellement disponible (selon les pouvoirs de
 * l'étape courante et le rôle du spectateur). Crée l'instance à la volée si besoin
 * (couvre aussi les demandes créées avant l'activation du moteur).
 */
export async function getWorkflowForEntity(viewer: SessionUser, entityType: EntityType, entityId: string, requesterIdDonne: string | null): Promise<WorkflowView | null> {
  const category = entityToCategory(entityType);
  if (!category) return null;
  const instance = await ensureInstance(entityType, entityId);
  if (!instance) return null;
  // LE DEMANDEUR SE RELIT QUAND L'APPELANT NE L'A PAS (la fiche d'un événement passait `null`) :
  // sans lui, une étape « N+1 du demandeur » ne trouvait personne, et le demandeur lui-même ne se
  // voyait proposer ni la resoumission ni le retrait de SA demande.
  const requesterId = requesterIdDonne ?? (await demandeurDeLaDemande(entityType, entityId));
  const def = await getDefinition(category);
  const toutesLesEtapes = orderedSteps(def);

  // ─── LE PARCOURS DE CETTE DEMANDE, ET NON LA DÉFINITION ENTIÈRE ───────────────────────
  //
  // Une demande de KAM est TRANCHÉE par Direction Marketing : l'étape de la Direction ne la
  // concerne pas. L'afficher quand même serait le défaut le plus coûteux de cet écran — une
  // frise qui annonce une validation qui n'aura pas lieu, donc un demandeur qui attend et une
  // Direction qui croit avoir un dossier à traiter. On retire exactement ce que le moteur
  // n'atteindra pas (`nextStepAfter` avec la MÊME borne et le MÊME tamis) : deux lectures des
  // deux faits, une seule règle, celle de `parcours.ts` (§118.5).
  //
  // ET CE N'EST PLUS SEULEMENT UNE QUEUE. Depuis la règle du 22/09/2026, une étape peut être
  // hors route AU MILIEU : un KAM ne passe pas par la Direction des opérations, alors que
  // Direction Marketing — la dernière étape — le concerne bien. Ne couper que la queue aurait
  // affiché à ce demandeur une validation de la Direction qu'il n'atteindra jamais, c'est-à-dire
  // le défaut que ce paragraphe existe pour fermer, une position plus tôt.
  const borne = instance.finalSlug ?? null;
  const ignorees = instance.skippedSlugs ?? [];
  const horsRoute = new Set(etapesNonAtteintes(toutesLesEtapes.map((s) => s.slug), borne, ignorees));
  const steps = toutesLesEtapes.filter((s) => !horsRoute.has(s.slug));

  // ─── CONFIDENTIALITÉ : UN AVIS, OUI ; UNE DÉCISION, NON ───────────────────────────────
  //
  // L'avis et le montant d'une étape « confidentielle » ne sont pas visibles du demandeur —
  // sauf quand cette étape est celle qui TRANCHE. Ce n'est pas un assouplissement : la
  // confidentialité protège une PROPOSITION en cours d'arbitrage, et une proposition cesse
  // d'en être une quand elle devient la décision. Pour une demande de KAM, Direction Marketing
  // accorde le budget ; caviarder ce montant-là laisserait le demandeur devant une demande
  // approuvée dont il ne peut pas lire la somme accordée — un accord illisible n'est pas un
  // accord.
  const privileged = hasGlobalView(viewer) || viewer.role === "SUPER_ADMIN" || instance.assigneeId === viewer.id
    || hasRole(viewer, "NATIONAL_SALES") || hasRole(viewer, ROLE_DIRECTION_MARKETING);
  const confidentialSlugs = new Set(
    steps.filter((s) => s.confidential && !estDecisionnaire(s.slug, borne)).map((s) => s.slug),
  );

  const events = await prisma.workflowStepEvent.findMany({ where: { instanceId: instance.id }, orderBy: { createdAt: "asc" } });

  // LA LIGNE DE CRÉATION — qui a demandé, et quand.
  //
  // Le moteur l'inscrit désormais à l'ouverture de l'instance. Mais les demandes ouvertes AVANT
  // n'en ont pas, et leur historique commencerait encore à la première validation : on la
  // reconstitue alors depuis la demande elle-même, sans rien écrire en base — reconstituer à
  // l'affichage est exact, réécrire l'historique a posteriori ne le serait pas.
  const createdLine = events.some((e) => e.action === "CREATE")
    ? null
    : await synthesizeCreationEvent(entityType, entityId, requesterId);
  const approved = new Set(events.filter((e) => e.action === "APPROVE").map((e) => e.stepSlug));
  const rejectedSlug = [...events].reverse().find((e) => e.action === "REJECT")?.stepSlug ?? null;
  const currentPos = instance.currentSlug ? steps.find((s) => s.slug === instance.currentSlug)?.position ?? -1 : Infinity;

  const stepViews: WorkflowStepView[] = steps.map((s) => {
    let state: WorkflowStepView["state"];
    if (instance.status === "REJECTED" && s.slug === rejectedSlug) state = "rejected";
    else if (instance.status === "APPROVED") state = "done";
    // Une demande À CORRIGER garde son étape « en cours » : c'est là qu'elle reviendra.
    else if ((instance.status === "IN_PROGRESS" || instance.status === "RETURNED") && s.slug === instance.currentSlug) state = "current";
    else if (approved.has(s.slug) || s.position < currentPos) state = "done";
    else state = "todo";
    return {
      slug: s.slug, title: s.title, description: s.description, actorRoles: s.actorRoles, actorScope: s.actorScope as ActorScope,
      powers: s.powers as WorkflowPower[], assignRole: s.assignRole, requireAmount: s.requireAmount, autoSkipMaxAmount: s.autoSkipMaxAmount ? toNumber(s.autoSkipMaxAmount) : null, autoApproveIfRequester: s.autoApproveIfRequester, requireCategory: s.requireCategory,
      requireNote: s.requireNote, optional: s.optional, confidential: s.confidential, emitDeclaration: s.emitDeclaration, emitExpenseOrder: s.emitExpenseOrder,
      notifyRoles: s.notifyRoles, legacyStatus: s.legacyStatus, state,
    };
  });

  const assignee = instance.assigneeId ? await prisma.user.findUnique({ where: { id: instance.assigneeId }, select: { name: true } }) : null;

  // Action disponible pour ce spectateur à l'étape courante ?
  let action: WorkflowActionView | null = null;
  const current = stepBySlug(def, instance.currentSlug);
  if (instance.status === "IN_PROGRESS" && current && (await canActOnStep(viewer, current, instance, { requesterId }))) {
    // L'ÉTAPE TELLE QUE LE MOTEUR LA JUGERA, pas seulement telle que la définition la décrit : sur
    // la route d'un rang 2, la Direction des opérations CONCLUT et hérite le montant et la
    // catégorie de Direction Marketing (`workflow/pouvoirs-argent.ts`). Lire `current` seul
    // offrirait une approbation que le moteur refuse — un bouton offert puis refusé (§118.83).
    const decide = lectureDeLApprobation(def, current, borne, ignorees).etape;
    const candidates = current.assignRole
      ? await prisma.user.findMany({ where: { ...anyRoleFilter([current.assignRole as UserRole]), isActive: true }, select: { id: true, name: true }, orderBy: { name: "asc" } })
      : [];
    // Montant suggéré : dernier montant proposé (analyse), sinon montant déjà accordé.
    const lastAmount = [...events].reverse().find((e) => e.amount != null)?.amount ?? instance.amount ?? null;
    action = {
      slug: current.slug, title: current.title, description: current.description,
      powers: decide.powers as WorkflowPower[], requireAmount: decide.requireAmount, requireCategory: decide.requireCategory,
      requireNote: current.requireNote, assignRole: current.assignRole, assigneeCandidates: candidates,
      suggestedAmount: lastAmount != null ? toNumber(lastAmount) : null,
    };
  }

  // L'ACTION PROPOSÉE COMPTE AUSSI : l'étape qui conclut une route coupée hérite la catégorie sans
  // qu'aucune étape de la route ne la porte dans la définition — sans cette ligne, le champ serait
  // exigé et la liste des catégories, vide.
  const needsCategory = stepViews.some((s) => s.requireCategory || s.powers.includes("SET_CATEGORY"))
    || (action !== null && (action.requireCategory || action.powers.includes("SET_CATEGORY")));
  // Catégories restreintes aux enveloppes ACCESSIBLES au décideur (Direction) — décidées par le Super Admin.
  const budgetCategories = needsCategory && action ? await getBudgetCategoryOptions(AD_PRO_BUDGET_MODULES, viewer) : [];
  const outcome = instance.status !== "IN_PROGRESS" || instance.assigneeId ? await loadOutcome(entityType, entityId) : null;

  return {
    category, definitionName: def.name, status: instance.status, currentSlug: instance.currentSlug,
    isSuperAdmin: viewer.role === "SUPER_ADMIN",
    canViewHistory: privileged,
    steps: stepViews, assigneeName: assignee?.name ?? null,
    events: [...(createdLine ? [createdLine] : []), ...events].map((e) => {
      const hide = !privileged && confidentialSlugs.has(e.stepSlug);
      return {
        stepTitle: e.stepTitle, action: e.action, actorName: e.actorName,
        note: hide ? (e.note ? "— confidentiel —" : null) : e.note,
        amount: hide ? null : e.amount != null ? toNumber(e.amount) : null,
        createdAt: e.createdAt.toISOString(),
      };
    }),
    action, budgetCategories, outcome,
    // Lu sur l'historique BRUT : un renvoi est adressé au demandeur, et un refus définitif est une
    // décision — ni l'un ni l'autre n'est un avis confidentiel (`motifVisible`).
    motif: motifVisible(instance.status, events),
    peutResoumettre: instance.status === "RETURNED"
      && peutResoumettre({ id: viewer.id, vueGlobale: hasGlobalView(viewer) || viewer.role === "SUPER_ADMIN" }, requesterId),
    peutRetirer: (instance.status === "IN_PROGRESS" || instance.status === "RETURNED")
      && (requesterId === viewer.id || hasGlobalView(viewer) || viewer.role === "SUPER_ADMIN" || userCan(viewer, MODULE_DE_LA_CATEGORIE[category], "VALIDATE")),
    peutFaireAppel: instance.status === "REJECTED" && entityType !== "SPONSORING"
      && (requesterId === viewer.id || hasGlobalView(viewer) || viewer.role === "SUPER_ADMIN"),
  };
}

async function demandeurDeLaDemande(entityType: EntityType, entityId: string): Promise<string | null> {
  const sel = { select: { requesterId: true } } as const;
  const ligne =
    entityType === "SPONSORING" ? await prisma.sponsoringRequest.findUnique({ where: { id: entityId }, ...sel })
      : entityType === "CONGRESS_INTERNATIONAL" ? await prisma.congressInternational.findUnique({ where: { id: entityId }, ...sel })
        : entityType === "CONGRESS_NATIONAL" ? await prisma.congressNational.findUnique({ where: { id: entityId }, ...sel })
          : entityType === "EVENT" ? await prisma.event.findUnique({ where: { id: entityId }, ...sel })
            : entityType === "AD_PRO_OTHER" ? await prisma.adProOtherRequest.findUnique({ where: { id: entityId }, ...sel })
              : null;
  return ligne?.requesterId ?? null;
}

// ───────────────────────────── Builder (Administration) ─────────────────────────────

export interface DefinitionAdminView {
  id: string;
  category: WorkflowCategory;
  categoryLabel: string;
  name: string;
  description: string | null;
  isActive: boolean;
  instanceCount: number;
  steps: WorkflowStepView[];
}

/** Toutes les définitions (semées si absentes) pour l'éditeur no-code du Super Admin. */
export async function getWorkflowDefinitions(): Promise<DefinitionAdminView[]> {
  const out: DefinitionAdminView[] = [];
  for (const category of WORKFLOW_CATEGORIES) {
    const def = await getDefinition(category);
    const instanceCount = await prisma.workflowInstance.count({ where: { definitionId: def.id } });
    out.push({
      id: def.id, category, categoryLabel: CATEGORY_LABELS[category], name: def.name, description: def.description, isActive: def.isActive, instanceCount,
      steps: orderedSteps(def).map((s) => ({
        slug: s.slug, title: s.title, description: s.description, actorRoles: s.actorRoles, actorScope: s.actorScope as ActorScope,
        powers: s.powers as WorkflowPower[], assignRole: s.assignRole, requireAmount: s.requireAmount, autoSkipMaxAmount: s.autoSkipMaxAmount ? toNumber(s.autoSkipMaxAmount) : null, autoApproveIfRequester: s.autoApproveIfRequester, requireCategory: s.requireCategory,
        requireNote: s.requireNote, optional: s.optional, confidential: s.confidential, emitDeclaration: s.emitDeclaration, emitExpenseOrder: s.emitExpenseOrder,
        notifyRoles: s.notifyRoles, legacyStatus: s.legacyStatus, state: "todo" as const,
      })),
    });
  }
  return out;
}
