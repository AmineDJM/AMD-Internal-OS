import Link from "next/link";
import { redirect } from "next/navigation";
import { Radar } from "lucide-react";
import { requireUser } from "@/lib/session";
import { vueInfluence, type VueInfluence } from "@/lib/queries/influence";
import { vueRoi, type VueRoi, type ActionRoi } from "@/lib/queries/roi-adpro";
import { FENETRES_MOIS, LIBELLE_APPARIEMENT, lireFenetre, type Effet } from "@/lib/roi-adpro/mesure";
import { LIBELLE_RELATION } from "@/lib/influence/relations";
import { LIBELLE_RAISON_ND } from "@/lib/influence/parts-lots";
import type { VuePartsLots } from "@/lib/queries/parts-lots";
import { LETTRES, STATUT_LABELS, type Lettre, type Statut } from "@/lib/segmentation/regles";
import { LIBELLE_ROLE_MEDECIN, TYPES_MEDECINS_CONCERNES, LIBELLE_NATURE_DEMANDE } from "@/lib/ad-pro/medecins-concernes";
import { LettreBadge } from "@/app/(app)/segmentation/lettre-badge";
import { InfoBulle } from "@/components/ui/info-bulle";
import { cn } from "@/lib/utils";
import { GrapheService } from "./graphe-service";
import { DecisionLien, RelancerAnalyse } from "./gestes";

export const metadata = { title: "Intelligence terrain — AMD Internal OS" };
export const dynamic = "force-dynamic";

/**
 * INTELLIGENCE TERRAIN — le graphe d'influence hospitalière (powered by Luna) et le ROI Ad & Pro (Direction, 10/2026 :
 * « uniquement dans la console d'administration, visible uniquement par le Super Administrateur »). Tire les données de
 * toute la plateforme : rapports des délégués, Segmentation, besoins des services, demandes Ad & Pro, ventes PCH.
 */

type Params = Record<string, string | string[] | undefined>;
const un = (p: Params | undefined, k: string): string | null => {
  const v = p?.[k];
  const s = Array.isArray(v) ? v[0] : v;
  return s && s.trim() ? s.trim() : null;
};

const CHEMIN = "/admin/intelligence-terrain";
const nb = (n: number) => Math.round(n).toLocaleString("fr-FR").replace(/[  ]/g, " ");
const montant = (n: number | null) => (n === null ? "n/d" : n >= 1e6 ? `${(n / 1e6).toFixed(1).replace(".", ",")} M` : nb(n));
const jour = (d: Date) => d.toLocaleDateString("fr-FR", { timeZone: "Africa/Algiers", day: "2-digit", month: "2-digit", year: "numeric" });
const signe = (x: number, dec = 1) => `${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.abs(x).toFixed(dec).replace(".", ",")}`;
const TH = "whitespace-nowrap px-3 py-2 text-left text-xs font-medium text-muted-foreground";
const TD = "whitespace-nowrap px-3 py-2";

function Lettre_({ l }: { l: string | null }) {
  if (!l || !(LETTRES as readonly string[]).includes(l)) return <span className="text-muted-foreground">—</span>;
  return <LettreBadge lettre={l as Lettre} />;
}
const statutLibelle = (s: string | null) => (s && s in STATUT_LABELS ? STATUT_LABELS[s as Statut] : "—");

