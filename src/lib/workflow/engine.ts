import type { EntityType, Prisma, UserRole, WorkflowInstance, WorkflowStep } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { notifyRoles, notifyUser } from "@/lib/notify";
import {
  aPrevenirPourLaGamme, laGammeEstConcernee, porteLeRoleQuiTranche, type ReferentMarketing,
} from "@/lib/personnes/referents-gamme";
import { recordAudit } from "@/lib/audit";
import { hasGlobalView, hasRole } from "@/lib/rbac";
import { createMedicalInfoDeclaration, pharmacienAssigne } from "@/lib/medical-info";
import { isManagerOfUser, getManagerOfUser } from "@/lib/departments";
import { createExpenseOrder } from "@/lib/expense-orders";
import { toNumber } from "@/lib/utils";
import { CHEMIN_PARENT_AD_PRO, lienDemandeAdPro, type ParentAdPro } from "@/lib/chemins/ad-pro";
import { defaultDefinition } from "./defaults";
import { estDecisionnaire, etapesNonAtteintes, estIgnoree, parcoursEffectif, seuilFranchissement, SLUG_MARKETING } from "./parcours";
import { adProOriginRank } from "./origin";
import { getAppSettings } from "@/lib/settings";
import { statutDepuisCircuit, AD_PRO_PARENTS, PARENT_COLONNE, type AdProParent } from "@/modules/ad-pro/partage";
import { issueTerminaleSponsoring } from "./issue-sponsoring";
import { ecritureAutreDepuisCircuit } from "./autre-statut";
import { argentEffectif } from "./pouvoirs-argent";
import { auteursDAvis, etapeDeReprise, peutResoumettre, refusDuRenvoi, statutLegacyALEtape } from "./renvoi";
import {
  CATEGORY_LABELS,
  entityToCategory,
  type ActorScope,
  type StepInput,
  type WorkflowCategory,
} from "./types";
import { sansBloquer } from "@/lib/journal";

/**
 * Moteur de workflow configurable (Ad & Pro). Une **définition** (par catégorie)
 * décrit une suite d'**étapes** ; chaque étape déclare qui agit et ses pouvoirs.
 * Une **instance** suit une demande précise à travers ces étapes. Le moteur assure
 * le gating, la progression et les effets (désignation, émission d'ordre de dépense
 * / déclaration d'information médicale), tout en **projetant** le statut « legacy »
 * de l'entité source pour ne rien casser des frises/badges/queries existants.
 */

type Viewer = { id: string; role: UserRole; secondaryRole?: UserRole | null; name?: string | null };
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
function autoSkipEligible(step: LoadedStep, amount: number, seuilDgGlobal: number | null): boolean {
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

/**
 * Franchissements AUTOMATIQUES d'étapes intermédiaires (anti-bureaucratie configurable).
 * À partir de l'étape où l'instance vient d'arriver (`landing`), tant qu'elle est éligible,
 * elle est franchie SANS action humaine — tracé, avec projection legacy sur l'étape réelle
 * de repos. Deux motifs, tous deux opt-in par étape :
 *   • SEUIL DE MONTANT — montant de travail ≤ `autoSkipMaxAmount` → « AUTO_SKIP ».
 *   • AUTORITÉ DU DEMANDEUR — le demandeur détient déjà le rôle/la portée de l'étape
 *     (`autoApproveIfRequester`) → « AUTO_APPROVE_REQUESTER » (on ne fait pas valider quelqu'un
 *     sa propre demande).
 * Ne franchit JAMAIS une désignation (ASSIGN), une émission financière, ni la décision finale
 * (dernière étape sans successeur) : un humain tranche toujours l'accord définitif.
 * Retourne l'étape de repos.
 */
async function settleAutoSkips(
  entityType: EntityType, entityId: string, def: LoadedDefinition,
  instanceId: string, amount: number, requesterId: string | null, landing: LoadedStep | null, viewer: Viewer,
  borne: string | null, ignorees: readonly string[],
): Promise<LoadedStep | null> {
  let current = landing;
  let guard = 0;
  // LE SEUIL GLOBAL, lu UNE fois pour tout l'enchaînement (mis en cache par requête). Illisible
  // (base indisponible) ⇒ `null` ⇒ aucune porte du DG franchie automatiquement : sous l'incertitude
  // on garde la validation de plus, jamais de moins.
  const seuilDgGlobal = await getAppSettings().then((s) => s.adProDgThreshold).catch(sansBloquer("workflow-engine.settleAutoSkips.getAppSettings", null));
  // Rôle du demandeur — chargé paresseusement (uniquement si une étape « auto-accord si autorité » l'exige).
  let reqRole: { role: UserRole; secondaryRole: UserRole | null } | null | undefined = undefined;
  const requesterHoldsAuthority = async (step: LoadedStep): Promise<boolean> => {
    if (!step.autoApproveIfRequester || !requesterId) return false;
    if (step.powers.includes("ASSIGN") || step.emitDeclaration || step.emitExpenseOrder) return false;
    const scope = step.actorScope as ActorScope;
    if (scope === "REQUESTER") return true;
    if (scope !== "ROLE") return false; // GLOBAL_VIEW / ASSIGNEE : pas d'auto-accord demandeur
    if (reqRole === undefined) {
      const u = await prisma.user.findUnique({ where: { id: requesterId }, select: { role: true, secondaryRole: true } });
      reqRole = u ? { role: u.role, secondaryRole: u.secondaryRole ?? null } : null;
    }
    if (!reqRole) return false;
    const asViewer = { id: requesterId, role: reqRole.role, secondaryRole: reqRole.secondaryRole };
    return step.actorRoles.some((r) => hasRole(asViewer, r as UserRole));
  };

  while (current && guard++ < 50) {
    const byAmount = autoSkipEligible(current, amount, seuilDgGlobal);
    const byRequester = !byAmount && (await requesterHoldsAuthority(current));
    if (!byAmount && !byRequester) break;
    const after = nextStepAfter(def, current, borne, ignorees);
    if (!after) break; // pas de successeur (décision finale) → on ne franchit pas
    const action = byAmount ? "AUTO_SKIP" : "AUTO_APPROVE_REQUESTER";
    const reason = byAmount
      ? `Montant ${amount} DZD ≤ seuil ${seuilFranchissement(current.slug, current.autoSkipMaxAmount == null ? null : toNumber(current.autoSkipMaxAmount), seuilDgGlobal)} DZD — étape franchie automatiquement.`
      : "Le demandeur détient déjà l'autorité de cette étape — approuvée automatiquement en son nom.";
    await projectApprove(entityType, entityId, current, after, {
      viewer, note: reason, amount: null, assigneeId: null, emitResult: null,
      nextLegacyStatus: after.legacyStatus ?? null, emitStep: false,
    });
    await recordEvent(instanceId, current, action, viewer, reason, null);
    current = after;
  }
  return current;
}

// ───────────────────────────── Statut « legacy » de l'entité ─────────────────────────────

const LEGACY_FIELD: Record<string, "status" | "requestStatus"> = {
  SPONSORING: "status",
  CONGRESS_INTERNATIONAL: "requestStatus",
  CONGRESS_NATIONAL: "requestStatus",
  EVENT: "requestStatus",
  AD_PRO_OTHER: "status",
};

function updateEntity(entityType: EntityType, entityId: string, data: Record<string, unknown>) {
  switch (entityType) {
    case "SPONSORING":
      return prisma.sponsoringRequest.update({ where: { id: entityId }, data: data as Prisma.SponsoringRequestUpdateInput });
    case "CONGRESS_INTERNATIONAL":
      return prisma.congressInternational.update({ where: { id: entityId }, data: data as Prisma.CongressInternationalUpdateInput });
    case "CONGRESS_NATIONAL":
      return prisma.congressNational.update({ where: { id: entityId }, data: data as Prisma.CongressNationalUpdateInput });
    case "EVENT": {
      // Le modèle Event n'a pas de champ updatedById (contrairement aux congrès).
      const { updatedById: _omit, ...rest } = data;
      return prisma.event.update({ where: { id: entityId }, data: rest as Prisma.EventUpdateInput });
    }
    case "AD_PRO_OTHER":
      // LA DEMANDE « AUTRE » (27/10/2026) n'a ni les statuts ni les colonnes des quatre autres natures :
      // l'écriture du moteur est TRADUITE (`workflow/autre-statut.ts`), et ce qu'elle n'a pas est abandonné.
      return prisma.adProOtherRequest.update({ where: { id: entityId }, data: ecritureAutreDepuisCircuit(data) });
    default:
      return Promise.resolve(null);
  }
}

interface EntitySummary {
  name: string;
  requesterId: string | null;
  beneficiary: string | null;
  label: string;
  legacyStatus: string | null;
  /** Montant estimé/demandé par le demandeur — repli pour le routage par seuil tant qu'aucun montant de travail n'est fixé. */
  estimatedAmount: number | null;
  /** Instant EXACT de création de la demande — première ligne de son historique. */
  createdAt: Date | null;
}

async function loadEntity(entityType: EntityType, entityId: string): Promise<EntitySummary | null> {
  if (entityType === "SPONSORING") {
    const r = await prisma.sponsoringRequest.findUnique({ where: { id: entityId }, select: { reference: true, institution: true, requesterId: true, status: true, amountRequested: true, createdAt: true } });
    if (!r) return null;
    return { name: r.institution, requesterId: r.requesterId, beneficiary: r.institution, label: `Sponsoring ${r.reference} — ${r.institution}`, legacyStatus: r.status, estimatedAmount: r.amountRequested != null ? toNumber(r.amountRequested) : null, createdAt: r.createdAt };
  }
  if (entityType === "CONGRESS_INTERNATIONAL") {
    const c = await prisma.congressInternational.findUnique({ where: { id: entityId }, select: { name: true, requesterId: true, requestStatus: true, estimatedBudget: true, createdAt: true } });
    if (!c) return null;
    return { name: c.name, requesterId: c.requesterId, beneficiary: c.name, label: `Congrès — ${c.name}`, legacyStatus: c.requestStatus, estimatedAmount: c.estimatedBudget != null ? toNumber(c.estimatedBudget) : null, createdAt: c.createdAt };
  }
  if (entityType === "CONGRESS_NATIONAL") {
    const c = await prisma.congressNational.findUnique({ where: { id: entityId }, select: { name: true, requesterId: true, requestStatus: true, estimatedBudget: true, createdAt: true } });
    if (!c) return null;
    return { name: c.name, requesterId: c.requesterId, beneficiary: c.name, label: `Congrès — ${c.name}`, legacyStatus: c.requestStatus, estimatedAmount: c.estimatedBudget != null ? toNumber(c.estimatedBudget) : null, createdAt: c.createdAt };
  }
  if (entityType === "EVENT") {
    const e = await prisma.event.findUnique({ where: { id: entityId }, select: { name: true, requesterId: true, requestStatus: true, estimatedBudget: true, createdAt: true } });
    if (!e) return null;
    return { name: e.name, requesterId: e.requesterId, beneficiary: e.name, label: `Événement — ${e.name}`, legacyStatus: e.requestStatus, estimatedAmount: e.estimatedBudget != null ? toNumber(e.estimatedBudget) : null, createdAt: e.createdAt };
  }
  if (entityType === "AD_PRO_OTHER") {
    const o = await prisma.adProOtherRequest.findUnique({ where: { id: entityId }, select: { reference: true, title: true, beneficiary: true, requesterId: true, status: true, amount: true, createdAt: true } });
    if (!o) return null;
    return { name: o.title, requesterId: o.requesterId, beneficiary: o.beneficiary ?? o.title, label: `Autre demande ${o.reference} — ${o.title}`, legacyStatus: o.status, estimatedAmount: o.amount != null ? toNumber(o.amount) : null, createdAt: o.createdAt };
  }
  return null;
}

// ───────────────────────────── Instance (création paresseuse) ─────────────────────────────

/** Positionne une instance nouvellement créée sur l'étape correspondant au statut legacy. */
function positionFromLegacy(steps: LoadedStep[], legacy: string | null): { currentSlug: string | null; status: string } {
  const ordered = [...steps].sort((a, b) => a.position - b.position);
  if (!legacy) return { currentSlug: ordered[0]?.slug ?? null, status: "IN_PROGRESS" };
  // `PRE_VALIDATED` (§118.151) : le CIRCUIT est terminé — la tenue est décidée —, la demande vit
  // ensuite par ses postes puis sa clôture, qui ne sont pas des étapes du circuit.
  // `DONE` : une demande « autre » marquée terminée (27/10/2026) — prévalidée, puis exécutée.
  if (["APPROVED", "VALIDATED", "PAID", "CLOSED", "COMPLETED", "ACCEPTED", "PRE_VALIDATED", "DONE"].includes(legacy)) return { currentSlug: null, status: "APPROVED" };
  if (["REJECTED", "REFUSED", "CANCELLED"].includes(legacy)) return { currentSlug: null, status: "REJECTED" };
  const match = ordered.find((s) => s.legacyStatus === legacy);
  if (match) return { currentSlug: match.slug, status: "IN_PROGRESS" };
  // Statuts « legacy » élargis (appels, en analyse…) → rapprochement raisonnable.
  if (["PRELIMINARY_APPROVED"].includes(legacy)) return { currentSlug: ordered[1]?.slug ?? ordered[0]?.slug ?? null, status: "IN_PROGRESS" };
  if (["AWAITING_FINAL", "AWAITING_FINAL_APPEAL", "APPEAL_PENDING", "AWAITING_DIRECTION"].includes(legacy)) {
    const money = ordered.find((s) => s.emitDeclaration || s.emitExpenseOrder);
    return { currentSlug: (money ?? ordered[ordered.length - 1])?.slug ?? null, status: "IN_PROGRESS" };
  }
  return { currentSlug: ordered[0]?.slug ?? null, status: "IN_PROGRESS" };
}

/**
 * LA PREMIÈRE ÉTAPE RÉELLEMENT TRAVERSÉE à partir d'un slug : si le statut legacy désigne une étape du
 * tamis (la porte du DG, hors circuit depuis le 27/10/2026), on avance jusqu'à la suivante qui ne l'est pas.
 */
function premiereEtapeTraversee(def: LoadedDefinition, slug: string | null, ignorees: readonly string[]): string | null {
  if (!slug || !ignorees.includes(slug)) return slug;
  const ordonnees = orderedSteps(def);
  const depuis = ordonnees.findIndex((st) => st.slug === slug);
  return ordonnees.slice(depuis + 1).find((st) => !ignorees.includes(st.slug))?.slug ?? slug;
}

/** Crée l'instance si absente (idempotent), positionnée d'après le statut legacy courant. */
export async function ensureInstance(entityType: EntityType, entityId: string): Promise<LoadedInstance | null> {
  const category = entityToCategory(entityType);
  if (!category) return null;
  const existing = await prisma.workflowInstance.findUnique({ where: { entityType_entityId: { entityType, entityId } } });
  if (existing) return existing;
  const def = await getDefinition(category);
  const summary = await loadEntity(entityType, entityId);
  const { currentSlug, status } = positionFromLegacy(orderedSteps(def), summary?.legacyStatus ?? null);
  // LA BORNE ET LE TAMIS DU PARCOURS, fixés MAINTENANT et jamais recalculés.
  //
  // Ils se lisent sur le DEMANDEUR et sur la NATURE de la demande (`parcoursAdPro` : le rang et
  // le métier de son auteur, et le sponsoring d'un KAM qui traverse aussi la Direction des
  // opérations). On les fige à la naissance de l'instance
  // parce qu'un KAM promu National Sales en cours de circuit ne doit pas voir sa chaîne
  // changer — et surtout parce qu'un National Sales redevenu KAM ne doit pas PERDRE la
  // validation de la Direction qui lui était promise. Le parcours est un fait de la DEMANDE.
  //
  // Demandeur inconnu (demande sans auteur) ⇒ `null` ⇒ chaîne complète : on n'ampute jamais un
  // circuit sur une absence de donnée, le sens sûr étant celui qui garde une validation de plus.
  const demandeur = summary?.requesterId
    ? await prisma.user
        .findUnique({ where: { id: summary.requesterId }, select: { role: true, secondaryRole: true } })
        .catch(sansBloquer("workflow-engine.ensureInstance.user", null))
    : null;
  //
  // LES DEUX FAITS SE LISENT D'UN SEUL APPEL. Ils viennent de la même branche : en tirer un sans
  // l'autre laisserait une demande s'arrêter là où la vue annonce qu'elle continue (§118.5).
  const parcours = demandeur
    ? parcoursEffectif(demandeur, orderedSteps(def).map((st) => st.slug), adProOriginRank(demandeur), category)
    : null;
  const finalSlug = parcours?.decision ?? null;
  const skippedSlugs = parcours ? [...parcours.ignorees] : [];
  // L'ÉTAPE DE POSE NE PEUT PAS ÊTRE HORS DU PARCOURS (27/10/2026). Le statut legacy d'entrée
  // (« préliminaire faite ») désigne la PREMIÈRE étape qui le porte — la porte du DG, qui n'est plus
  // sur la route : la demande s'y serait posée devant un DG qui n'a rien à valider. On avance donc
  // jusqu'à la première étape réellement traversée.
  const pose = status === "IN_PROGRESS" ? premiereEtapeTraversee(def, currentSlug, skippedSlugs) : currentSlug;
  try {
    const created = await prisma.workflowInstance.create({
      data: { definitionId: def.id, entityType, entityId, category, currentSlug: pose, status, finalSlug, skippedSlugs },
    });
    // LA PREMIÈRE LIGNE DE L'HISTORIQUE : QUI a demandé, et QUAND.
    //
    // L'historique ne commençait qu'à la première validation : on lisait « approuvé par X à
    // 14 h 12 » sans jamais savoir qui avait demandé, ni à quelle heure. On horodate donc à
    // l'instant EXACT de création de la demande (`summary.createdAt`), et non à celui où
    // l'instance est ouverte — elle l'est paresseusement, parfois des jours plus tard.
    if (summary?.requesterId) {
      const requester = await prisma.user
        .findUnique({ where: { id: summary.requesterId }, select: { name: true } })
        .catch(sansBloquer("workflow-engine.ensureInstance.user", null));
      await prisma.workflowStepEvent
        .create({
          data: {
            instanceId: created.id,
            stepSlug: "__created__",
            stepTitle: "Demande créée",
            action: "CREATE",
            actorId: summary.requesterId,
            actorName: requester?.name ?? null,
            note: summary.label,
            createdAt: summary.createdAt ?? created.createdAt,
          },
        })
        .catch((e) => console.error("[workflow] ligne de création non journalisée (non bloquant)", e));
    }
    // ═══════════════════════════════════════════════════════════════════════════════════════
    // LES FRANCHISSEMENTS AUTOMATIQUES S'APPLIQUENT AUSSI À L'ÉTAPE D'ENTRÉE (§118.138).
    //
    // Ils ne se réglaient qu'EN TRANSIT, après une approbation. Une demande qui ENTRE sur une
    // étape franchissable y restait donc posée pour toujours : c'est exactement le cas d'un
    // demandeur non-KAM depuis l'inversion du circuit — il entre par la porte du Directeur
    // Général, qui doit s'ouvrir seule sous le seuil. Sans cette ligne, sa demande attendrait un
    // DG qui n'a rien à valider, sans une seule étape en échec et sans que rien ne le dise.
    //
    // L'ACTEUR est le DEMANDEUR, faute de quoi rien n'est franchi : c'est lui qui vient de
    // soumettre, et attribuer le franchissement à personne rendrait la ligne d'historique
    // illisible. Sans demandeur connu, on ne franchit rien — un montant qu'on ne sait pas
    // rattacher ne doit pas ouvrir une porte de contrôle.
    // ═══════════════════════════════════════════════════════════════════════════════════════
    // PRÉVALIDÉE D'OFFICE (27/10/2026) : la demande de la Direction Marketing n'attend personne. L'étape
    // de prévalidation est franchie maintenant, AU NOM de sa créatrice, par le même geste que l'écran
    // (déclaration, statut, notifications compris) — et le journal dit pourquoi.
    if (parcours?.dOffice && summary?.requesterId && status === "IN_PROGRESS" && pose === SLUG_MARKETING) {
      const creatrice = await prisma.user
        .findUnique({ where: { id: summary.requesterId }, select: { name: true, role: true, secondaryRole: true } })
        .catch(sansBloquer("workflow-engine.ensureInstance.user", null));
      if (creatrice) {
        const r = await advanceWorkflowInstance({
          viewer: { id: summary.requesterId, role: creatrice.role, secondaryRole: creatrice.secondaryRole, name: creatrice.name },
          entityType, entityId, action: "APPROVE",
          note: "Prévalidée d'office — demande de la Direction Marketing (règle du 27/10/2026).",
        }).catch((e) => ({ ok: false as const, error: String(e) }));
        if (!r.ok) console.error("[workflow] prévalidation d'office non appliquée", entityType, entityId, r.error);
      }
      return prisma.workflowInstance.findUnique({ where: { id: created.id } });
    }
    if (summary?.requesterId && pose) {
      const depart = stepBySlug(def, pose);
      const montant = summary.estimatedAmount ?? 0;
      if (depart && montant > 0) {
        const demandeur = await prisma.user
          .findUnique({ where: { id: summary.requesterId }, select: { name: true, role: true, secondaryRole: true } })
          .catch(sansBloquer("workflow-engine.ensureInstance.user", null));
        if (demandeur) {
          const repos = await settleAutoSkips(
            entityType, entityId, def, created.id, montant, summary.requesterId, depart,
            { id: summary.requesterId, role: demandeur.role, secondaryRole: demandeur.secondaryRole, name: demandeur.name },
            finalSlug, skippedSlugs,
          );
          if (repos && repos.slug !== pose) {
            const avance = await prisma.workflowInstance.update({ where: { id: created.id }, data: { currentSlug: repos.slug } });
            return avance;
          }
        }
      }
    }
    return created;
  } catch {
    return prisma.workflowInstance.findUnique({ where: { entityType_entityId: { entityType, entityId } } });
  }
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
    default:
      return step.actorRoles.some((r) => hasRole(viewer, r as UserRole));
  }
}

