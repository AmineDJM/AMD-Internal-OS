import { prisma } from "@/lib/prisma";
import { hasGlobalView, hasRole, userCan, type SessionUser } from "@/lib/rbac";
import { actsForUser } from "@/lib/hr/stand-in-resolve";
import { canAccessEntity } from "@/lib/entity-access";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES DEVIS D'UNE PRISE EN CHARGE, POUR L'ASSISTANTE À QUI ON LES A DEMANDÉS (audit Assistante de direction, 10/2026).
 *
 * Le défaut : « Devis à obtenir — prise en charge » menait à une porte fermée. La notification ouvrait la fiche du
 * congrès — un module que l'assistante de direction n'a pas — et `createCareQuote` exigeait le droit d'écrire dans ce
 * module. Les devis repartaient donc par e-mail, et la demande restait vide.
 *
 * La porte est ÉTROITE, comme celle des billets émis (`page-billets-emis.tsx`) : elle n'ouvre ni la fiche, ni la
 * comptabilité de la demande. Elle ouvre la SAISIE DES DEVIS (et la lecture des devis déjà saisis) d'une demande pour
 * laquelle des devis ont été DEMANDÉS — la demande porte son sujet d'assistante (`careReservationDossierId`, ouvert
 * par `requestCareQuotes`) — à :
 *   • une assistante de direction, par son rôle PRINCIPAL ou SECONDAIRE (c'est ainsi qu'elle est notifiée) ;
 *   • l'assistante DÉSIGNÉE du sujet (responsable ou participante), et l'intérimaire de la responsable absente.
 * Qui tient la fiche (droit d'écrire dans le module, sur CETTE demande) garde sa porte d'avant.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type PerimetreDevis = "NATIONAL" | "INTERNATIONAL";

const MODULE: Record<PerimetreDevis, "CONGRESS_NATIONAL" | "CONGRESS_INTERNATIONAL"> = {
  NATIONAL: "CONGRESS_NATIONAL",
  INTERNATIONAL: "CONGRESS_INTERNATIONAL",
};

/** Les faits d'une porte de saisie — établis au serveur, tranchés par `regleSaisieDevis`. */
export interface FaitsSaisieDevis {
  /** Écrit dans le module de la demande, et la demande lui est ouverte en écriture. */
  parLaFiche: boolean;
  /** Des devis ont été demandés : la demande porte son sujet d'assistante. */
  sollicitee: boolean;
  /** Assistante de direction, par le rôle principal OU secondaire. */
  assistanteDeDirection: boolean;
  /** Responsable ou participante du sujet — ou intérimaire de la responsable. */
  designee: boolean;
}

/** LA RÈGLE, sans base. */
export function regleSaisieDevis(f: FaitsSaisieDevis): boolean {
  if (f.parLaFiche) return true;
  return f.sollicitee && (f.assistanteDeDirection || f.designee);
}

/** La porte ÉTROITE seule (sans la fiche) : l'assistante sollicitée pour CETTE demande. */
export async function solliciteePourLesDevis(
  user: Pick<SessionUser, "id" | "role" | "secondaryRole">,
  scope: PerimetreDevis,
  requestId: string,
): Promise<boolean> {
  const demande = scope === "NATIONAL"
    ? await prisma.congressNational.findUnique({ where: { id: requestId }, select: { careReservationDossierId: true } })
    : await prisma.congressInternational.findUnique({ where: { id: requestId }, select: { careReservationDossierId: true } });
  if (!demande?.careReservationDossierId) return false;
  const assistanteDeDirection = hasRole(user, "DIRECTION_ASSISTANT");
  let designee = false;
  if (!assistanteDeDirection) {
    const sujet = await prisma.dossier.findUnique({
      where: { id: demande.careReservationDossierId }, select: { assignedToId: true, participantIds: true },
    });
    designee = Boolean(sujet && (
      sujet.assignedToId === user.id
      || sujet.participantIds.includes(user.id)
      || (sujet.assignedToId && await actsForUser(user.id, sujet.assignedToId))
    ));
  }
  return regleSaisieDevis({ parLaFiche: false, sollicitee: true, assistanteDeDirection, designee });
}

/** Qui tient la fiche : le droit d'écrire dans le module, sur CETTE demande (la porte d'avant de `createCareQuote`). */
export async function saisitParLaFiche(user: SessionUser, scope: PerimetreDevis, requestId: string): Promise<boolean> {
  const m = MODULE[scope];
  const ecrit = userCan(user, m, "CREATE") || userCan(user, m, "UPDATE") || hasGlobalView(user);
  return ecrit && canAccessEntity(user, m, requestId, "UPDATE");
}

/** PEUT-ON SAISIR LES DEVIS DE CETTE PRISE EN CHARGE ? — la porte de l'action ET de la page « Devis ». */
export async function peutSaisirLesDevis(user: SessionUser, scope: PerimetreDevis, requestId: string): Promise<boolean> {
  return (await saisitParLaFiche(user, scope, requestId)) || solliciteePourLesDevis(user, scope, requestId);
}