export default async function IntelligenceTerrainPage(props: { searchParams?: Promise<Params> }) {
  const searchParams = await props.searchParams;
  const user = await requireUser();
  // RÉSERVÉ AU SUPER ADMINISTRATEUR — aucun droit de module ne l'ouvre à un autre rôle.
  if (user.role !== "SUPER_ADMIN") redirect("/dashboard?denied=ADMIN");

  const onglet = un(searchParams, "onglet") === "roi" ? "roi" : "influence";
  const lienOnglet = (o: string) => `${CHEMIN}?onglet=${o}`;
  // Les données d'abord (un seul onglet est lu), le rendu ensuite.
  const vInfluence = onglet === "influence"
    ? await vueInfluence({ etabId: un(searchParams, "etab"), serviceId: un(searchParams, "service"), productId: un(searchParams, "produit"), medecinId: un(searchParams, "medecin") })
    : null;
  const vRoi = onglet === "roi"
    ? await vueRoi({ fenetre: lireFenetre(un(searchParams, "fenetre")), productId: un(searchParams, "produit"), nature: un(searchParams, "nature"), medecinId: un(searchParams, "medecin") })
    : null;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-violet-500/10 text-violet-600 dark:text-violet-300"><Radar className="h-6 w-6" /></span>
          <div>
            <h1 className="flex items-center gap-1.5 text-2xl font-semibold tracking-tight">
              Intelligence terrain
              <InfoBulle label="À propos : Intelligence terrain">
                Réservé au Super Administrateur. Tire les rapports des délégués, la Segmentation, les besoins des services, les
                demandes Ad &amp; Pro et les ventes PCH. Les liens lus par Luna sont proposés, jamais appliqués ; aucun statut
                n&apos;est changé ici.
              </InfoBulle>
            </h1>
            <p className="text-sm text-muted-foreground">Qui décide, qui influence — et ce que rapporte l&apos;Ad &amp; Pro.</p>
          </div>
        </div>
        <Link href="/admin" className="text-sm text-muted-foreground hover:underline">← Administration</Link>
      </div>

      <nav className="flex w-fit max-w-full gap-1.5 overflow-x-auto rounded-xl border border-border bg-card p-1" aria-label="Onglets">
        {[["influence", "Influence"], ["roi", "ROI Ad & Pro"]].map(([k, l]) => (
          <Link key={k} href={lienOnglet(k)} aria-current={onglet === k ? "page" : undefined}
            className={cn("whitespace-nowrap rounded-lg px-3.5 py-2 text-sm font-semibold", onglet === k ? "bg-foreground text-background" : "text-muted-foreground hover:bg-secondary")}>
            {l}
          </Link>
        ))}
      </nav>

      {vInfluence && <OngletInfluence v={vInfluence} />}
      {vRoi && <OngletRoi v={vRoi} nature={un(searchParams, "nature")} produitId={un(searchParams, "produit")} />}
    </div>
  );
}

function Carte({ titre, info, droite, children, className }: { titre: React.ReactNode; info?: React.ReactNode; droite?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn("surface min-w-0 overflow-hidden rounded-xl", className)}>
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <h2 className="flex items-center gap-1.5 text-[15px] font-semibold">{titre}{info && <InfoBulle label="Plus d'informations">{info}</InfoBulle>}</h2>
        {droite}
      </header>
      {children}
    </section>
  );
}

const SELECT = "h-9 min-w-0 rounded-lg border border-border bg-card px-2 text-sm";

// ─────────────────────────── Part de nos lots ───────────────────────────

/**
 * LA PART DE NOS LOTS dans ce que les DR de la PCH ont livré à l'établissement (12 derniers mois reçus). Le niveau le plus fin
 * des fichiers de la PCH est l'ÉTABLISSEMENT : aucun volume par service — c'est dit sur la carte. « n/d » quand le lot manque.
 */
