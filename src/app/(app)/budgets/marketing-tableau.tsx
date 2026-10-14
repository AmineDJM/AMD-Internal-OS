"use client";

/**
 * BUDGET MARKETING — LE TABLEAU DE BORD SOUS LE DISPONIBLE (maquettes validées, Direction 10/2026) : « À traiter », la
 * barre de filtres (période, catégorie, comparaison N-1) et ses exports, les six graphiques, le tableau « Par catégorie »
 * et le détail d'une catégorie. Les graphiques lisent les mêmes faits (`budget/marketing-vue.ts`).
 *
 * « Onglets » (10/2026) : le tableau se DÉPLIE en sous-catégories et lit chaque catégorie AVEC ses sous-catégories
 * (`arbreCategories`, `cumul-categories.ts`) ; « À traiter » remonte aussi les pièces manquantes et les éléments
 * « absents du fichier » de l'intégration 2026 ; « Réallouer » est borné à ce qu'une catégorie peut céder.
 */

import * as React from "react";
import Link from "next/link";
import { ArrowRight, ChevronDown, ChevronRight, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InfoBulle } from "@/components/ui/info-bulle";
import { cn } from "@/lib/utils";
import { ancreCategorieBudget } from "@/lib/chemins/budgets";
import {
  LIBELLE_SANTE, alertesBudget, arbreCategories, demandesDeLaCategorie, periodesProposees, propositionReallocation, tetesDeLArbre, vueFiltree,
  type Alerte, type CategorieBrute, type DonneesMarketing, type Filtres, type NoeudArbre, type ResteIntegration,
} from "@/lib/budget/marketing-vue";
import { GraphiquesMarketing, couleurDeCategorie, fmt, useCouleurs, type RegistreExports } from "./marketing-graphiques";
import { ReallouerSheet, type DemandeReallocation } from "./marketing-reallouer";

export interface Reallocation { le: string; par: string | null; resume: string }

const TH = "whitespace-nowrap px-3 py-2 text-left text-xs font-medium text-muted-foreground";
const TD = "whitespace-nowrap px-3 py-2";

export interface LiensMarketing {
  depenses: string;
  reglages: string;
  /** L'onglet Demandes Ad & Pro (`?env=…`) : on y ajoute `&cat=…` ou `&statut=manquantes`. */
  demandes: string;
  export: string;
  /** L'onglet Intégration 2026 sur l'enveloppe (`?env=…`) — `null` quand la personne ne le gère pas. */
  integration: string | null;
}

