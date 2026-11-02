"use client";

import * as React from "react";
import { Plus, Pencil, Trash2, Loader2, AlertCircle, Power } from "lucide-react";
import { useAction, useFormAction } from "@/components/shared/use-action";
import { createValidationRule, updateValidationRule, deleteValidationRule, toggleValidationRule } from "@/lib/actions/validation-actions";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { Input, Select, Textarea, Label } from "@/components/ui/input";

type Option = { value: string; label: string };

export interface RuleDTO {
  id: string;
  name: string;
  module: string;
  objectType: string;
  description: string;
  minAmount: string;
  maxAmount: string;
  department: string;
  requesterRole: string;
  priority: string;
  category: string;
  validator1Id: string;
  validator2Id: string;
  mode: string;
  active: boolean;
}

export function RuleEditor({
  users, moduleOptions, roleOptions, priorityOptions, rule,
}: {
  users: Option[];
  moduleOptions: Option[];
  roleOptions: Option[];
  priorityOptions: Option[];
  rule?: RuleDTO;
}) {
  const [open, setOpen] = React.useState(false);
  const editing = Boolean(rule);
  const { action: enregistrer, busy: saving, err, setErr } = useFormAction(
    (fd) => (editing ? updateValidationRule(fd) : createValidationRule(undefined, fd)),
    { prepare: (fd) => { if (rule) fd.set("id", rule.id); }, onOk: () => setOpen(false) },
  );

  return (
    <>
      {editing ? (
        <button onClick={() => { setErr(null); setOpen(true); }} className="rounded p-2.5 text-muted-foreground hover:bg-secondary hover:text-foreground sm:p-1.5" title="Modifier la règle" aria-label="Modifier la règle">
          <Pencil className="h-4 w-4" />
        </button>
      ) : (
        <Button onClick={() => { setErr(null); setOpen(true); }}><Plus className="h-4 w-4" /> Nouvelle règle</Button>
      )}

      <Sheet open={open} onClose={() => setOpen(false)} title={editing ? "Modifier la règle" : "Nouvelle règle de validation"} description="Définissez qui valide quoi, selon le contexte." width="lg">
        <form
          action={enregistrer}
          className="space-y-4"
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Wrap full label="Nom de la règle" required><Input name="name" required defaultValue={rule?.name} placeholder="Ex. Validation paiement prestataire" /></Wrap>
            <Wrap label="Module concerné">
              <Select name="module" defaultValue={rule?.module ?? ""}><option value="">Tous</option>{moduleOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select>
            </Wrap>
            <Wrap label="Type d'objet"><Input name="objectType" defaultValue={rule?.objectType} placeholder="PURCHASE, PAYMENT…" /></Wrap>
            <Wrap label="Montant min (DZD)"><Input name="minAmount" type="number" inputMode="decimal" step="any" defaultValue={rule?.minAmount} /></Wrap>
            <Wrap label="Montant max (DZD)"><Input name="maxAmount" type="number" inputMode="decimal" step="any" defaultValue={rule?.maxAmount} /></Wrap>
            <Wrap label="Département"><Input name="department" defaultValue={rule?.department} /></Wrap>
            <Wrap label="Rôle du demandeur">
              <Select name="requesterRole" defaultValue={rule?.requesterRole ?? ""}><option value="">Tous</option>{roleOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select>
            </Wrap>
            <Wrap label="Priorité ciblée">
              <Select name="priority" defaultValue={rule?.priority ?? ""}><option value="">Toutes</option>{priorityOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select>
            </Wrap>
            <Wrap label="Catégorie"><Input name="category" defaultValue={rule?.category} /></Wrap>
            <Wrap label="Validateur 1" required>
              <Select name="validator1Id" required defaultValue={rule?.validator1Id ?? ""}><option value="">—</option>{users.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select>
            </Wrap>
            <Wrap label="Validateur 2 (optionnel)">
              <Select name="validator2Id" defaultValue={rule?.validator2Id ?? ""}><option value="">—</option>{users.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select>
            </Wrap>
            <Wrap label="Mode">
              <Select name="mode" defaultValue={rule?.mode ?? "SEQUENTIAL"}><option value="SEQUENTIAL">Séquentiel (1 puis 2)</option><option value="PARALLEL">Parallèle (les deux)</option></Select>
            </Wrap>
            <Wrap full label="Description"><Textarea name="description" defaultValue={rule?.description} /></Wrap>
            {editing && (
              <Wrap full label="Active">
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="active" defaultChecked={rule?.active} className="h-4 w-4 rounded border-input" /> Règle active</label>
              </Wrap>
            )}
          </div>
          {err && <div className="flex items-center gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"><AlertCircle className="h-4 w-4" /> {err}</div>}
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>Annuler</Button>
            <Button type="submit" disabled={saving}>{saving && <Loader2 className="h-4 w-4 animate-spin" />} Enregistrer</Button>
          </div>
        </form>
      </Sheet>
    </>
  );
}

export function RuleControls({ id, active }: { id: string; active: boolean }) {
  // Les icônes d'une ligne n'ont pas de place pour parler : un refus part en avis flottant.
  const { busy: pending, run } = useAction({ signalerErreurs: true });
  const fd = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
  return (
    <span className="inline-flex items-center gap-1">
      {pending && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
      <button onClick={() => void run(() => toggleValidationRule(fd({ id })))} disabled={pending} className={`rounded p-2.5 hover:bg-secondary sm:p-1.5 ${active ? "text-success" : "text-muted-foreground"}`} title={active ? "Désactiver" : "Activer"} aria-label={active ? "Désactiver la règle" : "Activer la règle"}>
        <Power className="h-4 w-4" />
      </button>
      <button onClick={() => void run(() => deleteValidationRule(fd({ id })), undefined, { confirmer: "Supprimer cette règle ?" })} disabled={pending} className="rounded p-2.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive sm:p-1.5" title="Supprimer" aria-label="Supprimer la règle">
        <Trash2 className="h-4 w-4" />
      </button>
    </span>
  );
}

function Wrap({ label, full, required, children }: { label: string; full?: boolean; required?: boolean; children: React.ReactNode }) {
  return (
    <div className={full ? "sm:col-span-2 space-y-1.5" : "space-y-1.5"}>
      <Label>{label}{required && <span className="ml-0.5 text-destructive">*</span>}</Label>
      {children}
    </div>
  );
}