function PartsLots({ p }: { p: VuePartsLots }) {
  const periode = p.periode ? `${p.periode.debut} → ${p.periode.fin}` : "";
  if (!p.periode) {
    return (
      <Carte titre={<>Part de nos lots — {p.etablissement}</>}>
        <p className="px-4 py-4 text-sm text-muted-foreground">n/d — aucune vente PCH de nos produits n&apos;est rattachée à cet établissement (fichiers Ventes PCH).</p>
      </Carte>
    );
  }
  return (
    <Carte titre={<>Part de nos lots — {p.etablissement}</>}
      info={`Boîtes livrées à l'établissement par les directions régionales de la PCH (${periode}), dont le numéro de lot est l'un de ceux de nos livraisons à la PCH. Seules les lignes qui portent un lot comptent ; « n/d » quand les fichiers n'en donnent pas ou que nos numéros de lot ne sont pas renseignés. Les fichiers de la PCH s'arrêtent à l'établissement : aucun volume par service n'existe.`}
      droite={<span className="text-xs text-muted-foreground">établissement · pas de volume par service</span>}>
      <div className="overflow-x-auto [-webkit-overflow-scrolling:touch]">
        <table className="w-full text-sm">
          <thead className="bg-muted/40"><tr className="border-b border-border">
            <th className={cn(TH, "sticky left-0 z-[1] bg-card")}>Produit</th><th className={cn(TH, "text-right")}>Livré (bt)</th>
            <th className={cn(TH, "text-right")}>Lot renseigné</th><th className={cn(TH, "text-right")}>De nos lots</th><th className={cn(TH, "text-right")}>Part</th>
          </tr></thead>
          <tbody>
            {p.lignes.length === 0 && <tr><td colSpan={5} className="px-3 py-4 text-muted-foreground">Aucune livraison de nos produits à cet établissement sur la période.</td></tr>}
            {p.lignes.map((l) => (
              <tr key={l.productId} className="border-b border-border last:border-b-0">
                <td className={cn(TD, "sticky left-0 z-[1] bg-card font-medium")}>{l.nom}</td>
                <td className={cn(TD, "text-right tabular-nums")}>{nb(l.livre)}</td>
                <td className={cn(TD, "text-right tabular-nums")}>{l.couvertureLot === null ? "n/d" : `${l.couvertureLot} %`}</td>
                <td className={cn(TD, "text-right tabular-nums")}>{l.part === null ? "n/d" : nb(l.livreNosLots)}</td>
                <td className={cn(TD, "text-right")} title={l.raison ? LIBELLE_RAISON_ND[l.raison] : undefined}>
                  {l.part === null
                    ? <span className="text-muted-foreground">n/d{l.raison ? <span className="block text-[11px]">{LIBELLE_RAISON_ND[l.raison]}</span> : null}</span>
                    : <span className="font-semibold tabular-nums">{l.part} %</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
        {nb(p.lotsRenseignes)} ligne(s) de livraison de nos commandes portent un numéro de lot. Les fichiers de la PCH s&apos;arrêtent à l&apos;établissement : pas de volume par service.
      </p>
    </Carte>
  );
}

// ─────────────────────────── Influence ───────────────────────────

function OngletInfluence({ v }: { v: VueInfluence }) {
  const q = (extra: Record<string, string | null>) => {
    const p = new URLSearchParams({ onglet: "influence" });
    for (const [k, val] of Object.entries({ etab: v.etabId, service: v.serviceId, produit: v.produit?.id ?? null, ...extra })) if (val) p.set(k, val);
    return `${CHEMIN}?${p.toString()}`;
  };
  const b = v.analyse.bilan;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3 text-sm">
        <span className="text-muted-foreground">
          {v.analyse.le ? <>Dernière analyse le {jour(v.analyse.le)}{b ? ` · ${b.rapportsLus} rapport(s) lu(s), ${b.liensProposes} lien(s) proposé(s)${b.luna === "INDISPONIBLE" ? " · Luna indisponible" : ""}` : ""}</> : "Aucune analyse encore — lancez-la."}
        </span>
        <RelancerAnalyse />
      </div>

      <form method="get" action={CHEMIN} className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="onglet" value="influence" />
        <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">Établissement
          <select name="etab" defaultValue={v.etabId ?? ""} className={SELECT}>
            {v.etablissements.map((e) => <option key={e.id} value={e.id}>{e.nom} ({e.n})</option>)}
          </select>
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">Service
          <select name="service" defaultValue={v.serviceId ?? ""} className={SELECT}>
            <option value="">Les plus peuplés</option>
            {v.services.map((s) => <option key={s.id} value={s.id}>{s.nom}</option>)}
          </select>
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">Produit
          <select name="produit" defaultValue={v.produit?.id ?? ""} className={SELECT}>
            <option value="">—</option>
            {v.produits.map((p) => <option key={p.id} value={p.id}>{p.nom}</option>)}
          </select>
        </label>
        <button type="submit" className="h-9 rounded-lg border border-border bg-card px-3 text-sm font-medium hover:bg-secondary">Voir</button>
      </form>

      {v.graphes.length === 0 && (
        <p className="rounded-xl border border-border bg-card px-4 py-5 text-sm text-muted-foreground">
          {v.etabId ? "Aucun service de cet établissement n'a au moins deux praticiens rattachés." : "Aucun établissement avec des praticiens rattachés."}
        </p>
      )}

      {v.graphes.map((g) => (
        <div key={g.serviceId} className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
          <Carte
            titre={g.nom}
            info="Traits pleins : hiérarchie du service et liens confirmés. Pointillés violets : liens lus par Luna dans un rapport, à confirmer. Couleur = lettre de Segmentation. Un clic ouvre son réseau."
            droite={g.besoin ? <span className="rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary">besoin {g.besoin.annee} : {nb(g.besoin.quantite)} bt</span> : undefined}>
            <div className="px-2 py-2"><GrapheService g={g} lien={(id) => q({ medecin: id })} /></div>
            {g.masques > 0 && <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">+{g.masques} praticien(s) non affiché(s)</p>}
          </Carte>
          <Carte titre={v.produit ? `Pour entrer avec ${v.produit.nom}` : "Pour entrer dans ce service"}
            info="Ordre proposé : le décideur d'abord, puis celui qui influence les prescripteurs, puis la pharmacie. Un rôle sans titulaire est sauté.">
            {g.ordre.length === 0 ? <p className="px-4 py-4 text-sm text-muted-foreground">Ni décideur, ni influenceur, ni pharmacie identifiés.</p> : (
              <ol>
                {g.ordre.map((o, i) => (
                  <li key={o.doctorId} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-b border-border px-4 py-2.5 text-sm last:border-b-0">
                    <Lettre_ l={o.lettre} />
                    <div className="min-w-0">
                      <Link href={q({ medecin: o.doctorId })} className="font-medium hover:underline">{i + 1}. {o.nom}</Link>
                      <span className="block text-xs text-muted-foreground">{o.pourquoi}</span>
                    </div>
                    {i === 0 && <span className="rounded-full bg-warning/10 px-2 py-0.5 text-xs font-medium text-warning">priorité</span>}
                  </li>
                ))}
              </ol>
            )}
          </Carte>
        </div>
      ))}

      {v.partsLots && <PartsLots p={v.partsLots} />}

      {v.detail && (
        <Carte titre={<>Son réseau — {v.detail.nom}</>} droite={
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-violet-500/10 font-bold text-violet-600 dark:text-violet-300" title="Score d'influence">{v.detail.score}</span>
        }>
          <p className="border-b border-border px-4 py-2 text-xs text-muted-foreground">
            {[v.detail.service, v.detail.etablissement].filter(Boolean).join(", ") || "Sans établissement"} · {statutLibelle(v.detail.statut)} · lettre {v.detail.lettre ?? "—"}
          </p>
          <div className="grid grid-cols-1 gap-0 md:grid-cols-2">
            <ul className="border-b border-border md:border-b-0 md:border-r">
              {v.detail.raisons.length === 0 && <li className="px-4 py-3 text-sm text-muted-foreground">Aucun signal d&apos;influence mesuré.</li>}
              {v.detail.raisons.map((r) => (
                <li key={r.code} className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 border-b border-border px-4 py-2 text-sm last:border-b-0">
                  <div className="min-w-0"><span className="font-medium">{r.libelle}</span><span className="block text-xs text-muted-foreground">{r.detail}</span></div>
                  <span className="text-muted-foreground">+{r.points}</span>
                </li>
              ))}
            </ul>
            <div className="overflow-x-auto [-webkit-overflow-scrolling:touch]">
              <table className="w-full text-sm">
                <thead className="bg-muted/40"><tr className="border-b border-border"><th className={TH}>Relié à</th><th className={TH}>Lien</th><th className={TH}>Source</th></tr></thead>
                <tbody>
                  {v.detail.liens.length === 0 && <tr><td colSpan={3} className="px-3 py-3 text-muted-foreground">Aucun lien.</td></tr>}
                  {v.detail.liens.map((l, i) => (
                    <tr key={i} className="border-b border-border last:border-b-0">
                      <td className={TD}><Link href={q({ medecin: l.autre.id })} className="hover:underline">{l.autre.nom}</Link></td>
                      <td className={TD}>{l.sens === "SORTANT" ? "→ " : "← "}{LIBELLE_RELATION[l.type] ?? l.type}</td>
                      <td className={cn(TD, "text-muted-foreground")}>{l.source === "STRUCTURE" ? "structure" : l.source === "LUNA" ? "Luna" : "saisie"}{l.statut === "PROPOSEE" ? " · à confirmer" : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </Carte>
      )}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Carte titre="Influenceurs — toute la plateforme"
          info="Score 0–100 expliqué (rôle, orateur, citations, volume, réseau). « Passer en Influenceur ? » est une suggestion : le statut se change dans la Segmentation, par une personne.">
          <div className="overflow-x-auto [-webkit-overflow-scrolling:touch]">
            <table className="w-full text-sm">
              <thead className="bg-muted/40"><tr className="border-b border-border">
                <th className={cn(TH, "sticky left-0 z-[1] bg-card")}>Praticien</th><th className={TH}>Statut</th><th className={TH}>Lettre</th><th className={cn(TH, "text-right")}>Influence</th><th className={TH}>Suggestion</th>
              </tr></thead>
              <tbody>
                {v.top.length === 0 && <tr><td colSpan={5} className="px-3 py-4 text-muted-foreground">Aucun score — lancez l&apos;analyse.</td></tr>}
                {v.top.map((t) => (
                  <tr key={t.doctorId} className="border-b border-border last:border-b-0">
                    <td className={cn(TD, "sticky left-0 z-[1] bg-card")}>
                      <Link href={q({ medecin: t.doctorId })} className="font-medium hover:underline">{t.nom}</Link>
                      <span className="block text-xs text-muted-foreground">{t.raisons.join(" · ") || t.etablissement || ""}</span>
                    </td>
                    <td className={TD}>{statutLibelle(t.statut)}</td>
                    <td className={TD}><Lettre_ l={t.lettre} /></td>
                    <td className={cn(TD, "text-right font-semibold tabular-nums")}>{t.score}</td>
                    <td className={TD}>
                      {t.suggestion
                        ? (t.lienSegmentation
                          ? <Link href={t.lienSegmentation} className="rounded-full bg-violet-500/10 px-2.5 py-0.5 text-xs font-medium text-violet-600 hover:underline dark:text-violet-300">passer en Influenceur ?</Link>
                          : <span className="rounded-full bg-violet-500/10 px-2.5 py-0.5 text-xs font-medium text-violet-600 dark:text-violet-300">passer en Influenceur ? · hors panel</span>)
                        : <span className="text-muted-foreground">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Carte>

        <Carte titre={`Liens proposés par Luna (${v.file.length})`}
          info="Chaque lien vient d'un rapport de visite, avec sa citation mot pour mot. « À vérifier » : un nom n'a été rapproché de l'annuaire que par le nom de famille. Confirmé, il pèse 1 dans le score ; proposé, sa confiance × 0,5 ; rejeté, plus rien.">
          {v.file.length === 0 ? <p className="px-4 py-4 text-sm text-muted-foreground">Rien à trancher.</p> : (
            <ul>
              {v.file.map((l) => (
                <li key={l.id} className="space-y-1.5 border-b border-border px-4 py-3 text-sm last:border-b-0">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <Link href={q({ medecin: l.de.id })} className="font-medium hover:underline">{l.de.nom}</Link>
                    <span className="text-muted-foreground">{LIBELLE_RELATION[l.type] ?? l.type} →</span>
                    <Link href={q({ medecin: l.vers.id })} className="font-medium hover:underline">{l.vers.nom}</Link>
                    <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{Math.round(l.confiance * 100)} %</span>
                    {l.rapprochement === "A_VERIFIER" && <span className="rounded-full bg-warning/10 px-2 py-0.5 text-xs font-medium text-warning">à vérifier</span>}
                  </div>
                  {l.citation && <blockquote className="border-l-2 border-violet-500/50 pl-2 text-xs italic text-muted-foreground">« {l.citation} »{l.rapportHref ? <> — <Link href={l.rapportHref} className="not-italic hover:underline">{l.rapportLibelle}</Link></> : ` — ${l.rapportLibelle}`}</blockquote>}
                  <DecisionLien relationId={l.id} />
                </li>
              ))}
            </ul>
          )}
        </Carte>
      </div>
    </div>
  );
}

// ─────────────────────────── ROI Ad & Pro ───────────────────────────

function EffetCellule({ e, unite, dec = 1 }: { e: Effet | null; unite: string; dec?: number }) {
  if (!e) return <span className="text-muted-foreground">n/d</span>;
  if (e.statut === "EN_ATTENTE") return <span className="text-muted-foreground">—</span>;
  if (e.statut === "PEU_DE_DONNEES" || e.effet === null) return <span className="text-xs text-muted-foreground" title={`${e.nExposes} touché(s) mesurable(s), ${e.nComparables} comparable(s)`}>pas assez de données</span>;
  return (
    <span title={`${e.nExposes} touché(s) vs ${e.nComparables} comparable(s)`}>
      <span className={cn("font-semibold", e.effet > 0 ? "text-success" : e.effet < 0 ? "text-destructive" : "")}>{signe(e.effet, dec)} {unite}</span>
      {e.bas !== null && e.haut !== null && <span className="block text-[11px] text-muted-foreground">{signe(e.bas, dec)} / {signe(e.haut, dec)}</span>}
    </span>
  );
}

function statutAction(a: ActionRoi): { texte: string; ton: string } {
  if (a.medecins.length === 0) return { texte: "non nominatif", ton: "bg-muted text-muted-foreground" };
  if (a.enAttente) return { texte: `mesure le ${jour(a.disponibleLe)}`, ton: "bg-muted text-muted-foreground" };
  const ok = [a.affinite, a.consommation].some((e) => e?.statut === "MESURE");
  return ok ? { texte: "mesuré", ton: "bg-success/10 text-success" } : { texte: "peu de données", ton: "bg-warning/10 text-warning" };
}

function OngletRoi({ v, nature, produitId }: { v: VueRoi; nature: string | null; produitId: string | null }) {
  const q = (extra: Record<string, string | null>) => {
    const p = new URLSearchParams({ onglet: "roi", fenetre: String(v.fenetre) });
    for (const [k, val] of Object.entries({ nature, produit: produitId, ...extra })) if (val) p.set(k, val);
    return `${CHEMIN}?${p.toString()}`;
  };
  return (
    <div className="space-y-5">
      <form method="get" action={CHEMIN} className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="onglet" value="roi" />
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">Fenêtre
          <select name="fenetre" defaultValue={String(v.fenetre)} className={SELECT}>
            {FENETRES_MOIS.map((f) => <option key={f} value={f}>{f} mois</option>)}
          </select>
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">Produit
          <select name="produit" defaultValue={produitId ?? ""} className={SELECT}>
            <option value="">Tous</option>
            {v.produits.map((p) => <option key={p.id} value={p.id}>{p.nom}</option>)}
          </select>
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">Nature
          <select name="nature" defaultValue={nature ?? ""} className={SELECT}>
            <option value="">Toutes</option>
            {TYPES_MEDECINS_CONCERNES.map((n) => <option key={n} value={n}>{LIBELLE_NATURE_DEMANDE[n]}</option>)}
          </select>
        </label>
        <button type="submit" className="h-9 rounded-lg border border-border bg-card px-3 text-sm font-medium hover:bg-secondary">Voir</button>
      </form>

      <Carte titre="Effet mesuré par action"
        info={`Avant / après (${v.fenetre} mois) comparé à des médecins semblables non touchés (même spécialité, zone, lettre, statut ; desserré si trop peu) : différence des différences, fourchette à 95 %. Affinité = patients sur 10 sous le produit (Q2/Q1), en points. Consommation = boîtes livrées par les DR à leurs établissements, pour les produits de l'action. Visites = l'effort terrain sur la même période, à isoler. « Pas assez de données » sous 3 touchés ou 10 comparables.`}>
        <div className="overflow-x-auto [-webkit-overflow-scrolling:touch]">
          <table className="w-full text-sm">
            <thead className="bg-muted/40"><tr className="border-b border-border">
              <th className={cn(TH, "sticky left-0 z-[1] bg-card")}>Action</th><th className={TH}>Date</th><th className={cn(TH, "text-right")}>Coût</th>
              <th className={TH}>Touchés</th><th className={cn(TH, "text-right")}>Affinité</th><th className={TH}>Lettres</th>
              <th className={cn(TH, "text-right")}>Consommation</th><th className={cn(TH, "text-right")}>Visites</th><th className={TH}>Statut</th>
            </tr></thead>
            <tbody>
              {v.actions.length === 0 && <tr><td colSpan={9} className="px-3 py-4 text-muted-foreground">Aucune action Ad &amp; Pro sur 24 mois.</td></tr>}
              {v.actions.slice(0, 120).map((a) => {
                const st = statutAction(a);
                return (
                  <tr key={a.cle} className="border-b border-border last:border-b-0">
                    <td className={cn(TD, "sticky left-0 z-[1] max-w-[260px] bg-card")}>
                      <Link href={a.href} className="block truncate font-medium hover:underline">{a.nom}</Link>
                      <span className="block text-xs text-muted-foreground">{a.natureLibelle}{a.produits.length ? ` · ${a.produits.map((p) => p.nom).join(", ")}` : ""}</span>
                    </td>
                    <td className={TD}>{jour(a.date)}</td>
                    <td className={cn(TD, "text-right tabular-nums")}>{montant(a.cout)}</td>
                    <td className={TD}>
                      {a.medecins.length === 0 ? <span className="text-muted-foreground">—</span> : (
                        <span className="flex flex-wrap gap-1">{Object.entries(a.parLettre).map(([l, n]) => <span key={l} className="text-xs">{n}×{l}</span>)}</span>
                      )}
                    </td>
                    <td className={cn(TD, "text-right")}><EffetCellule e={a.affinite} unite="pts" /></td>
                    <td className={TD}>
                      {!a.lettres ? <span className="text-muted-foreground">—</span> : a.lettres.mesurables === 0 ? <span className="text-xs text-muted-foreground">n/d</span> : (
                        <span title={`${a.lettres.hausses}/${a.lettres.mesurables} en hausse ; comparables ${a.lettres.comparablesHausses}/${a.lettres.comparablesMesurables}`}>
                          {a.lettres.resume ?? "aucune hausse"}
                          <span className="block text-[11px] text-muted-foreground">comparables : {a.lettres.comparablesHausses} sur {a.lettres.comparablesMesurables}</span>
                        </span>
                      )}
                    </td>
                    <td className={cn(TD, "text-right")}><EffetCellule e={a.consommation} unite="%" /></td>
                    <td className={cn(TD, "text-right")}><EffetCellule e={a.visites} unite="" /></td>
                    <td className={TD}>
                      <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium", st.ton)}>{st.texte}</span>
                      {!a.enAttente && a.medecins.length > 0 && <span className="block text-[11px] text-muted-foreground">{LIBELLE_APPARIEMENT[a.appariement]}</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Carte>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <Carte titre="Ce que rapporte chaque nature d'action" info="Sur 12 mois. Effet affinité : toutes les actions mesurées de la nature, ensemble. Coût par passage en A = dépense des actions mesurées ÷ médecins passés en A (ou H).">
          <div className="overflow-x-auto [-webkit-overflow-scrolling:touch]">
            <table className="w-full text-sm">
              <thead className="bg-muted/40"><tr className="border-b border-border">
                <th className={cn(TH, "sticky left-0 z-[1] bg-card")}>Nature</th><th className={cn(TH, "text-right")}>Dépensé</th><th className={cn(TH, "text-right")}>Touchés</th>
                <th className={cn(TH, "text-right")}>Effet affinité</th><th className={cn(TH, "text-right")}>Coût / passage en A</th>
              </tr></thead>
              <tbody>
                {v.natures.length === 0 && <tr><td colSpan={5} className="px-3 py-4 text-muted-foreground">Aucune action sur 12 mois.</td></tr>}
                {v.natures.map((n) => (
                  <tr key={n.nature} className="border-b border-border last:border-b-0">
                    <td className={cn(TD, "sticky left-0 z-[1] bg-card")}>{n.libelle} <span className="text-xs text-muted-foreground">({n.actions})</span></td>
                    <td className={cn(TD, "text-right tabular-nums")}>{montant(n.depense)}</td>
                    <td className={cn(TD, "text-right tabular-nums")}>{n.medecinsTouches || <span className="text-xs text-muted-foreground">non nominatif</span>}</td>
                    <td className={cn(TD, "text-right")}>{n.medecinsTouches ? <EffetCellule e={n.affinite} unite="pts" /> : <span className="text-muted-foreground">n/d</span>}</td>
                    <td className={cn(TD, "text-right tabular-nums")}>{n.coutParPassageA === null ? <span className="text-muted-foreground">n/d</span> : montant(n.coutParPassageA)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Carte>

        {v.medecin ? (
          <Carte titre={<>Ce qu&apos;il a reçu, ce qui a bougé — {v.medecin.nom}</>} droite={<Link href={q({ medecin: null })} className="text-xs text-muted-foreground hover:underline">fermer</Link>}>
            <p className="border-b border-border px-4 py-2 text-xs text-muted-foreground">
              {v.medecin.etablissement ?? "Sans établissement"} · lettre il y a 12 mois {v.medecin.lettreIlYA12Mois ?? "—"} → aujourd&apos;hui {v.medecin.lettreActuelle ?? "—"}
            </p>
            <ul>
              {v.medecin.recu.length === 0 && <li className="px-4 py-3 text-sm text-muted-foreground">Aucune action sur 24 mois.</li>}
              {v.medecin.recu.map((r) => (
                <li key={r.cle} className="border-b border-border px-4 py-2 text-sm">
                  <Link href={r.href} className="font-medium hover:underline">{r.nom}</Link>
                  <span className="block text-xs text-muted-foreground">{r.natureLibelle} · {LIBELLE_ROLE_MEDECIN[r.role]} · {jour(r.date)}</span>
                </li>
              ))}
              <li className="border-b border-border px-4 py-2 text-sm">
                <span className="font-medium">Affinité</span>
                <span className="block text-xs text-muted-foreground">
                  {v.medecin.affinite.length ? v.medecin.affinite.map((o) => `${nb(o.valeur)} % le ${jour(o.date)}${o.produit ? ` (${o.produit})` : ""}`).join(" · ") : "aucune observation"}
                </span>
              </li>
              <li className="px-4 py-2 text-sm">
                <span className="font-medium">Visites : {v.medecin.visites6m} en 6 mois</span>
                <span className="block text-xs text-muted-foreground">{v.medecin.visites6mAvant} les 6 mois d&apos;avant · message porté {v.medecin.messages6m} fois</span>
              </li>
            </ul>
          </Carte>
        ) : (
          <Carte titre="Médecins les plus touchés" info="Un clic : ce qu'il a reçu, ce qui a bougé.">
            <div className="overflow-x-auto [-webkit-overflow-scrolling:touch]">
              <table className="w-full text-sm">
                <thead className="bg-muted/40"><tr className="border-b border-border"><th className={TH}>Praticien</th><th className={TH}>Lettre</th><th className={cn(TH, "text-right")}>Actions</th></tr></thead>
                <tbody>
                  {v.touches.length === 0 && <tr><td colSpan={3} className="px-3 py-4 text-muted-foreground">Aucun médecin désigné sur les demandes.</td></tr>}
                  {v.touches.map((t) => (
                    <tr key={t.doctorId} className="border-b border-border last:border-b-0">
                      <td className={TD}><Link href={q({ medecin: t.doctorId })} className="hover:underline">{t.nom}</Link></td>
                      <td className={TD}><Lettre_ l={t.lettre} /></td>
                      <td className={cn(TD, "text-right tabular-nums")}>{t.actions}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Carte>
        )}
      </div>
    </div>
  );
}
