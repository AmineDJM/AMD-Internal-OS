import { requireModule } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { anyRoleFilter } from "@/lib/rbac";
import { PageHeader } from "@/components/shared/page-header";
import { listerCampagnes, vueCampagnePour, entreeDroits } from "@/lib/budget-campagne/requetes";
import { droitsCampagne } from "@/lib/budget-campagne/regles";
import { VueDirection } from "./vue-direction";
import { VuePole } from "./vue-pole";
import { ReglagesCampagne } from "./reglages";

export const metadata = { title: "Campagne budgétaire — AMD Internal OS" };
export const dynamic = "force-dynamic";

/**
 * LA CAMPAGNE BUDGÉTAIRE (Budgets 2027, Direction 10/2026 — maquette validée). Une page, trois vues :
 *   • la Direction (pilote, valideurs, Finances) : frise, tuiles, propositions par pôle, examen ligne par ligne ;
 *   • un pôle (son responsable) : ses lignes, le pré-remplissage, la soumission — SANS le cadrage, filtré côté serveur ;
 *   • les réglages (`?vue=reglages`) : dates, cadrage privé, valideurs, seuil, rectificatif.
 * `?campagne=` choisit la campagne (la plus récente sinon), `?pole=` ouvre la préparation d'un pôle, `?examen=` ouvre le
 * panneau d'examen d'une proposition — les liens des notifications (`chemins/budget-campagne.ts`).
 */
export default async function CampagneBudgetairePage(
  props: { searchParams: Promise<{ campagne?: string; pole?: string; examen?: string; vue?: string }> }
) {
  const searchParams = await props.searchParams;
  const user = await requireModule("BUDGET_CAMPAIGN");
  const campagnes = await listerCampagnes();
  // Le lien d'une notification nomme la PROPOSITION : on en retrouve la campagne.
  const viaProposition = searchParams.pole ?? searchParams.examen;
  const campagneDuLien = viaProposition
    ? (await prisma.budgetProposal.findUnique({ where: { id: viaProposition }, select: { campaignId: true } }))?.campaignId
    : null;
  const campaignId = searchParams.campagne ?? campagneDuLien ?? campagnes[0]?.id ?? null;
  const reglages = searchParams.vue === "reglages" || searchParams.vue === "nouvelle";

  const [departements, valideursPossibles] = await Promise.all([
    prisma.department.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.user.findMany({ where: { isActive: true, ...anyRoleFilter(["SUPER_ADMIN", "GENERAL_MANAGER", "DIRECTION", "FINANCE_BUDGET_MANAGER"]) }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);

  if (!campaignId || searchParams.vue === "nouvelle") {
    const e = await entreeDroits(user, []);
    const d = droitsCampagne(e);
    return (
      <div className="space-y-5">
        <PageHeader title="Campagne budgétaire" description={campagnes.length ? undefined : "Aucune campagne pour l'instant."} />
        {d.peutPiloter ? (
          <ReglagesCampagne mode="creation" campagne={null} departements={departements} valideursPossibles={valideursPossibles}
            voitLeCadrage={d.voitLeCadrage || user.role === "GENERAL_MANAGER" || user.secondaryRole === "GENERAL_MANAGER"} estSuperAdmin={user.role === "SUPER_ADMIN"} campagnes={campagnes} />
        ) : (
          <p className="surface p-6 text-center text-sm text-muted-foreground">La Direction n&apos;a pas encore ouvert de campagne.</p>
        )}
      </div>
    );
  }

  // LA DIRECTION QUI OUVRE LA PRÉPARATION D'UN PÔLE la voit comme le pôle — sans cadrage.
  const vue = await vueCampagnePour(user, campaignId, Boolean(searchParams.pole));
  if (vue.kind === "aucune") return <p className="surface p-6 text-center text-sm text-muted-foreground">Campagne introuvable.</p>;
  if (vue.kind === "interdit") return <p className="surface p-6 text-center text-sm text-muted-foreground">Aucun pôle de cette campagne ne vous est confié.</p>;

  if (vue.kind === "direction") {
    if (reglages && vue.droits.peutPiloter) {
      return (
        <div className="space-y-5">
          <PageHeader title={`Réglages — ${vue.campagne.title}`} />
          <ReglagesCampagne mode="edition" campagne={vue.campagne} departements={departements} valideursPossibles={valideursPossibles}
            voitLeCadrage={vue.droits.voitLeCadrage} estSuperAdmin={user.role === "SUPER_ADMIN"} campagnes={campagnes}
            poles={vue.propositions.map((p) => ({ id: p.id, pole: p.pole, domaine: p.domaine, cadrage: p.cadrage ?? null, version: p.version }))} />
        </div>
      );
    }
    return <VueDirection campagne={vue.campagne} propositions={vue.propositions} droits={vue.droits} campagnes={campagnes} examenId={searchParams.examen ?? null} />;
  }

  const choisie = searchParams.pole ? vue.propositions.find((p) => p.id === searchParams.pole) : vue.propositions[0];
  return (
    <VuePole campagne={vue.campagne} propositions={vue.propositions} propositionId={choisie?.id ?? null}
      retourDirection={vue.droits.voitVueDG} />
  );
}
