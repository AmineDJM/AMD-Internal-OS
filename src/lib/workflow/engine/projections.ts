/**
 * Moteur de workflow — LES PROJECTIONS : le statut « legacy » écrit sur l'entité source lors d'un
 * refus, d'un renvoi pour correction ou d'une pose (l'approbation reste dans `engine.ts`).
 */
import type { EntityType } from "@prisma/client";
import { statutDepuisCircuit } from "@/modules/ad-pro/partage";
import { statutLegacyALEtape } from "../renvoi";
import { type LoadedDefinition, type LoadedStep, orderedSteps, type Viewer } from "./definitions";
import { LEGACY_FIELD, updateEntity } from "./entites";

export async function projectReject(entityType: EntityType, entityId: string, viewer: Viewer, reason: string) {
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
export async function projectReturn(entityType: EntityType, entityId: string, viewer: Viewer) {
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
export async function projectPose(entityType: EntityType, entityId: string, def: LoadedDefinition, etape: LoadedStep, ignorees: readonly string[], viewer: Viewer) {
  await projeterStatut(entityType, entityId, statutLegacyALEtape(orderedSteps(def), etape, ignorees, "AWAITING_PRELIMINARY"), viewer);
}
