"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apercuReprise, executerReprise, type ResultatReprise } from "@/lib/actions/refonte-reprise-actions";
import { resumeBilan } from "@/lib/referentiels/reprises/journal";
import type { BilanReprise } from "@/lib/referentiels/reprises/types";

export interface EntreeJournal { id: string; quand: string; qui: string; resume: string }

/**
 * UNE REPRISE : aperçu à blanc, un lot, ou tous les lots à la suite (l'écran rappelle l'action avec la `suite`
 * tant qu'il en reste — chaque lot est une requête courte, et s'arrête au premier échec).
 */
export function CarteReprise({ cle, titre, description, journal }: { cle: string; titre: string; description: string; journal: EntreeJournal[] }) {
  const [busy, setBusy] = React.useState<null | "apercu" | "lot" | "tout">(null);
  const [apercu, setApercu] = React.useState<BilanReprise | null>(null);
  const [cumul, setCumul] = React.useState<BilanReprise | null>(null);
  const [suite, setSuite] = React.useState<string | null>(null);
  const [erreur, setErreur] = React.useState<string | null>(null);
  const arreter = React.useRef(false);

  const ajouter = (a: BilanReprise | null, b: BilanReprise): BilanReprise => a ? {
    lues: a.lues + b.lues, creees: a.creees + b.creees, liees: a.liees + b.liees, doublonsProposes: a.doublonsProposes + b.doublonsProposes,
    ignorees: a.ignorees + b.ignorees, erreurs: [...a.erreurs, ...b.erreurs].slice(0, 50),
  } : b;

  const lancerApercu = async () => {
    setBusy("apercu"); setErreur(null);
    const r = await apercuReprise(cle);
    if (r.ok && r.bilan) setApercu(r.bilan); else setErreur(r.error ?? "Échec.");
    setBusy(null);
  };

  const unLot = async (curseur: string | null, total: BilanReprise | null): Promise<{ r: ResultatReprise; total: BilanReprise | null }> => {
    const r = await executerReprise(cle, curseur);
    if (!r.ok || !r.bilan) { setErreur(r.error ?? "Échec."); return { r, total }; }
    const t = ajouter(total, r.bilan);
    setCumul(t);
    setSuite(r.suite ?? null);
    return { r, total: t };
  };

  const lancerLot = async () => {
    setBusy("lot"); setErreur(null);
    await unLot(suite, cumul);
    setBusy(null);
  };

  const lancerTout = async () => {
    setBusy("tout"); setErreur(null); arreter.current = false;
    let curseur = suite;
    let total = cumul;
    for (;;) {
      const { r, total: t } = await unLot(curseur, total);
      total = t;
      if (!r.ok || !r.suite || arreter.current || (r.bilan?.erreurs.length ?? 0) > 0) break;
      curseur = r.suite;
    }
    setBusy(null);
  };

  return (
    <section className="surface min-w-0 space-y-3 p-3 sm:p-4">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold [overflow-wrap:anywhere]">{titre}</h3>
        <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{description}</p>
        <p className="font-mono text-[11px] text-muted-foreground">{cle}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={!!busy} onClick={lancerApercu}>
          {busy === "apercu" && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Aperçu à blanc
        </Button>
        <Button size="sm" variant="secondary" disabled={!!busy} onClick={lancerLot}>
          {busy === "lot" && <Loader2 className="h-3.5 w-3.5 animate-spin" />} {suite ? "Lot suivant" : "Exécuter un lot"}
        </Button>
        <Button size="sm" disabled={!!busy} onClick={lancerTout}>
          {busy === "tout" && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Tout exécuter
        </Button>
        {busy === "tout" && <Button size="sm" variant="ghost" onClick={() => { arreter.current = true; }}>Arrêter après ce lot</Button>}
      </div>
      {apercu && <p className="text-sm"><b>Aperçu :</b> {resumeBilan(apercu)}</p>}
      {cumul && <p className="text-sm"><b>Exécuté :</b> {resumeBilan(cumul)}{suite ? " — il en reste." : " — terminé."}</p>}
      {[...(apercu?.erreurs ?? []), ...(cumul?.erreurs ?? [])].length > 0 && (
        <ul className="list-disc space-y-0.5 pl-5 text-xs text-destructive [overflow-wrap:anywhere]">
          {[...(apercu?.erreurs ?? []), ...(cumul?.erreurs ?? [])].slice(0, 10).map((e, i) => <li key={i}>{e}</li>)}
        </ul>
      )}
      {erreur && <p className="text-sm text-destructive">{erreur}</p>}
      {journal.length > 0 && (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">Journal ({journal.length})</summary>
          <ul className="mt-1 space-y-1">
            {journal.map((j) => (
              <li key={j.id} className="[overflow-wrap:anywhere]">{new Date(j.quand).toLocaleString("fr-FR")} — {j.qui} — {j.resume}</li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
