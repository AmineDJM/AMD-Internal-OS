import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { REPRISES } from "@/lib/referentiels/reprises";
import { lireJournal } from "@/lib/referentiels/reprises/journal";
import { doubleEcritureOrganisationsOuverte } from "@/lib/referentiels/organisations/double-ecriture";
import { PageHeader } from "@/components/shared/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { GestesReprise, InterrupteurDoubleEcriture } from "./cartes";
import { etatFile } from "@/lib/enrichissement/lectures";
import { PanneauEnrichissement } from "./panneau-enrichissement";
import { InterrupteurDoubleEcriturePersonnes } from "./interrupteur-double-ecriture";

export const dynamic = "force-dynamic";
export const metadata = { title: "Refonte des données — Administration" };

const dateFr = (d: Date) => new Intl.DateTimeFormat("fr-FR", {
  day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Africa/Algiers",
}).format(d);

/**
 * ADMINISTRATION › REFONTE DES DONNÉES (vague 2, `docs/architecture/refonte-vague-2.md`) — Super Admin SEUL.
 *
 * Une carte par reprise : ce qu'elle fait, l'aperçu à blanc, l'exécution par lots, et son journal (les lignes
 * d'audit de ses lots). Rien ne tourne au déploiement : c'est ici, et seulement ici, qu'une reprise s'exécute.
 */
export default async function RefonteDonneesPage() {
  const user = await requireUser();
  if (user.role !== "SUPER_ADMIN") redirect("/dashboard?denied=ADMIN");
  const [journaux, doubleEcriture, doublonsEnAttente, etat, reglages, personnes, doublonsPersonnes] = await Promise.all([
    Promise.all(REPRISES.map((r) => lireJournal(r.cle))),
    doubleEcritureOrganisationsOuverte(),
    prisma.propositionDoublonOrganisation.count({
      where: { statut: "PROPOSEE", organisationA: { fusionneeDansId: null }, organisationB: { fusionneeDansId: null } },
    }),
    etatFile(),
    prisma.appSetting.findUnique({ where: { id: "global" }, select: { refontePersonnesDoubleEcriture: true } }),
    prisma.personne.count({ where: { fusionneeDansId: null } }),
    prisma.doublonPersonne.count({ where: { statut: "PROPOSE" } }),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Refonte des données"
        description="Remplir les référentiels depuis les fiches existantes : aperçu à blanc d'abord, puis exécution par lots. Rejouer une reprise ne refait rien de ce qui est fait ; les doublons sont proposés, jamais fusionnés d'office."
      >
        <Link href="/admin" className="text-sm text-muted-foreground hover:underline"><ArrowLeft className="mr-1 inline h-4 w-4" />Administration</Link>
      </PageHeader>

      <PanneauEnrichissement etat={etat} />

      <Card>
        <CardHeader><CardTitle>Personnes — double écriture et doublons</CardTitle></CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p>
            {personnes} Personne(s) ·{" "}
            <Link href="/personnes/doublons" className="font-medium text-primary hover:underline">{doublonsPersonnes} doublon(s) à trancher</Link>
          </p>
          <InterrupteurDoubleEcriturePersonnes actif={reglages?.refontePersonnesDoubleEcriture === true} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Organisations — double écriture et doublons</CardTitle></CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p>
            Double écriture{" "}
            <Badge tone={doubleEcriture ? "success" : "neutral"}>{doubleEcriture ? "ouverte" : "fermée"}</Badge>{" "}
            — ouverte, la création d&apos;un fournisseur, d&apos;un partenaire ou d&apos;un établissement crée aussi son
            organisation. Un échec n&apos;empêche jamais la création : la reprise rattrape.
          </p>
          <InterrupteurDoubleEcriture ouvert={doubleEcriture} />
          <p>
            <Link href="/admin/refonte-donnees/organisations" className="font-medium text-primary hover:underline" data-testid="refonte-lien-doublons">
              Doublons d&apos;organisations à trancher : {doublonsEnAttente}
            </Link>
          </p>
        </CardContent>
      </Card>

      {REPRISES.map((r, i) => {
        const journal = journaux[i];
        return (
          <Card key={r.cle} data-testid={`refonte-carte-${r.cle}`}>
            <CardHeader><CardTitle>{r.titre}</CardTitle></CardHeader>
            <CardContent className="space-y-4 text-sm">
              <p className="text-muted-foreground">{r.description}</p>
              <GestesReprise cle={r.cle} suiteInitiale={journal[0]?.suite ?? null} />
              <div>
                <div className="mb-1 text-xs font-medium uppercase text-muted-foreground">Journal</div>
                {journal.length === 0 ? (
                  <p className="text-xs text-muted-foreground">Jamais exécutée.</p>
                ) : (
                  <ul className="space-y-1 text-xs">
                    {journal.map((e, j) => (
                      <li key={j}><span className="text-muted-foreground">{dateFr(e.le)}{e.par ? ` · ${e.par}` : ""} —</span> {e.resume}</li>
                    ))}
                  </ul>
                )}
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
