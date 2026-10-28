"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, Send, ClipboardCheck, RefreshCw, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { submitDossier, reanalyseDossier } from "@/lib/regulatory/intelligence/actions";
import { sansBloquer } from "@/lib/journal";

interface Props {
  dossierId: string;
  status: string;
  openBlockers: number;
  canPrepare: boolean;
  canApprove: boolean;
  canAnalyse: boolean;
}

/** Porte de soumission : prête/soumission gardée par l'absence de bloqueur ouvert. */
export function SubmissionGate({ dossierId, status, openBlockers, canPrepare, canApprove, canAnalyse }: Props) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const blocked = openBlockers > 0;

  async function submit(target: string) {
    setBusy(target); setError(null);
    const fd = new FormData();
    fd.set("dossierId", dossierId);
    fd.set("target", target);
    const r = await submitDossier(fd);
    setBusy(null);
    if (r.ok) router.refresh();
    else setError(r.error ?? "Échec.");
  }

  async function reanalyse() {
    setBusy("reanalyse"); setError(null);
    const fd = new FormData();
    fd.set("dossierId", dossierId);
    const r = await reanalyseDossier(fd);
    if (r.ok) {
      await fetch("/api/regulatory/intelligence/process", { method: "POST" }).catch(sansBloquer("submission-gate.reanalyse.fetch"));
      router.refresh();
    } else setError(r.error ?? "Échec.");
    setBusy(null);
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {canAnalyse && (
          <Button type="button" variant="outline" size="sm" disabled={busy !== null} onClick={reanalyse}>
            {busy === "reanalyse" ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Relancer l'analyse
          </Button>
        )}
        {canPrepare && status !== "READY_FOR_REVIEW" && status !== "SUBMITTED" && (
          <Button type="button" size="sm" disabled={busy !== null || blocked} onClick={() => submit("READY_FOR_REVIEW")}>
            {busy === "READY_FOR_REVIEW" ? <Loader2 className="h-4 w-4 animate-spin" /> : <ClipboardCheck className="h-4 w-4" />} Marquer prêt pour revue
          </Button>
        )}
        {canApprove && status !== "SUBMITTED" && (
          <Button type="button" size="sm" disabled={busy !== null || blocked} onClick={() => submit("SUBMITTED")}>
            {busy === "SUBMITTED" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Marquer soumis (ANPP)
          </Button>
        )}
      </div>
      {blocked && (canPrepare || canApprove) && (
        <p className="flex items-center gap-1.5 text-xs text-destructive">
          <Lock className="h-3.5 w-3.5" /> Soumission verrouillée : {openBlockers} bloqueur·s à résoudre ou lever d'abord.
        </p>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
