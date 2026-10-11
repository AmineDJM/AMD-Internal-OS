import { prisma } from "@/lib/prisma";
import { hasGlobalView, type SessionUser } from "@/lib/rbac";
import { peutTeleverserBillet } from "@/lib/care-fiches";
import { natureDuLivret, peutLirePiecePriseEnCharge, type NaturePiece } from "@/lib/care-pieces-acces";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE PASSEPORT D'UN VOYAGEUR, POUR QUI RÉSERVE SON BILLET (§118.185 — audit 360°, I10).
 *
 * Le sujet de réservation annonce « passeport joint » ; le passeport est une pièce du POSTE de
 * billetterie (désignée par le voyageur, `stepKey`), et l'accès à un poste suit son opération —
 * congrès, sponsoring, événement — que l'assistante de direction n'a pas. Elle recevait donc un
 * refus au téléchargement de la pièce même qu'on lui demandait d'utiliser, et réservait un billet
 * international en redemandant le passeport hors de la plateforme.
 *
 * La porte est ÉTROITE, et c'est la moitié qui compte : elle ne s'ouvre qu'au responsable et aux
 * participants du SUJET DE RÉSERVATION de ce poste, et seulement pour une pièce qui désigne un
 * VOYAGEUR de ce poste. Les autres pièces du poste (devis, factures) restent derrière la porte de
 * l'opération : réserver un billet n'ouvre pas la comptabilité de la demande.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export async function peutLirePasseportDuSujet(
  userId: string,
  doc: { entityType: string; entityId: string; stepKey: string | null },
): Promise<boolean> {
  if (doc.entityType !== "AD_PRO_ITEM" || !doc.stepKey) return false;
  const poste = await prisma.adProItem.findUnique({
    where: { id: doc.entityId },
    select: { reservationDossier: { select: { assignedToId: true, participantIds: true } } },
  });
  const sujet = poste?.reservationDossier;
  if (!sujet) return false;
  const membre = sujet.assignedToId === userId || sujet.participantIds.includes(userId);
  if (!membre) return false;
  // La pièce désigne-t-elle un VOYAGEUR — ou une FICHE HÔTELLERIE (Direction, 06/10) — de ce poste ?
  // Sinon ce n'est pas une pièce d'identité de personne prise en charge.
  const [voyageur, hebergement] = await Promise.all([
    prisma.adProVoyageur.count({ where: { id: doc.stepKey, itemId: doc.entityId } }),
    prisma.adProHebergement.count({ where: { id: doc.stepKey, itemId: doc.entityId } }),
  ]);
  return voyageur + hebergement > 0;
}

/**
 * LES PIÈCES D'UNE PRISE EN CHARGE (congrès) POUR QUI RÉSERVE ET QUI ACCOMPAGNE — le pendant de la porte ci-dessus :
 * passeports (au sujet de réservation), billets émis et vouchers, livrets de séjour. La règle est pure et testée
 * (`care-pieces-acces.ts`) ; ici, les faits.
 */
export async function peutLirePieceDePriseEnCharge(
  user: Pick<SessionUser, "id" | "role" | "secondaryRole"> & Parameters<typeof hasGlobalView>[0],
  doc: { id: string; entityType: string; entityId: string; stepKey: string | null },
): Promise<boolean> {
  if (doc.entityType !== "CONGRESS_INTERNATIONAL" && doc.entityType !== "CONGRESS_NATIONAL") return false;
  const intl = doc.entityType === "CONGRESS_INTERNATIONAL";
  const demande = intl
    ? await prisma.congressInternational.findUnique({ where: { id: doc.entityId }, select: { requesterId: true, careReservationDossierId: true } })
    : await prisma.congressNational.findUnique({ where: { id: doc.entityId }, select: { requesterId: true, careReservationDossierId: true } });
  if (!demande) return false;
  const parent = intl ? { congressInternationalId: doc.entityId } : { congressNationalId: doc.entityId };

  let nature: NaturePiece = natureDuLivret(doc.stepKey) ?? "AUTRE";
  if (nature === "AUTRE") {
    const [emis, piece] = await Promise.all([
      prisma.careCell.count({ where: { issuedDocumentId: doc.id, beneficiary: parent } }),
      prisma.careCell.count({ where: { kind: "DOCUMENT", beneficiary: parent, OR: [{ documentId: doc.id }, ...(doc.stepKey ? [{ id: doc.stepKey }] : [])] } }),
    ]);
    nature = emis > 0 ? "BILLET_EMIS" : piece > 0 ? "PIECE_IDENTITE" : "AUTRE";
  }
  if (nature === "AUTRE") return false;

  const sujet = demande.careReservationDossierId
    ? await prisma.dossier.findUnique({ where: { id: demande.careReservationDossierId }, select: { assignedToId: true, participantIds: true } })
    : null;
  const membreDuSujet = Boolean(sujet && (sujet.assignedToId === user.id || sujet.participantIds.includes(user.id)));
  const organise = peutTeleverserBillet(
    { id: user.id, roles: [user.role, user.secondaryRole].filter((r): r is NonNullable<typeof r> => Boolean(r)), vueGlobale: hasGlobalView(user) },
    { requesterId: demande.requesterId },
  );
  const equipe = nature === "LIVRET_GENERAL"
    ? (await prisma.missionAssignment.count({ where: { entityType: doc.entityType, entityId: doc.entityId, userId: user.id, archivedAt: null, response: { not: "DECLINEE" } } })) > 0
    : false;
  return peutLirePiecePriseEnCharge({ nature, membreDuSujet, organise, equipe });
}