// ───────────────────────────── Progression ─────────────────────────────

export interface AdvanceInput {
  viewer: Viewer;
  entityType: EntityType;
  entityId: string;
  /**
   * `RETURN` : RENVOYER POUR CORRECTION (audit 360°, R02 — §118.186). Un refus adouci, ouvert là où le
   * refus l'est : la demande revient au demandeur, motif à l'appui, sans être tranchée.
   */
  action: "APPROVE" | "REJECT" | "COMMENT" | "SKIP" | "RETURN";
  note?: string | null;
  amount?: number | null;
  budgetCategoryId?: string | null;
  assigneeId?: string | null;
}

type AdvanceResult = { ok: true; category: WorkflowCategory } | { ok: false; error: string };

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UN GESTE À LA FOIS SUR UN CIRCUIT (§118.186).
 *
 * Approuver, refuser, sauter, renvoyer, resoumettre, retirer, relancer, faire appel : chaque
 * geste PREND le circuit avant son premier effet et le REND à la fin, même en échec.
 *
 * ── LE DÉFAUT QUE LA PRISE FERME ─────────────────────────────────────────────────────────
 *
 * Les écritures du moteur n'étaient pas conditionnelles : deux clics à une seconde d'intervalle
 * sur « Approuver » à l'étape qui tranche lisaient le même état, et chacun émettait son ordre de
 * dépense. Le renvoi pour correction a rendu le défaut plus probable — un validateur renvoie
 * pendant qu'un autre approuve, et les deux s'appliquent : la demande est « à corriger » chez son
 * demandeur ET approuvée.
 *
 * ── POURQUOI UNE CONDITION SUR L'ÉTAT NE SUFFIT PAS ─────────────────────────────────────
 *
 * L'approbation ne déplace l'étape qu'à sa FIN (après l'émission, la projection, les
 * franchissements). Un second geste lu pendant ce temps voit l'étape INCHANGÉE et la croit
 * libre : une condition `currentSlug = étape` le laisserait passer. Il faut un fait posé AU
 * DÉBUT et retiré à la fin — c'est la prise, écrite conditionnellement : celui qui la pose gagne,
 * l'autre trouve le circuit pris (ou déjà déplacé) et le dit.
 *
 * ── CE QUI EMPÊCHE UNE PANNE DE BLOQUER UN CIRCUIT ──────────────────────────────────────
 *
 * Une prise plus vieille que deux minutes est réputée abandonnée (processus tombé en plein
 * geste) et se reprend. Le geste le plus long du moteur — une approbation qui émet — dure une
 * fraction de seconde.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
const PRISE_PERIMEE_MS = 2 * 60_000;

const CIRCUIT_PRIS = "La demande vient de changer, ou quelqu'un agit dessus au même instant : rouvrez-la pour voir où elle en est.";

/**
 * LA PRISE ET SA RESTITUTION — leurs ARGUMENTS, partagés par tous les gestes, qui gardent chacun
 * l'APPEL Prisma dans leur propre corps (même raison que `clotureDuCircuit` : la dérivation des
 * contrats ne suit qu'un niveau). La prise ne se pose que si le circuit est dans l'`etat` attendu
 * ET libre (ou abandonné) : `count === 0` dit qu'un autre geste l'a, ou que l'état a changé.
 */
function argsPrise(instanceId: string, etat: Prisma.WorkflowInstanceWhereInput, maintenant: Date) {
  return {
    where: { AND: [{ id: instanceId }, etat, { OR: [{ claimedAt: null }, { claimedAt: { lt: new Date(maintenant.getTime() - PRISE_PERIMEE_MS) } }] }] },
    data: { claimedAt: maintenant },
  } satisfies Prisma.WorkflowInstanceUpdateManyArgs;
}

/** Rend la prise — la SIENNE seulement : une prise reprise après abandon appartient à un autre. */
function argsRendre(instanceId: string, prise: Date) {
  return { where: { id: instanceId, claimedAt: prise }, data: { claimedAt: null } } satisfies Prisma.WorkflowInstanceUpdateManyArgs;
}

/**
 * Prendre en ATTENDANT qu'un geste en cours se termine — réservé aux suites d'une écriture déjà
 * faite (une modification enregistrée doit encore rouvrir sa porte). Un geste humain, lui, ne
 * patiente pas : il refuse tout de suite et le dit.
 */
async function prendreLeCircuitEnAttendant(instanceId: string, etat: Prisma.WorkflowInstanceWhereInput, patienceMs: number): Promise<Date | null> {
  const fin = Date.now() + patienceMs;
  for (;;) {
    const maintenant = new Date();
    const posee = await prisma.workflowInstance.updateMany(argsPrise(instanceId, etat, maintenant));
    if (posee.count > 0) return maintenant;
    if (Date.now() >= fin) return null;
    await new Promise((r) => setTimeout(r, 100));
  }
}

