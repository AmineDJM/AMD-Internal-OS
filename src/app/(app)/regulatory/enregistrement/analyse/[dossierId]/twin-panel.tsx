"use client";

import * as React from "react";

import { Loader2, Check, Pencil, X, AlertTriangle, FileText } from "lucide-react";
import { reviewFact, resolveConflict } from "@/lib/regulatory/intelligence/actions";
import { Retour } from "@/components/ui/retour";
import { useAction } from "@/components/shared/use-action";

interface Occurrence { id: string; documentId: string; sectionCode: string | null; rawValue: string; extract: string; confidence: number; method: string }
interface Fact { id: string; factKey: string; label: string; value: string | null; status: string; hasConflict: boolean; approvedValue: string | null; occurrences: Occurrence[] }
interface ConflictValue { value: string; documentId: string; sectionCode: string | null; extract: string; confidence: number }
interface Conflict { id: string; factKey: string; label: string; severity: string; status: string; values: ConflictValue[]; proposedAction: string | null; finalValue: string | null }

const STATUS_LABEL: Record<string, string> = { PROPOSED: "proposé", CONFIRMED: "confirmé", CORRECTED: "corrigé", REJECTED: "rejeté" };
// Méthode d'origine d'une preuve : « IA » (compréhension du sens), extraction déterministe, ou
// OCR (avec le moteur réellement utilisé — Mistral cloud vs Tesseract local, pour la traçabilité).
const METHOD_LABEL: Record<string, string> = {
  ai: "IA", regex: "auto", keyword: "auto", label: "auto",
  "ocr-mistral": "OCR Mistral", "ocr-tesseract": "OCR local", ocr: "OCR",
};
const methodLabel = (m: string) => METHOD_LABEL[m] ?? m;

export function TwinPanel({ facts, conflicts, canEdit, canApprove }: { facts: Fact[]; conflicts: Conflict[]; canEdit: boolean; canApprove: boolean }) {
  return (
    <div className="space-y-4">
      {conflicts.filter((c) => c.status === "OPEN").length > 0 && (
        <div className="space-y-2">
          <p className="flex items-center gap-1.5 text-sm font-semibold text-destructive"><AlertTriangle className="h-4 w-4" /> Conflits à résoudre</p>
          {conflicts.filter((c) => c.status === "OPEN").map((c) => <ConflictRow key={c.id} conflict={c} canApprove={canApprove} />)}
        </div>
      )}
      <div className="space-y-1.5">
        {facts.map((f) => <FactRow key={f.id} fact={f} canEdit={canEdit} />)}
        {facts.length === 0 && <p className="text-sm text-muted-foreground">Aucun fait extrait pour l'instant (relancez l'analyse après extraction du texte).</p>}
      </div>
    </div>
  );
}

