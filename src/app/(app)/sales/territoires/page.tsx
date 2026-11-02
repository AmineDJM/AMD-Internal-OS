import Link from "next/link";
import { requireModule } from "@/lib/session";
import { formatNumber } from "@/lib/utils";
import { etablissementPch, territoiresPch, type LigneTerritoire } from "@/lib/ventes-pch/requetes";
import { moisCourt } from "@/lib/ventes-pch/calculs";
import { InfoBulle } from "@/components/ui/info-bulle";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EnteteVentesPch } from "../entete";
import { FiltresVentesPch } from "../filtres";
import { contexteVentesPch, type ParamsVentesPch } from "../contexte";

export const dynamic = "force-dynamic";

/** L'adresse de la page avec un paramètre changé (les autres suivent). */
function lien(sp: ParamsVentesPch, maj: Partial<Record<keyof ParamsVentesPch, string | null>>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...sp, ...maj })) if (v) p.set(k, v);
  const q = p.toString();
  return q ? `/sales/territoires?${q}` : "/sales/territoires";
}

function TableTerritoires({ titre, lignes, lienDe }: { titre: string; lignes: LigneTerritoire[]; lienDe?: (l: LigneTerritoire) => string }) {
  return (
    <div className="surface overflow-x-auto">
      <Table className="min-w-[420px]">
        <TableHeader>
          <TableRow>
            <TableHead className="sticky left-0 z-10 bg-card">{titre}</TableHead>
            <TableHead className="text-right">Distribué</TableHead>
            <TableHead className="text-right">Non servi</TableHead>
            <TableHead className="text-right">Établ.</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {lignes.map((l) => (
            <TableRow key={l.cle || "vide"}>
              <TableCell className="sticky left-0 z-10 bg-card font-medium">{lienDe ? <Link href={lienDe(l)} className="text-primary hover:underline">{l.libelle}</Link> : l.libelle}</TableCell>
              <TableCell className="text-right tabular-nums">{formatNumber(l.livre)}</TableCell>
              <TableCell className={`text-right tabular-nums ${l.nonServi ? "text-warning" : ""}`}>{formatNumber(l.nonServi)}</TableCell>
              <TableCell className="text-right tabular-nums">{formatNumber(l.etablissements)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/**
 * VENTES PCH — PAR DR, WILAYA ET ÉTABLISSEMENT : où nos molécules sont distribuées, où les hôpitaux demandent sans
 * obtenir. Un clic sur un établissement ouvre sa série mensuelle (12 mois).
 */
export default async function TerritoiresVentesPchPage(props: { searchParams: Promise<ParamsVentesPch> }) {
  const searchParams = await props.searchParams;
  const user = await requireModule("PCH_VENTES");
  const ctx = await contexteVentesPch(searchParams);
  const sp: ParamsVentesPch = { bu: searchParams.bu, p: searchParams.p, m: searchParams.m, dr: searchParams.dr, produit: searchParams.produit };
  const [t, detail] = await Promise.all([
    territoiresPch(ctx.periode, { buId: ctx.buId, dr: searchParams.dr ?? null, productId: searchParams.produit ?? null }),
    searchParams.etab ? etablissementPch(searchParams.etab, ctx.periode.fin, ctx.buId) : Promise.resolve(null),
  ]);
  const top = t.etablissements.slice(0, 150);

  return (
    <div className="space-y-4">
      <EnteteVentesPch user={user} />
      <FiltresVentesPch bus={ctx.bus} buId={ctx.buId} type={ctx.type} refMois={ctx.ref} moisDisponibles={ctx.moisDisponibles} />
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        {searchParams.dr && <Badge tone="info">DR {searchParams.dr} <Link href={lien(sp, { dr: null })} className="ml-1 underline">retirer</Link></Badge>}
        {searchParams.produit && <Badge tone="info">{t.produits.find((p) => p.id === searchParams.produit)?.nom ?? "Produit"} <Link href={lien(sp, { produit: null })} className="ml-1 underline">retirer</Link></Badge>}
        <form action="/sales/territoires" className="flex items-center gap-1.5">
          {Object.entries({ bu: sp.bu, p: sp.p, m: sp.m, dr: sp.dr }).map(([k, v]) => v ? <input key={k} type="hidden" name={k} value={v} /> : null)}
          <select name="produit" defaultValue={searchParams.produit ?? ""} aria-label="Produit" className="h-9 max-w-[16rem] rounded-md border border-input bg-card px-2 text-xs sm:h-8">
            <option value="">Tous nos produits</option>
            {t.produits.map((p) => <option key={p.id} value={p.id}>{p.nom}</option>)}
          </select>
          <button type="submit" className="h-9 rounded-md border border-border px-2.5 sm:h-8">Voir</button>
        </form>
        <InfoBulle>Quantités livrées aux établissements par les directions régionales de la PCH (nos molécules), et quantités commandées mais non servies. Un établissement « à rattacher » se relie à l&apos;annuaire depuis l&apos;onglet Importer.</InfoBulle>
      </div>

      {detail && (
        <div className="surface space-y-2 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-medium">
              {detail.exemple?.institution?.name ?? detail.exemple?.client ?? searchParams.etab}
              <span className="ml-2 text-xs text-muted-foreground">{[detail.exemple?.institution?.wilaya, detail.exemple?.dr].filter(Boolean).join(" · ")}</span>
            </p>
            <Link href={lien(sp, { etab: null })} className="text-xs text-primary hover:underline">Fermer</Link>
          </div>
          {detail.series.length === 0 ? <p className="text-sm text-muted-foreground">Aucune de nos molécules sur ces 12 mois.</p> : (
            <div className="overflow-x-auto">
              <Table className="min-w-[900px]">
                <TableHeader>
                  <TableRow>
                    <TableHead className="sticky left-0 z-10 bg-card">Produit</TableHead>
                    {detail.mois.map((m) => <TableHead key={m} className="text-right">{moisCourt(m)}</TableHead>)}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {detail.series.map((s) => (
                    <TableRow key={s.productId}>
                      <TableCell className="sticky left-0 z-10 min-w-[160px] bg-card font-medium">{s.nom}</TableCell>
                      {s.livre.map((v, i) => (
                        <TableCell key={detail.mois[i]} className="text-right tabular-nums">
                          {v ? formatNumber(v) : <span className="text-muted-foreground">·</span>}
                          {s.nonServi[i] > 0 && <span className="block text-[11px] text-warning">-{formatNumber(s.nonServi[i])}</span>}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          <p className="text-xs text-muted-foreground">En orange sous le chiffre : la quantité demandée et non servie ce mois-là.</p>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <TableTerritoires titre="Direction régionale" lignes={t.parDr} lienDe={(l) => lien(sp, { dr: l.cle })} />
        <TableTerritoires titre="Wilaya" lignes={t.parWilaya} />
      </div>

      <div className="surface overflow-x-auto">
        <Table className="min-w-[640px]">
          <TableHeader>
            <TableRow>
              <TableHead className="sticky left-0 z-10 bg-card">Établissement</TableHead>
              <TableHead>Wilaya</TableHead>
              <TableHead>DR</TableHead>
              <TableHead className="text-right">Distribué</TableHead>
              <TableHead className="text-right">Non servi</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {top.length === 0 && <TableRow><TableCell colSpan={5} className="text-sm text-muted-foreground">Aucune donnée sur {ctx.periode.libelle}.</TableCell></TableRow>}
            {top.map((e) => (
              <TableRow key={`${e.dr}|${e.cle}`}>
                <TableCell className="sticky left-0 z-10 min-w-[220px] bg-card [overflow-wrap:anywhere]">
                  <Link href={lien(sp, { etab: e.cle })} className="font-medium text-primary hover:underline">{e.nom}</Link>
                  {!e.institutionId && <Badge tone="neutral" className="ml-1.5">à rattacher</Badge>}
                </TableCell>
                <TableCell className="text-muted-foreground">{e.wilaya ?? "—"}</TableCell>
                <TableCell className="text-muted-foreground">{e.dr}</TableCell>
                <TableCell className="text-right tabular-nums">{formatNumber(e.livre)}</TableCell>
                <TableCell className={`text-right tabular-nums ${e.nonServi ? "font-medium text-warning" : ""}`}>{formatNumber(e.nonServi)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {t.etablissements.length > top.length && <p className="text-xs text-muted-foreground">Les {top.length} premiers établissements sur {t.etablissements.length}.</p>}
    </div>
  );
}
