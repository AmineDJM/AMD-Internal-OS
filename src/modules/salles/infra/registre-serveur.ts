import { prisma } from "@/lib/prisma";
import { chevauche } from "../domaine/registre";

/**
 * LE REGISTRE DES MOYENS GÉNÉRAUX — les lectures partagées par l'action de réservation et l'assistant (lot T3).
 * Jamais une action serveur : aucun appel depuis le navigateur.
 */

/** Les réservations CONFIRMÉES d'un moyen qui chevauchent un créneau. */
export async function conflitsDeReservation(moyenId: string, creneau: { debut: Date; fin: Date }) {
  const autour = await prisma.moyenGeneralReservation.findMany({
    where: { moyenId, statut: "CONFIRMEE", debut: { lt: creneau.fin }, fin: { gt: creneau.debut } },
    select: { id: true, debut: true, fin: true, objet: true },
  });
  return autour.filter((r) => chevauche(r, creneau));
}
