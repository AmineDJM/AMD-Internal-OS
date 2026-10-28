"use client";

/**
 * LES PRATICIENS — le filtre d'une colonne (liste, texte, plage).
 */
import * as React from "react";
import { cn } from "@/lib/utils";
import { valeursDuFiltre, basculerValeur, retirerFiltre, type Colonne, type EtatTableau, type LigneTri, type FiltreListe } from "@/lib/segmentation/tableau-praticiens";
import { FILTRE_DE, estTexte, LIBELLES, champ, estPlage, fmt, libelleFiltre, plie } from "./modele";

// ─────────────────────────────── Le filtre d'une colonne ───────────────────────────────

export function PanneauFiltre({ col, etat, setEtat, lignes }: { col: Colonne; etat: EtatTableau; setEtat: React.Dispatch<React.SetStateAction<EtatTableau>>; lignes: LigneTri[] }) {
  const f = FILTRE_DE[col]!;
  if (estTexte(f)) {
    return (
      <div className="p-3">
        <input autoFocus value={etat.textes[f] ?? ""} onChange={(e) => { const t = e.target.value; setEtat((x) => ({ ...x, textes: { ...x.textes, [f]: t } })); }} placeholder="Contient…" aria-label={`${LIBELLES[col]} contient`} className={cn(champ, "w-full")} />
      </div>
    );
  }
  if (estPlage(f)) {
    const p = etat.plages[f] ?? { min: null, max: null };
    const poser = (cle: "min" | "max", s: string) => {
      const t = s.trim().replace(",", ".");
      const n = t === "" ? null : Number(t);
      if (n !== null && !Number.isFinite(n)) return;
      setEtat((x) => ({ ...x, plages: { ...x.plages, [f]: { ...(x.plages[f] ?? { min: null, max: null }), [cle]: n } } }));
    };
    return (
      <div className="flex items-center gap-2 p-3 text-sm">
        <input autoFocus defaultValue={fmt(p.min)} onChange={(e) => poser("min", e.target.value)} inputMode="decimal" placeholder="min" aria-label="Minimum" className={cn(champ, "w-20")} />
        <span className="text-muted-foreground">à</span>
        <input defaultValue={fmt(p.max)} onChange={(e) => poser("max", e.target.value)} inputMode="decimal" placeholder="max" aria-label="Maximum" className={cn(champ, "w-20")} />
        {f === "pct" && <span className="text-muted-foreground">%</span>}
      </div>
    );
  }
  return (
    <div className="max-h-[inherit] overflow-y-auto">
      <ListeFiltre f={f as FiltreListe} etat={etat} setEtat={setEtat} lignes={lignes} />
      {col === "cdr" && (
        <div className="border-t border-border">
          <p className="px-3 pt-2 text-[11px] font-medium uppercase text-muted-foreground">In / Out</p>
          <ListeFiltre f="io" etat={etat} setEtat={setEtat} lignes={lignes} />
        </div>
      )}
    </div>
  );
}

function ListeFiltre({ f, etat, setEtat, lignes }: { f: FiltreListe; etat: EtatTableau; setEtat: React.Dispatch<React.SetStateAction<EtatTableau>>; lignes: LigneTri[] }) {
  const [q, setQ] = React.useState("");
  const valeurs = React.useMemo(() => valeursDuFiltre(lignes, f, (l) => libelleFiltre(f, l)), [lignes, f]);
  const choisis = etat.listes[f] ?? [];
  const mots = plie(q).trim();
  const montrees = mots ? valeurs.filter((v) => plie(v.libelle).includes(mots)) : valeurs;
  return (
    <div className="text-sm">
      {valeurs.length > 8 && (
        <div className="p-2 pb-1"><input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Chercher…" aria-label="Chercher une valeur" className={cn(champ, "w-full py-1")} /></div>
      )}
      <div className="py-1">
        {montrees.map((v) => (
          <label key={v.valeur || "__vide"} className="flex cursor-pointer items-center gap-2 px-3 py-1.5 hover:bg-secondary">
            <input type="checkbox" checked={choisis.includes(v.valeur)} onChange={() => setEtat((x) => basculerValeur(x, f, v.valeur))} className="h-4 w-4" />
            <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{v.libelle}</span>
            <span className="text-xs tabular-nums text-muted-foreground">{v.n}</span>
          </label>
        ))}
        {montrees.length === 0 && <p className="px-3 py-1.5 text-muted-foreground">Aucune valeur.</p>}
      </div>
      {choisis.length > 0 && (
        <button type="button" onClick={() => setEtat((x) => retirerFiltre(x, f))} className="w-full border-t border-border px-3 py-1.5 text-left text-xs text-muted-foreground hover:text-foreground">Tout afficher</button>
      )}
    </div>
  );
}
