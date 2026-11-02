import { requireUser } from "@/lib/session";
import { faitsAConfirmer, type LigneAConfirmer } from "@/lib/enrichissement/lectures";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { GestesFait } from "./gestes-fait";

export const dynamic = "force-dynamic";
export const metadata = { title: "À confirmer — faits lus sur les pièces" };

/**
 * « À CONFIRMER » (refonte, lot V2-A) — les faits que les pièces déposées proposent aux fiches et que le
 * moteur n'a pas confirmés d'office, et les conflits avec ce que la fiche tient déjà. Chacun voit ceux des
 * pièces qu'il a déposées ; le Super Admin voit tout. Confirmer écrit la fiche (historique gardé), rejeter
 * ne l'écrit pas, un conflit se tranche — jamais d'écrasement silencieux. Aucune donnée sensible ici :
 * elles sont au coffre.
 */
const pourcent = (c: number) => `${Math.round(c * 100)} %`;

function Lignes({ lignes, gestes }: { lignes: LigneAConfirmer[]; gestes: boolean }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Fiche</TableHead><TableHead>Attribut</TableHead><TableHead>Valeur lue</TableHead>
          <TableHead>Pièce</TableHead><TableHead>Pourquoi</TableHead>{gestes && <TableHead />}
        </TableRow>
      </TableHeader>
      <TableBody>
        {lignes.map((l) => (
          <TableRow key={l.id} data-testid="fait-a-confirmer">
            <TableCell>{l.sujet.libelle}<div className="text-xs text-muted-foreground">{l.sujet.type === "PERSONNE" ? "Personne" : l.sujet.type === "ORGANISATION" ? "Organisation" : "Produit"}</div></TableCell>
            <TableCell>{l.libelle}</TableCell>
            <TableCell>
              <strong>{l.valeur ?? "—"}</strong> <Badge tone="neutral">{pourcent(l.confiance)}</Badge>
              {l.conflit && <div className="text-xs text-warning">Fiche : {l.conflit.valeurActuelle ?? "—"}</div>}
              {l.extrait && <div className="text-xs text-muted-foreground">« {l.extrait} »</div>}
            </TableCell>
            <TableCell>{l.piece.nom}<div className="text-xs text-muted-foreground">{l.piece.nature ?? "non classée"}</div></TableCell>
            <TableCell className="max-w-sm text-xs text-muted-foreground">{l.raison}</TableCell>
            {gestes && <TableCell><GestesFait faitId={l.id} conflitId={l.conflit?.id ?? null} /></TableCell>}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export default async function AConfirmerPage() {
  const user = await requireUser();
  const { aTrancher, sansFiche } = await faitsAConfirmer({ id: user.id, superAdmin: user.role === "SUPER_ADMIN" });
  return (
    <div className="space-y-6">
      <PageHeader title="À confirmer" description="Ce que les pièces déposées disent des personnes et des organisations, en attente de votre décision." />
      <Card>
        <CardHeader><CardTitle>Faits proposés et conflits ({aTrancher.length})</CardTitle></CardHeader>
        <CardContent>
          {aTrancher.length === 0 ? <EmptyState title="Rien à confirmer" description="Les faits lus sur vos pièces apparaîtront ici." /> : <Lignes lignes={aTrancher} gestes />}
        </CardContent>
      </Card>
      {sansFiche.length > 0 && (
        <Card>
          <CardHeader><CardTitle>Lus, sans fiche ({sansFiche.length})</CardTitle></CardHeader>
          <CardContent>
            <p className="mb-3 text-sm text-muted-foreground">Aucune fiche n&apos;a pu être désignée sans deviner : ces faits attendent qu&apos;une fiche les porte (dépôt sur la fiche, reprise des référentiels).</p>
            <Lignes lignes={sansFiche} gestes={false} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
