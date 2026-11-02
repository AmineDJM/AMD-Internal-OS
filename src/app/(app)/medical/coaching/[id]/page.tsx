import Link from "next/link";
import { notFound } from "next/navigation";
import { Download, Pencil, Printer } from "lucide-react";
import { requireModule } from "@/lib/session";
import { PageHeader } from "@/components/shared/page-header";
import { BackLink } from "@/components/shared/back-link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { InfoBulle } from "@/components/ui/info-bulle";
import { FicheCoachingForm } from "@/components/coaching/fiche-form";
import { FicheActions } from "@/components/coaching/fiche-actions";
import { EntreeMenu, MenuPlus } from "../../menu-plus";
import { BilanLecture, EchelleNiveaux, GrilleEvaluation, TotalFiche } from "@/components/coaching/fiche-grille";
import { collaborateursCoachables, lecteurCoaching, managersPossibles } from "@/lib/coaching/serveur";
import { chargerFicheVisible } from "@/lib/coaching/fiches";
import { formaterJour, jourAlger, jourDe } from "@/lib/coaching/dates";

export const dynamic = "force-dynamic";
export const metadata = { title: "Fiche de coaching — AMD Internal OS" };

/**
 * UNE FICHE DE COACHING (§118.157) — consultation, et modification (`?modifier=1`) quand la règle
 * le permet. Une fiche que la personne ne peut pas lire rend la même page qu'une fiche
 * inexistante : dire « elle existe mais vous n'y avez pas accès » apprendrait à un collègue
 * qu'une évaluation a été écrite sur quelqu'un.
 */
