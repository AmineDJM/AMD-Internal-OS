import Link from "next/link";
import { requireModule } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { PageHeader } from "@/components/shared/page-header";
import { calculerAffinites, lireConfig, lignesDuMarche, produitsEtConfigsAffinite, nomsEtablissements, PERIODE_LABELS } from "@/modules/consommation/api";
import { pct } from "@/lib/segmentation/regles";
import { ConfigAffiniteForm } from "@/modules/consommation/ecrans/config-affinite";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const dynamic = "force-dynamic";
export const metadata = { title: "Affinité par établissement — AMD Internal OS" };

/**
 * L'AFFINITÉ PAR ÉTABLISSEMENT — pour chaque produit réglé : sa consommation ÷ celle du marché choisi (panier de
 * produits et/ou de molécules), sur la période choisie, établissement par établissement. C'est une affinité
 * d'HÔPITAL : l'utiliser pour un médecin est un proxy que la stratégie de segmentation choisit explicitement.
 */
export default async function AffinitePage(props: { searchParams?: Promise<{ p?: string }> }) {
  const searchParams = await props.searchParams;
  const user = await requireModule("CONSUMPTION");
  const peutRegler = userCan(user, "CONSUMPTION", "VALIDATE");
  const { produits, configs } = await produitsEtConfigsAffinite();
  const choisi = produits.find((p) => p.id === searchParams?.p) ?? produits.find((p) => configs.some((c) => c.productId === p.id)) ?? produits[0] ?? null;
  const row = choisi ? configs.find((c) => c.productId === choisi.id) : undefined;
  const cfg = row ? lireConfig(row) : null;
  const resultat = cfg ? calculerAffinites(await lignesDuMarche(cfg), cfg) : null;
  const noms = await nomsEtablissements(resultat?.parEtablissement.map((a) => a.institutionId) ?? []);

  return (
    <div className="space-y-5">
      <PageHeader title="Affinité par établissement" description="Consommation du produit ÷ consommation du marché choisi, établissement par établissement.">
        <Link href="/consommation" className="text-sm text-primary underline">Imports</Link>
      </PageHeader>
      {/* TOUS LES PRODUITS DU RÉFÉRENTIEL se choisissent ici ; les pastilles sont ceux dont l'affinité est déjà réglée. */}
      <form className="flex flex-wrap items-center gap-2 text-sm">
        <select name="p" defaultValue={choisi?.id ?? ""} className="h-10 min-w-0 flex-1 rounded-lg border border-border bg-background px-2 text-sm sm:h-9 sm:min-w-[18rem] sm:flex-none" aria-label="Produit">
          {produits.map((p) => <option key={p.id} value={p.id}>{p.canonicalName}{configs.some((c) => c.productId === p.id) ? " ✓" : ""}</option>)}
        </select>
        <button type="submit" className="h-10 rounded-lg border border-border px-3 text-sm hover:bg-secondary sm:h-9">Ouvrir</button>
        <span className="text-xs text-muted-foreground">{produits.length} produit(s) du référentiel · ✓ = affinité réglée</span>
      </form>
      <div className="flex flex-wrap gap-1 text-xs">
        {produits.filter((p) => configs.some((c) => c.productId === p.id)).map((p) => (
          <Link key={p.id} href={`/consommation/affinite?p=${p.id}`} className={`rounded-md border px-3 py-2 sm:px-2 sm:py-1 ${p.id === choisi?.id ? "border-primary text-primary" : "border-border text-muted-foreground"}`}>{p.canonicalName}</Link>
        ))}
      </div>
      {choisi && peutRegler && (
        <ConfigAffiniteForm
          produits={produits.map((p) => ({ id: p.id, nom: p.canonicalName }))}
          productId={choisi.id}
          initial={cfg ? { productIds: cfg.panier.productIds, molecules: cfg.panier.molecules.join(", "), periode: cfg.periode, debut: cfg.debut ?? "", fin: cfg.fin ?? "" } : null}
        />
      )}
      {!cfg && <p className="surface p-4 text-sm text-muted-foreground">Aucune affinité n&apos;est réglée pour ce produit : aucun marché ni aucune période n&apos;est supposé.</p>}
      {cfg && resultat && (
        <section className="surface p-4">
          <p className="mb-2 text-sm">{PERIODE_LABELS[cfg.periode]}{resultat.fenetre ? ` — ${resultat.fenetre.libelle}` : " — aucune donnée validée dans le marché"}</p>
          {/* Une ligne = un établissement : une carte au téléphone. */}
          <Table>
            <TableHeader className="bg-transparent">
              <TableRow><TableHead className="px-2">Établissement</TableHead><TableHead className="px-2">Affinité</TableHead><TableHead className="px-2">Produit</TableHead><TableHead className="px-2">Marché</TableHead><TableHead className="px-2">Unité</TableHead><TableHead className="px-2">Lignes exclues (autre unité)</TableHead></TableRow>
            </TableHeader>
            <TableBody>
              {resultat.parEtablissement.map((a) => (
                <TableRow key={a.institutionId} className="border-border/60">
                  <TableCell data-sans-etiquette className="!justify-start px-2 font-medium [overflow-wrap:anywhere] sm:py-1 sm:font-normal">{noms.get(a.institutionId) ?? a.institutionId}</TableCell>
                  <TableCell className="px-2 font-medium sm:py-1">{pct(a.valeur)}</TableCell>
                  <TableCell className="px-2 sm:py-1">{a.numerateur}</TableCell>
                  <TableCell className="px-2 sm:py-1">{a.denominateur}</TableCell>
                  <TableCell className="px-2 sm:py-1">{a.unite ?? "—"}</TableCell>
                  <TableCell className="px-2 sm:py-1">{a.exclues}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
      )}
    </div>
  );
}
