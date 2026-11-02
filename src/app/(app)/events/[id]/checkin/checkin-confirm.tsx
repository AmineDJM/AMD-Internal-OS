"use client";

import * as React from "react";
import Link from "next/link";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { checkInByToken } from "@/modules/ad-pro/actions-evenements";

/** Marque automatiquement le participant « présent » au scan du QR. */
export function CheckinConfirm({ token, name, eventId }: { token: string; name: string; eventId: string }) {
  const [state, setState] = React.useState<"loading" | "ok" | "error">("loading");
  React.useEffect(() => {
    const fd = new FormData(); fd.set("token", token);
    checkInByToken(fd).then((r) => setState(r.ok ? "ok" : "error"));
  }, [token]);

  return (
    // Utilisé debout, téléphone en main, à l'entrée : verdict en grand, et un vrai bouton pleine largeur pour repartir.
    <div className="surface flex flex-col items-center gap-3 p-6 text-center sm:p-8" aria-live="polite">
      {state === "loading" && <><Loader2 className="h-12 w-12 animate-spin text-muted-foreground" /><p className="text-base">Enregistrement de la présence…</p></>}
      {state === "ok" && (
        <>
          <CheckCircle2 className="h-16 w-16 text-success sm:h-14 sm:w-14" />
          <p className="max-w-full break-words text-2xl font-bold sm:text-xl">{name}</p>
          <p className="text-lg font-medium text-success sm:text-base">Présence enregistrée ✓</p>
        </>
      )}
      {state === "error" && (<><XCircle className="h-16 w-16 text-destructive sm:h-14 sm:w-14" /><p className="text-base font-medium">Impossible d'enregistrer la présence.</p></>)}
      <Link href={`/events/${eventId}`} className="mt-3 inline-flex h-12 w-full items-center justify-center rounded-lg border border-border px-4 text-base font-medium text-primary transition-colors hover:bg-secondary sm:h-10 sm:w-auto sm:text-sm">Retour à l'événement</Link>
    </div>
  );
}
