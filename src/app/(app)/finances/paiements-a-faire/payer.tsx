"use client";

import * as React from "react";
import { Loader2, Banknote } from "lucide-react";
import { useFormAction } from "@/components/shared/use-action";
import { settleExpenseOrder } from "@/modules/finances/actions-depenses";
import { Sheet } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { Retour } from "@/components/ui/retour";
import { BoutonDecisif } from "@/components/ui/bouton-decisif";
import { formatCurrency } from "@/lib/utils";
import { BUDGET_CLASSIFY_PROMPT, MODES_REGLEMENT, REFERENCE_MAX, jourAlger, jourFr } from "@/modules/finances/partage";
import type { BudgetChoice, CompteChoice, LigneBanque } from "./orders-table";

/**
 * LE PANNEAU « PAYER » — toujours le même, quel que soit l'ordre (Super Admin, 24/11/2026).
 *
 * Le récapitulatif, puis seulement ce qui a une réponse à donner : le compte (s'il y en a au moins deux, avec son
 * solde), la date (aujourd'hui par défaut, jamais dans le futur), le mode (virement ; espèces pour une remise de
 * caisse, que son écrivain sort toujours en liquide), la référence du virement ou du chèque (facultative), la
 * quittance d'un BV de l'ancien circuit, le budget quand l'ordre n'en a pas — JAMAIS pour une remise, qui n'est pas
 * une dépense. « Marquer payé » règle ; l'annulation passe par la barre d'annulation commune (`annulable`).
 */