function FactRow({ fact, canEdit }: { fact: Fact; canEdit: boolean }) {
  // Les petits boutons d'un fait n'ont pas de place pour parler : un refus part en avis flottant.
  const { busy, run } = useAction({ signalerErreurs: true });
  const [editing, setEditing] = React.useState(false);
  const [val, setVal] = React.useState(fact.value ?? "");
  const [open, setOpen] = React.useState(false);

  async function act(decision: string, value?: string) {
    const fd = new FormData();
    fd.set("factId", fact.id);
    fd.set("decision", decision);
    if (value !== undefined) fd.set("value", value);
    await run(() => reviewFact(fd), () => setEditing(false));
  }

  const tone = fact.status === "CONFIRMED" || fact.status === "CORRECTED" ? "text-success" : fact.status === "REJECTED" ? "text-muted-foreground line-through" : "text-foreground";

  return (
    <div className={`rounded-lg border px-3 py-2 text-sm ${fact.hasConflict ? "border-destructive/40 bg-destructive/5" : "border-border"}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-full shrink-0 text-xs text-muted-foreground sm:w-40">{fact.label}</span>
        {editing ? (
          <input value={val} onChange={(e) => setVal(e.target.value)} className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-0.5 text-sm" />
        ) : (
          <span className={`min-w-0 flex-1 font-medium ${tone}`}>{fact.value ?? "—"}</span>
        )}
        <span className="shrink-0 text-[0.6875rem] uppercase tracking-wide text-muted-foreground/70">{STATUS_LABEL[fact.status] ?? fact.status}</span>
        {fact.occurrences.length > 0 && (
          <button type="button" onClick={() => setOpen((v) => !v)} className="shrink-0 py-1 text-[0.6875rem] text-primary hover:underline sm:py-0">{fact.occurrences.length} source·s</button>
        )}
        {canEdit && (
          <span className="flex shrink-0 items-center gap-1">
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
            {editing ? (
              <>
                <button type="button" disabled={busy} onClick={() => act("CORRECT", val)} className="rounded border border-success/40 px-2.5 py-1.5 text-[0.6875rem] text-success sm:px-1.5 sm:py-0.5">Enregistrer</button>
                <button type="button" onClick={() => setEditing(false)} className="rounded border border-border px-2.5 py-1.5 text-[0.6875rem] sm:px-1.5 sm:py-0.5">Annuler</button>
              </>
            ) : (
              <>
                <button type="button" disabled={busy} title="Confirmer" onClick={() => act("CONFIRM")} className="rounded border border-success/40 p-2 text-success sm:p-1"><Check className="h-3 w-3" /></button>
                <button type="button" disabled={busy} title="Corriger" onClick={() => { setEditing(true); setVal(fact.value ?? ""); }} className="rounded border border-border p-2 sm:p-1"><Pencil className="h-3 w-3" /></button>
                <button type="button" disabled={busy} title="Rejeter" onClick={() => act("REJECT")} className="rounded border border-border p-2 text-muted-foreground sm:p-1"><X className="h-3 w-3" /></button>
              </>
            )}
          </span>
        )}
      </div>
      {open && (
        <ul className="mt-1.5 space-y-1 border-t border-border/50 pt-1.5">
          {fact.occurrences.slice(0, 5).map((o) => (
            <li key={o.id} className="text-[0.6875rem] text-muted-foreground">
              <span className="inline-flex items-center gap-1"><FileText className="h-3 w-3" /> {o.sectionCode ?? "—"} · {Math.round(o.confidence * 100)}% · {methodLabel(o.method)}</span>
              <span className="ml-1 italic">« {o.extract} »</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ConflictRow({ conflict, canApprove }: { conflict: Conflict; canApprove: boolean }) {
  const { busy, err: error, run } = useAction();
  const [finalValue, setFinalValue] = React.useState("");
  const [note, setNote] = React.useState("");

  async function resolve() {
    const fd = new FormData();
    fd.set("conflictId", conflict.id);
    fd.set("finalValue", finalValue);
    fd.set("note", note);
    fd.set("status", "RESOLVED");
    await run(() => resolveConflict(fd));
  }

  return (
    <div className={`rounded-lg border px-3 py-2 text-sm ${conflict.severity === "CRITICAL" ? "border-destructive/50 bg-destructive/5" : "border-amber-500/40 bg-amber-500/5"}`}>
      <p className="font-medium">{conflict.label} — valeurs divergentes {conflict.severity === "CRITICAL" && <span className="ml-1 rounded bg-destructive px-1.5 py-0.5 text-[0.6875rem] font-semibold text-white">CRITIQUE</span>}</p>
      <ul className="mt-1 space-y-0.5">
        {conflict.values.map((v, i) => (
          <li key={i} className="flex items-start gap-2 text-xs">
            <button type="button" disabled={!canApprove} onClick={() => setFinalValue(v.value)} className="shrink-0 rounded border border-border px-2 py-1 font-medium hover:bg-accent disabled:opacity-60 sm:px-1.5 sm:py-0.5">{v.value}</button>
            <span className="min-w-0 text-muted-foreground">{v.sectionCode ?? "—"} · « {v.extract} »</span>
          </li>
        ))}
      </ul>
      {conflict.proposedAction && <p className="mt-1 text-[0.6875rem] text-muted-foreground">Action proposée : {conflict.proposedAction}</p>}
      {canApprove && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <input value={finalValue} onChange={(e) => setFinalValue(e.target.value)} placeholder="Valeur finale retenue" className="min-w-[10rem] flex-1 rounded border border-border bg-background px-2 py-0.5 text-xs" />
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Justification" className="min-w-[8rem] flex-1 rounded border border-border bg-background px-2 py-0.5 text-xs" />
          <button type="button" disabled={busy || !finalValue.trim()} onClick={resolve} className="rounded bg-primary px-3 py-2 text-xs font-medium text-primary-foreground disabled:opacity-50 sm:px-2 sm:py-1">
            {busy ? <Loader2 className="inline h-3 w-3 animate-spin" /> : "Résoudre"}
          </button>
        </div>
      )}
      <Retour ton="erreur" className="mt-1">{error}</Retour>
    </div>
  );
}
