"use client";

import * as React from "react";
import { useAction } from "@/components/shared/use-action";
import { Check, X, MessageSquareWarning, Loader2, Undo2 } from "lucide-react";
import { reviewValidationItem, clearValidationItem } from "@/lib/actions/validation-actions";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type Decision = "APPROVED" | "REJECTED" | "CHANGES_REQUESTED";
const LABEL: Record<Decision, string> = { APPROVED: "Approuvé", CHANGES_REQUESTED: "À réviser", REJECTED: "Refusé" };
const TONE: Record<Decision, string> = { APPROVED: "text-success", CHANGES_REQUESTED: "text-warning", REJECTED: "text-destructive" };

function pill(active: boolean, tone: "success" | "warning" | "destructive") {
  const on: Record<string, string> = {
    success: "border-success bg-success/10 text-success",
    warning: "border-warning bg-warning/10 text-warning",
    destructive: "border-destructive bg-destructive/10 text-destructive",
  };
  return cn(
    "inline-flex min-h-9 items-center gap-1 rounded-md border px-2.5 py-1 text-xs transition-colors sm:min-h-0 sm:px-1.5",
    active ? on[tone] : "border-border text-muted-foreground hover:bg-secondary",
  );
}

/**
 * Verdict GRANULAIRE d'un validateur sur UN élément (le message ou une pièce jointe) :
 * Approuver / À réviser / Refuser, avec un commentaire OPTIONNEL. Idempotent : recliquer
 * change le verdict ; « Effacer » le retire. C'est un retour détaillé, en plus de la
 * décision globale de la demande.
 */
export function ItemReview({
  stepId, itemKey, current, currentComment,
}: {
  stepId: string;
  itemKey: string;
  current?: string;
  currentComment?: string;
}) {
  const [open, setOpen] = React.useState<null | Decision>(null);
  const [comment, setComment] = React.useState(currentComment ?? "");
  const verdict = useAction();
  // « Effacer » est une icône sans place pour parler : un refus part en avis flottant.
  const effacement = useAction({ signalerErreurs: true });
  const pending = verdict.busy || effacement.busy;
  const { err, setErr } = verdict;

  const begin = (d: Decision) => { setErr(null); setComment(currentComment ?? ""); setOpen(d); };

  const submit = () => {
    if (!open) return;
    const fd = new FormData();
    fd.set("stepId", stepId);
    fd.set("itemKey", itemKey);
    fd.set("decision", open);
    fd.set("comment", comment.trim()); // commentaire OPTIONNEL
    void verdict.run(() => reviewValidationItem(fd), () => setOpen(null));
  };

  const clear = () => {
    const fd = new FormData();
    fd.set("stepId", stepId);
    fd.set("itemKey", itemKey);
    void effacement.run(() => clearValidationItem(fd));
  };

  if (open) {
    return (
      <div className="mt-1 space-y-1.5">
        <Textarea autoFocus value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Commentaire (optionnel)…" className="min-h-[46px] text-sm" />
        {err && <p className="text-xs text-destructive">{err}</p>}
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" className="h-auto min-h-9 max-w-full whitespace-normal py-1.5 sm:min-h-8" disabled={pending} onClick={submit}>{pending && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Enregistrer « {LABEL[open]} »</Button>
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => setOpen(null)}>Annuler</Button>
        </div>
      </div>
    );
  }

  const cur = current as Decision | undefined;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1.5">
      <button type="button" onClick={() => begin("APPROVED")} className={pill(cur === "APPROVED", "success")} title="Approuver cet élément">
        <Check className="h-3.5 w-3.5" /> Approuver
      </button>
      <button type="button" onClick={() => begin("CHANGES_REQUESTED")} className={pill(cur === "CHANGES_REQUESTED", "warning")} title="Demander une révision">
        <MessageSquareWarning className="h-3.5 w-3.5" /> Réviser
      </button>
      <button type="button" onClick={() => begin("REJECTED")} className={pill(cur === "REJECTED", "destructive")} title="Refuser cet élément">
        <X className="h-3.5 w-3.5" /> Refuser
      </button>
      {cur && (
        <>
          <span className={cn("min-w-0 text-xs font-medium [overflow-wrap:anywhere]", TONE[cur])}>{LABEL[cur]}{currentComment ? ` — ${currentComment}` : ""}</span>
          <button type="button" onClick={clear} disabled={pending} className="rounded-md p-2 text-muted-foreground hover:text-foreground sm:p-0.5" title="Effacer mon avis sur cet élément" aria-label="Effacer mon avis sur cet élément">
            {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Undo2 className="h-3.5 w-3.5" />}
          </button>
        </>
      )}
    </div>
  );
}
