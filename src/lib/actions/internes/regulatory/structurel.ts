/**
 * REGULATORY — les CHAMPS STRUCTURELS (statut de fabrication, chargé du dossier, entité) : comparés, refusés à qui n'y a
 * pas droit, et annoncés au chargé ; le chargé nommé et s'il voit les dossiers verrouillés.
 *
 * Sorti de `actions/regulatory-actions.ts` (lot V4). Aucune écriture en base directe : l'annonce passe par les
 * notifications.
 */
import type { UserRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { seesLockedRegulatory, getAccess } from "@/lib/rbac";
import { notifyUser } from "@/lib/notify";
import { MANUFACTURING_STATUS } from "@/lib/labels";
import {
  canSetStructural, structuralChanges, structuralRefusal, structuralNotice, STRUCTURAL_LABELS, type StructuralChange,
} from "@/lib/regulatory/structural-fields";

/**
 * LES TROIS CHAMPS STRUCTURELS — comparés, refusés à qui n'y a pas droit, et ANNONCÉS.
 *
 * Un même verrou sert quatre écrans (la fiche, les deux menus du tableau, la promotion par
 * variation). Le poser une fois évite qu'une correction ne s'applique qu'à trois d'entre eux.
 *
 * Rend les changements RETENUS (vides si l'on n'a pas le droit) et le refus à afficher. Le refus
 * est une réserve, pas une erreur : le reste de la fiche s'enregistre. Perdre un formulaire de
 * trente champs parce qu'une liste déroulante a bougé serait une punition, pas une protection.
 */
export async function guardStructural(
  user: { id: string; role: string },
  before: { manufacturingStatus: string | null; responsibleId: string | null; companyId: string | null },
  after: Partial<{ manufacturingStatus: string | null; responsibleId: string | null; companyId: string | null }>,
): Promise<{ changes: StructuralChange[]; refusal: string | null }> {
  // Les valeurs s'affichent LISIBLES : un identifiant `cmxyz…` dans une notification n'apprend
  // rien à qui la reçoit.
  const ids = [after.responsibleId, before.responsibleId].filter(Boolean) as string[];
  const companyIds = [after.companyId, before.companyId].filter(Boolean) as string[];
  const [people, companies] = await Promise.all([
    ids.length ? prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : [],
    companyIds.length ? prisma.company.findMany({ where: { id: { in: companyIds } }, select: { id: true, name: true, shortName: true } }) : [],
  ]);
  const display = (field: string, value: string | null): string => {
    if (!value) return "—";
    if (field === "manufacturingStatus") return MANUFACTURING_STATUS[value] ?? value;
    if (field === "responsibleId") return people.find((p) => p.id === value)?.name ?? "—";
    const c = companies.find((x) => x.id === value);
    return c ? c.shortName || c.name : "—";
  };

  const changes = structuralChanges(before, after, display as never);
  if (changes.length === 0) return { changes: [], refusal: null };
  if (!canSetStructural(user)) return { changes: [], refusal: structuralRefusal(changes) };
  return { changes, refusal: null };
}

/**
 * PRÉVENIR LE CHARGÉ DU DOSSIER qu'un champ structurel a bougé.
 *
 * C'est lui qui répondra à l'agence sur le statut de fabrication : l'apprendre trois semaines
 * plus tard, en rouvrant la fiche par hasard, n'est pas acceptable. On ne se notifie pas
 * soi-même — le Super Admin sait ce qu'il vient de faire.
 */
export async function notifyCarrierOfStructural(
  productId: string,
  carrierId: string | null,
  actorId: string,
  reference: string,
  dci: string,
  changes: readonly StructuralChange[],
): Promise<void> {
  if (!carrierId || carrierId === actorId) return;
  const notice = structuralNotice(reference, dci, changes);
  if (!notice) return;
  await notifyUser({ userId: carrierId, type: "ASSIGNMENT", ...notice, link: `/regulatory/${productId}` });
}

/** MÊME CHANGEMENT, MÊME ANNONCE : une variation obtenue fait évoluer le statut de fabrication, et le chargé l'apprend. */
export async function annoncerLaFabrication(
  variation: { productId: string; toStatus: string },
  product: { reference: string; dci: string; manufacturingStatus: string; responsibleId: string | null },
  actorId: string,
): Promise<void> {
  await notifyCarrierOfStructural(
    variation.productId, product.responsibleId, actorId, product.reference, product.dci,
    [{
      field: "manufacturingStatus",
      label: STRUCTURAL_LABELS.manufacturingStatus,
      from: MANUFACTURING_STATUS[product.manufacturingStatus] ?? product.manufacturingStatus,
      to: MANUFACTURING_STATUS[variation.toStatus] ?? variation.toStatus,
    }],
  );
}

/** Le chargé nommé (son nom et ses rôles) — `null` quand le dossier est libéré. */
export async function chargeNomme(responsibleId: string | null) {
  return responsibleId
    ? await prisma.user.findUnique({ where: { id: responsibleId }, select: { name: true, role: true, secondaryRole: true } })
    : null;
}

/**
 * Le chargé voit-il les dossiers verrouillés ? Les DEUX clés du pipeline (Direction, 08/10) : la confidence ET le module
 * « Pipeline réglementaire » de la console.
 */
export async function voitLesVerrouilles(
  responsibleId: string | null, target: { role: UserRole; secondaryRole: UserRole | null } | null,
): Promise<boolean> {
  return target
    ? seesLockedRegulatory({
        id: responsibleId as string, role: target.role, secondaryRole: target.secondaryRole,
        access: await getAccess(responsibleId as string, target.role),
      })
    : false;
}
