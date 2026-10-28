"use client";

import * as React from "react";
import { Loader2, CalendarClock, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Retour } from "@/components/ui/retour";
import { useAction } from "@/components/shared/use-action";
import { proposeHrMeeting, confirmHrMeeting } from "@/modules/rh/actions-documents";
import { formatAlgiers } from "@/lib/calendar-tz";

/**
 * Négociation de la date d'une ENTREVUE RH, côté demandeur ou côté RH :
 * la partie qui n'a pas proposé la dernière date peut l'accepter ou contre-proposer.
 */
export function MeetingControls({
  requestId, meetingAt, proposedByMe, confirmed, canPropose, otherParty,
}: {
  requestId: string;
  meetingAt: string | null;
  proposedByMe: boolean;
  confirmed: boolean;
  /** Peut lancer une 1ʳᵉ proposition (RH : oui ; employé : seulement en contre-proposition). */
  canPropose: boolean;
  /** Libellé de l'autre partie (« les RH » ou le nom de l'employé). */
  otherParty: string;
}) {
  const { busy, err, run } = useAction();
  const [counter, setCounter] = React.useState(false);

  const whenLabel = meetingAt
    ? formatAlgiers(new Date(meetingAt), { weekday: "long", day: "2-digit", month: "long", hour: "2-digit", minute: "2-digit" })
    : null;

  async function accept() {
    const fd = new FormData(); fd.set("id", requestId);
    await run(async () => {
      const r = await confirmHrMeeting(fd);
      return r.ok ? r : { ...r, error: r.error ?? "La date n'a pas été acceptée." };
    });
  }

  if (confirmed && whenLabel) {
    return (
      <p className="flex items-center gap-1.5 rounded-lg bg-success/10 px-2.5 py-1.5 text-xs font-medium text-success">
        <Check className="h-3.5 w-3.5" /> Entrevue confirmée : {whenLabel} (ajoutée au calendrier)
      </p>
    );
  }

  return (
    <div className="space-y-2 rounded-lg border border-border bg-muted/20 p-2.5">
      {whenLabel ? (
        proposedByMe ? (
          <p className="text-xs text-muted-foreground"><CalendarClock className="mr-1 inline h-3.5 w-3.5" /> Vous avez proposé : <span className="font-medium text-foreground">{whenLabel}</span> — en attente de réponse de {otherParty}.</p>
        ) : (
          <div className="space-y-2">
            <p className="text-xs"><CalendarClock className="mr-1 inline h-3.5 w-3.5" /> Date proposée par {otherParty} : <span className="font-medium">{whenLabel}</span></p>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={accept} disabled={busy}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Accepter cette date</Button>
              <Button size="sm" variant="outline" onClick={() => setCounter((v) => !v)} disabled={busy}>Proposer une autre date</Button>
            </div>
          </div>
        )
      ) : (
        canPropose
          ? <p className="text-xs text-muted-foreground">Proposez une date et une heure pour l&apos;entrevue.</p>
          : <p className="text-xs text-muted-foreground">En attente d&apos;une proposition de date par {otherParty}.</p>
      )}

      {(counter || (!whenLabel && canPropose)) && (
        <form
          action={async (fd) => {
            fd.set("id", requestId);
            const proposer = async () => {
              const r = await proposeHrMeeting(fd);
              return r.ok ? r : { ...r, error: r.error ?? "La proposition de date n'a pas été envoyée." };
            };
            await run(proposer, () => setCounter(false));
          }}
          className="flex flex-wrap items-end gap-2"
        >
          <div className="w-full space-y-1 sm:w-auto">
            <Label htmlFor={`meet-${requestId}`}>Date et heure (Alger)</Label>
            <Input id={`meet-${requestId}`} name="meetingAt" type="datetime-local" required />
          </div>
          <Button type="submit" size="sm" disabled={busy}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Envoyer la proposition</Button>
        </form>
      )}
      <Retour ton="erreur" className="py-1 text-xs">{err}</Retour>
    </div>
  );
}
