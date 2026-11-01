"use client";

import { useActionState } from "react";
import { Wallet } from "lucide-react";
import { BoutonDecisif } from "@/components/ui/bouton-decisif";
import { imputerBudgetMaterielPromo } from "@/lib/actions/promo-budget-actions";

/**
 * LE BUDGET DU DOSSIER (Direction, 27/10 — point 21) : la catégorie du Budget Marketing qui porte ce matériel
 * promotionnel. La Direction Marketing la choisit ; les autres la lisent. Ses BC signés y comptent en engagé, ses
 * ordres fournisseur en consommé. Le serveur refuse une catégorie d'une autre nature, d'un autre exercice ou d'une
 * autre gamme — le refus s'affiche ici, en clair.
 */
export function BudgetPromoCard({ promoMaterialId, actuelle, options, peutImputer }: {
  promoMaterialId: string;
  actuelle: string | null;
  options: { id: string; label: string }[] | null;
  peutImputer: boolean;
}) {
  const [etat, envoyer] = useActionState(imputerBudgetMaterielPromo, undefined);
  return (
    <section className="surface space-y-2 px-4 py-3 text-sm">
      <h2 className="flex items-center gap-1.5 text-[0.9375rem] font-semibold"><Wallet className="h-4 w-4 text-muted-foreground" aria-hidden /> Budget</h2>
      <p className="text-muted-foreground">
        {actuelle
          ? <>Imputé sur <span className="font-medium text-foreground">{actuelle}</span> : les BC signés y comptent en engagé, les ordres fournisseur en consommé.</>
          : "Aucun budget imputé : ce dossier ne pèse encore sur aucune enveloppe."}
      </p>
      {peutImputer && options && (
        <form action={envoyer} className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="promoMaterialId" value={promoMaterialId} />
          <select name="budgetCategoryId" required defaultValue="" aria-label="Catégorie budgétaire"
            className="h-9 min-w-0 max-w-full flex-1 rounded-md border border-border bg-background px-2 text-sm">
            <option value="" disabled>Choisir une catégorie du Budget Marketing…</option>
            {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
          <BoutonDecisif size="sm" confirmation="Imputer ce dossier à ce budget">{actuelle ? "Changer de budget" : "Imputer"}</BoutonDecisif>
        </form>
      )}
      {etat && (etat.ok
        ? <p className="text-success">{etat.message ?? "Imputé."}</p>
        : <p className="text-destructive">{etat.error}</p>)}
    </section>
  );
}
