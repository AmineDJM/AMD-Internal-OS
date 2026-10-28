"use client";

import * as React from "react";

import Link from "next/link";
import { Loader2, Check, Eye, ShieldOff, ListPlus, CheckCircle2 } from "lucide-react";
import { updateFindingStatus, createTaskFromFinding } from "@/lib/regulatory/intelligence/actions";
import { Retour } from "@/components/ui/retour";
import { useAction } from "@/components/shared/use-action";

interface Props {
  findingId: string;
  status: string;
  blocker: boolean;
  canEdit: boolean;
  canApprove: boolean;
}

/** Boutons de revue d'un constat : Pris en compte / Résolu / Lever (avec justification). */
export function FindingControls({ findingId, status, blocker, canEdit, canApprove }: Props) {
  const { busy, err: error, run } = useAction();
  const [waiving, setWaiving] = React.useState(false);
  const [note, setNote] = React.useState("");
  const [taskCreated, setTaskCreated] = React.useState(false);

  async function apply(next: string, justification?: string) {
    const fd = new FormData();
    fd.set("findingId", findingId);
    fd.set("status", next);
    if (justification) fd.set("note", justification);
    await run(() => updateFindingStatus(fd), () => { setWaiving(false); setNote(""); });
  }

  // CONSTAT → TÂCHE : le pont entre « ce qui ne va pas » et « qui s'en occupe ».
  async function toTask() {
    const fd = new FormData();
    fd.set("findingId", findingId);
    await run(() => createTaskFromFinding(fd), () => setTaskCreated(true));
  }

  if (!canEdit && !canApprove) return null;
  const done = status === "RESOLVED" || status === "WAIVED";

  return (
    <div className="mt-1.5 flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[0.6875rem] uppercase tracking-wide text-muted-foreground/70">{statusLabel(status)}</span>
        {canEdit && status !== "ACKNOWLEDGED" && !done && (
          <button type="button" disabled={busy} onClick={() => apply("ACKNOWLEDGED")} className="inline-flex items-center gap-1 rounded border border-border px-2.5 py-1.5 text-[0.6875rem] sm:px-1.5 sm:py-0.5 hover:bg-accent disabled:opacity-50"><Eye className="h-3 w-3" /> Pris en compte</button>
        )}
        {canEdit && status !== "RESOLVED" && (
          <button type="button" disabled={busy} onClick={() => apply("RESOLVED")} className="inline-flex items-center gap-1 rounded border border-success/40 px-2.5 py-1.5 text-[0.6875rem] sm:px-1.5 sm:py-0.5 text-success hover:bg-success/10 disabled:opacity-50"><Check className="h-3 w-3" /> Résolu</button>
        )}
        {canApprove && status !== "WAIVED" && (
          <button type="button" disabled={busy} onClick={() => (blocker ? setWaiving((v) => !v) : apply("WAIVED"))} className="inline-flex items-center gap-1 rounded border border-amber-500/40 px-2.5 py-1.5 text-[0.6875rem] sm:px-1.5 sm:py-0.5 text-amber-600 hover:bg-amber-500/10 disabled:opacity-50"><ShieldOff className="h-3 w-3" /> Lever</button>
        )}
        {canEdit && !done && (
          taskCreated ? (
            <Link href="/mon-espace" className="inline-flex items-center gap-1 rounded border border-success/40 bg-success/10 px-2.5 py-1.5 text-[0.6875rem] sm:px-1.5 sm:py-0.5 text-success">
              <CheckCircle2 className="h-3 w-3" /> Tâche créée — Mon espace
            </Link>
          ) : (
            <button type="button" disabled={busy} onClick={toTask} title="Créer une tâche personnelle avec le détail, la preuve et le lien vers ce dossier" className="inline-flex items-center gap-1 rounded border border-primary/40 px-2.5 py-1.5 text-[0.6875rem] sm:px-1.5 sm:py-0.5 text-primary hover:bg-primary/10 disabled:opacity-50"><ListPlus className="h-3 w-3" /> Créer une tâche</button>
          )
        )}
        {busy && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
      </div>
      {waiving && (
        <div className="flex flex-col gap-1">
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2}
            placeholder="Justification obligatoire pour lever un bloqueur…"
            className="w-full rounded border border-border bg-background px-2 py-1 text-xs" />
          <div className="flex gap-1.5">
            <button type="button" disabled={busy || !note.trim()} onClick={() => apply("WAIVED", note.trim())} className="rounded bg-amber-500 px-3 py-1.5 text-[0.6875rem] sm:px-2 sm:py-0.5 font-medium text-white disabled:opacity-50">Confirmer la levée</button>
            <button type="button" onClick={() => setWaiving(false)} className="rounded border border-border px-3 py-1.5 text-[0.6875rem] sm:px-2 sm:py-0.5">Annuler</button>
          </div>
        </div>
      )}
      <Retour ton="erreur">{error}</Retour>
    </div>
  );
}

function statusLabel(s: string): string {
  return { OPEN: "Ouvert", ACKNOWLEDGED: "Pris en compte", RESOLVED: "Résolu", WAIVED: "Levé (justifié)" }[s] ?? s;
}
