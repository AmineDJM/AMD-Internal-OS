/**
 * Moteur de workflow — LES DÉFINITIONS : types chargés, création d'étapes, définition par catégorie,
 * ordre des étapes, étape suivante, lecture de l'approbation effective, franchissement par montant,
 * éligibilité d'un saut automatique et droit d'agir sur une étape.
 */
import type { Prisma, UserRole, WorkflowInstance, WorkflowStep } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { hasGlobalView, hasRole } from "@/lib/rbac";
import { isManagerOfUser, getManagerOfUser } from "@/lib/departments";
import { toNumber } from "@/lib/utils";
import { defaultDefinition } from "../defaults";
import { estDecisionnaire, etapesNonAtteintes, estIgnoree, seuilFranchissement } from "../parcours";
import { horsDeSaGamme, ROLE_LIE_A_LA_GAMME } from "../etape-gamme";
import { superviseurDeLaGamme } from "../gamme-lue";
import { argentEffectif } from "../pouvoirs-argent";
import { CATEGORY_LABELS, type ActorScope, type StepInput, type WorkflowCategory } from "../types";

export type Viewer = { id: string; role: UserRole; secondaryRole?: UserRole | null; name?: string | null };

export type LoadedStep = WorkflowStep;

export type LoadedInstance = WorkflowInstance;

export type LoadedDefinition = Prisma.WorkflowDefinitionGetPayload<{ include: { steps: true } }>;

// ───────────────────────────── Définition (lazy-seed) ─────────────────────────────

/**
 * Une étape de la colonne vertébrale par défaut, telle qu'on la sème. Exportée pour les bancs qui
 * POSSÈDENT leur circuit (§118.186) : une copie privée, semée par la même fonction, ne diverge pas
 * du circuit réel — et un banc voisin qui modifie le circuit partagé ne la touche pas.
 */
export function stepCreate(s: StepInput, i: number): Prisma.WorkflowStepCreateWithoutDefinitionInput {
  return {
    position: i,
    slug: s.slug,
    title: s.title,
    description: s.description ?? null,
    actorRoles: s.actorRoles,
    actorScope: s.actorScope,
    powers: s.powers,
    assignRole: s.assignRole ?? null,
    requireAmount: s.requireAmount ?? false,
    autoSkipMaxAmount: s.autoSkipMaxAmount ?? null,
    autoApproveIfRequester: s.autoApproveIfRequester ?? false,
    requireCategory: s.requireCategory ?? false,
    requireNote: s.requireNote ?? false,
    emitDeclaration: s.emitDeclaration ?? false,
    emitExpenseOrder: s.emitExpenseOrder ?? false,
    notifyRoles: s.notifyRoles ?? [],
    optional: s.optional ?? false,
    confidential: s.confidential ?? false,
    legacyStatus: s.legacyStatus ?? null,
  };
}

/** Charge la définition d'une catégorie ; la sème (défaut) si elle n'existe pas encore. */
export async function getDefinition(category: WorkflowCategory): Promise<LoadedDefinition> {
  const existing = await prisma.workflowDefinition.findUnique({
    where: { category },
    include: { steps: { orderBy: { position: "asc" } } },
  });
  if (existing && existing.steps.length > 0) return existing;

  const d = defaultDefinition(category);

  // ── UNE DÉFINITION SANS AUCUNE ÉTAPE N'EST PAS UN CIRCUIT ────────────────────────────────
  //
  // Mesuré en base : la ligne `WorkflowDefinition` existait, avec ZÉRO `WorkflowStep`. La garde
  // était `if (existing) return existing` — elle ne regardait que la présence de la LIGNE, et
  // rendait donc un circuit vide comme s'il était configuré.
  //
  // Ce que cela produit est un faux succès parfait : `ensureInstance` lit `orderedSteps(def)`
  // vide, pose la demande sur un `currentSlug` qu'AUCUNE étape ne porte, et la demande existe,
  // apparaît dans les listes, n'a aucune étape en échec — et personne, à aucun rôle, ne peut la
  // faire avancer. C'est la signature de §118.14 vue cette semaine à l'autre bout du même
  // moteur (une étape de tête à portée ASSIGNEE : une demande que personne ne peut avancer).
  //
  // On RESÈME au lieu de refuser, et c'est la moitié qui compte : un circuit vide n'est jamais
  // une configuration VOULUE — « aucune validation » signifierait un accord automatique, que ce
  // moteur ne prononce jamais. Refuser laisserait le module mort ; resemer rend la colonne
  // vertébrale par défaut, celle que `defaults.ts` décrit, et le geste est idempotent.
  // Les `WorkflowStepEvent` déjà écrits portent leur `stepSlug` en TEXTE (pas de clé étrangère) :
  // l'historique d'une instance survit au resemis, il ne se perd pas avec les étapes.
  if (existing) {
    try {
      await prisma.workflowStep.createMany({
        data: d.steps.map((st, i) => ({ ...stepCreate(st, i), definitionId: existing.id })),
        skipDuplicates: true,
      });
    } catch {
      // Course : une autre requête vient de resemer → la relecture ci-dessous tranche.
    }
    const reseme = await prisma.workflowDefinition.findUnique({
      where: { category },
      include: { steps: { orderBy: { position: "asc" } } },
    });
    if (reseme && reseme.steps.length > 0) return reseme;
    throw new Error(`Le circuit ${CATEGORY_LABELS[category]} n'a aucune étape et n'a pas pu être réinitialisé.`);
  }

  try {
    return await prisma.workflowDefinition.create({
      data: { category, name: d.name, description: d.description, steps: { create: d.steps.map(stepCreate) } },
      include: { steps: { orderBy: { position: "asc" } } },
    });
  } catch {
    // Course : une autre requête l'a semée en parallèle → relire.
    const again = await prisma.workflowDefinition.findUnique({
      where: { category },
      include: { steps: { orderBy: { position: "asc" } } },
    });
    if (again) return again;
    throw new Error(`Impossible d'initialiser le workflow ${CATEGORY_LABELS[category]}.`);
  }
}

