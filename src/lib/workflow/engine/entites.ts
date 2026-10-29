/**
 * Moteur de workflow — L'ENTITÉ SOURCE : champs legacy, lecture et mise à jour de la demande,
 * position déduite du statut legacy, chemin, module d'audit et journal d'événements du circuit.
 */
import type { EntityType, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { toNumber } from "@/lib/utils";
import { CHEMIN_PARENT_AD_PRO, lienDemandeAdPro, type ParentAdPro } from "@/lib/chemins/ad-pro";
import { ecritureAutreDepuisCircuit } from "../autre-statut";
import { type LoadedDefinition, type LoadedStep, orderedSteps, type Viewer } from "./definitions";

// ───────────────────────────── Statut « legacy » de l'entité ─────────────────────────────

export const LEGACY_FIELD: Record<string, "status" | "requestStatus"> = {
  SPONSORING: "status",
  CONGRESS_INTERNATIONAL: "requestStatus",
  CONGRESS_NATIONAL: "requestStatus",
  EVENT: "requestStatus",
  AD_PRO_OTHER: "status",
};

export function updateEntity(entityType: EntityType, entityId: string, data: Record<string, unknown>) {
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

export interface EntitySummary {
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

export async function loadEntity(entityType: EntityType, entityId: string): Promise<EntitySummary | null> {
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
export function positionFromLegacy(steps: LoadedStep[], legacy: string | null): { currentSlug: string | null; status: string } {
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
export function premiereEtapeTraversee(def: LoadedDefinition, slug: string | null, ignorees: readonly string[]): string | null {
  if (!slug || !ignorees.includes(slug)) return slug;
  const ordonnees = orderedSteps(def);
  const depuis = ordonnees.findIndex((st) => st.slug === slug);
  return ordonnees.slice(depuis + 1).find((st) => !ignorees.includes(st.slug))?.slug ?? slug;
}

export async function recordEvent(instanceId: string, step: LoadedStep, action: string, viewer: Viewer, note: string | null, amount: number | null) {
  await prisma.workflowStepEvent.create({
    data: { instanceId, stepSlug: step.slug, stepTitle: step.title, action, actorId: viewer.id, actorName: viewer.name ?? null, note, amount: amount ?? null },
  });
}

export function entityPath(entityType: EntityType, entityId: string): string {
  // La table des fiches Ad & Pro vit une fois (`chemins/ad-pro`) ; le circuit ne porte que ces cinq natures.
  return lienDemandeAdPro(entityType in CHEMIN_PARENT_AD_PRO ? (entityType as ParentAdPro) : "EVENT", entityId);
}

export function auditModule(entityType: EntityType): string {
  return entityType === "SPONSORING" ? "Sponsoring"
    : entityType === "EVENT" ? "Events"
      : entityType === "AD_PRO_OTHER" ? "Ad & Pro — autres demandes"
        : "Congrès";
}
