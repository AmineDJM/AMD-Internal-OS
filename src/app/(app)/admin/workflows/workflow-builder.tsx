"use client";

import * as React from "react";
import { Plus, Trash2, ArrowUp, ArrowDown, Loader2, Save, RotateCcw, GripVertical } from "lucide-react";
import { saveWorkflowDefinition, resetWorkflowDefinition } from "@/lib/actions/workflow-actions";
import type { DefinitionAdminView, WorkflowStepView } from "@/lib/queries/workflow";
import { ACTOR_SCOPES, SCOPE_LABELS, SCOPE_HINTS, WORKFLOW_POWERS, POWER_LABELS, type ActorScope, type WorkflowPower } from "@/lib/workflow/types";
import { ROLE_LABELS } from "@/lib/labels";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea, Label } from "@/components/ui/input";
import { useConfirmer } from "@/components/ui/dialogue";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";

const ROLE_ENTRIES = Object.entries(ROLE_LABELS);

type Draft = Omit<WorkflowStepView, "state">;

function blankStep(): Draft {
  return {
    slug: "", title: "Nouvelle étape", description: "", actorRoles: [], actorScope: "ROLE", powers: ["APPROVE", "REJECT"],
    assignRole: null, requireAmount: false, autoSkipMaxAmount: null, autoApproveIfRequester: false, requireCategory: false, requireNote: false, optional: false, confidential: false,
    emitDeclaration: false, emitExpenseOrder: false, notifyRoles: [], legacyStatus: null,
  };
}

