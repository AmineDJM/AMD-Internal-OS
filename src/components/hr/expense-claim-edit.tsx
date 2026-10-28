"use client";

import * as React from "react";
import { AlertCircle, Clock, Loader2, Lock, Pencil, Unlock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { ExpenseClaimFields } from "./expense-claim-form";
import { canEditExpenseClaim, expenseEditLabel, type ExpenseEditState } from "@/lib/hr/expense-claim";
import { updateExpenseClaim } from "@/lib/actions/hr-document-actions";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";

/**
 * CORRIGER SA NOTE DE FRAIS — pendant quinze minutes, ou après si les RH ont rouvert.
 *
 * ── POURQUOI LE COMPTE À REBOURS VIT DANS LE NAVIGATEUR ─────────────────────────────────────
 *
 * Le serveur rend une page à un instant donné ; l'onglet, lui, reste ouvert. Sans horloge
 * locale, la personne verrait « modifiable encore 14 minutes » une demi-heure plus tard, et le
 * refus tomberait au moment de l'envoi — après avoir tout retapé. On recalcule donc chaque
 * minute, à partir de la MÊME fonction que le serveur : deux règles différentes finiraient par
 * afficher un bouton que le serveur refuse.
 *
 * L'écran ne fait qu'éviter de proposer une porte fermée ; la garde qui compte est côté serveur
 * (§118-7), et c'est elle qui répond si l'on force l'appel.
 */
export function ExpenseClaimEdit({
  id, state, month, amount, details,
}: {
  id: string;
  state: ExpenseEditState;
  month: string | null;
  amount: number | null;
  details: string | null;
}) {
  const { rafraichir } = useRafraichir();
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [now, setNow] = React.useState<Date>(() => new Date());

  // Une fois par minute : c'est la granularité de ce qu'on affiche, et c'est suffisant pour que
  // le bouton disparaisse au bon moment sans faire battre la page.
  React.useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);

  const verdict = canEditExpenseClaim(state, now);
  const texte = expenseEditLabel(verdict);

  const submit = async (fd: FormData) => {
    setBusy(true); setErr(null);
    fd.set("id", id);
    let r: Awaited<ReturnType<typeof updateExpenseClaim>>;
    try {
      r = await updateExpenseClaim(fd);
    } catch {
      setErr(actionFailureMessage("THROWN"));
      return;
    } finally {
      setBusy(false);
    }
    if (r.ok) { setOpen(false); rafraichir(); } else setErr(r.error ?? "La modification a échoué.");
  };

  return (
    <div className="mt-1 flex flex-wrap items-center gap-2">
      <span className={`inline-flex items-center gap-1 text-[0.6875rem] ${verdict.allowed ? "text-primary" : "text-muted-foreground"}`}>
        {verdict.reason === "UNLOCKED" ? <Unlock className="h-3 w-3" /> : verdict.allowed ? <Clock className="h-3 w-3" /> : <Lock className="h-3 w-3" />}
        {texte}
      </span>
      {verdict.allowed && (
        <Button variant="outline" size="sm" onClick={() => { setErr(null); setOpen(true); }}>
          <Pencil className="h-3.5 w-3.5" /> Modifier
        </Button>
      )}

      <Sheet
        open={open}
        onClose={() => !busy && setOpen(false)}
        title="Corriger la note de frais"
        description="C'est la même demande qui change : elle garde ses pièces, son fil et sa place dans votre historique."
        width="md"
      >
        <form action={submit} className="space-y-4">
          <ExpenseClaimFields
            defaultMonth={month}
            defaultAmount={amount}
            defaultDetails={details}
            filesRequired={false}
            filesHint="Les pièces déjà déposées restent en place. Ajoutez-en une seulement si vous voulez compléter ou remplacer — pour retirer l'ancienne, servez-vous de la liste des pièces."
          />

          {err && (
            <div className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> <span className="min-w-0">{err}</span>
            </div>
          )}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" className="w-full sm:w-auto" onClick={() => setOpen(false)} disabled={busy}>Annuler</Button>
            <Button type="submit" className="w-full sm:w-auto" disabled={busy}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />} Enregistrer la correction
            </Button>
          </div>
        </form>
      </Sheet>
    </div>
  );
}
