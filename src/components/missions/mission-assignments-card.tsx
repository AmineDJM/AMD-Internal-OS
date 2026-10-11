import type { EntityType } from "@prisma/client";
import { personnesInvitables, type MissionAssignmentDTO } from "@/lib/queries/missions";
import { adProBudgetOptions } from "@/lib/queries/ad-pro-items";
import { getCurrentUser } from "@/lib/session";
import { rolesDe } from "@/lib/missions-equipe/serveur";
import { peutChoisirBudgetMission } from "@/lib/missions-equipe/participation";
import { EquipeAdventum } from "./equipe-adventum";

/**
 * « ÉQUIPE ADVENTUM » sur une demande Ad & Pro (sponsoring, événement, congrès national / international) — composant
 * SERVEUR : il lit lui-même les salariés actifs, groupés par département, pour le sélecteur, et — pour la Direction
 * Marketing — les lignes budgétaires où imputer les frais de mission. Les fiches lui passent encore `users` (liste à
 * plat d'avant) : il n'en a plus besoin.
 */
export async function MissionAssignmentsCard({
  entityType, entityId, assignments, canManage, currentUserId,
}: {
  entityType: EntityType;
  entityId: string;
  assignments: MissionAssignmentDTO[];
  users?: { id: string; name: string }[];
  canManage: boolean;
  currentUserId: string;
  path?: string;
}) {
  const viewer = await getCurrentUser();
  const roles = viewer ? rolesDe(viewer) : [];
  const peutBudget = peutChoisirBudgetMission(roles);
  const [personnes, budgetOptions] = await Promise.all([
    canManage ? personnesInvitables() : Promise.resolve([]),
    viewer && assignments.length > 0 ? adProBudgetOptions(viewer).catch(() => []) : Promise.resolve([]),
  ]);
  return (
    <EquipeAdventum
      entityType={entityType} entityId={entityId} assignments={assignments}
      personnes={personnes} canManage={canManage} currentUserId={currentUserId}
      viewerRoles={roles} peutBudget={peutBudget} budgetOptions={budgetOptions}
    />
  );
}
