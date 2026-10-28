import Link from "next/link";
import { Link2 } from "lucide-react";
import { requireModule } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { listeProduits360, type OngletListe, type LigneProduit360 } from "@/lib/queries/produits-360";
import { compterProduitsARapprocher } from "@/lib/queries/product-catalog";
import { MenuDossier } from "@/components/shared/menu-dossier";
import { VerifierCatalogue } from "./verifier-catalogue";
import { montantCourt } from "@/lib/products/fiche-360";
import { tonSante, decimal, COMPOSANTES_SANTE, LIBELLE_COMPOSANTE, POIDS_SANTE } from "@/lib/products/sante";
import { REGULATORY_STATUS } from "@/lib/labels";
import { Input } from "@/components/ui/input";
import { InfoBulle } from "@/components/ui/info-bulle";
import { Onglets, Pastille } from "@/components/produits/ui-360";
import { FiltreBu, TableauPortefeuille, type LignePortefeuille } from "./portefeuille";

export const dynamic = "force-dynamic";
export const metadata = { title: "Produits 360 — AMD Internal OS" };

const signe = (n: number) => `${n > 0 ? "+" : ""}${n}`;

/** Une ligne du portefeuille, telle que le tableau (client) la reçoit : `undefined` = colonne non visible. */
function versPortefeuille(p: LigneProduit360): LignePortefeuille {
  const c = p.chiffres;
  return {
    id: p.id, nom: p.nom, sousTitre: [p.sousTitre, p.bu].filter(Boolean).join(" · "), sante: p.sante, alerte: p.alerte,
    couvertureMois: c?.stock ? c.stock.couvertureMois : undefined,
    visites: c?.visites ?? undefined,
    prescripteursA: c?.prescripteurs ? (c.prescripteurs.segmentes ? c.prescripteurs.a : null) : undefined,
    adpro: c?.adpro ? c.adpro.montant : undefined,
  };
}

/** Comparer 2 à 4 produits : les six chiffres et les composantes de la note, côte à côte. */
function Comparaison({ produits, fermer }: { produits: LigneProduit360[]; fermer: string }) {
  const nd = <span className="text-muted-foreground">n/d</span>;
  const lignes: [string, (p: LigneProduit360) => React.ReactNode][] = [
    ["Santé", (p) => <Pastille ton={tonSante(p.sante?.score ?? null)}>{p.sante?.score ?? "n/d"}</Pastille>],
    ...COMPOSANTES_SANTE.map((k): [string, (p: LigneProduit360) => React.ReactNode] => [
      `${LIBELLE_COMPOSANTE[k]} (${POIDS_SANTE[k]})`,
      (p) => { const c = p.sante?.composantes.find((x) => x.cle === k); return c?.note != null ? <span title={c.fait ?? undefined}>{c.note}</span> : nd; },
    ]),
    ["Couverture du stock", (p) => (p.chiffres?.stock?.couvertureMois != null ? `${decimal(p.chiffres.stock.couvertureMois)} mois` : nd)],
    ["Visites (cycle)", (p) => (p.chiffres?.visites ? `${p.chiffres.visites.cycle}${p.chiffres.visites.evolutionPct !== null ? ` (${signe(p.chiffres.visites.evolutionPct)} %)` : ""}` : nd)],
    ["Cibles H·A·B vues", (p) => (p.chiffres?.cibles?.pct != null ? `${p.chiffres.cibles.pct} %` : nd)],
    ["Prescripteurs A", (p) => (p.chiffres?.prescripteurs?.segmentes ? `${p.chiffres.prescripteurs.a}${p.chiffres.prescripteurs.mouvementNet !== null ? ` (${signe(p.chiffres.prescripteurs.mouvementNet)})` : ""}` : nd)],
    ["Ad & Pro 12 mois", (p) => (p.chiffres?.adpro ? `${montantCourt(p.chiffres.adpro.montant)}${p.chiffres.adpro.partHabPct !== null ? ` · ${p.chiffres.adpro.partHabPct} % H·A·B` : ""}` : nd)],
    ["Cas PV ouverts", (p) => (p.chiffres?.pv ? String(p.chiffres.pv.ouverts) : nd)],
    ["Alerte principale", (p) => (p.alerte ? <Pastille ton={p.alerte.ton}>{p.alerte.label}</Pastille> : "—")],
  ];
  return (
    <section className="surface overflow-hidden">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <h2 className="text-[15px] font-semibold">Comparaison</h2>
        <Link href={fermer} className="text-xs text-primary hover:underline">Fermer</Link>
      </header>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
            <tr><th className="sticky left-0 bg-card px-3 py-2 font-medium" />{produits.map((p) => <th key={p.id} className="whitespace-nowrap px-3 py-2 text-right font-medium"><Link href={`/produits/${p.id}`} className="text-foreground hover:underline">{p.nom}</Link></th>)}</tr>
          </thead>
          <tbody>{lignes.map(([label, cellule]) => (
            <tr key={label} className="border-t border-border/60">
              <td className="sticky left-0 whitespace-nowrap bg-card px-3 py-2 text-muted-foreground">{label}</td>
              {produits.map((p) => <td key={p.id} className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{cellule(p)}</td>)}
            </tr>
          ))}</tbody>
        </table>
      </div>
    </section>
  );
}

