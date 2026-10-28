import { requireModule } from "@/lib/session";
import { PageHeader } from "@/components/shared/page-header";
import { BackLink } from "@/components/shared/back-link";
import { EmptyState } from "@/components/shared/empty-state";
import { FicheCoachingForm } from "@/components/coaching/fiche-form";
import { collaborateursCoachables, grilleCourante, lecteurCoaching, managersPossibles } from "@/lib/coaching/serveur";
import { jourAlger } from "@/lib/coaching/dates";

export const dynamic = "force-dynamic";
export const metadata = { title: "Nouvelle fiche de coaching — AMD Internal OS" };

/**
 * NOUVELLE FICHE DE COACHING (§118.157) — sur la grille en vigueur. Le collaborateur peut être
 * pré-choisi par l'adresse (`?collaborateur=<id>`), depuis le suivi de l'équipe.
 */
export default async function NouvelleFicheCoachingPage(props: { searchParams?: Promise<{ collaborateur?: string }> }) {
  const searchParams = await props.searchParams;
  const user = await requireModule("MEDICAL");
  const l = await lecteurCoaching(user);
  const [courante, collaborateurs, managers] = await Promise.all([
    grilleCourante(),
    collaborateursCoachables(l),
    l.administre ? managersPossibles([user.id]) : Promise.resolve(null),
  ]);
  const preselection = collaborateurs.find((c) => c.id === searchParams?.collaborateur) ?? null;

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <BackLink href="/medical/coaching" className="inline-flex items-center gap-1 text-sm text-primary hover:underline">← Coaching</BackLink>
      <PageHeader title={courante.grille.titre} description="Nouvelle fiche" />
      {collaborateurs.length === 0 ? (
        <EmptyState icon="Users" title="Aucun collaborateur à coacher" description="Vous coachez les KAM des Business Units que vous supervisez." />
      ) : (
        <FicheCoachingForm
          mode="creation"
          grille={courante.grille}
          gridVersion={courante.version}
          collaborateurs={collaborateurs}
          managers={managers}
          valeurs={{
            collaboratorId: preselection?.id ?? "",
            managerId: user.id,
            visitDate: jourAlger(),
            sector: preselection?.secteur ?? "",
            notes: {},
            strengths: "",
            improvements: "",
          }}
          finalisee={false}
          peutFinaliser
          aujourdHui={jourAlger()}
          nomManagerParDefaut={user.name}
        />
      )}
    </div>
  );
}
