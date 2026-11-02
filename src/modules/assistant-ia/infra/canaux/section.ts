import type { AssistantIaAttentePieces } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { sansBloquer } from "@/lib/journal";
import { sectionAttentes } from "../../domaine/canaux/attentes";

/**
 * K6 (décision 0036) — LES PIÈCES ATTENDUES DANS LA CONSIGNE : lues à chaque tour du fil, une section SEULEMENT si une
 * attente est ouverte (zéro jeton sinon). Fichier à part : le fil la lit sans charger la réception (qui notifie par lui).
 */
export async function attentesVivantes(userId: string, maintenant: Date): Promise<AssistantIaAttentePieces[]> {
  return prisma.assistantIaAttentePieces.findMany({
    where: { userId, etat: { in: ["OUVERTE", "RECUE"] }, expireLe: { gt: maintenant } },
    orderBy: { createdAt: "desc" }, take: 10,
  });
}

/** LA SECTION DE LA CONSIGNE — nulle (zéro jeton) sans attente ouverte. */
export async function sectionAttentesDuTour(userId: string, maintenant = new Date()): Promise<string | null> {
  const a = await attentesVivantes(userId, maintenant).catch(sansBloquer("canaux.sectionAttentesDuTour", [] as AssistantIaAttentePieces[]));
  return sectionAttentes(a, maintenant);
}
