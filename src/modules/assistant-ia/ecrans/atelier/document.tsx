"use client";

import React from "react";
import { Check, Columns2, FileOutput, GitCompare, Loader2, Lock, Redo2, RotateCcw, Save, Undo2, X } from "lucide-react";
import type { VueArtefact } from "@/platform/ia/artifact/view-types";
import { SceneDocx, ScenePdf, ScenePptx, SceneXlsx } from "@/platform/ia/ecrans/blocks/artifact";
import type { OngletOuvert } from "@/modules/assistant-ia/actions-atelier";

/** Où l'on regarde dans un onglet — changé par la personne (miniature) ou par l'Atelier (là où ça change). */
export interface Navigation { diapo: number | null; feuille: string | null; page: number | null }

export interface EtatOnglet extends OngletOuvert {
  vue: VueArtefact;
  nav: Navigation;
  /** Les zones surlignées (ce qui vient de changer) et la révision qui les a fait animer. */
  zones: string[];
  anime: number;
}

const FORMAT: Record<string, string> = { DOCX: "Word", PPTX: "PowerPoint", XLSX: "Excel", PDF: "PDF" };
export const nomFormat = (f: string) => FORMAT[f] ?? f;

/** LA SCÈNE — le rendu fidèle par format, celui du Live Office, avec les zones qui viennent de changer. */
export function SceneAtelier({ vue, nav, zones, anime, onNav }: {
  vue: VueArtefact; nav: Navigation; zones: string[]; anime: boolean; onNav: (n: Partial<Navigation>) => void;
}) {
  const affichee: VueArtefact = {
    ...vue,
    surbrillance: zones,
    activeSlide: nav.diapo ?? vue.activeSlide,
    activeSheet: nav.feuille ?? vue.activeSheet,
    activePage: nav.page ?? vue.activePage,
  };
  const rien = () => undefined;
  return (
    <div className={`artifact h-full${anime ? " atelier-anime" : ""}`} data-format={vue.format}>
      <div className="artifact-scene" key={anime ? `a${vue.revision}` : "fixe"}>
        {affichee.contenu.kind === "DOCX" && <SceneDocx vue={affichee} contenu={affichee.contenu} zoom={0.82} surbrillance={zones} onCliquer={rien} />}
        {affichee.contenu.kind === "PDF" && <ScenePdf vue={affichee} contenu={affichee.contenu} zoom={1} onPage={(p) => onNav({ page: p })} />}
        {affichee.contenu.kind === "PPTX" && <ScenePptx vue={affichee} contenu={affichee.contenu} zoom={1.1} onDiapo={(d) => onNav({ diapo: d })} onForme={rien} />}
        {affichee.contenu.kind === "XLSX" && <SceneXlsx vue={affichee} contenu={affichee.contenu} onFeuille={(f) => onNav({ feuille: f })} onCellule={rien} />}
      </div>
    </div>
  );
}

const bouton = "inline-flex h-8 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800";

/** LA BARRE D'UN ONGLET — annuler, rétablir, comparer, convertir, enregistrer (une NOUVELLE version). */
export function BarreOnglet({ o, occupe, coteACote, peutCote, onAnnuler, onRetablir, onComparer, onConvertir, onEnregistrer, onCote }: {
  o: EtatOnglet; occupe: boolean; coteACote: boolean; peutCote: boolean;
  onAnnuler: () => void; onRetablir: () => void; onComparer: () => void; onConvertir: (vers: string) => void; onEnregistrer: () => void; onCote: () => void;
}) {
  const [menu, setMenu] = React.useState(false);
  const v = o.vue;
  const lecture = o.droits && !o.droits.modifier;
  const version = v.savedVersion ?? v.baseVersion;
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b border-slate-200 px-2 py-1.5 dark:border-zinc-800">
      <button type="button" className={bouton} onClick={onAnnuler} disabled={occupe || !v.peutAnnuler || lecture} aria-label="Annuler la dernière modification" title="Annuler"><Undo2 className="h-3.5 w-3.5" /></button>
      <button type="button" className={bouton} onClick={onRetablir} disabled={occupe || !v.peutRetablir || lecture} aria-label="Rétablir" title="Rétablir"><Redo2 className="h-3.5 w-3.5" /></button>
      <button type="button" className={bouton} onClick={onComparer} disabled={occupe || v.historique.length === 0} data-testid="atelier-comparer"><GitCompare className="h-3.5 w-3.5" /> Comparer</button>
      {(o.conversions?.length ?? 0) > 0 && (
        <span className="relative">
          <button type="button" className={bouton} onClick={() => setMenu((m) => !m)} aria-expanded={menu} disabled={occupe}><FileOutput className="h-3.5 w-3.5" /> Convertir</button>
          {menu && (
            <span role="menu" className="absolute left-0 top-9 z-30 flex w-48 flex-col rounded-lg border border-slate-200 bg-white p-1 shadow-xl dark:border-zinc-800 dark:bg-zinc-950">
              {o.conversions!.map((c) => (
                <button key={c} type="button" role="menuitem" onClick={() => { setMenu(false); onConvertir(c); }}
                  className="rounded-md px-2.5 py-2 text-left text-xs text-slate-700 hover:bg-slate-100 dark:text-zinc-200 dark:hover:bg-zinc-800">
                  {v.format === "DOCX" && c === "XLSX" ? "Tableaux → Excel" : `${nomFormat(v.format)} → ${nomFormat(c)}`}
                </button>
              ))}
            </span>
          )}
        </span>
      )}
      {peutCote && <button type="button" className={bouton} onClick={onCote} aria-pressed={coteACote} title="Deux documents côte à côte"><Columns2 className="h-3.5 w-3.5" /> Côte à côte</button>}
      <span className="ml-auto flex items-center gap-1.5">
        <span className="hidden text-[11px] text-slate-500 sm:inline dark:text-zinc-400">v{version}{v.dirty ? " · modifié" : ""}</span>
        {lecture
          ? <span className="inline-flex items-center gap-1 text-[11px] text-amber-700 dark:text-amber-400"><Lock className="h-3 w-3" /> Lecture seule</span>
          : (
            <button type="button" onClick={onEnregistrer} disabled={occupe || !v.dirty} data-testid="atelier-enregistrer"
              className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-violet-600 px-2.5 text-xs font-semibold text-white hover:bg-violet-700 disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500">
              {occupe ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />} Enregistrer
            </button>
          )}
      </span>
    </div>
  );
}

