"use client";

import * as React from "react";
import { Check, X, Loader2 } from "lucide-react";
import { submitProductAnalysis, finalDecision, updateGrantedBudget } from "@/lib/actions/congress-request-actions";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea, Label } from "@/components/ui/input";
import { BoutonDecisif } from "@/components/ui/bouton-decisif";
import { useAction } from "@/components/shared/use-action";

type Cat = { id: string; label: string; isSub: boolean };
type Action = (fd: FormData) => Promise<{ ok: boolean; error?: string }>;

function useRun() {
  // Gardé (levée, délai) et rafraîchi par `useAction` : le bouton ne peut plus tourner pour toujours.
  const { busy: pending, err, run: executer } = useAction();
  const run = (fd: FormData, action: Action, onOk?: () => void) => { void executer(() => action(fd), onOk); };
  return { pending, err, run };
}

function base(type: string, id: string, extra: Record<string, string> = {}) {
  const fd = new FormData();
  fd.set("type", type); fd.set("id", id);
  for (const [k, v] of Object.entries(extra)) fd.set(k, v);
  return fd;
}


/** Analyse de la Direction Marketing : Approuver (budget facultatif) ou Refuser. */
export function ProductAnalysis({ type, id }: { type: string; id: string }) {
  const { pending, err, run } = useRun();
  const [mode, setMode] = React.useState<null | "approve" | "reject">(null);
  const [budget, setBudget] = React.useState("");
  const [notes, setNotes] = React.useState("");

  if (!mode) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">Analyse de la Direction Marketing : approuvez (en proposant éventuellement un budget) ou refusez la demande.</p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="success" onClick={() => setMode("approve")}><Check className="h-4 w-4" /> Approuver</Button>
          <Button size="sm" variant="destructive" onClick={() => setMode("reject")}><X className="h-4 w-4" /> Refuser</Button>
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {mode === "approve" ? (
        <>
          <Label>Budget proposé (DZD) <span className="text-xs font-normal text-muted-foreground">— facultatif</span></Label>
          <Input type="number" step="any" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="Budget après analyse (optionnel)" />
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Analyse / justification…" className="min-h-[64px]" />
        </>
      ) : (
        <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Motif du refus (obligatoire)…" className="min-h-[64px]" />
      )}
      {err && <p className="text-xs text-destructive">{err}</p>}
      <div className="flex flex-wrap gap-2">
        <BoutonDecisif size="sm" variant={mode === "reject" ? "destructive" : "primary"} disabled={pending || (mode === "reject" && !notes.trim())}
          onClick={() => run(base(type, id, { decision: mode === "approve" ? "APPROVE" : "REJECT", productManagerBudget: budget, productManagerNotes: notes }), submitProductAnalysis, () => setMode(null))}>
          {pending && <Loader2 className="h-4 w-4 animate-spin" />} {mode === "reject" ? "Refuser" : "Soumettre"}
        </BoutonDecisif>
        <Button size="sm" variant="ghost" onClick={() => { setMode(null); setNotes(""); setBudget(""); }}>Annuler</Button>
      </div>
    </div>
  );
}

/** La Direction modifie le montant accordé même après validation définitive. */
export function EditGrantedBudget({ type, id, current }: { type: string; id: string; current: number | null }) {
  const { pending, err, run } = useRun();
  const [open, setOpen] = React.useState(false);
  const [amount, setAmount] = React.useState(current != null ? String(current) : "");
  if (!open) {
    return <Button size="sm" variant="outline" onClick={() => setOpen(true)}>Modifier le budget accordé</Button>;
  }
  return (
    <div className="space-y-2">
      <Label>Nouveau montant accordé (DZD)</Label>
      <Input type="number" step="any" inputMode="decimal" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} />
      <p className="text-xs text-muted-foreground">Répercuté sur la déclaration d'information médicale et l'ordre de dépense (s'ils ne sont pas déjà réglés).</p>
      {err && <p className="text-xs text-destructive">{err}</p>}
      <div className="flex flex-wrap gap-2">
        <BoutonDecisif size="sm" disabled={pending || !(Number(amount) > 0)} onClick={() => run(base(type, id, { finalAmount: amount }), updateGrantedBudget, () => setOpen(false))}>
          {pending && <Loader2 className="h-4 w-4 animate-spin" />} Enregistrer
        </BoutonDecisif>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Annuler</Button>
      </div>
    </div>
  );
}

