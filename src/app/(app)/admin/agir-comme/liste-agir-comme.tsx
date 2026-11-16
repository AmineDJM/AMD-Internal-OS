"use client";

import * as React from "react";
import { Loader2, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useRetours } from "@/components/ui/retour";
import { annulerGesteAgirComme, annulerToutAgirComme } from "@/lib/actions/impersonation-actions";
import type { GesteAgirComme } from "@/lib/effets/agir-comme-liste";

const quand = (iso: string) => new Date(iso).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });

/** Les gestes, groupés par personne ; chaque ligne s'annule, et « Annuler tout » défait tout ce qui a été fait pour elle. */
export function ListeAgirComme({ gestes }: { gestes: GesteAgirComme[] }) {
  const [busy, setBusy] = React.useState<string | null>(null);
  const [confirmer, setConfirmer] = React.useState<string | null>(null);
  const retours = useRetours();
  const parPersonne = new Map<string, GesteAgirComme[]>();
  for (const g of gestes) parPersonne.set(g.personneId, [...(parPersonne.get(g.personneId) ?? []), g]);

  const lancer = async (cle: string, fn: () => Promise<{ ok: boolean; error?: string; message?: string }>) => {
    setBusy(cle);
    try {
      const r = await fn();
      if (r.ok) retours.succes(r.message ?? "Annulé."); else retours.erreur(r.error ?? "L'annulation n'a pas eu lieu.");
    } catch {
      retours.erreur("L'annulation n'a pas eu lieu : réessayez.");
    } finally {
      setBusy(null);
      setConfirmer(null);
    }
  };

  return (
    <div className="space-y-4">
      {[...parPersonne.entries()].map(([personneId, liste]) => {
        const actifs = liste.filter((g) => !g.annuleLe && g.ecritures > 0).length;
        return (
          <section key={personneId} className="rounded-xl border border-border bg-card">
            <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
              <div className="min-w-0">
                <h2 className="font-semibold">En tant que {liste[0].personne}</h2>
                <p className="text-xs text-muted-foreground">{liste.length} geste(s) · {actifs} encore actif(s)</p>
              </div>
              {actifs > 0 && (confirmer === personneId ? (
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span>Annuler les {actifs} geste(s) faits en tant que {liste[0].personne} ?</span>
                  <Button size="sm" variant="destructive" disabled={busy !== null} onClick={() => void lancer(`tout:${personneId}`, () => annulerToutAgirComme(personneId))}>
                    {busy === `tout:${personneId}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <Undo2 className="h-4 w-4" />} Oui, tout annuler
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirmer(null)}>Non</Button>
                </div>
              ) : (
                <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => setConfirmer(personneId)}>
                  <Undo2 className="h-4 w-4" /> Annuler tout
                </Button>
              ))}
            </header>
            <ul className="divide-y divide-border">
              {liste.map((g) => (
                <li key={g.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5 text-sm">
                  <span className="w-28 shrink-0 tabular-nums text-muted-foreground">{quand(g.quand)}</span>
                  <span className="min-w-0 flex-1 basis-60 [overflow-wrap:anywhere]">
                    {g.libelle}
                    <span className="block text-xs text-muted-foreground">
                      {g.ecritures} écriture(s){g.modeles.length ? ` · ${g.modeles.join(", ")}` : ""} · par {g.superAdmin}
                    </span>
                    {g.annuleLe && <span className="block text-xs text-success">Annulé le {quand(g.annuleLe)}{g.issue ? ` — ${g.issue}` : ""}</span>}
                  </span>
                  {!g.annuleLe && g.ecritures > 0 && (
                    <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void lancer(g.id, () => annulerGesteAgirComme(g.id))}>
                      {busy === g.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Undo2 className="h-4 w-4" />} Annuler
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
