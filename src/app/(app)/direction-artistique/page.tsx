import Link from "next/link";
import { ArrowUpRight, Building2 } from "lucide-react";
import { requireModule } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { peutGererDirectionArtistique } from "@/lib/direction-artistique/droits";
import { vueDirectionArtistique } from "@/lib/direction-artistique/serveur";
import { marqueDe, peutReglerMarque } from "@/platform/in-process/brand";
import { FormulaireMarque, FormulaireLogo } from "@/app/(app)/admin/marque/marque-client";
import { ModelesDePieces, PapeterieParType } from "./direction-artistique-client";

export const dynamic = "force-dynamic";
export const metadata = { title: "Direction artistique — AMD Internal OS" };

/**
 * LA DIRECTION ARTISTIQUE (Transverse, 10/2026) — la papeterie de CHAQUE entité, au même endroit,
 * tenue par l'assistante de direction : papiers en-tête Word, modèle de bon de commande (et de
 * devis, facture, avoir), modèles PowerPoint et Excel, logo et charte. Un onglet par entité
 * (`?entite=`), comme les coordonnées de l'entité.
 *
 * C'est ICI que la plateforme va chercher le modèle d'une pièce : la fabrique lit le modèle
 * désigné pour la nature (`settings.modelesParType`), puis le papier par défaut de l'entité
 * (`profilDocumentaire`, `lib/direction-artistique/modeles.ts`).
 *
 * Gestes : le module (VIEW/UPLOAD/UPDATE/DELETE), OU la responsabilité historique de la papeterie
 * (`canManageLetterheads`). Chaque dépôt est rattaché à l'entité ouverte, jamais à une autre.
 */