export default async function FicheCoachingPage(
  props: { params: Promise<{ id: string }>; searchParams?: Promise<{ modifier?: string }> }
) {
  const searchParams = await props.searchParams;
  const params = await props.params;
  const user = await requireModule("MEDICAL");
  const l = await lecteurCoaching(user);
  const fiche = await chargerFicheVisible(l, params.id);
  if (!fiche) notFound();
  const finalisee = fiche.status === "FINALIZED";
  const modifiable = fiche.gestes.modifier && !!fiche.grille;

  if (searchParams?.modifier === "1" && fiche.gestes.modifier && fiche.grille) {
    const [coachables, managers] = await Promise.all([
      collaborateursCoachables(l),
      l.administre ? managersPossibles([user.id, ...(fiche.managerId ? [fiche.managerId] : [])]) : Promise.resolve(null),
    ]);
    // Le collaborateur de la fiche reste proposé même s'il a quitté le périmètre : on corrige
    // une fiche sur la personne qu'elle évalue, pas sur celles qu'on coache aujourd'hui.
    const collaborateurs = coachables.some((c) => c.id === fiche.collaboratorId)
      ? coachables
      : [{ id: fiche.collaboratorId, nom: fiche.collaborateur, secteur: fiche.sector ?? "" }, ...coachables];
    return (
      <div className="mx-auto max-w-6xl space-y-5">
        <BackLink href={`/medical/coaching/${fiche.id}`} className="inline-flex items-center gap-1 text-sm text-primary hover:underline">← Retour à la fiche</BackLink>
        <PageHeader
          title={`Modifier — ${fiche.collaborateur}`}
          description={finalisee ? "Fiche finalisée — le collaborateur sera prévenu" : "Brouillon"}
        />
        <FicheCoachingForm
          mode="modification"
          ficheId={fiche.id}
          grille={fiche.grille}
          gridVersion={fiche.gridVersion}
          collaborateurs={collaborateurs}
          managers={managers}
          valeurs={{
            collaboratorId: fiche.collaboratorId,
            managerId: fiche.managerId ?? user.id,
            visitDate: jourDe(fiche.visitDate),
            sector: fiche.sector ?? "",
            notes: fiche.notes,
            strengths: fiche.strengths ?? "",
            improvements: fiche.improvements ?? "",
          }}
          finalisee={finalisee}
          peutFinaliser={fiche.gestes.finaliser}
          aujourdHui={jourAlger()}
          nomManagerParDefaut={fiche.manager ?? user.name}
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <BackLink href="/medical/coaching" className="inline-flex items-center gap-1 text-sm text-primary hover:underline">← Coaching</BackLink>
      <PageHeader
        title={`Fiche de coaching — ${fiche.collaborateur}`}
        description={`Tournée en double du ${formaterJour(fiche.visitDate)}${fiche.manager ? ` avec ${fiche.manager}` : ""}${fiche.sector ? ` · ${fiche.sector}` : ""}`}
      >
        {/* UN GESTE PRINCIPAL : finaliser quand la règle le permet, sinon modifier. Le reste dans « ⋯ »
            (Direction, 07/10). Le menu reste ouvert au clic : « Retirer » y montre son erreur s'il échoue. */}
        {fiche.gestes.finaliser ? (
          <FicheActions
            id={fiche.id}
            collaborateur={fiche.collaborateur}
            finaliser
            supprimer={false}
            finalisee={finalisee}
            complete={fiche.complet}
          />
        ) : modifiable && (
          <Link href={`/medical/coaching/${fiche.id}?modifier=1`}>
            <Button size="sm" className="h-10 sm:h-8"><Pencil className="h-4 w-4" /> Modifier</Button>
          </Link>
        )}
        <MenuPlus label="Autres actions sur la fiche" fermerAuClic={false}>
          {fiche.gestes.finaliser && modifiable && (
            <EntreeMenu href={`/medical/coaching/${fiche.id}?modifier=1`}>
              <Pencil className="h-4 w-4" /> Modifier
            </EntreeMenu>
          )}
          <EntreeMenu href={`/api/medical/coaching/${fiche.id}/export`} brut>
            <Download className="h-4 w-4" /> Télécharger (Excel)
          </EntreeMenu>
          <EntreeMenu href={`/impression/coaching/${fiche.id}?auto=1`} brut nouvelOnglet>
            <Printer className="h-4 w-4" /> Imprimer / PDF
          </EntreeMenu>
          {fiche.gestes.supprimer && (
            <FicheActions
              id={fiche.id}
              collaborateur={fiche.collaborateur}
              finaliser={false}
              supprimer
              finalisee={finalisee}
              complete={fiche.complet}
              dansUnMenu
            />
          )}
        </MenuPlus>
      </PageHeader>

      {/* L'ÉTAT EN UNE PHRASE « état — chez qui » ; la version de grille et l'auteur de la saisie derrière le ⓘ. */}
      <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
        <Badge tone={finalisee ? "success" : "warning"}>
          {finalisee
            ? `Finalisée${fiche.finalizedAt ? ` le ${fiche.finalizedAt.toLocaleDateString("fr-FR", { timeZone: "Africa/Algiers" })}` : ""}${fiche.finalisePar ? ` par ${fiche.finalisePar}` : ""}`
            : `Brouillon — chez ${fiche.manager ?? "le manager"}`}
        </Badge>
        <InfoBulle label="Détails de la fiche" align="left">
          Grille version {fiche.gridVersion}{fiche.creePar ? ` · saisie par ${fiche.creePar}` : ""}.
        </InfoBulle>
      </div>

      {fiche.grille ? (
        <>
          <EchelleNiveaux grille={fiche.grille} />
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_18rem]">
            <GrilleEvaluation grille={fiche.grille} notes={fiche.notes} nomGroupe={fiche.id} />
            <aside className="lg:sticky lg:top-4 lg:self-start">
              <TotalFiche grille={fiche.grille} notes={fiche.notes} />
            </aside>
          </div>
          <BilanLecture grille={fiche.grille} strengths={fiche.strengths} improvements={fiche.improvements} />
        </>
      ) : (
        <p className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          Grille de cette fiche illisible — notes non affichables.
        </p>
      )}
    </div>
  );
}
