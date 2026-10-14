"use client";

/**
 * BUDGET MARKETING › DEMANDES AD & PRO — UNE LIGNE PAR DEMANDE (maquette « onglets » validée, Direction 10/2026).
 *
 * Tuiles en tête (demandes affichées, accordé · réglé, pièces jointes / attendues), filtres statut (dont « pièces
 * manquantes »), catégorie (sous-catégories comprises), origine (Historique 2026 / circuit normal) et recherche — tenus
 * dans l'adresse (`budget-marketing/demandes-vue.ts`), sans recharger la page. Chaque demande porte ses postes et leur
 * imputation ; un clic ouvre sa fiche en panneau latéral. Sous 900 px, le tableau devient des cartes.
 */

import * as React from "react";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  LIBELLE_STATUT_DEMANDE, comptesDesPuces, montantsDansLaCategorie, passeFiltres, requeteDemandes, tuilesDemandes,
  type CleFiltreOrigine, type CleFiltreStatut, type DemandeVue, type FiltresDemandes,
} from "@/lib/budget-marketing/demandes-vue";
import { idsDeLaCategorie } from "@/lib/budget/marketing-vue";
import { FicheDemandeSheet, type FicheOuverte } from "../fiche-demande";

const fmt = (n: number) => Math.round(n).toLocaleString("fr-FR");
const MOIS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const moisDe = (iso: string | null) => (iso ? `${MOIS[Number(iso.slice(5, 7)) - 1] ?? ""} ${iso.slice(0, 4)}` : "");

// Le tableau devient des cartes sous 900 px : chaque cellule porte son libellé (`data-l`) au-dessus de sa valeur.
const TD = "min-w-0 px-3 py-2.5 align-top max-[900px]:block max-[900px]:w-full max-[900px]:p-0 max-[900px]:before:mb-1 max-[900px]:before:block max-[900px]:before:text-[11px] max-[900px]:before:font-semibold max-[900px]:before:uppercase max-[900px]:before:tracking-wide max-[900px]:before:text-muted-foreground max-[900px]:before:content-[attr(data-l)]";
const SEP = "min-[900px]:border-l min-[900px]:border-border";
const TH = "px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground";

export interface CategorieFiltre { id: string; nom: string; parentId: string | null; sous: number }

const STATUTS: [CleFiltreStatut, string][] = [["TOUT", "Toutes"], ["ACCORDEE", "Accordées"], ["ENGAGEE", "Engagées"], ["PAYEE", "Payées"], ["EN_COURS", "En cours"], ["MANQUANTES", "Pièces manquantes"]];
const ORIGINES: [CleFiltreOrigine, string][] = [["TOUT", "Toutes origines"], ["HISTORIQUE", "Historique 2026"], ["CIRCUIT", "Circuit normal"]];

