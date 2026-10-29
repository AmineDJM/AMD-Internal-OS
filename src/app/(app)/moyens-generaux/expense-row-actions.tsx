"use client";

import * as React from "react";
import { useAction } from "@/components/shared/use-action";
import { Pencil, Trash2, Loader2, Check, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { formatCurrency } from "@/lib/utils";
import { DEPT_BUDGET_LABEL } from "@/lib/department-budget";
import { updateDepartmentExpense, deleteDepartmentExpense } from "@/lib/actions/department-budget-actions";
import { ReceiptLines, type CatalogArticle, type ExistingLine } from "./receipt-lines";
import { BudgetTargetField } from "./budget-target-field";
import { SOURCE_LABEL, SOURCE_HINT, type PaymentSource } from "@/lib/general-means/payment-source";
import { cn } from "@/lib/utils";
import type { BudgetTarget } from "@/lib/budget/target";
import { BoutonDecisif } from "@/components/ui/bouton-decisif";

export interface EditableExpense {
  id: string;
  label: string;
  amount: number;
  kind: string;
  notes: string | null;
  fromPettyCash: boolean;
  budgetCategoryId: string | null;
  lines: { id: string; label: string; quantity: number; amount: number; budgetCategoryId: string | null }[];
}

/**
 * CORRIGER OU SUPPRIMER UNE DÉPENSE, depuis la liste où on la relit.
 *
 * Une erreur de saisie — mauvais montant, double enregistrement, mauvaise nature de budget —
 * se répare là où on la voit. La laisser « pour la trace » ne préserve rien : elle fausse à la
 * fois le budget et le solde de caisse, qui se lisent tous deux sur ces lignes. C'est le
 * JOURNAL D'AUDIT qui garde la trace, avec le montant d'avant et l'auteur de la correction.
 *
 * Le formulaire rouvre le TICKET, pas seulement le montant : une dépense sans détail est
 * réouverte comme un article unique portant son libellé et sa somme — ce qu'elle est
 * réellement — plutôt que de perdre l'information au premier passage.
 */
export function ExpenseRowActions({
  expense, articles, budgetTargets = [], cashUsable = false,
}: {
  expense: EditableExpense;
  articles: CatalogArticle[];
  budgetTargets?: BudgetTarget[];
  /** Une caisse du mois existe, reçue, entre les mains de qui regarde : le moyen de paiement se corrige. */
  cashUsable?: boolean;
}) {
  const [mode, setMode] = React.useState<"idle" | "edit" | "confirm">("idle");
  const { busy, err: error, setErr: setError, run } = useAction();
  const [total, setTotal] = React.useState(expense.amount);
  const [source, setSource] = React.useState<PaymentSource>(expense.fromPettyCash ? "CASH" : "OFF_CASH");
  React.useEffect(() => {
    if (mode === "edit") setSource(expense.fromPettyCash ? "CASH" : "OFF_CASH");
  }, [mode, expense.fromPettyCash]);

  const initial: ExistingLine[] = expense.lines.length > 0
    ? expense.lines
    : [{ label: expense.label, quantity: 1, amount: expense.amount, budgetCategoryId: expense.budgetCategoryId }];

  const remove = async () => {
    const fd = new FormData(); fd.set("id", expense.id);
    await run(() => deleteDepartmentExpense(fd), () => setMode("idle"));
  };

  return (
    <>
      <span className="flex items-center gap-0.5">
        <button
          type="button"
          onClick={() => { setMode(mode === "edit" ? "idle" : "edit"); setError(null); }}
          aria-label="Modifier la dépense"
          title="Modifier"
          className="rounded-md p-2 text-muted-foreground hover:bg-secondary hover:text-foreground sm:p-1.5"
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => { setMode(mode === "confirm" ? "idle" : "confirm"); setError(null); }}
          aria-label="Supprimer la dépense"
          title="Supprimer"
          className="rounded-md p-2 text-muted-foreground hover:bg-destructive/10 hover:text-destructive sm:p-1.5"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </span>

      {/* SUPPRESSION : on dit ce qui part, et l'effet sur les chiffres. « Êtes-vous sûr ? »
          ne renseigne personne — le montant réimputé au budget, si. */}
      {mode === "confirm" && (
        <div className="w-full rounded-lg border border-destructive/40 bg-destructive/5 p-2.5 text-xs">
          <p>
            Supprimer <strong>{expense.label}</strong> ({formatCurrency(expense.amount)}) ?
            Le montant est <strong>rendu au budget</strong>
            {expense.fromPettyCash ? " et au solde de la caisse" : ""}, et le justificatif est
            supprimé avec la ligne. L&apos;opération est tracée dans le journal.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <BoutonDecisif size="sm" variant="destructive" onClick={() => void remove()} disabled={busy}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />} Supprimer
            </BoutonDecisif>
            <Button size="sm" variant="outline" onClick={() => setMode("idle")}><X className="h-3.5 w-3.5" /> Annuler</Button>
          </div>
        </div>
      )}

      {mode === "edit" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            fd.set("id", expense.id);
            // Champ envoyé UNIQUEMENT quand le choix est offert : absent = moyen de paiement
            // inchangé côté serveur, ce qui protège les écrans qui ne le proposent pas.
            if (cashUsable || expense.fromPettyCash) fd.set("paymentSource", source);
            void run(() => updateDepartmentExpense(fd), () => setMode("idle"));
          }}
          className="w-full space-y-2 rounded-lg border border-primary/30 bg-primary/5 p-2.5"
        >
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <label className="text-xs sm:col-span-2">
              Objet
              <Input name="label" defaultValue={expense.label} placeholder="Résumé depuis les articles si vide" className="mt-1 h-9" />
            </label>
            <label className="text-xs">
              Budget imputé
              <select name="kind" defaultValue={expense.kind} className="mt-1 h-10 w-full rounded-lg border border-border bg-background px-2 text-base sm:h-9 sm:text-sm">
                <option value="OPERATING">{DEPT_BUDGET_LABEL.OPERATING}</option>
                <option value="ACTIVITY">{DEPT_BUDGET_LABEL.ACTIVITY}</option>
              </select>
            </label>
            <BudgetTargetField targets={budgetTargets} defaultValue={expense.budgetCategoryId} />
            <label className="text-xs sm:col-span-3">
              Précisions
              <Input name="notes" defaultValue={expense.notes ?? ""} placeholder="Facultatif" className="mt-1 h-9" />
            </label>
          </div>

          {/* « C'ÉTAIT EN FAIT SUR LA CAISSE. » Une dépense saisie du mauvais côté laisse le fond
              du mois faux jusqu'au solde, et l'erreur ne se voit qu'à ce moment-là. On la corrige
              donc ici, là où on la constate. */}
          {(cashUsable || expense.fromPettyCash) && (
            <div className="grid grid-cols-2 gap-2">
              {(["CASH", "OFF_CASH"] as PaymentSource[]).map((v) => (
                <button
                  key={v} type="button" onClick={() => setSource(v)} aria-pressed={source === v}
                  className={cn(
                    "rounded-lg border p-2 text-left transition",
                    source === v ? "border-primary bg-primary/5 ring-1 ring-primary" : "border-border bg-background hover:bg-secondary",
                  )}
                >
                  <span className="block text-xs font-medium">{SOURCE_LABEL[v]}</span>
                  <span className="block text-[0.6875rem] text-muted-foreground">{SOURCE_HINT[v]}</span>
                </button>
              ))}
            </div>
          )}

          <div className="rounded-lg border border-border bg-background p-2">
            <p className="mb-1.5 text-xs font-medium">
              Articles <span className="font-normal text-muted-foreground">— le montant en découle</span>
            </p>
            <ReceiptLines articles={articles} initial={initial} onTotalChange={setTotal} budgetTargets={budgetTargets} />
          </div>

          {total !== expense.amount && (
            <p className="text-xs text-muted-foreground">
              Montant : {formatCurrency(expense.amount)} → <strong>{formatCurrency(total)}</strong>
              {expense.fromPettyCash ? " — le solde de la caisse suivra." : " — le budget suivra."}
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            <Button size="sm" type="submit" disabled={busy}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} Enregistrer
            </Button>
            <Button size="sm" type="button" variant="outline" onClick={() => setMode("idle")}>Annuler</Button>
          </div>
        </form>
      )}

      {error && <p className="w-full rounded-lg bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive">{error}</p>}
    </>
  );
}