export function TableauMarketing({ donnees, categoriesBrutes, integration, reallocations, pctEcoule, moisCourant, peutReallouer, liens }: {
  donnees: DonneesMarketing;
  /** Les catégories et sous-catégories de l'enveloppe, montants PROPRES (`getBudgetOverview`). */
  categoriesBrutes: CategorieBrute[];
  /** Ce que l'intégration Ad & Pro 2026 laisse à faire (pièces, absentes à décider) — `null` sans lot. */
  integration: ResteIntegration | null;
  reallocations: Reallocation[];
  /** Part de l'année écoulée (repère « rythme »). */
  pctEcoule: number;
  /** Le mois du jour (« 2026-10 »). */
  moisCourant: string;
  peutReallouer: boolean;
  liens: LiensMarketing;
}) {
  const couleurs = useCouleurs();
  const registre: RegistreExports = React.useRef(new Map());
  const periodes = React.useMemo(() => periodesProposees(donnees.moisEnveloppe), [donnees.moisEnveloppe]);
  const [periode, setPeriode] = React.useState("annee");
  const [cat, setCat] = React.useState<string | null>(null);
  const [comparer, setComparer] = React.useState(false);
  const [detail, setDetail] = React.useState<string | null>(null);
  const [ouverts, setOuverts] = React.useState<Set<string>>(() => new Set());
  const [realloc, setRealloc] = React.useState<{ ouverte: boolean; initial: DemandeReallocation }>({ ouverte: false, initial: {} });
  const [message, setMessage] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!message) return;
    const h = setTimeout(() => setMessage(null), 4500);
    return () => clearTimeout(h);
  }, [message]);

  const p = periodes.find((x) => x.cle === periode) ?? periodes[0];
  const filtres: Filtres = { debut: p?.debut ?? "0000-00", fin: p?.fin ?? "9999-99", cat };
  const vue = React.useMemo(() => vueFiltree(donnees, filtres, comparer), [donnees, filtres.debut, filtres.fin, filtres.cat, comparer]); // eslint-disable-line react-hooks/exhaustive-deps
  const vueToutes = React.useMemo(() => vueFiltree(donnees, { ...filtres, cat: null }, comparer), [donnees, filtres.debut, filtres.fin, comparer]); // eslint-disable-line react-hooks/exhaustive-deps
  // L'arbre : chaque catégorie avec ses sous-catégories (le cumul), sur toute l'enveloppe.
  const arbre = React.useMemo(() => arbreCategories(categoriesBrutes), [categoriesBrutes]);
  const lignes = React.useMemo(() => arbre.filter((n) => n.alloue > 0.5 || n.paye > 0.5 || n.engage > 0.5), [arbre]);
  const ordre = React.useMemo(() => lignes.map((l) => l.id), [lignes]);
  const couleurCat = React.useMemo(() => couleurDeCategorie(ordre), [ordre]);
  const alertes = React.useMemo(() => alertesBudget({
    categories: tetesDeLArbre(lignes),
    sansCategorie: donnees.sansCategorie,
    total: donnees.enveloppe.total,
    integration: integration ? { ...integration, aDecider: liens.integration ? integration.aDecider : 0 } : null,
  }), [lignes, donnees, integration, liens.integration]);

  const total = lignes.reduce((a, l) => ({ alloue: a.alloue + l.alloue, paye: a.paye + l.paye, engage: a.engage + l.engage }), { alloue: 0, paye: 0, engage: 0 });
  const surAnnee = periode === "annee";
  const avecSous = lignes.filter((l) => l.sous.length > 0);
  const toutOuvert = avecSous.length > 0 && avecSous.every((l) => ouverts.has(l.id));
  const basculer = (id: string) => setOuverts((o) => { const n = new Set(o); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  /** Réallouer : vers la catégorie en dépassement, depuis celle qui peut céder le plus. */
  const ouvrirRealloc = (cibleId?: string) => {
    const prop = propositionReallocation(cibleId, arbre);
    setRealloc({ ouverte: true, initial: { cibleId, sourceId: prop.sourceId, montant: prop.montant, besoin: prop.besoin } });
  };

  const exporterHref = (format: string) => {
    const q = new URLSearchParams({ format, debut: filtres.debut, fin: filtres.fin });
    if (cat) q.set("cat", cat);
    if (comparer) q.set("n1", "1");
    return `${liens.export}&${q.toString()}`;
  };
  const lienCategorie = (id: string) => `${liens.demandes}&cat=${encodeURIComponent(id)}`;

  return (
    <>
      {message && <p role="status" className="rounded-xl border border-success/40 bg-success/5 px-4 py-2.5 text-sm">{message}</p>}
      <CarteATraiter alertes={alertes} liens={liens} peutReallouer={peutReallouer} onReallouer={ouvrirRealloc} />

      {/* ── FILTRES ET EXPORT ─────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <label className="inline-flex items-center gap-2 text-sm text-muted-foreground">
          Période
          <select value={periode} onChange={(e) => setPeriode(e.target.value)} className="h-9 rounded-lg border border-border bg-card px-2 text-sm text-foreground">
            {periodes.map((x) => <option key={x.cle} value={x.cle}>{x.libelle}</option>)}
          </select>
        </label>
        <label className="inline-flex items-center gap-2 text-sm text-muted-foreground">
          Catégorie
          <select value={cat ?? ""} onChange={(e) => setCat(e.target.value || null)} className="h-9 max-w-[14rem] rounded-lg border border-border bg-card px-2 text-sm text-foreground">
            <option value="">Toutes</option>
            {lignes.map((l) => <option key={l.id} value={l.id}>{l.nom}</option>)}
          </select>
        </label>
        {donnees.n1 && (
          <label className="inline-flex items-center gap-1.5 text-sm">
            <input type="checkbox" checked={comparer} onChange={(e) => setComparer(e.target.checked)} className="h-4 w-4 rounded border-input" />
            Comparer à {donnees.n1.annee}
          </label>
        )}
        <InfoBulle label="À propos des filtres">
          La période et la catégorie s&apos;appliquent aux six graphiques et aux exports. L&apos;engagé est un état à date ; le tableau « Par catégorie » reste sur toute l&apos;année.
        </InfoBulle>
        <MenuExport hrefDe={exporterHref} onImages={async () => { for (const f of registre.current.values()) await f(); }} />
      </div>

      <GraphiquesMarketing vue={vue} vueToutes={vueToutes} couleurCat={couleurCat} couleurs={couleurs} registre={registre} comparer={comparer} anneeN1={donnees.n1?.annee ?? null} moisCourant={moisCourant} />

      {/* ── PAR CATÉGORIE ─────────────────────────────────────────────── */}
      <section className="surface min-w-0 overflow-hidden rounded-xl">
        <header className="flex flex-wrap items-center gap-1.5 border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold">Par catégorie</h2>
          <InfoBulle label="À propos du tableau">
            Toute l&apos;enveloppe. Une catégorie comprend ses sous-catégories : son payé et son engagé sont les siens plus ceux de ses sous-catégories (▸ les déplie). Reste = alloué − payé − engagé. Le trait marque la part de l&apos;année écoulée ({Math.round(pctEcoule)} %). Cliquez un nom pour voir ses demandes.
          </InfoBulle>
          {avecSous.length > 0 && (
            <button type="button" className="ml-auto text-xs text-muted-foreground hover:text-foreground hover:underline" onClick={() => setOuverts(toutOuvert ? new Set() : new Set(avecSous.map((l) => l.id)))}>
              {toutOuvert ? "Tout replier" : "Tout déplier"}
            </button>
          )}
        </header>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[46rem] text-sm tabular-nums">
            <thead className="border-b border-border">
              <tr>
                <th className={`${TH} sticky left-0 z-[1] bg-card`}>Catégorie</th>
                <th className={`${TH} text-right`}>Alloué</th>
                <th className={`${TH} text-right`}>Payé</th>
                <th className={`${TH} text-right`}>Engagé</th>
                <th className={`${TH} text-right`}>Reste</th>
                <th className={TH}>Utilisé</th>
                <th className={`${TH} text-right`}>%</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {lignes.map((l) => (
                <React.Fragment key={l.id}>
                  <LigneTableau
                    l={l} pctEcoule={surAnnee ? pctEcoule : null} choisie={detail === l.id || cat === l.id} couleur={couleurCat(l.id)}
                    ouvert={ouverts.has(l.id)} onBasculer={() => basculer(l.id)}
                    onClick={() => setDetail(detail === l.id ? null : l.id)}
                  />
                  {ouverts.has(l.id) && l.sous.map((s) => (
                    <LigneTableau key={s.id} l={s} sous pctEcoule={surAnnee ? pctEcoule : null} choisie={false} couleur={couleurCat(l.id)} lien={lienCategorie(s.id)} />
                  ))}
                </React.Fragment>
              ))}
              {lignes.length === 0 && (
                <tr><td colSpan={7} className="px-4 py-5 text-sm text-muted-foreground">L&apos;enveloppe n&apos;est pas encore répartie en catégories.</td></tr>
              )}
            </tbody>
            <tfoot className="border-t border-border">
              <tr className="font-semibold">
                <td className={`${TD} sticky left-0 z-[1] bg-card`}>Total</td>
                <td className={`${TD} text-right`}>{fmt(total.alloue)}</td>
                <td className={`${TD} text-right`}>{fmt(total.paye)}</td>
                <td className={`${TD} text-right`}>{fmt(total.engage)}</td>
                <td className={cn(TD, "text-right", total.alloue - total.paye - total.engage < 0 && "text-destructive")}>{fmt(total.alloue - total.paye - total.engage)}</td>
                <td className={TD} />
                <td className={`${TD} text-right`}>{total.alloue > 0 ? `${Math.round(((total.paye + total.engage) / total.alloue) * 100)} %` : "—"}</td>
              </tr>
              {donnees.sansCategorie.total > 0.5 && (
                <tr className="text-muted-foreground">
                  <td className={`${TD} sticky left-0 z-[1] bg-card`}>
                    <span className="inline-flex items-center gap-1">Sans catégorie
                      <InfoBulle label="À propos des dépenses sans catégorie">Dépenses de la société pas encore imputées : elles n&apos;entrent dans une enveloppe qu&apos;une fois imputées.</InfoBulle>
                    </span>
                  </td>
                  <td className={`${TD} text-right`}>—</td>
                  <td className={`${TD} text-right`}>{fmt(donnees.sansCategorie.total)}</td>
                  <td className={`${TD} text-right`}>—</td>
                  <td className={`${TD} text-right`}>—</td>
                  <td className={TD} />
                  <td className={TD} />
                </tr>
              )}
            </tfoot>
          </table>
        </div>
      </section>

      {detail && (
        <DetailCategorie
          ligne={lignes.find((l) => l.id === detail) ?? null}
          donnees={donnees}
          lienDemandes={lienCategorie(detail)}
          peutReallouer={peutReallouer}
          onReallouer={() => ouvrirRealloc(detail)}
          onFermer={() => setDetail(null)}
        />
      )}

      {reallocations.length > 0 && (
        <section className="surface min-w-0 overflow-hidden rounded-xl">
          <header className="border-b border-border px-4 py-3"><h2 className="text-sm font-semibold">Réallocations</h2></header>
          <ul className="divide-y divide-border text-sm">
            {reallocations.map((r) => (
              <li key={r.le} className="px-4 py-2.5">
                <span className="[overflow-wrap:anywhere]">{r.resume}</span>
                <span className="block text-xs text-muted-foreground">{new Date(r.le).toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric" })}{r.par ? ` · ${r.par}` : ""}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {peutReallouer && (
        <ReallouerSheet ouverte={realloc.ouverte} onClose={() => setRealloc((r) => ({ ...r, ouverte: false }))} tetes={arbre} envelopeId={donnees.enveloppe.id} initial={realloc.initial} onFait={setMessage} />
      )}
    </>
  );
}

function LigneTableau({ l, sous = false, pctEcoule, choisie, couleur, ouvert, onBasculer, onClick, lien }: {
  l: NoeudArbre; sous?: boolean; pctEcoule: number | null; choisie: boolean; couleur: string;
  ouvert?: boolean; onBasculer?: () => void; onClick?: () => void; lien?: string;
}) {
  const sansAllocation = l.sante === "SANS_ALLOCATION";
  const depasse = l.alloue > 0.5 && l.pct > 100;
  const bas = pctEcoule !== null && l.alloue > 0.5 && l.pct < pctEcoule - 25;
  const barre = depasse || sansAllocation ? "bg-destructive" : bas ? "bg-warning" : "bg-success";
  const largeur = l.alloue > 0.5 ? Math.min(100, Math.max(0, l.pct)) : l.paye + l.engage > 0.5 ? 100 : 0;
  const dansSous = l.paye + l.engage - (l.payePropre + l.engagePropre);
  const fond = sous ? "bg-secondary/40" : "bg-card";
  return (
    <tr
      id={sous ? undefined : ancreCategorieBudget(l.id)}
      className={cn(sous ? "bg-secondary/40 text-[13px]" : "cursor-pointer hover:bg-secondary/50", choisie && "bg-secondary/60")}
      onClick={sous ? undefined : onClick}
      onKeyDown={sous ? undefined : (e) => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onClick?.(); } }}
      tabIndex={sous ? undefined : 0}
      aria-selected={sous ? undefined : choisie}
    >
      <td className={cn(TD, "sticky left-0 z-[1]", fond, sous ? "pl-10 font-normal" : "font-medium")}>
        <span className="inline-flex items-center gap-1.5">
          {!sous && (l.sous.length > 0 ? (
            <button
              type="button" aria-expanded={ouvert} aria-label={`${ouvert ? "Replier" : "Déplier"} ${l.nom}`}
              onClick={(e) => { e.stopPropagation(); onBasculer?.(); }}
              className="grid h-6 w-6 place-items-center rounded text-muted-foreground hover:bg-secondary hover:text-foreground"
            >
              {ouvert ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            </button>
          ) : <span className="w-6" aria-hidden />)}
          {sous && <span className="text-muted-foreground" aria-hidden>›</span>}
          <span className={cn("h-2.5 w-2.5 shrink-0 rounded-sm", sous && "opacity-60")} style={{ backgroundColor: couleur }} aria-hidden />
          {lien ? <Link href={lien} className="text-primary hover:underline" onClick={(e) => e.stopPropagation()}>{l.nom}</Link> : <span>{l.nom}</span>}
        </span>
        {!sous && l.sous.length > 0 && (
          <span className="block pl-[3.25rem] text-xs font-normal text-muted-foreground">dont {fmt(dansSous)} dans ses {l.sous.length} sous-catégorie{l.sous.length > 1 ? "s" : ""}</span>
        )}
      </td>
      <td className={`${TD} text-right`}>{sous && l.alloue <= 0.5 ? <span className="text-xs text-muted-foreground">—</span> : fmt(l.alloue)}</td>
      <td className={`${TD} text-right`}>{fmt(l.paye)}</td>
      <td className={`${TD} text-right`}>{fmt(l.engage)}</td>
      <td className={cn(TD, "text-right", l.reste < 0 && !(sous && l.alloue <= 0.5) && "font-semibold text-destructive")}>{sous && l.alloue <= 0.5 ? <span className="text-xs text-muted-foreground">—</span> : fmt(l.reste)}</td>
      <td className={TD}>
        <div className="relative h-2 w-28 rounded-full bg-muted" aria-hidden>
          <span className={`absolute inset-y-0 left-0 rounded-full ${barre}`} style={{ width: `${largeur}%` }} />
          {pctEcoule !== null && <span className="absolute -bottom-[3px] -top-[3px] w-0.5 bg-foreground/60" style={{ left: `${pctEcoule}%` }} />}
        </div>
      </td>
      <td className={cn(TD, "text-right font-semibold", depasse ? "text-destructive" : bas ? "text-warning" : "")}>
        {l.alloue > 0.5 ? `${Math.round(l.pct)} %` : sansAllocation && !sous
          ? <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">{LIBELLE_SANTE.SANS_ALLOCATION}</span>
          : "—"}
      </td>
    </tr>
  );
}

function CarteATraiter({ alertes, liens, peutReallouer, onReallouer }: {
  alertes: Alerte[]; liens: LiensMarketing; peutReallouer: boolean; onReallouer: (catId?: string) => void;
}) {
  if (alertes.length === 0) return null;
  const bouton = "inline-flex h-9 items-center gap-1 whitespace-nowrap rounded-[var(--radius)] border border-border bg-card px-3 text-xs font-medium hover:bg-secondary sm:h-8";
  const geste = (a: Alerte) => {
    switch (a.geste) {
      case "REALLOUER": return peutReallouer ? <Button size="sm" variant="outline" onClick={() => onReallouer(a.categorieId)}>Réallouer</Button> : null;
      case "IMPUTER": return <Link href={liens.depenses} className={bouton}>Les imputer</Link>;
      case "AJUSTER": return <Link href={liens.reglages} className={bouton}>Ajuster</Link>;
      // Les pièces se joignent depuis l'onglet Intégration (gestionnaire), sinon depuis la fiche de chaque demande.
      case "PIECES": return <Link href={liens.integration ? `${liens.integration}&filtre=manquantes` : `${liens.demandes}&statut=manquantes`} className={bouton}>Voir les pièces</Link>;
      case "ABSENTES": return liens.integration ? <Link href={`${liens.integration}#absentes`} className={bouton}>Décider</Link> : null;
    }
  };
  return (
    <section className="surface min-w-0 overflow-hidden rounded-xl" aria-label="À traiter">
      <header className="flex items-center gap-2 border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">À traiter</h2>
        <span className="rounded-full bg-warning/15 px-2 py-0.5 text-xs font-medium text-warning">{alertes.length}</span>
      </header>
      <ul className="divide-y divide-border">
        {alertes.map((a) => {
          const g = geste(a);
          return (
            <li key={a.cle} className="grid grid-cols-[6px_minmax(0,1fr)] items-center gap-x-3 gap-y-2 px-4 py-3 text-sm sm:grid-cols-[6px_minmax(0,1fr)_auto]">
              <span className={cn("self-stretch rounded", g && "row-span-2 sm:row-span-1", a.niveau === "danger" ? "bg-destructive" : "bg-warning")} />
              <div className="min-w-0">
                <b className="block font-semibold">
                  {a.titre}
                  {a.integration && <span className="ml-1.5 text-[10px] font-semibold uppercase tracking-wide text-violet-600 dark:text-violet-300">Intégration 2026</span>}
                </b>
                <small className="text-xs text-muted-foreground">{a.detail}</small>
              </div>
              {g ? <div className="col-start-2 justify-self-start sm:col-start-3 sm:justify-self-end">{g}</div> : <span className="hidden sm:block" />}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function DetailCategorie({ ligne, donnees, lienDemandes, peutReallouer, onReallouer, onFermer }: {
  ligne: NoeudArbre | null; donnees: DonneesMarketing; lienDemandes: string; peutReallouer: boolean; onReallouer: () => void; onFermer: () => void;
}) {
  if (!ligne) return null;
  const debut = donnees.moisEnveloppe[0] ?? "0000-00", fin = donnees.moisEnveloppe[donnees.moisEnveloppe.length - 1] ?? "9999-99";
  const demandes = demandesDeLaCategorie({ faits: donnees.faits, engagements: donnees.engagements, demandes: donnees.demandes, cat: ligne.id, debut, fin });
  const visibles = demandes.slice(0, 5);
  const autres = demandes.slice(5);
  const horsDemande = ligne.paye + ligne.engage - demandes.reduce((a, d) => a + d.total, 0);
  const pill = ligne.alloue > 0.5 ? `${Math.round(ligne.pct)} %` : LIBELLE_SANTE[ligne.sante];
  return (
    <section className="surface min-w-0 overflow-hidden rounded-xl">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="truncate text-sm font-semibold">{ligne.nom}</h2>
          <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium", ligne.pct > 100 || ligne.sante === "SANS_ALLOCATION" ? "bg-destructive/10 text-destructive" : "bg-secondary text-muted-foreground")}>{pill}</span>
        </div>
        <button type="button" onClick={onFermer} className="text-xs text-muted-foreground hover:underline">Fermer</button>
      </header>
      {demandes.length === 0 ? (
        <p className="px-4 py-4 text-sm text-muted-foreground">Aucune demande Ad &amp; Pro ne consomme cette catégorie.</p>
      ) : (
        <ul className="divide-y divide-border text-sm">
          {visibles.map((d) => (
            <li key={d.cle} className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 px-4 py-2.5">
              <div className="min-w-0">
                {d.href ? <Link href={d.href} className="font-medium text-primary hover:underline [overflow-wrap:anywhere]">{d.libelle}</Link> : <span className="font-medium [overflow-wrap:anywhere]">{d.libelle}</span>}
                <small className="block text-xs text-muted-foreground">{d.type}{d.engage > 0 ? ` · ${fmt(d.engage)} engagés` : ""}</small>
              </div>
              <b className="tabular-nums">{fmt(d.total)}</b>
            </li>
          ))}
          {autres.length > 0 && (
            <li className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 px-4 py-2.5 text-muted-foreground">
              <span>+ {autres.length} autre{autres.length > 1 ? "s" : ""} demande{autres.length > 1 ? "s" : ""}</span>
              <b className="tabular-nums">{fmt(autres.reduce((a, d) => a + d.total, 0))}</b>
            </li>
          )}
          {horsDemande > 0.5 && (
            <li className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 px-4 py-2.5 text-muted-foreground">
              <span>Hors demande (saisies directes, moyens généraux…)</span>
              <b className="tabular-nums">{fmt(horsDemande)}</b>
            </li>
          )}
        </ul>
      )}
      <div className="flex flex-wrap gap-2 border-t border-border px-4 py-3">
        <Link href={lienDemandes} className="inline-flex h-9 items-center gap-1 rounded-[var(--radius)] border border-border bg-card px-3 text-xs font-medium hover:bg-secondary sm:h-8">
          Voir les {demandes.length} demande{demandes.length > 1 ? "s" : ""} <ArrowRight className="h-3.5 w-3.5" />
        </Link>
        {peutReallouer && <Button size="sm" variant="outline" onClick={onReallouer}>Réallouer</Button>}
      </div>
    </section>
  );
}

function MenuExport({ hrefDe, onImages }: { hrefDe: (format: string) => string; onImages: () => Promise<void> }) {
  const [ouvert, setOuvert] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (!ouvert) return;
    const ailleurs = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOuvert(false); };
    const echap = (e: KeyboardEvent) => { if (e.key === "Escape") setOuvert(false); };
    document.addEventListener("mousedown", ailleurs);
    document.addEventListener("keydown", echap);
    return () => { document.removeEventListener("mousedown", ailleurs); document.removeEventListener("keydown", echap); };
  }, [ouvert]);
  const item = "block w-full rounded-md px-3 py-2 text-left text-sm hover:bg-secondary";
  return (
    <div ref={ref} className="relative lg:ml-auto">
      <Button type="button" size="sm" variant="outline" aria-expanded={ouvert} onClick={() => setOuvert((o) => !o)}>
        <Download className="h-4 w-4" /> Exporter <ChevronDown className="h-3.5 w-3.5" />
      </Button>
      {ouvert && (
        <div className="absolute left-0 top-full z-20 mt-1.5 w-60 rounded-xl border border-border bg-card p-1 shadow-lg lg:left-auto lg:right-0" role="menu">
          <a role="menuitem" className={item} href={hrefDe("xlsx")} onClick={() => setOuvert(false)}>Excel complet</a>
          <a role="menuitem" className={item} href={hrefDe("pdf")} onClick={() => setOuvert(false)}>Rapport PDF</a>
          <a role="menuitem" className={item} href={hrefDe("csv")} onClick={() => setOuvert(false)}>CSV des dépenses</a>
          <a role="menuitem" className={item} href={hrefDe("pptx")} onClick={() => setOuvert(false)}>Diapositives PowerPoint</a>
          <button type="button" role="menuitem" className={item} onClick={() => { setOuvert(false); void onImages(); }}>Graphiques en images (PNG)</button>
        </div>
      )}
    </div>
  );
}
