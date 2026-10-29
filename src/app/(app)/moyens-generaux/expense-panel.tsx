"use client";

import * as React from "react";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";
import { Receipt, Loader2, Plus, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet } from "@/components/ui/sheet";
import { formatCurrency } from "@/lib/utils";
import { DEPT_BUDGET_LABEL } from "@/lib/department-budget";
import { addDepartmentExpense } from "@/lib/actions/department-budget-actions";
import { ReceiptLines, type CatalogArticle } from "./receipt-lines";
import { BudgetTargetField } from "./budget-target-field";
import { SOURCE_LABEL, SOURCE_HINT, defaultSource, type PaymentSource } from "@/lib/general-means/payment-source";
import { cn } from "@/lib/utils";
import type { BudgetTarget } from "@/lib/budget/target";
import { journal } from "@/lib/journal";

/**
 * AJOUTER UN ACHAT — UN SEUL BOUTON, la question du paiement à l'intérieur.
 *
 * Il y en avait deux : « Ajouter une dépense » (sur le budget) et « Enregistrer une dépense »
 * (sur la caisse d'avance). Deux boutons, deux formulaires, deux endroits — pour la MÊME dépense :
 * le même achat, la même facture, le même budget consommé. Seul le moyen de paiement changeait.
 * On saisissait régulièrement par le mauvais, et la caisse se retrouvait fausse d'un côté,
 * gonflée de l'autre, sans qu'aucun des deux écrans ne le dise.
 *
 * La pièce est obligatoire, et le formulaire le dit avant qu'on ne clique : une dépense sans
 * facture ni bon de paiement n'est qu'une affirmation, et un budget bâti sur des affirmations
 * ne sert à rien.
 */