export async function advanceWorkflowInstance(input: AdvanceInput): Promise<AdvanceResult> {
  const { viewer, entityType, entityId, action } = input;
  const category = entityToCategory(entityType);
  if (!category) return { ok: false, error: "Catégorie de workflow inconnue." };

  const instance = await ensureInstance(entityType, entityId);
  if (!instance) return { ok: false, error: "Impossible d'initialiser le circuit." };
  // UNE DEMANDE À CORRIGER N'EST PAS UN CIRCUIT CLOS : elle est chez son demandeur. Le dire, au lieu
  // de « déjà clôturé », évite qu'un validateur croie la décision prise par quelqu'un d'autre.
  if (instance.status === "RETURNED") {
    return { ok: false, error: "La demande est chez son demandeur, pour correction : elle reviendra à cette étape quand il l'aura resoumise." };
  }
  if (instance.status !== "IN_PROGRESS") return { ok: false, error: "Ce circuit est déjà clôturé." };

  const def = await prisma.workflowDefinition.findUnique({ where: { id: instance.definitionId }, include: { steps: { orderBy: { position: "asc" } } } });
  if (!def) return { ok: false, error: "Définition de workflow introuvable." };
  const step = stepBySlug(def, instance.currentSlug);
  if (!step) return { ok: false, error: "Étape courante introuvable." };

  const summary = await loadEntity(entityType, entityId);
  if (!summary) return { ok: false, error: "Demande introuvable." };

  if (!(await canActOnStep(viewer, step, instance, { requesterId: summary.requesterId }))) {
    return { ok: false, error: "Vous n'êtes pas habilité à agir à cette étape." };
  }

  const note = input.note?.trim() || null;

  // LA BORNE DE SORTIE DU PARCOURS de cette demande — lue UNE fois, pour les trois gestes.
  //
  // Elle est hissée ici et non au moment de l'approbation, parce que le REFUS et le SAUT en
  // dépendent tout autant : un refus à l'étape qui TRANCHE est définitif (le laisser passer en
  // « avis défavorable » enverrait la demande refusée d'un KAM attendre une Direction qu'elle
  // n'atteindra jamais), et l'étape qui tranche ne se saute pas.
  const borne = instance.finalSlug ?? null;
  // LE TAMIS, gelé à la naissance lui aussi. Une instance née avant la règle du 22/09/2026 porte
  // une liste VIDE — donc exactement la chaîne qui lui avait été promise, sans étape retirée
  // rétroactivement. Amputer un circuit en vol ferait atteindre la décision à une demande dont
  // l'écran annonçait qu'un validateur la verrait encore (§118.16).
  const ignorees = instance.skippedSlugs ?? [];

  // COMMENT : simple trace + commentaire sur l'entité, sans avancer.
  if (action === "COMMENT") {
    if (!step.powers.includes("COMMENT")) return { ok: false, error: "Le commentaire n'est pas autorisé à cette étape." };
    if (!note) return { ok: false, error: "Commentaire vide." };
    await prisma.comment.create({ data: { entityType, entityId, body: note, authorId: viewer.id } });
    await recordEvent(instance.id, step, "COMMENT", viewer, note, null);
    return { ok: true, category };
  }

  // UN GESTE À LA FOIS : le circuit est PRIS avant le premier effet et rendu à la fin
  // (`prendreLeCircuit`). Le commentaire, qui ne fait pas avancer, n'en a pas besoin.
  const prise = new Date();
  const posee = await prisma.workflowInstance.updateMany(argsPrise(instance.id, { status: "IN_PROGRESS", currentSlug: step.slug }, prise));
  if (posee.count === 0) return { ok: false, error: CIRCUIT_PRIS };
  try {
    return await appliquerLeGeste({ input, action, viewer, entityType, entityId, category, instance, def, step, summary, note, borne, ignorees });
  } finally {
    await prisma.workflowInstance.updateMany(argsRendre(instance.id, prise)).catch(sansBloquer("workflow-engine.advanceWorkflowInstance.workflowInstance"));
  }
}

/** Ce que les gestes d'avance lisent — validé par `advanceWorkflowInstance`, sous prise. */
interface ContexteGeste {
  input: AdvanceInput;
  action: AdvanceInput["action"];
  viewer: Viewer;
  entityType: EntityType;
  entityId: string;
  category: WorkflowCategory;
  instance: LoadedInstance;
  def: LoadedDefinition;
  step: LoadedStep;
  summary: EntitySummary;
  note: string | null;
  borne: string | null;
  ignorees: string[];
}

/**
 * LES GESTES QUI FONT AVANCER LE CIRCUIT — renvoyer, refuser, sauter, approuver. Jamais appelés
 * directement : `advanceWorkflowInstance` valide l'acteur et l'étape, puis PREND le circuit.
 */
