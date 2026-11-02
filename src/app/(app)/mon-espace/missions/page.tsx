import { requireModule } from "@/lib/session";
import { PageHeader } from "@/components/shared/page-header";
import { ModuleTabs } from "@/components/shared/module-tabs";
import { ongletsEspace } from "@/lib/queries/mes-taches";
import { getMyMissions, ordresMissionAValider, articlesDemandables } from "@/lib/queries/missions";
import { faitsStock } from "@/lib/queries/promo-stock";
import { peutDemander } from "@/lib/promo/stock-acces";
import { MesMissions } from "@/components/missions/mes-missions";
import { sansBloquer } from "@/lib/journal";

export const dynamic = "force-dynamic";
export const metadata = { title: "Mes missions — Mon espace" };

/**
 * MON ESPACE › MES MISSIONS (Direction, 10/2026) — les missions Ad & Pro de la personne : invitations à confirmer,
 * puis une carte par mission (ordre de mission, et les étapes qu'elle ajoute). Le N+1 y valide aussi les ordres de
 * mission de son équipe. L'ancienne adresse `/missions` renvoie ici.
 */
export default async function MesMissionsPage() {
  const user = await requireModule("WORKSPACE");
  const [missions, aValider, tabs, faits] = await Promise.all([
    getMyMissions(user.id),
    ordresMissionAValider(user.id),
    ongletsEspace(user),
    faitsStock(user).catch(sansBloquer("missions-page.MesMissionsPage.faitsStock", null)),
  ]);
  const besoinArticles = missions.some((m) => m.response === "CONFIRMEE");
  const articles = besoinArticles && faits && peutDemander(faits) ? await articlesDemandables(user.id).catch(sansBloquer("missions-page.MesMissionsPage.articlesDemandables", [])) : [];
  const aVenir = missions.filter((m) => m.response === "CONFIRMEE").length;
  const invitations = missions.filter((m) => m.response === "INVITEE").length;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Mes missions"
        description={`${aVenir} mission${aVenir > 1 ? "s" : ""}${invitations ? ` · ${invitations} invitation${invitations > 1 ? "s" : ""}` : ""}${aValider.length ? ` · ${aValider.length} ordre${aValider.length > 1 ? "s" : ""} à valider` : ""}`}
      />
      <ModuleTabs tabs={tabs} />
      <MesMissions missions={missions} aValider={aValider} articles={articles} currentUserId={user.id} />
    </div>
  );
}
