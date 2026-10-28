"use client";

import { Loader2, CheckCircle2, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { budgetKindLocked, ITEM_KINDS, ITEM_KIND_LABELS, ITEM_BUDGET_KIND_LABELS } from "@/lib/ad-pro-items";
import { estPosteStock, RANGEE_ACTIONS, type ItemRow } from "../items-panel";

/** MODIFIER UN POSTE, ET SES CHIFFRES — sortis de `items-panel.tsx` (cliquet de taille). */

/**
 * MODIFIER UN POSTE — ce qui le DÉCRIT, pas ce qui l'engage.
 *
 * Ces champs ne portent aucun engagement financier — seul le montant AFFECTÉ a été transmis aux
 * Finances, et lui seul se verrouille avec l'ordre de dépense. La nature de budget (inclus /
 * rallonge) reste modifiable tant que la Direction n'a pas tranché : après, c'est sur quoi elle
 * s'est prononcée.
 */
export function EditItemForm({ item, busy, onCancel, onSave }: {
  item: ItemRow; busy: boolean; onCancel: () => void; onSave: (fd: FormData) => void;
}) {
  const budgetLocked = budgetKindLocked(item);
  const champ = "mt-1 w-full rounded-lg border border-border bg-background px-2.5 py-2 text-base outline-none focus:border-primary/60 sm:text-sm";
  // UN POSTE « MATÉRIEL DU STOCK » ne se décrit que par son libellé et ses précisions : ni montant,
  // ni fournisseur, ni nature de budget — et sa nature ne change plus hors d'un brouillon vierge
  // (`refusChangementNature`). Son matériel se compose dans son propre bloc.
  if (estPosteStock(item)) {
    return (
      <form onSubmit={(e) => { e.preventDefault(); onSave(new FormData(e.currentTarget)); }} className="space-y-2 rounded-xl border border-primary/30 bg-primary/5 p-3">
        <label className="block text-xs">Libellé<input name="label" required defaultValue={item.label} className={champ} /></label>
        <label className="block text-xs">Précisions<input name="notes" defaultValue={item.notes ?? ""} placeholder="Facultatif" className={champ} /></label>
        <div className={RANGEE_ACTIONS}>
          <Button size="sm" type="submit" disabled={busy}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />} Enregistrer</Button>
          <Button size="sm" type="button" variant="outline" onClick={onCancel}>Annuler</Button>
        </div>
      </form>
    );
  }
  return (
    <form onSubmit={(e) => { e.preventDefault(); onSave(new FormData(e.currentTarget)); }} className="space-y-2 rounded-xl border border-primary/30 bg-primary/5 p-3">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="text-xs">
          Nature
          <select name="kind" defaultValue={item.kind} className={champ}>
            {ITEM_KINDS.map((k) => <option key={k} value={k}>{ITEM_KIND_LABELS[k]}</option>)}
          </select>
        </label>
        <label className="text-xs">Libellé<input name="label" required defaultValue={item.label} className={champ} /></label>
        <label className="text-xs">Payé à<input name="supplier" defaultValue={item.supplier ?? ""} placeholder="Organisateur, agence, association…" className={champ} /></label>
        <label className="text-xs">
          Montant estimé (DZD)
          <input name="amountEstimated" type="number" inputMode="decimal" min="0" step="0.01" defaultValue={item.amountEstimated ?? ""} className={`${champ} tabular-nums`} />
        </label>
      </div>
      <label className="block text-xs">Précisions<input name="notes" defaultValue={item.notes ?? ""} placeholder="Facultatif" className={champ} /></label>

      {budgetLocked ? (
        <p className="text-[0.6875rem] text-muted-foreground">
          La Direction a tranché : la nature du budget ({ITEM_BUDGET_KIND_LABELS[item.budgetKind]}) ne change plus —
          c&apos;est sur elle qu&apos;elle s&apos;est prononcée.
        </p>
      ) : (
        <fieldset className="rounded-lg border border-border p-2.5">
          <legend className="px-1 text-xs text-muted-foreground">Ce poste est-il couvert par le budget accordé ?</legend>
          <div className="flex flex-wrap gap-3 text-sm">
            <label className="inline-flex min-h-9 items-center gap-1.5 sm:min-h-0">
              <input type="radio" name="budgetKind" value="INCLUDED" defaultChecked={item.budgetKind === "INCLUDED"} /> Inclus dans le budget accordé
            </label>
            <label className="inline-flex min-h-9 items-center gap-1.5 sm:min-h-0">
              <input type="radio" name="budgetKind" value="ADDITIONAL" defaultChecked={item.budgetKind === "ADDITIONAL"} /> Budget supplémentaire (rallonge)
            </label>
          </div>
        </fieldset>
      )}

      {item.expenseOrderId && (
        <p className="flex items-start gap-1.5 text-[0.6875rem] text-muted-foreground">
          <AlertTriangle className="mt-px h-3 w-3 shrink-0 text-warning" />
          Un ordre de dépense a été émis : le <strong>montant affecté</strong> ne change plus. Le reste se corrige librement.
        </p>
      )}

      <div className={RANGEE_ACTIONS}>
        <Button size="sm" type="submit" disabled={busy}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />} Enregistrer</Button>
        <Button size="sm" type="button" variant="outline" onClick={onCancel}>Annuler</Button>
      </div>
    </form>
  );
}

export function Figure({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: "danger" | "success" }) {
  const cls = tone === "danger" ? "text-destructive" : tone === "success" ? "text-success" : "";
  return (
    <div className="min-w-0 rounded-lg border border-border px-2.5 py-2 sm:px-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`mt-0.5 text-sm font-semibold tabular-nums [overflow-wrap:anywhere] sm:text-base ${cls}`}>{value}</p>
      {hint && <p className="text-[0.6875rem] text-muted-foreground">{hint}</p>}
    </div>
  );
}