async function appliquerLeGeste(ctx: ContexteGeste): Promise<AdvanceResult> {
  const { input, action, viewer, entityType, entityId, category, instance, def, step, summary, note, borne, ignorees } = ctx;

  // ═══════════════════════════════════════════════════════════════════════════════════════
  // RENVOYER POUR CORRECTION (audit 360°, R02 — §118.186).
  //
  // Ni accord, ni refus : la demande retourne à son DEMANDEUR, avec ce qu'il doit corriger, et
  // revient À CETTE ÉTAPE quand il la resoumet. C'est le geste qui manquait entre « laisser passer
  // une demande fausse » et « la tuer pour un montant mal tapé ».
  //
  // Trois gardes, chacune avec son cas, écrites dans `refusDuRenvoi` (pur, éprouvé sans base) :
  // ouvert là où le REFUS l'est, motif OBLIGATOIRE, un DEMANDEUR à qui renvoyer.
  // L'écriture est CONDITIONNELLE : un renvoi et un accord donnés en même temps sur la même étape ne
  // s'appliquent pas tous les deux — le second trouve l'étape déjà quittée et le dit.
  // ═══════════════════════════════════════════════════════════════════════════════════════
  if (action === "RETURN") {
    const refus = refusDuRenvoi({ pouvoirs: step.powers, motif: note, demandeurId: summary.requesterId });
    if (refus) return { ok: false, error: refus };
    const demandeurId = summary.requesterId as string; // garanti par `refusDuRenvoi`
    const pris = await prisma.workflowInstance.updateMany({
      where: { id: instance.id, status: "IN_PROGRESS", currentSlug: step.slug },
      data: { status: "RETURNED" },
    });
    if (pris.count === 0) return { ok: false, error: "La demande vient de changer d'étape : rouvrez-la pour voir où elle en est." };
    await projectReturn(entityType, entityId, viewer);
    await recordEvent(instance.id, step, "RETURN", viewer, note, null);
    // LE MOTIF VOYAGE AVEC LA NOTIFICATION : le demandeur sait quoi corriger sans ouvrir la fiche.
    await notifyUser({
      userId: demandeurId, type: "ASSIGNMENT",
      title: `${CATEGORY_LABELS[category]} — à corriger`,
      body: `${summary.name} — ${step.title} : ${note}`,
      link: entityPath(entityType, entityId),
    });
    await recordAudit({ actorId: viewer.id, action: "UPDATE", module: auditModule(entityType), entityType, entityId, summary: `Renvoyée pour correction (${step.title}) — ${summary.name} : ${note}` });
    return { ok: true, category };
  }

  if (action === "REJECT") {
    if (!step.powers.includes("REJECT")) return { ok: false, error: "Le refus n'est pas autorisé à cette étape." };
    if (!note) return { ok: false, error: "Le motif du refus est obligatoire." };
    const next = nextStepAfter(def, step, borne, ignorees);

    if (next) {
      // Étape INTERMÉDIAIRE (National Sales, Direction Marketing…) : le refus n'est PAS
      // éliminatoire — c'est un AVIS DÉFAVORABLE. Il est consigné et le circuit
      // continue vers l'étape suivante (la décision finale reste à la Direction).
      const assigneeId = input.assigneeId?.trim() || null;
      // Montant révisé OPTIONNEL joint à l'avis défavorable : uniquement si l'étape porte le
      // pouvoir « fixer un montant » (SET_AMOUNT, ex. analyse Direction Marketing) et qu'un montant
      // positif est fourni. Sinon on reste sur le comportement actuel (aucun montant).
      const revisedAmount = step.powers.includes("SET_AMOUNT") && input.amount != null && input.amount > 0 ? input.amount : null;
      if (step.powers.includes("ASSIGN")) {
        if (!assigneeId) return { ok: false, error: "Même en cas d'avis défavorable, désignez la personne en charge de l'étape suivante." };
        const okUser = await prisma.user.count({ where: { id: assigneeId, isActive: true } });
        if (okUser === 0) return { ok: false, error: "La personne désignée est introuvable ou inactive." };
        await prisma.workflowInstance.update({ where: { id: instance.id }, data: { assigneeId } });
      }
      await projectApprove(entityType, entityId, step, next, {
        viewer, note, amount: revisedAmount, assigneeId, emitResult: null,
        nextLegacyStatus: next.legacyStatus ?? null, emitStep: false,
      });
      // ENCHAÎNE LES FRANCHISSEMENTS AUTOMATIQUES, exactement comme une approbation et un saut
      // (§118.138). L'avis défavorable était le SEUL des trois gestes d'avance à ne pas les
      // régler : la demande se posait alors sur une étape franchissable — la porte du Directeur
      // Général sous le seuil — et y restait, à attendre quelqu'un qui n'a rien à valider. Une
      // porte gardée à côté d'une porte ouverte, et c'est la même chose qui passe (§118.71).
      const montantApresAvis = revisedAmount ?? (toNumber(instance.amount) || (summary.estimatedAmount ?? 0));
      const apresAvis = (await settleAutoSkips(entityType, entityId, def, instance.id, montantApresAvis, summary.requesterId, next, viewer, borne, ignorees)) ?? next;
      // Le montant révisé devient le montant de TRAVAIL de l'instance (proposition portée à la
      // décision + base des franchissements auto par seuil en aval).
      const rejectInst: Prisma.WorkflowInstanceUpdateInput = { currentSlug: apresAvis.slug, status: "IN_PROGRESS" };
      if (revisedAmount != null) rejectInst.amount = revisedAmount;
      await prisma.workflowInstance.update({ where: { id: instance.id }, data: rejectInst });
      await recordEvent(instance.id, step, "OPINION_AGAINST", viewer, note, revisedAmount);
      // ON PRÉVIENT L'ÉTAPE OÙ L'ON SE POSE, pas la suivante nominale : après un franchissement
      // automatique, notifier `next` alerterait quelqu'un qui n'a plus rien à faire, et
      // laisserait le vrai destinataire sans signal.
      if (assigneeId && apresAvis.actorScope === "ASSIGNEE") {
        await notifyUser({ userId: assigneeId, type: "ASSIGNMENT", title: `${CATEGORY_LABELS[category]} — ${apresAvis.title} (avis défavorable en amont)`, body: summary.name, link: entityPath(entityType, entityId) });
      }
      await notifyStepManager(apresAvis, summary.requesterId, `${CATEGORY_LABELS[category]} — ${apresAvis.title}`, `${summary.name} — avis défavorable en amont`, entityPath(entityType, entityId));
      await prevenirEtapeAtteinte(entityType, entityId, apresAvis, { title: `${CATEGORY_LABELS[category]} — ${apresAvis.title}`, body: `${summary.name} — avis défavorable en amont`, link: entityPath(entityType, entityId) }, summary.requesterId);
      await recordAudit({ actorId: viewer.id, action: "UPDATE", module: auditModule(entityType), entityType, entityId, summary: `Avis défavorable (${step.title}) — ${summary.name}` });
      return { ok: true, category };
    }

    // DERNIÈRE étape (décision de la Direction) : le refus est définitif.
    await prisma.workflowInstance.update({ where: { id: instance.id }, data: { status: "REJECTED", currentSlug: null } });
    await projectReject(entityType, entityId, viewer, note);
    await recordEvent(instance.id, step, "REJECT", viewer, note, null);
    if (summary.requesterId) {
      // LE MOTIF VOYAGE AVEC LE REFUS (R03) : « demande refusée » sans dire pourquoi obligeait le
      // demandeur à chercher une explication qu'aucun écran ne lui montrait.
      await notifyUser({ userId: summary.requesterId, type: "GENERIC", title: `${CATEGORY_LABELS[category]} — demande refusée`, body: `${summary.name} — ${step.title} : ${note}`, link: `${entityPath(entityType, entityId)}` });
    }
    await recordAudit({ actorId: viewer.id, action: "REFUSE", module: auditModule(entityType), entityType, entityId, summary: `Refus définitif (${step.title}) — ${summary.name}` });
    return { ok: true, category };
  }

  // SKIP : sauter une étape INTERMÉDIAIRE, à la main, avec RAISON OBLIGATOIRE (anti-bureaucratie).
  // C'est tracé (WorkflowStepEvent « SKIP » + audit) et notifié à l'étape suivante. Interdit sur la
  // décision finale (pas d'étape suivante) et sur une étape de désignation (sinon plus personne en charge).
  if (action === "SKIP") {
    const next = nextStepAfter(def, step, borne, ignorees);
    if (!next) return { ok: false, error: "L'étape de décision finale ne peut pas être sautée." };
    if (step.powers.includes("ASSIGN")) return { ok: false, error: "Cette étape désigne le responsable de la suite : elle ne peut pas être sautée." };
    if (!note) return { ok: false, error: "Indiquez la raison du saut d'étape (elle est tracée et notifiée)." };

    // Avance sans approuver ni émettre : on projette uniquement le statut de l'étape suivante.
    await projectApprove(entityType, entityId, step, next, {
      viewer, note, amount: null, assigneeId: null, emitResult: null,
      nextLegacyStatus: next.legacyStatus ?? null, emitStep: false,
    });
    // Enchaîne d'éventuels franchissements automatiques par seuil de montant.
    const skipKnownAmount = toNumber(instance.amount) || (summary.estimatedAmount ?? 0);
    const landed = (await settleAutoSkips(entityType, entityId, def, instance.id, skipKnownAmount, summary.requesterId, next, viewer, borne, ignorees)) ?? next;
    await prisma.workflowInstance.update({ where: { id: instance.id }, data: { currentSlug: landed.slug, status: "IN_PROGRESS" } });
    await recordEvent(instance.id, step, "SKIP", viewer, note, null);

    const skipTitle = `${CATEGORY_LABELS[category]} — ${landed.title} (étape « ${step.title} » sautée)`;
    if (landed.actorScope === "ASSIGNEE" && instance.assigneeId) {
      await notifyUser({ userId: instance.assigneeId, type: "ASSIGNMENT", title: skipTitle, body: summary.name, link: entityPath(entityType, entityId) });
    }
    await notifyStepManager(landed, summary.requesterId, skipTitle, summary.name, entityPath(entityType, entityId));
    await prevenirEtapeAtteinte(entityType, entityId, landed, { title: skipTitle, body: summary.name, link: entityPath(entityType, entityId) }, summary.requesterId);
    await recordAudit({ actorId: viewer.id, action: "UPDATE", module: auditModule(entityType), entityType, entityId, summary: `Étape sautée : « ${step.title} » — ${summary.name} (raison : ${note})` });
    return { ok: true, category };
  }

  // action === APPROVE
  if (!step.powers.includes("APPROVE")) return { ok: false, error: "Cette étape ne permet pas d'approuver." };

  // L'ÉTAPE SUIVANTE, LUE ICI ET UNE SEULE FOIS — c'est elle qui dit si cette étape CONCLUT.
  //
  // Elle était calculée plus bas, et l'héritage d'émission se gouvernait sur la BORNE
  // (`estDecisionnaire`). Depuis que le parcours est un TAMIS, les deux ne coïncident plus : un
  // KAM n'a AUCUNE borne (Direction Marketing est la dernière étape de la définition) et saute
  // pourtant la Direction des opérations. Un Super Admin qui aurait posé l'ordre de dépense sur
  // cette étape-là aurait vu l'émission se perdre — budget accordé, rien d'engagé, aucune étape
  // en échec, exactement le silence que l'héritage existe pour fermer.
  //
  // « Y a-t-il une suite ? » est déjà l'unique lecture qui réunit la borne ET le tamis. On s'en
  // sert donc, au lieu d'en écrire une seconde qui divergerait (§118.5, §118.61) — et l'écran lit
  // la MÊME réponse (`lectureDeLApprobation`), pour proposer exactement les champs jugés ici.
  //
  // L'ÉMISSION HÉRITÉE DE TOUT CE QUI N'EST PAS ATTEINT — la queue coupée ET le tamis.
  //
  // Une demande de KAM s'arrête à Direction Marketing ; l'émission financière peut être déclarée
  // sur une étape qu'elle n'atteindra jamais. Sans cet héritage, la demande sort APPROUVÉE avec
  // son budget accordé écrit en base et Finance ne reçoit RIEN : l'argent est accordé, rien n'est
  // engagé, et aucune étape n'est en échec. On ne réécrit pas la définition pour autant (§118.5)
  // — le Super Admin a posé ses drapeaux où il les voulait ; c'est l'EXÉCUTION qui hérite, et
  // seulement à l'étape qui CONCLUT, une fois qu'il est sûr que rien d'autre ne viendra.
  //
  // LES POUVOIRS D'ARGENT SUIVENT LE MÊME CHEMIN, et c'est ce qui manquait (`pouvoirs-argent.ts`).
  // Hériter l'émission sans hériter le montant ne servait à rien : `emitFinancials` ne part pas
  // sans montant fixé, et la Direction des opérations, qui conclut la route d'un rang 2, n'avait
  // aucun moyen d'en fixer un — 12 demandes sur 12 sortaient approuvées sans budget ni dépense.
  // `etape` est donc l'étape TELLE QU'ELLE DÉCIDE : c'est elle qu'on juge (montant, catégorie) et
  // dont on lit l'issue ; `step` reste l'étape de la définition, pour tout le reste.
  const { next, conclut, nonAtteintes, etape } = lectureDeLApprobation(def, step, borne, ignorees);
  const emitDeclarationDue = step.emitDeclaration || nonAtteintes.some((s) => s.emitDeclaration);
  const emitExpenseOrderDue = step.emitExpenseOrder || nonAtteintes.some((s) => s.emitExpenseOrder);
  const emitStep = emitDeclarationDue || emitExpenseOrderDue;
  // UN SPONSORING DONT CETTE ÉTAPE PRÉ-VALIDE LA TENUE (§118.151) : l'argent se décidera APRÈS,
  // poste par poste puis à la clôture. La déclaration d'information médicale ne peut pas attendre
  // jusque-là — la clôture vient une fois l'événement passé, trop tard pour le déclarer.
  //
  // L'ISSUE SE LIT SUR L'ÉTAPE TELLE QU'ELLE DÉCIDE : sur le circuit par défaut, l'étape décisive
  // du sponsoring ne fixe aucun argent, donc rien n'est hérité et la tenue reste pré-validée. Sur
  // un circuit dont le Super Admin a laissé l'argent à Direction Marketing, l'étape qui conclut une
  // route coupée hérite ce pouvoir — et ACCORDE, exactement comme l'étape dont elle tient la place.
  //
  // DEPUIS LE 27/10/2026, C'EST LA RÈGLE DE TOUTES LES NATURES : la Direction Marketing PRÉVALIDE (le
  // fond de la demande et le montant demandé), puis l'argent se décide poste par poste, et le DG valide
  // le total au-dessus du seuil (`ad-pro/porte-dg.ts`). Un circuit dont l'étape qui conclut fixe encore
  // un montant (remodelé à la main) garde son comportement d'avant.
  const argentDecideApres = conclut && issueTerminaleSponsoring(etape) === "PRE_VALIDATED";
  const amount = input.amount ?? null;
  const budgetCategoryId = input.budgetCategoryId?.trim() || null;
  const assigneeId = input.assigneeId?.trim() || null;

  // Contrôles des champs requis par l'étape — telle qu'elle décide.
  if (step.powers.includes("ASSIGN") && !assigneeId) return { ok: false, error: "Désignez la personne en charge de l'étape suivante." };
  if (etape.requireAmount && !(amount != null && amount > 0)) return { ok: false, error: "Le montant est obligatoire à cette étape." };
  if (step.requireNote && !note) return { ok: false, error: "Un commentaire est obligatoire à cette étape." };
  if (etape.requireCategory && !budgetCategoryId) return { ok: false, error: "La (sous-)catégorie budgétaire est obligatoire à cette étape." };
  if (budgetCategoryId) {
    const okCat = await prisma.budgetCategoryLine.count({ where: { id: budgetCategoryId } });
    if (okCat === 0) return { ok: false, error: "La (sous-)catégorie budgétaire choisie est introuvable." };
  }
  if (assigneeId) {
    const okUser = await prisma.user.count({ where: { id: assigneeId, isActive: true } });
    if (okUser === 0) return { ok: false, error: "La personne désignée est introuvable ou inactive." };
  }

  // Effets sur l'instance : désignation, montant « accordé » (uniquement à l'étape
  // d'émission — sinon le montant est une PROPOSITION portée par la projection),
  // (sous-)catégorie budgétaire.
  const instData: Prisma.WorkflowInstanceUpdateInput = {};
  if (assigneeId) instData.assigneeId = assigneeId;
  if (budgetCategoryId) instData.budgetCategoryId = budgetCategoryId;
  // Le montant d'une étape « Fixer un montant » (proposition) OU de l'étape d'émission (accordé)
  // devient le montant de TRAVAIL de l'instance : base des franchissements auto par seuil en aval.
  if (amount != null && (emitStep || etape.powers.includes("SET_AMOUNT"))) instData.amount = amount;
  if (Object.keys(instData).length) await prisma.workflowInstance.update({ where: { id: instance.id }, data: instData });

  const refreshed = await prisma.workflowInstance.findUnique({ where: { id: instance.id } });
  const liveInstance = refreshed ?? instance;

  // Émission financière (à l'étape marquée) : information médicale (PRIM) ou, à défaut
  // de pharmacien, ordre de dépense direct → Finances.
  let emitResult: { declarationId: string | null; orderId: string | null } | null = null;
  if (emitStep) {
    emitResult = await emitFinancials(entityType, entityId,
      { emitDeclaration: emitDeclarationDue, emitExpenseOrder: emitExpenseOrderDue, argentDecideApres },
      liveInstance, summary, viewer);
  }

  // Projection « legacy » : écrit les champs de l'entité source attendus par l'UI. L'étape TELLE
  // QU'ELLE DÉCIDE, ici aussi : l'issue d'un sponsoring s'y relit (§118.151), et elle doit être la
  // même que celle que `argentDecideApres` vient de juger.
  await projectApprove(entityType, entityId, etape, next, {
    viewer, note, amount, assigneeId, emitResult,
    nextLegacyStatus: next?.legacyStatus ?? null,
    emitStep,
    // LE MONTANT ACCORDÉ EST CELUI DE L'INSTANCE, pas la saisie de l'étape qui conclut.
    //
    // La Direction n'a plus le pouvoir « fixer un montant » : elle accorde ce que Direction
    // Marketing a arbitré. Sans ce repli, son approbation écrivait `amountGranted = undefined`
    // — la demande passait APPROUVÉE, l'ordre de dépense partait avec 87 500 DZD, et la fiche
    // n'affichait aucun budget accordé.
    montantDeTravail: toNumber(liveInstance.amount) || null,
  });

  // Franchissements AUTOMATIQUES par seuil de montant (anti-bureaucratie) à partir de l'étape suivante.
  // Montant de référence : montant de travail de l'instance, à défaut l'estimation du demandeur.
  const knownAmount = toNumber(liveInstance.amount) || (summary.estimatedAmount ?? 0);
  const landed = await settleAutoSkips(entityType, entityId, def, instance.id, knownAmount, summary.requesterId, next, viewer, borne, ignorees);

  // Avance l'instance (ou clôture).
  await prisma.workflowInstance.update({
    where: { id: instance.id },
    data: { currentSlug: landed ? landed.slug : null, status: landed ? "IN_PROGRESS" : "APPROVED" },
  });

  await recordEvent(instance.id, step, "APPROVE", viewer, note, emitStep ? amount : amount);

  // Notifications d'entrée de l'étape où l'on se pose réellement (après d'éventuels franchissements auto).
  if (landed) {
    if (assigneeId && landed.actorScope === "ASSIGNEE") {
      await notifyUser({ userId: assigneeId, type: "ASSIGNMENT", title: `${CATEGORY_LABELS[category]} — ${landed.title}`, body: summary.name, link: entityPath(entityType, entityId) });
    }
    await notifyStepManager(landed, summary.requesterId, `${CATEGORY_LABELS[category]} — ${landed.title}`, summary.name, entityPath(entityType, entityId));
    await prevenirEtapeAtteinte(entityType, entityId, landed, { title: `${CATEGORY_LABELS[category]} — ${landed.title}`, body: summary.name, link: entityPath(entityType, entityId) }, summary.requesterId);
  } else if (summary.requesterId) {
    // « Pris en charge » annoncerait un financement : une tenue PRÉ-VALIDÉE n'en accorde aucun
    // encore. Le demandeur doit lire ce qui l'attend — les postes, puis la clôture (§118.151).
    const titreFin = argentDecideApres
      ? `${CATEGORY_LABELS[category]} — prévalidée : les postes se préparent`
      : `${CATEGORY_LABELS[category]} — pris en charge`;
    await notifyUser({ userId: summary.requesterId, type: "GENERIC", title: titreFin, body: summary.name, link: entityPath(entityType, entityId) });
  }

  await recordAudit({ actorId: viewer.id, action: next ? "UPDATE" : "VALIDATE", module: auditModule(entityType), entityType, entityId, summary: `${step.title} — ${summary.name}${emitResult?.orderId ? " (ordre de dépense émis)" : emitResult?.declarationId ? " (déclaration info médicale)" : ""}` });
  return { ok: true, category };
}

// ───────────────────────────── Effets & projection ─────────────────────────────

