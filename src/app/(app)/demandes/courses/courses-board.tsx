"use client";

import * as React from "react";
import Link from "next/link";
import { useAction } from "@/components/shared/use-action";
import { MapPin, Clock, Paperclip, Phone, XCircle } from "lucide-react";
import { updateMission } from "@/lib/actions/admin-request-actions";
import { StatusBadge } from "@/components/shared/status-badge";
import { EmptyState } from "@/components/shared/empty-state";
import { DRIVER_MISSION_STATUS } from "@/lib/labels";
import { formatAlgiers } from "@/lib/calendar-tz";

/** Échéance « date et heure max » affichée à l'heure d'Alger. */
const deadlineLabel = (iso: string) =>
  formatAlgiers(new Date(iso), { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

export interface CourseStopDTO { id: string; location: string; task: string | null; done: boolean }
export interface CourseDTO {
  id: string;
  title: string;
  status: string;
  assignee: string | null;
  deadline: string | null;
  contactName: string | null;
  contactPhone: string | null;
  instructions: string | null;
  startLocation: string | null;
  destination: string | null;
  address: string | null;
  createdAt: string;
  request: { id: string; reference: string } | null;
  stops: CourseStopDTO[];
  attachments: { id: string; name: string; sizeBytes: number | null }[];
}

const letter = (i: number) => String.fromCharCode(65 + (i % 26));

/** Les courses déjà posées — en lecture (10/2026) : les missions chauffeur ne se créent plus. */
export function CoursesBoard({ courses }: { courses: CourseDTO[] }) {
  // Le lien « Annuler » d'une carte n'a pas de place pour parler : un refus part en avis flottant.
  const { busy, run } = useAction({ signalerErreurs: true });

  const active = courses.filter((c) => c.status !== "DONE" && c.status !== "CANCELLED");
  const finished = courses.filter((c) => c.status === "DONE" || c.status === "CANCELLED");

  async function cancelCourse(c: CourseDTO) {
    const fd = new FormData();
    fd.set("id", c.id);
    fd.set("status", "CANCELLED");
    await run(() => updateMission(fd), undefined, { confirmer: `Annuler la course « ${c.title} » ?` });
  }

  return (
    <div className="space-y-4">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Courses en cours ({active.length})</h2>

      {active.length === 0 ? (
        <EmptyState icon="Car" title="Aucune course en cours" description="Les missions chauffeur ne se créent plus." />
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {active.map((c) => (
            <div key={c.id} className="surface space-y-2.5 p-4">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="font-semibold">{c.title}</p>
                  <p className="text-xs text-muted-foreground">{c.assignee ? `Assignée à ${c.assignee}` : "Non assignée"}</p>
                </div>
                <StatusBadge map={DRIVER_MISSION_STATUS} value={c.status} dot={false} />
              </div>

              {c.deadline && (
                <p className={`flex items-center gap-1.5 text-xs ${new Date(c.deadline) < new Date() ? "font-medium text-destructive" : "text-muted-foreground"}`}>
                  <Clock className="h-3.5 w-3.5" /> Avant le {deadlineLabel(c.deadline)}
                </p>
              )}

              {c.stops.length > 0 ? (
                <ol className="space-y-1.5">
                  {c.stops.map((s, i) => (
                    <li key={s.id} className={`flex items-start gap-2 text-sm ${s.done ? "text-muted-foreground line-through" : ""}`}>
                      <span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[0.6875rem] font-semibold ${s.done ? "bg-success/15 text-success" : "bg-secondary text-foreground"}`}>{letter(i)}</span>
                      <span><span className="font-medium">{s.location}</span>{s.task ? <span className="text-muted-foreground"> — {s.task}</span> : null}</span>
                    </li>
                  ))}
                </ol>
              ) : (
                (c.destination || c.address) && (
                  <p className="flex items-start gap-1.5 text-sm text-muted-foreground"><MapPin className="mt-0.5 h-4 w-4 shrink-0" /> {[c.destination, c.address].filter(Boolean).join(" · ")}</p>
                )
              )}

              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span>{c.stops.filter((s) => s.done).length}/{c.stops.length || "—"} points faits</span>
                {c.attachments.length > 0 && <span className="inline-flex items-center gap-1"><Paperclip className="h-3.5 w-3.5" /> {c.attachments.length} pièce·s</span>}
                {c.contactPhone && <span className="inline-flex items-center gap-1"><Phone className="h-3.5 w-3.5" /> {c.contactName ? `${c.contactName} — ` : ""}{c.contactPhone}</span>}
                {c.request && <Link href={`/demandes/${c.request.id}`} className="text-primary hover:underline">Demande {c.request.reference}</Link>}
              </div>

              <div className="flex justify-end">
                <button onClick={() => void cancelCourse(c)} disabled={busy} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-destructive/10 hover:text-destructive">
                  <XCircle className="h-3.5 w-3.5" /> Annuler la course
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {finished.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Terminées / annulées</h2>
          <div className="surface divide-y divide-border">
            {finished.slice(0, 30).map((c) => (
              <div key={c.id} className="flex items-center justify-between gap-2 px-4 py-2.5 text-sm">
                <span className="min-w-0 truncate font-medium">{c.title}<span className="ml-2 text-xs font-normal text-muted-foreground">{c.assignee ?? ""}</span></span>
                <StatusBadge map={DRIVER_MISSION_STATUS} value={c.status} dot={false} />
              </div>
            ))}
          </div>
        </section>
      )}

    </div>
  );
}
