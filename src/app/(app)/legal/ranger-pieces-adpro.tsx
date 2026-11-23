"use client";

import * as React from "react";
import { FolderInput, Loader2 } from "lucide-react";
import { rangerPiecesAdPro } from "@/lib/actions/legal-folder-actions";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";

/**
 * « RANGER LES PIÈCES AD & PRO » (Super Admin, recette du 23/11/2026) — le rattrapage : les devis, BC et
 * factures rattachés à un poste avant le rangement automatique rejoignent le dossier de leur demande
 * (« Événements › 2026 › … »). Les nouvelles pièces s'y rangent seules.
 */
export function RangerPiecesAdPro() {
  const { rafraichir } = useRafraichir();
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<{ ok: boolean; t: string } | null>(null);

  async function lancer() {
    setBusy(true); setMsg(null);
    try {
      const r = await rangerPiecesAdPro();
      setMsg(r.ok ? { ok: true, t: r.message ?? "Rangement terminé." } : { ok: false, t: r.error ?? "Le rangement a échoué." });
      if (r.ok) rafraichir();
    } catch {
      setMsg({ ok: false, t: actionFailureMessage("THROWN") });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <button
        type="button"
        onClick={lancer}
        disabled={busy}
        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-card px-2.5 font-medium text-foreground hover:bg-secondary disabled:opacity-50"
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <FolderInput className="h-3.5 w-3.5" aria-hidden />}
        Ranger les pièces Ad & Pro par demande
      </button>
      <span>Devis, BC et factures des postes rejoignent « Événements › année › événement » (et de même pour les autres demandes).</span>
      {msg && <span role="status" className={msg.ok ? "text-success" : "text-destructive"}>{msg.t}</span>}
    </div>
  );
}
