import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireModule } from "@/lib/session";
import { canAccessEntity } from "@/lib/entity-access";
import { getMissionDetail } from "@/lib/queries/missions";
import { adProBudgetOptions } from "@/lib/queries/ad-pro-items";
import { rolesDe } from "@/lib/missions-equipe/serveur";
import { estArbitre, coteDe, peutDeposerReservation, peutChoisirBudgetMission } from "@/lib/missions-equipe/participation";
import { CHEMIN_MES_MISSIONS } from "@/lib/chemins/espace";
import { MissionEquipe } from "@/components/missions/mission-equipe";

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
  const detail = await getMissionDetail(params.id);
  if (!detail) notFound();
  const roles = rolesDe(user);
  const arbitre = estArbitre({ id: user.id, roles }, detail.mission.organisateurIds);
  const vue = coteDe(user.id, detail.mission.userId, arbitre);
  const peutBudget = peutChoisirBudgetMission(roles);
  const budgetOptions = peutBudget ? await adProBudgetOptions(user).catch(() => []) : [];
  const path = `${CHEMIN_MES_MISSIONS}/${params.id}`;

  return (
    <div className="mx-auto w-full max-w-6xl space-y-4">
      <Link href={CHEMIN_MES_MISSIONS} className="inline-flex w-fit items-center gap-1.5 py-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" aria-hidden /> Mes missions
      </Link>
      <MissionEquipe
        detail={detail} vue={vue} currentUserId={user.id} path={path}
        peutDeposer={peutDeposerReservation({ id: user.id, roles }, detail.mission.organisateurIds)}
        peutBudget={peutBudget} budgetOptions={budgetOptions}
      />
    </div>
  );
}
