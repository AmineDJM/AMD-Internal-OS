/**
 * MISSIONS AD & PRO — la PARTICIPATION d'un membre de l'équipe : versions de sa fiche, contexte de l'acteur (son
 * côté, l'arbitre), prévenir l'autre côté, et les portes des dépôts (billet, hôtel) et des frais.
 *
 * Sorti de `actions/mission-actions.ts` (lot V4) : lectures et notifications, aucune écriture en base directe.
 */
import { prisma } from "@/lib/prisma";
import { notifyUser } from "@/lib/notify";
import { persistUploadedDocument } from "@/lib/documents";
import { lienMission } from "@/lib/chemins/espace";
import { sansBloquer } from "@/lib/journal";
import { parentMission, rolesDe, organisateursDe } from "@/lib/missions-equipe/serveur";
import { etatOrdreMission, type HrStatut, type GateN1 } from "@/lib/missions-equipe/etat";
import {
  etapeParticipation, estArbitre, coteDe, peutDeposerReservation, refusModifFrais, versionLite, type Cote,
} from "@/lib/missions-equipe/participation";
import { chargerAssignation, dernierOrdre } from "./assignation";

export type Assignation = NonNullable<Awaited<ReturnType<typeof chargerAssignation>>>;

/** Les versions de l'invitation EN COURS (une réinvitation repart à zéro), de la plus ancienne à la plus récente. */
export async function versionsCourantes(a: { id: string; createdAt: Date }) {
  return prisma.missionParticipationVersion.findMany({
    where: { assignmentId: a.id, createdAt: { gte: a.createdAt } },
    orderBy: { numero: "asc" },
  });
}

/** Le contexte d'une participation pour l'acteur : demande parente, organisateurs, son côté, l'état. */
export async function contexteParticipation(a: Assignation, user: { id: string; role: string; secondaryRole?: string | null }) {
  const parent = await parentMission(a.entityType, a.entityId);
  const organisateurs = organisateursDe(a, parent);
  const roles = rolesDe(user);
  const arbitre = estArbitre({ id: user.id, roles }, organisateurs);
  const cote = coteDe(user.id, a.userId, arbitre);
  const versions = await versionsCourantes(a);
  const derniere = versions.length ? versions[versions.length - 1]! : null;
  const etape = etapeParticipation(a, derniere ? versionLite(derniere) : null);
  return { parent, organisateurs, roles, arbitre, cote, versions, derniere, etape };
}

/** Prévenir l'autre côté : la personne, ou les organisateurs (hors soi). */
export async function prevenirAutreCote(a: Assignation, cote: Cote, acteurId: string, organisateurs: string[], titre: string, corps: string, ancre?: "fil") {
  const cibles = cote === "PERSONNE" ? organisateurs : [a.userId];
  for (const c of new Set(cibles)) {
    if (c === acteurId) continue;
    await notifyUser({ userId: c, type: "ASSIGNMENT", title: titre, body: corps, link: lienMission(a.id, ancre) }).catch(sansBloquer("mission-actions.prevenirAutreCote.notifyUser"));
  }
}

/** La porte des dépôts de la plateforme (billet, hôtel) : assistante de direction, organisateurs, Direction Marketing, Super Admin. */
export async function porteReservation(id: string | null, user: { id: string; role: string; secondaryRole?: string | null }) {
  const a = await chargerAssignation(id);
  if (!a || a.archivedAt) return { erreur: "Mission introuvable." } as const;
  const parent = await parentMission(a.entityType, a.entityId);
  if (!peutDeposerReservation({ id: user.id, roles: rolesDe(user) }, organisateursDe(a, parent))) {
    return { erreur: "Le billet émis et la confirmation d'hôtel se déposent par l'assistante de direction, l'organisateur, la Direction Marketing ou le Super Admin." } as const;
  }
  return { a, parent } as const;
}

export async function deposerPiece(userId: string, assignmentId: string, f: FormDataEntryValue | null, stepKey: "BILLET" | "HOTEL" | "FRAIS"): Promise<{ ok: true; id: string | undefined } | { ok: false; error: string }> {
  if (!(f instanceof File) || f.size === 0) return { ok: true, id: undefined };
  const r = await persistUploadedDocument(userId, { entityType: "MISSION_ASSIGNMENT", entityId: assignmentId, category: "SUPPORTING_DOC", confidentiality: "INTERNAL", stepKey, file: f });
  if (!r.ok || !r.documentId) return { ok: false, error: r.error ?? "Le fichier n'a pas pu être enregistré." };
  return { ok: true, id: r.documentId };
}

/** La porte des dépenses : la personne, sa mission ouverte (OM émis), pas encore clôturée. */
export async function porteFrais(id: string | null, userId: string) {
  const a = await chargerAssignation(id);
  if (!a || a.archivedAt) return { erreur: "Mission introuvable." } as const;
  const om = await dernierOrdre(a.id);
  const etatOm = etatOrdreMission(om ? { status: om.status as HrStatut, managerGate: (om.managerGate ?? null) as GateN1 | null } : null, a.orderStatus);
  const refus = refusModifFrais({ cloturee: Boolean(a.clotureLe), omEmis: etatOm === "EMIS" }, a.userId === userId);
  if (refus) return { erreur: refus } as const;
  return { a, etatOm } as const;
}
