"use client";

import * as React from "react";
import { Pencil, Loader2, Check, Video, Mic, MapPin } from "lucide-react";
import { updateMeeting } from "@/lib/actions/meeting-actions";
import { Sheet } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";

interface Props {
  id: string;
  title: string;
  description: string;
  meetLink: string;
  /** Horaire au format `datetime-local` (déjà converti en heure d'Alger), ou "" si non planifiée. */
  scheduledAtInput: string;
  withVideo: boolean;
  inPerson: boolean;
  location: string;
}

/** Modifier les informations et l'horaire d'une réunion (organisateur / vue globale). */
export function EditMeetingButton({ id, title, description, meetLink, scheduledAtInput, withVideo, inPerson: inPersonInit, location }: Props) {
  const { rafraichir } = useRafraichir();
  const [open, setOpen] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [video, setVideo] = React.useState(withVideo);
  const [inPerson, setInPerson] = React.useState(inPersonInit);

  // Repart des valeurs actuelles à chaque ouverture.
  React.useEffect(() => { if (open) { setVideo(withVideo); setInPerson(inPersonInit); setErr(null); } }, [open, withVideo, inPersonInit]);

  return (
    <>
      <Button type="button" variant="outline" onClick={() => setOpen(true)}>
        <Pencil className="h-4 w-4" /> Modifier
      </Button>
      <Sheet open={open} onClose={() => !saving && setOpen(false)} title="Modifier la réunion" width="lg">
        <form
          action={async (fd) => {
            setSaving(true); setErr(null);
            fd.set("id", id);
            fd.set("withVideo", video ? "true" : "false");
            fd.set("inPerson", inPerson ? "true" : "false");
            try {
              const r = await updateMeeting(fd);
              if (r.ok) { setOpen(false); rafraichir(); }
              else setErr(r.error ?? "La réunion n'a pas été modifiée.");
            } catch {
              setErr(actionFailureMessage("THROWN"));
            } finally {
              setSaving(false);
            }
          }}
          className="space-y-4"
        >
          <div className="space-y-1.5">
            <Label htmlFor="edit-title">Titre</Label>
            <Input id="edit-title" name="title" defaultValue={title} required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="edit-description">Objet (optionnel)</Label>
            <Textarea id="edit-description" name="description" rows={2} defaultValue={description} placeholder="Ordre du jour, contexte…" />
          </div>
          <div className="space-y-1.5">
            <Label>Format</Label>
            <div className="flex gap-2">
              <button type="button" onClick={() => setInPerson(false)}
                className={`inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-sm ${!inPerson ? "border-primary bg-primary/5 ring-1 ring-primary" : "border-border hover:bg-secondary"}`}>
                <Video className="h-4 w-4" /> En ligne (lien)
              </button>
              <button type="button" onClick={() => setInPerson(true)}
                className={`inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-sm ${inPerson ? "border-primary bg-primary/5 ring-1 ring-primary" : "border-border hover:bg-secondary"}`}>
                <MapPin className="h-4 w-4" /> Présentiel
              </button>
            </div>
          </div>

          {inPerson ? (
            <div className="space-y-1.5">
              <Label htmlFor="edit-location">Lieu</Label>
              <Input id="edit-location" name="location" defaultValue={location} placeholder="Ex. Salle de réunion — siège Adventum, Alger" />
              <p className="text-xs text-muted-foreground">Adresse ou salle de la réunion en personne (aucun lien en ligne).</p>
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label htmlFor="edit-meetLink">Lien de la réunion (Google Meet, Teams, Zoom…)</Label>
              <Input id="edit-meetLink" name="meetLink" type="url" autoCapitalize="off" autoCorrect="off" spellCheck={false} defaultValue={meetLink} placeholder="https://meet.google.com/xxx-xxxx-xxx" />
              <p className="text-xs text-muted-foreground">Laissez vide pour retirer le lien externe.</p>
            </div>
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="edit-scheduledAt">Date / heure (optionnel)</Label>
              <Input id="edit-scheduledAt" name="scheduledAt" type="datetime-local" defaultValue={scheduledAtInput} />
              <p className="text-xs text-muted-foreground">Heure d'Alger. Modifier réactive le rappel « 30 min avant ».</p>
            </div>
            {!inPerson && (
              <div className="space-y-1.5">
                <Label>Type d'appel</Label>
                <div className="flex gap-2">
                  <button type="button" onClick={() => setVideo(true)}
                    className={`inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-sm ${video ? "border-primary bg-primary/5 ring-1 ring-primary" : "border-border hover:bg-secondary"}`}>
                    <Video className="h-4 w-4" /> Vidéo
                  </button>
                  <button type="button" onClick={() => setVideo(false)}
                    className={`inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-sm ${!video ? "border-primary bg-primary/5 ring-1 ring-primary" : "border-border hover:bg-secondary"}`}>
                    <Mic className="h-4 w-4" /> Audio
                  </button>
                </div>
              </div>
            )}
          </div>

          {err && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={saving} className="w-full sm:w-auto">Annuler</Button>
            <Button type="submit" disabled={saving} className="w-full sm:w-auto">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Enregistrer
            </Button>
          </div>
        </form>
      </Sheet>
    </>
  );
}
