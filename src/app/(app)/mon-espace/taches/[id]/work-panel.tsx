"use client";

import * as React from "react";
import { actionFailureMessage } from "@/lib/action-outcome";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { Check, X, Loader2, RotateCcw } from "lucide-react";
import { respondTaskRequest, submitTaskWork, reopenTaskWork } from "@/lib/actions/task-actions";
import { submitLabel } from "@/lib/tasks/request-flow";
import { Button } from "@/components/ui/button";
import { Label, Textarea } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * ACCEPTER, FAIRE, VALIDER — les trois seuls gestes de la personne à qui l'on demande.
 *
 * Le refus s'accompagne d'un motif FACULTATIF. Rendre le motif obligatoire ne produit pas de
 * meilleures raisons : il produit des « non » et des « pas dispo », et transforme un refus
 * légitime en formalité désagréable. Le champ est là, la case n'est pas verrouillée.
 *
 * Le travail validé reste modifiable, et le bouton le dit : « Valider mon travail » devient
 * « Mettre à jour mon travail ». Le demandeur est prévenu à chaque fois — c'est ce qui rend la
 * modification honnête plutôt que discrète.
 */
export function TaskWorkPanel({
  id, status, note, canRespond, canWork,
}: {
  id: string;
  status: string;
  note: string | null;
  canRespond: boolean;
  canWork: boolean;
}) {
  const { enCours, rafraichir } = useRafraichir();
  const [declining, setDeclining] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  const run = async (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setBusy(true); setErr(null);
    try {
      const r = await fn();
      if (r.ok) rafraichir(); else setErr(r.error ?? "La tâche n'a pas été mise à jour.");
    } catch {
      setErr(actionFailureMessage("THROWN"));
    } finally {
      setBusy(false);
    }
  };

  if (canRespond) {
    return (
      <Card>
        <CardHeader><CardTitle>Acceptez-vous cette demande&nbsp;?</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {!declining ? (
            <>
              <p className="text-sm text-muted-foreground">
                En acceptant, vous entrez directement dans le travail — pas d&apos;étape
                intermédiaire. Vous déposerez ici les pièces, puis vous validerez.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button" disabled={busy || enCours} className="flex-1 sm:flex-none"
                  onClick={() => run(() => { const fd = new FormData(); fd.set("id", id); fd.set("accept", "1"); return respondTaskRequest(fd); })}
                >
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Accepter
                </Button>
                <Button type="button" variant="outline" disabled={busy || enCours} className="flex-1 sm:flex-none" onClick={() => setDeclining(true)}>
                  <X className="h-4 w-4" /> Refuser
                </Button>
              </div>
            </>
          ) : (
            <form
              action={async (fd) => {
                fd.set("id", id); fd.set("accept", "0");
                await run(() => respondTaskRequest(fd));
              }}
              className="space-y-3"
            >
              <div className="space-y-1.5">
                <Label htmlFor="decline-reason">Motif du refus (facultatif)</Label>
                <Textarea id="decline-reason" name="reason" rows={3} placeholder="ex. Je suis en congé la semaine prochaine" />
                <p className="text-xs text-muted-foreground">
                  Vous pouvez refuser sans vous justifier. Une ligne évite souvent un appel.
                </p>
              </div>
              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:flex-wrap">
                <Button type="submit" variant="destructive" disabled={busy || enCours}>
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />} Confirmer le refus
                </Button>
                <Button type="button" variant="outline" disabled={busy || enCours} onClick={() => setDeclining(false)}>Annuler</Button>
              </div>
            </form>
          )}
          {err && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>}
        </CardContent>
      </Card>
    );
  }

  if (status === "DECLINED") {
    return (
      <Card>
        <CardContent className="p-4 text-sm text-muted-foreground">
          Cette demande a été <strong className="text-foreground">refusée</strong>. Le motif, s&apos;il
          y en a un, figure dans le fil ci-contre.
        </CardContent>
      </Card>
    );
  }

  if (!canWork) {
    return (
      <Card>
        <CardContent className="p-4 text-sm text-muted-foreground">
          {status === "REQUESTED"
            ? "En attente de la réponse de la personne à qui vous l'avez demandée."
            : "Vous suivez cette tâche : le compte rendu sera visible ici dès qu'il sera validé."}
          {note && <p className="mt-2 whitespace-pre-wrap text-foreground">{note}</p>}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader><CardTitle>Mon travail</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <form
          action={async (fd) => { fd.set("id", id); await run(() => submitTaskWork(fd)); }}
          className="space-y-3"
        >
          <div className="space-y-1.5">
            <Label htmlFor="work-note">Compte rendu (facultatif)</Label>
            <Textarea id="work-note" name="note" rows={4} defaultValue={note ?? ""} placeholder="Ce qui a été fait, ce qui reste, où sont les pièces…" />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={busy || enCours} className="w-full sm:w-auto">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} {submitLabel({ status })}
            </Button>
            {status === "DONE" && (
              <Button
                type="button" variant="outline" disabled={busy || enCours}
                onClick={() => run(() => { const fd = new FormData(); fd.set("id", id); return reopenTaskWork(fd); })}
              >
                <RotateCcw className="h-4 w-4" /> Reprendre
              </Button>
            )}
            <span className="text-xs text-muted-foreground">
              {status === "DONE"
                ? "Validé — vous pouvez encore modifier le compte rendu et les pièces."
                : "Vous pourrez modifier après validation : rien ne se ferme."}
            </span>
          </div>
        </form>
        {err && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>}
      </CardContent>
    </Card>
  );
}
