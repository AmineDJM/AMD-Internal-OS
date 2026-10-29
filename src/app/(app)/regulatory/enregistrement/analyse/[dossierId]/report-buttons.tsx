"use client";

import * as React from "react";

import { Loader2, FileDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";
import { generateFindingsReportAction, generateReserveLetterAction } from "@/lib/regulatory/intelligence/docgen/actions";

/**
 * Boutons « produire le .docx » depuis l'analyse. Un clic = le document est composé, stocké
 * (chiffré + audité, visible dans « Génération documentaire ») ET téléchargé immédiatement —
 * pas de deuxième clic à chercher.
 */

function useGenerate() {
  const { rafraichir } = useRafraichir();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const lock = React.useRef(false);

  const run = (fn: () => Promise<{ ok: boolean; error?: string; generatedDocId?: string }>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        const r = await fn();
        if (r.ok && r.generatedDocId) {
          window.location.assign(`/api/regulatory/intelligence/generated/${r.generatedDocId}`);
          rafraichir();
        } else if (!r.ok) {
          setError(r.error ?? "Le document n'a pas été généré.");
        }
      } catch {
        setError(actionFailureMessage("THROWN"));
      } finally {
        setBusy(false);
        lock.current = false;
      }
    })();
  };

  return { busy, error, run };
}

/** Rapport de constats (.docx) — groupé par gravité, avec preuves, pages et recommandations. */
export function FindingsReportButton({ dossierId }: { dossierId: string }) {
  const { busy, error, run } = useGenerate();
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <Button
        type="button" size="sm" variant="outline" disabled={busy}
        title="Produire le rapport de constats (.docx) — groupé par gravité, avec preuves et pages"
        onClick={() => run(() => { const fd = new FormData(); fd.set("dossierId", dossierId); return generateFindingsReportAction(fd); })}
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileDown className="h-4 w-4" />} Rapport (.docx)
      </Button>
      {error && <span className="text-[0.6875rem] text-destructive">{error}</span>}
    </span>
  );
}

/** Lettre de réponse aux réserves d'un cycle (.docx) — verbatim + réponses, prête à relire. */
export function ReserveLetterButton({ cycleId }: { cycleId: string }) {
  const { busy, error, run } = useGenerate();
  return (
    <span className="inline-flex flex-col gap-1">
      <button
        type="button" disabled={busy}
        title="Composer la lettre de réponse (.docx) : chaque réserve mot à mot + votre réponse"
        onClick={() => run(() => { const fd = new FormData(); fd.set("cycleId", cycleId); return generateReserveLetterAction(fd); })}
        className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-2 text-xs font-medium hover:bg-accent disabled:opacity-50 sm:px-2 sm:py-1"
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileDown className="h-3.5 w-3.5" />} Lettre de réponse (.docx)
      </button>
      {error && <span className="text-[0.6875rem] text-destructive">{error}</span>}
    </span>
  );
}
