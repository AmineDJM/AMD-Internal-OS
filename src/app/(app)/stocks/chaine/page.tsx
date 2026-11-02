import Link from "next/link";
import { redirect } from "next/navigation";
import { PackageSearch } from "lucide-react";
import { requireModule } from "@/lib/session";
import { PageHeader } from "@/components/shared/page-header";
import { ModuleTabs } from "@/components/shared/module-tabs";
import { EmptyState } from "@/components/shared/empty-state";
import { InfoBulle } from "@/components/ui/info-bulle";
import { CHEMIN_DEMANDES_STOCKS, CHEMIN_STOCKS, CHEMIN_STOCKS_CHAINE, CHEMIN_STOCK_PCH, ongletsStocks } from "@/lib/chemins/stocks";
import { chargerChaine, chargerConsommationMensuelle, chargerProduitsPch, voitLaChaine, type LigneChaine } from "@/lib/queries/stock-pch";
import {
  SEUIL_RUPTURE_MOIS, SEUIL_VIGILANCE_MOIS, ageEnJours, consommationDepuis, couvertureEnMois, estPerime, ilYa, niveauCouverture, stockDeLaChaine,
  type ConsommationMensuelle,
} from "@/lib/stocks/pch-central";
import { cn, formatNumber } from "@/lib/utils";

export const dynamic = "force-dynamic";
export const metadata = { title: "Stocks de la chaîne — AMD Internal OS" };

/**
 * LES STOCKS DE LA CHAÎNE, PAR BU (Direction, 08/10 — maquette « Stocks de la chaîne ») : pour chacun de nos produits,
 * le stock PCH central et celui des directions régionales (saisis depuis les relevés de la PCH) et la somme des derniers
 * relevés des hôpitaux (les KAM), avec l'âge de chaque relevé (orange au-delà de 30 jours). Direction, 10/2026 : « les
 * stocks Adventum proviennent de deux sources, la PCH et les hôpitaux » — pas de colonne Adventum. La couverture = ce stock
 * ÷ la consommation mensuelle lue dans « Ventes PCH » (moyenne des 3 derniers mois complets distribués aux hôpitaux) :
 * rouge sous 2 mois, orange sous 3.
 */

