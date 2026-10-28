import Link from "next/link";
import { requireModule } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { formatCurrency, formatNumber } from "@/lib/utils";
import { synthesePch, type LigneSynthese } from "@/lib/ventes-pch/requetes";
import { KpiCard } from "@/components/shared/kpi-card";
import { InfoBulle } from "@/components/ui/info-bulle";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EnteteVentesPch, BandeauFraicheur } from "./entete";
import { FiltresVentesPch } from "./filtres";
import { contexteVentesPch, type ParamsVentesPch } from "./contexte";

export const dynamic = "force-dynamic";

function Evol({ v }: { v: number | null }) {
  if (v === null) return <span className="text-muted-foreground">—</span>;
  return <span className={v > 0 ? "text-success" : v < 0 ? "text-destructive" : "text-muted-foreground"}>{v > 0 ? "+" : ""}{v.toLocaleString("fr-FR")} %</span>;
}

/**
 * VENTES PCH — SYNTHÈSE PAR BU → PRODUIT (Direction, 08/10). Ce que la PCH a reçu de nous (sell-in), ce que ses DR ont
 * distribué aux hôpitaux, la demande non servie, notre part des réceptions de la PCH, l'évolution sur la période d'avant.
 */
export default async function VentesPchPage(props: { searchParams: Promise<ParamsVentesPch> }) {
  const searchParams = await props.searchParams;
  const user = await requireModule("PCH_VENTES");
  const ctx = await contexteVentesPch(searchParams);
  const lignes = await synthesePch(ctx.periode, ctx.precedente, ctx.buId);
  const actives = lignes.filter((l) => l.recuNous || l.recuMarche || l.distribue || l.nonServi);

  // Groupées par BU (la première du produit) ; « Sans BU » en dernier.
  const groupes = new Map<string, { nom: string; lignes: LigneSynthese[] }>();
  for (const l of actives) {
    const bu = (ctx.buId ? l.bus.find((b) => b.id === ctx.buId) : l.bus[0]) ?? { id: "", nom: "Sans BU" };
    (groupes.get(bu.id) ?? groupes.set(bu.id, { nom: bu.nom, lignes: [] }).get(bu.id)!).lignes.push(l);
  }
  const ordre = [...groupes.entries()].sort((a, b) => (a[0] === "" ? 1 : b[0] === "" ? -1 : a[1].nom.localeCompare(b[1].nom)));
  const total = actives.reduce((s, l) => ({ recuValeur: s.recuValeur + (l.recuValeur ?? 0), recu: s.recu + l.recuNous, distribue: s.distribue + l.distribue, nonServi: s.nonServi + l.nonServi }), { recuValeur: 0, recu: 0, distribue: 0, nonServi: 0 });
  const sansFournisseur = actives.filter((l) => l.sansFournisseur && l.recuMarche > 0).length;

  return (
    <div className="space-y-4">
      <EnteteVentesPch user={user} />
      <BandeauFraicheur sources={ctx.fraicheur.sources} />
      <FiltresVentesPch bus={ctx.bus} buId={ctx.buId} type={ctx.type} refMois={ctx.ref} moisDisponibles={ctx.moisDisponibles} />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard label={`Reçu par la PCH · ${ctx.periode.libelle}`} value={formatCurrency(total.recuValeur)} hint={`${formatNumber(total.recu)} boîtes`} icon="PackageCheck" tone="success" />
        <KpiCard label="Distribué aux hôpitaux" value={formatNumber(total.distribue)} hint="boîtes" icon="Hospital" />
        <KpiCard label="Demande non servie" value={formatNumber(total.nonServi)} hint="boîtes" icon="PackageX" tone={total.nonServi > 0 ? "warning" : "default"} />
        <KpiCard label="Produits" value={actives.length} icon="Pill" tone="info" />
      </div>

      {actives.length === 0 ? (
        <p className="surface p-4 text-sm text-muted-foreground">
          Aucune donnée PCH sur {ctx.periode.libelle}.{userCan(user, "PCH_VENTES", "UPLOAD") && <> <Link href="/sales/importer" className="text-primary hover:underline">Importer des fichiers</Link></>}
        </p>
      ) : (
        <>
        <div className="flex items-center gap-2 text-sm font-medium">
          Par BU et par produit · {ctx.periode.libelle}
          <InfoBulle>
            <b>Reçu PCH</b> : nos livraisons à la PCH centrale (réceptions FO de nos fournisseurs), en boîtes, valorisées au coût d&apos;achat de la PCH.{" "}
            <b>Part de marché</b> : nos réceptions ÷ toutes les réceptions FO des mêmes postes PCH.{" "}
            <b>Distribué</b> : ce que les directions régionales ont livré aux hôpitaux (la molécule, toutes origines).{" "}
            <b>Non servi</b> : commandé par les hôpitaux et livré à 0. Évolutions : par rapport à la période précédente de même longueur.
          </InfoBulle>
        </div>
        <div className="surface overflow-x-auto">
          <Table className="min-w-[860px]">
            <TableHeader>
              <TableRow>
                <TableHead className="sticky left-0 z-10 bg-card">Produit</TableHead>
                <TableHead className="text-right">Reçu PCH</TableHead>
                <TableHead className="text-right">Valeur</TableHead>
                <TableHead className="text-right">Part de marché</TableHead>
                <TableHead className="text-right">Distribué</TableHead>
                <TableHead className="text-right">Non servi</TableHead>
                <TableHead className="text-right">Évol. reçu</TableHead>
                <TableHead className="text-right">Évol. distribué</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ordre.map(([buKey, g]) => [
                <TableRow key={`bu-${buKey}`} className="bg-secondary/40 hover:bg-secondary/40">
                  <TableCell colSpan={8} className="sticky left-0 z-10 bg-secondary/40 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{g.nom}</TableCell>
                </TableRow>,
                ...g.lignes.map((l) => (
                  <TableRow key={l.productId}>
                    <TableCell className="sticky left-0 z-10 min-w-[200px] bg-card">
                      <Link href={`/produits/${l.productId}`} className="font-medium text-primary hover:underline">{l.nom}</Link>
                      {l.sansFournisseur && l.recuMarche > 0 && <Badge tone="warning" className="ml-1.5">fournisseur à régler</Badge>}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{l.sansFournisseur ? "—" : formatNumber(l.recuNous)}</TableCell>
                    <TableCell className="text-right tabular-nums">{l.recuValeur !== null && !l.sansFournisseur ? formatCurrency(l.recuValeur) : "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">{l.partPct !== null && !l.sansFournisseur ? `${l.partPct.toLocaleString("fr-FR")} %` : "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(l.distribue)}</TableCell>
                    <TableCell className={`text-right tabular-nums ${l.nonServi > 0 ? "font-medium text-warning" : ""}`}>{formatNumber(l.nonServi)}</TableCell>
                    <TableCell className="text-right tabular-nums"><Evol v={l.sansFournisseur ? null : l.evolRecu} /></TableCell>
                    <TableCell className="text-right tabular-nums"><Evol v={l.evolDistribue} /></TableCell>
                  </TableRow>
                )),
              ])}
            </TableBody>
          </Table>
        </div>
        </>
      )}
      {sansFournisseur > 0 && (
        <p className="text-xs text-muted-foreground">
          {sansFournisseur} produit{sansFournisseur > 1 ? "s" : ""} sans fournisseur « à nous » réglé — <Link href="/sales/importer#fournisseurs" className="text-primary hover:underline">régler</Link>
        </p>
      )}
    </div>
  );
}
