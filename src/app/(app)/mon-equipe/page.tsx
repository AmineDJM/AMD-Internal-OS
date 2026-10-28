import Link from "next/link";
import { UserPlus } from "lucide-react";
import { requireModule } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { getMyTeam } from "@/lib/queries/my-team";
import { getMyTeamOverview } from "@/lib/queries/my-team-overview";
import { chargerTableauKpi } from "@/lib/kpi/service";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { EquipeEcran, type VueMonEquipe } from "./equipe-ecran";

export const dynamic = "force-dynamic";
export const metadata = { title: "Mon Équipe — AMD Internal OS" };

/**
 * MON ÉQUIPE — l'écran de celui qui ENCADRE.
 *
 * ── CE QU'IL EST, ET CE QU'IL N'EST PAS ─────────────────────────────────────────────────────
 *
 * Ce n'est pas un mini-module RH : un encadrant n'administre pas les fiches, ne touche pas aux
 * salaires et n'ouvre pas les dossiers. Cela reste aux ressources humaines, et le recopier ici
 * ouvrirait une seconde porte sur des données qu'on a cloisonnées exprès.
 *
 * C'est l'écran de trois questions : **qui est dans mon équipe**, **qu'est-ce qui m'attend**
 * (congés, achats, formations, plans de tournée, marches de recrutement — ce qui dort chez moi et
 * bloque quelqu'un), et **qui est là** — au jour d'Alger, avec les jours où deux personnes d'une
 * même équipe manquent ensemble (§118.196, lot E3).
 *
 * ── TROIS VUES, UN PANNEAU (maquette validée, Direction 07/10) ──────────────────────────────
 *
 *  · « Vue d'ensemble » — seulement ce qui appelle un geste : quatre tuiles, la file « À décider »
 *    (la plus ancienne en tête, le congé se décide sur place), « À surveiller », la semaine ;
 *  · « L'équipe » — un tableau, une ligne par personne, dans l'ordre de l'arbre ;
 *  · « Calendrier » — le mois, une ligne par personne, une colonne par jour.
 * Un clic sur une personne, où qu'elle soit, ouvre son panneau sur le côté.
 *
 * ── L'ÉQUIPE SE DÉDUIT, ET ELLE DESCEND JUSQU'EN BAS ────────────────────────────────────────
 *
 * Personne ne « déclare » son équipe : elle est l'ensemble des gens dont la cascade
 * hiérarchique dit que je suis le N+1 — la MÊME fonction qui route leurs demandes vers moi
 * (`getMyTeam`). Tout l'arbre est montré ; **ce qui attend ma décision, lui, suit son circuit** :
 * un congé, un achat, une formation d'un N-2 sont routés vers SON N+1.
 *
 * Le RECRUTEMENT n'est plus ici : c'est un module à part sous « Ressources humaines » (Direction, 07/10).
 */
export default async function MonEquipePage(
  props: { searchParams?: Promise<{ vue?: string; mois?: string; periode?: string }> }
) {
  const searchParams = await props.searchParams;
  const user = await requireModule("MY_TEAM");
  const team = await getMyTeam(user);
  const { selfEmployeeId, members, directCount, pending, chevauchements, chevauchementsNonMontres } = team;

  if (!selfEmployeeId) {
    return (
      <div className="space-y-5">
        <PageHeader title="Mon équipe" />
        <EmptyState
          icon="UserSearch"
          title="Aucune fiche employé n'est rattachée à votre compte"
          description="Votre équipe se déduit de l'organigramme : demandez aux ressources humaines de rattacher votre fiche."
        />
      </div>
    );
  }

  const apercu = await getMyTeamOverview(user, team, { mois: searchParams?.mois ?? null });
  // L'onglet KPI (KPI sans code, Direction 08/10) : à qui a le module « KPI & bilans » ; le tableau n'est lu que sur lui.
  const ongletKpi = userCan(user, "KPI", "VIEW");
  const vue: VueMonEquipe = searchParams?.vue === "equipe" || searchParams?.vue === "calendrier" || (searchParams?.vue === "kpi" && ongletKpi) ? searchParams.vue : "ensemble";
  const kpi = vue === "kpi" ? await chargerTableauKpi(user, searchParams?.periode ?? null) : null;

  // « N personnes · X en direct, Y via Untel » — ceux de mes N-1 qui encadrent à leur tour.
  const indirects = members.length - directCount;
  const relais = members.filter((m) => m.depth === 1 && members.some((c) => c.managerEmployeeId === m.employeeId)).map((m) => m.fullName);
  const sousTitre = members.length === 0
    ? undefined
    : `${members.length} personne${members.length > 1 ? "s" : ""} · ${directCount} en direct`
      + (indirects > 0 ? `, ${indirects} via ${relais.slice(0, 2).join(", ")}${relais.length > 2 ? ` et ${relais.length - 2} autre(s)` : ""}` : "");
  // L'ÂGE DE LA PLUS ANCIENNE DÉCISION EN ATTENTE — la file est déjà triée, la plus ancienne en tête.
  const plusAncienJours = pending.length > 0 ? Math.max(0, Math.floor((Date.now() - new Date(pending[0].createdAt).getTime()) / 86_400_000)) : null;

  return (
    <div className="space-y-5">
      <PageHeader title="Mon équipe" description={sousTitre}>
        {apercu.droits.recrutement && (
          <Link
            href="/recrutement"
            className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-secondary sm:min-h-0"
          >
            <UserPlus className="h-4 w-4" /> Demander un recrutement
          </Link>
        )}
      </PageHeader>

      {members.length === 0 ? (
        <EmptyState
          icon="Users"
          title="Personne ne vous est rattaché"
          description="Aucun employé n'a votre fiche pour N+1. Si cela vous surprend, c'est l'organigramme qu'il faut corriger : c'est lui qui route aussi les demandes."
        />
      ) : (
        <EquipeEcran
          vue={vue}
          apercu={apercu}
          pending={pending}
          plusAncienJours={plusAncienJours}
          chevauchements={chevauchements}
          chevauchementsNonMontres={chevauchementsNonMontres}
          kpi={kpi}
          ongletKpi={ongletKpi}
        />
      )}
    </div>
  );
}