export function PayerPanneau({ ligne, comptes, budgets, onClose }: {
  ligne: LigneBanque;
  comptes: CompteChoice[];
  budgets: BudgetChoice[];
  onClose: () => void;
}) {
  const aujourdhui = React.useMemo(() => jourAlger(new Date()), []);
  const choisirCompte = comptes.length >= 2;
  const [compteId, setCompteId] = React.useState(ligne.compteParDefautId ?? comptes[0]?.id ?? "");
  const [date, setDate] = React.useState(aujourdhui);
  const [mode, setMode] = React.useState<string>(ligne.remise ? "CASH" : "BANK_TRANSFER");
  const [reference, setReference] = React.useState("");
  const [categoryId, setCategoryId] = React.useState("");
  const [quittance, setQuittance] = React.useState<File | null>(null);
  const quittanceRequise = Boolean(ligne.bv && !ligne.bv.quittanceJointe);
  const budgetRequis = ligne.needsBudget && !ligne.remise;
  const especes = ligne.remise || mode === "CASH";

  const { action: regler, busy, err, setErr } = useFormAction(settleExpenseOrder, {
    prepare: (fd) => {
      fd.set("id", ligne.id);
      fd.set("date", date);
      fd.set("mode", mode);
      if (reference.trim()) fd.set("reference", reference.trim());
      if (choisirCompte && compteId) fd.set("treasuryAccountId", compteId);
      if (budgetRequis) fd.set("budgetCategoryId", categoryId);
      if (quittance) fd.set("quittance", quittance);
    },
    onOk: onClose,
    succes: `${ligne.beneficiaire} — ${formatCurrency(ligne.montant)} marqué payé.`,
  });

  return (
    <Sheet
      open onClose={() => { if (!busy) { setErr(null); onClose(); } }}
      title={`Payer ${ligne.beneficiaire}`}
      description={`${formatCurrency(ligne.montant)} · ${ligne.objet}`}
      width="md"
    >
      <form action={regler} className="space-y-4">

        {choisirCompte && (
          <fieldset className="space-y-1.5">
            <legend className="mb-1 text-sm font-medium">Payé depuis</legend>
            {comptes.map((c) => (
              <button
                key={c.id} type="button" onClick={() => setCompteId(c.id)} aria-pressed={compteId === c.id}
                className={`flex w-full flex-wrap items-center justify-between gap-1.5 rounded-lg px-3 py-2.5 text-left text-sm ${compteId === c.id ? "border-2 border-primary bg-primary/10" : "border border-border hover:bg-secondary"}`}
              >
                <span className="font-medium">{c.nom}</span>
                <span className={`tabular-nums ${c.solde < ligne.montant ? "text-destructive" : "text-muted-foreground"}`}>{formatCurrency(c.solde)} au {jourFr(c.jourAncrage)}</span>
              </button>
            ))}
          </fieldset>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor={`date-${ligne.id}`}>Date du paiement</Label>
            <Input id={`date-${ligne.id}`} type="date" value={date} max={aujourdhui} required onChange={(e) => setDate(e.target.value)} />
          </div>
          <fieldset className="space-y-1">
            <legend className="mb-1 text-sm font-medium">Mode</legend>
            <div className="flex gap-1.5">
              {MODES_REGLEMENT.map((m) => (
                <button
                  key={m.value} type="button" aria-pressed={mode === m.value} disabled={ligne.remise && m.value !== "CASH"} onClick={() => setMode(m.value)}
                  className={`h-10 flex-1 rounded-lg px-2 text-sm disabled:opacity-40 ${mode === m.value ? "border-2 border-primary bg-primary/10 font-semibold text-primary" : "border border-border hover:bg-secondary"}`}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </fieldset>
        </div>

        {especes && (
          <p className="rounded-lg bg-secondary/60 px-3 py-2 text-xs">
            {ligne.remise
              ? "Remise de caisse : retrait en espèces sur le compte choisi, remis au caissier contre signature du bon de retrait. Pas de budget : elle se justifie par l'état de caisse."
              : "Paiement en espèces : le bénéficiaire signe un reçu, à joindre au dossier comme quittance."}
          </p>
        )}

        <div className="space-y-1">
          <Label htmlFor={`ref-${ligne.id}`}>{especes ? "N° du bon de retrait" : "Référence du virement ou du chèque"} <span className="text-muted-foreground">(facultatif)</span></Label>
          <Input id={`ref-${ligne.id}`} value={reference} maxLength={REFERENCE_MAX} placeholder={especes ? "BR-…" : mode === "CHEQUE" ? "CHQ …" : "VIR-…"} onChange={(e) => setReference(e.target.value)} />
        </div>

        {quittanceRequise && (
          <div className="space-y-1">
            <Label htmlFor={`qt-${ligne.id}`}>Quittance — {ligne.bv?.nature ?? "BV"} payé <span className="text-destructive">*</span></Label>
            <Input id={`qt-${ligne.id}`} type="file" required onChange={(e) => setQuittance(e.target.files?.[0] ?? null)} />
            <p className="text-xs text-muted-foreground">Elle se range sur l&apos;étape « Paiement du BV » du dossier, qui se coche.</p>
          </div>
        )}

        {budgetRequis && (
          <div className="space-y-1">
            <Label htmlFor={`bud-${ligne.id}`}>Budget <span className="text-destructive">*</span></Label>
            <Select id={`bud-${ligne.id}`} value={categoryId} onChange={(e) => setCategoryId(e.target.value)} required>
              <option value="">— Choisir la catégorie —</option>
              {budgets.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
            </Select>
            <p className="text-xs text-muted-foreground">{BUDGET_CLASSIFY_PROMPT}</p>
          </div>
        )}

        <p className="text-xs text-muted-foreground">Justification : <span className="font-semibold text-foreground">{ligne.justification}</span> · Budget : {ligne.budget}</p>
        <Retour ton="erreur">{err}</Retour>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" className="w-full sm:w-auto" disabled={busy} onClick={onClose}>Annuler</Button>
          <BoutonDecisif
            type="submit" className="h-11 w-full sm:h-10 sm:w-auto"
            disabled={busy || (budgetRequis && !categoryId) || (quittanceRequise && !quittance)}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Banknote className="h-4 w-4" />} Marquer payé
          </BoutonDecisif>
        </div>
      </form>
    </Sheet>
  );
}