async function emitFinancials(
  entityType: EntityType,
  entityId: string,
  /**
   * Les émissions DUES à cette approbation — celles de l'étape, plus celles héritées de la queue
   * coupée — et `argentDecideApres` : l'étape décide la TENUE, pas l'argent (§118.151).
   */
  step: { emitDeclaration: boolean; emitExpenseOrder: boolean; argentDecideApres?: boolean },
  instance: LoadedInstance,
  summary: EntitySummary,
  viewer: Viewer,
): Promise<{ declarationId: string | null; orderId: string | null } | null> {
  const amount = toNumber(instance.amount);
  // SANS MONTANT FIXÉ, RIEN NE PART — sauf la déclaration d'une tenue pré-validée.
  //
  // La règle d'avant tient pour tout ce qui ENGAGE de l'argent : aucun ordre de dépense sur un
  // montant que personne n'a décidé (§118.16). Mais une tenue pré-validée n'engage rien encore, et
  // l'événement doit être déclaré AVANT d'avoir lieu : attendre la clôture, qui vient après
  // l'événement, reviendrait à ne jamais le déclarer à temps. La déclaration part donc sans
  // montant fixé, avec l'estimation que portent ses postes — une information, pas un engagement :
  // son montant ne sert qu'à l'ordre global que la Direction émettait à la validation de la
  // déclaration, et cet ordre-là n'est plus émis quand des postes portent la dépense
  // (`validateDeclarationByDirection`).
  if (!(amount > 0) && !step.argentDecideApres) return null;
  const budgetCategoryId = instance.budgetCategoryId ?? null;
  const requestedById = summary.requesterId ?? viewer.id;

  // Le pharmacien désigné — le plus ancien actif, déterministe (`pharmacienAssigne`).
  const pharmacist = await pharmacienAssigne();
  if (pharmacist && step.emitDeclaration) {
    const montantDeclare = await montantADeclarer(entityType, entityId, amount);
    const decl = await createMedicalInfoDeclaration({
      sourceType: entityType, sourceId: entityId, label: summary.label,
      beneficiary: summary.beneficiary, amount: montantDeclare, requesterId: requestedById, budgetCategoryId,
    });
    return { declarationId: decl.id, orderId: null };
  }
  // SANS PHARMACIEN : le paiement part comme avant — rien n'est bloqué ni débloqué ici.
  const paiement = await (async (): Promise<{ declarationId: string | null; orderId: string | null } | null> => {
    // Un ordre de dépense n'est JAMAIS émis sur un montant que personne n'a fixé.
    if (!(amount > 0)) return null;
    if (step.emitExpenseOrder) {
      // ANTI-DOUBLE COMPTAGE : si l'opération est VENTILÉE EN POSTES, chaque poste émet sa propre
      // pièce (bénéficiaires distincts : l'organisateur, l'agence, le prestataire). Émettre EN PLUS
      // un ordre global ferait payer la même dépense deux fois — c'est exactement ce qu'on voyait
      // dans « À régler » : un ordre de sponsoring de 53 350 DZD à côté de l'ordre du poste
      // « Prestation : Webinar » de 53 000 DZD, pour une seule et même dépense.
      const itemCount = await countAdProItems(entityType, entityId);
      if (itemCount > 0) {
        console.info(`[workflow] ${entityType} ${entityId} : ordre global NON émis — ${itemCount} poste(s) portent déjà la dépense.`);
        return { declarationId: null, orderId: null };
      }
      const order = await createExpenseOrder({
        label: summary.label, amount, category: "EVENEMENT", beneficiary: summary.beneficiary,
        sourceType: entityType, sourceId: entityId, requestedById, budgetCategoryId,
      });
      return { declarationId: null, orderId: order.id };
    }
    return null;
  })();
  // …MAIS LA DÉCLARATION NAÎT QUAND MÊME, non assignée (Direction, 10/2026). L'événement reste à déclarer
  // au ministère : sans pharmacien, il ne l'était jamais, et personne ne le voyait. Elle porte l'ordre déjà
  // parti, que la validation finale ne double pas (`ordreGlobalALaValidation`) ; elle n'est pas rendue à
  // l'appelant, dont le statut suit le paiement comme avant. Best-effort : le paiement est fait.
  if (step.emitDeclaration) {
    await createMedicalInfoDeclaration({
      sourceType: entityType, sourceId: entityId, label: summary.label, beneficiary: summary.beneficiary,
      amount: await montantADeclarer(entityType, entityId, amount), requesterId: requestedById, budgetCategoryId,
      expenseOrderId: paiement?.orderId ?? null,
    }).catch((e) => console.error("[workflow] déclaration non assignée non créée", e));
  }
  return paiement;
}

/**
 * LES POSTES QUI PORTENT LA DÉPENSE D'UNE OPÉRATION — la seule lecture, partagée (§118.151).
 *
 * Un poste refusé ne compte pas : il ne paiera jamais rien. Deux questions en dépendent et elles
 * ne vivent pas au même endroit : « faut-il un ordre GLOBAL en plus ? » (ici, et à la validation
 * d'une déclaration d'information médicale, `validateDeclarationByDirection`) et « quelle
 * estimation déclarer pour une tenue pré-validée ? ». Deux comptages écrits à part finiraient par
 * ne plus compter les mêmes postes, et le symptôme serait un ordre global émis À CÔTÉ des postes :
 * la même dépense payée deux fois (§118.5).
 *
 * La colonne du parent vient de `PARENT_COLONNE`, la table que la garde d'accès d'un poste lit
 * déjà — pas d'une cascade de ternaires recopiée.
 *
 * Elle ne rattrape PAS ses erreurs : c'est à l'appelant de dire dans quel sens il se trompe.
 */
export async function postesPortantLaDepense(
  entityType: EntityType, entityId: string,
): Promise<{ nombre: number; montantEstime: number }> {
  if (!(AD_PRO_PARENTS as readonly string[]).includes(entityType)) return { nombre: 0, montantEstime: 0 };
  const colonne = PARENT_COLONNE[entityType as AdProParent];
  const lignes = await prisma.adProItem.findMany({
    where: { [colonne]: entityId, status: { not: "REJECTED" } },
    select: { amountEstimated: true, amountGranted: true },
  });
  return {
    nombre: lignes.length,
    // Le montant ACCORDÉ quand il existe, sinon l'estimation du demandeur.
    montantEstime: lignes.reduce((t, l) => t + (l.amountGranted != null ? toNumber(l.amountGranted) : toNumber(l.amountEstimated)), 0),
  };
}

/** Combien de postes portent la dépense — une panne de comptage ne bloque pas la validation en cours. */
async function countAdProItems(entityType: EntityType, entityId: string): Promise<number> {
  try {
    return (await postesPortantLaDepense(entityType, entityId)).nombre;
  } catch {
    return 0; // une panne de comptage ne doit pas bloquer la validation en cours
  }
}

/**
 * LE MONTANT QU'UNE DÉCLARATION D'INFORMATION MÉDICALE PORTE (§118.151).
 *
 * Le montant FIXÉ par le circuit quand il y en a un ; sinon — une tenue pré-validée, dont l'argent
 * se décide après — l'estimation que portent ses postes ; `null` s'ils ne portent rien. Exportée
 * pour être éprouvée par la base réelle : la branche qui l'appelle n'existe que lorsqu'un
 * pharmacien est actif, ce qu'un banc ne peut pas poser sans troubler les bancs voisins.
 */
export async function montantADeclarer(entityType: EntityType, entityId: string, montantFixe: number): Promise<number | null> {
  return montantFixe > 0 ? montantFixe : montantEstimeDesPostes(entityType, entityId);
}

/**
 * UNE RÉVISION DE POSTE SE RÉPERCUTE SUR LA DÉCLARATION (§118.191, audit 10/2026).
 *
 * `repercuterMontantSurDeclaration` ne suivait que l'ancien chemin des congrès (le montant accordé
 * révisé) : un poste Ad & Pro ajouté, réestimé, accordé, refusé ou retiré laissait la déclaration
 * d'information médicale sur l'estimation de sa naissance. Quand des postes portent la dépense, le
 * montant déclaré EST leur estimation — la même lecture que `postesPortantLaDepense` (§118.5).
 *
 * Seulement tant que la déclaration n'est pas validée et qu'aucun ordre n'en est né — écriture
 * CONDITIONNELLE : une validation passée entre la lecture et l'écriture garde son montant.
 *
 * SANS POSTE (le dernier refusé ou retiré), le montant redevient celui que le CIRCUIT a fixé
 * (`montantADeclarer` sur `WorkflowInstance.amount`) — `null` pour une prévalidation, qui n'en fixe pas
 * (27/10/2026). Le laisser sur la dernière estimation faisait naître, à la validation finale de la
 * déclaration, un ORDRE GLOBAL du montant de postes refusés : aucun poste n'y portait plus la dépense,
 * donc rien ne l'empêchait (audit du 27/10/2026, ADPRO-03).
 */
export async function reporterLesPostesSurLaDeclaration(entityType: EntityType, entityId: string): Promise<void> {
  const decl = await prisma.medicalInfoDeclaration.findUnique({
    where: { sourceType_sourceId: { sourceType: entityType, sourceId: entityId } },
    select: { id: true, status: true, expenseOrderId: true },
  });
  if (!decl || decl.status === "VALIDATED" || decl.expenseOrderId) return;
  const { nombre, montantEstime } = await postesPortantLaDepense(entityType, entityId);
  let amount: number | null;
  if (nombre > 0) {
    amount = montantEstime > 0 ? montantEstime : null;
  } else {
    const instance = await prisma.workflowInstance.findUnique({
      where: { entityType_entityId: { entityType, entityId } }, select: { amount: true },
    });
    // Sans circuit (une déclaration saisie à la main), rien ne dit ce qu'elle devrait porter : on n'y touche pas.
    if (!instance) return;
    const fixe = instance.amount != null ? toNumber(instance.amount) : 0;
    amount = fixe > 0 ? fixe : null;
  }
  await prisma.medicalInfoDeclaration.updateMany({
    where: { id: decl.id, status: { not: "VALIDATED" }, expenseOrderId: null },
    data: { amount },
  });
}

/** L'estimation déclarée d'une tenue pré-validée : ce que portent ses postes, `null` s'ils ne portent rien. */
async function montantEstimeDesPostes(entityType: EntityType, entityId: string): Promise<number | null> {
  try {
    const { montantEstime } = await postesPortantLaDepense(entityType, entityId);
    return montantEstime > 0 ? montantEstime : null;
  } catch {
    // Une déclaration sans montant reste une déclaration : le pharmacien déclare l'événement, et
    // aucun ordre ne peut en naître (`validateDeclarationByDirection` n'émet rien sur un montant nul).
    return null;
  }
}

interface ProjectApproveCtx {
  viewer: Viewer;
  note: string | null;
  amount: number | null;
  assigneeId: string | null;
  emitResult: { declarationId: string | null; orderId: string | null } | null;
  nextLegacyStatus: string | null;
  emitStep: boolean;
  /** Le montant de travail de l'instance — repli quand l'étape qui conclut n'en fixe pas. */
  montantDeTravail?: number | null;
}

/** Écrit les champs « legacy » de l'entité source attendus par les frises/vues détail. */
async function projectApprove(entityType: EntityType, entityId: string, step: LoadedStep, next: LoadedStep | null, ctx: ProjectApproveCtx) {
  const now = new Date();
  const data: Record<string, unknown> = { updatedById: ctx.viewer.id };
  const statusField = LEGACY_FIELD[entityType] ?? "status";

  // Désignation (pouvoir ASSIGN) → Direction Marketing + méta préliminaire.
  if (ctx.assigneeId) {
    data.productManagerId = ctx.assigneeId;
    data.preliminaryById = ctx.viewer.id;
    data.preliminaryAt = now;
    data.preliminaryNote = ctx.note;
  }
  // Montant proposé (SET_AMOUNT hors étape d'émission) → budget Direction Marketing.
  if (!ctx.emitStep && step.powers.includes("SET_AMOUNT") && ctx.amount != null) {
    data.productManagerBudget = ctx.amount;
    data.productManagerNotes = ctx.note;
  }

  if (next) {
    // Étape intermédiaire : projeter le statut de l'étape suivante (si mappé).
    if (ctx.nextLegacyStatus) data[statusField] = ctx.nextLegacyStatus;
  } else {
    // Étape terminale : approbation définitive.
    const accorde = ctx.amount ?? ctx.montantDeTravail ?? null;
    if (entityType === "SPONSORING") {
      // LA TENUE, OU L'ARGENT (§118.151) — ce que l'étape qui conclut a réellement décidé.
      //
      // Pré-validée, la demande n'a encore AUCUN montant accordé ni validation signée : écrire
      // l'un ou l'autre ferait lire un budget accordé là où il n'y a qu'un accord de principe.
      // Le montant et la validation s'écriront à la CLÔTURE, sur le total des postes accordés.
      const issue = issueTerminaleSponsoring(step);
      data.status = issue;
      data.finalDecision = ctx.note;
      data.finalById = ctx.viewer.id;
      data.finalAt = now;
      if (issue === "APPROVED") {
        data.amountGranted = accorde ?? undefined;
        data.validatedBy = ctx.viewer.name ?? null;
        data.validationDate = now;
      }
      if (ctx.emitResult?.orderId) data.expenseOrderId = ctx.emitResult.orderId;
    } else {
      data.requestStatus = "APPROVED";
      data.status = "VALIDATED";
      data.finalById = ctx.viewer.id;
      data.finalAt = now;
      data.finalNote = ctx.note;
      if (accorde != null) data.finalAmount = accorde;
      if (ctx.emitResult?.orderId) data.expenseOrderId = ctx.emitResult.orderId;
    }
  }
  // L'ÉVÉNEMENT PORTE DEUX CHAMPS, et l'un cessait de suivre l'autre (§118.138).
  //
  // `requestStatus` est la décision du CIRCUIT ; `status` est l'état de vie de l'événement, et il
  // se tapait à la main dans « Modifier » — d'où des événements affichés « Validé » qu'aucune
  // étape n'avait validés. Le formulaire ne peut plus écrire ces deux valeurs-là
  // (`lib/events/statut.ts`) ; il fallait donc que le circuit, lui, les écrive : sans cette
  // ligne, un événement validé serait resté « Brouillon » pour toujours — un refus à tort, plus
  // coûteux que le défaut corrigé (§118.27). Une seule lecture, celle que `data` vient d'écrire,
  // pour que les deux branches (intermédiaire et terminale) ne puissent pas diverger.
  if (entityType === "EVENT") {
    const impose = statutDepuisCircuit(typeof data.requestStatus === "string" ? data.requestStatus : null);
    if (impose) data.status = impose;
  }

  // Étape d'émission NON terminale : consigner tout de même le montant accordé.
  if (ctx.emitStep && next) {
    if (entityType === "SPONSORING") data.amountGranted = ctx.amount ?? undefined;
    else if (ctx.amount != null) data.finalAmount = ctx.amount;
  }

  await updateEntity(entityType, entityId, data);
}

