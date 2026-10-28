"use client";

import * as React from "react";

import { Loader2, Send, ClipboardCheck, RefreshCw, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Retour } from "@/components/ui/retour";
import { useKeyedAction } from "@/components/shared/use-action";
import { submitDossier, reanalyseDossier } from "@/lib/regulatory/intelligence/actions";

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
  const { busy, error, run } = useKeyedAction();
  const blocked = openBlockers > 0;

  async function submit(target: string) {
    const fd = new FormData();
    fd.set("dossierId", dossierId);
    fd.set("target", target);
    await run(target, () => submitDossier(fd));
  }

  async function reanalyse() {
    const fd = new FormData();
    fd.set("dossierId", dossierId);
    await run("reanalyse", async () => {
      const r = await reanalyseDossier(fd);
      if (r.ok) await fetch("/api/regulatory/intelligence/process", { method: "POST" }).catch(() => undefined);
      return r;
    });
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
      <Retour ton="erreur">{error}</Retour>
    </div>
  );
}
