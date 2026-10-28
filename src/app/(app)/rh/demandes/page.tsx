import Link from "next/link";
import { requireModule } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { clauseSalariesVisibles } from "@/lib/queries/visibilite-listes";
import { getLeavesToDecide } from "@/lib/queries/hr";
import { getHrRequestQueue, getHrRequestsPretes } from "@/lib/queries/hr-documents";
import { complementsConges } from "@/lib/queries/conges-discussion";
import { referenceOrdreMissionSuggeree } from "@/lib/ordre-mission-depot";
import { PageHeader } from "@/components/shared/page-header";
import { ModuleTabs } from "@/components/shared/module-tabs";
import { visibleTabs } from "@/lib/nav-tabs";
import { DEMANDES_RH_TABS } from "@/lib/labels";
import { CongesATrancher } from "@/components/hr/leave-approvals";
import { cn } from "@/lib/utils";
import { FileDemandesRh, type FiltreDemandes } from "./file-demandes-rh";

export const dynamic = "force-dynamic";
export const metadata = { title: "Demandes RH — AMD Internal OS" };

const FILTRES: FiltreDemandes[] = ["a-traiter", "en-cours", "pretes"];

/**
 * « DEMANDES RH » — le sous-module des demandes des salariés (Direction, 06/10 : « qui recevra uniquement les demandes RH
 * et les congés »). Refondu sur la maquette validée le 07/10 : en tête, « N à traiter · M congés à trancher » et trois
 * filtres (À traiter, En cours, Prêtes) ; une LIGNE par demande, un geste (« Traiter »), le traitement dans un panneau
 * sous la ligne ; puis la TABLE des congés à trancher, chacun avec sa discussion.
 */
export default async function DemandesRhPage(props: { searchParams?: Promise<{ filtre?: string; demande?: string }> }) {
  const searchParams = await props.searchParams;
  const user = await requireModule("HR_REQUESTS");
  const peutTrancherConges = userCan(user, "HR_REQUESTS", "VALIDATE");
  const filtre: FiltreDemandes = FILTRES.includes(searchParams?.filtre as FiltreDemandes) ? (searchParams!.filtre as FiltreDemandes) : "a-traiter";
  const demandeAOuvrir = searchParams?.demande ?? null;
  // LA MÊME CLAUSE DE VISIBILITÉ pour la file ouverte et pour les demandes prêtes : le filtre « Prêtes » n'ouvre rien de
  // plus que ce que l'écran voyait déjà (les salariés visibles), borné à 30 jours et 50 lignes.
  const perimetre = await clauseSalariesVisibles(user.id);
  const [tabs, demandes, pretes, conges, reference] = await Promise.all([
    visibleTabs(user, DEMANDES_RH_TABS),
    getHrRequestQueue(perimetre),
    getHrRequestsPretes(perimetre),
    peutTrancherConges ? getLeavesToDecide(user) : Promise.resolve([]),
    referenceOrdreMissionSuggeree(),
  ]);
  const complements = await complementsConges(conges.map((c) => c.id));
  const congesRh = conges.map((c) => ({
    ...c,
    n1Valide: complements[c.id]?.n1Valide ?? null,
    soldeApres: complements[c.id]?.soldeApres ?? null,
    commentaires: complements[c.id]?.commentaires ?? [],
  }));

  const enCours = demandes.filter((d) => d.status === "IN_PROGRESS");
  const compte: Record<FiltreDemandes, number> = { "a-traiter": demandes.length, "en-cours": enCours.length, pretes: pretes.length };
  // UNE NOTIFICATION OUVRE SA DEMANDE OÙ ELLE EST (`?demande=`) : une entrevue confirmée ou une note
  // de frais traitée est « prête », pas « à traiter » — sans ce choix, le lien tombait sur une liste
  // où la demande n'est pas, et rien ne s'ouvrait.
  const filtreVu: FiltreDemandes = !searchParams?.filtre && demandeAOuvrir && !demandes.some((d) => d.id === demandeAOuvrir) && pretes.some((d) => d.id === demandeAOuvrir)
    ? "pretes"
    : filtre;
  const liste = filtreVu === "pretes" ? pretes : filtreVu === "en-cours" ? enCours : demandes;
  const LIBELLE: Record<FiltreDemandes, string> = { "a-traiter": "À traiter", "en-cours": "En cours", pretes: "Prêtes" };
  const resume = [
    `${demandes.length} à traiter`,
    peutTrancherConges ? `${conges.length} congé${conges.length > 1 ? "s" : ""} à trancher` : null,
  ].filter(Boolean).join(" · ");
  const maintenant = new Date().toISOString();

  return (
    <div className="space-y-5">
      <PageHeader title="Demandes RH" description={resume}>
        <nav aria-label="Filtrer les demandes" className="flex flex-wrap gap-1.5">
          {FILTRES.map((f) => (
            <Link
              key={f} href={f === "a-traiter" ? "/rh/demandes" : `/rh/demandes?filtre=${f}`} scroll={false}
              aria-current={f === filtreVu ? "page" : undefined}
              className={cn(
                "inline-flex min-h-9 items-center rounded-full border px-3 text-sm transition-colors sm:min-h-8",
                f === filtreVu ? "border-foreground bg-foreground text-background" : "border-border bg-card text-muted-foreground hover:bg-secondary hover:text-foreground",
              )}
            >
              {LIBELLE[f]} ({compte[f]})
            </Link>
          ))}
        </nav>
      </PageHeader>
      <ModuleTabs tabs={tabs} />
      <FileDemandesRh
        demandes={liste} filtre={filtreVu} referenceOrdreMission={reference} currentUserId={user.id}
        lienFiche={userCan(user, "EMPLOYEES", "VIEW")} maintenant={maintenant} demandeAOuvrir={demandeAOuvrir}
      />
      {peutTrancherConges && (
        <CongesATrancher
          leaves={congesRh} canManage={userCan(user, "HR_REQUESTS", "UPDATE")}
          maintenant={maintenant} currentUserId={user.id}
        />
      )}
    </div>
  );
}
