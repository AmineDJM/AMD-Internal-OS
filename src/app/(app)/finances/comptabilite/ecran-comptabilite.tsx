"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { MoreHorizontal, Plus, X } from "lucide-react";
import type { CompteLu, DonneesComptabilite, LigneCompta } from "@/modules/finances/api";
import { cn, formatCurrency } from "@/lib/utils";
import { ComptesTresorerieButton } from "../comptes-tresorerie";
import { PanneauEcriture } from "./panneau-ecriture";
import { PanneauFacture } from "./panneau-facture";
import { PanneauSaisie } from "./panneau-saisie";
import { PanneauImport } from "./panneau-import";
import { PanneauControles } from "./panneau-controles";
import { ResultatCompta } from "./resultat-compta";
import { dateCourte } from "./format";
import { useRafraichir } from "@/components/shared/use-rafraichir";

export interface DroitsCompta { creer: boolean; modifier: boolean; supprimer: boolean; demanderPaiement: boolean }

type PanneauLocal = null | "nouvelle" | "encaissement" | "import" | "controles";
type Cle = "societe" | "vue" | "periode" | "q" | "ecriture" | "facture" | "compte" | "sans";

/**
 * L'ÉCRAN « COMPTABILITÉ » (maquette validée, 24/11/2026) — l'enveloppe : en-tête (sociétés, « Nouvelle écriture », ⋯),
 * onglets avec leur total, la recherche unique, les filtres, la liste ou le Résultat, et le panneau de droite.
 *
 * L'état PARTAGEABLE (société, onglet, période, recherche, écriture ou facture ouverte, filtres) vit dans l'adresse et se
 * lit au serveur ; seuls les panneaux de saisie (nouvelle écriture, encaissement, import, contrôles) sont locaux.
 * Au téléphone, le panneau couvre l'écran ; au bureau, il se range à droite de la liste.
 */
