import { prisma } from "@/lib/prisma";

/** L'écran des salles : les salles actives (capacité) et les réservations à venir. */
export async function sallesEtReservations(maintenant: Date = new Date()) {
  const [salles, reservations] = await Promise.all([
    prisma.moyenGeneral.findMany({
      where: { statut: "ACTIF", type: "SALLE" }, orderBy: [{ capacite: "asc" }, { libelle: "asc" }], take: 200,
      select: { id: true, reference: true, libelle: true, capacite: true, notes: true },
    }),
    prisma.moyenGeneralReservation.findMany({
      where: { statut: "CONFIRMEE", fin: { gte: maintenant }, moyen: { type: "SALLE" } }, orderBy: { debut: "asc" }, take: 100,
      select: { id: true, debut: true, fin: true, objet: true, participants: true, reserveParId: true, moyen: { select: { libelle: true } } },
    }),
  ]);
  return { salles, reservations };
}
