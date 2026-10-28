"use client";

import * as React from "react";
import { apercuReprise, executerReprise } from "@/lib/actions/refonte-reprise-actions";
import type { BilanReprise } from "@/lib/referentiels/reprises/types";
import { Button } from "@/components/ui/button";

/**
 * UNE REPRISE : l'aperçu à blanc, puis un lot à la fois — le curseur du lot suivant est gardé à l'écran,
 * et chaque bilan s'ajoute au journal de la carte (le journal durable est l'audit).
 */
const resume = (b: BilanReprise) =>
  `${b.lues} lue(s), ${b.creees} créée(s), ${b.liees} liée(s), ${b.doublonsProposes} doublon(s) proposé(s), ${b.ignorees} ignorée(s)${b.erreurs.length ? ` — ${b.erreurs.join(" ")}` : ""}`;

export function CarteReprise({ cle, titre, description }: { cle: string; titre: string; description: string }) {
  const [pending, start] = React.useTransition();
  const [suite, setSuite] = React.useState<string | null>(null);
  const [termine, setTermine] = React.useState(false);
  const [journal, setJournal] = React.useState<string[]>([]);
  const noter = (l: string) => setJournal((j) => [`${new Date().toLocaleTimeString("fr-FR")} — ${l}`, ...j].slice(0, 30));

  return (
    <div className="rounded-md border p-4" data-testid={`reprise-${cle}`}>
      <div className="font-medium">{titre}</div>
      <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={pending} onClick={() => start(async () => {
          const r = await apercuReprise(cle);
          noter(r.ok ? `Aperçu : ${resume(r.bilan)}` : r.message);
        })}>Aperçu à blanc</Button>
        <Button size="sm" disabled={pending || termine} onClick={() => start(async () => {
          const r = await executerReprise(cle, suite);
          if (!r.ok) return noter(r.message);
          noter(`Lot : ${resume(r.bilan)}`);
          setSuite(r.suite ?? null);
          if (!r.suite) setTermine(true);
        })}>{termine ? "Terminée" : suite ? "Lot suivant" : "Exécuter un lot"}</Button>
        {termine && <Button size="sm" variant="ghost" disabled={pending} onClick={() => { setSuite(null); setTermine(false); }}>Rejouer depuis le début</Button>}
      </div>
      {journal.length > 0 && (
        <ul className="mt-3 space-y-1 text-xs text-muted-foreground" data-testid={`reprise-journal-${cle}`}>
          {journal.map((l, i) => <li key={i}>{l}</li>)}
        </ul>
      )}
    </div>
  );
}
