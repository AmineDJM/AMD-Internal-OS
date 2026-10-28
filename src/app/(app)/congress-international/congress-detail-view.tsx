import type { EntityType } from "@prisma/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { CongressDetail } from "@/modules/ad-pro/api";
import { WorkflowPanel } from "@/components/workflow/workflow-panel";
import type { WorkflowView } from "@/lib/queries/workflow";
import { ThirdPartyInvolveButton } from "@/modules/ad-pro/ecrans/third-party-involve";
import { MissionAssignmentsCard } from "@/components/missions/mission-assignments-card";
import type { MissionAssignmentDTO } from "@/lib/queries/missions";

/**
 * LE CIRCUIT DE VALIDATION D'UNE PRISE EN CHARGE — pleine largeur.
 *
 * Ce qui vivait ici et n'y est plus (Direction, 07/10) : « Informations » (fusionnée dans « La prise en charge »,
 * `CartePriseEnCharge`), « Budgets » (estimé / arbitré — les chiffres sont dans le bandeau de la prise en charge) et
 * « Participants Adventum » (retirés de la demande). « Accompagnants & délégués » se pose TOUT EN BAS de la fiche
 * (`AccompagnantsDeLaPriseEnCharge`) : la colonne de droite ne rétrécit plus le reste.
 */
export function CongressDetailView({ detail, workflow, canInvolveThirdParty, entityType, entityId, missionUsers }: {
  detail: CongressDetail;
  workflow: WorkflowView | null;
  canInvolveThirdParty: boolean;
  entityType: EntityType;
  entityId: string;
  missionUsers: { id: string; name: string }[];
}) {
  return (
    <Card>
      <CardHeader><CardTitle>Circuit de validation</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        {workflow ? (
          <WorkflowPanel entityType={entityType} entityId={entityId} view={workflow} />
        ) : (
          <p className="text-sm text-muted-foreground">Circuit indisponible.</p>
        )}
        {canInvolveThirdParty && (
          <div className="border-t border-border pt-3">
            <ThirdPartyInvolveButton type={detail.type} id={detail.id} people={missionUsers} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** « Accompagnants & délégués » — en bas de la fiche, pleine largeur. */
export function AccompagnantsDeLaPriseEnCharge(p: {
  entityType: EntityType; entityId: string; missions: MissionAssignmentDTO[]; missionUsers: { id: string; name: string }[];
  canManageMissions: boolean; currentUserId: string; path: string;
}) {
  return (
    <MissionAssignmentsCard
      entityType={p.entityType} entityId={p.entityId} assignments={p.missions} users={p.missionUsers}
      canManage={p.canManageMissions} currentUserId={p.currentUserId} path={p.path}
    />
  );
}