export function WorkflowBuilder({ definitions }: { definitions: DefinitionAdminView[] }) {
  const { rafraichir } = useRafraichir();
  const confirmer = useConfirmer();
  const [active, setActive] = React.useState(definitions[0]?.category ?? "SPONSORING");
  const [drafts, setDrafts] = React.useState<Record<string, { name: string; description: string; isActive: boolean; steps: Draft[] }>>(() =>
    Object.fromEntries(definitions.map((d) => [d.category, { name: d.name, description: d.description ?? "", isActive: d.isActive, steps: d.steps.map((s) => ({ ...s })) }])),
  );
  const [saving, setSaving] = React.useState(false);
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);

  const meta = definitions.find((d) => d.category === active);
  const draft = drafts[active];
  if (!draft || !meta) return null;

  const patchDraft = (p: Partial<typeof draft>) => setDrafts((prev) => ({ ...prev, [active]: { ...prev[active], ...p } }));
  const patchStep = (i: number, p: Partial<Draft>) =>
    setDrafts((prev) => {
      const steps = prev[active].steps.map((s, idx) => (idx === i ? { ...s, ...p } : s));
      return { ...prev, [active]: { ...prev[active], steps } };
    });
  const moveStep = (i: number, dir: -1 | 1) =>
    setDrafts((prev) => {
      const steps = [...prev[active].steps];
      const j = i + dir;
      if (j < 0 || j >= steps.length) return prev;
      [steps[i], steps[j]] = [steps[j], steps[i]];
      return { ...prev, [active]: { ...prev[active], steps } };
    });
  const removeStep = (i: number) => setDrafts((prev) => ({ ...prev, [active]: { ...prev[active], steps: prev[active].steps.filter((_, idx) => idx !== i) } }));
  const addStep = () => setDrafts((prev) => ({ ...prev, [active]: { ...prev[active], steps: [...prev[active].steps, blankStep()] } }));

  const save = async () => {
    setSaving(true); setMsg(null);
    const fd = new FormData();
    fd.set("payload", JSON.stringify({ category: active, name: draft.name, description: draft.description, isActive: draft.isActive, steps: draft.steps }));
    try {
      const r = await saveWorkflowDefinition(fd);
      if (r.ok) { setMsg({ ok: true, text: "Circuit enregistré." }); rafraichir(); }
      else setMsg({ ok: false, text: r.error ?? "Le circuit n'a pas été enregistré." });
    } catch {
      setMsg({ ok: false, text: actionFailureMessage("THROWN") });
    } finally {
      setSaving(false);
    }
  };
  const reset = async () => {
    if (!(await confirmer("Réinitialiser ce circuit au modèle par défaut ? (impossible si des demandes l'utilisent)"))) return;
    setSaving(true); setMsg(null);
    const fd = new FormData();
    fd.set("category", active);
    try {
      const r = await resetWorkflowDefinition(fd);
      if (r.ok) { setMsg({ ok: true, text: "Circuit réinitialisé — rechargez la page." }); rafraichir(); }
      else setMsg({ ok: false, text: r.error ?? "Le circuit n'a pas été réinitialisé." });
    } catch {
      setMsg({ ok: false, text: actionFailureMessage("THROWN") });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      {/* Sélecteur de catégorie */}
      <div className="flex flex-wrap gap-2">
        {definitions.map((d) => (
          <button
            key={d.category}
            onClick={() => { setActive(d.category); setMsg(null); }}
            className={`rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${active === d.category ? "border-primary bg-primary/10 text-primary" : "border-border hover:bg-secondary"}`}
          >
            {d.categoryLabel}
            {d.instanceCount > 0 && <span className="ml-1.5 text-xs text-muted-foreground">· {d.instanceCount}</span>}
          </button>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center justify-between gap-2">
            <span>{meta.categoryLabel}</span>
            <span className="text-xs font-normal text-muted-foreground">{meta.instanceCount} demande·s dans ce circuit</span>
          </CardTitle>
          <CardDescription>Nom, description et étapes du circuit. Les identifiants d'étape (slug) sont conservés pour les demandes en cours.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1"><Label>Nom du circuit</Label><Input value={draft.name} onChange={(e) => patchDraft({ name: e.target.value })} /></div>
            <div className="space-y-1"><Label>Description</Label><Input value={draft.description} onChange={(e) => patchDraft({ description: e.target.value })} /></div>
          </div>

          <div className="space-y-3">
            {draft.steps.map((s, i) => (
              <StepEditor
                key={i}
                index={i}
                total={draft.steps.length}
                step={s}
                onChange={(p) => patchStep(i, p)}
                onMove={(dir) => moveStep(i, dir)}
                onRemove={() => removeStep(i)}
              />
            ))}
          </div>

          <Button variant="outline" size="sm" onClick={addStep}><Plus className="h-4 w-4" /> Ajouter une étape</Button>

          {msg && <p className={`text-sm ${msg.ok ? "text-success" : "text-destructive"}`}>{msg.text}</p>}

          <div className="flex flex-wrap gap-2 border-t border-border pt-3">
            <Button onClick={save} disabled={saving}>{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Enregistrer le circuit</Button>
            <Button variant="ghost" onClick={reset} disabled={saving}><RotateCcw className="h-4 w-4" /> Réinitialiser au défaut</Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function StepEditor({ index, total, step, onChange, onMove, onRemove }: {
  index: number; total: number; step: Draft;
  onChange: (p: Partial<Draft>) => void; onMove: (dir: -1 | 1) => void; onRemove: () => void;
}) {
  const toggleIn = (key: "actorRoles" | "powers" | "notifyRoles", value: string) => {
    const arr = step[key] as string[];
    onChange({ [key]: arr.includes(value) ? arr.filter((v) => v !== value) : [...arr, value] } as Partial<Draft>);
  };
  const hasAssign = step.powers.includes("ASSIGN");

  return (
    <div className="rounded-lg border border-border bg-secondary/20 p-3 space-y-3">
      <div className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">{index + 1}</span>
        <GripVertical className="h-4 w-4 text-muted-foreground" />
        <Input value={step.title} onChange={(e) => onChange({ title: e.target.value })} className="order-last min-w-0 flex-1 basis-full sm:order-none sm:basis-auto" placeholder="Titre de l'étape" />
        <Button variant="ghost" size="icon" onClick={() => onMove(-1)} disabled={index === 0} aria-label="Monter l'étape" className="ml-auto sm:ml-0"><ArrowUp className="h-4 w-4" /></Button>
        <Button variant="ghost" size="icon" onClick={() => onMove(1)} disabled={index === total - 1} aria-label="Descendre l'étape"><ArrowDown className="h-4 w-4" /></Button>
        <Button variant="ghost" size="icon" onClick={onRemove} aria-label="Supprimer l'étape"><Trash2 className="h-4 w-4 text-destructive" /></Button>
      </div>

      <Textarea value={step.description ?? ""} onChange={(e) => onChange({ description: e.target.value })} placeholder="Description (aide affichée aux acteurs)…" className="min-h-[44px]" />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label>Qui agit (portée)</Label>
          <Select value={step.actorScope} onChange={(e) => onChange({ actorScope: e.target.value as ActorScope })}>
            {ACTOR_SCOPES.map((sc) => <option key={sc} value={sc}>{SCOPE_LABELS[sc]}</option>)}
          </Select>
          <p className="text-[0.6875rem] text-muted-foreground">{SCOPE_HINTS[step.actorScope]}</p>
        </div>
        {hasAssign && (
          <div className="space-y-1">
            <Label>Rôle désignable (pouvoir « Désigner »)</Label>
            <Select value={step.assignRole ?? ""} onChange={(e) => onChange({ assignRole: e.target.value || null })}>
              <option value="">— Aucun —</option>
              {ROLE_ENTRIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </Select>
          </div>
        )}
      </div>

      {(step.actorScope === "ROLE" || step.actorScope === "GLOBAL_VIEW") && (
        <div className="space-y-1">
          <Label>Rôles acteurs {step.actorScope === "GLOBAL_VIEW" && <span className="text-xs font-normal text-muted-foreground">(en plus de la Direction / Super Admin)</span>}</Label>
          <ChipGroup entries={ROLE_ENTRIES} selected={step.actorRoles} onToggle={(v) => toggleIn("actorRoles", v)} />
        </div>
      )}

      <div className="space-y-1">
        <Label>Pouvoirs à cette étape</Label>
        <ChipGroup entries={WORKFLOW_POWERS.map((p) => [p, POWER_LABELS[p]] as [string, string])} selected={step.powers} onToggle={(v) => toggleIn("powers", v as WorkflowPower)} />
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-2">
        <Flag label="Montant obligatoire" checked={step.requireAmount} onChange={(v) => onChange({ requireAmount: v })} />
        <Flag label="(Sous-)catégorie obligatoire" checked={step.requireCategory} onChange={(v) => onChange({ requireCategory: v })} />
        <Flag label="Commentaire obligatoire" checked={step.requireNote} onChange={(v) => onChange({ requireNote: v })} />
        <Flag label="Confidentiel (masqué au demandeur)" checked={step.confidential} onChange={(v) => onChange({ confidential: v })} />
        <Flag label="Émet une déclaration info médicale" checked={step.emitDeclaration} onChange={(v) => onChange({ emitDeclaration: v })} />
        <Flag label="Émet un ordre de dépense" checked={step.emitExpenseOrder} onChange={(v) => onChange({ emitExpenseOrder: v })} />
      </div>

      <div className="space-y-1 rounded-lg border border-dashed border-primary/40 bg-primary/[0.03] p-2.5">
        <Label>Franchir automatiquement si le montant ≤ <span className="text-xs font-normal text-muted-foreground">(DZD — optionnel, anti-bureaucratie)</span></Label>
        <Input
          type="number"
          inputMode="numeric"
          min={0}
          step={1000}
          value={step.autoSkipMaxAmount ?? ""}
          onChange={(e) => onChange({ autoSkipMaxAmount: e.target.value === "" ? null : Math.max(0, Number(e.target.value)) })}
          placeholder="ex. 50000 — en deçà, l'étape est franchie sans validation humaine"
        />
        <p className="text-[0.6875rem] text-muted-foreground">Sous ce seuil, l'étape est franchie automatiquement (tracé : « étape franchie automatiquement »). Sans effet sur une désignation, une émission financière ou la décision finale.</p>
        <label className="mt-2 flex cursor-pointer items-start gap-2 border-t border-primary/20 pt-2 text-sm">
          <input type="checkbox" checked={step.autoApproveIfRequester} onChange={(e) => onChange({ autoApproveIfRequester: e.target.checked })} className="mt-0.5 h-4 w-4 rounded border-border accent-primary" />
          <span>
            <span className={step.autoApproveIfRequester ? "font-medium" : "text-muted-foreground"}>Auto-accord si le demandeur détient l'autorité</span>
            <span className="block text-[0.6875rem] text-muted-foreground">Si l'auteur de la demande a déjà le rôle (ou la portée) de cette étape, elle est approuvée automatiquement en son nom (tracé) — on ne fait pas valider quelqu'un sa propre demande.</span>
          </span>
        </label>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label>Rôles notifiés à l'entrée</Label>
          <ChipGroup entries={ROLE_ENTRIES} selected={step.notifyRoles} onToggle={(v) => toggleIn("notifyRoles", v)} />
        </div>
        <div className="space-y-1">
          <Label>Statut « legacy » projeté <span className="text-xs font-normal text-muted-foreground">(avancé, optionnel)</span></Label>
          <Input value={step.legacyStatus ?? ""} onChange={(e) => onChange({ legacyStatus: e.target.value || null })} placeholder="ex. AWAITING_PRELIMINARY" />
        </div>
      </div>
    </div>
  );
}

function ChipGroup({ entries, selected, onToggle }: { entries: [string, string][]; selected: string[]; onToggle: (v: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {entries.map(([v, l]) => {
        const on = selected.includes(v);
        return (
          <button
            key={v}
            type="button"
            onClick={() => onToggle(v)}
            className={`rounded-full border px-2.5 py-1.5 text-xs font-medium transition-colors sm:py-1 ${on ? "border-primary bg-primary text-primary-foreground" : "border-border text-muted-foreground hover:bg-secondary"}`}
          >
            {l}
          </button>
        );
      })}
    </div>
  );
}

function Flag({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex min-h-9 cursor-pointer items-center gap-2 text-sm sm:min-h-0">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4 rounded border-border accent-primary" />
      <span className={checked ? "font-medium" : "text-muted-foreground"}>{label}</span>
    </label>
  );
}