export function orderedSteps(def: LoadedDefinition): LoadedStep[] {
  return [...def.steps].sort((a, b) => a.position - b.position);
}

export function stepBySlug(def: LoadedDefinition, slug: string | null): LoadedStep | null {
  if (!slug) return null;
  return def.steps.find((s) => s.slug === slug) ?? null;
}

/**
 * L'ÉTAPE SUIVANTE — ou `null` quand celle-ci TRANCHE.
 *
 * L'UNIQUE endroit où « y a-t-il une suite ? » se décide, et c'est pour cela que la borne du
 * parcours entre ICI plutôt que dans les quatre endroits qui en dépendent : la terminalité, la
 * projection de l'accord définitif (`next === null`), le refus de franchir automatiquement la
 * décision finale et la levée du caviardage se déduisent tous de cette réponse. Écrire la borne
 * quatre fois aurait donné quatre occasions de ne plus dire la même chose (§118.5).
 *
 * `borne` absente ou inconnue de la définition ⇒ comportement d'avant, à l'identique.
 *
 * LE TAMIS ENTRE ICI POUR LA MÊME RAISON QUE LA BORNE. Depuis la règle du 22/09/2026, le parcours
 * n'est plus une troncature : une étape peut être hors route AU MILIEU (un KAM ne passe pas par la
 * Direction des opérations). Écrire le saut ailleurs qu'ici aurait laissé l'une des quatre
 * questions le rater — et celle qui l'aurait raté le plus visiblement est la terminalité : la
 * demande se serait posée sur une étape que personne n'a le droit ni la raison de franchir, sans
 * une seule ligne en échec (§118.113).
 *
 * `ignorees` est un TAMIS et non une borne : on saute chaque étape qui y figure et l'on CONTINUE.
 * S'arrêter à la première ignorée amputerait la chaîne de tout ce qui la suit.
 */
export function nextStepAfter(
  def: LoadedDefinition,
  step: LoadedStep,
  borne?: string | null,
  ignorees: readonly string[] = [],
): LoadedStep | null {
  if (estDecisionnaire(step.slug, borne ?? null)) return null;
  return orderedSteps(def).find((s) => s.position > step.position && !estIgnoree(s.slug, ignorees)) ?? null;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * CE QUE DÉCIDE L'APPROBATION DE CETTE ÉTAPE — une seule lecture, pour le moteur ET pour l'écran.
 *
 * Trois faits qui ne vont pas l'un sans l'autre : y a-t-il une SUITE (`nextStepAfter`, la borne et
 * le tamis réunis), quelles étapes la demande n'atteindra JAMAIS (`etapesNonAtteintes` — c'est d'elles
 * que l'étape qui conclut hérite l'émission, §118.107a), et donc ce que l'étape DÉCIDE de l'argent
 * (`argentEffectif` : sur la route d'un rang 2, la Direction des opérations conclut, et fixe le
 * montant et la catégorie que Direction Marketing aurait fixés).
 *
 * Le moteur l'appelle pour JUGER l'approbation (montant exigé, catégorie exigée, issue d'un
 * sponsoring) ; l'écran doit l'appeler pour PROPOSER les champs. Deux lectures séparées finiraient
 * par ne plus dire la même chose, et le symptôme serait le pire de cet écran : un montant exigé que
 * le panneau ne montre pas — une approbation offerte puis refusée (§118.83).
 *
 * `etape` est l'étape elle-même (même objet) quand rien n'est hérité.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export function lectureDeLApprobation(
  def: LoadedDefinition,
  step: LoadedStep,
  borne: string | null,
  ignorees: readonly string[],
): { next: LoadedStep | null; conclut: boolean; nonAtteintes: LoadedStep[]; etape: LoadedStep } {
  const ordonnees = orderedSteps(def);
  const next = nextStepAfter(def, step, borne, ignorees);
  const conclut = next === null;
  const nonAtteintes = conclut
    ? etapesNonAtteintes(ordonnees.map((s) => s.slug), borne, ignorees)
        .map((slug) => ordonnees.find((s) => s.slug === slug))
        .filter((s): s is LoadedStep => Boolean(s))
    : [];
  return { next, conclut, nonAtteintes, etape: argentEffectif(step, conclut, nonAtteintes) };
}

