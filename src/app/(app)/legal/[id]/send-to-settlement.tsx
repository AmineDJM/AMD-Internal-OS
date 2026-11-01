"use client";

import * as React from "react";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";
import { AlertCircle, Loader2, Send } from "lucide-react";
import { BoutonDecisif } from "@/components/ui/bouton-decisif";
import { sendLegalInvoiceToSettlement } from "@/lib/actions/legal-actions";
import { formatCurrency } from "@/lib/utils";

/**
 * ENVOYER LA FACTURE AU RÈGLEMENT — un clic, une confirmation, et le circuit fait le reste :
 * le centre de paiement autorise TOUT paiement, quel que soit son montant (décision de la
 * Direction, 09/2026), puis Règlements à effectuer. Le bouton disparaît une fois la facture
 * partie — l'état du règlement prend sa place dans la chaîne.
 *
 * « Dès 50 000 DZD » était écrit ici, et c'était FAUX depuis que le centre voit tout : la phrase
 * qu'une personne lit AVANT de cliquer promettait qu'une petite facture partirait directement aux
 * Finances. Elle ne le fait pas, et la personne attendait un règlement qui attendait, lui, le
 * centre (§118.148).
 */
/**
 * `renvoi` : l'ordre précédent a été refusé par le centre, ou annulé — il ne paiera jamais, et la
 * facture repart (§118.185, audit 360° I8). Le bouton le dit, pour qu'on sache qu'on ne double rien.
 */
export function SendToSettlementButton({ id, amount, renvoi = false }: { id: string; amount: number | null; renvoi?: boolean }) {
  const { rafraichir } = useRafraichir();
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  const run = async () => {
    setBusy(true); setErr(null);
    const f = new FormData();
    f.set("id", id);
    try {
      const r = await sendLegalInvoiceToSettlement(f);
      if (r.ok) rafraichir(); else setErr(r.error ?? "L'envoi a échoué.");
    } catch {
      setErr(actionFailureMessage("THROWN"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      {err && (
        <p className="flex items-center gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0" /> {err}
        </p>
      )}
      <BoutonDecisif
        size="sm" variant="primary" onClick={run} disabled={busy}
        confirmation={`${renvoi ? "renvoyer" : "envoyer"} ${amount != null ? formatCurrency(amount) : "cette facture"} au règlement`}
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} {renvoi ? "Renvoyer au règlement" : "Envoyer au règlement"}
      </BoutonDecisif>
      <p className="text-xs text-muted-foreground">
        Le centre de paiement l&apos;autorisera avant que les Finances ne la règlent.{renvoi ? " L’ordre précédent ne paiera pas." : ""}
      </p>
    </div>
  );
}
