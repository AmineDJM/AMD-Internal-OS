"use client";

import * as React from "react";
import { actionFailureMessage } from "@/lib/action-outcome";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { MessageSquare, Send, Loader2 } from "lucide-react";
import { addTaskComment } from "@/lib/actions/task-actions";
import { commentsSummary } from "@/lib/tasks/request-flow";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Avatar } from "@/components/ui/avatar";
import { formatDateTime } from "@/lib/utils";

export interface TaskCommentItem {
  id: string;
  author: string;
  body: string;
  createdAt: string;
  mine: boolean;
}

/**
 * LE FIL DE LA TÂCHE — l'aller-retour entre celui qui demande et celui qui fait.
 *
 * Une demande se précise presque toujours : « pour quelle heure ? », « le bureau était fermé, je
 * repasse demain », « la facture est jointe ». Sans cet endroit, l'échange part en messagerie et
 * se sépare de la tâche : trois semaines plus tard, elle dit « validée » et personne ne retrouve
 * pourquoi elle a pris dix jours.
 *
 * **Facultatif, et il le reste** : une tâche sans un seul message est une tâche normale. Le bloc
 * n'affiche donc ni compteur alarmant ni invitation insistante — juste une zone de saisie.
 *
 * Rien ne se modifie ni ne s'efface : un message est la trace de l'échange. Une correction
 * silencieuse qui remplacerait la question à laquelle l'autre a répondu rendrait le fil illisible.
 */
export function TaskComments({ id, items, canWrite }: { id: string; items: TaskCommentItem[]; canWrite: boolean }) {
  const { enCours, rafraichir } = useRafraichir();
  const [body, setBody] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  const send = async () => {
    const text = body.trim();
    if (!text || busy || enCours) return;
    setBusy(true); setErr(null);
    const fd = new FormData();
    fd.set("id", id);
    fd.set("body", text);
    try {
      const r = await addTaskComment(fd);
      if (r.ok) { setBody(""); rafraichir(); }
      else setErr(r.error ?? "Échec de l'envoi.");
    } catch {
      setErr(actionFailureMessage("THROWN"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MessageSquare className="h-4 w-4" /> Échanges
          <span className="text-sm font-normal text-muted-foreground">{commentsSummary(items.length)}</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {items.length > 0 && (
          <ul className="space-y-3">
            {items.map((c) => (
              <li key={c.id} className="flex gap-2.5">
                <Avatar name={c.author} size="sm" className="mt-0.5 shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-baseline gap-2">
                    <span className="text-sm font-medium">{c.mine ? "Vous" : c.author}</span>
                    <span className="text-[0.6875rem] text-muted-foreground">{formatDateTime(c.createdAt)}</span>
                  </p>
                  <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{c.body}</p>
                </div>
              </li>
            ))}
          </ul>
        )}

        {canWrite ? (
          <div className="space-y-2">
            <textarea
              value={body}
              onChange={(e) => { setBody(e.target.value); setErr(null); }}
              onKeyDown={(e) => {
                // Entrée envoie, Maj+Entrée passe à la ligne — le geste de toutes les messageries.
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); }
              }}
              rows={2}
              placeholder="Une précision, une question, un point d'avancement…"
              className="w-full resize-none rounded-lg border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">Facultatif — tout le cercle de la tâche le lit.</span>
              <Button type="button" size="sm" onClick={() => void send()} disabled={busy || enCours || body.trim().length === 0}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Envoyer
              </Button>
            </div>
            {err && <p className="text-xs text-destructive">{err}</p>}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">Vous suivez cette tâche en lecture.</p>
        )}
      </CardContent>
    </Card>
  );
}
