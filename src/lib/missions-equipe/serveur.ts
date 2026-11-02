import type { EntityType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { notifyUser } from "@/lib/notify";
import { recordAudit } from "@/lib/audit";
import { anyRoleFilter } from "@/lib/rbac";
import { createDossierRecord, ecrireDansLeSujet } from "@/lib/dossiers-core";
import { CHEMIN_PARENT_AD_PRO, lienDemandeAdPro, type ParentAdPro } from "@/lib/chemins/ad-pro";
import { CHEMIN_MES_MISSIONS, lienMission } from "@/lib/chemins/espace";
import { ficheStockee, lignesReservation, reservationsAdventum } from "@/lib/missions-equipe/participation";
import { sansBloquer } from "@/lib/journal";

/**
 * MISSIONS AD & PRO — l'orchestration côté SERVEUR (base, notifications). Les règles vivent dans
 * `missions-equipe/etat.ts` et `missions-equipe/participation.ts` (purs) ; ce module n'est jamais importé par
 * un composant client.
 */

export const MES_MISSIONS = CHEMIN_MES_MISSIONS;

/** Les demandes Ad & Pro qui portent une équipe Adventum. */
export const PARENT_TYPES: EntityType[] = ["CONGRESS_INTERNATIONAL", "CONGRESS_NATIONAL", "EVENT", "SPONSORING"];

/** Chemin de la fiche de la demande parente. */
export function parentPath(entityType: EntityType, entityId: string): string {
  return entityType in CHEMIN_PARENT_AD_PRO ? lienDemandeAdPro(entityType as ParentAdPro, entityId) : MES_MISSIONS;
}

/** Ce que la demande dit de la mission. */
export interface ParentMissionInfo {
  label: string; ville: string | null; debut: Date | null; fin: Date | null;
  /** Le demandeur de l'opération Ad & Pro — l'organisateur qui tranche la participation. */
  requesterId: string | null;
  /** Une prise en charge internationale : les dépenses (hors billet) se saisissent en USD. */
  international: boolean;
  /** Le taux USD → DZD figé sur la demande (nul hors international). */
  taux: number | null;
}

/** Ce que la demande dit de la mission — libellé, ville, dates (pour pré-remplir), demandeur, devise. */
export async function parentMission(entityType: EntityType, entityId: string): Promise<ParentMissionInfo> {
  const vide = { requesterId: null, international: false, taux: null };
  try {
    if (entityType === "EVENT") {
      const e = await prisma.event.findUnique({ where: { id: entityId }, select: { name: true, city: true, startDate: true, endDate: true, requesterId: true } });
      if (e) return { ...vide, label: e.name, ville: e.city, debut: e.startDate, fin: e.endDate ?? e.startDate, requesterId: e.requesterId };
    } else if (entityType === "SPONSORING") {
      const r = await prisma.sponsoringRequest.findUnique({ where: { id: entityId }, select: { institution: true, reference: true, city: true, requesterId: true } });
      if (r) return { ...vide, label: `${r.reference} — ${r.institution}`, ville: r.city, debut: null, fin: null, requesterId: r.requesterId };
    } else if (entityType === "CONGRESS_INTERNATIONAL") {
      const c = await prisma.congressInternational.findUnique({ where: { id: entityId }, select: { name: true, city: true, startDate: true, endDate: true, requesterId: true, usdDzdRate: true } });
      if (c) {
        return {
          label: c.name, ville: c.city, debut: c.startDate, fin: c.endDate ?? c.startDate, requesterId: c.requesterId,
          international: true, taux: c.usdDzdRate != null ? Number(c.usdDzdRate) : null,
        };
      }
    } else if (entityType === "CONGRESS_NATIONAL") {
      const c = await prisma.congressNational.findUnique({ where: { id: entityId }, select: { name: true, city: true, date: true, endDate: true, requesterId: true } });
      if (c) return { ...vide, label: c.name, ville: c.city, debut: c.date, fin: c.endDate ?? c.date, requesterId: c.requesterId };
    }
  } catch { /* best-effort */ }
  return { ...vide, label: "mission", ville: null, debut: null, fin: null };
}

/** Les rôles d'une personne (principal et secondaire). */
export function rolesDe(u: { role: string; secondaryRole?: string | null }): string[] {
  return [u.role, u.secondaryRole].filter((r): r is string => Boolean(r));
}

/** Les organisateurs d'une participation : le demandeur de l'opération et celui qui a invité. */
export function organisateursDe(a: { createdById: string | null }, parent: { requesterId: string | null }): string[] {
  return [parent.requesterId, a.createdById].filter((x): x is string => Boolean(x));
}

/**
 * CE QU'ADVENTUM RÉSERVE PART CHEZ L'ASSISTANTE DE DIRECTION — comme les fiches voyageur : un sujet par demande
 * pour toute l'équipe (celui déjà ouvert pour un autre membre, sinon un nouveau). Appelé à l'émission de l'ordre
 * de mission, une seule fois par membre (`reservationDemandeeLe`). Ne fait jamais échouer l'appelant.
 */
export async function envoyerReservationEquipe(assignmentId: string, actorId: string): Promise<void> {
  try {
    const a = await prisma.missionAssignment.findUnique({
      where: { id: assignmentId },
      select: {
        id: true, entityType: true, entityId: true, accordVersionId: true, reservationDemandeeLe: true, createdById: true,
        user: { select: { name: true } },
      },
    });
    if (!a || !a.accordVersionId || a.reservationDemandeeLe) return;
    const v = await prisma.missionParticipationVersion.findUnique({ where: { id: a.accordVersionId }, select: { contenu: true } });
    const fiche = ficheStockee(v?.contenu ?? null);
    if (!fiche) return;
    const r = reservationsAdventum(fiche);
    if (!r.billet && !r.hotel) return;
    const parent = await parentMission(a.entityType, a.entityId);
    const corps = [
      `Équipe Adventum — ${parent.label} : réservation à faire (ordre de mission émis).`,
      ...lignesReservation(a.user.name, fiche),
      `Billet émis et confirmation d'hôtel à déposer sur la mission : ${lienMission(a.id, "reservation")}`,
    ].join("\n");

    const frere = await prisma.missionAssignment.findFirst({
      where: { entityType: a.entityType, entityId: a.entityId, reservationDossierId: { not: null } },
      select: { reservationDossierId: true },
    });
    let dossierId: string | null = null;
    if (frere?.reservationDossierId && (await ecrireDansLeSujet({ dossierId: frere.reservationDossierId, authorId: actorId, body: corps }))) {
      dossierId = frere.reservationDossierId;
    } else {
      const assistantes = await prisma.user.findMany({ where: { isActive: true, ...anyRoleFilter(["DIRECTION_ASSISTANT"]) }, select: { id: true }, orderBy: { createdAt: "asc" } });
      if (assistantes.length === 0) {
        console.warn("[missions] aucune assistante de direction active : réservation de l'équipe non envoyée");
        return;
      }
      const seule = assistantes.length === 1 ? assistantes[0]!.id : null;
      const sujet = await createDossierRecord({
        title: `Équipe Adventum — ${parent.label}`,
        description: corps,
        category: "Billets",
        priority: "HIGH",
        assignedToId: seule,
        participantIds: [...(seule ? [] : assistantes.map((x) => x.id)), ...organisateursDe(a, parent)],
        sourceType: a.entityType,
        sourceId: a.entityId,
      }, actorId);
      dossierId = sujet.id;
    }
    await prisma.missionAssignment.update({ where: { id: a.id }, data: { reservationDossierId: dossierId, reservationDemandeeLe: new Date() } });
    await recordAudit({ actorId, action: "UPDATE", module: "Congrès", entityType: "MISSION_ASSIGNMENT", entityId: a.id, summary: `Réservation envoyée à l'assistante de direction — ${a.user.name}` });
  } catch (err) {
    console.error("[missions] envoi de la réservation de l'équipe impossible", err);
  }
}

/**
 * L'ORDRE EST PRÊT → LA MISSION LE SAIT. Appelé quand les RH produisent (ou joignent) l'ordre de
 * mission d'une demande reliée à une assignation : `orderStatus` passe ISSUED, la personne est
 * prévenue (sa mission s'ouvre dans Mon espace), et ce qu'Adventum réserve part chez l'assistante de
 * direction. Idempotent ; ne fait jamais échouer le traitement RH.
 */
export async function synchroniserOrdreEmis(requestId: string, actorId: string): Promise<void> {
  try {
    const req = await prisma.hrDocumentRequest.findUnique({
      where: { id: requestId },
      select: { type: true, status: true, missionAssignmentId: true },
    });
    if (!req || req.type !== "MISSION_ORDER" || !req.missionAssignmentId) return;
    if (!["READY", "DELIVERED", "APPROVED"].includes(req.status)) return;
    const maj = await prisma.missionAssignment.updateMany({
      where: { id: req.missionAssignmentId, NOT: { orderStatus: "ISSUED" } },
      data: { orderStatus: "ISSUED", issuedAt: new Date(), issuedById: actorId },
    });
    if (maj.count === 0) return;
    const a = await prisma.missionAssignment.findUnique({ where: { id: req.missionAssignmentId }, select: { entityType: true, entityId: true, createdById: true, userId: true } });
    if (!a) return;
    const p = await parentMission(a.entityType, a.entityId);
    await notifyUser({ userId: a.userId, type: "ASSIGNMENT", title: "Ordre de mission émis — votre mission est ouverte", body: p.label, link: lienMission(req.missionAssignmentId) }).catch(sansBloquer("missions-equipe-serveur.synchroniserOrdreEmis.notifyUser"));
    if (a.createdById && a.createdById !== a.userId) {
      await notifyUser({ userId: a.createdById, type: "GENERIC", title: "Ordre de mission émis", body: p.label, link: lienMission(req.missionAssignmentId) }).catch(sansBloquer("missions-equipe-serveur.synchroniserOrdreEmis.notifyUser"));
    }
    await recordAudit({ actorId, action: "UPDATE", module: "Congrès", entityType: "MISSION_ASSIGNMENT", entityId: req.missionAssignmentId, summary: `Ordre de mission émis par les RH — ${p.label}` });
    await envoyerReservationEquipe(req.missionAssignmentId, actorId);
  } catch (err) {
    console.error("[missions] synchronisation de l'ordre impossible", err);
  }
}
