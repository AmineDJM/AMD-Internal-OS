import { prisma } from "@/lib/prisma";
import { hasGlobalView, userCan, type SessionUser } from "@/lib/rbac";

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

/**
 * QUI INSTRUIT LES DEMANDES — les Finances (valider ou modifier), le responsable budget, la vue globale. Une seule
 * définition pour l'écran (`/validations/paiements`, section « À instruire ») et son export (lot K7, décision 0037).
 */
export const instruitLesDemandes = (user: SessionUser): boolean =>
  userCan(user, "FINANCES", "VALIDATE") || userCan(user, "FINANCES", "UPDATE")
  || user.role === "FINANCE_BUDGET_MANAGER" || hasGlobalView(user.role);

/**
 * LA FILE À INSTRUIRE (Finances) — transmises, en instruction, mises en attente.
 *
 * LES COMPAGNONS NE S'INSTRUISENT PAS ICI : depuis que tout ordre de dépense ouvre son dossier, les paiements nés
 * ailleurs (matériel promotionnel, bon de versement, sponsoring…) ont eux aussi un dossier ; leur circuit d'origine a
 * validé, le centre a autorisé, les Finances les règlent dans « Banque & paiements ». Les faire remonter ici
 * demanderait de les instruire une SECONDE fois — d'où `origin: "REQUEST"`.
 */
export async function fileAInstruire(take = 200) {
  return prisma.paymentRequest.findMany({
    where: { status: { in: ["SUBMITTED", "UNDER_REVIEW", "ON_HOLD"] }, origin: "REQUEST" },
    orderBy: { createdAt: "desc" }, take,
  });
}