/**
 * PRODUITS 360 — LE portefeuille (version 2, Direction 10/2026). Les commercialisés triés par note de santé (ce qui va mal
 * d'abord), filtrables par BU, comparables 2 à 4 ; le pipeline (dossier en cours) dans son onglet. Chaque colonne
 * n'apparaît qu'à qui a son module.
 */
export default async function ProduitsPage(
  props: { searchParams?: Promise<{ q?: string; onglet?: string; bu?: string; comparer?: string }> }
) {
  const searchParams = await props.searchParams;
  const user = await requireModule("PRODUCTS");
  const q = (searchParams?.q ?? "").trim();
  const bu = searchParams?.bu?.trim() || null;
  const onglet: OngletListe = searchParams?.onglet === "enregistrement" ? "enregistrement" : "commercialises";
  const { lignes, compte, colonnes, bus } = await listeProduits360(user, { q, onglet, bu });
  const requete = (o: OngletListe, avecBu = true) => [o === "enregistrement" ? "onglet=enregistrement" : "", q ? `q=${encodeURIComponent(q)}` : "", avecBu && bu ? `bu=${encodeURIComponent(bu)}` : ""].filter(Boolean).join("&");
  const lien = (o: OngletListe) => `/produits${requete(o) ? `?${requete(o)}` : ""}`;
  const commerce = onglet === "commercialises";
  const selection = commerce ? (searchParams?.comparer ?? "").split(",").filter((id) => lignes.some((l) => l.id === id)).slice(0, 4) : [];
  const compares = selection.map((id) => lignes.find((l) => l.id === id)!).filter(Boolean);
  // LE MENU ⋯ — rapprocher un produit BD / BU créé sans dossier, et vérifier que chaque dossier a son produit (Super Admin).
  const peutRapprocher = userCan(user, "REGULATORY", "UPDATE");
  const aRapprocher = peutRapprocher ? await compterProduitsARapprocher() : 0;
  const estSuperAdmin = user.role === "SUPER_ADMIN";

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0 space-y-1">
          <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight sm:text-2xl">
            Produits 360
            <InfoBulle label="Comment lire ce portefeuille ?">
              Un produit = son dossier réglementaire. Commercialisé = décision d&apos;enregistrement obtenue ou dossier clôturé. Santé sur 100 : stock 25, couverture terrain 25, prescripteurs 20, réglementaire 15, qualité 15 ; une composante sans donnée (ou hors de vos modules) est exclue et les poids renormalisés. Trié par santé croissante.
            </InfoBulle>
          </h1>
          <p className="text-sm text-muted-foreground">{compte.commercialises} commercialisé{compte.commercialises > 1 ? "s" : ""} · {compte.enregistrement} en enregistrement</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <form className="w-full sm:w-64">
            {onglet === "enregistrement" && <input type="hidden" name="onglet" value={onglet} />}
            {bu && <input type="hidden" name="bu" value={bu} />}
            <Input name="q" type="search" defaultValue={q} placeholder="Nom, DCI, code, alias, dossier…" aria-label="Rechercher un produit" />
          </form>
          {bus.length > 0 && <FiltreBu bus={bus} actif={bu} base={requete(onglet, false)} />}
          {((peutRapprocher && aRapprocher > 0) || estSuperAdmin) && (
            <MenuDossier>
              {peutRapprocher && aRapprocher > 0 && (
                <Link href="/produits/rapprocher" role="menuitem" className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-secondary">
                  <Link2 className="h-4 w-4 text-muted-foreground" /> Rapprocher un produit BD / BU
                  <span className="ml-auto text-xs tabular-nums text-muted-foreground">{aRapprocher}</span>
                </Link>
              )}
              {estSuperAdmin && <VerifierCatalogue />}
            </MenuDossier>
          )}
        </div>
      </div>

      <Onglets label="Catalogue" actif={onglet} items={[
        { cle: "commercialises", label: "Commercialisés", href: lien("commercialises"), n: compte.commercialises },
        { cle: "enregistrement", label: "En enregistrement", href: lien("enregistrement"), n: compte.enregistrement },
      ]} />

      {commerce ? (
        <>
          {compares.length >= 2 && <Comparaison produits={compares} fermer={lien("commercialises")} />}
          <TableauPortefeuille key={selection.join(",")} lignes={lignes.map(versPortefeuille)} colonnes={colonnes} selection={selection} base={requete(onglet)} />
        </>
      ) : (
        /* Un tableau reste un tableau au téléphone : la première colonne reste visible, le reste défile. */
        <div className="surface overflow-hidden">
          <div className="overflow-x-auto [-webkit-overflow-scrolling:touch]">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="sticky left-0 z-[1] bg-card px-3 py-2 font-medium">Produit</th>
                  <th className="whitespace-nowrap px-3 py-2 font-medium">BU</th>
                  <th className="whitespace-nowrap px-3 py-2 font-medium">Dossier</th>
                  <th className="whitespace-nowrap px-3 py-2 font-medium">Statut</th>
                  <th className="whitespace-nowrap px-3 py-2 font-medium">Cible d&apos;enregistrement</th>
                </tr>
              </thead>
              <tbody>
                {lignes.length === 0 && <tr><td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">Aucun produit{q ? ` pour « ${q} »` : ""}.</td></tr>}
                {lignes.map((p) => (
                  <tr key={p.id} className="border-b border-border/60 last:border-0 hover:bg-secondary/40">
                    <td className="sticky left-0 z-[1] bg-card px-3 py-2">
                      <Link href={`/produits/${p.id}`} className="block min-w-[10rem] max-w-[18rem]">
                        <b className="block truncate font-medium text-foreground hover:underline">{p.nom}</b>
                        <small className="block truncate text-xs text-muted-foreground">{p.sousTitre}</small>
                      </Link>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">{p.bu ?? <span className="text-muted-foreground">—</span>}</td>
                    <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-muted-foreground">{p.dossier?.reference ?? "—"}</td>
                    <td className="whitespace-nowrap px-3 py-2">{p.dossier ? <Pastille ton="info">{REGULATORY_STATUS[p.dossier.statut]?.label ?? p.dossier.statut}</Pastille> : "—"}</td>
                    <td className="whitespace-nowrap px-3 py-2 tabular-nums">{p.dossier?.cible ? new Date(p.dossier.cible).toLocaleDateString("fr-FR", { month: "long", year: "numeric" }) : <span className="text-muted-foreground">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {lignes.length >= 200 && <p className="text-xs text-muted-foreground">Les 200 premiers produits sont affichés : précisez la recherche.</p>}
    </div>
  );
}