async function projectReject(entityType: EntityType, entityId: string, viewer: Viewer, reason: string) {
  const now = new Date();
  if (entityType === "SPONSORING") {
    await updateEntity(entityType, entityId, { status: "REFUSED", finalDecision: reason, finalById: viewer.id, finalAt: now, validatedBy: viewer.name ?? null, validationDate: now, updatedById: viewer.id });
  } else {
    const data: Record<string, unknown> = { requestStatus: "REJECTED", rejectionReason: reason, finalById: viewer.id, finalAt: now, updatedById: viewer.id };
    // L'ÉVÉNEMENT NE RESTE PAS « EN ATTENTE DE VALIDATION » après un refus définitif : plus rien
    // n'est attendu, et l'état le dirait faux. Il n'est pas ANNULÉ pour autant — on a refusé la
    // prise en charge, pas l'événement (§118.138).
    if (entityType === "EVENT") {
      const impose = statutDepuisCircuit("REJECTED");
      if (impose) data.status = impose;
    }
    await updateEntity(entityType, entityId, data);
  }
}

/**
 * LA DEMANDE RENVOYÉE SE LIT « À CORRIGER » PARTOUT — fiche, listes, compteurs.
 *
 * Garder le statut de l'étape (« Attente Direction Marketing ») ferait lire qu'un validateur a la
 * main, alors que c'est le demandeur ; la marquer refusée ferait lire une décision qui n'a pas eu
 * lieu. L'événement suit la même règle que pour un refus : plus rien n'est attendu d'un validateur,
 * il redevient un brouillon le temps de la correction (`statutDepuisCircuit`).
 */
async function projectReturn(entityType: EntityType, entityId: string, viewer: Viewer) {
  await projeterStatut(entityType, entityId, "RETURNED", viewer);
}

/**
 * ÉCRIT LE STATUT « LEGACY » D'UNE DEMANDE — et, pour un événement, l'état que ce statut impose
 * (`statutDepuisCircuit`). Une seule écriture pour le renvoi, la pose et le retrait : trois copies
 * du même couple finiraient par oublier l'état de l'événement dans l'une d'elles (§118.5).
 */
async function projeterStatut(entityType: EntityType, entityId: string, statut: string, viewer: Viewer) {
  const field = LEGACY_FIELD[entityType] ?? "status";
  const data: Record<string, unknown> = { [field]: statut, updatedById: viewer.id };
  if (entityType === "EVENT") {
    const impose = statutDepuisCircuit(statut);
    if (impose) data.status = impose;
  }
  await updateEntity(entityType, entityId, data);
}

/**
 * PROJETTE LE STATUT D'UNE ÉTAPE où l'on POSE une demande sans passer par une approbation
 * (resoumission, porte rouverte, nouveau cycle). Lu par une seule règle (`statutLegacyALEtape`),
 * pour qu'une étape sans statut propre ne laisse pas l'entité figée sur son statut d'avant.
 */
async function projectPose(entityType: EntityType, entityId: string, def: LoadedDefinition, etape: LoadedStep, ignorees: readonly string[], viewer: Viewer) {
  await projeterStatut(entityType, entityId, statutLegacyALEtape(orderedSteps(def), etape, ignorees, "AWAITING_PRELIMINARY"), viewer);
}

// ───────────────────────────── Divers ─────────────────────────────

/**
 * Notifie le **responsable hiérarchique du demandeur** quand l'étape où l'on arrive lui est
 * confiée (portées `DEPARTMENT_MANAGER` / `DEPARTMENT_HEAD`). Sans cela, une étape « N+1 »
 * n'aurait aucun destinataire : personne ne saurait qu'il y a quelque chose à valider.
 * Best-effort : ne fait jamais échouer la progression.
 */
/**
 * PRÉVENIR L'ÉTAPE QUI VIENT D'ÊTRE ATTEINTE — le rôle, ET les référents de la gamme.
 *
 * ── POURQUOI UN SEUL POINT ──────────────────────────────────────────────────────────────
 *
 * Une étape est « atteinte » à TROIS endroits de ce moteur : après une approbation, après un
 * saut, et après un avis défavorable qui renvoie plus loin. Les trois appelaient `notifyRoles`
 * pour leur compte. Ajouter les référents à deux sur trois aurait laissé une porte muette à côté
 * de deux portes qui parlent (§118.71) — et c'est le chemin le plus rare, celui de l'avis
 * défavorable, qui serait resté silencieux. Un cliquet interdit désormais un `notifyRoles` nu
 * dans ce fichier.
 *
 * ── CE QUE LES RÉFÉRENTS AJOUTENT, ET CE QU'ILS NE RETIRENT PAS ─────────────────────────
 *
 * Les rôles de l'étape sont TOUJOURS prévenus : c'est ainsi que « le directeur du département
 * marketing recevra ÉGALEMENT l'accès et la notif » est tenu sans avoir à deviner qui est le
 * directeur. Les référents de la gamme s'y AJOUTENT, nommément. Une gamme sans référent retombe
 * donc exactement sur le comportement d'avant (§118.16).
 *
 * Un échec de notification ne casse JAMAIS le franchissement : l'étape a été décidée, et la
 * refuser parce qu'un envoi a raté ferait perdre la décision (§118.137).
 */
async function prevenirEtapeAtteinte(
  entityType: EntityType,
  entityId: string,
  etape: LoadedStep,
  msg: { title: string; body: string; link: string },
  requesterId: string | null,
  // « À vous d'agir » par défaut ; « pour information » quand le circuit s'ouvre et annonce la
  // demande aux acteurs des étapes suivantes (décision #1, 27/10/2026) — mêmes destinataires.
  type: "VALIDATION_REQUIRED" | "GENERIC" = "VALIDATION_REQUIRED",
): Promise<void> {
  const roles = (etape.notifyRoles as UserRole[]).filter(Boolean);
  if (roles.length) await notifyRoles(roles, { type, ...msg });
  // LES RÉFÉRENTS DE LA GAMME s'AJOUTENT au rôle — et seulement là où l'étape NOMME ce rôle.
  // La décision est pure (`laGammeEstConcernee`) : l'écrire ici en lisant le slug ferait une
  // seconde vérité, fausse au premier circuit remanié (§118.5, §118.73).
  if (!laGammeEstConcernee(roles)) return;
  try {
    const referents = await referentsDeLaDemande(entityType, entityId);
    for (const userId of aPrevenirPourLaGamme({ referents, demandeurId: requesterId })) {
      await notifyUser({ userId, type, ...msg });
    }
  } catch (err) {
    console.error("[workflow] notification des référents Direction Marketing impossible", err);
  }
}

/**
 * LES RÉFÉRENTS DE LA GAMME QUE PORTE CETTE DEMANDE.
 *
 * La gamme vit sur la LIGNE de la demande (`businessUnitId`), pas sur l'instance de circuit : le
 * moteur est générique, et y recopier la gamme ferait une seconde vérité qui prendrait du retard
 * au premier rattachement corrigé (§118.5). On la lit donc là où elle est.
 *
 * Le rôle est relu EN MÊME TEMPS : une désignation ne garantit pas que la personne porte encore
 * le rôle, et prévenir quelqu'un qui ne peut plus trancher est une attente sans pouvoir.
 */
async function referentsDeLaDemande(entityType: EntityType, entityId: string): Promise<ReferentMarketing[]> {
  const ligne =
    entityType === "SPONSORING" ? await prisma.sponsoringRequest.findUnique({ where: { id: entityId }, select: { businessUnitId: true } })
      : entityType === "CONGRESS_INTERNATIONAL" ? await prisma.congressInternational.findUnique({ where: { id: entityId }, select: { businessUnitId: true } })
        : entityType === "CONGRESS_NATIONAL" ? await prisma.congressNational.findUnique({ where: { id: entityId }, select: { businessUnitId: true } })
          : entityType === "AD_PRO_OTHER" ? await prisma.adProOtherRequest.findUnique({ where: { id: entityId }, select: { businessUnitId: true } })
            : await prisma.event.findUnique({ where: { id: entityId }, select: { businessUnitId: true } });
  if (!ligne?.businessUnitId) return [];
  const lignes = await prisma.businessUnitMarketingReferent.findMany({
    where: { businessUnitId: ligne.businessUnitId, user: { isActive: true } },
    select: { userId: true, user: { select: { name: true, role: true, secondaryRole: true } } },
  });
  return lignes.map((r) => ({
    userId: r.userId,
    name: r.user.name,
    porteLeRole: porteLeRoleQuiTranche(r.user),
  }));
}

async function notifyStepManager(step: LoadedStep, requesterId: string | null, title: string, body: string, link: string): Promise<void> {
  const scope = step.actorScope as ActorScope;
  if (scope !== "DEPARTMENT_MANAGER" && scope !== "DEPARTMENT_HEAD") return;
  if (!requesterId) return;
  try {
    const mgr = await getManagerOfUser(requesterId);
    if (mgr?.userId) await notifyUser({ userId: mgr.userId, type: "VALIDATION_REQUIRED", title, body, link });
  } catch (err) {
    console.error("[workflow] notification N+1 impossible", err);
  }
}

async function recordEvent(instanceId: string, step: LoadedStep, action: string, viewer: Viewer, note: string | null, amount: number | null) {
  await prisma.workflowStepEvent.create({
    data: { instanceId, stepSlug: step.slug, stepTitle: step.title, action, actorId: viewer.id, actorName: viewer.name ?? null, note, amount: amount ?? null },
  });
}

function entityPath(entityType: EntityType, entityId: string): string {
  // La table des fiches Ad & Pro vit une fois (`chemins/ad-pro`) ; le circuit ne porte que ces cinq natures.
  return lienDemandeAdPro(entityType in CHEMIN_PARENT_AD_PRO ? (entityType as ParentAdPro) : "EVENT", entityId);
}

function auditModule(entityType: EntityType): string {
  return entityType === "SPONSORING" ? "Sponsoring"
    : entityType === "EVENT" ? "Events"
      : entityType === "AD_PRO_OTHER" ? "Ad & Pro — autres demandes"
        : "Congrès";
}

// ───────────────────────────── Révision : resoumettre, rouvrir, relancer, fermer ─────────────────────────────

type ResultatRevision = { ok: true; category: WorkflowCategory; etape: string } | { ok: false; error: string };

async function chargerDefinition(instance: LoadedInstance): Promise<LoadedDefinition | null> {
  return prisma.workflowDefinition.findUnique({ where: { id: instance.definitionId }, include: { steps: { orderBy: { position: "asc" } } } });
}

/** Les étapes que le MONTANT a franchies automatiquement — les seules qu'une correction peut rouvrir. */
async function franchiesParMontant(instanceId: string): Promise<Set<string>> {
  const lignes = await prisma.workflowStepEvent.findMany({ where: { instanceId, action: "AUTO_SKIP" }, select: { stepSlug: true } });
  return new Set(lignes.map((l) => l.stepSlug));
}

/**
 * PRÉVIENT L'ÉTAPE OÙ L'ON POSE UNE DEMANDE hors d'une approbation (resoumission, porte rouverte,
 * nouveau cycle) : la personne désignée, le N+1 si l'étape lui revient, le rôle et les référents.
 * Les trois chemins d'approbation le faisaient chacun ; les trois chemins de révision passent ici.
 */
async function prevenirLaPose(
  entityType: EntityType, entityId: string, instance: LoadedInstance, etape: LoadedStep,
  requesterId: string | null, titre: string, corps: string,
): Promise<void> {
  const link = entityPath(entityType, entityId);
  if (etape.actorScope === "ASSIGNEE" && instance.assigneeId) {
    await notifyUser({ userId: instance.assigneeId, type: "ASSIGNMENT", title: titre, body: corps, link });
  }
  await notifyStepManager(etape, requesterId, titre, corps, link);
  await prevenirEtapeAtteinte(entityType, entityId, etape, { title: titre, body: corps, link }, requesterId);
}

/**
 * RESOUMETTRE UNE DEMANDE RENVOYÉE POUR CORRECTION (audit 360°, R02 et R15 — §118.186).
 *
 * La demande revient à l'étape qui l'a renvoyée — la personne qui a demandé la correction juge la
 * correction — sauf si le montant corrigé ne franchit plus une porte qu'il avait franchie sous le
 * seuil : la porte se rouvre, et la demande reprend là (`etapeDeReprise`). Puis les
 * franchissements automatiques s'enchaînent depuis cette étape, exactement comme à la naissance :
 * un montant revu à la baisse ouvre seul la porte du DG que la version d'avant lui faisait garder.
 *
 * L'écriture est CONDITIONNELLE (`status: "RETURNED"`) : deux clics simultanés ne resoumettent
 * qu'une fois, et le second le dit.
 */