export default async function DirectionArtistiquePage({ searchParams }: { searchParams?: { entite?: string } }) {
  const user = await requireModule("ART_DIRECTION");
  const { entites, ouverte } = await vueDirectionArtistique(user, searchParams?.entite);

  if (!ouverte) {
    return (
      <div className="space-y-5">
        <PageHeader title="Direction artistique" />
        <EmptyState icon="Building2" title="Aucune entité dans votre périmètre" description="La papeterie appartient à une entité : sans entité, il n'y a rien à régler." />
      </div>
    );
  }

  const droits = {
    televerser: peutGererDirectionArtistique(user, "UPLOAD"),
    modifier: peutGererDirectionArtistique(user, "UPDATE"),
    supprimer: peutGererDirectionArtistique(user, "DELETE"),
  };
  const marque = await marqueDe(user, ouverte.id);
  const reglerMarque = peutReglerMarque(user);
  const voitCoordonnees = userCan(user, "LEGAL", "VIEW");

  const parKind = (kind: string) => ouverte.modeles.filter((m) => m.kind === kind);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Direction artistique"
        description="La papeterie de chaque entité : papier en-tête, modèles de pièces, PowerPoint, Excel, logo et charte. La plateforme va chercher ici le modèle d'un bon de commande, d'un devis ou d'une facture."
      />

      {/* Un onglet par entité — le lien porte `?entite=`, partageable et rechargeable. */}
      <nav className="flex flex-wrap gap-2" aria-label="Entités" data-testid="da-entites">
        {entites.map((e) => (
          <Link
            key={e.id}
            href={`/direction-artistique?entite=${e.id}`}
            aria-current={e.id === ouverte.id ? "page" : undefined}
            className={cn(
              "inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors",
              e.id === ouverte.id ? "border-primary bg-primary/10 font-medium text-foreground" : "border-border text-muted-foreground hover:bg-secondary hover:text-foreground",
            )}
          >
            <span className="inline-block h-2.5 w-2.5 rounded-full border" style={{ backgroundColor: e.color ?? undefined }} aria-hidden />
            {e.label}
          </Link>
        ))}
      </nav>

      {!droits.modifier && !droits.televerser && (
        <p className="text-sm text-muted-foreground" data-testid="da-lecture-seule">
          Vous lisez la papeterie de l&apos;entité ; elle se règle par l&apos;assistante de direction (ou qui tient ce module).
        </p>
      )}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card className="xl:col-span-2" data-testid="da-papier">
          <CardHeader><CardTitle className="text-base">Papier en-tête (Word)</CardTitle></CardHeader>
          <CardContent>
            <PapeterieParType
              companyId={ouverte.id} kind="word" modeles={parKind("word")} papierParDefautId={ouverte.papierParDefautId}
              droits={droits}
              aide="Le document d'en-tête tel qu'il s'imprime — marges, logo, pied de page, mentions légales. Le papier « par défaut » habille toute pièce de l'entité qui n'a pas de modèle dédié."
            />
          </CardContent>
        </Card>

        <Card className="xl:col-span-2" data-testid="da-modeles-pieces">
          <CardHeader><CardTitle className="text-base">Modèle de bon de commande, devis, facture</CardTitle></CardHeader>
          <CardContent>
            <ModelesDePieces
              companyId={ouverte.id}
              papiers={parKind("word").filter((m) => m.isActive).map((m) => ({ id: m.id, name: m.name, commun: m.companyId === null }))}
              modelesParType={ouverte.modelesParType}
              papierParDefautId={ouverte.papierParDefautId}
              droits={droits}
            />
          </CardContent>
        </Card>

        <Card data-testid="da-slides">
          <CardHeader><CardTitle className="text-base">Modèles PowerPoint</CardTitle></CardHeader>
          <CardContent>
            <PapeterieParType companyId={ouverte.id} kind="slide" modeles={parKind("slide")} droits={droits}
              aide="Proposés à la création d'une présentation depuis le Drive." />
          </CardContent>
        </Card>

        <Card data-testid="da-excel">
          <CardHeader><CardTitle className="text-base">Modèles Excel</CardTitle></CardHeader>
          <CardContent>
            <PapeterieParType companyId={ouverte.id} kind="cell" modeles={parKind("cell")} droits={droits}
              aide="Proposés à la création d'un classeur depuis le Drive." />
          </CardContent>
        </Card>

        <Card className="xl:col-span-2" data-testid="da-marque">
          <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-base">Logo &amp; charte</CardTitle>
            {marque.ok && (
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge tone="neutral">accent #{marque.lue.charte.accent}</Badge>
                <Badge tone={marque.lue.marque.logo ? "info" : "warning"}>{marque.lue.marque.logo ? "logo déposé" : "sans logo"}</Badge>
              </div>
            )}
          </CardHeader>
          <CardContent className="space-y-4">
            {!marque.ok ? (
              <p className="text-sm text-muted-foreground">{marque.motif}</p>
            ) : (
              <>
                <p className="text-sm text-muted-foreground">{marque.lue.resume}</p>
                {reglerMarque && (
                  <>
                    <FormulaireLogo companyId={ouverte.id} logo={marque.lue.marque.logo ? { nom: marque.lue.marque.logo.nom, taille: marque.lue.marque.logo.taille, largeurCm: marque.lue.marque.logo.largeurCm } : null} />
                    <FormulaireMarque companyId={ouverte.id} marque={marque.lue.marque} />
                  </>
                )}
              </>
            )}
          </CardContent>
        </Card>

        <Card className="xl:col-span-2" data-testid="da-coordonnees">
          <CardContent className="flex flex-wrap items-center gap-3 p-4">
            <Building2 className="h-5 w-5 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">Coordonnées de l&apos;entité</p>
              <p className="text-xs text-muted-foreground">RC, NIF, NIS, siège, banque : la carte d&apos;identité légale que portent les pièces.</p>
            </div>
            {voitCoordonnees ? (
              <Link href={`/legal/identites?entite=${ouverte.id}`} className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
                Ouvrir <ArrowUpRight className="h-4 w-4" />
              </Link>
            ) : (
              <span className="text-xs text-muted-foreground">Tenues dans Legal › Coordonnées (accès Legal requis).</span>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
