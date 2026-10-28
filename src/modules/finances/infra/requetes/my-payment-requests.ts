import { prisma } from "@/lib/prisma";

/**
 * MES DEMANDES DE PAIEMENT — la liste du DEMANDEUR, définie une seule fois.
 *
 * ── LE DÉFAUT QU'ELLE FERME ─────────────────────────────────────────────────────────────────
 *
 * Les demandes de paiement n'ont plus d'entrée de menu : on les dépose depuis « Demandes de
 * validations », et le formulaire conduit ensuite sur la fiche du dossier. Cet écran-là, en
 * revanche, ne montrait AUCUNE demande de paiement. Résultat : une fois la fiche quittée, le
 * dossier n'était plus atteignable par personne — ni pour suivre, ni pour joindre la pièce que
 * les Finances réclament. « J'envoie ma demande, et je ne la vois plus. »
 *
 * Un écran où l'on DÉPOSE doit montrer ce qu'on y a déposé. Cette fonction est cette liste, et
 * elle est partagée par les deux écrans qui la servent — l'écran des validations (la porte) et
 * l'écran dédié (la liste complète). Deux requêtes auraient fini par diverger, et l'on serait
 * revenu au même endroit : une demande visible ici, absente là.
 *
 * ── CE QU'ELLE NE FILTRE PAS, ET POURQUOI ───────────────────────────────────────────────────
 *
 * Ni le statut, ni l'origine. Une demande transmise, mise en attente, refusée ou payée reste
 * SIENNE : c'est elle qu'on relancera, et c'est son auteur qui fournira la pièce manquante. Les
 * dossiers nés d'un autre circuit (matériel promotionnel, bon de versement, sponsoring) en font
 * partie — ce sont des paiements qu'il attend, et les retrouver ici est la condition pour
 * pouvoir relancer ou signaler une urgence.
 */
export async function myPaymentRequests(userId: string, take = 200) {
  return prisma.paymentRequest.findMany({
    where: { requesterId: userId },
    orderBy: { createdAt: "desc" },
    take,
  });
}

export type MyPaymentRequest = Awaited<ReturnType<typeof myPaymentRequests>>[number];
