"use client";

import * as React from "react";

import { Loader2, Plus, CheckCircle2, Trash2, CalendarClock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Retour } from "@/components/ui/retour";
import { useKeyedAction } from "@/components/shared/use-action";
import { addLifecycleEvent, deleteLifecycleEvent, addObligation, completeObligation, deleteObligation } from "@/lib/regulatory/intelligence/lifecycle/actions";

interface Event { id: string; kind: string; sequenceNo: number | null; operation: string | null; label: string; note: string | null; effectiveDate: string | null; createdAt: string }
interface Obligation { id: string; label: string; certType: string | null; dueDate: string | null; status: string; note: string | null }

const KINDS = [["SUBMISSION", "Soumission initiale"], ["SEQUENCE", "Séquence"], ["SUPPLEMENT", "Complément"], ["MODIFICATION", "Modification"], ["RENEWAL", "Renouvellement"], ["RESPONSE", "Réponse"], ["APPROVED", "Version approuvée"], ["WITHDRAWAL", "Retrait"]];
const OB_STATUS: Record<string, string> = { OPEN: "bg-muted text-muted-foreground", DONE: "bg-success/10 text-success", OVERDUE: "bg-destructive/10 text-destructive" };

export function LifecyclePanel({ dossierId, events, obligations, canManage }: { dossierId: string; events: Event[]; obligations: Obligation[]; canManage: boolean }) {
  const { busy, error, run } = useKeyedAction();
  const [addEv, setAddEv] = React.useState(false);
  const [addOb, setAddOb] = React.useState(false);
  const [kind, setKind] = React.useState("MODIFICATION");

  async function submit(key: string, fd: FormData, fn: (fd: FormData) => Promise<{ ok: boolean; error?: string }>, close: () => void) {
    fd.set("dossierId", dossierId);
    if (await run(key, () => fn(fd))) close();
  }

  return (
    <div className="space-y-3">
      <Retour ton="erreur">{error}</Retour>

      {/* Chronologie */}
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-muted-foreground">Chronologie réglementaire</p>
        {canManage && <Button type="button" size="sm" variant="outline" onClick={() => setAddEv((v) => !v)}><Plus className="h-4 w-4" /> Événement</Button>}
      </div>
      {addEv && (
        <form onSubmit={(e) => { e.preventDefault(); submit("ev", new FormData(e.currentTarget), addLifecycleEvent, () => setAddEv(false)); }} className="space-y-2 rounded-xl border border-border bg-card p-3">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <select name="kind" value={kind} onChange={(e) => setKind(e.target.value)} className="rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm">{KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
            <select name="operation" className="rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm"><option value="">Opération (optionnel)</option><option value="NEW">NEW</option><option value="REPLACE">REPLACE</option><option value="DELETE">DELETE</option><option value="APPEND">APPEND</option></select>
          </div>
          <Input name="label" placeholder="Libellé *" required />
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Input name="sequenceNo" type="number" placeholder="N° de séquence" />
            <Input name="effectiveDate" type="date" />
          </div>
          {kind === "MODIFICATION" && <Input name="sections" placeholder="Sections modifiées (ex. 3.2.S.2, 1.3) — analyse d'impact automatique" />}
          <div className="flex justify-end gap-2"><Button type="button" size="sm" variant="outline" onClick={() => setAddEv(false)}>Annuler</Button><Button type="submit" size="sm" disabled={busy === "ev"}>{busy === "ev" ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Ajouter</Button></div>
        </form>
      )}
      <div className="space-y-1.5">
        {events.map((e) => (
          <div key={e.id} className="flex flex-wrap items-start gap-2 rounded-lg border border-border/60 px-2.5 py-1.5 text-xs">
            <span className="rounded bg-primary/10 px-1.5 py-0.5 font-medium text-primary">{KINDS.find(([v]) => v === e.kind)?.[1] ?? e.kind}</span>
            <div className="min-w-0 flex-1">
              <p className="font-medium">{e.label}{e.operation ? ` · ${e.operation}` : ""}{e.sequenceNo != null ? ` · séq. ${e.sequenceNo}` : ""}</p>
              {e.note && <p className="whitespace-pre-wrap text-muted-foreground">{e.note}</p>}
              {e.effectiveDate && <p className="text-muted-foreground/70">Effet : {new Date(e.effectiveDate).toLocaleDateString("fr-FR")}</p>}
            </div>
            {canManage && <button type="button" disabled={busy !== null} onClick={() => run(`de-${e.id}`, () => { const fd = new FormData(); fd.set("id", e.id); return deleteLifecycleEvent(fd); })} aria-label="Supprimer l'événement" className="-m-1 rounded p-2 text-destructive sm:m-0 sm:p-0"><Trash2 className="h-3 w-3" /></button>}
          </div>
        ))}
        {events.length === 0 && <p className="text-xs text-muted-foreground">Aucun événement. Ajoutez la soumission initiale, les séquences, modifications…</p>}
      </div>

      {/* Obligations */}
      <div className="flex items-center justify-between pt-1">
        <p className="text-xs font-medium text-muted-foreground">Obligations & certificats expirants</p>
        {canManage && <Button type="button" size="sm" variant="outline" onClick={() => setAddOb((v) => !v)}><Plus className="h-4 w-4" /> Obligation</Button>}
      </div>
      {addOb && (
        <form onSubmit={(e) => { e.preventDefault(); submit("ob", new FormData(e.currentTarget), addObligation, () => setAddOb(false)); }} className="space-y-2 rounded-xl border border-border bg-card p-3">
          <Input name="label" placeholder="Obligation / certificat *" required />
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Input name="certType" placeholder="Type (CPP, GMP, AMM…)" />
            <label className="text-xs text-muted-foreground">Échéance <Input name="dueDate" type="date" /></label>
          </div>
          <div className="flex justify-end gap-2"><Button type="button" size="sm" variant="outline" onClick={() => setAddOb(false)}>Annuler</Button><Button type="submit" size="sm" disabled={busy === "ob"}>{busy === "ob" ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Ajouter</Button></div>
        </form>
      )}
      <div className="space-y-1.5">
        {obligations.map((o) => (
          <div key={o.id} className="flex items-center gap-2 rounded-lg border border-border/60 px-2.5 py-1.5 text-xs">
            <CalendarClock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">{o.label}{o.certType ? ` (${o.certType})` : ""}{o.dueDate ? ` — ${new Date(o.dueDate).toLocaleDateString("fr-FR")}` : ""}</span>
            <span className={`rounded px-1.5 py-0.5 ${OB_STATUS[o.status] ?? ""}`}>{o.status === "OVERDUE" ? "En retard" : o.status === "DONE" ? "Traité" : "Ouvert"}</span>
            {canManage && o.status !== "DONE" && <button type="button" disabled={busy !== null} onClick={() => run(`co-${o.id}`, () => { const fd = new FormData(); fd.set("id", o.id); return completeObligation(fd); })} aria-label="Marquer traitée" className="-m-1 rounded p-2 text-success sm:m-0 sm:p-0"><CheckCircle2 className="h-3.5 w-3.5" /></button>}
            {canManage && <button type="button" disabled={busy !== null} onClick={() => run(`do-${o.id}`, () => { const fd = new FormData(); fd.set("id", o.id); return deleteObligation(fd); })} aria-label="Supprimer l'obligation" className="-m-1 rounded p-2 text-destructive sm:m-0 sm:p-0"><Trash2 className="h-3 w-3" /></button>}
          </div>
        ))}
        {obligations.length === 0 && <p className="text-xs text-muted-foreground">Aucune obligation. Suivez ici les certificats expirants (CPP/GMP) et obligations post-enregistrement.</p>}
      </div>
    </div>
  );
}
