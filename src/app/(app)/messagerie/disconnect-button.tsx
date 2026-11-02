"use client";

import * as React from "react";
import { LogOut, Loader2 } from "lucide-react";
import { disconnectMicrosoftMail } from "@/lib/actions/microsoft-mail-actions";
import { useAction } from "@/components/shared/use-action";

/**
 * SE DÉCONNECTER DOIT VRAIMENT DÉCONNECTER : les jetons sont EFFACÉS, pas désactivés. On confirme,
 * parce qu'un clic malheureux obligerait à repasser par Microsoft.
 */
export function DisconnectButton() {
  // Le bouton n'a pas de place où parler : un refus part en avis flottant.
  const { busy, run } = useAction({ signalerErreurs: true });

  const go = async () => {
    await run(() => disconnectMicrosoftMail(), undefined, {
      confirmer: "Déconnecter votre boîte Microsoft ? Vos e-mails restent chez Microsoft ; seule la liaison est coupée.",
    });
  };

  return (
    <button
      type="button" onClick={() => void go()} disabled={busy}
      className="inline-flex items-center gap-1.5 rounded-lg border border-input px-2.5 py-2 text-sm font-medium text-muted-foreground hover:bg-secondary disabled:opacity-60"
    >
      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogOut className="h-4 w-4" />} Déconnecter
    </button>
  );
}
