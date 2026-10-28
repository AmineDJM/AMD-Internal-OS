"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, Trash2 } from "lucide-react";
import { deleteMyValidationRequest } from "@/lib/actions/validation-actions";
import { Button } from "@/components/ui/button";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";
import { BoutonDecisif } from "@/components/ui/bouton-decisif";

/**
 * RETIRER SA DEMANDE — tant que personne ne s'est prononcé.
 *
 * Le bouton reste VISIBLE quand le retrait n'est plus possible, mais désactivé et expliqué : le
 * faire disparaître aurait laissé chercher « où est passé le bouton ? », alors que la vraie
 * réponse est « quelqu'un a déjà répondu, et sa réponse ne s'efface pas ».
 */
export function WithdrawRequestButton({ id, reference, canWithdraw, abandon = false }: {
  id: string; reference: string; canWithdraw: boolean;
  /** Une demande qui a un HISTORIQUE (renvoyée, ou déjà resoumise) s'abandonne : close, pas effacée. */
  abandon?: boolean;
}) {
  const router = useRouter();
  const { rafraichir } = useRafraichir();
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  if (!canWithdraw) {
    return (
      <span
        className="text-xs text-muted-foreground"
        title="La demande est tranchée : l'accord ou le refus d'un tiers ne s'efface pas."
      >
        Retrait impossible — déjà tranchée
      </span>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <BoutonDecisif
        variant="outline"
        size="sm"
        className="text-destructive"
        disabled={busy}
        confirmation={abandon ? `retirer ${reference} (close, validateurs prévenus)` : `retirer ${reference} de la file des validateurs`}
        onClick={async () => {
          setBusy(true); setErr(null);
          const fd = new FormData();
          fd.set("id", id);
          try {
            const r = await deleteMyValidationRequest(fd);
            if (r.ok) { if (abandon) rafraichir(); else router.push("/validations"); }
            else setErr(r.error ?? "Retrait impossible.");
          } catch {
            setErr(actionFailureMessage("THROWN"));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />} Retirer ma demande
      </BoutonDecisif>
      {err && <p role="alert" className="max-w-xs text-right text-xs text-destructive">{err}</p>}
    </div>
  );
}
