"use client";

import * as React from "react";
import { Loader2, Send, Check, PlayCircle, CheckCircle2, Archive, AlertCircle, Megaphone, XCircle, RotateCw } from "lucide-react";
import {
  updateDirectiveStatus, postDirectiveMessage, publishDirective, rejectDirective, resendDirective,
} from "@/lib/actions/directive-actions";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { useAction } from "@/components/shared/use-action";


const set = (id: string, status: string) => { const fd = new FormData(); fd.set("id", id); fd.set("status", status); return updateDirectiveStatus(fd); };

export function StatusActions({ id, status, canManage }: { id: string; status: string; canManage: boolean }) {
  const { saving, err, run } = useAction();
  const done = status === "DONE" || status === "ARCHIVED";
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {status === "OPEN" && (
          <Button size="sm" variant="outline" disabled={saving} onClick={() => run(() => set(id, "ACKNOWLEDGED"))}><Check className="h-4 w-4" /> Accuser réception</Button>
        )}
        {(status === "OPEN" || status === "ACKNOWLEDGED") && (
          <Button size="sm" variant="outline" disabled={saving} onClick={() => run(() => set(id, "IN_PROGRESS"))}><PlayCircle className="h-4 w-4" /> En cours</Button>
        )}
        {!done && (
          <Button size="sm" disabled={saving} onClick={() => run(() => set(id, "DONE"))}><CheckCircle2 className="h-4 w-4" /> Marquer traité</Button>
        )}
        {canManage && status !== "ARCHIVED" && (
          <Button size="sm" variant="ghost" disabled={saving} onClick={() => run(() => set(id, "ARCHIVED"))}><Archive className="h-4 w-4" /> Archiver</Button>
        )}
        {saving && <Loader2 className="h-4 w-4 animate-spin self-center text-muted-foreground" />}
      </div>
      {err && <div className="flex items-center gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"><AlertCircle className="h-4 w-4" /> {err}</div>}
    </div>
  );
}

/**
 * LA PORTE DE PUBLICATION — le geste réservé à la direction générale.
 *
 * Publier ENVOIE : les deux ne se séparent pas, sinon il resterait des notes « approuvées » que
 * personne n'a reçues. Le refus, lui, exige un motif : sans lui, l'auteur ne sait pas quoi
 * corriger et représente la même note.
 */
export function PublishPanel({ id, recipientCount, popup }: { id: string; recipientCount: number; popup: boolean }) {
  const { saving, err, run } = useAction();
  const [refus, setRefus] = React.useState(false);
  const [note, setNote] = React.useState("");

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Cette directive attend votre accord. À la publication, elle partira à{" "}
        <strong className="text-foreground">{recipientCount} personne{recipientCount > 1 ? "s" : ""}</strong>
        {popup ? " en pop-up plein écran" : " par notification"}. Ce qui a été lu ne se rattrape pas.
      </p>
      {!refus ? (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={saving} onClick={() => run(() => { const fd = new FormData(); fd.set("id", id); return publishDirective(fd); })}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Megaphone className="h-4 w-4" />} Publier et envoyer
          </Button>
          <Button size="sm" variant="outline" disabled={saving} onClick={() => setRefus(true)}>
            <XCircle className="h-4 w-4" /> Refuser
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          <Textarea
            value={note} onChange={(e) => setNote(e.target.value)}
            placeholder="Pourquoi cette note ne part pas — ce que l'auteur doit corriger."
            className="min-h-[70px]"
          />
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm" variant="destructive" disabled={saving || !note.trim()}
              onClick={() => run(() => { const fd = new FormData(); fd.set("id", id); fd.set("note", note); return rejectDirective(fd); })}
            >
              {saving && <Loader2 className="h-4 w-4 animate-spin" />} Confirmer le refus
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setRefus(false)}>Annuler</Button>
          </div>
        </div>
      )}
      {err && <div className="flex items-center gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"><AlertCircle className="h-4 w-4" /> {err}</div>}
    </div>
  );
}

/** RENVOYER la même note à la même portée — pour ce qui n'a pas été lu. */
export function ResendButton({ id, hint }: { id: string; hint: string }) {
  const { saving, err, run } = useAction();
  const [done, setDone] = React.useState<string | null>(null);
  return (
    <div className="space-y-2">
      <Button
        size="sm" variant="outline" disabled={saving}
        onClick={() => run(async () => {
          const fd = new FormData(); fd.set("id", id);
          const r = await resendDirective(fd);
          if (r.ok) setDone(r.message ?? "Renvoyée.");
          return r;
        })}
      >
        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCw className="h-4 w-4" />} Renvoyer
      </Button>
      <p className="text-xs text-muted-foreground">{done ?? hint}</p>
      {err && <div className="flex items-center gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"><AlertCircle className="h-4 w-4" /> {err}</div>}
    </div>
  );
}

export function MessageForm({ id }: { id: string }) {
  const { saving, err, run } = useAction();
  const ref = React.useRef<HTMLFormElement>(null);
  return (
    <form
      ref={ref}
      action={(fd) => { fd.set("id", id); run(() => postDirectiveMessage(fd), () => ref.current?.reset()); }}
      className="space-y-2"
    >
      <Textarea name="body" required placeholder="Votre retour, une précision, une question…" className="min-h-[70px]" />
      {err && <div className="flex items-center gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"><AlertCircle className="h-4 w-4" /> {err}</div>}
      <Button type="submit" size="sm" disabled={saving} className="w-full sm:w-auto">{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Répondre</Button>
    </form>
  );
}