export async function resubmitWorkflowInstance(input: { viewer: Viewer; entityType: EntityType; entityId: string; note?: string | null }): Promise<ResultatRevision> {
  const { viewer, entityType, entityId } = input;
  const category = entityToCategory(entityType);
  if (!category) return { ok: false, error: "Catégorie de workflow inconnue." };
  const instance = await prisma.workflowInstance.findUnique({ where: { entityType_entityId: { entityType, entityId } } });
  if (!instance) return { ok: false, error: "Circuit introuvable." };
  if (instance.status !== "RETURNED") return { ok: false, error: "Cette demande n'est pas à corriger : il n'y a rien à resoumettre." };
  const summary = await loadEntity(entityType, entityId);
  if (!summary) return { ok: false, error: "Demande introuvable." };
  if (!peutResoumettre({ id: viewer.id, vueGlobale: hasGlobalView(viewer) || viewer.role === "SUPER_ADMIN" }, summary.requesterId)) {
    return { ok: false, error: "Seul le demandeur (ou la Direction) resoumet une demande renvoyée pour correction." };
  }
  const prise = new Date();
  const posee = await prisma.workflowInstance.updateMany(argsPrise(instance.id, { status: "RETURNED" }, prise));
  if (posee.count === 0) return { ok: false, error: "La demande a déjà été resoumise, ou quelqu'un agit dessus au même instant." };
  try {
    const def = await chargerDefinition(instance);
    if (!def) return { ok: false, error: "Définition de workflow introuvable." };
    const retour = stepBySlug(def, instance.currentSlug);
    if (!retour) return { ok: false, error: "L'étape qui a renvoyé la demande n'existe plus dans le circuit : la Direction doit la reprendre." };
    const borne = instance.finalSlug ?? null;
    const ignorees = instance.skippedSlugs ?? [];
    const note = input.note?.trim() || null;

    const montant = toNumber(instance.amount) || (summary.estimatedAmount ?? 0);
    const seuilDgGlobal = await getAppSettings().then((st) => st.adProDgThreshold).catch(sansBloquer("workflow-engine.resubmitWorkflowInstance.getAppSettings", null));
    const reprise = etapeDeReprise(orderedSteps(def), retour, await franchiesParMontant(instance.id), (e) => autoSkipEligible(e, montant, seuilDgGlobal), ignorees);

    const pris = await prisma.workflowInstance.updateMany({
      where: { id: instance.id, status: "RETURNED" },
      data: { status: "IN_PROGRESS", currentSlug: reprise.slug },
    });
    if (pris.count === 0) return { ok: false, error: "La demande a déjà été resoumise." };

    await projectPose(entityType, entityId, def, reprise, ignorees, viewer);
    const pose = (await settleAutoSkips(entityType, entityId, def, instance.id, montant, summary.requesterId, reprise, viewer, borne, ignorees)) ?? reprise;
    if (pose.slug !== reprise.slug) await prisma.workflowInstance.update({ where: { id: instance.id }, data: { currentSlug: pose.slug } });

    const porteRouverte = reprise.slug !== retour.slug;
    const trace = porteRouverte
      ? `${note ? `${note} — ` : ""}le montant (${montant} DZD) ne franchit plus « ${reprise.title} » : la demande y reprend.`
      : note;
    await recordEvent(instance.id, pose, "RESUBMIT", viewer, trace, null);

    const titre = `${CATEGORY_LABELS[category]} — ${pose.title} (corrigée et resoumise)`;
    const corps = note ? `${summary.name} — ${note}` : summary.name;
    await prevenirLaPose(entityType, entityId, instance, pose, summary.requesterId, titre, corps);
    // CELUI QUI A DEMANDÉ LA CORRECTION l'attend. Quand la demande revient à SON étape, la notification
    // de l'étape le prévient déjà (il en porte le rôle, puisqu'il y a agi) ; quand une porte rouverte la
    // fait reprendre AVANT son étape, personne d'autre ne le lui dirait.
    const renvoi = porteRouverte
      ? await prisma.workflowStepEvent.findFirst({ where: { instanceId: instance.id, action: "RETURN" }, orderBy: { createdAt: "desc" }, select: { actorId: true } })
      : null;
    if (renvoi?.actorId && renvoi.actorId !== viewer.id) {
      await notifyUser({ userId: renvoi.actorId, type: "VALIDATION_REQUIRED", title: titre, body: corps, link: entityPath(entityType, entityId) });
    }
    await recordAudit({
      actorId: viewer.id, action: "UPDATE", module: auditModule(entityType), entityType, entityId,
      summary: `Corrigée et resoumise — ${summary.name}${porteRouverte ? ` (porte « ${reprise.title} » rouverte)` : ""}`,
    });
    return { ok: true, category, etape: pose.title };
  } finally {
    await prisma.workflowInstance.updateMany(argsRendre(instance.id, prise)).catch(sansBloquer("workflow-engine.resubmitWorkflowInstance.workflowInstance"));
  }
}

/**
 * APRÈS UNE MODIFICATION DE LA DEMANDE EN COURS DE CIRCUIT (audit 360°, R15 — §118.186).
 *
 * Une correction faite après un premier avis ne rouvrait rien et ne prévenait personne : la
 * personne qui avait approuvé 200 000 DZD n'apprenait jamais qu'on en demandait 400 000, et une
 * porte du DG franchie sous le seuil restait franchie pour une demande qui l'avait dépassé.
 *   • une porte franchie PAR LE MONTANT et que le montant ne franchit plus se ROUVRE — la demande
 *     y retourne (même règle que la resoumission, `etapeDeReprise`) ;
 *   • si quelqu'un a DÉJÀ donné un avis, l'étape courante et les auteurs d'avis sont prévenus de ce
 *     qui a changé. Avant tout avis, on ne prévient personne : nul n'a encore rien regardé, et une
 *     notification par faute de frappe corrigée serait du bruit qu'on cesse de lire (§118.32).
 * Une demande À CORRIGER n'est pas concernée : la resoumission fera les deux.
 */
export async function apresModificationDeLaDemande(input: { viewer: Viewer; entityType: EntityType; entityId: string; changes: readonly string[] }): Promise<{ porteRouverte: string | null }> {
  const { viewer, entityType, entityId } = input;
  const category = entityToCategory(entityType);
  if (!category) return { porteRouverte: null };
  const lu = await prisma.workflowInstance.findUnique({ where: { entityType_entityId: { entityType, entityId } }, select: { id: true, status: true } });
  if (!lu || lu.status !== "IN_PROGRESS") return { porteRouverte: null };
  // Un geste en cours — une approbation qui part — se termine d'abord : la porte se juge sur
  // l'étape où il aura laissé la demande, pas sur celle qu'on a lue avant lui. La modification est
  // déjà enregistrée ; c'est sa SUITE qui attend son tour, quelques secondes au plus.
  const prise = await prendreLeCircuitEnAttendant(lu.id, { status: "IN_PROGRESS" }, 5_000);
  if (!prise) return { porteRouverte: null };
  try {
    // RELUE sous la prise : le geste qu'on a attendu a pu déplacer l'étape.
    const instance = await prisma.workflowInstance.findUnique({ where: { id: lu.id } });
    if (!instance || instance.status !== "IN_PROGRESS") return { porteRouverte: null };
    const def = await chargerDefinition(instance);
    const courante = def ? stepBySlug(def, instance.currentSlug) : null;
    const summary = await loadEntity(entityType, entityId);
    if (!def || !courante || !summary) return { porteRouverte: null };
    const ignorees = instance.skippedSlugs ?? [];
    const link = entityPath(entityType, entityId);

    const montant = toNumber(instance.amount) || (summary.estimatedAmount ?? 0);
    const seuilDgGlobal = await getAppSettings().then((st) => st.adProDgThreshold).catch(sansBloquer("workflow-engine.apresModificationDeLaDemande.getAppSettings", null));
    const reprise = etapeDeReprise(orderedSteps(def), courante, await franchiesParMontant(instance.id), (e) => autoSkipEligible(e, montant, seuilDgGlobal), ignorees);

    let porteRouverte: string | null = null;
    let etapeAPrevenir = courante;
    if (reprise.slug !== courante.slug) {
      const pris = await prisma.workflowInstance.updateMany({
        where: { id: instance.id, status: "IN_PROGRESS", currentSlug: courante.slug },
        data: { currentSlug: reprise.slug },
      });
      if (pris.count > 0) {
        porteRouverte = reprise.title;
        etapeAPrevenir = reprise;
        await projectPose(entityType, entityId, def, reprise, ignorees, viewer);
        await recordEvent(instance.id, reprise, "REOPEN", viewer, `Montant porté à ${montant} DZD : « ${reprise.title} » n'est plus franchie sous le seuil — la demande y revient.`, null);
        await prevenirLaPose(entityType, entityId, instance, reprise, summary.requesterId, `${CATEGORY_LABELS[category]} — ${reprise.title} (montant relevé)`, summary.name);
      }
    }

    const historique = await prisma.workflowStepEvent.findMany({ where: { instanceId: instance.id }, select: { action: true, actorId: true }, orderBy: { createdAt: "asc" } });
    const auteurs = auteursDAvis(historique, [viewer.id, summary.requesterId]);
    if (auteurs.length > 0 && input.changes.length > 0) {
      const corps = `${summary.name} — ${input.changes.join(" · ")}`;
      for (const userId of auteurs) {
        await notifyUser({ userId, type: "VALIDATION_REQUIRED", title: `${CATEGORY_LABELS[category]} — demande modifiée après votre avis`, body: corps, link });
      }
      // L'étape courante, si la porte rouverte ne l'a pas déjà prévenue : elle décidera sur la version
      // modifiée, et doit savoir ce qui a changé depuis les avis qu'elle lit.
      if (!porteRouverte) {
        await prevenirEtapeAtteinte(entityType, entityId, etapeAPrevenir, { title: `${CATEGORY_LABELS[category]} — ${etapeAPrevenir.title} (demande modifiée)`, body: corps, link }, summary.requesterId);
      }
    }
    return { porteRouverte };
  } finally {
    await prisma.workflowInstance.updateMany(argsRendre(lu.id, prise)).catch(sansBloquer("workflow-engine.apresModificationDeLaDemande.workflowInstance"));
  }
}

/**
 * FERMER LE CIRCUIT D'UNE DEMANDE RETIRÉE, ANNULÉE OU TRANSFÉRÉE.
 *
 * L'annulation et le transfert écrivaient le statut de l'ENTITÉ et laissaient l'instance « en
 * cours » : le panneau proposait encore « Approuver » sur une demande annulée, et l'approuver
 * aurait émis l'argent d'une demande que son auteur avait retirée. Une demande close ferme son
 * circuit, en une écriture conditionnelle (rien à fermer = rien d'écrit), avec sa raison au journal.
 */
export async function fermerInstance(input: { viewer: Viewer; entityType: EntityType; entityId: string; motif: string }): Promise<boolean> {
  const instance = await prisma.workflowInstance.findUnique({ where: { entityType_entityId: { entityType: input.entityType, entityId: input.entityId } } });
  if (!instance) return false;
  // Toujours la SUITE d'une décision déjà écrite (un transfert a déplacé les pièces) : on attend
  // qu'un geste en cours se termine plutôt que de laisser le circuit de la source ouvert.
  const prise = await prendreLeCircuitEnAttendant(instance.id, { status: { in: ["IN_PROGRESS", "RETURNED"] } }, 5_000);
  if (!prise) return false;
  try {
    const def = await chargerDefinition(instance);
    const etape = def ? stepBySlug(def, instance.currentSlug) : null;
    const pris = await prisma.workflowInstance.updateMany(clotureDuCircuit(instance.id));
    if (pris.count === 0) return false;
    await prisma.workflowStepEvent.create(evenementDeCloture(instance.id, etape, input.viewer, input.motif));
    return true;
  } finally {
    await prisma.workflowInstance.updateMany(argsRendre(instance.id, prise)).catch(sansBloquer("workflow-engine.fermerInstance.workflowInstance"));
  }
}

/**
 * LA CLÔTURE D'UN CIRCUIT — ses ARGUMENTS, partagés par ses deux écrivains (`fermerInstance`,
 * `retirerDemande`), qui gardent chacun l'APPEL Prisma dans leur propre corps.
 *
 * Pourquoi pas une seule fonction qui écrit : la dérivation des contrats d'action ne suit qu'UN
 * niveau de délégation (`faitsEcritureImportes`). Quand `retirerDemande` déléguait sa clôture à
 * `fermerInstance`, les deux actions qui l'appellent — annuler un congrès, retirer une demande —
 * se décrivaient « n'écrit rien », et la carte de confirmation aurait annoncé une lecture. C'est
 * le partage de §118.137 : la partie qu'on ne veut pas voir diverger (la condition, l'état écrit,
 * la ligne d'historique) vit une fois ; l'écriture reste visible là où elle a lieu.
 */
function clotureDuCircuit(instanceId: string) {
  return {
    where: { id: instanceId, status: { in: ["IN_PROGRESS", "RETURNED"] } },
    data: { status: "CANCELLED", currentSlug: null },
  } satisfies Prisma.WorkflowInstanceUpdateManyArgs;
}

function evenementDeCloture(instanceId: string, etape: LoadedStep | null, viewer: Viewer, motif: string) {
  return {
    data: {
      instanceId, stepSlug: etape?.slug ?? "__cancel__", stepTitle: etape?.title ?? "Demande close",
      action: "CANCEL", actorId: viewer.id, actorName: viewer.name ?? null, note: motif,
    },
  } satisfies Prisma.WorkflowStepEventCreateArgs;
}

/**
 * RETIRER UNE DEMANDE QUI N'EST PAS ENCORE TRANCHÉE (audit 360°, R24 — §118.186).
 *
 * Le demandeur ne pouvait pas retirer sa propre demande : l'action existait pour les congrès, sans
 * écran, et n'existait pas pour le sponsoring ni l'événement. Retirer est un geste qui RÉDUIT
 * (§118.15) : il ne touche à rien de ce qui a quitté l'ERP, et c'est la condition qu'on vérifie —
 * un poste qui engage déjà la dépense (bon de commande demandé, ordre émis) l'interdit, avec le
 * geste qui débloque. Le motif est obligatoire (règle commune des gestes définitifs, R17) ; la
 * permission est vérifiée par l'APPELANT, qui seul connaît la session.
 *
 * RETIRER, C'EST SUPPRIMER (Direction, 05/10) : « quand je retire une demande Ad&Pro, elle doit être
 * TOTALEMENT supprimée — évidemment toujours récupérable depuis la corbeille par le Super Admin ».
 * Le moteur ne fait plus que JUGER si la demande se retire (état du circuit, postes engagés) et tient
 * la prise du circuit pendant que l'APPELANT supprime : la suppression est le cœur réversible de la
 * corbeille (`supprimerReversible`, un lot, une transaction), qui emporte avec la demande son circuit,
 * ses validations, ses ordres non réglés, ses postes et ses pièces — et refuse ce qui a quitté l'ERP.
 * Fermer le circuit AVANT de supprimer aurait laissé, sur un refus du lot, une demande « annulée »
 * qu'on n'a pas supprimée : l'ordre inverse (juger, supprimer, rien d'autre) ne laisse jamais un
 * état à moitié. Le cœur de la suppression n'est pas importé ici — le domaine du circuit ne lit pas
 * celui de la corbeille —, il arrive en argument, et il est appelé APRÈS tous les refus.
 */
