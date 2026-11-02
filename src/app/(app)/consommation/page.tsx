import Link from "next/link";
import { requireModule } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { PageHeader } from "@/components/shared/page-header";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { listerImports } from "@/modules/consommation/api";
import { TeleverserConsommation } from "@/modules/consommation/ecrans/televerser";

export const dynamic = "force-dynamic";
export const metadata = { title: "Consumption Intelligence — AMD Internal OS" };

const STATUT: Record<string, { label: string; tone: "warning" | "success" | "neutral" }> = {
  EN_REVUE: { label: "En revue", tone: "warning" }, VALIDE: { label: "Validé", tone: "success" }, ANNULE: { label: "Annulé", tone: "neutral" },
};

/**
 * CONSUMPTION INTELLIGENCE — les fichiers de consommation hospitalière, quels qu'en soient les colonnes, l'ordre, les
 * feuilles, les unités : importés, lus, rapprochés de l'annuaire et du référentiel produits, dédoublonnés, revus, puis
 * VALIDÉS. Seules les lignes d'un import validé comptent, et chacune remonte à sa cellule d'origine.
 */
export default async function ConsommationPage() {
  const user = await requireModule("CONSUMPTION");
  const peutImporter = userCan(user, "CONSUMPTION", "UPLOAD");
  const imports = await listerImports();
  return (
    <div className="space-y-5">
      <PageHeader title="Consumption Intelligence" description="Les fichiers de consommation des établissements, rendus fiables et traçables — et l'affinité qu'on en tire.">
        <Link href="/consommation/affinite" className="text-sm text-primary underline">Affinité par établissement</Link>
      </PageHeader>
      {/* LE MODE D'EMPLOI (Direction, 06/10 : « qu'est-ce que tu attends de moi exactement, quel fichier uploader ? »). */}
      <details className="surface p-3 text-sm sm:p-4" open={imports.length === 0}>
        <summary className="cursor-pointer py-1 font-semibold">Ce qu&apos;il faut importer, et dans quel ordre</summary>
        <div className="mt-3 space-y-2 text-muted-foreground">
          <p><b className="text-foreground">Quoi :</b> les fichiers de consommation des établissements, tels que les pharmacies hospitalières, la PCH ou les DSP les envoient. Ce sont les sorties de médicaments par établissement, par produit (ou molécule) et par période.</p>
          <p><b className="text-foreground">Format :</b> Excel (.xlsx, .xls, .xlsm) ou CSV, avec une ou plusieurs feuilles. Les colonnes n&apos;ont pas besoin d&apos;avoir nos noms :</p>
          <ul className="list-disc pl-5">
            <li><b className="text-foreground">Établissement</b> : une colonne, ou une feuille par hôpital (le nom de la feuille sert alors d&apos;établissement).</li>
            <li><b className="text-foreground">Produit et/ou DCI</b> : la désignation, la molécule, ou les deux.</li>
            <li><b className="text-foreground">Quantité</b> et <b className="text-foreground">période</b> : une colonne « Mois » ou « Date », ou bien une colonne par mois (janv-26, févr-26…). La période peut aussi être écrite dans le titre ou le nom de la feuille.</li>
            <li>Conseillées : l&apos;<b className="text-foreground">unité</b> (boîte, comprimé…) et la <b className="text-foreground">présentation</b> (« B/30 », qui permet de convertir les boîtes en unités). La valeur en DA est facultative.</li>
          </ul>
          <p><b className="text-foreground">Important :</b> gardez dans le fichier les <b className="text-foreground">produits concurrents</b> (les autres molécules du même marché). Sans eux, l&apos;affinité n&apos;a pas de dénominateur.</p>
          <p><b className="text-foreground">Ensuite :</b></p>
          <ol className="list-decimal pl-5">
            <li>Importez le fichier.</li>
            <li>Tranchez ce qui n&apos;est pas sûr (établissement ou produit inconnu) : chaque choix est retenu pour les fichiers suivants.</li>
            <li>Validez l&apos;import.</li>
            <li>Dans « Affinité par établissement », choisissez pour chaque produit son marché (les molécules concurrentes) et la période.</li>
            <li>Dans Segmentation › Règles, choisissez « proxy établissement » comme source d&apos;affinité si vous voulez l&apos;utiliser pour classer les médecins.</li>
          </ol>
          <p><a href="/api/consommation/modele" className="text-primary underline">Télécharger un fichier modèle</a> (un exemple seulement : vos fichiers n&apos;ont pas à le suivre).</p>
        </div>
      </details>
      {peutImporter && <TeleverserConsommation />}
      {/* Une ligne = un fichier importé : une carte au téléphone. */}
      <div className="surface">
        <Table>
          <TableHeader className="bg-transparent">
            <TableRow><TableHead>Fichier</TableHead><TableHead>Statut</TableHead><TableHead>Lignes</TableHead><TableHead>Sûres</TableHead><TableHead>À revoir</TableHead><TableHead>Doublons</TableHead><TableHead>Importé le</TableHead></TableRow>
          </TableHeader>
          <TableBody>
            {imports.length === 0 && <TableRow><TableCell colSpan={7} data-sans-etiquette className="!justify-start py-4 text-muted-foreground sm:py-4">Aucun fichier importé.</TableCell></TableRow>}
            {imports.map((i) => (
              <TableRow key={i.id} className="border-border/60">
                <TableCell data-sans-etiquette className="!justify-start sm:py-2"><Link href={`/consommation/${i.id}`} className="min-w-0 py-1 font-medium text-primary [overflow-wrap:anywhere] hover:underline">{i.nomFichier}</Link></TableCell>
                <TableCell className="sm:py-2"><Badge tone={STATUT[i.statut]?.tone ?? "neutral"}>{STATUT[i.statut]?.label ?? i.statut}</Badge></TableCell>
                <TableCell className="sm:py-2">{i._count.lignes}</TableCell>
                <TableCell className="sm:py-2">{i.sures}</TableCell>
                <TableCell className="sm:py-2">{i.aRevoir}</TableCell>
                <TableCell className="sm:py-2">{i.doublons}</TableCell>
                <TableCell className="sm:py-2">{i.createdAt.toLocaleDateString("fr-FR")}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