/** Validation définitive (Direction) → ordre de dépense. Le **montant accordé** est
 *  obligatoire (prérempli avec la proposition de la Direction Marketing, modifiable). La
 *  Direction impute la dépense à une **(sous-)catégorie budgétaire** avant qu'elle ne
 *  parte au comptable (requis dès qu'il existe des (sous-)catégories). */
export function FinalDecision({ type, id, suggestedAmount, categories = [] }: { type: string; id: string; suggestedAmount?: number | null; categories?: Cat[] }) {
  const { pending, err, run } = useRun();
  const [mode, setMode] = React.useState<null | "approve" | "reject">(null);
  const [note, setNote] = React.useState("");
  const [amount, setAmount] = React.useState(suggestedAmount != null ? String(suggestedAmount) : "");
  const [category, setCategory] = React.useState("");

  if (!mode) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">Validation définitive après analyse de la Direction Marketing. La validation émet un ordre de dépense vers l'espace comptable.</p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="success" onClick={() => setMode("approve")}><Check className="h-4 w-4" /> Valider définitivement</Button>
          <Button size="sm" variant="destructive" onClick={() => setMode("reject")}><X className="h-4 w-4" /> Refuser</Button>
        </div>
      </div>
    );
  }
  const amountValid = Number(amount) > 0;
  const categoryRequired = categories.length > 0;
  const categoryValid = !categoryRequired || !!category;
  return (
    <div className="space-y-2">
      {mode === "approve" && (
        <>
          <Label>Montant accordé (DZD) <span className="text-destructive">*</span></Label>
          <Input type="number" step="any" inputMode="decimal" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="Montant validé par la Direction" />
          <p className="text-xs text-muted-foreground">Ce montant fait foi pour la déclaration d'information médicale puis l'ordre de dépense.</p>
          {categoryRequired && (
            <>
              <Label>(Sous-)catégorie budgétaire <span className="text-destructive">*</span></Label>
              <Select value={category} onChange={(e) => setCategory(e.target.value)}>
                <option value="">— Choisir la (sous-)catégorie à imputer —</option>
                {categories.map((c) => <option key={c.id} value={c.id}>{c.isSub ? " ↳ " : ""}{c.label}</option>)}
              </Select>
              <p className="text-xs text-muted-foreground">La dépense sera imputée à cette (sous-)catégorie du budget avant de partir au comptable.</p>
            </>
          )}
        </>
      )}
      <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder={mode === "reject" ? "Motif du refus (obligatoire)…" : "Note (optionnel)…"} className="min-h-[56px]" />
      {err && <p className="text-xs text-destructive">{err}</p>}
      <div className="flex flex-wrap gap-2">
        <BoutonDecisif size="sm" variant={mode === "reject" ? "destructive" : "primary"} disabled={pending || (mode === "reject" && !note.trim()) || (mode === "approve" && (!amountValid || !categoryValid))}
          onClick={() => run(base(type, id, { decision: mode === "approve" ? "APPROVE" : "REJECT", note, finalAmount: amount, budgetCategoryId: category }), finalDecision, () => setMode(null))}>
          {pending && <Loader2 className="h-4 w-4 animate-spin" />} Confirmer
        </BoutonDecisif>
        <Button size="sm" variant="ghost" onClick={() => { setMode(null); setNote(""); }}>Annuler</Button>
      </div>
    </div>
  );
}
