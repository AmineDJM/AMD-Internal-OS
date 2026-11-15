import Link from "next/link";
import { requireModule } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { derniersDepots, etatDesDonnees } from "@/modules/donnees-marche/api";
import { PageHeader } from "@/components/shared/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDate } from "@/lib/utils";

export const dynamic = "force-dynamic";
export const metadata = { title: "Données marché — AMD Internal OS" };

const NATURE: Record<string, string> = { NOMENCLATURE: "Nomenclature", IQVIA: "IQVIA (ville)" };

/**
 * LES DONNÉES MARCHÉ — déposer la nomenclature nationale et l'audit IQVIA. Le plus récent fait foi ; il alimente le
 * service Portefeuille DCI. Les réceptions hospitalières se déposent, elles, dans Ventes PCH › Importer.
 */
export default async function DonneesMarchePage(props: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requireModule("PRODUCT_EXPLORER");
  const sp = await props.searchParams;
  const peutDeposer = userCan(user, "PRODUCT_EXPLORER", "UPDATE");
  const [etat, depots] = await Promise.all([etatDesDonnees(), derniersDepots()]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Données marché"
        description="La nomenclature nationale et l'audit IQVIA, déposés tels que reçus. Le dépôt le plus récent fait foi et alimente le Portefeuille DCI. Les réceptions hospitalières se déposent dans Ventes PCH."
      >
        <Link href="/explorateur-produits"><Button variant="outline">Explorateur produits</Button></Link>
      </PageHeader>

      {sp.erreur && <p className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">{sp.erreur}</p>}
      {sp.ok && (
        <p className="rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm">
          {sp.deja === "1" ? "Ce fichier était déjà déposé : rien n'a changé." : `${NATURE[sp.ok] ?? sp.ok} déposée : ${sp.lignes} lignes.`}
        </p>
      )}

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader><CardTitle>Nomenclature</CardTitle></CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            {etat.nomenclature ? <>Au {etat.nomenclature.periode ?? "—"} · {etat.nomenclature.lignes} décisions · déposée le {formatDate(etat.nomenclature.depose)}</> : "Aucune nomenclature déposée."}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>IQVIA (ville)</CardTitle></CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            {etat.iqvia ? <>{etat.iqvia.periode ?? "—"} · {etat.iqvia.lignes} présentations · déposé le {formatDate(etat.iqvia.depose)}</> : "Aucun audit IQVIA déposé."}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Réceptions hôpital (PCH)</CardTitle></CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            {etat.receptions ? <>Dernier import le {formatDate(etat.receptions.depose)}</> : "Aucune réception importée."}{" "}
            <Link href="/sales/importer" className="text-primary hover:underline">Ventes PCH › Importer</Link>
          </CardContent>
        </Card>
      </div>

      {peutDeposer && (
        <Card>
          <CardHeader><CardTitle>Déposer un fichier</CardTitle></CardHeader>
          <CardContent>
            <form action="/api/donnees-marche/import" method="post" encType="multipart/form-data" className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <input type="file" name="fichier" accept=".xlsx,.xls" required className="text-sm" aria-label="Fichier Excel" />
              <Button type="submit">Déposer</Button>
              <span className="text-xs text-muted-foreground">Nomenclature ou IQVIA : la nature est reconnue à l&apos;en-tête du classeur.</span>
            </form>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader><CardTitle>Derniers dépôts</CardTitle></CardHeader>
        <CardContent>
          {depots.length === 0 ? <p className="text-sm text-muted-foreground">Aucun dépôt.</p> : (
            <Table className="min-w-[40rem]">
              <TableHeader><TableRow><TableHead>Nature</TableHead><TableHead>Fichier</TableHead><TableHead>Période</TableHead><TableHead>Lignes</TableHead><TableHead>Déposé le</TableHead></TableRow></TableHeader>
              <TableBody>
                {depots.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell>{NATURE[d.nature] ?? d.nature}</TableCell>
                    <TableCell className="[overflow-wrap:anywhere]">{d.nomFichier}</TableCell>
                    <TableCell>{d.periode ?? "—"}</TableCell>
                    <TableCell>{d.lignes}</TableCell>
                    <TableCell>{formatDate(d.createdAt.toISOString())}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
