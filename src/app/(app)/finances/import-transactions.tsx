"use client";

import * as React from "react";
import { useFormState } from "react-dom";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { Upload, Loader2, AlertCircle, CheckCircle2 } from "lucide-react";
import { importTransactions, type ResultatImport } from "@/lib/actions/finance-actions";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/input";

const SAMPLE = `date,direction,category,label,amount,method,account,counterparty
2026-06-01,IN,RECETTE,Vente PCH juin,1250000,BANK_TRANSFER,Banque,PCH Alger
2026-06-03,OUT,LOYER,Loyer bureau juin,90000,BANK_TRANSFER,Banque,Propriétaire
2026-06-04,OUT,VOYAGE,Mission Oran,35000,CASH,Caisse,Délégué`;

export function ImportTransactionsButton() {
  const { rafraichir } = useRafraichir();
  const [open, setOpen] = React.useState(false);
  const [state, formAction] = useFormState<ResultatImport | undefined, FormData>(importTransactions, undefined);
  const [pending, setPending] = React.useState(false);
  // Le bilan de CET import, remis à zéro à chaque ouverture : le bilan d'un import précédent ne
  // doit pas se lire sous un texte neuf.
  const [bilan, setBilan] = React.useState<ResultatImport | undefined>(undefined);
  // Le texte affiché vient d'être importé : un second clic l'importerait une seconde fois.
  const [dejaImporte, setDejaImporte] = React.useState(false);

  React.useEffect(() => {
    if (!state) return;
    setPending(false);
    setBilan(state);
    if (state.ok) {
      setDejaImporte(true);
      rafraichir();
      // Tout est passé : on referme, le temps de lire le compte. Une ligne écartée garde le panneau
      // ouvert — la personne doit pouvoir lire laquelle, et pourquoi.
      if (!state.ecartees) setTimeout(() => setOpen(false), 1500);
    }
  }, [state, rafraichir]);

  const ouvrir = () => { setBilan(undefined); setDejaImporte(false); setOpen(true); };

  return (
    <>
      <Button variant="outline" onClick={ouvrir}><Upload className="h-4 w-4" /> Importer CSV</Button>
      <Sheet open={open} onClose={() => setOpen(false)} title="Importer des écritures" description="Collez vos données CSV (1ʳᵉ ligne = en-tête).">
        <form action={(fd) => { setPending(true); formAction(fd); }} className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Colonnes&nbsp;: <code className="[overflow-wrap:anywhere]">date, direction (IN/OUT), category, label, amount, method, account, counterparty</code>
            {" "}— séparées par « , » ou « ; », date au format AAAA-MM-JJ ou JJ/MM/AAAA.
          </p>
          <Textarea name="csv" defaultValue={SAMPLE} onChange={() => setDejaImporte(false)} className="min-h-[220px] font-mono text-xs" />
          {bilan && !bilan.ok && <div className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> {bilan.error}</div>}
          {/* Le bilan RENDU par l'action — le nombre réellement écrit, et chaque ligne écartée avec sa raison. */}
          {bilan?.ok && (
            <div className={`flex items-start gap-2 rounded-lg px-3 py-2 text-sm ${bilan.ecartees ? "bg-amber-500/10 text-amber-700 dark:text-amber-400" : "bg-success/10 text-success"}`}>
              {bilan.ecartees ? <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> : <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />} {bilan.message ?? "Import terminé."}
            </div>
          )}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" className="w-full sm:w-auto" onClick={() => setOpen(false)}>Fermer</Button>
            <Button type="submit" className="w-full sm:w-auto" disabled={pending || dejaImporte}>{pending && <Loader2 className="h-4 w-4 animate-spin" />} {dejaImporte ? "Importé" : "Importer"}</Button>
          </div>
        </form>
      </Sheet>
    </>
  );
}
