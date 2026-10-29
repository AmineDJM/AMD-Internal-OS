import type { EntityType } from "@prisma/client";
import { canAccessEntity } from "@/lib/entity-access";
import { peutLirePasseportDuSujet, peutLirePieceDePriseEnCharge } from "@/modules/ad-pro/api";
import { hasGlobalView, userCan, type SessionUser } from "@/lib/rbac";
import { voitLesSalaires } from "@/lib/hr/confidentialite";
import { entitePermisePourFiche } from "@/lib/company";
import { managesReports } from "@/lib/queries/field-reports";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * QUI PEUT OUVRIR CETTE PIÈCE — les règles des routes qui SERVENT un fichier, sorties de leur route pour
 * avoir deux lecteurs : la route elle-même, et la recherche de la bibliothèque (J1), qui ne doit rendre
 * QUE ce que la personne pourrait ouvrir (`src/modules/bibliotheque/infra/acces.ts`). Une règle, un
 * endroit (§118.5) : la route et la recherche appellent la même fonction, aucune ne la recopie.
 *
 * Les règles déjà nommées ailleurs restent où elles sont : `resolveDriveAccess` (Drive),
 * `canAccessConversation` (messagerie), `canViewMeeting` (réunions), `canReadFeedback` (retours),
 * `peutVoirBilan` (KPI).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Un `Document` de module (`/api/documents/[id]`) : l'entité, ou les deux portes étroites d'Ad & Pro. */
export async function peutOuvrirDocument(
  user: SessionUser,
  doc: { id: string; entityType: EntityType; entityId: string; stepKey: string | null },
): Promise<boolean> {
  // Le passeport d'un voyageur s'ouvre aussi à qui réserve son billet (audit 360°, I10) — une porte
  // ÉTROITE, à la pièce près : voir `peutLirePasseportDuSujet`.
  // Même porte pour un congrès (passeports, billets émis, vouchers, livrets de séjour) : `peutLirePieceDePriseEnCharge`.
  return (await canAccessEntity(user, doc.entityType, doc.entityId, "VIEW"))
    || (await peutLirePasseportDuSujet(user.id, doc))
    || (await peutLirePieceDePriseEnCharge(user, doc));
}

/** La pièce jointe d'un message de SUJET (`/api/dossiers/message-attachment/[id]`). */
export function peutOuvrirPieceDeSujet(
  user: SessionUser,
  dossier: { createdById: string | null; assignedToId: string | null; participantIds: string[] },
): boolean {
  if (!userCan(user, "DOSSIERS", "VIEW")) return false;
  return hasGlobalView(user.role) || dossier.createdById === user.id || dossier.assignedToId === user.id || dossier.participantIds.includes(user.id);
}

/**
 * Un document du dossier RH (`/api/rh/document/[id]`). Un bulletin, un contrat, une pièce d'identité : la
 * LECTURE du module ne suffit pas (audit 360°, S5) — il faut GÉRER les RH (`voitLesSalaires`), et dans une
 * société permise (S6). L'employé garde ses propres pièces marquées visibles.
 */
export async function peutOuvrirDocumentRh(
  user: SessionUser,
  doc: { visibleToEmployee: boolean; employee: { userId: string | null; companyId: string | null } },
): Promise<boolean> {
  const isOwner = doc.employee.userId === user.id && doc.visibleToEmployee;
  return isOwner || (voitLesSalaires(user) && (await entitePermisePourFiche(user.id, doc.employee.companyId)));
}

/** Une pièce (ou le vocal) d'un rapport terrain (`/api/field-reports/attachment/[id]`). */
export function peutOuvrirPieceDeRapport(user: SessionUser, report: { delegateId: string | null }): boolean {
  // Garde sur le module RAPPORTS TERRAIN (et non « Promotion médicale ») depuis leur séparation.
  if (!userCan(user, "FIELD_REPORTS", "VIEW")) return false;
  return managesReports(user) || report.delegateId === user.id;
}