export function DemandesAdPro({ demandes, categories, initiaux, envelopeId }: {
  demandes: DemandeVue[];
  /** Les têtes puis leurs sous-catégories, dans l'ordre du sélecteur. */
  categories: CategorieFiltre[];
  initiaux: FiltresDemandes;
  envelopeId: string;
}) {
  const [f, setF] = React.useState<FiltresDemandes>(initiaux);
  const [fiche, setFiche] = React.useState<FicheOuverte | null>(null);
  const [ouvertes, setOuvertes] = React.useState<Set<string>>(() => new Set());

  // Les filtres vivent dans l'adresse : un lien partagé (ou « Voir les demandes » de la vue d'ensemble) rouvre la liste filtrée.
  React.useEffect(() => {
    try {
      const voulu = `${window.location.pathname}${requeteDemandes(f, { env: envelopeId })}`;
      if (voulu !== `${window.location.pathname}${window.location.search}`) window.history.replaceState(null, "", voulu);
    } catch { /* navigation sans historique */ }
  }, [f, envelopeId]);

  const idsCat = React.useMemo(() => (f.cat ? idsDeLaCategorie(f.cat, categories) : null), [f.cat, categories]);
  const visibles = React.useMemo(() => demandes.filter((d) => passeFiltres(d, f, idsCat)), [demandes, f, idsCat]);
  const comptes = React.useMemo(() => comptesDesPuces(demandes, f, idsCat), [demandes, f, idsCat]);
  const t = tuilesDemandes(visibles, idsCat);
  const catChoisie = categories.find((c) => c.id === f.cat) ?? null;
  const nomCat = (c: CategorieFiltre) => (c.parentId ? `${categories.find((x) => x.id === c.parentId)?.nom ?? ""} › ${c.nom}` : c.nom);
  const ouvrir = (d: DemandeVue) => setFiche({ cle: d.cle, libelle: d.libelle, nature: d.nature, href: d.href, mode: d.mode, lignes: d.lignes, demande: d });
  const basculer = (cle: string) => setOuvertes((o) => { const n = new Set(o); if (n.has(cle)) n.delete(cle); else n.add(cle); return n; });

  return (
    <>
      <section className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-3" aria-label="En un coup d'œil">
        <Tuile k="Demandes affichées" v={String(t.demandes)} c={`sur ${demandes.length} rangée${demandes.length > 1 ? "s" : ""} dans l'enveloppe`} />
        <Tuile k="Accordé · réglé" pastille="bg-primary" v={fmt(t.accorde)} c={`DZD accordés · ${fmt(t.regle)} réglés${t.engage > 0.5 ? ` · ${fmt(t.engage)} engagés` : ""}`} />
        <Tuile
          k="Pièces" pastille="bg-warning"
          v={t.piecesAttendues ? `${t.piecesAttendues - t.piecesManquantes} / ${t.piecesAttendues}` : "—"}
          c={t.piecesAttendues ? `${t.piecesManquantes} manquante${t.piecesManquantes > 1 ? "s" : ""} — non bloquantes` : "aucune pièce attendue ici"}
        />
      </section>

      <section className="surface min-w-0 overflow-hidden rounded-xl">
        <header className="flex flex-wrap items-center justify-between gap-2.5 border-b border-border px-4 py-3">
          <h2 className="min-w-0 text-sm font-semibold">
            {catChoisie ? <>Demandes rangées dans « {nomCat(catChoisie)} »</> : <>Demandes rangées dans l&apos;enveloppe</>}
            {catChoisie && (
              <button type="button" className="ml-2 text-xs font-normal text-muted-foreground hover:text-primary hover:underline" onClick={() => setF((x) => ({ ...x, cat: null }))}>Toutes les catégories</button>
            )}
          </h2>
          <label className="relative w-full sm:w-80">
            <span className="sr-only">Rechercher</span>
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <input
              type="search" value={f.q} onChange={(e) => setF((x) => ({ ...x, q: e.target.value }))}
              placeholder="Rechercher une demande, un poste, une ligne Excel…"
              className="h-9 w-full rounded-lg border border-border bg-card pl-8 pr-2 text-[13px] focus-ring"
            />
          </label>
        </header>
        <div className="grid gap-2.5 border-b border-border px-4 py-2.5">
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filtrer par statut">
            {STATUTS.filter(([k]) => k !== "EN_COURS" || comptes.statut.EN_COURS > 0 || f.statut === "EN_COURS").map(([k, l]) => (
              <Puce key={k} on={f.statut === k} n={comptes.statut[k]} onClick={() => setF((x) => ({ ...x, statut: k }))}>{l}</Puce>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
              Catégorie
              <select value={f.cat ?? ""} onChange={(e) => setF((x) => ({ ...x, cat: e.target.value || null }))} className="h-8 max-w-[15rem] rounded-lg border border-border bg-card px-2 text-[13px] text-foreground">
                <option value="">Toutes</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>{c.parentId ? `  › ${c.nom}` : `${c.nom}${c.sous ? " (+ sous-catégories)" : ""}`}</option>
                ))}
              </select>
            </label>
            <span className="flex flex-wrap gap-1.5" role="group" aria-label="Filtrer par origine">
              {ORIGINES.map(([k, l]) => (
                <Puce key={k} on={f.origine === k} n={comptes.origine[k]} onClick={() => setF((x) => ({ ...x, origine: k }))}>{l}</Puce>
              ))}
            </span>
          </div>
        </div>

        <table className="w-full table-fixed border-collapse text-sm max-[900px]:block">
          <colgroup className="max-[900px]:hidden"><col className="w-[27%]" /><col className="w-[31%]" /><col className="w-[14%]" /><col className="w-[10%]" /><col className="w-[8%]" /><col className="w-[10%]" /></colgroup>
          <thead className="border-b border-border bg-secondary/50 max-[900px]:hidden">
            <tr>
              <th className={TH}>Demande</th>
              <th className={cn(TH, SEP)}>Postes · imputation</th>
              <th className={cn(TH, SEP)}>Pièces</th>
              <th className={cn(TH, SEP, "text-right")}>Accordé</th>
              <th className={cn(TH, SEP, "text-right")}>Engagé</th>
              <th className={cn(TH, SEP, "text-right")}>Réglé</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border max-[900px]:block">
            {visibles.map((d) => {
              const m = montantsDansLaCategorie(d, idsCat);
              const replies = d.postes.length > 3 && !ouvertes.has(d.cle);
              const postes = replies ? d.postes.slice(0, 2) : d.postes;
              return (
                <tr key={d.cle} className="hover:bg-secondary/30 max-[900px]:grid max-[900px]:gap-2.5 max-[900px]:px-4 max-[900px]:py-3">
                  <td className={TD} data-l="Demande">
                    <button type="button" className="text-left font-semibold text-primary hover:underline [overflow-wrap:anywhere]" onClick={() => ouvrir(d)}>{d.libelle}</button>
                    <div className="text-xs text-muted-foreground">
                      {d.nature}{d.date ? ` · ${moisDe(d.date)}` : ""}{d.lieu ? ` · ${d.lieu}` : ""}
                      {d.lignes.length > 0 && <span className="ml-1 rounded border border-border bg-secondary px-1 text-[11px] font-semibold tabular-nums">L{d.lignes.join(" + L")}</span>}
                    </div>
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {d.mode === "CREEE" && <Pastille ton="violet">Historique 2026</Pastille>}
                      {d.mode === "COMPLETEE" && <Pastille ton="info">Complétée</Pastille>}
                      {d.mode === null && d.origine === "HISTORIQUE" && <Pastille ton="violet">Historique 2026</Pastille>}
                      <Pastille ton={d.statut === "PAYEE" ? "ok" : d.statut === "ENGAGEE" ? "warn" : "neutre"}>{LIBELLE_STATUT_DEMANDE[d.statut]}</Pastille>
                    </div>
                  </td>
                  <td className={cn(TD, SEP)} data-l="Postes · imputation">
                    <div className="flex min-w-0 flex-wrap gap-1.5">
                      {postes.map((p) => {
                        const hors = idsCat !== null && !(p.categorieId && idsCat.has(p.categorieId));
                        return (
                          <button key={p.id} type="button" onClick={() => ouvrir(d)} title={p.poste}
                            className={cn("grid min-w-0 max-w-full gap-px rounded-lg border border-border bg-card px-2 py-1.5 text-left hover:border-primary hover:bg-primary/5", hors && "opacity-50")}>
                            <span className="truncate text-xs font-semibold text-primary">{p.categorie}</span>
                            <span className="max-w-[17rem] truncate text-[11px] text-muted-foreground">{p.poste}</span>
                            <span className="text-[11px] tabular-nums">{fmt(p.historique ? p.regle : p.accorde)}</span>
                          </button>
                        );
                      })}
                      {d.postes.length > 3 && (
                        <button type="button" className="self-center text-xs text-muted-foreground hover:text-primary hover:underline" aria-expanded={!replies} onClick={() => basculer(d.cle)}>
                          {replies ? `+ ${d.postes.length - 2} poste${d.postes.length - 2 > 1 ? "s" : ""}` : "Replier"}
                        </button>
                      )}
                    </div>
                  </td>
                  <td className={cn(TD, SEP)} data-l="Pièces">
                    {d.pieces && d.pieces.attendues > 0
                      ? d.pieces.manquantes > 0
                        ? <Pastille ton="warn">{d.pieces.manquantes}/{d.pieces.attendues} manquante{d.pieces.manquantes > 1 ? "s" : ""}</Pastille>
                        : <Pastille ton="ok">complètes</Pastille>
                      : <span className="text-xs text-muted-foreground">—</span>}
                  </td>
                  <td className={cn(TD, SEP, "text-right tabular-nums max-[900px]:text-left")} data-l="Accordé">{fmt(m.accorde)}</td>
                  <td className={cn(TD, SEP, "text-right tabular-nums max-[900px]:text-left")} data-l="Engagé">{m.engage > 0.5 ? fmt(m.engage) : <span className="text-xs text-muted-foreground">—</span>}</td>
                  <td className={cn(TD, SEP, "text-right tabular-nums max-[900px]:text-left")} data-l="Réglé">{m.regle > 0.5 ? fmt(m.regle) : <span className="text-xs text-muted-foreground">—</span>}</td>
                </tr>
              );
            })}
            {visibles.length === 0 && (
              <tr className="max-[900px]:block"><td colSpan={6} className="px-4 py-6 text-center text-sm text-muted-foreground max-[900px]:block">
                {demandes.length === 0 ? "Aucune demande Ad & Pro n'est encore rangée dans cette enveloppe." : "Aucune demande ne répond à ces filtres."}
              </td></tr>
            )}
          </tbody>
        </table>
      </section>

      <FicheDemandeSheet fiche={fiche} onClose={() => setFiche(null)} />
    </>
  );
}

