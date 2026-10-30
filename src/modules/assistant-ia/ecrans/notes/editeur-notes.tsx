"use client";

import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check, GripVertical, X } from "lucide-react";
import {
  blocVide, changerType, cocher, deplacerA, deplacerDUnCran, desindenter, indenter, indexDe, raccourci, retirer, sousArbre,
  type BlocNote, type TypeBloc,
} from "../../domaine/notes/blocs";
import type { PropositionNote } from "../../domaine/notes/gestes";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'ÉDITEUR DE « MES NOTES » (décision 0026) — une ligne par bloc, au clavier d'abord.
 *
 *   Entrée            nouvelle ligne (du même type ; sur une puce ou une case vide : on sort de la liste)
 *   Retour arrière    en début de ligne : la puce redevient texte, puis remonte d'un cran, puis rejoint la ligne d'au-dessus
 *   Tab / Maj+Tab     imbriquer / désimbriquer (avec les sous-lignes)
 *   Alt+↑ / Alt+↓     déplacer la ligne (le glisser au clavier) ; ↑ / ↓ en bord de ligne : ligne voisine
 *   Ctrl+Entrée       cocher / décocher (une ligne qui n'est pas une case le devient)
 *   « - » « [] » « # » en début de ligne : puce, case, titre
 *
 * Les modifications PROPOSÉES par l'assistant s'affichent DANS la page, en surbrillance, avec Accepter / Refuser :
 * une ligne proposée n'est pas modifiable — elle n'existe pas tant que la personne ne l'a pas acceptée.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface ProprietesEditeur {
  blocs: BlocNote[];
  onChange: (blocs: BlocNote[]) => void;
  /** Les propositions EN ATTENTE pour cette page. */
  propositions: PropositionNote[];
  onDecider: (id: string, decision: "accepter" | "refuser") => void;
  /** Les lignes que l'assistant vient de modifier (acceptées) : surlignées quelques secondes. */
  neuves: ReadonlySet<string>;
  /** La ligne active (la barre d'outils insère après elle). */
  onActive?: (id: string | null) => void;
  enLecture?: boolean;
  /** Une ligne que la barre d'outils vient d'insérer : le curseur y va. */
  aFocaliser?: { id: string; jeton: number } | null;
}

type Ligne = { cle: string; bloc: BlocNote; proposition?: PropositionNote; fantome?: boolean };

const PLACEHOLDER = "Écrivez… « - » puce, « [] » case, « # » titre";

/** Les lignes à l'écran : les vraies, et les lignes proposées (fantômes) posées après leur repère. */
function lignesAffichees(blocs: BlocNote[], propositions: PropositionNote[]): Ligne[] {
  const out: Ligne[] = blocs.map((b) => ({ cle: b.id, bloc: b, proposition: propositions.find((p) => p.geste !== "ajouter_note" && p.cible.id === b.id) }));
  for (const p of propositions) {
    if (p.geste !== "ajouter_note" || !p.cible.bloc) continue;
    const j = p.cible.apres ? out.findIndex((l) => l.bloc.id === p.cible.apres) : -1;
    const fantome: Ligne = { cle: `p-${p.id}`, bloc: p.cible.bloc, proposition: p, fantome: true };
    if (p.cible.apres && j < 0) out.push(fantome);
    else out.splice(j + 1, 0, fantome);
  }
  return out;
}

const LIBELLE_PROPOSITION: Record<string, string> = {
  ajouter_note: "Ajout proposé", modifier_note: "Modification proposée", cocher_note: "Proposé : cocher", deplacer_note: "Déplacement proposé",
  supprimer_note: "Suppression proposée",
};