export function ExpensePanel({
  departmentId, year, remaining, articles, budgetTargets = [], cash,
}: {
  departmentId: string;
  year: number;
  remaining: number;
  articles: CatalogArticle[];
  budgetTargets?: BudgetTarget[];
  /** La caisse d'avance, quand elle contient quelque chose ET qu'on peut en sortir de l'argent. */
  cash?: { status: string; remaining: number; canSpend: boolean } | null;
}) {
  const { rafraichir } = useRafraichir();
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);
  // Le montant vient du DÉTAIL du ticket : il se calcule, il ne se saisit pas à côté.
  const [total, setTotal] = React.useState(0);

  const cashUsable = Boolean(cash?.canSpend);
  const [source, setSource] = React.useState<PaymentSource>(
    defaultSource(cash ? { status: cash.status } : null, { isHolder: cashUsable }),
  );
  React.useEffect(() => {
    if (open) setSource(defaultSource(cash ? { status: cash.status } : null, { isHolder: cashUsable }));
  }, [open, cash, cashUsable]);

  // Le plafond dépassé n'est pas le même selon le moyen de paiement : le fond en main d'un côté,
  // la caisse de l'exercice de l'autre. Prévenir avec le mauvais chiffre serait pire que se taire.
  const ceiling = source === "CASH" && cash ? cash.remaining : remaining;
  const overBudget = total > 0 && total > ceiling;

  React.useEffect(() => {
    if (!msg?.ok) return;
    const t = window.setTimeout(() => setMsg(null), 8000);
    return () => window.clearTimeout(t);
  }, [msg]);

  return (
    <>
      <Button onClick={() => { setOpen(true); setMsg(null); }}>
        <Plus className="h-4 w-4" /> Ajouter une dépense
      </Button>
      <Sheet open={open} onClose={() => setOpen(false)} title="Ajouter une dépense" width="lg">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            fd.set("departmentId", departmentId);
            fd.set("year", String(year));
            fd.set("paymentSource", source);
            setBusy(true); setMsg(null);
            void addDepartmentExpense(fd).then((r) => {
              setBusy(false);
              setMsg({
                ok: r.ok,
                text: r.ok
                  ? (source === "CASH" ? "Dépense enregistrée et déduite de la caisse d'avance." : "Dépense enregistrée et déduite de la caisse de l'exercice.")
                  : (r.error ?? "La dépense n'a pas été enregistrée."),
              });
              if (r.ok) { setOpen(false); setTotal(0); rafraichir(); }
            }).catch((e: unknown) => { journal.erreur("expense-panel.addDepartmentExpense", {}, e);
              setBusy(false);
              setMsg({ ok: false, text: actionFailureMessage("THROWN") });
            });
          }}
          className="space-y-3"
        >
          {/* PAYÉ COMMENT ? La question qui séparait deux boutons — elle tient en deux cases. */}
          {cashUsable && (
            <div className="grid grid-cols-2 gap-2">
              {(["CASH", "OFF_CASH"] as PaymentSource[]).map((s) => (
                <button
                  key={s} type="button" onClick={() => setSource(s)} aria-pressed={source === s}
                  className={cn(
                    "rounded-lg border p-2 text-left transition",
                    source === s ? "border-primary bg-primary/5 ring-1 ring-primary" : "border-border bg-background hover:bg-secondary",
                  )}
                >
                  <span className="block text-sm font-medium">{SOURCE_LABEL[s]}</span>
                  <span className="block text-[0.6875rem] text-muted-foreground">{SOURCE_HINT[s]}</span>
                </button>
              ))}
            </div>
          )}

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <label className="text-xs sm:col-span-2">
              Objet de l&apos;achat
              <Input name="label" placeholder="Facultatif — résumé depuis les articles si vide" className="mt-1 h-9" />
            </label>
            <label className="text-xs">
              Budget imputé
              <select name="kind" defaultValue="OPERATING" className="mt-1 h-10 w-full rounded-lg border border-border bg-background px-2 text-base sm:h-9 sm:text-sm">
                <option value="OPERATING">{DEPT_BUDGET_LABEL.OPERATING}</option>
                <option value="ACTIVITY">{DEPT_BUDGET_LABEL.ACTIVITY}</option>
              </select>
            </label>
            <BudgetTargetField targets={budgetTargets} />
            <label className="text-xs sm:col-span-3">
              Précisions
              <Input name="notes" placeholder="Facultatif — fournisseur, n° de facture…" className="mt-1 h-9" />
            </label>
          </div>

          <div className="rounded-lg border border-border bg-background p-2">
            <p className="mb-1.5 text-xs font-medium">
              Articles de la facture <span className="text-destructive">*</span>
              <span className="ml-1 font-normal text-muted-foreground">— le total en découle</span>
            </p>
            <ReceiptLines articles={articles} onTotalChange={setTotal} budgetTargets={budgetTargets} />
          </div>

          <label className="block text-xs">
            Scan de la facture ou du bon de paiement <span className="text-destructive">*</span>
            <input
              type="file" name="files" multiple required
              className="mt-1 block w-full text-sm text-muted-foreground file:mr-3 file:rounded-lg file:border-0 file:bg-secondary file:px-3 file:py-1.5 file:text-sm file:font-medium"
            />
          </label>

          {overBudget && (
            <p className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/5 p-2 text-xs text-muted-foreground">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
              <span>
                Ce montant dépasse ce qu&apos;il reste{source === "CASH" ? " dans la caisse d'avance" : " sur la caisse de l'exercice"} ({formatCurrency(ceiling)}).
                {source === "CASH"
                  ? " La dépense sera refusée : on ne sort pas d'un fond ce qu'il ne contient pas."
                  : " La dépense sera enregistrée — mais le budget passera en dépassement, et cela se verra."}
              </span>
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            <Button size="sm" type="submit" disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Receipt className="h-4 w-4" />} Enregistrer la dépense
            </Button>
            <Button size="sm" type="button" variant="outline" onClick={() => setOpen(false)}>Annuler</Button>
          </div>
        </form>
      </Sheet>

      {/* Le résultat de l'enregistrement, sous l'en-tête où se tient le bouton. Il s'efface seul. */}
      {msg && (
        <p role="status" className={`w-full rounded-xl px-3 py-2 text-sm sm:max-w-md ${msg.ok ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive"}`}>
          {msg.text}
        </p>
      )}
    </>
  );
}
