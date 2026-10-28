import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireModule } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { fiche360, type ASurveiller, type Fiche360, type TonFiche } from "@/lib/queries/produits-360";
import { chargerProduitCanonique } from "@/lib/queries/produits-canoniques";
import { sections360 } from "@/lib/vues-360-acces";
import { essentielDuProduit } from "@/lib/produit-360-luna";
import { essentielDeterministe, type PointEssentiel } from "@/lib/products/essentiel-360";
import { STATUT_PV, GRAVITE_PV, estStatutPv, estGravitePv } from "@/lib/pharmacovigilance/regles";
import { CATEGORIE_VOIX_LABELS } from "@/lib/voix-terrain/pur";
import { montantCourt } from "@/lib/products/fiche-360";
import { decimal, moisCourtDe, type Lettre360 } from "@/lib/products/sante";
import { REGULATORY_STATUS, MANUFACTURING_STATUS, VARIATION_STATUS, MEDICAL_INFO_STATUS } from "@/lib/labels";
import { BackLink } from "@/components/shared/back-link";
import { InfoBulle } from "@/components/ui/info-bulle";
import { ProductDriveExplorer, dossierDriveAffiche } from "@/components/documents/product-drive-explorer";
import { Onglets, Pastille, Point, Carte, Vide, Chiffre, LettreChip, type Ton } from "@/components/produits/ui-360";
import { AnneauSante } from "@/components/produits/anneau-sante";
import { AliasProduit, RenommerProduit } from "./fiche-gestes";

export const dynamic = "force-dynamic";
export const metadata = { title: "Produits 360 — AMD Internal OS" };

const entier = (n: number) => Math.round(n).toLocaleString("fr-FR");
const jour = (d: string | null) => (d ? new Date(d).toLocaleDateString("fr-FR", { timeZone: "UTC" }) : "—");
const jj = (d: string) => new Date(d).toLocaleDateString("fr-FR", { timeZone: "UTC", day: "2-digit", month: "2-digit" });
const signe = (n: number) => `${n > 0 ? "+" : ""}${n}`;

type Onglet = "vue" | "stocks" | "terrain" | "prescripteurs" | "marketing" | "adpro" | "reglementaire" | "documents";

/** Les cellules des tableaux de la fiche (au téléphone, le tableau défile et sa 1re colonne reste visible). */
const TH = "whitespace-nowrap px-3 py-2 font-medium";
const TD = "whitespace-nowrap px-3 py-2 text-right tabular-nums";
const THEAD = "bg-muted/40 text-left text-xs text-muted-foreground";
const LETTRES_AFFICHEES: Lettre360[] = ["H", "A", "B", "C", "D"];
const ROLE_P = (n: number | null) => (n === null ? "—" : `P${n}`);

function ListeATraiter({ items }: { items: ASurveiller[] }) {
  if (!items.length) return <Vide>Rien à traiter.</Vide>;
  return (
    <ul className="divide-y divide-border">
      {items.map((s, i) => (
        <li key={i} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-4 py-2.5 text-sm">
          <Point ton={s.ton as Ton} />
          <div className="min-w-0"><b className="block font-medium">{s.titre}</b><small className="block truncate text-xs text-muted-foreground">{s.detail}</small></div>
          {s.href && <Link href={s.href} className="rounded-md border border-border px-2.5 py-1 text-xs hover:bg-secondary">Voir</Link>}
        </li>
      ))}
    </ul>
  );
}

function Dl({ items }: { items: [string, React.ReactNode][] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-2 px-4 py-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
      {items.map(([k, v]) => <div key={k} className="min-w-0"><dt className="text-xs text-muted-foreground">{k}</dt><dd className="break-words">{v ?? "—"}</dd></div>)}
    </dl>
  );
}

function Lettres({ lettres, sansReponse }: { lettres: Partial<Record<Lettre360, number>>; sansReponse?: boolean }) {
  return (
    <span className="flex flex-wrap items-center gap-1">
      {LETTRES_AFFICHEES.map((l) => <LettreChip key={l} lettre={l} n={lettres[l] ?? 0} />)}
      {sansReponse && (lettres.NA ?? 0) > 0 && <span className="ml-1 text-xs text-muted-foreground">{lettres.NA} sans réponse</span>}
    </span>
  );
}

const tonMois = (m: number | null) => (m === null ? "" : m < 1 ? "text-destructive" : m < 3 ? "text-warning" : "");

