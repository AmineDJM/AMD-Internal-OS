"use client";

/**
 * LES PRATICIENS — les éditeurs de cellule (texte, choix) et le motif d'une lettre forcée.
 */
import * as React from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import type { Lettre } from "@/lib/segmentation/regles";
import { type Deplacement, type Choix, plie, libelleLettre, champ } from "./modele";
import { Flottant } from "./flottant";

// ─────────────────────────────── Les éditeurs ───────────────────────────────

function touchesDeSortie(e: React.KeyboardEvent, valider: (dep: Deplacement) => void, annuler: () => void): boolean {
  if (e.key === "Enter") { e.preventDefault(); valider(e.shiftKey ? "haut" : "bas"); return true; }
  if (e.key === "Tab") { e.preventDefault(); valider(e.shiftKey ? "gauche" : "droite"); return true; }
  if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); annuler(); return true; }
  return false;
}

export function EditeurTexte({ initial, numerique, selectionner, onValider, onAnnuler }: {
  initial: string; numerique: boolean; selectionner: boolean; onValider: (brut: string, dep: Deplacement) => void; onAnnuler: (refocaliser: boolean) => void;
}) {
  const [texte, setTexte] = React.useState(initial);
  const fait = React.useRef(false);
  const ref = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    if (selectionner) el.select(); else el.setSelectionRange(el.value.length, el.value.length);
  }, [selectionner]);
  const sortir = (dep: Deplacement) => { if (fait.current) return; fait.current = true; onValider(texte, dep); };
  const annuler = () => { if (fait.current) return; fait.current = true; onAnnuler(true); };
  return (
    <input
      ref={ref} value={texte} inputMode={numerique ? "decimal" : undefined} aria-label="Valeur"
      onChange={(e) => setTexte(e.target.value)}
      onKeyDown={(e) => { touchesDeSortie(e, sortir, annuler); }}
      onBlur={() => sortir(null)}
      onClick={(e) => e.stopPropagation()}
      className={cn("w-full min-w-[80px] rounded-md border border-primary bg-background px-2 py-1 text-sm outline-none", numerique && "w-[64px] min-w-0 text-center")}
    />
  );
}

/** UN MENU DÉROULANT QUI SE TAPE : la liste filtre à la frappe, ↑ ↓ choisissent, Entrée / Tab valident, Échap annule. */
export function EditeurChoix({ options, courant, recherche, selectionner, onValider, onAnnuler }: {
  options: Choix[]; courant: string; recherche: string; selectionner: boolean; onValider: (brut: string, dep: Deplacement) => void; onAnnuler: (refocaliser: boolean) => void;
}) {
  const [q, setQ] = React.useState(recherche);
  const idListe = React.useId();
  const [ancre, setAncre] = React.useState<HTMLInputElement | null>(null);
  const fait = React.useRef(false);
  const filtrees = React.useMemo(() => {
    const mots = plie(q).split(/\s+/).filter(Boolean);
    const r = mots.length ? options.filter((o) => { const t = plie(`${o.libelle} ${o.detail ?? ""}`); return mots.every((m) => t.includes(m)); }) : options;
    return mots.length ? r.slice(0, 150) : r;
  }, [options, q]);
  const [iBrut, setI] = React.useState(() => (recherche ? 0 : Math.max(0, options.findIndex((o) => o.valeur === courant))));
  const i = Math.max(0, Math.min(iBrut, filtrees.length - 1));
  const qPrec = React.useRef(q);
  React.useEffect(() => { if (qPrec.current !== q) { qPrec.current = q; setI(0); } }, [q]);
  React.useEffect(() => {
    if (!ancre) return;
    ancre.focus();
    if (selectionner) ancre.select(); else ancre.setSelectionRange(ancre.value.length, ancre.value.length);
  }, [ancre, selectionner]);
  const listeRef = React.useRef<HTMLDivElement | null>(null);
  const iRef = React.useRef(i);
  iRef.current = i;
  const voir = (el: HTMLElement | null, k: number) => el?.querySelector<HTMLElement>(`[data-i="${k}"]`)?.scrollIntoView({ block: "nearest" });
  React.useEffect(() => { voir(listeRef.current, i); }, [i]);
  // La liste naît dans le panneau flottant après coup : à sa naissance, l'option en cours est amenée en vue.
  const poserListe = React.useCallback((el: HTMLDivElement | null) => { listeRef.current = el; voir(el, iRef.current); }, []);

  const choisir = (o: Choix | undefined, dep: Deplacement) => {
    if (fait.current) return;
    fait.current = true;
    if (o) onValider(o.valeur, dep); else onAnnuler(true);
  };
  const annuler = (refocaliser: boolean) => { if (fait.current) return; fait.current = true; onAnnuler(refocaliser); };
  const courantLib = options.find((o) => o.valeur === courant)?.libelle ?? "";
  return (
    <>
      <input
        ref={setAncre} value={q} placeholder={courantLib || "Choisir…"} aria-label="Choisir" role="combobox" aria-expanded={true} aria-controls={idListe} aria-autocomplete="list"
        onChange={(e) => setQ(e.target.value)}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setI((x) => Math.min(filtrees.length - 1, x + 1)); return; }
          if (e.key === "ArrowUp") { e.preventDefault(); setI((x) => Math.max(0, x - 1)); return; }
          touchesDeSortie(e, (dep) => choisir(filtrees[i], dep), () => annuler(true));
        }}
        className="w-full min-w-[140px] rounded-md border border-primary bg-background px-2 py-1 text-sm outline-none"
      />
      {ancre && (
        <Flottant ancre={ancre} onFermer={() => annuler(false)} largeur={Math.max(220, Math.min(360, ancre.getBoundingClientRect().width + 80))} garderFocus>
          <div ref={poserListe} id={idListe} role="listbox" className="py-1 text-sm">
            {filtrees.map((o, k) => (
              <div
                key={o.valeur || "__vide"} data-i={k} role="option" aria-selected={k === i}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setI(k)}
                onClick={() => choisir(o, "ici")}
                className={cn("flex cursor-pointer items-baseline justify-between gap-3 px-3 py-1.5", k === i && "bg-secondary", o.valeur === courant && "font-semibold")}
              >
                <span className="min-w-0 [overflow-wrap:anywhere]">{o.libelle}</span>
                {o.detail && <span className="shrink-0 text-xs text-muted-foreground">{o.detail}</span>}
              </div>
            ))}
            {filtrees.length === 0 && <p className="px-3 py-2 text-muted-foreground">Aucun résultat.</p>}
          </div>
        </Flottant>
      )}
    </>
  );
}

export function FormMotif({ lettre, calculee, onValider, onAnnuler }: { lettre: Lettre; calculee: Lettre | null; onValider: (motif: string) => void; onAnnuler: () => void }) {
  const [t, setT] = React.useState("");
  const ok = t.trim().length >= 3;
  return (
    <form className="space-y-2 p-3 text-sm" onSubmit={(e) => { e.preventDefault(); if (ok) onValider(t.trim()); }}>
      <p className="font-medium">Forcer à {libelleLettre(lettre)} <span className="font-normal text-muted-foreground">(calculé : {libelleLettre(calculee)})</span></p>
      <input autoFocus value={t} onChange={(e) => setT(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onAnnuler(); } }} placeholder="Motif (obligatoire)" aria-label="Motif" className={cn(champ, "w-full")} />
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onAnnuler}>Annuler</Button>
        <Button type="submit" size="sm" disabled={!ok}>Forcer</Button>
      </div>
    </form>
  );
}