/**
 * L'HISTORIQUE À REVOIR — une ligne par modification, comme le suivi des modifications : ACCEPTER (on garde,
 * c'est jugé), REFUSER (la modification disparaît du document, rejeu exact), REMETTRE à revoir.
 */
export function RevueModifications({ vue, occupe, onRevoir, onToutAccepter }: {
  vue: VueArtefact; occupe: boolean;
  onRevoir: (seq: number, decision: "ACCEPTER" | "REFUSER" | "A_REVOIR") => void; onToutAccepter: () => void;
}) {
  const lignes = [...vue.historique].sort((a, b) => b.seq - a.seq);
  if (!lignes.length) return null;
  const aRevoir = lignes.filter((l) => !l.annulee && !l.revue).length;
  return (
    <section aria-label="Modifications à revoir" className="max-h-[34%] min-h-[96px] overflow-auto border-t border-slate-200 bg-slate-50/80 px-2 py-1.5 dark:border-zinc-800 dark:bg-zinc-900/60" data-testid="atelier-revue">
      <header className="mb-1 flex items-center gap-2">
        <h3 className="text-xs font-semibold text-slate-700 dark:text-zinc-200">Modifications ({lignes.length}{aRevoir ? ` · ${aRevoir} à revoir` : ""})</h3>
        {aRevoir > 1 && <button type="button" onClick={onToutAccepter} disabled={occupe} className="ml-auto text-[11px] font-medium text-emerald-700 hover:underline disabled:opacity-40 dark:text-emerald-400">Tout accepter</button>}
      </header>
      <ol className="space-y-1">
        {lignes.map((l) => {
          const etat = l.revue === "REFUSEE" ? "refusee" : l.annulee ? "annulee" : l.revue === "ACCEPTEE" ? "acceptee" : "attente";
          return (
            <li key={l.operationId} data-testid="atelier-modif" data-etat={etat}
              className={`flex items-start gap-2 rounded-lg border px-2 py-1.5 text-xs ${etat === "refusee" || etat === "annulee" ? "border-slate-200 bg-white/50 text-slate-400 line-through dark:border-zinc-800 dark:bg-zinc-950/40" : etat === "acceptee" ? "border-emerald-200 bg-emerald-50/60 text-slate-700 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-zinc-200" : "border-amber-200 bg-white text-slate-800 dark:border-amber-900 dark:bg-zinc-950 dark:text-zinc-100"}`}>
              <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                <span className="no-underline">{l.resume}</span>
                <span className="mt-0.5 block text-[10px] text-slate-500 no-underline dark:text-zinc-400">{l.acteur ?? ""} · {etat === "attente" ? "à revoir" : etat === "acceptee" ? "acceptée" : etat === "refusee" ? "refusée" : "annulée"}</span>
              </span>
              {etat === "attente" && (
                <>
                  <button type="button" disabled={occupe} onClick={() => onRevoir(l.seq, "ACCEPTER")} aria-label={`Accepter : ${l.resume}`} title="Accepter" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-emerald-700 hover:bg-emerald-100 disabled:opacity-40 dark:text-emerald-400 dark:hover:bg-emerald-950"><Check className="h-4 w-4" /></button>
                  <button type="button" disabled={occupe} onClick={() => onRevoir(l.seq, "REFUSER")} aria-label={`Refuser : ${l.resume}`} title="Refuser" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-red-700 hover:bg-red-100 disabled:opacity-40 dark:text-red-400 dark:hover:bg-red-950"><X className="h-4 w-4" /></button>
                </>
              )}
              {etat !== "attente" && (
                <button type="button" disabled={occupe} onClick={() => onRevoir(l.seq, "A_REVOIR")} aria-label={`Remettre à revoir : ${l.resume}`} title={etat === "acceptee" ? "Remettre à revoir" : "Rétablir"} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-slate-500 hover:bg-slate-200 disabled:opacity-40 dark:hover:bg-zinc-800"><RotateCcw className="h-3.5 w-3.5" /></button>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