function TableStocks({ f, complet }: { f: NonNullable<Fiche360["stock"]>; complet?: boolean }) {
  const lieux = complet ? f.lieux : f.lieux.slice(0, 6);
  if (!lieux.length) return <Vide>Aucun relevé.</Vide>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className={THEAD}><tr><th className={`sticky left-0 bg-card ${TH}`}>Où</th>{complet && <th className={TH}>Relevé</th>}<th className={`${TH} text-right`}>Boîtes</th><th className={`${TH} text-right`}>Mois</th></tr></thead>
        <tbody>{lieux.map((l) => (
          <tr key={l.cle} className="border-t border-border/60">
            <td className="sticky left-0 max-w-[12rem] truncate bg-card px-3 py-2">{l.lieu}</td>
            {complet && <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">{jour(l.date)} · {l.portee}</td>}
            <td className={`${TD} ${l.rupture ? "text-destructive" : ""}`}>{entier(l.quantite)}</td>
            <td className={`${TD} ${tonMois(l.mois)}`}>{l.mois !== null ? decimal(l.mois) : <span className="text-muted-foreground">n/d</span>}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function TableKams({ t }: { t: NonNullable<Fiche360["terrain"]> }) {
  if (!t.kams.length) return <Vide>Aucun délégué affecté ni visite ce cycle.</Vide>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className={THEAD}><tr><th className={`sticky left-0 bg-card ${TH}`}>Délégué</th><th className={TH}>Priorité</th><th className={`${TH} text-right`}>Visites</th><th className={`${TH} text-right`}>Messages</th></tr></thead>
        <tbody>{t.kams.map((k) => (
          <tr key={k.repId} className="border-t border-border/60">
            <td className="sticky left-0 max-w-[12rem] truncate bg-card px-3 py-2">{k.nom}</td>
            <td className="px-3 py-2">{k.position !== null ? <Pastille ton={k.position === 1 ? "info" : "neutral"}>{ROLE_P(k.position)}</Pastille> : <span className="text-xs text-muted-foreground">hors plan</span>}</td>
            <td className={`${TD} ${k.position === 1 && k.visites === 0 ? "text-warning" : ""}`}>{k.visites}</td>
            <td className={TD}>{k.messages}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function TableAdPro({ a, limite }: { a: NonNullable<Fiche360["adpro"]>; limite?: number }) {
  const actions = limite ? a.actions.slice(0, limite) : a.actions;
  if (!actions.length) return <Vide>Aucune action Ad & Pro imputée sur 12 mois.</Vide>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className={THEAD}><tr><th className={`sticky left-0 bg-card ${TH}`}>Action</th>{!limite && <th className={TH}>Date</th>}<th className={`${TH} text-right`}>Montant</th><th className={TH}>Médecins</th></tr></thead>
        <tbody>{actions.map((x) => (
          <tr key={x.cle} className="border-t border-border/60">
            <td className="sticky left-0 max-w-[14rem] truncate bg-card px-3 py-2">{x.href ? <Link href={x.href} className="hover:underline">{x.libelle}</Link> : x.libelle}{!limite && <small className="block text-xs text-muted-foreground">{x.nature}</small>}</td>
            {!limite && <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">{jour(x.date)}</td>}
            <td className={TD}>{montantCourt(x.montant)}</td>
            <td className="whitespace-nowrap px-3 py-2">{x.medecins ? <span className="flex gap-1">{(["H", "A", "B", "C", "D", "NA", "NC"] as Lettre360[]).filter((l) => x.lettres[l]).map((l) => <LettreChip key={l} lettre={l} n={x.lettres[l]} />)}</span> : <span className="text-xs text-muted-foreground">non nominatif</span>}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function Chronologie({ items, id }: { items: Fiche360["chronologie"]; id: string }) {
  if (!items.length) return <Vide>Aucun événement sur 12 mois.</Vide>;
  return (
    <ol className="space-y-0 px-4 py-3 text-sm">
      {items.map((e, i) => (
        <li key={i} className="grid grid-cols-[3.5rem_minmax(0,1fr)] gap-2 border-l-2 border-border py-1.5 pl-3">
          <span className="text-xs tabular-nums text-muted-foreground">{jj(e.date)}</span>
          <span className="min-w-0"><Point ton={(e.ton === "success" ? "success" : e.ton) as Ton} /> {e.href ? <Link href={e.href.startsWith("?") ? `/produits/${id}${e.href}` : e.href} className="hover:underline">{e.texte}</Link> : e.texte}</span>
        </li>
      ))}
    </ol>
  );
}

function PointsEssentiel({ points, parLuna }: { points: PointEssentiel[]; parLuna: boolean }) {
  return (
    <div className="flex flex-col gap-1.5 border-t border-border bg-violet-500/5 px-4 py-3 text-sm">
      <span className="flex items-center gap-1 font-semibold text-violet-600 dark:text-violet-300">
        Luna — l&apos;essentiel ce mois
        <InfoBulle label="D'où viennent ces points ?">{parLuna ? "Luna choisit et formule trois points à partir des chiffres calculés de cette fiche, ceux que vous voyez ; chaque point dit sa source. Aucun chiffre ne vient d'elle." : "Les trois faits les plus urgents de la fiche, tels que calculés (Luna indisponible ou coupée)."}</InfoBulle>
      </span>
      {points.length === 0 ? <span className="text-muted-foreground">Rien de saillant ce mois.</span> : points.map((p, i) => (
        <span key={i}>• {p.texte} <small className="text-xs text-muted-foreground">({p.sources.join(", ")})</small></span>
      ))}
    </div>
  );
}

async function EssentielLuna({ f, userId }: { f: Fiche360; userId: string }) {
  const e = await essentielDuProduit({ productId: f.identite.id, faits: f.faits, userId });
  return <PointsEssentiel points={e.points} parLuna={e.parLuna} />;
}

/**
 * LA FICHE PRODUIT 360 (version 2, Direction 10/2026) — la santé d'un produit : stocks, terrain, visites, prescripteurs,
 * marketing, Ad & Pro, réglementaire et qualité. Une note sur 100 (détail au clic), six chiffres, l'essentiel du mois par
 * Luna, et un onglet par métier. Chaque chiffre, chaque onglet n'apparaît qu'à qui a son module (`vues-360-acces.ts`).
 */
export default async function Produit360Page(
  props: { params: Promise<{ id: string }>; searchParams?: Promise<{ onglet?: string; dossier?: string }> }
) {
  const searchParams = await props.searchParams;
  const params = await props.params;
  const user = await requireModule("PRODUCTS");
  const voit = sections360(user);
  const f = await fiche360(user, params.id);
  if (!f) notFound();
  const id = f.identite.id;

  const onglets: { cle: Onglet; label: string; visible: boolean }[] = [
    { cle: "vue", label: "Vue d'ensemble", visible: true },
    { cle: "stocks", label: "Stocks", visible: voit.stock },
    { cle: "terrain", label: "Terrain & visites", visible: voit.terrain || voit.forceDeVente },
    { cle: "prescripteurs", label: "Prescripteurs", visible: voit.segmentation || voit.terrain },
    { cle: "marketing", label: "Marketing", visible: f.marketing !== null },
    { cle: "adpro", label: "Ad & Pro", visible: voit.adpro },
    { cle: "reglementaire", label: "Réglementaire & qualité", visible: voit.reglementaire || voit.pharmacovigilance },
    { cle: "documents", label: "Documents", visible: voit.reglementaire && f.dossiers.length > 0 },
  ];
  const visibles = onglets.filter((o) => o.visible);
  const demande = (searchParams?.dossier ? "documents" : searchParams?.onglet) as Onglet | undefined;
  const onglet: Onglet = visibles.some((o) => o.cle === demande) ? demande! : "vue";
  const lienOnglet = (o: Onglet) => (o === "vue" ? `/produits/${id}` : `/produits/${id}?onglet=${o}`);
  const aTraiter = f.aTraiter.map((s) => ({ ...s, href: s.href?.startsWith("?") ? `/produits/${id}${s.href}` : s.href }));
  const canonique = onglet === "reglementaire" && voit.reglementaire ? await chargerProduitCanonique(user, id) : null;

  // ── Les six chiffres (chacun seulement avec son module) ──
  const c = f.chiffres;
  const chiffres: React.ReactNode[] = [];
  if (c.stock) chiffres.push(<Chiffre key="k" label="Couverture du stock" valeur={c.stock.couvertureMois !== null ? `${decimal(c.stock.couvertureMois)} mois` : null} contexte="PCH, DR + hôpitaux" ton={c.stock.couvertureMois !== null && c.stock.couvertureMois < 2 ? "ko" : c.stock.couvertureMois !== null && c.stock.couvertureMois < 3 ? "w" : null} />);
  if (c.visites) chiffres.push(<Chiffre key="v" label="Visites (cycle)" valeur={String(c.visites.cycle)} contexte={c.visites.evolutionPct !== null ? `${signe(c.visites.evolutionPct)} % vs cycle préc.` : "sans comparaison"} ton={c.visites.evolutionPct === null ? null : c.visites.evolutionPct >= 0 ? "ok" : "ko"} />);
  if (c.cibles) chiffres.push(<Chiffre key="c" label="Cibles H·A·B vues" valeur={c.cibles.pct !== null ? `${c.cibles.pct} %` : null} contexte={c.cibles.cibles ? `à fréquence · ${c.cibles.vues}/${c.cibles.cibles}` : "aucune cible"} />);
  if (c.prescripteurs) chiffres.push(<Chiffre key="p" label="Prescripteurs A" valeur={c.prescripteurs.segmentes ? String(c.prescripteurs.a) : null} contexte={c.prescripteurs.mouvementNet !== null ? `${signe(c.prescripteurs.mouvementNet)} ce cycle` : c.prescripteurs.segmentes ? `sur ${c.prescripteurs.segmentes} segmentés` : "non segmenté"} ton={c.prescripteurs.mouvementNet ? (c.prescripteurs.mouvementNet > 0 ? "ok" : "ko") : null} />);
  if (c.adpro) chiffres.push(<Chiffre key="a" label="Investi Ad & Pro" valeur={montantCourt(c.adpro.montant)} contexte={`12 mois${c.adpro.partHabPct !== null ? ` · ${c.adpro.partHabPct} % sur H·A·B` : ""}`} />);
  if (c.pv) chiffres.push(<Chiffre key="q" label="Pharmacovigilance" valeur={String(c.pv.ouverts)} contexte={c.pv.ouverts > 1 ? "cas ouverts" : "cas ouvert"} ton={c.pv.ouverts > 0 ? "ko" : null} />);

  const sousTitre = [f.identite.dosage, f.identite.forme?.toLowerCase(), f.identite.conditionnement].filter(Boolean).join(" · ");
  const ligne2 = [
    f.bus.length ? f.bus.map((b) => b.nom).join(" / ") : null,
    f.identite.decision ? `DE ${f.identite.decision.reference} du ${jour(f.identite.decision.date)}` : null,
    f.identite.decision ? `commercialisable depuis ${moisCourtDe(f.identite.decision.date)}` : null,
  ].filter(Boolean).join(" · ");
  const p = f.pastilles;
  const cycleTxt = `${jour(f.cycle.debut)} → ${jour(f.cycle.fin)}`;

  return (
    <div className="space-y-4">
      <BackLink href="/produits"><ArrowLeft className="h-4 w-4" /> Produits 360</BackLink>

      <section className="surface">
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 p-4">
          <div className="min-w-0">
            <h1 className="break-words text-lg font-semibold sm:text-xl">{f.identite.nom}{sousTitre && <span className="font-normal text-muted-foreground"> · {sousTitre}</span>}</h1>
            {ligne2 && <p className="text-sm text-muted-foreground">{ligne2}</p>}
            <div className="mt-2 flex flex-wrap gap-1.5">
              {p.p1 !== null && <Pastille ton={p.p1 > 0 ? "info" : "neutral"}>{p.p1 > 0 ? `P1 chez ${p.p1} délégué${p.p1 > 1 ? "s" : ""}` : "P1 chez aucun délégué"}</Pastille>}
              {p.messagesActifs !== null && <Pastille ton={p.messagesActifs > 0 ? "success" : "neutral"}>{p.messagesActifs} message{p.messagesActifs > 1 ? "s" : ""} actif{p.messagesActifs > 1 ? "s" : ""}</Pastille>}
              {p.echeance && <Pastille ton={p.echeance.ton as TonFiche}>{p.echeance.texte}</Pastille>}
            </div>
          </div>
          <AnneauSante score={f.sante.score} composantes={f.sante.composantes} />
        </div>
        {chiffres.length > 0 && (
          <div className={`grid grid-cols-2 border-t border-border ${chiffres.length >= 6 ? "lg:grid-cols-6" : chiffres.length === 5 ? "lg:grid-cols-5" : chiffres.length === 4 ? "lg:grid-cols-4" : "lg:grid-cols-3"}`}>{chiffres}</div>
        )}
        <Suspense fallback={<PointsEssentiel points={essentielDeterministe(f.faits)} parLuna={false} />}>
          <EssentielLuna f={f} userId={user.id} />
        </Suspense>
      </section>

      <Onglets label="Facettes du produit" actif={onglet} items={visibles.map((o) => ({ cle: o.cle, label: o.label, href: lienOnglet(o.cle) }))} />

      {onglet === "vue" && (
        <>
          <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-3">
            {f.stock && (
              <Carte titre="Stocks" sousTitre="derniers relevés" action={<Link href={lienOnglet("stocks")} className="text-primary hover:underline">Détail</Link>}>
                <TableStocks f={f.stock} />
                {f.stock.lots?.slice(0, 1).map((l, i) => (
                  <div key={i} className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3 border-t border-border px-4 py-2.5 text-sm">
                    <Point ton="warning" /><div className="min-w-0"><b className="block font-medium">Lot {l.lot ?? "sans numéro"} périme en {moisCourtDe(l.peremption)}</b><small className="text-xs text-muted-foreground">{entier(l.quantite)} {l.unite}{(f.stock?.lots?.length ?? 0) > 1 ? ` · ${(f.stock?.lots?.length ?? 1) - 1} autre(s)` : ""}</small></div>
                  </div>
                ))}
              </Carte>
            )}
            {(f.terrain || f.segmentation) && (
              <Carte titre="Terrain" sousTitre="ce cycle" action={<Link href={lienOnglet("terrain")} className="text-primary hover:underline">Détail</Link>}>
                {f.terrain && <TableKams t={{ ...f.terrain, kams: f.terrain.kams.slice(0, 5) }} />}
                {f.segmentation && (
                  <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-2.5 text-sm">
                    <Lettres lettres={f.segmentation.lettres} sansReponse />
                  </div>
                )}
              </Carte>
            )}
            <Carte titre="À traiter"><ListeATraiter items={aTraiter} /></Carte>
          </div>
          <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-3">
            {f.marketing && (
              <Carte titre="Marketing" action={<Link href={lienOnglet("marketing")} className="text-primary hover:underline">Détail</Link>}>
                {(f.marketing.messages ?? []).filter((m) => m.actif).length === 0 && !(f.marketing.materiel ?? []).length ? <Vide>Aucun message actif ni matériel.</Vide> : (
                  <ul className="divide-y divide-border text-sm">
                    {(f.marketing.messages ?? []).filter((m) => m.actif).slice(0, 3).map((m) => (
                      <li key={m.id} className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3 px-4 py-2.5">
                        <Point ton={m.portes > 0 ? "success" : "warning"} />
                        <div className="min-w-0"><b className="block truncate font-medium">« {m.titre} »</b><small className="text-xs text-muted-foreground">porté {m.portes} fois · {m.delegues} délégué{m.delegues > 1 ? "s" : ""}{f.marketing!.deleguesAssignes ? ` sur ${f.marketing!.deleguesAssignes}` : ""}</small></div>
                      </li>
                    ))}
                    {(f.marketing.materiel ?? []).filter((m) => m.actif).length > 0 && (
                      <li className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3 px-4 py-2.5">
                        <Point ton="info" />
                        <div className="min-w-0"><b className="block font-medium">Matériel promotionnel</b><small className="block truncate text-xs text-muted-foreground">{(f.marketing.materiel ?? []).filter((m) => m.actif).slice(0, 3).map((m) => `${m.nom} ${entier(m.stock)}`).join(" · ")}</small></div>
                      </li>
                    )}
                  </ul>
                )}
              </Carte>
            )}
            {f.adpro && (
              <Carte titre="Ad & Pro · 12 mois" sousTitre={montantCourt(f.adpro.montant)} action={<Link href={lienOnglet("adpro")} className="text-primary hover:underline">Détail</Link>}>
                <TableAdPro a={f.adpro} limite={4} />
              </Carte>
            )}
            <Carte titre="La vie du produit"><Chronologie items={f.chronologie} id={id} /></Carte>
          </div>
        </>
      )}

      {onglet === "stocks" && f.stock && (
        <>
          <Carte titre="Stocks" sousTitre={<>{f.stock.date ? `dernier relevé le ${jour(f.stock.date)}` : "aucun relevé"} <InfoBulle>Le stock = le dernier relevé de chaque lieu (PCH, hôpitaux, annexes) des dossiers du produit, dans votre portée. Couverture = stock ÷ écoulement mensuel : la distribution aux hôpitaux par les DR de la PCH (3 derniers mois reçus), à défaut les ventes saisies ou la consommation hospitalière en boîtes. Mois d&apos;un hôpital = son stock ÷ sa propre consommation importée.</InfoBulle></>} action={<Link href="/stocks" className="text-primary hover:underline">Stocks</Link>}>
            <Dl items={[
              ["Niveau actuel", `${entier(f.stock.unites)} boîtes · ${f.stock.lieux.length} lieu(x)`],
              ["Couverture", f.stock.couvertureMois !== null ? `${decimal(f.stock.couvertureMois)} mois` : "n/d"],
              ["Écoulement mensuel", f.stock.ecoulementMensuel !== null ? `${entier(f.stock.ecoulementMensuel)} boîtes · ${f.stock.sourceEcoulement === "PCH" ? "distribution PCH" : f.stock.sourceEcoulement === "VENTES" ? "ventes" : "consommation"}` : "n/d"],
            ]} />
            <div className="border-t border-border"><TableStocks f={f.stock} complet /></div>
          </Carte>
          {f.stock.lots && (
            <Carte titre="Lots sous 6 mois" sousTitre={<InfoBulle>Lots et péremptions lus sur les bons de livraison de la PCH, quand le bon les donne.</InfoBulle>}>
              {f.stock.lots.length === 0 ? <Vide>Aucun lot livré ne périme dans les 6 mois.</Vide> : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className={THEAD}><tr><th className={`sticky left-0 bg-card ${TH}`}>Lot</th><th className={TH}>Péremption</th><th className={`${TH} text-right`}>Quantité</th></tr></thead>
                    <tbody>{f.stock.lots.map((l, i) => (
                      <tr key={i} className="border-t border-border/60"><td className="sticky left-0 bg-card px-3 py-2 font-mono text-xs">{l.lot ?? "—"}</td><td className="whitespace-nowrap px-3 py-2 text-warning">{jour(l.peremption)}</td><td className={TD}>{entier(l.quantite)} {l.unite}</td></tr>
                    ))}</tbody>
                  </table>
                </div>
              )}
            </Carte>
          )}
          {f.stock.releves.length > 0 && (
            <Carte titre="Historique des relevés">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className={THEAD}><tr><th className={`sticky left-0 bg-card ${TH}`}>Date</th><th className={TH}>Lieu</th><th className={TH}>Portée</th><th className={`${TH} text-right`}>Quantité</th></tr></thead>
                  <tbody>{f.stock.releves.map((r) => (
                    <tr key={r.id} className="border-t border-border/60"><td className="sticky left-0 whitespace-nowrap bg-card px-3 py-2">{jour(r.date)}</td><td className="whitespace-nowrap px-3 py-2">{r.lieu}</td><td className="whitespace-nowrap px-3 py-2 text-muted-foreground">{r.portee}</td><td className={TD}>{entier(r.quantite)}</td></tr>
                  ))}</tbody>
                </table>
              </div>
            </Carte>
          )}
        </>
      )}

      {onglet === "terrain" && (
        <>
          {f.terrain ? (
            <Carte titre="Délégués" sousTitre={<>cycle {cycleTxt} <InfoBulle>Priorité : l&apos;affectation du cycle promotionnel du mois (P1, P2, P3). Visites : visites terminées où le produit a été présenté, dans votre portée. Messages : messages du produit retenus en visite.</InfoBulle></>}>
              <TableKams t={f.terrain} />
            </Carte>
          ) : <Carte titre="Délégués"><Vide>Visites hors de votre portée.</Vide></Carte>}
          {f.segmentation && (
            <Carte titre="Couverture des cibles" sousTitre={<>ce cycle <InfoBulle>Cible vue à fréquence : au moins autant de visites terminées ce cycle que sa fréquence requise (règles de segmentation). Décideur H d&apos;abord, puis segments A et B du produit.</InfoBulle></>}>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className={THEAD}><tr><th className={`sticky left-0 bg-card ${TH}`}>Cibles</th><th className={`${TH} text-right`}>Nombre</th><th className={`${TH} text-right`}>Vues à fréquence</th><th className={`${TH} text-right`}>%</th></tr></thead>
                  <tbody>{f.segmentation.couverture.map((x) => (
                    <tr key={x.lettre} className="border-t border-border/60"><td className="sticky left-0 bg-card px-3 py-2"><LettreChip lettre={x.lettre} /></td><td className={TD}>{x.cibles}</td><td className={TD}>{x.vues}</td><td className={TD}>{x.cibles ? `${Math.round((x.vues / x.cibles) * 100)} %` : "n/d"}</td></tr>
                  ))}</tbody>
                </table>
              </div>
            </Carte>
          )}
          {f.terrain && (
            <Carte titre="Visites récentes">
              {f.terrain.recentes.length === 0 ? <Vide>Présenté dans aucune visite récente.</Vide> : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className={THEAD}><tr><th className={`sticky left-0 bg-card ${TH}`}>Date</th><th className={TH}>Médecin</th><th className={TH}>Lettre</th><th className={TH}>Délégué</th></tr></thead>
                    <tbody>{f.terrain.recentes.map((v, i) => (
                      <tr key={i} className="border-t border-border/60"><td className="sticky left-0 whitespace-nowrap bg-card px-3 py-2">{jour(v.date)}</td><td className="max-w-[14rem] truncate px-3 py-2">{v.medecin ?? "—"}</td><td className="px-3 py-2">{v.lettre ? <LettreChip lettre={v.lettre} /> : <span className="text-muted-foreground">—</span>}</td><td className="whitespace-nowrap px-3 py-2 text-muted-foreground">{v.delegue ?? "—"}</td></tr>
                    ))}</tbody>
                  </table>
                </div>
              )}
            </Carte>
          )}
        </>
      )}

      {onglet === "prescripteurs" && (
        <>
          {f.segmentation ? (
            <Carte titre="Prescripteurs" sousTitre={<>{f.segmentation.strategies.map((s) => s.nom).join(", ")} <InfoBulle>Lettre du produit : H = décideur, puis le segment A–D calculé par la segmentation. Mouvement : comparé à l&apos;instantané du dernier cycle ouvert{f.segmentation.cycleComparaison ? ` (« ${f.segmentation.cycleComparaison} »)` : ""}.</InfoBulle></>} action={<Link href={`/segmentation?s=${f.segmentation.strategies[0]?.id ?? ""}`} className="text-primary hover:underline">Studio</Link>}>
              <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
                <Lettres lettres={f.segmentation.lettres} sansReponse />
                {f.segmentation.mouvement && <span className="text-muted-foreground"><b className="font-medium text-success">{f.segmentation.mouvement.bVersA}</b> de B à A · <b className="font-medium text-destructive">{f.segmentation.mouvement.aPerdus}</b> A perdu{f.segmentation.mouvement.aPerdus > 1 ? "s" : ""}</span>}
              </div>
              {f.segmentation.decideurs.length > 0 && (
                <div className="overflow-x-auto border-t border-border">
                  <table className="w-full text-sm">
                    <thead className={THEAD}><tr><th className={`sticky left-0 bg-card ${TH}`}>Décideur H</th><th className={TH}>Établissement</th><th className={`${TH} text-right`}>Vu / requis</th></tr></thead>
                    <tbody>{f.segmentation.decideurs.map((d) => (
                      <tr key={d.doctorId} className="border-t border-border/60"><td className="sticky left-0 max-w-[14rem] truncate bg-card px-3 py-2"><Link href={`/praticiens/${d.doctorId}`} className="hover:underline">{d.nom}</Link></td><td className="max-w-[16rem] truncate px-3 py-2 text-muted-foreground">{d.etablissement ?? "—"}</td><td className={`${TD} ${d.vus < d.requis ? "text-warning" : ""}`}>{d.vus} / {d.requis}</td></tr>
                    ))}</tbody>
                  </table>
                </div>
              )}
            </Carte>
          ) : voit.segmentation ? <Carte titre="Prescripteurs"><Vide>Classé dans aucune stratégie de segmentation active.</Vide></Carte> : null}
          {f.voix && (
            <Carte titre="Voix du terrain" sousTitre={<>{f.voix.rapports} rapport{f.voix.rapports > 1 ? "s" : ""} · 60 jours <InfoBulle>Comptes rendus des visites où le produit a été présenté, rangés par mots-clés ; la citation est copiée mot pour mot.</InfoBulle></>}>
              {f.voix.groupes.length === 0 ? <Vide>Aucun rapport à ranger.</Vide> : (
                <ul className="divide-y divide-border text-sm">{f.voix.groupes.map((g) => (
                  <li key={g.categorie} className="px-4 py-2.5"><b className="font-medium first-letter:uppercase">{CATEGORIE_VOIX_LABELS[g.categorie]}</b> <span className="text-xs text-muted-foreground">· {g.rapports} rapport{g.rapports > 1 ? "s" : ""} · {g.delegues} délégué{g.delegues > 1 ? "s" : ""}</span>{g.citation && <span className="block text-muted-foreground">« {g.citation.texte}{g.citation.coupe ? "…" : ""} »</span>}</li>
                ))}</ul>
              )}
            </Carte>
          )}
        </>
      )}

      {onglet === "marketing" && f.marketing && (
        <>
          {f.marketing.messages && (
            <Carte titre="Messages" sousTitre={<>cycle {cycleTxt} <InfoBulle>Porté : nombre de visites de ce cycle où le message a été retenu, dans votre portée.</InfoBulle></>} action={<Link href="/marketing-cockpit" className="text-primary hover:underline">Cockpit</Link>}>
              {f.marketing.messages.length === 0 ? <Vide>Aucun message pré-défini pour ce produit.</Vide> : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className={THEAD}><tr><th className={`sticky left-0 bg-card ${TH}`}>Message</th><th className={`${TH} text-right`}>Porté</th><th className={`${TH} text-right`}>Délégués</th></tr></thead>
                    <tbody>{f.marketing.messages.map((m) => (
                      <tr key={m.id} className={`border-t border-border/60 ${m.actif ? "" : "text-muted-foreground"}`}><td className="sticky left-0 max-w-[18rem] truncate bg-card px-3 py-2">{m.titre}{!m.actif && " (inactif)"}</td><td className={TD}>{m.portes}</td><td className={TD}>{m.delegues}{f.marketing!.deleguesAssignes ? ` / ${f.marketing!.deleguesAssignes}` : ""}</td></tr>
                    ))}</tbody>
                  </table>
                </div>
              )}
            </Carte>
          )}
          {f.marketing.materiel && (
            <Carte titre="Matériel promotionnel" action={<Link href="/stock-promotionnel" className="text-primary hover:underline">Stock promotionnel</Link>}>
              {f.marketing.materiel.length === 0 ? <Vide>Aucun matériel promotionnel pour ce produit.</Vide> : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className={THEAD}><tr><th className={`sticky left-0 bg-card ${TH}`}>Article</th><th className={`${TH} text-right`}>En stock</th><th className={`${TH} text-right`}>Remis ce cycle</th></tr></thead>
                    <tbody>{f.marketing.materiel.map((m) => (
                      <tr key={m.id} className={`border-t border-border/60 ${m.actif ? "" : "text-muted-foreground"}`}><td className="sticky left-0 max-w-[18rem] truncate bg-card px-3 py-2">{m.nom}</td><td className={TD}>{entier(m.stock)}</td><td className={TD}>{entier(m.remisCycle)}</td></tr>
                    ))}</tbody>
                  </table>
                </div>
              )}
            </Carte>
          )}
        </>
      )}

      {onglet === "adpro" && f.adpro && (
        <Carte titre="Ad & Pro · 12 mois" sousTitre={<>{montantCourt(f.adpro.montant)} DZD{f.adpro.partHabPct !== null ? ` · ${f.adpro.partHabPct} % sur H·A·B` : ""} <InfoBulle>Montant : la part imputée au produit (saisie, ou part × montant accordé — jamais une estimation). Médecins : ceux reliés à la demande et les invités du congrès, par lettre du produit. Part H·A·B : montant des actions nominatives × part de leurs médecins H, A ou B.</InfoBulle></>}>
          <TableAdPro a={f.adpro} />
          {f.adpro.postesSansMontant > 0 && <p className="border-t border-border px-4 py-2 text-xs text-warning">{f.adpro.postesSansMontant} poste(s) sans part ni montant : non compté(s).</p>}
        </Carte>
      )}

      {onglet === "reglementaire" && (
        <>
          {voit.reglementaire && (f.dossiers.length === 0 ? <Carte titre="Dossier réglementaire"><Vide>Aucun dossier visible.</Vide></Carte> : f.dossiers.map((d) => (
            <Carte key={d.id} titre={`Dossier ${d.reference}`} sousTitre={<Pastille ton={REGULATORY_STATUS[d.statut]?.tone === "success" ? "success" : REGULATORY_STATUS[d.statut]?.tone === "danger" ? "danger" : "info"}>{REGULATORY_STATUS[d.statut]?.label ?? d.statut}</Pastille>} action={<Link href={`/regulatory/${d.id}`} className="text-primary hover:underline">Ouvrir le dossier</Link>}>
              <Dl items={[
                ["Nom commercial", d.nomCommercial],
                ["Détenteur de la DE", d.detenteurDe],
                ["Décision d'enregistrement", d.dateDecision ? jour(d.dateDecision) : d.statut === "DECISION_OBTAINED" ? "date non renseignée" : "—"],
                ["Renouvellement", d.echeance ? `dépôt avant le ${jour(d.echeance.depotAvant)} · expire le ${jour(d.echeance.expiration)}` : "—"],
                ["Cible d'enregistrement", d.cibleEnregistrement ? jour(d.cibleEnregistrement) : "—"],
                ["Laboratoire partenaire", d.laboPartenaire],
                ["Classe thérapeutique", d.classeTherapeutique],
                ["Fabrication", `${MANUFACTURING_STATUS[d.statutFabrication] ?? d.statutFabrication}${d.fabricant ? ` · ${d.fabricant}` : ""}`],
              ]} />
              {d.variations.length > 0 && (
                <div className="border-t border-border px-4 py-3 text-sm">
                  <p className="mb-1 text-xs font-medium text-muted-foreground">Variations</p>
                  {d.variations.map((v) => <p key={v.id}>{MANUFACTURING_STATUS[v.vers] ?? v.vers} · {VARIATION_STATUS[v.statut]?.label ?? v.statut}{v.depot ? ` · déposée le ${jour(v.depot)}` : ""}{v.decision ? ` · décision le ${jour(v.decision)}` : ""}</p>)}
                </div>
              )}
            </Carte>
          )))}
          {voit.reglementaire && f.dossiersMasques > 0 && <p className="text-xs text-muted-foreground">{f.dossiersMasques} autre(s) dossier(s) hors de votre portée.</p>}

          {f.declarationsInfoMed && (
            <Carte titre="Information médicale" sousTitre={`${f.declarationsInfoMed.length} déclaration${f.declarationsInfoMed.length > 1 ? "s" : ""}`}>
              {f.declarationsInfoMed.length === 0 ? <Vide>Aucune déclaration liée à ce produit.</Vide> : (
                <ul className="divide-y divide-border text-sm">{f.declarationsInfoMed.map((x) => (
                  <li key={x.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2">
                    <span>
                      <Link href={`/information-medicale/${x.id}`} className="font-mono text-xs text-primary hover:underline">{x.reference}</Link>{" "}
                      {x.label} <span className="text-muted-foreground">· {x.nature} · {jour(x.date)}</span>
                    </span>
                    <span className="text-xs text-muted-foreground">{MEDICAL_INFO_STATUS[x.statut]?.label ?? x.statut}</span>
                  </li>
                ))}</ul>
              )}
            </Carte>
          )}

          {f.pv && (
            <Carte titre="Pharmacovigilance" sousTitre={`${f.pv.filter((x) => x.statut !== "CLOS").length} ouvert(s)`}>
              {f.pv.length === 0 ? <Vide>Aucun cas signalé.</Vide> : (
                <ul className="divide-y divide-border text-sm">{f.pv.map((x) => (
                  <li key={x.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2">
                    <span><Link href={x.href} className="font-mono text-xs text-primary hover:underline">{x.reference}</Link> <span className="text-muted-foreground">· survenu le {jour(x.survenu)}{x.gravite && estGravitePv(x.gravite) ? ` · ${GRAVITE_PV[x.gravite].label.toLowerCase()}` : ""}</span></span>
                    {estStatutPv(x.statut) && <Pastille ton={x.statut === "CLOS" ? "neutral" : "warning"}>{STATUT_PV[x.statut].label}</Pastille>}
                  </li>
                ))}</ul>
              )}
            </Carte>
          )}

          {canonique && (
            <Carte titre="Identité, alias et historique" sousTitre={<InfoBulle>L&apos;identité (DCI, dosage, forme, conditionnement) se corrige sur le dossier : le produit suit. Ici se règlent le nom et les alias — un alias retrouve le produit juste après sa référence.</InfoBulle>}>
              <Dl items={[["DCI", canonique.dci], ["Dosage", f.identite.dosage], ["Forme", f.identite.forme], ["Conditionnement", canonique.packaging], ["Code", canonique.code], ["Profils BU", canonique.produitsBu.map((b) => b.bu ? `${b.name} (${b.bu})` : b.name).join(", ") || "—"]]} />
              <div className="space-y-3 border-t border-border px-4 py-3">
                {userCan(user, "REGULATORY", "UPDATE") ? (
                  <>
                    <RenommerProduit id={canonique.id} nom={canonique.canonicalName} />
                    <AliasProduit id={canonique.id} aliases={canonique.aliases.map((a) => ({ id: a.id, label: a.label }))} />
                  </>
                ) : <p className="text-sm">Alias : {canonique.aliases.map((a) => a.label).join(", ") || "aucun"}</p>}
              </div>
              {canonique.historique.length > 0 && (
                <details className="border-t border-border">
                  <summary className="cursor-pointer px-4 py-2 text-xs font-medium text-muted-foreground">Historique ({canonique.historique.length})</summary>
                  <ul className="divide-y divide-border px-4 pb-2 text-sm">{canonique.historique.map((h) => <li key={h.id} className="py-1.5">{h.summary}<span className="block text-xs text-muted-foreground">{h.createdAt.toLocaleDateString("fr-FR")}{h.acteur ? ` · ${h.acteur}` : ""}</span></li>)}</ul>
                </details>
              )}
            </Carte>
          )}
        </>
      )}

      {onglet === "documents" && (
        <>
          {await Promise.all(f.dossiers.map(async (d, i) => (
            <Carte key={d.id} titre={`Fichiers — ${d.reference}`}>
              <div className="p-4">
                <ProductDriveExplorer user={user} rootId={await dossierDriveAffiche({ id: d.id, reference: d.reference, dci: f.identite.dci })}
                  folderId={i === 0 ? searchParams?.dossier ?? null : null} basePath={`/produits/${id}`} canEdit={userCan(user, "REGULATORY", "UPDATE")} />
              </div>
            </Carte>
          )))}
        </>
      )}
    </div>
  );
}