export default async function StocksChainePage(props: { searchParams?: Promise<{ bu?: string }> }) {
  const searchParams = await props.searchParams;
  const user = await requireModule("STOCKS");
  if (!voitLaChaine(user)) redirect(CHEMIN_STOCKS);
  const produits = await chargerProduitsPch(user);
  const [lignes, consos] = await Promise.all([chargerChaine(user, produits), chargerConsommationMensuelle(produits.map((p) => p.id))]);
  const consommationMensuelle = consommationDepuis(consos);
  const bus = [...new Map(lignes.map((l) => [l.buId ?? "-", l.buNom])).entries()];
  const bu = searchParams?.bu && bus.some(([id]) => id === searchParams.bu) ? searchParams.bu : null;
  const visibles = bu ? lignes.filter((l) => (l.buId ?? "-") === bu) : lignes;
  const groupes = bus.filter(([id]) => !bu || id === bu).map(([id, nom]) => ({ id, nom, lignes: visibles.filter((l) => (l.buId ?? "-") === id) }));

  return (
    <div className="space-y-4">
      <ModuleTabs tabs={ongletsStocks(true)} />
      <PageHeader title="Stocks de la chaîne" description="PCH central · directions régionales · hôpitaux, par BU">
        <InfoBulle>
          Deux sources : la PCH (relevés reçus par mail — central et directions régionales) et les hôpitaux (relevés des
          KAM, demandes de stocks). PCH central et Directions rég. : le dernier relevé de chaque lieu. Hôpitaux : la somme
          du dernier relevé de chaque hôpital. Un relevé de plus de 30 jours passe en orange.
          {" "}Conso / mois : la moyenne des 3 derniers mois complets distribués aux hôpitaux (Ventes PCH). Couverture : le
          stock de la chaîne ÷ cette consommation — rouge sous {SEUIL_RUPTURE_MOIS} mois, orange sous {SEUIL_VIGILANCE_MOIS}.
        </InfoBulle>
        <Link href={CHEMIN_DEMANDES_STOCKS} className="inline-flex h-10 items-center gap-2 rounded-[var(--radius)] bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90">
          <PackageSearch className="h-4 w-4" /> Demander les stocks
        </Link>
      </PageHeader>

      {bus.length > 1 && (
        <nav className="-mx-3 flex gap-1.5 overflow-x-auto px-3 sm:mx-0 sm:flex-wrap sm:px-0" aria-label="Business units">
          <Puce href={CHEMIN_STOCKS_CHAINE} actif={!bu}>Toutes les BU</Puce>
          {bus.map(([id, nom]) => <Puce key={id} href={`${CHEMIN_STOCKS_CHAINE}?bu=${encodeURIComponent(id)}`} actif={bu === id}>{nom}</Puce>)}
        </nav>
      )}

      {lignes.length === 0 ? (
        <EmptyState icon="Boxes" title="Aucun produit" description="Les produits des Business Units (avec leur dossier) apparaissent ici." />
      ) : (
        <div className="surface overflow-x-auto rounded-xl">
          <table className="w-full min-w-[760px] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="sticky left-0 z-10 bg-card px-3 py-2 font-medium">Produit</th>
                <th className="px-3 py-2 text-right font-medium">PCH central</th>
                <th className="px-3 py-2 text-right font-medium">Directions rég.</th>
                <th className="px-3 py-2 text-right font-medium">Hôpitaux</th>
                <th className="px-3 py-2 text-right font-medium">Conso / mois</th>
                <th className="px-3 py-2 text-right font-medium">Couverture chaîne</th>
                <th className="px-3 py-2 text-right font-medium">En rupture</th>
              </tr>
            </thead>
            <tbody>
              {groupes.map((g) => (
                <Groupe key={g.id} nom={g.nom} lignes={g.lignes} avecTitre={!bu && groupes.length > 1} consommationMensuelle={consommationMensuelle} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        Saisir le stock PCH reçu par mail : <Link href={CHEMIN_STOCK_PCH} className="text-primary hover:underline">Stock PCH</Link>.
      </p>
    </div>
  );
}

function Puce({ href, actif, children }: { href: string; actif: boolean; children: React.ReactNode }) {
  return (
    <Link href={href} aria-current={actif ? "page" : undefined}
      className={cn("shrink-0 whitespace-nowrap rounded-full border px-3 py-1 text-xs font-medium", actif ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:text-foreground")}>
      {children}
    </Link>
  );
}

function Groupe({ nom, lignes, avecTitre, consommationMensuelle }: { nom: string; lignes: LigneChaine[]; avecTitre: boolean; consommationMensuelle: ConsommationMensuelle }) {
  return (
    <>
      {avecTitre && (
        <tr className="border-b border-border bg-secondary/40">
          <td colSpan={7} className="sticky left-0 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{nom}</td>
        </tr>
      )}
      {lignes.map((l) => {
        const total = stockDeLaChaine([l.pch?.quantite, l.directions?.quantite, l.hopitaux?.quantite]);
        const conso = consommationMensuelle(l.productId);
        const couverture = couvertureEnMois(total, conso);
        const niveau = niveauCouverture(couverture);
        return (
          <tr key={`${l.buId ?? "-"}:${l.productId}`} className="border-b border-border last:border-0">
            <td className="sticky left-0 z-10 bg-card px-3 py-2 font-medium">{l.label}</td>
            <Cellule niveau={l.pch} />
            <Cellule niveau={l.directions} note={l.directions ? `${l.directions.nb} DR` : undefined} title={l.directions?.parDr.map((d) => `${d.code} ${formatNumber(d.quantite)}`).join(" · ")} />
            <Cellule niveau={l.hopitaux} note={l.hopitaux ? `${l.hopitaux.nb} hôp.` : undefined} />
            <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{conso === null ? "—" : formatNumber(conso)}</td>
            <td className={cn("px-3 py-2 text-right tabular-nums", niveau === "rupture" ? "font-semibold text-destructive" : niveau === "vigilance" ? "font-medium text-warning" : niveau === "ok" ? "" : "text-muted-foreground")}>
              {couverture === null ? "—" : `${couverture.toLocaleString("fr-FR")} mois`}
            </td>
            <td className="px-3 py-2 text-right tabular-nums">
              {l.hopitaux && l.hopitaux.ruptures > 0 ? <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">{l.hopitaux.ruptures}</span> : <span className="text-muted-foreground">—</span>}
            </td>
          </tr>
        );
      })}
    </>
  );
}

function Cellule({ niveau, note, title }: { niveau: { quantite: number; date: string } | null; note?: string; title?: string }) {
  if (!niveau) return <td className="px-3 py-2 text-right text-muted-foreground">—</td>;
  const age = ageEnJours(niveau.date);
  return (
    <td className="px-3 py-2 text-right" title={title}>
      <div className="tabular-nums">{formatNumber(niveau.quantite)}</div>
      <div className={cn("text-xs", estPerime(age) ? "font-medium text-warning" : "text-muted-foreground")}>
        {ilYa(age)}{note ? ` · ${note}` : ""}
      </div>
    </td>
  );
}