export async function retirerDemande(input: {
  viewer: Viewer; entityType: EntityType; entityId: string; motif: string;
  supprimer: (nom: string) => Promise<{ ok: boolean; error?: string; redirect?: string }>;
}): Promise<ResultatRevision & { redirect?: string }> {
  const { viewer, entityType, entityId } = input;
  const category = entityToCategory(entityType);
  if (!category) return { ok: false, error: "Catégorie de workflow inconnue." };
  const motif = input.motif.trim();
  if (!motif) return { ok: false, error: "Dites pourquoi vous retirez la demande : le motif reste au journal." };
  const instance = await ensureInstance(entityType, entityId);
  if (!instance) return { ok: false, error: "Circuit introuvable." };
  if (instance.status !== "IN_PROGRESS" && instance.status !== "RETURNED") {
    return { ok: false, error: "La demande est déjà tranchée ou close : elle ne se retire plus." };
  }
  const prise = new Date();
  const posee = await prisma.workflowInstance.updateMany(argsPrise(instance.id, { status: { in: ["IN_PROGRESS", "RETURNED"] } }, prise));
  if (posee.count === 0) return { ok: false, error: CIRCUIT_PRIS };
  try {
    const colonne = PARENT_COLONNE[entityType as AdProParent];
    if (colonne) {
      const engages = await prisma.adProItem.count({
        where: { [colonne]: entityId, OR: [{ expenseOrderId: { not: null } }, { orderStage: { in: ["REQUESTED", "DIRECTION_OK", "ISSUED"] } }] },
      });
      if (engages > 0) {
        return { ok: false, error: `${engages} poste(s) de cette demande engagent déjà la dépense (bon de commande demandé ou ordre émis) : retirez ou annulez d'abord ces postes.` };
      }
    }
    const summary = await loadEntity(entityType, entityId);
    if (!summary) return { ok: false, error: "Demande introuvable." };
    // LA SUPPRESSION, sous la prise : plus personne ne décide, approuve ou renvoie cette demande pendant
    // qu'elle part. Un refus du lot (de l'argent est parti, une pièce est signée) rend la demande telle
    // qu'elle était — la prise est rendue plus bas, rien n'a été écrit.
    const supprime = await input.supprimer(summary.name);
    if (!supprime.ok) return { ok: false, error: supprime.error ?? "La demande n'a pas pu être supprimée." };
    return { ok: true, category, etape: "", redirect: supprime.redirect };
  } finally {
    await prisma.workflowInstance.updateMany(argsRendre(instance.id, prise)).catch(sansBloquer("workflow-engine.retirerDemande.workflowInstance"));
  }
}

/**
 * UN NOUVEAU CYCLE POUR UNE DEMANDE REFUSÉE OU ANNULÉE (audit 360°, R01 — §118.186).
 *
 * Un événement refusé ne pouvait JAMAIS être resoumis : l'instance de circuit est unique par
 * demande, et elle restait close. On la ROUVRE plutôt que d'en créer une seconde — l'historique du
 * premier cycle reste lisible, motif du refus compris — sur l'étape d'entrée que le statut
 * fraîchement écrit désigne (`positionFromLegacy`, la même lecture qu'à la naissance), puis les
 * franchissements automatiques s'enchaînent comme à la naissance.
 */
export async function relancerCycle(input: {
  viewer: Viewer; entityType: EntityType; entityId: string; note: string;
  /** L'écriture de la demande relancée, faite SOUS la prise — avant que le circuit relise son statut d'entrée. */
  preparer?: () => Promise<void>;
}): Promise<ResultatRevision> {
  const { viewer, entityType, entityId } = input;
  const category = entityToCategory(entityType);
  if (!category) return { ok: false, error: "Catégorie de workflow inconnue." };
  const instance = await prisma.workflowInstance.findUnique({ where: { entityType_entityId: { entityType, entityId } } });
  if (!instance) {
    // Jamais ouverte : la première lecture la créera à la bonne étape, d'après la demande écrite.
    if (input.preparer) await input.preparer();
    const neuve = await ensureInstance(entityType, entityId);
    return neuve ? { ok: true, category, etape: neuve.currentSlug ?? "" } : { ok: false, error: "Impossible d'ouvrir le circuit." };
  }
  if (instance.status !== "REJECTED" && instance.status !== "CANCELLED") return { ok: false, error: "Cette demande n'est ni refusée ni annulée : son circuit est toujours ouvert." };
  const prise = new Date();
  const posee = await prisma.workflowInstance.updateMany(argsPrise(instance.id, { status: { in: ["REJECTED", "CANCELLED"] } }, prise));
  if (posee.count === 0) return { ok: false, error: "La demande vient d'être relancée, ou quelqu'un agit dessus au même instant." };
  try {
    // La demande s'écrit d'abord, sous la prise : l'étape d'entrée se lit sur son statut FRAIS.
    if (input.preparer) await input.preparer();
    const def = await chargerDefinition(instance);
    const summary = await loadEntity(entityType, entityId);
    if (!def || !summary) return { ok: false, error: "Demande introuvable." };
    const { currentSlug } = positionFromLegacy(orderedSteps(def), summary.legacyStatus);
    const depart = stepBySlug(def, premiereEtapeTraversee(def, currentSlug, instance.skippedSlugs ?? []));
    if (!depart) return { ok: false, error: "Le circuit n'a pas d'étape d'entrée pour cette demande." };
    const pris = await prisma.workflowInstance.updateMany({
      where: { id: instance.id, status: { in: ["REJECTED", "CANCELLED"] } },
      data: { status: "IN_PROGRESS", currentSlug: depart.slug, assigneeId: null, amount: null },
    });
    if (pris.count === 0) return { ok: false, error: "La demande vient d'être relancée." };
    const montant = summary.estimatedAmount ?? 0;
    const pose = montant > 0
      ? (await settleAutoSkips(entityType, entityId, def, instance.id, montant, summary.requesterId, depart, viewer, instance.finalSlug ?? null, instance.skippedSlugs ?? [])) ?? depart
      : depart;
    if (pose.slug !== depart.slug) await prisma.workflowInstance.update({ where: { id: instance.id }, data: { currentSlug: pose.slug } });
    await recordEvent(instance.id, pose, "RESUBMIT", viewer, `Nouveau cycle — ${input.note}`, null);
    await prevenirLaPose(entityType, entityId, instance, pose, summary.requesterId, `${CATEGORY_LABELS[category]} — ${pose.title} (nouvelle demande après refus)`, `${summary.name} — ${input.note}`);
    return { ok: true, category, etape: pose.title };
  } finally {
    await prisma.workflowInstance.updateMany(argsRendre(instance.id, prise)).catch(sansBloquer("workflow-engine.relancerCycle.workflowInstance"));
  }
}

/**
 * L'APPEL D'UNE DÉCISION ROUVRE LE CIRCUIT À L'ÉTAPE QUI A TRANCHÉ (audit 360°, R04 — §118.186).
 *
 * Il rouvrait sur la première étape à portée « personne désignée », sinon la DEUXIÈME étape — la
 * porte du DG depuis l'inversion du circuit : sans franchissement ni notification, le dossier
 * attendait un Directeur Général qui n'avait rien à juger, pendant que l'écran promettait « un
 * nouvel examen de la Direction Marketing ». L'appel conteste une DÉCISION ; il revient à qui l'a
 * rendue — la borne du parcours, sinon la dernière étape de sa route —, qui est prévenu.
 *
 * Rend le titre de cette étape, pour que l'écran et la notification disent la vérité.
 */
export async function reopenInstance(entityType: EntityType, entityId: string, viewer?: Viewer, motif?: string | null): Promise<{ etape: string | null; rolesPrevenus: string[] }> {
  const instance = await prisma.workflowInstance.findUnique({ where: { entityType_entityId: { entityType, entityId } } });
  if (!instance) return { etape: null, rolesPrevenus: [] };
  const def = await chargerDefinition(instance);
  if (!def) return { etape: null, rolesPrevenus: [] };
  const etapes = orderedSteps(def);
  const ignorees = instance.skippedSlugs ?? [];
  const decision = (instance.finalSlug ? stepBySlug(def, instance.finalSlug) : null)
    ?? [...etapes].reverse().find((s) => !estIgnoree(s.slug, ignorees))
    ?? etapes[etapes.length - 1];
  if (!decision) return { etape: null, rolesPrevenus: [] };
  // Seule une décision RENDUE se conteste : deux appels simultanés n'en rouvrent qu'un.
  const prise = new Date();
  const posee = await prisma.workflowInstance.updateMany(argsPrise(instance.id, { status: { in: ["APPROVED", "REJECTED"] } }, prise));
  if (posee.count === 0) return { etape: null, rolesPrevenus: [] };
  try {
    await prisma.workflowInstance.update({ where: { id: instance.id }, data: { currentSlug: decision.slug, status: "IN_PROGRESS" } });
    if (viewer) {
      await recordEvent(instance.id, decision, "APPEAL", viewer, motif?.trim() || null, null);
      const summary = await loadEntity(entityType, entityId);
      const category = entityToCategory(entityType);
      if (summary && category) {
        await prevenirLaPose(entityType, entityId, instance, decision, summary.requesterId, `${CATEGORY_LABELS[category]} — appel à réexaminer (${decision.title})`, motif?.trim() ? `${summary.name} — ${motif.trim()}` : summary.name);
      }
    }
    // Les rôles que l'étape qui tranche vient de prévenir : l'appelant qui INFORME d'autres rôles
    // (la Direction, pour un appel) ne les prévient pas une seconde fois.
    return { etape: decision.title, rolesPrevenus: viewer ? [...(decision.notifyRoles ?? [])] : [] };
  } finally {
    await prisma.workflowInstance.updateMany(argsRendre(instance.id, prise)).catch(sansBloquer("workflow-engine.reopenInstance.workflowInstance"));
  }
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * OUVRIR LE CIRCUIT À LA CRÉATION — et prévenir CHAQUE acteur (décision #1, Direction 27/10/2026).
 *
 * « À la création, ça doit notifier tous les acteurs concernés, puis chaque personne à son tour. »
 * L'instance naissait paresseusement, à la première ouverture de la fiche : personne n'était prévenu
 * par le circuit, et les actions de création prévenaient des rôles écrits à la main (la Direction pour
 * une demande que le Directeur des opérations devait voir). Désormais :
 *   • l'instance naît avec la demande (son parcours est figé à cet instant, comme avant) ;
 *   • l'acteur de l'étape où elle se pose reçoit « à vous d'agir » ;
 *   • les acteurs des étapes SUIVANTES de SON parcours sont prévenus pour information ;
 *   • chacun recevra ensuite « à vous d'agir » quand son tour viendra (`prevenirEtapeAtteinte`).
 * Une demande prévalidée d'office n'a plus personne à attendre : son créateur a déjà été notifié par
 * le geste qui l'a prévalidée. Ne lève jamais : la demande est créée, quoi qu'il arrive ici.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export async function ouvrirLeCircuit(entityType: EntityType, entityId: string): Promise<void> {
  try {
    const category = entityToCategory(entityType);
    if (!category) return;
    const avant = await prisma.workflowInstance.findUnique({ where: { entityType_entityId: { entityType, entityId } }, select: { id: true } });
    const inst = await ensureInstance(entityType, entityId);
    if (!inst || avant || inst.status !== "IN_PROGRESS") return;
    const [def, summary] = await Promise.all([chargerDefinition(inst), loadEntity(entityType, entityId)]);
    if (!def || !summary) return;
    const courante = stepBySlug(def, inst.currentSlug);
    if (!courante) return;
    const link = entityPath(entityType, entityId);
    await prevenirLaPose(entityType, entityId, inst, courante, summary.requesterId, `${CATEGORY_LABELS[category]} — ${courante.title} : à vous d'agir`, summary.name);
    // LES ÉTAPES SUIVANTES DE CE PARCOURS (le tamis gelé exclu), pour information — par le même
    // point unique, pour que les référents de la gamme l'apprennent aussi quand le marketing est sur la route.
    const ignorees = inst.skippedSlugs ?? [];
    const route = orderedSteps(def).filter((s) => !ignorees.includes(s.slug));
    const ici = route.findIndex((s) => s.slug === courante.slug);
    const dejaPrevenus = new Set<string>(courante.notifyRoles);
    const roles = new Set<UserRole>();
    for (const s of route.slice(ici + 1)) {
      for (const r of s.notifyRoles) if (!dejaPrevenus.has(r) && r !== "SUPER_ADMIN") roles.add(r as UserRole);
    }
    const suivante = route[ici + 1];
    if (roles.size && suivante) {
      await prevenirEtapeAtteinte(entityType, entityId, { ...suivante, notifyRoles: [...roles] }, {
        title: `${CATEGORY_LABELS[category]} — nouvelle demande (pour information)`,
        body: `${summary.name} — elle vous parviendra après « ${courante.title} ».`,
        link,
      }, summary.requesterId, "GENERIC");
    }
  } catch (e) {
    console.error("[workflow] ouverture du circuit à la création (non bloquant)", entityType, entityId, e);
  }
}