export function EditeurNotes({ blocs, onChange, propositions, onDecider, neuves, onActive, enLecture, aFocaliser }: ProprietesEditeur) {
  const champs = useRef(new Map<string, HTMLTextAreaElement>());
  const [focus, setFocus] = useState<{ id: string; pos: number | "fin" } | null>(null);
  const [glisse, setGlisse] = useState<string | null>(null);
  const [cible, setCible] = useState<{ id: string; apres: boolean } | null>(null);

  // Le focus demandé par un geste (nouvelle ligne, fusion…), posé une fois le rendu fait.
  useLayoutEffect(() => {
    if (!focus) return;
    const el = champs.current.get(focus.id);
    if (!el) return;
    el.focus();
    const p = focus.pos === "fin" ? el.value.length : Math.min(focus.pos, el.value.length);
    el.setSelectionRange(p, p);
    setFocus(null);
  }, [focus, blocs]);

  useEffect(() => { if (aFocaliser) setFocus({ id: aFocaliser.id, pos: "fin" }); }, [aFocaliser]);

  // Chaque zone de texte prend la hauteur de son contenu.
  // … et la reprend quand la largeur change (téléphone tourné, panneau qui passe en plein écran).
  useEffect(() => {
    const ajuster = () => { for (const el of champs.current.values()) { el.style.height = "auto"; el.style.height = `${el.scrollHeight}px`; } };
    ajuster();
    window.addEventListener("resize", ajuster);
    return () => window.removeEventListener("resize", ajuster);
  }, [blocs, propositions]);

  const changer = (id: string, texte: string) => {
    const b = blocs.find((x) => x.id === id);
    if (!b) return;
    const r = raccourci({ ...b, texte });
    onChange(blocs.map((x) => (x.id === id ? r ?? { ...x, texte } : x)));
    if (r) setFocus({ id, pos: 0 });
  };

  const clavier = (e: React.KeyboardEvent<HTMLTextAreaElement>, b: BlocNote) => {
    const el = e.currentTarget;
    const debut = el.selectionStart === 0 && el.selectionEnd === 0;
    const fin = el.selectionStart === el.value.length;
    const i = indexDe(blocs, b.id);
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      onChange(b.type === "tache" ? cocher(blocs, b.id, !b.fait) : changerType(blocs, b.id, "tache"));
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      // Une puce ou une case VIDE : on sort de la liste (un cran à gauche, puis texte).
      if (!b.texte && (b.type === "puce" || b.type === "tache")) {
        onChange(b.niveau > 0 ? desindenter(blocs, b.id) : changerType(blocs, b.id, "texte"));
        return;
      }
      const c = el.selectionStart;
      const type: TypeBloc = b.type === "titre" ? "texte" : b.type;
      const neuf = { ...blocVide(type, b.niveau), texte: b.texte.slice(el.selectionEnd) };
      const tete = blocs.map((x) => (x.id === b.id ? { ...x, texte: x.texte.slice(0, c) } : x));
      onChange([...tete.slice(0, i + 1), neuf, ...tete.slice(i + 1)]);
      setFocus({ id: neuf.id, pos: 0 });
      return;
    }
    if (e.key === "Backspace" && debut) {
      if (b.type !== "texte") { e.preventDefault(); onChange(changerType(blocs, b.id, "texte")); return; }
      if (b.niveau > 0) { e.preventDefault(); onChange(desindenter(blocs, b.id)); return; }
      if (i > 0) {
        e.preventDefault();
        const prec = blocs[i - 1];
        const pos = prec.texte.length;
        onChange(blocs.filter((x) => x.id !== b.id).map((x) => (x.id === prec.id ? { ...x, texte: x.texte + b.texte } : x)));
        setFocus({ id: prec.id, pos });
      }
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      onChange(e.shiftKey ? desindenter(blocs, b.id) : indenter(blocs, b.id));
      setFocus({ id: b.id, pos: el.selectionStart });
      return;
    }
    if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      onChange(deplacerDUnCran(blocs, b.id, e.key === "ArrowUp" ? -1 : 1));
      setFocus({ id: b.id, pos: el.selectionStart });
      return;
    }
    if (e.key === "ArrowUp" && debut && i > 0) { e.preventDefault(); setFocus({ id: blocs[i - 1].id, pos: "fin" }); return; }
    if (e.key === "ArrowDown" && fin && i < blocs.length - 1) { e.preventDefault(); setFocus({ id: blocs[i + 1].id, pos: 0 }); }
  };

  /** Le dépôt d'une ligne glissée : avant ou après la ligne survolée (et son sous-arbre). */
  const deposer = (cibleId: string, apres: boolean) => {
    if (!glisse || glisse === cibleId) return;
    const i = indexDe(blocs, glisse);
    const [d, f] = sousArbre(blocs, i);
    if (blocs.slice(d, f).some((x) => x.id === cibleId)) return;
    const reste = [...blocs.slice(0, d), ...blocs.slice(f)];
    const j = indexDe(reste, cibleId);
    if (j < 0) return;
    onChange(deplacerA(blocs, glisse, apres ? sousArbre(reste, j)[1] : j));
  };

  const lignes = lignesAffichees(blocs, propositions);

  return (
    <div className="flex flex-col gap-0.5" data-testid="notes-editeur" onDragEnd={() => { setGlisse(null); setCible(null); }}>
      {lignes.map(({ cle, bloc: b, proposition: p, fantome }) => {
        const proposeeVue = p ? (p.geste === "modifier_note" ? { ...b, texte: p.cible.texte ?? b.texte } : p.geste === "cocher_note" ? { ...b, type: "tache" as const, fait: p.cible.fait } : b) : b;
        const v = proposeeVue;
        const barre = v.type === "tache" && v.fait;
        const supprimee = p?.geste === "supprimer_note";
        return (
          <div
            key={cle}
            data-testid={fantome ? "note-ligne-proposee" : "note-ligne"}
            data-bloc={b.id}
            data-type={v.type}
            data-fait={v.type === "tache" ? String(!!v.fait) : undefined}
            className={[
              "group relative flex items-start gap-1.5 rounded-lg py-0.5 pr-1 transition-colors duration-700 motion-reduce:transition-none",
              p ? (supprimee ? "bg-red-50 ring-1 ring-red-200 dark:bg-red-950/30 dark:ring-red-900/60" : "bg-amber-50 ring-1 ring-amber-300 dark:bg-amber-950/30 dark:ring-amber-800/70") : "",
              !p && neuves.has(b.id) ? "bg-amber-100/80 dark:bg-amber-900/40" : "",
              glisse === b.id ? "opacity-40" : "",
              cible?.id === b.id ? (cible.apres ? "shadow-[inset_0_-2px_0_0_theme(colors.violet.500)]" : "shadow-[inset_0_2px_0_0_theme(colors.violet.500)]") : "",
            ].join(" ")}
            style={{ paddingLeft: `${4 + v.niveau * 22}px` }}
            onDragOver={(e) => {
              if (!glisse || p) return;
              e.preventDefault();
              const r = e.currentTarget.getBoundingClientRect();
              setCible({ id: b.id, apres: e.clientY > r.top + r.height / 2 });
            }}
            onDrop={(e) => { e.preventDefault(); if (cible) deposer(cible.id, cible.apres); setGlisse(null); setCible(null); }}
          >
            {!p && !enLecture ? (
              <button
                type="button" draggable
                onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", b.id); setGlisse(b.id); }}
                onKeyDown={(e) => {
                  if (e.key === "ArrowUp" || e.key === "ArrowDown") { e.preventDefault(); onChange(deplacerDUnCran(blocs, b.id, e.key === "ArrowUp" ? -1 : 1)); }
                }}
                aria-label={`Déplacer la ligne « ${b.texte.slice(0, 40) || "vide"} » (glisser, ou flèches haut / bas)`}
                title="Glisser pour déplacer (ou flèches haut / bas)"
                className="mt-1 flex h-5 w-4 shrink-0 cursor-grab items-center justify-center rounded text-slate-300 opacity-0 hover:text-slate-500 focus:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 dark:text-zinc-600"
              >
                <GripVertical className="h-3.5 w-3.5" />
              </button>
            ) : <span className="w-4 shrink-0" />}
            {v.type === "tache" ? (
              <input
                type="checkbox" checked={!!v.fait} disabled={!!p || enLecture}
                onChange={() => onChange(cocher(blocs, b.id, !b.fait))}
                aria-label={`Fait : ${b.texte || "case vide"}`}
                className="mt-[5px] h-4 w-4 shrink-0 cursor-pointer accent-violet-600"
              />
            ) : (
              <span aria-hidden className="mt-px w-4 shrink-0 text-center text-slate-400 dark:text-zinc-500">{v.type === "puce" ? (v.niveau % 2 ? "◦" : "•") : ""}</span>
            )}
            <div className="min-w-0 flex-1">
              {p ? (
                <div className={`py-0.5 text-[14px] leading-6 [overflow-wrap:anywhere] ${v.type === "titre" ? "font-semibold" : ""} ${barre || supprimee ? "text-slate-400 line-through" : "text-slate-800 dark:text-zinc-100"}`}>
                  {p.geste === "modifier_note" && <span className="mr-1 text-slate-400 line-through">{b.texte}</span>}
                  {v.texte || <span className="italic text-slate-400">(vide)</span>}
                </div>
              ) : (
                <textarea
                  ref={(el) => { if (el) champs.current.set(b.id, el); else champs.current.delete(b.id); }}
                  value={b.texte} rows={1} readOnly={enLecture}
                  onChange={(e) => changer(b.id, e.target.value)}
                  onKeyDown={(e) => clavier(e, b)}
                  onFocus={() => onActive?.(b.id)}
                  placeholder={blocs.length === 1 ? PLACEHOLDER : undefined}
                  aria-label={b.type === "titre" ? "Titre" : b.type === "tache" ? "Case à cocher" : b.type === "puce" ? "Puce" : "Ligne"}
                  className={`block w-full resize-none overflow-hidden bg-transparent py-0.5 text-[14px] leading-6 outline-none placeholder:text-slate-400 focus-visible:ring-0 ${b.type === "titre" ? "pt-2 text-[15.5px] font-semibold text-slate-900 dark:text-zinc-50" : "text-slate-800 dark:text-zinc-100"} ${barre ? "text-slate-400 line-through dark:text-zinc-500" : ""}`}
                />
              )}
              {p && (
                <div className="mb-1 mt-0.5 flex flex-wrap items-center gap-1.5 text-[12px]">
                  <span className={`font-medium ${supprimee ? "text-red-700 dark:text-red-400" : "text-amber-800 dark:text-amber-300"}`}>{LIBELLE_PROPOSITION[p.geste] ?? "Proposé"} par l&apos;assistant</span>
                  <button type="button" onClick={() => onDecider(p.id, "accepter")} className="inline-flex h-7 items-center gap-1 rounded-md bg-violet-600 px-2 font-medium text-white hover:bg-violet-700">
                    <Check className="h-3 w-3" /> Accepter
                  </button>
                  <button type="button" onClick={() => onDecider(p.id, "refuser")} className="inline-flex h-7 items-center gap-1 rounded-md px-2 font-medium text-slate-600 hover:bg-white dark:text-zinc-300 dark:hover:bg-zinc-900">
                    <X className="h-3 w-3" /> Refuser
                  </button>
                </div>
              )}
            </div>
            {!p && !enLecture && (
              <button
                type="button" onClick={() => onChange(retirer(blocs, b.id))}
                aria-label={`Supprimer la ligne « ${b.texte.slice(0, 40) || "vide"} »`} title="Supprimer la ligne (30 jours à la corbeille)"
                className="mt-1 flex h-5 w-5 shrink-0 items-center justify-center rounded text-slate-400 opacity-0 hover:text-red-600 focus:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
