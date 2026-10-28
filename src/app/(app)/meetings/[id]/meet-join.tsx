"use client";

import * as React from "react";
import { Video, ExternalLink, Link2, Loader2, Check, Pencil } from "lucide-react";
import { setMeetingLink } from "@/lib/actions/meeting-actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Retour } from "@/components/ui/retour";
import { useAction } from "@/components/shared/use-action";

/**
 * Rejoindre une réunion via son **lien** (Google Meet, Teams, Zoom… ou lien d'appel).
 * Remplace l'embed Jitsi : on affiche un grand bouton « Rejoindre ». L'organisateur peut
 * coller / modifier le lien. (Le code Jitsi reste présent, simplement masqué ici.)
 */
export function MeetJoin({ meetingId, meetLink, canManage }: { meetingId: string; meetLink: string | null; canManage: boolean }) {
  const [editing, setEditing] = React.useState(false);
  const [value, setValue] = React.useState(meetLink ?? "");
  const { saving, err, run } = useAction();

  async function save() {
    const fd = new FormData(); fd.set("id", meetingId); fd.set("meetLink", value);
    await run(() => setMeetingLink(fd), () => setEditing(false));
  }

  // Saisie / modification du lien.
  const editor = (
    <div className="space-y-2">
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input value={value} onChange={(e) => setValue(e.target.value)} type="url" inputMode="url" autoCapitalize="off" autoCorrect="off" spellCheck={false} placeholder="https://meet.google.com/xxx-xxxx-xxx" className="flex-1" />
        <Button type="button" onClick={save} disabled={saving}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Enregistrer
        </Button>
        {meetLink && <Button type="button" variant="outline" onClick={() => { setEditing(false); setValue(meetLink); }}>Annuler</Button>}
      </div>
      <Retour ton="erreur">{err}</Retour>
    </div>
  );

  if (!meetLink) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-border bg-secondary/30 px-4 py-8 text-center sm:px-6 sm:py-10">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10"><Video className="h-6 w-6 text-primary" /></div>
        {canManage ? (
          <>
            <p className="max-w-sm text-sm text-muted-foreground">Ajoutez le lien de la réunion (Google Meet, Teams, Zoom…) pour que tout le monde puisse rejoindre.</p>
            <div className="w-full max-w-md">{editor}</div>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">En attente du lien de réunion de l'organisateur.</p>
        )}
      </div>
    );
  }

  if (editing) {
    return <div className="rounded-xl border border-border bg-card p-3 sm:p-4">{editor}</div>;
  }

  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-border bg-secondary/30 px-4 py-8 text-center sm:px-6 sm:py-10">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-primary/10"><Video className="h-7 w-7 text-primary" /></div>
      <a href={meetLink} target="_blank" rel="noopener noreferrer"
        className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-5 py-3 text-sm font-semibold sm:w-auto sm:py-2.5 text-primary-foreground hover:opacity-90">
        <ExternalLink className="h-4 w-4" /> Rejoindre la réunion
      </a>
      <p className="max-w-full truncate text-xs text-muted-foreground"><Link2 className="mr-1 inline h-3 w-3" />{meetLink}</p>
      {canManage && (
        <button type="button" onClick={() => setEditing(true)} className="inline-flex items-center gap-1 py-2 text-xs text-muted-foreground hover:text-foreground sm:py-0">
          <Pencil className="h-3 w-3" /> Modifier le lien
        </button>
      )}
    </div>
  );
}
