import type { EntityType } from "@prisma/client";
import { personnesInvitables, getEntityMissions, type MissionAssignmentDTO } from "@/lib/queries/missions";
import { getCurrentUser } from "@/lib/session";
import { parentMission, rolesDe } from "@/lib/missions-equipe/serveur";
import { assurerImputationEquipe, imputationsProposees } from "@/lib/missions-equipe/imputation-serveur";
import { peutChoisirBudgetMission } from "@/lib/missions-equipe/participation";
import { EquipeAdventum } from "./equipe-adventum";

/**
 * « ÉQUIPE ADVENTUM » sur une demande Ad & Pro (sponsoring, événement, congrès national / international) — composant
 * SERVEUR : il lit lui-même les salariés actifs, groupés par département, pour le sélecteur, et les catégories du
 * BUDGET OPERATIONS & SALES où vont les frais de l'équipe (Direction, 10/2026 : « ici le budget à imputer, ce n'est pas
 * Ad & Pro, c'est Operations & Sales ») — l'enveloppe de l'année ouverte d'office, et l'imputation par défaut posée sur
 * un membre qui n'en a pas encore. Les fiches lui passent encore `users` (liste à plat d'avant) : il n'en a plus besoin.
 */
export async function MissionAssignmentsCard({
  entityType, entityId, assignments: initiales, canManage, currentUserId,
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
  let assignments = initiales;
  let imputation: Awaited<ReturnType<typeof imputationsProposees>> = { options: [], defaut: null };
  if (viewer && assignments.length > 0) {
    const parent = await parentMission(entityType, entityId);
    // Un membre invité avant la règle n'a pas d'imputation : la sienne est posée par défaut (Operations & Sales), une
    // fois. Une ancienne imputation Ad & Pro n'est jamais réécrite — l'écran la montre comme telle.
    const sans = assignments.filter((a) => !a.budgetCategoryId && a.response !== "DECLINEE");
    if (sans.length > 0) {
      for (const a of sans) await assurerImputationEquipe(a.id, viewer.id, parent.debut);
      assignments = await getEntityMissions(entityType, entityId);
    }
    imputation = await imputationsProposees({ date: parent.debut, actorId: viewer.id }).catch(() => ({ options: [], defaut: null }));
  }
  const personnes = canManage ? await personnesInvitables() : [];
  return (
    <EquipeAdventum
      entityType={entityType} entityId={entityId} assignments={assignments}
      personnes={personnes} canManage={canManage} currentUserId={currentUserId}
      viewerRoles={roles} peutBudget={peutBudget} budgetOptions={imputation.options} imputationDefaut={imputation.defaut}
    />
  );
}
