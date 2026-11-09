"use server";

import { requireUser } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { fdStr } from "@/lib/actions/types";
import { documentsLegalPourPaiement, lireFichierPourLaDemande, lirePourLaDemande } from "@/lib/actions/internes/paiement/pieces-legal";
import { prisma } from "@/lib/prisma";
import type { DemandeEnCours, DocumentLegalPropose, LecturePourDemande } from "./partage";
import { refusDeRemplacement } from "./partage";

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

/**
 * « VOS DEMANDES EN COURS » (Direction, 09/11/2026) — les demandes de paiement de la personne qui ne sont ni réglées ni
 * refusées ni annulées, les plus récentes d'abord. Rappelées en tête de « Demander un paiement » : on ajoute un fichier à
 * la demande qui existe au lieu d'en ouvrir une seconde. Les SIENNES seulement (`requesterId`).
 */
export async function mesDemandesDePaiementEnCours(): Promise<DemandeEnCours[]> {
  const user = await requireUser();
  if (!userCan(user, "VALIDATIONS", "CREATE")) return [];
  const lignes = await prisma.paymentRequest.findMany({
    where: { requesterId: user.id, status: { notIn: ["APPROVED", "REJECTED", "CANCELLED"] } },
    orderBy: { updatedAt: "desc" },
    take: 8,
    select: {
      id: true, reference: true, title: true, payee: true, amount: true, status: true, updatedAt: true,
      pieces: {
        where: { replacedBy: null }, orderBy: { position: "asc" },
        select: { id: true, documentId: true, kind: true, status: true },
      },
    },
  });
  // Les NOMS des fichiers (la pièce ne porte que l'id du document).
  const docIds = lignes.flatMap((d) => d.pieces.map((p) => p.documentId));
  const docs = docIds.length
    ? await prisma.document.findMany({ where: { id: { in: docIds } }, select: { id: true, name: true } })
    : [];
  const nomDe = new Map(docs.map((x) => [x.id, x.name]));
  return lignes.map((d) => ({
    id: d.id, reference: d.reference, title: d.title, payee: d.payee, amount: Number(d.amount ?? 0), status: d.status,
    pieces: d.pieces.length, majLe: d.updatedAt.toISOString(),
    fichiers: d.pieces.map((p) => {
      // LA MÊME RÈGLE QUE L'ACTION (`addPaymentPiece` avec `replacesId`) : le bouton n'apparaît que là où elle accepterait.
      const refus = refusDeRemplacement({ pieceStatus: p.status, dejaRemplacee: false, dossierStatus: d.status, parLeDemandeur: true });
      return {
        id: p.id, documentId: p.documentId, nom: nomDe.get(p.documentId) ?? "Fichier", kind: p.kind, status: p.status,
        remplacable: refus === null, refus,
      };
    }),
  }));
}
