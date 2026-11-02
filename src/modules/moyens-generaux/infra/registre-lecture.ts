import { prisma } from "@/lib/prisma";

/** L'écran du registre : les fiches actives (échéance d'abord) et les réservations à venir. */
export async function registreEtReservations(maintenant: Date = new Date()) {
  const [moyens, reservations] = await Promise.all([
    prisma.moyenGeneral.findMany({
      where: { statut: "ACTIF" }, orderBy: [{ echeance: "asc" }, { libelle: "asc" }], take: 500,
      select: { id: true, reference: true, type: true, libelle: true, prestataire: true, identifiant: true, montant: true, periodicite: true, echeance: true, rappelJours: true, capacite: true, parent: { select: { libelle: true } } },
    }),
    prisma.moyenGeneralReservation.findMany({
      where: { statut: "CONFIRMEE", fin: { gte: maintenant } }, orderBy: { debut: "asc" }, take: 50,
      select: { id: true, debut: true, fin: true, objet: true, participants: true, moyen: { select: { libelle: true } } },
    }),
  ]);
  return { moyens, reservations };
}
