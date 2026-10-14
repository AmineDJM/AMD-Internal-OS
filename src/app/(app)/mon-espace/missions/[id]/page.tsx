import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, BookOpen } from "lucide-react";
import { requireModule } from "@/lib/session";
import { canAccessEntity } from "@/lib/entity-access";
import { getMissionDetail } from "@/lib/queries/missions";
import { assurerImputationEquipe, imputationsProposees } from "@/lib/missions-equipe/imputation-serveur";
import { rolesDe } from "@/lib/missions-equipe/serveur";
import { estArbitre, coteDe, peutDeposerReservation, peutChoisirBudgetMission } from "@/lib/missions-equipe/participation";
import { CHEMIN_MES_MISSIONS } from "@/lib/chemins/espace";
import { MissionEquipe } from "@/components/missions/mission-equipe";
import { dernierLivretGeneral } from "@/lib/livret/serveur";

export const dynamic = "force-dynamic";
export const metadata = { title: "Mission — Mon espace" };

/**
 * UNE MISSION DE L'ÉQUIPE ADVENTUM (Direction, 10/2026) — la destination de ses notifications : la demande de
 * participation (fiche, versions, accord), puis la mission (ordre, billet, hôtel, dépenses, rapport, clôture).
 * La même page pour la personne invitée et pour qui tranche côté Adventum ; une mission qu'on ne peut pas voir
 * rend la même page qu'une mission inexistante.
 */
export default async function MissionEquipePage({ params }: { params: { id: string } }) {
  const user = await requireModule("WORKSPACE");
  if (!(await canAccessEntity(user, "MISSION_ASSIGNMENT", params.id, "VIEW"))) notFound();
  let detail = await getMissionDetail(params.id);
  if (!detail) notFound();
  // Les frais de l'équipe vont au budget Operations & Sales (Direction, 10/2026) : un membre invité avant la règle reçoit
  // l'imputation par défaut, une fois ; une ancienne imputation Ad & Pro n'est jamais réécrite.
  if (!detail.mission.budgetCategoryId && detail.mission.response !== "DECLINEE") {
    await assurerImputationEquipe(params.id, user.id, detail.mission.dateDepart ? new Date(detail.mission.dateDepart) : null);
    detail = (await getMissionDetail(params.id)) ?? detail;
  }
  const roles = rolesDe(user);
  const arbitre = estArbitre({ id: user.id, roles }, detail.mission.organisateurIds);
  const vue = coteDe(user.id, detail.mission.userId, arbitre);
  const peutBudget = peutChoisirBudgetMission(roles);
  const imputation = await imputationsProposees({ date: detail.mission.dateDepart ? new Date(detail.mission.dateDepart) : null, actorId: user.id })
    .catch(() => ({ options: [], defaut: null }));
  const path = `${CHEMIN_MES_MISSIONS}/${params.id}`;
  // LE LIVRET DE LA DÉLÉGATION (congrès) : le dernier édité par les organisateurs — la porte des documents l'ouvre à l'équipe.
  const livret = await dernierLivretGeneral(detail.mission.entityType, detail.mission.entityId);

  return (
    <div className="mx-auto w-full max-w-6xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link href={CHEMIN_MES_MISSIONS} className="inline-flex w-fit items-center gap-1.5 py-1.5 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" aria-hidden /> Mes missions
        </Link>
        {livret && (
          <a href={`/api/documents/${livret}`} target="_blank" rel="noreferrer" className="inline-flex min-h-9 items-center gap-1.5 text-sm font-medium text-primary hover:underline sm:min-h-0">
            <BookOpen className="h-4 w-4" aria-hidden /> Livret de la délégation
          </a>
        )}
      </div>
      <MissionEquipe
        detail={detail} vue={vue} currentUserId={user.id} path={path}
        peutDeposer={peutDeposerReservation({ id: user.id, roles }, detail.mission.organisateurIds)}
        peutBudget={peutBudget} budgetOptions={imputation.options} imputationDefaut={imputation.defaut}
      />
    </div>
  );
}
