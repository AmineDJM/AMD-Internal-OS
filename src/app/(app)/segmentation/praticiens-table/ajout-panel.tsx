"use client";

/**
 * LES PRATICIENS — ajouter au panel un praticien de l'annuaire qui n'y est pas encore.
 */
import * as React from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { casseNom } from "@/lib/segmentation/tableau-praticiens";
import { ajouterAuPanel, chercherPraticiensHorsPanel, type PraticienTrouve } from "@/lib/actions/segmentation-actions";
import { champ } from "./modele";

// ─────────────────────────────── Ajouter au panel ───────────────────────────────

/** Ajouter un praticien de l'annuaire au panel. */
export function AjoutPanel({ strategieId, onFait }: { strategieId: string; onFait: () => void }) {
  const [q, setQ] = React.useState("");
  const [res, setRes] = React.useState<PraticienTrouve[]>([]);
  const [erreur, setErreur] = React.useState<string | null>(null);
  const [envoi, setEnvoi] = React.useState(false);
  React.useEffect(() => {
    if (q.trim().length < 2) { setRes([]); return; }
    let actif = true;
    const t = setTimeout(async () => {
      const r = await chercherPraticiensHorsPanel({ strategieId, q });
      if (!actif) return;
      if (r.ok) { setRes(r.praticiens); setErreur(null); } else setErreur(r.error);
    }, 250);
    return () => { actif = false; clearTimeout(t); };
  }, [q, strategieId]);
  return (
    <div className="space-y-2 border-b border-border px-4 py-3 text-sm">
      <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Chercher dans l'annuaire (nom, établissement)…" aria-label="Chercher un praticien" className={cn(champ, "w-full sm:w-96")} autoFocus />
      {erreur && <p className="text-destructive">{erreur}</p>}
      {res.map((p) => (
        <div key={p.id} className="flex flex-wrap items-center justify-between gap-2">
          <span className="min-w-0 [overflow-wrap:anywhere]"><b className="font-medium">{p.nom}</b> <span className="text-muted-foreground">{[p.etablissement, casseNom(p.specialite)].filter(Boolean).join(" · ")}</span></span>
          <Button type="button" size="sm" variant="outline" disabled={envoi} onClick={async () => {
            setEnvoi(true);
            const r = await ajouterAuPanel(strategieId, [p.id], null);
            setEnvoi(false);
            if (r.ok) onFait(); else setErreur(r.error);
          }}>Ajouter</Button>
        </div>
      ))}
      {q.trim().length >= 2 && res.length === 0 && !erreur && <p className="text-muted-foreground">Aucun praticien hors panel ne correspond.</p>}
    </div>
  );
}
