"use server";

import { requireUser } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { fdStr } from "@/lib/actions/types";
import { documentsLegalPourPaiement, lireFichierPourLaDemande, lirePourLaDemande } from "@/lib/actions/internes/paiement/pieces-legal";
import type { DocumentLegalPropose, LecturePourDemande } from "./partage";

/**
 * LES PIÈCES DE « DEMANDER UN PAIEMENT » (Direction, 04/11/2026) — deux lectures d'écran, rien n'est écrit.
 *
 * La porte est celle de la demande (« Demandes de paiement », créer) : qui ne peut pas demander un paiement ne fait
 * pas lire de pièce ici. Le registre proposé est celui que la personne voit dans Legal — sans accès à Legal, la liste
 * est vide, et le dépôt d'une pièce reste ouvert.
 */

/** Ce qu'une pièce propose au formulaire : `fichier` (déposé), ou `legalDocumentId` (choisi dans Legal). */
export async function lirePieceDePaiement(formData: FormData): Promise<LecturePourDemande> {
  const user = await requireUser();
  if (!userCan(user, "VALIDATIONS", "CREATE")) return { ok: false, error: "Non autorisé." };
  const legalDocumentId = fdStr(formData, "legalDocumentId");
  if (legalDocumentId) return lirePourLaDemande(user, { legalDocumentId });
  const fichier = formData.get("fichier");
  if (!(fichier instanceof File) || fichier.size === 0) return { ok: false, error: "Choisissez la pièce à lire." };
  return lireFichierPourLaDemande(user, fichier);
}

/** « Choisir dans Legal » : les documents visibles qui justifient un paiement, filtrés par `recherche`. */
export async function documentsLegalPourDemande(formData: FormData): Promise<DocumentLegalPropose[]> {
  const user = await requireUser();
  if (!userCan(user, "VALIDATIONS", "CREATE")) return [];
  return documentsLegalPourPaiement(user, fdStr(formData, "recherche"));
}