export function EcranComptabilite({ d, droits, composer, comptesTresorerie, entites }: {
  d: DonneesComptabilite;
  droits: DroitsCompta;
  composer: React.ReactNode;
  comptesTresorerie: CompteLu[];
  entites: { value: string; label: string }[];
}) {
  const router = useRouter();
  // Relancer les contrôles : le rafraîchissement suivi, dans une transition (`useRafraichir`).
  const { rafraichir } = useRafraichir();
  const [local, setLocal] = React.useState<PanneauLocal>(null);
  const [menu, setMenu] = React.useState(false);
  const [menuCompte, setMenuCompte] = React.useState(false);
  const [q, setQ] = React.useState(d.q);
  const comptesRef = React.useRef<HTMLDivElement>(null);
  // La dernière recherche que CET écran a poussée dans l'adresse : si l'adresse change autrement (un onglet, une société),
  // le champ reprend ce qu'elle dit — sinon l'ancien texte serait aussitôt renvoyé.
  const pousse = React.useRef(d.q);
  React.useEffect(() => {
    if (d.q !== pousse.current) { pousse.current = d.q; setQ(d.q); }
  }, [d.q]);

  const actuel = React.useMemo<Record<Cle, string | null>>(() => ({
    societe: d.societeId, vue: d.vue, periode: d.periode.cle, q: d.q || null, ecriture: d.ecriture?.id ?? null,
    facture: d.facture?.id ?? null, compte: d.compteId, sans: d.sansJustif ? "1" : null,
  }), [d]);
  const lien = React.useCallback((changes: Partial<Record<Cle, string | null>>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...actuel, ...changes })) if (v) p.set(k, v);
    return `/finances/comptabilite?${p.toString()}`;
  }, [actuel]);
  const aller = React.useCallback((changes: Partial<Record<Cle, string | null>>) => {
    setLocal(null);
    router.push(lien(changes), { scroll: false });
  }, [router, lien]);

  // LA RECHERCHE suit la frappe (un temps de pause), sans empiler l'historique : chaque lettre n'est pas une page.
  React.useEffect(() => {
    if (q.trim() === d.q) return;
    const t = window.setTimeout(() => {
      pousse.current = q.trim();
      router.replace(lien({ q: q.trim() || null, ecriture: null, facture: null }), { scroll: false });
    }, 350);
    return () => window.clearTimeout(t);
  }, [q, d.q, router, lien]);

  const ouvrirLocal = (p: PanneauLocal) => {
    setMenu(false);
    setLocal(p);
    if (d.ecriture || d.facture) router.replace(lien({ ecriture: null, facture: null }), { scroll: false });
  };
  const fermerPanneau = () => {
    setLocal(null);
    if (d.ecriture || d.facture) router.replace(lien({ ecriture: null, facture: null }), { scroll: false });
  };
  const ouvrirEcriture = (id: string) => aller({ ecriture: id, facture: null });

  const enRecherche = Boolean(d.q);
  const sens = d.vue === "rec" ? "IN" : "OUT";
  const nbSans = d.lignes.filter((l) => !l.justificatif.present).length;
  const totalVisible = d.lignes.reduce((a, l) => a + l.montant, 0);
  const aPanneau = Boolean(local || d.ecriture || d.facture);
  const nbControles = d.controles.points.length;

  return (
    <div className="space-y-3.5">
      {/* ── EN-TÊTE ── */}
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-3.5">
          <h1 className="text-2xl font-bold tracking-tight">Comptabilité</h1>
          {d.societes.length > 0 && (
            <nav aria-label="Société" className="flex flex-wrap gap-1 rounded-[10px] border border-border bg-card p-1">
              {d.societes.map((s) => (
                <Link
                  key={s.id} href={lien({ societe: s.id, ecriture: null, facture: null, q: null, compte: null, sans: null })} scroll={false}
                  aria-current={s.id === d.societeId ? "page" : undefined}
                  className={cn("rounded-md px-3 py-1.5 text-sm", s.id === d.societeId ? "bg-primary/10 font-semibold text-primary" : "text-muted-foreground hover:bg-secondary")}
                >
                  {s.label}
                </Link>
              ))}
            </nav>
          )}
        </div>
        <div className="relative flex items-center gap-2">
          {droits.creer && (
            <button type="button" onClick={() => ouvrirLocal("nouvelle")} className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground hover:bg-primary/90">
              <Plus className="h-4 w-4" aria-hidden /> Nouvelle écriture
            </button>
          )}
          <button
            type="button" onClick={() => { setMenu((m) => !m); setMenuCompte(false); }} aria-label="Autres actions" aria-expanded={menu}
            className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-border bg-card hover:bg-secondary"
          >
            <MoreHorizontal className="h-5 w-5" aria-hidden />
          </button>
          {/* LES COMPTES DE TRÉSORERIE (§118.176) — le composant de toujours, monté HORS du menu (sa fenêtre ne doit pas
              disparaître quand le menu se ferme) ; son propre bouton est caché, l'entrée du menu le déclenche. */}
          <div ref={comptesRef} className="[&>button]:hidden">
            <ComptesTresorerieButton comptes={comptesTresorerie} entites={entites} canUpdate={droits.modifier} />
          </div>
          {menu && (
          <div role="menu" className="absolute right-0 top-12 z-30 flex w-72 flex-col rounded-[10px] border border-border bg-card p-1.5 shadow-lg">
            {droits.creer && <ItemMenu onClick={() => ouvrirLocal("encaissement")}>Enregistrer un encaissement</ItemMenu>}
            {droits.creer && <ItemMenu onClick={() => ouvrirLocal("import")}>Importer un relevé bancaire (CSV)</ItemMenu>}
            <ItemMenu onClick={() => ouvrirLocal("controles")}>
              <span>Contrôles du livre</span>
              <span className={cn("rounded-full px-2 py-0.5 text-xs font-bold", nbControles ? "bg-warning/15 text-warning" : "bg-success/15 text-success")}>
                {nbControles ? `${nbControles} à voir` : "✓"}
              </span>
            </ItemMenu>
            <ItemMenu onClick={() => { setMenu(false); comptesRef.current?.querySelector<HTMLButtonElement>(":scope > button")?.click(); }}>Comptes de trésorerie</ItemMenu>
          </div>
          )}
        </div>
      </header>

      {/* ── ONGLETS ── */}
      <nav aria-label="Vues" className="flex flex-wrap gap-1 border-b border-border">
        {([
          { k: "dep", libelle: "Dépenses", total: formatCurrency(d.totaux.dep) },
          { k: "rec", libelle: "Recettes", total: formatCurrency(d.totaux.rec) },
          { k: "res", libelle: "Résultat", total: "par mois" },
        ] as const).map((t) => (
          <Link
            key={t.k} href={lien({ vue: t.k, q: null, ecriture: null, facture: null, sans: null })} scroll={false}
            aria-current={d.vue === t.k && !enRecherche ? "page" : undefined}
            className={cn("-mb-px border-b-2 px-3.5 py-2.5 text-[15px]", d.vue === t.k ? "border-primary font-bold text-primary" : "border-transparent text-muted-foreground hover:text-foreground")}
          >
            {t.libelle} <span className={cn("ml-1.5 text-xs font-medium", d.vue === t.k ? "text-primary" : "text-muted-foreground")}>{t.total}</span>
          </Link>
        ))}
      </nav>

      {/* ── RECHERCHE + FILTRES ── */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex min-w-0 flex-[1_1_340px]">
          <label htmlFor="recherche-compta" className="sr-only">Rechercher une dépense, une recette ou une facture</label>
          <input
            id="recherche-compta" type="search" value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="N° de facture, fournisseur, montant…"
            className="h-[42px] min-w-0 flex-1 rounded-lg border border-border bg-card pl-3.5 pr-10 text-[15px]"
          />
          {q && (
            <button type="button" onClick={() => setQ("")} aria-label="Effacer la recherche" className="absolute right-1.5 top-1.5 inline-flex h-[30px] w-[30px] items-center justify-center rounded-md bg-secondary text-sm">
              <X className="h-4 w-4" aria-hidden />
            </button>
          )}
        </div>
        {!enRecherche && d.vue !== "res" && (
          <div className="flex flex-wrap items-center gap-2">
            <div role="group" aria-label="Période" className="flex gap-0.5 rounded-lg border border-border bg-card p-[3px]">
              {d.periodes.map((p) => (
                <Link
                  key={p.cle} href={lien({ periode: p.cle, ecriture: null })} scroll={false} aria-current={p.cle === d.periode.cle ? "true" : undefined}
                  className={cn("inline-flex h-8 items-center rounded-md px-2.5 text-[13px]", p.cle === d.periode.cle ? "bg-primary/10 font-semibold text-primary" : "text-muted-foreground hover:bg-secondary")}
                >
                  {p.libelle}
                </Link>
              ))}
              {!d.periodes.some((p) => p.cle === d.periode.cle) && (
                <span aria-current="true" className="inline-flex h-8 items-center rounded-md bg-primary/10 px-2.5 text-[13px] font-semibold text-primary">{d.periode.libelle}</span>
              )}
            </div>
            <Link
              href={lien({ sans: d.sansJustif ? null : "1", ecriture: null })} scroll={false} aria-pressed={d.sansJustif}
              className={cn(
                "inline-flex h-10 items-center rounded-lg border px-3 text-sm font-semibold",
                d.sansJustif ? "border-destructive bg-destructive/5 text-destructive" : nbSans ? "border-border bg-card text-destructive" : "border-border bg-card text-muted-foreground",
              )}
            >
              {d.sansJustif ? "✓ " : ""}{sens === "OUT" ? "Sans justificatif" : "Sans pièce"} · {d.sansJustif ? d.lignes.length : nbSans}
            </Link>
            <div className="relative">
              <button
                type="button" onClick={() => { setMenuCompte((m) => !m); setMenu(false); }} aria-expanded={menuCompte}
                className="h-10 rounded-lg border border-border bg-card px-3 text-sm text-muted-foreground"
              >
                {d.comptes.find((c) => c.id === d.compteId)?.nom ?? "Tous les comptes"} ▾
              </button>
              {menuCompte && (
                <div role="menu" className="absolute right-0 top-12 z-30 flex w-64 flex-col rounded-[10px] border border-border bg-card p-1.5 shadow-lg">
                  {[{ id: null as string | null, nom: "Tous les comptes" }, ...d.comptes].map((c) => (
                    <Link
                      key={c.id ?? "tous"} role="menuitemradio" aria-checked={c.id === d.compteId} href={lien({ compte: c.id, ecriture: null })} scroll={false}
                      onClick={() => setMenuCompte(false)}
                      className={cn("rounded-md px-3 py-2 text-sm", c.id === d.compteId ? "bg-primary/10 font-semibold text-primary" : "hover:bg-secondary")}
                    >
                      {c.id === d.compteId ? "✓ " : ""}{c.nom}
                    </Link>
                  ))}
                </div>
              )}
            </div>
            {d.vue === "rec" && composer}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-start gap-4">
        {/* ── COLONNE PRINCIPALE ── */}
        <div className="flex min-w-0 flex-[999_1_640px] flex-col gap-3.5">
          {enRecherche && d.recherche && (
            <ResultatsRecherche d={d} onEcriture={ouvrirEcriture} onFacture={(id) => aller({ facture: id, ecriture: null })} onEffacer={() => setQ("")} />
          )}

          {!enRecherche && d.vue !== "res" && (
            <section aria-label={sens === "OUT" ? "Dépenses" : "Recettes"} className="overflow-hidden rounded-xl border border-border bg-card">
              <div className="overflow-x-auto">
                <div className="min-w-[720px]">
                  <div className="grid grid-cols-[54px_minmax(110px,1fr)_minmax(150px,1.5fr)_112px_58px_minmax(128px,1fr)] gap-x-3 bg-muted/50 px-4 py-2.5 text-xs font-semibold text-muted-foreground">
                    <span>Date</span>
                    <span>{sens === "OUT" ? "Payé à" : "Reçu de"}</span>
                    <span>Objet</span>
                    <span className="text-right">Montant</span>
                    <span>Compte</span>
                    <span>{sens === "OUT" ? "Justificatif" : "Pièce"}</span>
                  </div>
                  <ul>
                    {d.lignes.map((l) => (
                      <li key={l.id} className="border-t border-border/60">
                        <LigneEcriture l={l} choisie={d.ecriture?.id === l.id} onClick={() => ouvrirEcriture(l.id)} />
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
              {d.lignes.length === 0 && (
                <div className="flex flex-wrap items-center gap-3 border-t border-border/60 px-4 py-5">
                  <span className="text-sm text-muted-foreground">Aucune écriture pour ces filtres.</span>
                  <Link href={lien({ sans: null, compte: null, periode: d.periodes[2]?.cle ?? null })} scroll={false} className="inline-flex h-9 items-center rounded-lg border border-border px-3 text-sm font-semibold">
                    Effacer les filtres
                  </Link>
                </div>
              )}
              <div className="flex flex-wrap justify-between gap-2 border-t border-border bg-muted/50 px-4 py-3 text-sm">
                <span className="text-muted-foreground">
                  {d.lignes.length} {sens === "OUT" ? "dépense" : "recette"}{d.lignes.length > 1 ? "s" : ""}
                  {sens === "OUT" ? ` · ${nbSans} sans justificatif` : ""}
                </span>
                <strong>Total {formatCurrency(totalVisible)}</strong>
              </div>
            </section>
          )}

          {!enRecherche && d.vue === "res" && <ResultatCompta resultat={d.resultat} lienMois={(mois, vue) => lien({ vue, periode: mois, ecriture: null, facture: null, sans: null, compte: null })} />}
        </div>

        {/* ── PANNEAU ── */}
        {aPanneau && (
          <aside
            aria-label="Panneau"
            className="fixed inset-0 z-40 overflow-y-auto bg-background p-3 lg:sticky lg:top-4 lg:z-auto lg:max-h-[calc(100dvh-2rem)] lg:flex-[1_1_390px] lg:bg-transparent lg:p-0"
          >
            <div className="flex flex-col gap-3.5 rounded-xl border border-border bg-card p-4 shadow-lg sm:p-[18px]">
              {local === "nouvelle" || local === "encaissement" ? (
                <PanneauSaisie
                  key={local} encaissement={local === "encaissement"} societeId={d.societeId} comptes={d.comptes} budgets={d.budgets}
                  onFermer={() => setLocal(null)} onEnregistree={(id, vue) => aller({ ecriture: id, vue, q: null, sans: null, compte: null })}
                />
              ) : local === "import" ? (
                <PanneauImport comptes={d.comptes} onFermer={() => setLocal(null)} onVoirSansJustif={() => aller({ vue: "dep", sans: "1", q: null, compte: null })} />
              ) : local === "controles" ? (
                <PanneauControles controles={d.controles} onFermer={() => setLocal(null)} onOuvrir={ouvrirEcriture} onRelancer={rafraichir} />
              ) : d.ecriture ? (
                <PanneauEcriture key={d.ecriture.id} e={d.ecriture} droits={droits} comptes={d.comptes} onFermer={fermerPanneau} />
              ) : d.facture ? (
                <PanneauFacture key={d.facture.id} f={d.facture} droits={droits} onFermer={fermerPanneau} onOuvrirEcriture={ouvrirEcriture} />
              ) : null}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}

function ItemMenu({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" role="menuitem" onClick={onClick} className="flex items-center justify-between gap-2 rounded-md px-3 py-2.5 text-left text-sm hover:bg-secondary">
      {children}
    </button>
  );
}

function LigneEcriture({ l, choisie, onClick }: { l: LigneCompta; choisie: boolean; onClick: () => void }) {
  const barre = l.contrePassee ? "line-through text-muted-foreground" : "";
  return (
    <button
      type="button" onClick={onClick} aria-current={choisie ? "true" : undefined}
      className={cn(
        "grid w-full grid-cols-[54px_minmax(110px,1fr)_minmax(150px,1.5fr)_112px_58px_minmax(128px,1fr)] items-center gap-x-3 px-4 py-[11px] text-left",
        choisie ? "bg-primary/10 shadow-[inset_3px_0_0_hsl(var(--primary))]" : l.justificatif.present ? "bg-card hover:bg-secondary/60" : "bg-destructive/[0.03] hover:bg-secondary/60",
      )}
    >
      <span className="whitespace-nowrap text-[13px] text-muted-foreground">{dateCourte(l.date)}</span>
      <span className={cn("min-w-0 truncate text-sm font-semibold", barre)}>{l.tiers}</span>
      <span className="min-w-0">
        <span className={cn("text-sm [overflow-wrap:anywhere]", barre)}>{l.objet}</span>
        {l.contrePassee && <span className="ml-1.5 rounded bg-secondary px-1.5 py-px text-[11px] font-semibold text-muted-foreground">contre-passée</span>}
        {l.prevue && <span className="ml-1.5 rounded bg-warning/15 px-1.5 py-px text-[11px] font-semibold text-warning">prévue</span>}
        <br /><span className="text-xs text-muted-foreground">{l.origine}</span>
      </span>
      <span className={cn("whitespace-nowrap text-right text-sm font-bold tabular-nums", l.montant < 0 ? "text-muted-foreground" : l.direction === "IN" ? "text-success" : "", barre)}>
        {formatCurrency(l.montant)}
      </span>
      <span className="truncate text-[13px] text-muted-foreground" title={l.compte.long}>{l.compte.court}</span>
      <span className={cn("min-w-0 truncate text-[13px]", l.justificatif.present ? "font-semibold text-success" : "font-bold text-destructive")} title={l.justificatif.libelle}>
        {l.justificatif.libelle}
      </span>
    </button>
  );
}

function ResultatsRecherche({ d, onEcriture, onFacture, onEffacer }: {
  d: DonneesComptabilite; onEcriture: (id: string) => void; onFacture: (id: string) => void; onEffacer: () => void;
}) {
  const r = d.recherche!;
  const nb = r.depenses.length + r.recettes.length + r.factures.length;
  const Titre = ({ children }: { children: React.ReactNode }) => (
    <h2 className="px-[18px] pb-1.5 pt-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{children}</h2>
  );
  const ligne = (l: LigneCompta) => (
    <li key={l.id} className="border-t border-border/60">
      <button type="button" onClick={() => onEcriture(l.id)} className="flex w-full flex-wrap items-center gap-x-4 gap-y-2.5 px-[18px] py-3 text-left hover:bg-secondary/60">
        <span className="w-16 shrink-0 text-[13px] text-muted-foreground">{dateCourte(l.date)}</span>
        <span className="min-w-0 flex-[1_1_260px]">
          <span className="font-semibold">{l.tiers}</span> · {l.objet}<br />
          <span className="text-xs text-muted-foreground">{l.reference} · {l.origine}</span>
        </span>
        <span className={cn("shrink-0 whitespace-nowrap font-bold tabular-nums", l.direction === "IN" && "text-success")}>{formatCurrency(l.montant)}</span>
        <span className={cn("shrink-0 text-[13px]", l.justificatif.present ? "font-semibold text-success" : "font-bold text-destructive")}>{l.justificatif.libelle}</span>
      </button>
    </li>
  );
  return (
    <section aria-label="Résultats de la recherche" className="overflow-hidden rounded-xl border border-border bg-card">
      <p className="border-b border-border/60 px-[18px] py-3.5 text-sm text-muted-foreground">
        <strong className="text-foreground">{nb} résultat{nb > 1 ? "s" : ""}</strong> pour « {d.q} » · toutes périodes, toutes les pièces
      </p>
      {r.factures.length > 0 && (
        <>
          <Titre>Factures et pièces · {r.factures.length}</Titre>
          <ul>
            {r.factures.map((f) => (
              <li key={f.id} className="border-t border-border/60">
                <button type="button" onClick={() => onFacture(f.id)} className="flex w-full flex-wrap items-center gap-x-4 gap-y-2.5 px-[18px] py-3 text-left hover:bg-secondary/60">
                  <span className="min-w-0 flex-[1_1_260px]">
                    <span className="font-semibold">{f.type} {f.reference ?? f.titre} · {f.tiers}</span><br />
                    <span className="text-[13px] text-muted-foreground">{f.maison}</span>
                    {f.doublon && <><br /><span className="text-xs font-semibold text-warning">! {f.doublon}</span></>}
                  </span>
                  <span className="shrink-0 whitespace-nowrap font-bold tabular-nums">{f.montant !== null ? formatCurrency(f.montant) : "—"}</span>
                  <EtatFactureBadge etat={f.etat} libelle={f.etatLibelle} />
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {r.depenses.length > 0 && (<><Titre>Dépenses · {r.depenses.length}</Titre><ul>{r.depenses.map(ligne)}</ul></>)}
      {r.recettes.length > 0 && (<><Titre>Recettes · {r.recettes.length}</Titre><ul>{r.recettes.map(ligne)}</ul></>)}
      {nb === 0 && (
        <div className="flex flex-wrap items-center gap-3 px-[18px] py-5">
          <span className="text-sm text-muted-foreground">Rien trouvé : ni dépense, ni recette, ni facture.</span>
          <button type="button" onClick={onEffacer} className="inline-flex h-9 items-center rounded-lg border border-border px-3 text-sm font-semibold">Effacer la recherche</button>
        </div>
      )}
    </section>
  );
}

export function EtatFactureBadge({ etat, libelle }: { etat: string; libelle: string }) {
  const ton = etat === "NON_PAYEE" || etat === "NON_ENCAISSEE" ? "bg-destructive/10 text-destructive font-bold" : etat === "DEMANDEE" ? "bg-warning/15 text-warning font-semibold" : "bg-success/15 text-success font-semibold";
  return <span className={cn("shrink-0 rounded-full px-2.5 py-0.5 text-xs", ton)}>{libelle}</span>;
}
