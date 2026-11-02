import type { EntityType } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UNE LIGNE D'HISTOIRE AU FIL D'UNE FICHE AD & PRO (audit 360°, lot C4a).
 *
 * Un renvoi pour correction, un refus avant resoumission, une prolongation : ce qui a été DEMANDÉ ou
 * DÉCIDÉ doit survivre au geste suivant, qui efface les champs du moment (le motif du renvoi, la note
 * de refus) pour que la fiche dise l'état d'AUJOURD'HUI. L'histoire va donc au fil de la fiche — la
 * section discussion que les sept natures du pôle montrent (§118.145) —, écrite AVANT d'effacer.
 *
 * Hors des fichiers d'actions, pour une raison mesurée (§118.150 g) : une action qui écrit DEUX
 * modèles dans son propre corps fait renoncer la dérivation des contrats à dire ce que désigne son
 * `id`, et le chemin générique d'Adam ne saurait plus traduire « le contrat Atakor Minds » en
 * identifiant. Écrite ici, la ligne reste comptée parmi les écritures de l'action, et l'`id` garde
 * son modèle.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export async function ecrireAuFil(i: { entityType: EntityType; entityId: string; authorId: string; body: string }): Promise<void> {
  await prisma.comment.create({ data: { entityType: i.entityType, entityId: i.entityId, authorId: i.authorId, body: i.body } });
}
