"use client";

/**
 * BUDGETS — briques de FORMULAIRE partagées par les écrans « Dépenses » et « Réglages ».
 *
 * Ce fichier ne dessine aucun écran : il ne contient que les tiroirs (enveloppe, catégorie,
 * budget total, dépense) et les champs d'accès. Les écrans, eux, vivent dans
 * `budget-expenses.tsx` et `budget-settings.tsx` — un fichier par intention.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { Plus, Pencil, Trash2, Loader2, CornerDownRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { Input, Select, Textarea, Label } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/utils";
import {
  createEnvelope, updateEnvelope, deleteEnvelope, setBudgetTotal, createBudgetCategory, updateBudgetCategory,
  addBudgetExpense, updateBudgetExpense,
} from "@/lib/actions/budget-envelope-actions";
import type { BudgetOverview, BudgetCategoryView, BudgetHealth, AttributedTx } from "@/lib/queries/budget";
import { ROLE_LABELS } from "@/lib/labels";
import { effetAllocation } from "@/lib/budget/marketing-vue";

interface BudgetTotalInfo { mode: "FIXED" | "FLEXIBLE"; value: number; fixed: number }
type UserOpt = { id: string; name: string };
// Rôles (hors gestionnaires) auxquels on peut ouvrir une enveloppe en consultation.
const ACCESS_ROLE_OPTIONS = ["DIRECTION", "FINANCE_BUDGET_MANAGER", "MEDICAL_PROMOTION_MANAGER", "PRODUCT_MANAGER"] as const;

type Result = { ok: boolean; error?: string };
const d10 = (iso: string) => iso.slice(0, 10);

// Modules rattachables à une enveloppe (les catégories Ad & Pro en tête).
const MODULE_OPTIONS: { value: string; label: string }[] = [
  { value: "SPONSORING", label: "Ad & Pro — Sponsoring" },
  { value: "CONGRESS_INTERNATIONAL", label: "Ad & Pro — Prises en charge Internationales" },
  { value: "CONGRESS_NATIONAL", label: "Ad & Pro — Prises en charge Nationales" },
  { value: "EVENTS", label: "Ad & Pro — Événements" },
  { value: "PROMO_MATERIAL", label: "Ad & Pro — Matériel promotionnel" },
  { value: "AD_PRO_OTHER", label: "Ad & Pro — Autres" },
  { value: "MEDICAL", label: "Annuaire" },
  // Cocher « Moyens généraux » suffit à faire remonter ici les tickets de caisse et les achats
  // du quotidien : c'est ce rattachement que l'acheteur voit comme liste de destinations.
  { value: "GENERAL_MEANS", label: "Moyens généraux" },
  { value: "REGULATORY", label: "Regulatory" },
  { value: "BUSINESS_DEVELOPMENT", label: "Business Development" },
  { value: "RH", label: "Ressources humaines" },
  { value: "LOGISTICS", label: "Logistique" },
  { value: "PCH", label: "PCH — Marchés" },
];
const moduleLabel = (m: string | null | undefined) => MODULE_OPTIONS.find((o) => o.value === m)?.label ?? null;

/** Cases à cocher : une enveloppe peut couvrir un OU plusieurs modules. */
function modulesField(defaultModules: string[] = []) {
  return (
    <div className="space-y-1.5 sm:col-span-2">
      <Label>Modules rattachés</Label>
      <div className="grid grid-cols-1 gap-x-4 gap-y-1.5 rounded-lg border border-input p-2.5 sm:grid-cols-2">
        {MODULE_OPTIONS.map((o) => (
          <label key={o.value} className="flex items-center gap-1.5 text-sm">
            <input type="checkbox" name="modules" value={o.value} defaultChecked={defaultModules.includes(o.value)} className="h-4 w-4 rounded border-input" />
            {o.label}
          </label>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">Cochez un ou plusieurs modules. Laisser vide = enveloppe transverse.</p>
    </div>
  );
}

/** Cases « ouvrir en consultation à… » : ces rôles (ex. Direction des opérations)
 *  ne voient que les enveloppes ainsi ouvertes. */
function accessRolesField(defaultRoles: string[] = []) {
  return (
    <div className="space-y-1.5 sm:col-span-2">
      <Label>Ouvrir en consultation à</Label>
      <div className="flex flex-wrap gap-x-4 gap-y-1.5">
        {ACCESS_ROLE_OPTIONS.map((r) => (
          <label key={r} className="flex items-center gap-1.5 text-sm">
            <input type="checkbox" name="accessRoles" value={r} defaultChecked={defaultRoles.includes(r)} className="h-4 w-4 rounded border-input" />
            {ROLE_LABELS[r] ?? r}
          </label>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">Laisser vide = visible des seuls gestionnaires de budget.</p>
    </div>
  );
}

/** Autorisation par PERSONNE (en plus des rôles) — accordée par le Super Admin. */
function accessUsersField(users: UserOpt[], defaultIds: string[] = []) {
  if (users.length === 0) return null;
  return (
    <div className="space-y-1.5 sm:col-span-2">
      <Label>Autoriser des personnes précises</Label>
      <div className="grid max-h-40 grid-cols-1 gap-x-4 gap-y-1.5 overflow-y-auto rounded-lg border border-input p-2.5 sm:grid-cols-2">
        {users.map((u) => (
          <label key={u.id} className="flex items-center gap-1.5 text-sm">
            <input type="checkbox" name="accessUserIds" value={u.id} defaultChecked={defaultIds.includes(u.id)} className="h-4 w-4 rounded border-input" />
            {u.name}
          </label>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">Ces personnes pourront consulter cette enveloppe (en plus des rôles cochés).</p>
    </div>
  );
}

/**
 * GESTION déléguée : rôles / personnes autorisés par l'admin à GÉRER le contenu de CETTE
 * enveloppe (catégories, allocations, dépenses budgétaires) — au-delà de la simple consultation.
 * La modification de l'enveloppe elle-même et de ses accès reste réservée à l'admin.
 */
function managersField(users: UserOpt[], defaultRoles: string[] = [], defaultIds: string[] = []) {
  return (
    <div className="space-y-2 rounded-lg border border-dashed border-input p-2.5 sm:col-span-2">
      <Label>Déléguer la gestion (au-delà de la consultation)</Label>
      <div className="flex flex-wrap gap-x-4 gap-y-1.5">
        {ACCESS_ROLE_OPTIONS.map((r) => (
          <label key={r} className="flex items-center gap-1.5 text-sm">
            <input type="checkbox" name="managerRoles" value={r} defaultChecked={defaultRoles.includes(r)} className="h-4 w-4 rounded border-input" />
            {ROLE_LABELS[r] ?? r}
          </label>
        ))}
      </div>
      {users.length > 0 && (
        <div className="grid max-h-36 grid-cols-1 gap-x-4 gap-y-1.5 overflow-y-auto rounded-lg border border-input p-2 sm:grid-cols-2">
          {users.map((u) => (
            <label key={u.id} className="flex items-center gap-1.5 text-sm">
              <input type="checkbox" name="managerUserIds" value={u.id} defaultChecked={defaultIds.includes(u.id)} className="h-4 w-4 rounded border-input" />
              {u.name}
            </label>
          ))}
        </div>
      )}
      <p className="text-xs text-muted-foreground">Gestionnaires : peuvent créer/modifier catégories et dépenses de cette enveloppe (pas les accès ni le montant).</p>
    </div>
  );
}

export const HEALTH: Record<BudgetHealth, { label: string; tone: "success" | "warning" | "danger" | "neutral"; bar: string }> = {
  ON_TRACK: { label: "Maîtrisé", tone: "success", bar: "bg-success" },
  AT_RISK: { label: "À surveiller", tone: "warning", bar: "bg-warning" },
  OVER_BUDGET: { label: "Dépassé", tone: "danger", bar: "bg-destructive" },
  NONE: { label: "—", tone: "neutral", bar: "bg-muted-foreground/40" },
};

export function useRun() {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const run = async (fn: () => Promise<Result>, onOk?: () => void) => {
    setBusy(true); setErr(null);
    const r = await fn();
    setBusy(false);
    if (r.ok) { onOk?.(); router.refresh(); } else setErr(r.error ?? "Erreur.");
  };
  return { busy, err, setErr, run };
}

function field(name: string, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}, full = false) {
  return (
    <div className={full ? "space-y-1.5 sm:col-span-2" : "space-y-1.5"}>
      <Label>{label}</Label>
      <Input name={name} {...props} />
    </div>
  );
}

export function CreateEnvelopeButton({ users = [] }: { users?: UserOpt[] }) {
  const [open, setOpen] = React.useState(false);
  const { busy, err, run } = useRun();
  const year = new Date().getFullYear();
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> Nouvelle enveloppe</Button>
      <Sheet open={open} onClose={() => setOpen(false)} title="Nouvelle enveloppe budgétaire" description="Un budget total pour une période, à répartir ensuite en catégories." width="md">
        <form action={(fd) => run(() => createEnvelope(fd), () => setOpen(false))} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {field("name", "Nom de l'enveloppe", { placeholder: `Budget ${year}`, required: true }, true)}
          {modulesField()}
          {field("totalAmount", "Montant de l'enveloppe (DZD)", { type: "number", inputMode: "decimal", step: "any", placeholder: "0" }, true)}
          {field("periodStart", "Début de période", { type: "date", defaultValue: `${year}-01-01` })}
          {field("periodEnd", "Fin de période", { type: "date", defaultValue: `${year}-12-31` })}
          {accessRolesField()}
          {accessUsersField(users)}
          {managersField(users)}
          <div className="space-y-1.5 sm:col-span-2"><Label>Notes</Label><Textarea name="notes" rows={2} /></div>
          {err && <p className="text-sm text-destructive sm:col-span-2">{err}</p>}
          <div className="flex flex-col-reverse gap-2 sm:col-span-2 sm:flex-row sm:justify-end"><Button type="button" variant="outline" onClick={() => setOpen(false)}>Annuler</Button><Button type="submit" disabled={busy}>{busy && <Loader2 className="h-4 w-4 animate-spin" />} Créer</Button></div>
        </form>
      </Sheet>
    </>
  );
}

export function BudgetTotalSheet({ info, onClose }: { info: BudgetTotalInfo; onClose: () => void }) {
  const { busy, err, run } = useRun();
  const [mode, setMode] = React.useState<BudgetTotalInfo["mode"]>(info.mode);
  return (
    <Sheet open onClose={onClose} title="Budget total" description="Au-dessus des enveloppes : un montant figé, ou la somme automatique des enveloppes." width="md">
      <form action={(fd) => { fd.set("mode", mode); run(() => setBudgetTotal(fd), onClose); }} className="space-y-4">
        <div className="space-y-1.5">
          <Label>Mode</Label>
          <Select value={mode} onChange={(e) => setMode(e.target.value as BudgetTotalInfo["mode"])}>
            <option value="FLEXIBLE">Flexible — somme des enveloppes</option>
            <option value="FIXED">Fixe — montant figé</option>
          </Select>
        </div>
        {mode === "FIXED" && (
          <div className="space-y-1.5">
            <Label>Montant total fixe (DZD)</Label>
            <Input name="budgetFixedTotal" type="number" inputMode="decimal" step="any" defaultValue={info.fixed} />
          </div>
        )}
        {err && <p className="text-sm text-destructive">{err}</p>}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><Button type="button" variant="outline" onClick={onClose}>Annuler</Button><Button type="submit" disabled={busy}>{busy && <Loader2 className="h-4 w-4 animate-spin" />} Enregistrer</Button></div>
      </form>
    </Sheet>
  );
}

/**
 * Ajout RAPIDE d'une ligne de dépense qui CONSOMME un budget : (sous-)catégorie + référence
 * + montant → « + ». Crée une dépense réelle réglée imputée à la catégorie (consommation immédiate).
 */
export function AddExpenseRow({ categories }: { categories: BudgetCategoryView[] }) {
  const { busy, err, run } = useRun();
  const formRef = React.useRef<HTMLFormElement>(null);
  return (
    <form
      ref={formRef}
      action={(fd) => run(() => addBudgetExpense(fd), () => formRef.current?.reset())}
      className="surface flex flex-wrap items-end gap-2 p-3"
    >
      <div className="w-full space-y-1 sm:w-auto">
        <Label className="text-xs">Budget consommé</Label>
        <Select name="budgetCategoryId" required defaultValue="" className="h-10 w-full sm:h-9 sm:w-56">
          <option value="" disabled>Choisir une (sous-)catégorie…</option>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.parentId ? `↳ ${c.name}` : c.name}</option>)}
        </Select>
      </div>
      <div className="w-full space-y-1 sm:w-auto">
        <Label className="text-xs">Référence</Label>
        <Input name="reference" required placeholder="Ex. Facture 2026-042" className="h-10 w-full sm:h-9 sm:w-48" />
      </div>
      <div className="w-full space-y-1 sm:w-auto">
        <Label className="text-xs">Montant (DZD)</Label>
        <Input name="amount" type="number" inputMode="decimal" step="any" min="0" required placeholder="0" className="h-10 w-full tabular-nums sm:h-9 sm:w-32" />
      </div>
      <Button type="submit" size="sm" className="w-full sm:w-auto" disabled={busy}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Ajouter la dépense
      </Button>
      {err && <p className="w-full text-xs text-destructive">{err}</p>}
    </form>
  );
}

/**
 * Édition d'une ligne de dépense purement budgétaire (BudgetExpenseLine) : référence, montant,
 * date et RÉ-IMPUTATION vers une autre (sous-)catégorie. La consommation se réajuste aussitôt.
 * (Les dépenses de trésorerie, elles, se modifient dans les Finances.)
 */
export function ExpenseEditSheet({ tx, categories, onClose }: { tx: AttributedTx; categories: BudgetCategoryView[]; onClose: () => void }) {
  const { busy, err, run } = useRun();
  return (
    <Sheet open onClose={onClose} title="Modifier la dépense" description="Ligne purement budgétaire — la consommation de la catégorie est réajustée aussitôt." width="md">
      <form action={(fd) => { fd.set("id", tx.id); run(() => updateBudgetExpense(fd), onClose); }} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {field("reference", "Référence", { defaultValue: tx.reference, placeholder: "Ex. Facture 2026-042", required: true }, true)}
        {field("amount", "Montant (DZD)", { type: "number", inputMode: "decimal", step: "any", min: 0, defaultValue: tx.amount, required: true })}
        {field("date", "Date", { type: "date", defaultValue: d10(tx.date) })}
        <div className="space-y-1.5 sm:col-span-2">
          <Label>Budget consommé</Label>
          <Select name="budgetCategoryId" defaultValue={tx.categoryId}>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.parentId ? `↳ ${c.name}` : c.name}</option>)}
          </Select>
          <p className="text-xs text-muted-foreground">Changez la (sous-)catégorie pour ré-imputer la dépense.</p>
        </div>
        {err && <p className="text-sm text-destructive sm:col-span-2">{err}</p>}
        <div className="flex flex-col-reverse gap-2 sm:col-span-2 sm:flex-row sm:justify-end"><Button type="button" variant="outline" onClick={onClose}>Annuler</Button><Button type="submit" disabled={busy}>{busy && <Loader2 className="h-4 w-4 animate-spin" />} Enregistrer</Button></div>
      </form>
    </Sheet>
  );
}

/**
 * `c` arrive CUMULÉE (ses sous-catégories comprises, `budget/cumul-categories.ts`) ; `propre` est la part
 * imputée directement à la catégorie, rappelée quand des sous-catégories existent.
 */
export function CategoryCard({ c, propre, subs, canManage, onEdit, onDelete, onAddSub }: { c: BudgetCategoryView; propre?: number; subs: BudgetCategoryView[]; canManage: boolean; onEdit: (cat: BudgetCategoryView) => void; onDelete: (cat: BudgetCategoryView) => void; onAddSub: () => void }) {
  const h = HEALTH[c.health];
  const pct = Math.min(c.pct, 100);
  const subAllocated = subs.reduce((a, s) => a + s.allocated, 0);
  return (
    <div className="surface p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: c.color ?? "#64748b" }} />
        <span className="min-w-0 font-semibold [overflow-wrap:anywhere]">{c.name}</span>
        {c.module && <Badge tone="info" dot={false}>{moduleLabel(c.module) ?? c.module}</Badge>}
        <Badge tone={h.tone} dot={false}>{h.label}</Badge>
        <span className="ml-auto whitespace-nowrap text-sm text-muted-foreground tabular-nums">{formatCurrency(c.consumed)} / {formatCurrency(c.allocated)}</span>
        {canManage && (
          <div className="flex items-center gap-0.5">
            <button title="Ajouter une sous-catégorie" aria-label="Ajouter une sous-catégorie" onClick={onAddSub} className="rounded p-2 text-muted-foreground hover:bg-secondary hover:text-foreground sm:p-1.5"><Plus className="h-4 w-4" /></button>
            <button title="Modifier" aria-label="Modifier" onClick={() => onEdit(c)} className="rounded p-2 text-muted-foreground hover:bg-secondary hover:text-foreground sm:p-1.5"><Pencil className="h-4 w-4" /></button>
            <button title="Supprimer" aria-label="Supprimer" onClick={() => onDelete(c)} className="rounded p-2 text-muted-foreground hover:bg-destructive/10 hover:text-destructive sm:p-1.5"><Trash2 className="h-4 w-4" /></button>
          </div>
        )}
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-secondary">
        <div className={cn("h-full rounded-full transition-all", h.bar)} style={{ width: `${pct}%` }} />
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
        <span>Reste : <span className={cn("font-medium", c.remaining < 0 ? "text-destructive" : "text-foreground")}>{formatCurrency(c.remaining)}</span></span>
        <span>{c.pct}% consommé</span>
        {c.committed > 0 && <span>{formatCurrency(c.committed)} engagé (prévu)</span>}
        {subs.length > 0 && (
          <span>
            {subs.length} sous-catégorie{subs.length > 1 ? "s" : ""} comprise{subs.length > 1 ? "s" : ""}
            {propre !== undefined && <> · dont {formatCurrency(c.consumed - propre)} consommé dans les sous-catégories</>}
            {subAllocated > 0 && <> · {formatCurrency(subAllocated)} réparti</>}
          </span>
        )}
      </div>

      {/* Sous-catégories (ex. Table ronde sous Événement) */}
      {subs.length > 0 && (
        <div className="mt-2 space-y-1 border-l-2 border-border pl-3">
          {subs.map((s) => (
            <div key={s.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
              <CornerDownRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: s.color ?? "#94a3b8" }} />
              <span className="min-w-0 flex-1 truncate">{s.name}</span>
              <span className="ml-auto whitespace-nowrap text-xs text-muted-foreground tabular-nums">{formatCurrency(s.consumed)}{s.allocated > 0 ? <> / {formatCurrency(s.allocated)}</> : <> · sur l&apos;allocation de la catégorie</>}</span>
              {canManage && (
                <div className="flex items-center gap-0.5">
                  <button title="Modifier" aria-label="Modifier" onClick={() => onEdit(s)} className="rounded p-2 text-muted-foreground hover:bg-secondary hover:text-foreground sm:p-1"><Pencil className="h-3.5 w-3.5" /></button>
                  <button title="Supprimer" aria-label="Supprimer" onClick={() => onDelete(s)} className="rounded p-2 text-muted-foreground hover:bg-destructive/10 hover:text-destructive sm:p-1"><Trash2 className="h-3.5 w-3.5" /></button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function EnvelopeSheet({ envelope, users, onClose, onDeleted, canDelete }: { envelope: BudgetOverview["envelope"]; users: UserOpt[]; onClose: () => void; onDeleted: () => void; canDelete: boolean }) {
  const { busy, err, setErr, run } = useRun();
  return (
    <Sheet open onClose={onClose} title="Modifier l'enveloppe" width="md">
      <form action={(fd) => { fd.set("id", envelope.id); run(() => updateEnvelope(fd), onClose); }} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {field("name", "Nom", { defaultValue: envelope.name, required: true }, true)}
        {modulesField(envelope.modules.length ? envelope.modules : envelope.module ? [envelope.module] : [])}
        {field("totalAmount", "Budget total (DZD)", { type: "number", inputMode: "decimal", step: "any", defaultValue: envelope.total }, true)}
        {field("periodStart", "Début", { type: "date", defaultValue: d10(envelope.periodStart) })}
        {field("periodEnd", "Fin", { type: "date", defaultValue: d10(envelope.periodEnd) })}
        {accessRolesField(envelope.accessRoles)}
        {accessUsersField(users, envelope.accessUserIds)}
        {managersField(users, envelope.managerRoles, envelope.managerUserIds)}
        <div className="space-y-1.5 sm:col-span-2"><Label>Notes</Label><Textarea name="notes" defaultValue={envelope.notes ?? ""} rows={2} /></div>
        <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" name="isActive" defaultChecked={envelope.isActive} className="h-4 w-4 rounded border-input" /> Enveloppe active</label>
        {err && <p className="text-sm text-destructive sm:col-span-2">{err}</p>}
        <div className="flex flex-col-reverse gap-2 sm:col-span-2 sm:flex-row sm:items-center sm:justify-between">
          {canDelete ? <Button type="button" variant="ghost" className="text-destructive" onClick={() => { if (window.confirm("Supprimer cette enveloppe et ses catégories ?")) { const fd = new FormData(); fd.set("id", envelope.id); deleteEnvelope(fd).then((r) => { if (r.ok) onDeleted(); else setErr(r.error ?? "Suppression refusée."); }); } }}><Trash2 className="h-4 w-4" /> Supprimer</Button> : <span />}
          <div className="flex flex-col-reverse gap-2 sm:flex-row"><Button type="button" variant="outline" onClick={onClose}>Annuler</Button><Button type="submit" disabled={busy}>{busy && <Loader2 className="h-4 w-4 animate-spin" />} Enregistrer</Button></div>
        </div>
      </form>
    </Sheet>
  );
}

/**
 * `repartition` (Budget Marketing, maquette « onglets ») : le panneau dit l'effet de l'allocation saisie — dans sa
 * catégorie (« les sous-catégories répartiraient X sur Y alloués ») ou dans l'enveloppe (`effetAllocation`).
 */
export function CategorySheet({ envelopeId, cat, defaultParentId, parentOptions, onClose, repartition }: {
  envelopeId: string; cat?: BudgetCategoryView; defaultParentId?: string; parentOptions: { id: string; name: string }[]; onClose: () => void;
  repartition?: { total: number; categories: { id: string; parentId: string | null; alloue: number; nom: string }[] };
}) {
  const { busy, err, run } = useRun();
  const [parent, setParent] = React.useState(cat?.parentId ?? defaultParentId ?? "");
  const [alloue, setAlloue] = React.useState(cat ? String(cat.allocated) : "");
  const effet = repartition ? effetAllocation({ total: repartition.total, categories: repartition.categories, id: cat?.id ?? null, parentId: parent || null, alloue: Number(alloue.replace(",", ".")) || 0 }) : null;
  const nomParent = repartition?.categories.find((c) => c.id === parent)?.nom ?? "";
  // On ne propose pas la catégorie elle-même comme parente (édition) → pas de cycle.
  const opts = parentOptions.filter((o) => o.id !== cat?.id);
  return (
    <Sheet open onClose={onClose} title={cat ? "Modifier la catégorie" : parent ? "Nouvelle sous-catégorie" : "Nouvelle catégorie"} width="md">
      <form
        action={(fd) => {
          if (cat) { fd.set("id", cat.id); run(() => updateBudgetCategory(fd), onClose); }
          else { fd.set("envelopeId", envelopeId); run(() => createBudgetCategory(fd), onClose); }
        }}
        className="grid grid-cols-1 gap-3 sm:grid-cols-2"
      >
        {field("name", "Nom de la catégorie", { defaultValue: cat?.name, placeholder: parent ? "Ex. Table ronde" : "Ex. Sponsoring", required: true }, true)}
        {opts.length > 0 && (
          <div className="space-y-1.5 sm:col-span-2">
            <Label>Catégorie parente</Label>
            <Select name="parentId" value={parent} onChange={(e) => setParent(e.target.value)}>
              <option value="">— Catégorie de tête —</option>
              {opts.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </Select>
            <p className="text-xs text-muted-foreground">Rattachez-la à une catégorie pour en faire une sous-catégorie (ex. « Table ronde » sous « Événement »).</p>
          </div>
        )}
        {/* Le module ne s'applique qu'aux catégories de tête (attribution automatique). */}
        {!parent && (
          <div className="space-y-1.5 sm:col-span-2">
            <Label>Module associé</Label>
            <Select name="module" defaultValue={cat?.module ?? ""}>
              <option value="">— Aucun —</option>
              {MODULE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </Select>
            <p className="text-xs text-muted-foreground">Les dépenses d'une demande de ce module, une fois validées et réglées par les Finances, sont attribuées automatiquement à cette catégorie.</p>
          </div>
        )}
        {field("allocated", "Allocation (DZD)", { type: "number", inputMode: "decimal", step: "any", defaultValue: cat?.allocated ?? "", onChange: (e) => setAlloue(e.target.value) })}
        <div className="space-y-1.5"><Label>Couleur</Label><input type="color" name="color" defaultValue={cat?.color ?? "#0ea5e9"} className="h-9 w-full cursor-pointer rounded-lg border border-input" /></div>
        <div className="space-y-1.5 sm:col-span-2"><Label>Notes</Label><Textarea name="notes" defaultValue={cat?.notes ?? ""} rows={2} /></div>
        {effet && (
          <p className="rounded-lg border border-border bg-secondary/50 p-3 text-xs text-muted-foreground sm:col-span-2" role="status">
            {effet.dans === "CATEGORIE"
              ? <><b className="text-foreground">Comprise dans « {nomParent} ».</b> Ce qu&apos;elle consomme, « {nomParent} » le consomme aussi. Les sous-catégories répartiraient {formatCurrency(effet.reparti)} sur {formatCurrency(effet.plafond)} alloués</>
              : <><b className="text-foreground">Catégorie de tête.</b> Les catégories répartiraient {formatCurrency(effet.reparti)} sur {formatCurrency(effet.plafond)}</>}
            {effet.depassement > 0.5 ? <> — <b className="text-destructive">{formatCurrency(effet.depassement)} {effet.dans === "CATEGORIE" ? "de trop" : "au-delà de l'enveloppe"}</b>.</> : "."}
          </p>
        )}
        {err && <p className="text-sm text-destructive sm:col-span-2">{err}</p>}
        <div className="flex flex-col-reverse gap-2 sm:col-span-2 sm:flex-row sm:justify-end"><Button type="button" variant="outline" onClick={onClose}>Annuler</Button><Button type="submit" disabled={busy}>{busy && <Loader2 className="h-4 w-4 animate-spin" />} Enregistrer</Button></div>
      </form>
    </Sheet>
  );
}