/**
 * Une étape est-elle éligible au franchissement automatique pour un montant donné ?
 *
 * Le seuil ne se lit plus SEULEMENT sur l'étape : la porte du Directeur Général (§118.138) est
 * gouvernée par le seuil GLOBAL des réglages, qui vaut aussi pour le matériel promotionnel — le
 * recopier dans chaque définition en ferait cinq vérités qui divergent (§118.5). `seuilFranchissement`
 * arbitre entre les deux, et un seuil écrit à la main sur l'étape l'emporte toujours.
 */
export function autoSkipEligible(step: LoadedStep, amount: number, seuilDgGlobal: number | null): boolean {
  const threshold = seuilFranchissement(
    step.slug,
    step.autoSkipMaxAmount == null ? null : toNumber(step.autoSkipMaxAmount),
    seuilDgGlobal,
  );
  if (threshold == null) return false;
  if (!(amount > 0) || amount > threshold) return false;
  // Ne JAMAIS franchir automatiquement une désignation ni une émission financière
  // (sinon plus personne en charge / dépense émise sans décision).
  if (step.powers.includes("ASSIGN") || step.emitDeclaration || step.emitExpenseOrder) return false;
  return true;
}

// ───────────────────────────── Gating ─────────────────────────────

export async function canActOnStep(viewer: Viewer, step: LoadedStep, instance: LoadedInstance, ctx: { requesterId?: string | null }): Promise<boolean> {
  if (viewer.role === "SUPER_ADMIN") return true; // le Super Admin passe partout
  switch (step.actorScope as ActorScope) {
    case "GLOBAL_VIEW":
      return hasGlobalView(viewer) || step.actorRoles.some((r) => hasRole(viewer, r as UserRole));
    case "ASSIGNEE":
      return instance.assigneeId === viewer.id || hasGlobalView(viewer);
    case "REQUESTER":
      return (ctx.requesterId ?? null) === viewer.id;
    // Le N+1 RÉEL du demandeur valide (manager explicite → responsable de département →
    // responsable du parent). Toute la chaîne AU-DESSUS peut aussi trancher : c'est
    // l'escalade normale d'une entreprise (et ça évite qu'une demande reste bloquée).
    // La Direction garde sa vue globale.
    case "DEPARTMENT_MANAGER": {
      if (hasGlobalView(viewer)) return true;
      const requesterId = ctx.requesterId ?? null;
      if (!requesterId || requesterId === viewer.id) return false; // on ne se valide pas soi-même
      return isManagerOfUser(viewer.id, requesterId);
    }
    // Strictement le responsable (ou l'adjoint) du département du demandeur.
    case "DEPARTMENT_HEAD": {
      if (hasGlobalView(viewer)) return true;
      const requesterId = ctx.requesterId ?? null;
      if (!requesterId || requesterId === viewer.id) return false;
      const mgr = await getManagerOfUser(requesterId);
      return Boolean(mgr && mgr.userId === viewer.id);
    }
    case "ROLE":
    default: {
      if (!step.actorRoles.some((r) => hasRole(viewer, r as UserRole))) return false;
      // L'étape du National Sales revient au superviseur de la gamme du dossier (ADPRO-06) — lu
      // seulement quand l'étape nomme ce rôle.
      if (!step.actorRoles.includes(ROLE_LIE_A_LA_GAMME)) return true;
      const superviseur = await superviseurDeLaGamme(instance.entityType, instance.entityId);
      return !horsDeSaGamme(step.actorRoles, { id: viewer.id, role: viewer.role, secondaryRole: viewer.secondaryRole ?? null }, superviseur);
    }
  }
}

export async function chargerDefinition(instance: LoadedInstance): Promise<LoadedDefinition | null> {
  return prisma.workflowDefinition.findUnique({ where: { id: instance.definitionId }, include: { steps: { orderBy: { position: "asc" } } } });
}

/** Les étapes que le MONTANT a franchies automatiquement — les seules qu'une correction peut rouvrir. */
export async function franchiesParMontant(instanceId: string): Promise<Set<string>> {
  const lignes = await prisma.workflowStepEvent.findMany({ where: { instanceId, action: "AUTO_SKIP" }, select: { stepSlug: true } });
  return new Set(lignes.map((l) => l.stepSlug));
}
