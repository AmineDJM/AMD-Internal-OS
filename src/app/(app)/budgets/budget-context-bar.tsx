"use client";

import * as React from "react";
import { useRouter, usePathname } from "next/navigation";
import { Select } from "@/components/ui/input";
import type { BudgetEnvelopeOption } from "@/lib/queries/budget";
import { formatDate } from "@/lib/utils";
import { rememberBudgetEnvelope } from "@/lib/actions/budget-scope-actions";
import { nomAvecSociete } from "@/lib/budget/enveloppe-cle";

/**
 * Barre de contexte des Budgets : **quelle enveloppe** et **quelle période**. Rien d'autre.
 *
 * Avant, cette barre portait aussi le budget total, son réglage, l'export et l'édition de
 * l'enveloppe — cinq décisions au même endroit. Les réglages sont partis dans leur onglet ;
 * il ne reste ici que ce qui change ce qu'on REGARDE. La période reste dépliable : par défaut
 * on affiche celle de l'enveloppe, qui est la bonne réponse dans 9 cas sur 10.
 */
export function BudgetContextBar({
  envelopes, currentId, from, to,
}: {
  envelopes: BudgetEnvelopeOption[];
  currentId: string;
  from: string;
  to: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = React.useState(false);
  const [f, setF] = React.useState(from.slice(0, 10));
  const [t, setT] = React.useState(to.slice(0, 10));

  const go = (params: Record<string, string>) => {
    const sp = new URLSearchParams({ env: currentId, ...params });
    router.push(`${pathname}?${sp.toString()}`);
  };

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
      {envelopes.length > 1 ? (
        <Select
          value={currentId}
          onChange={(e) => {
            const id = e.target.value;
            // Mémorisé AVANT de naviguer : ainsi le choix survit au changement d'onglet, au
            // clic sur « Budgets » dans le menu et à la réouverture de l'application.
            void rememberBudgetEnvelope(id);
            router.push(`${pathname}?env=${id}`);
          }}
          className="h-10 w-full font-medium sm:h-9 sm:w-auto sm:min-w-[14rem]"
          aria-label="Enveloppe budgétaire"
        >
          {envelopes.map((en) => (
            <option key={en.id} value={en.id}>{nomAvecSociete(en.name, en.societe)}{en.isActive ? "" : " (archivée)"}</option>
          ))}
        </Select>
      ) : (
        <span className="font-medium">{envelopes[0] ? nomAvecSociete(envelopes[0].name, envelopes[0].societe) : null}</span>
      )}

      <button
        type="button" onClick={() => setOpen((o) => !o)}
        className="min-h-9 rounded-lg px-2 py-1 text-muted-foreground tabular-nums transition hover:bg-secondary hover:text-foreground sm:min-h-0"
      >
        {formatDate(from)} → {formatDate(to)}
      </button>

      {open && (
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          <input type="date" value={f} onChange={(e) => setF(e.target.value)} className="h-10 min-w-0 flex-1 rounded-lg border border-border bg-background px-2 text-base sm:h-9 sm:flex-none sm:text-sm" aria-label="Du" />
          <input type="date" value={t} onChange={(e) => setT(e.target.value)} className="h-10 min-w-0 flex-1 rounded-lg border border-border bg-background px-2 text-base sm:h-9 sm:flex-none sm:text-sm" aria-label="Au" />
          <button type="button" onClick={() => { setOpen(false); go({ from: f, to: t }); }} className="h-10 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground sm:h-9">
            Appliquer
          </button>
          <button type="button" onClick={() => { setOpen(false); go({}); }} className="min-h-9 text-xs text-muted-foreground underline-offset-2 hover:underline sm:min-h-0">
            Période de l&apos;enveloppe
          </button>
        </div>
      )}
    </div>
  );
}
