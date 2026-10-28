import Link from "next/link";
import { requireModule } from "@/lib/session";
import { formatNumber } from "@/lib/utils";
import { matriceNonServi, directionsRegionales } from "@/lib/ventes-pch/requetes";
import { InfoBulle } from "@/components/ui/info-bulle";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EnteteVentesPch } from "../entete";
import { FiltresVentesPch } from "../filtres";
import { contexteVentesPch, type ParamsVentesPch } from "../contexte";

export const dynamic = "force-dynamic";

/**
 * VENTES PCH — LA DEMANDE NON SERVIE, PRODUIT × DIRECTION RÉGIONALE : ce que les hôpitaux ont commandé et que la PCH a
 * livré à 0 (rupture), et combien d'établissements l'ont demandé. Le signal que lira le cockpit.
 */
export default async function NonServiVentesPchPage(props: { searchParams: Promise<ParamsVentesPch> }) {
  const searchParams = await props.searchParams;
  const user = await requireModule("PCH_VENTES");
  const ctx = await contexteVentesPch(searchParams);
  const [matrice, drs] = await Promise.all([matriceNonServi(ctx.periode, ctx.buId), directionsRegionales()]);
  // Filtre produit (lien de la fiche Produits 360) : la ligne du produit seul, ses DR.
  const produit = searchParams.produit ? matrice.lignes.find((l) => l.productId === searchParams.produit) ?? null : null;
  const m = searchParams.produit
    ? { drs: matrice.drs.filter((d) => produit?.parDr[d]), lignes: produit ? [produit] : [] }
    : matrice;
  const lib = new Map(drs.map((d) => [d.code, d.libelle]));
  const q = (extra: Record<string, string>) => new URLSearchParams({ ...(ctx.buId ? { bu: ctx.buId } : {}), ...(searchParams.p ? { p: searchParams.p } : {}), m: ctx.ref, ...extra }).toString();

  return (
    <div className="space-y-4">
      <EnteteVentesPch user={user} />
      <FiltresVentesPch bus={ctx.bus} buId={ctx.buId} type={ctx.type} refMois={ctx.ref} moisDisponibles={ctx.moisDisponibles} />
      <div className="flex items-center gap-2 text-sm font-medium">
        Demande non servie · {ctx.periode.libelle} · boîtes
        <InfoBulle>Quantités commandées par les établissements et livrées à 0 par la direction régionale. Sous le chiffre : le nombre d&apos;établissements qui l&apos;ont demandée. Un clic sur une case ouvre les établissements de cette DR.</InfoBulle>
        {searchParams.produit && <Badge tone="info">{produit?.nom ?? "Produit"} <Link href={`/sales/non-servi?${q({})}`} className="ml-1 underline">retirer</Link></Badge>}
      </div>
      {m.lignes.length === 0 ? (
        <p className="surface p-4 text-sm text-muted-foreground">Aucune demande non servie de nos produits sur {ctx.periode.libelle}.</p>
      ) : (
        <div className="surface overflow-x-auto">
          <Table className="min-w-[720px]">
            <TableHeader>
              <TableRow>
                <TableHead className="sticky left-0 z-10 bg-card">Produit</TableHead>
                {m.drs.map((d) => <TableHead key={d} className="text-right" title={lib.get(d) ?? d}>{d}</TableHead>)}
                <TableHead className="text-right">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {m.lignes.map((l) => (
                <TableRow key={l.productId}>
                  <TableCell className="sticky left-0 z-10 min-w-[180px] bg-card">
                    <Link href={`/produits/${l.productId}`} className="font-medium text-primary hover:underline">{l.nom}</Link>
                    {l.bus.length > 0 && <p className="text-xs text-muted-foreground">{l.bus.map((b) => b.nom).join(", ")}</p>}
                  </TableCell>
                  {m.drs.map((d) => {
                    const c = l.parDr[d];
                    return (
                      <TableCell key={d} className="text-right tabular-nums">
                        {c ? (
                          <Link href={`/sales/territoires?${q({ dr: d, produit: l.productId })}`} className="hover:underline">
                            <span className="font-medium text-warning">{formatNumber(c.quantite)}</span>
                            <span className="block text-[11px] text-muted-foreground">{c.etablissements} étab.</span>
                          </Link>
                        ) : <span className="text-muted-foreground">·</span>}
                      </TableCell>
                    );
                  })}
                  <TableCell className="text-right font-medium tabular-nums">
                    {formatNumber(l.total)}
                    <span className="block text-[11px] font-normal text-muted-foreground">{l.etablissements} étab.</span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
