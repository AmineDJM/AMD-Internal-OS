"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { CalendarPlus, Loader2, Check, Video, Mic, MapPin } from "lucide-react";
import { createMeeting } from "@/lib/actions/meeting-actions";
import { Sheet } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import { actionFailureMessage } from "@/lib/action-outcome";

interface UserOption { id: string; name: string; title?: string | null }

export function NewMeetingButton({ users }: { users: UserOption[] }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [video, setVideo] = React.useState(true);
  const [inPerson, setInPerson] = React.useState(false);
  const [picked, setPicked] = React.useState<Set<string>>(new Set());
  const [q, setQ] = React.useState("");

  const filtered = q
    ? users.filter((u) => `${u.name} ${u.title ?? ""}`.toLowerCase().includes(q.toLowerCase()))
    : users;

  function toggle(id: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  return (
    <>
      <Button type="button" onClick={() => { setErr(null); setOpen(true); }}>
        <CalendarPlus className="h-4 w-4" /> Nouvelle réunion
      </Button>
      <Sheet open={open} onClose={() => !saving && setOpen(false)} title="Nouvelle réunion" width="lg">
        <form
          action={async (fd) => {
            setSaving(true); setErr(null);
            fd.set("withVideo", video ? "true" : "false");
            fd.set("inPerson", inPerson ? "true" : "false");
            picked.forEach((id) => fd.append("participantIds", id));
            try {
              const r = await createMeeting(undefined, fd);
              if (r.ok && r.id) { setOpen(false); router.push(`/meetings/${r.id}`); }
              else setErr(r.error ?? "La réunion n'a pas été créée.");
            } catch {
              setErr(actionFailureMessage("THROWN"));
            } finally {
              setSaving(false);
            }
          }}
          className="space-y-4"
        >
          <div className="space-y-1.5">
            <Label htmlFor="title">Titre</Label>
            <Input id="title" name="title" placeholder="Ex. Point hebdo équipe médicale" required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="description">Objet (optionnel)</Label>
            <Textarea id="description" name="description" rows={2} placeholder="Ordre du jour, contexte…" />
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
              <Label htmlFor="location">Lieu</Label>
              <Input id="location" name="location" placeholder="Ex. Salle de réunion — siège Adventum, Alger" />
              <p className="text-xs text-muted-foreground">Adresse ou salle où se tiendra la réunion en personne (aucun lien en ligne).</p>
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label htmlFor="meetLink">Lien de la réunion (Google Meet, Teams, Zoom…)</Label>
              <Input id="meetLink" name="meetLink" type="url" autoCapitalize="off" autoCorrect="off" spellCheck={false} placeholder="https://meet.google.com/xxx-xxxx-xxx" />
              <p className="text-xs text-muted-foreground">Collez le lien de la réunion. Les participants cliqueront simplement dessus pour rejoindre.</p>
            </div>
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="scheduledAt">Date / heure (optionnel)</Label>
              <Input id="scheduledAt" name="scheduledAt" type="datetime-local" />
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

          <div className="space-y-1.5">
            <Label>Participants {picked.size > 0 && <span className="text-muted-foreground">({picked.size})</span>}</Label>
            <Input value={q} onChange={(e) => setQ(e.target.value)} type="search" placeholder="Rechercher un collègue…" />
            <div className="max-h-[40dvh] space-y-0.5 overflow-y-auto rounded-lg border border-border p-1 sm:max-h-52">
              {filtered.length === 0 && <p className="px-2 py-3 text-sm text-muted-foreground">Aucun collègue.</p>}
              {filtered.map((u) => (
                <label key={u.id} className="flex min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 py-2.5 text-sm hover:bg-secondary sm:py-1.5">
                  <input type="checkbox" checked={picked.has(u.id)} onChange={() => toggle(u.id)} className="h-4 w-4 shrink-0" />
                  <span className="min-w-0 truncate font-medium">{u.name}</span>
                  {u.title && <span className="min-w-0 truncate text-xs text-muted-foreground">· {u.title}</span>}
                </label>
              ))}
            </div>
          </div>

          {err && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={saving} className="w-full sm:w-auto">Annuler</Button>
            <Button type="submit" disabled={saving} className="w-full sm:w-auto">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Créer la réunion
            </Button>
          </div>
        </form>
      </Sheet>
    </>
  );
}
