"use client";

import * as React from "react";
import { Lock, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { useConfirmer } from "@/components/ui/dialogue";
import { actionFailureMessage } from "@/lib/action-outcome";
import { compterDossiersNonEntames, mettreAuPipelineNonEntames } from "@/lib/actions/regulatory-actions";

/**
 * « METTRE AU PIPELINE LES DOSSIERS NON ENTAMÉS » — Super Admin seul (Direction, 06/10). Compte d'abord, demande
 * confirmation avec le nombre réel, puis verrouille : les dossiers dont aucune étape n'a commencé repassent à l'étude.
 */
export function MettreAuPipeline() {
  const { enCours, rafraichir } = useRafraichir();
  const confirmer = useConfirmer();
  const [envoi, setEnvoi] = React.useState(false);
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);
  async function lancer() {
    setEnvoi(true); setMsg(null);
    try {
      const apercu = await compterDossiersNonEntames();
      if (!apercu.ok) { setMsg({ ok: false, text: apercu.error ?? "Impossible." }); return; }
      if (!apercu.nombre) { setMsg({ ok: true, text: "Aucun dossier non entamé : rien à mettre au pipeline." }); return; }
      if (!(await confirmer(`Mettre au pipeline ${apercu.nombre} dossier(s) non entamé(s) ?\n\nIls seront verrouillés : à l'étude, invisibles de l'équipe jusqu'à l'ouverture du cadenas.`))) return;
      const r = await mettreAuPipelineNonEntames();
      setMsg({ ok: r.ok, text: r.ok ? (r.message ?? "Fait.") : (r.error ?? "Impossible.") });
      if (r.ok) rafraichir();
    } catch {
      setMsg({ ok: false, text: actionFailureMessage("THROWN") });
    } finally {
      setEnvoi(false);
    }
  }
  return (
    <span className="inline-flex max-w-full flex-wrap items-center gap-2">
      <Button variant="outline" size="sm" disabled={envoi || enCours} onClick={() => void lancer()} title="Verrouille les dossiers dont aucune étape n'a commencé">
        {envoi ? <Loader2 className="h-4 w-4 animate-spin" /> : <Lock className="h-4 w-4" />} Mettre au pipeline les non entamés
      </Button>
      {msg && <span className={`min-w-0 text-xs ${msg.ok ? "text-muted-foreground" : "text-destructive"}`}>{msg.text}</span>}
    </span>
  );
}