function Tuile({ k, v, c, pastille }: { k: string; v: string; c: string; pastille?: string }) {
  return (
    <div className="surface grid min-w-0 content-start gap-1 rounded-xl px-4 py-3.5">
      <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">{pastille && <i className={cn("inline-block h-2 w-2 rounded-sm", pastille)} aria-hidden />}{k}</span>
      <span className="text-[22px] font-bold tabular-nums tracking-tight [overflow-wrap:anywhere]">{v}</span>
      <span className="text-xs text-muted-foreground">{c}</span>
    </div>
  );
}

function Puce({ on, n, onClick, children }: { on: boolean; n: number; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button" aria-pressed={on} onClick={onClick} disabled={!on && n === 0}
      className={cn("rounded-full border px-3 py-1 text-xs font-medium disabled:cursor-default disabled:opacity-50", on ? "border-primary bg-primary/10 text-primary" : "border-border bg-card hover:bg-secondary")}
    >
      {children}<span className="ml-1 tabular-nums text-muted-foreground">{n}</span>
    </button>
  );
}

function Pastille({ ton, children }: { ton: "violet" | "info" | "ok" | "warn" | "neutre"; children: React.ReactNode }) {
  const c = {
    violet: "bg-violet-500/10 text-violet-600 dark:text-violet-300",
    info: "bg-primary/10 text-primary",
    ok: "bg-success/10 text-success",
    warn: "bg-warning/15 text-warning",
    neutre: "bg-secondary text-muted-foreground",
  }[ton];
  return <span className={cn("inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold", c)}>{children}</span>;
}
