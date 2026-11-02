"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight, Plus, Loader2, Trash2, Pencil, MapPin, Video, Users, Clock, ExternalLink } from "lucide-react";
import type { CalendarEventDTO } from "@/lib/calendar";
import type { GridDay } from "@/lib/calendar-tz";
import { createCalendarEvent, updateCalendarEvent, deleteCalendarEvent, respondToInvite } from "@/lib/actions/calendar-actions";
import { utcToAlgiersInput, formatPlageAlgiers, joursCouverts } from "@/lib/calendar-tz";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { StatusBadge } from "@/components/shared/status-badge";
import { Avatar } from "@/components/ui/avatar";
import { useConfirmer } from "@/components/ui/dialogue";
import { Retour } from "@/components/ui/retour";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";
import { CALENDAR_EVENT_KIND, CALENDAR_INVITE_STATUS } from "@/lib/labels";

const MONTH_LABELS = ["Janvier", "Février", "Mars", "Avril", "Mai", "Juin", "Juillet", "Août", "Septembre", "Octobre", "Novembre", "Décembre"];
const WEEKDAYS = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];
const colorOf = (e: CalendarEventDTO) => e.color || CALENDAR_EVENT_KIND[e.kind]?.color || "#64748b";

type SheetMode =
  | null
  | { mode: "create"; day?: string }
  | { mode: "view"; event: CalendarEventDTO }
  | { mode: "edit"; event: CalendarEventDTO };

export function CalendarView({
  year, month, grid, events, upcoming, users, currentUserId, canCreate,
}: {
  year: number;
  month: number; // 0-based
  grid: GridDay[];
  events: CalendarEventDTO[];
  upcoming: CalendarEventDTO[];
  users: { id: string; name: string }[];
  currentUserId: string;
  canCreate: boolean;
}) {
  const router = useRouter();
  const { rafraichir } = useRafraichir();
  const [sheet, setSheet] = React.useState<SheetMode>(null);
  // Au téléphone, une grille de 7 colonnes laisse ~48 px par jour : illisible. On y ouvre donc
  // l'agenda en LISTE (jours du mois qui ont un rendez-vous) ; la grille reste à un appui. Sans effet dès `sm`.
  const [vueMobile, setVueMobile] = React.useState<"liste" | "mois">("liste");

  const byDay = React.useMemo(() => {
    const m = new Map<string, CalendarEventDTO[]>();
    // Un congrès de trois jours occupe ses trois cases.
    for (const e of events) {
      for (const ymd of joursCouverts(e.ymd, e.endYmd)) (m.get(ymd) ?? m.set(ymd, []).get(ymd)!).push(e);
    }
    return m;
  }, [events]);
  const joursDuMois = grid.filter((g) => g.inMonth && (byDay.get(g.ymd)?.length ?? 0) > 0);

  const prevHref = `/calendar?y=${month === 0 ? year - 1 : year}&m=${((month + 11) % 12) + 1}`;
  const nextHref = `/calendar?y=${month === 11 ? year + 1 : year}&m=${((month + 1) % 12) + 1}`;

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1fr_300px]">
      <div className="space-y-3">
        {/* La rangée PASSE À LA LIGNE : à 375 px, le mois, ses flèches, « Aujourd'hui » et
            « Nouveau » ne tiennent pas côte à côte — sans `flex-wrap`, « Nouveau » sortait de
            l'écran (mesuré par l'audit navigateur). */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-1">
            <button onClick={() => router.push(prevHref)} className="rounded-md p-2 hover:bg-secondary sm:p-1.5" aria-label="Mois précédent"><ChevronLeft className="h-5 w-5" /></button>
            <h2 className="min-w-[8.5rem] text-center text-lg font-semibold">{MONTH_LABELS[month]} {year}</h2>
            <button onClick={() => router.push(nextHref)} className="rounded-md p-2 hover:bg-secondary sm:p-1.5" aria-label="Mois suivant"><ChevronRight className="h-5 w-5" /></button>
            <button onClick={() => router.push("/calendar")} className="ml-1 rounded-md border border-border px-3 py-2 text-xs font-medium hover:bg-secondary sm:ml-2 sm:px-2.5 sm:py-1">Aujourd'hui</button>
          </div>
          {canCreate && <Button size="sm" onClick={() => setSheet({ mode: "create" })}><Plus className="h-4 w-4" /> Nouveau</Button>}
        </div>

        {/* Bascule Liste / Mois — téléphone seulement. */}
        <div className="flex rounded-lg border border-border bg-secondary/40 p-0.5 sm:hidden" role="tablist" aria-label="Affichage">
          {([["liste", "Liste"], ["mois", "Mois"]] as const).map(([v, l]) => (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={vueMobile === v}
              onClick={() => setVueMobile(v)}
              className={`flex-1 rounded-md py-2 text-sm font-medium transition-colors ${vueMobile === v ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"}`}
            >
              {l}
            </button>
          ))}
        </div>

        {/* Agenda en liste (téléphone). */}
        <div className={vueMobile === "liste" ? "space-y-3 sm:hidden" : "hidden"}>
          {joursDuMois.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">Aucun rendez-vous ce mois-ci.</p>
          ) : (
            joursDuMois.map((g) => (
              <section key={g.ymd} className="space-y-1.5">
                <h3 className={`flex items-center gap-2 text-xs font-semibold uppercase tracking-wide ${g.isToday ? "text-primary" : "text-muted-foreground"}`}>
                  {new Date(`${g.ymd}T12:00:00`).toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" })}
                  {g.isToday && <span className="rounded-full bg-primary px-2 py-0.5 text-[0.6875rem] normal-case tracking-normal text-primary-foreground">Aujourd&apos;hui</span>}
                </h3>
                <div className="surface divide-y divide-border p-0">
                  {(byDay.get(g.ymd) ?? []).map((e) => (
                    <button
                      key={e.id}
                      type="button"
                      onClick={() => setSheet({ mode: "view", event: e })}
                      className="flex w-full items-stretch gap-3 px-3 py-2.5 text-left active:bg-secondary/40"
                    >
                      <span className="w-1 shrink-0 rounded-full" style={{ backgroundColor: colorOf(e) }} />
                      <span className="w-12 shrink-0 pt-0.5 text-xs tabular-nums text-muted-foreground">{g.ymd === e.ymd ? e.timeLabel || "—" : "suite"}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{e.title}</span>
                        {e.location && <span className="block truncate text-xs text-muted-foreground">📍 {e.location}</span>}
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            ))
          )}
        </div>

        <div className={`surface overflow-hidden p-0 ${vueMobile === "mois" ? "" : "hidden sm:block"}`}>
          <div className="grid grid-cols-7 border-b border-border bg-secondary/40 text-center text-xs font-medium text-muted-foreground">
            {WEEKDAYS.map((d) => <div key={d} className="py-2">{d}</div>)}
          </div>
          <div className="grid grid-cols-7">
            {grid.map((g, i) => {
              const dayEvents = byDay.get(g.ymd) ?? [];
              return (
                <div
                  key={g.ymd}
                  className={`min-h-[64px] min-w-0 border-b border-r border-border p-0.5 sm:min-h-[92px] sm:p-1 ${(i + 1) % 7 === 0 ? "border-r-0" : ""} ${!g.inMonth ? "bg-secondary/20" : ""} ${canCreate ? "cursor-pointer hover:bg-secondary/30" : ""}`}
                  onClick={(ev) => { if (canCreate && ev.target === ev.currentTarget) setSheet({ mode: "create", day: g.ymd }); }}
                >
                  <div className="flex items-center justify-between px-0.5">
                    <span className={`text-xs ${g.isToday ? "flex h-5 w-5 items-center justify-center rounded-full bg-primary font-semibold text-primary-foreground" : g.inMonth ? "text-foreground" : "text-muted-foreground/60"}`}>{g.day}</span>
                  </div>
                  <div className="mt-0.5 space-y-0.5">
                    {dayEvents.slice(0, 3).map((e) => (
                      <button
                        key={e.id}
                        onClick={() => setSheet({ mode: "view", event: e })}
                        className="flex w-full min-w-0 items-center gap-1 truncate rounded px-0.5 py-0.5 text-left text-[0.6875rem] hover:opacity-80 sm:px-1"
                        style={{ backgroundColor: `${colorOf(e)}1a`, color: colorOf(e) }}
                      >
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: colorOf(e) }} />
                        {/* Au téléphone l'heure s'efface au profit du titre ; elle reste dans la liste et la fiche. */}
                        <span className="truncate font-medium">{e.timeLabel && g.ymd === e.ymd && <span className="hidden sm:inline">{e.timeLabel} </span>}{e.title}</span>
                      </button>
                    ))}
                    {dayEvents.length > 3 && <p className="truncate px-1 text-[0.6875rem] text-muted-foreground">+{dayEvents.length - 3}<span className="hidden sm:inline"> autre·s</span></p>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Agenda à venir */}
      <aside className="space-y-2">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">À venir</h3>
        {upcoming.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">Aucun rendez-vous à venir.</p>
        ) : (
          <div className="space-y-2">
            {upcoming.map((e) => (
              <button key={e.id} onClick={() => setSheet({ mode: "view", event: e })} className="surface flex w-full items-start gap-2 p-2.5 text-left hover:bg-secondary/30">
                <span className="mt-1 h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: colorOf(e) }} />
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{e.title}</p>
                  <p className="text-xs text-muted-foreground">{formatPlageAlgiers(e.startAt, e.endAt, e.allDay)}</p>
                  {e.location && <p className="truncate text-xs text-muted-foreground">📍 {e.location}</p>}
                </div>
              </button>
            ))}
          </div>
        )}
      </aside>

      <CalendarSheet
        sheet={sheet}
        onClose={() => setSheet(null)}
        users={users}
        currentUserId={currentUserId}
        onEdit={(event) => setSheet({ mode: "edit", event })}
        onDone={() => { setSheet(null); rafraichir(); }}
      />
    </div>
  );
}

function CalendarSheet({
  sheet, onClose, users, currentUserId, onEdit, onDone,
}: {
  sheet: SheetMode;
  onClose: () => void;
  users: { id: string; name: string }[];
  currentUserId: string;
  onEdit: (e: CalendarEventDTO) => void;
  onDone: () => void;
}) {
  if (!sheet) return <Sheet open={false} onClose={onClose} title="" width="md"><div /></Sheet>;

  if (sheet.mode === "view") {
    return (
      <Sheet open onClose={onClose} title={sheet.event.title} width="md">
        <EventDetail event={sheet.event} currentUserId={currentUserId} onEdit={() => onEdit(sheet.event)} onDone={onDone} />
      </Sheet>
    );
  }

  const isEdit = sheet.mode === "edit";
  const ev = isEdit ? sheet.event : undefined;
  const defaultDay = sheet.mode === "create" ? sheet.day : undefined;

  return (
    <Sheet open onClose={onClose} title={isEdit ? "Modifier le rendez-vous" : "Nouveau rendez-vous"} width="md">
      <EventForm
        event={ev}
        defaultDay={defaultDay}
        users={users}
        currentUserId={currentUserId}
        onDone={onDone}
        onCancel={onClose}
      />
    </Sheet>
  );
}

function EventDetail({ event: e, currentUserId, onEdit, onDone }: { event: CalendarEventDTO; currentUserId: string; onEdit: () => void; onDone: () => void }) {
  const confirmer = useConfirmer();
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const isOrganizer = e.isOrganizer;
  const amInvited = !isOrganizer && e.myStatus != null;

  async function respond(status: string) {
    setBusy(true); setErr(null);
    const fd = new FormData(); fd.set("eventId", e.id); fd.set("status", status);
    try {
      const r = await respondToInvite(fd);
      if (!r.ok) { setErr(r.error ?? "Votre réponse n'a pas été enregistrée."); return; }
      onDone();
    } catch {
      setErr(actionFailureMessage("THROWN"));
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!(await confirmer("Supprimer ce rendez-vous ?"))) return;
    setBusy(true); setErr(null);
    const fd = new FormData(); fd.set("id", e.id);
    try {
      const r = await deleteCalendarEvent(fd);
      if (!r.ok) { setErr(r.error ?? "Le rendez-vous n'a pas été supprimé."); return; }
      onDone();
    } catch {
      setErr(actionFailureMessage("THROWN"));
    } finally {
      setBusy(false);
    }
  }

  // UNE DEMANDE AD & PRO : lue sur sa fiche, elle s'y modifie — ici, ni réponse ni suppression.
  if (e.source) {
    return (
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full px-2 py-0.5 text-xs font-medium" style={{ backgroundColor: `${colorOf(e)}1a`, color: colorOf(e) }}>{e.source.label}</span>
          <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground"><Clock className="h-4 w-4" /> {formatPlageAlgiers(e.startAt, e.endAt, e.allDay)}</span>
        </div>
        {e.location && <p className="flex items-start gap-1.5 text-sm [overflow-wrap:anywhere]"><MapPin className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" /> {e.location}</p>}
        {e.organizerName !== "—" && <p className="text-xs text-muted-foreground">Demandé par {e.organizerName}{e.organizerId === currentUserId ? " (vous)" : ""}.</p>}
        <div className="flex justify-end border-t border-border pt-3">
          <Link href={e.source.href} className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-secondary"><ExternalLink className="h-4 w-4" /> Ouvrir la demande</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge map={CALENDAR_EVENT_KIND} value={e.kind} dot={false} />
        <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground"><Clock className="h-4 w-4" /> {formatPlageAlgiers(e.startAt, e.endAt, e.allDay)}</span>
      </div>
      {e.location && <p className="flex items-start gap-1.5 text-sm [overflow-wrap:anywhere]"><MapPin className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" /> {e.location}</p>}
      {e.meetLink && <a href={e.meetLink} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 py-1 text-sm font-medium text-primary hover:underline"><Video className="h-4 w-4" /> Rejoindre la visio</a>}
      {e.description && <p className="whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">{e.description}</p>}
      <p className="text-xs text-muted-foreground">Organisé par {e.organizerName}{isOrganizer ? " (vous)" : ""}.</p>

      {e.invitees.length > 0 && (
        <div className="space-y-1.5">
          <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground"><Users className="h-3.5 w-3.5" /> Invités ({e.invitees.length})</p>
          <ul className="space-y-1">
            {e.invitees.map((i) => (
              <li key={i.userId} className="flex items-center justify-between gap-2 text-sm">
                <span className="flex min-w-0 items-center gap-1.5"><Avatar name={i.name} size="sm" className="h-5 w-5 shrink-0 text-[0.5625rem]" /> <span className="truncate">{i.name}</span></span>
                <StatusBadge map={CALENDAR_INVITE_STATUS} value={i.status} dot={false} />
              </li>
            ))}
          </ul>
        </div>
      )}

      {amInvited && (
        <div className="space-y-1.5 border-t border-border pt-3">
          <p className="text-xs font-medium">Votre réponse</p>
          <div className="grid grid-cols-3 gap-2 sm:flex">
            <Button size="sm" variant={e.myStatus === "ACCEPTED" ? "primary" : "outline"} disabled={busy} onClick={() => respond("ACCEPTED")}>Accepter</Button>
            <Button size="sm" variant={e.myStatus === "TENTATIVE" ? "primary" : "outline"} disabled={busy} onClick={() => respond("TENTATIVE")}>Peut-être</Button>
            <Button size="sm" variant={e.myStatus === "DECLINED" ? "primary" : "outline"} disabled={busy} onClick={() => respond("DECLINED")}>Refuser</Button>
          </div>
        </div>
      )}

      {isOrganizer && (
        <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-3">
          <Button size="sm" variant="outline" onClick={onEdit}><Pencil className="h-4 w-4" /> Modifier</Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={remove} className="text-destructive hover:bg-destructive/10"><Trash2 className="h-4 w-4" /> Supprimer</Button>
        </div>
      )}
      <Retour ton="erreur">{err}</Retour>
    </div>
  );
}

function EventForm({
  event: ev, defaultDay, users, currentUserId, onDone, onCancel,
}: {
  event?: CalendarEventDTO;
  defaultDay?: string;
  users: { id: string; name: string }[];
  currentUserId: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [allDay, setAllDay] = React.useState(ev?.allDay ?? false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [invitees, setInvitees] = React.useState<string[]>(ev?.invitees.map((i) => i.userId) ?? []);

  const startDefault = ev ? utcToAlgiersInput(new Date(ev.startAt)) : defaultDay ? `${defaultDay}T09:00` : "";
  const endDefault = ev?.endAt ? utcToAlgiersInput(new Date(ev.endAt)) : "";
  const candidates = users.filter((u) => u.id !== currentUserId);

  async function submit(fd: FormData) {
    setBusy(true); setError(null);
    if (ev) fd.set("id", ev.id);
    invitees.forEach((id) => fd.append("inviteeIds", id));
    try {
      const r = ev ? await updateCalendarEvent(undefined, fd) : await createCalendarEvent(undefined, fd);
      if (r.ok) onDone(); else setError(r.error ?? (ev ? "Le rendez-vous n'a pas été modifié." : "Le rendez-vous n'a pas été créé."));
    } catch {
      setError(actionFailureMessage("THROWN"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form action={submit} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="title">Titre <span className="text-destructive">*</span></Label>
        <Input id="title" name="title" required defaultValue={ev?.title} placeholder="Ex. RDV pharmacien, réunion équipe…" />
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="kind">Type</Label>
          <Select id="kind" name="kind" defaultValue={ev?.kind ?? "APPOINTMENT"}>
            {Object.entries(CALENDAR_EVENT_KIND).map(([v, d]) => <option key={v} value={v}>{d.label}</option>)}
          </Select>
        </div>
        <div className="flex items-end sm:pb-2">
          <label className="flex items-center gap-2 py-1 text-sm sm:py-0">
            <input type="checkbox" name="allDay" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} className="h-4 w-4 rounded border-border" />
            Journée entière
          </label>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="start">Début <span className="text-destructive">*</span></Label>
          <Input id="start" name="start" type={allDay ? "date" : "datetime-local"} required defaultValue={allDay ? startDefault.slice(0, 10) : startDefault} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="end">Fin</Label>
          <Input id="end" name="end" type={allDay ? "date" : "datetime-local"} defaultValue={allDay ? (endDefault ? endDefault.slice(0, 10) : "") : endDefault} />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="location">Lieu</Label>
          <Input id="location" name="location" defaultValue={ev?.location ?? ""} placeholder="Bureau, ville…" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="meetLink">Lien visio</Label>
          <Input id="meetLink" name="meetLink" inputMode="url" autoCapitalize="off" autoCorrect="off" spellCheck={false} defaultValue={ev?.meetLink ?? ""} placeholder="https://meet…" />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="description">Description</Label>
        <Textarea id="description" name="description" defaultValue={ev?.description ?? ""} placeholder="Détails, ordre du jour…" />
      </div>

      <div className="space-y-1.5">
        <Label>Inviter ({invitees.length})</Label>
        <div className="max-h-56 space-y-1 overflow-y-auto rounded-lg border border-border p-2 sm:max-h-40">
          {candidates.length === 0 && <p className="text-xs text-muted-foreground">Aucun collègue à inviter.</p>}
          {candidates.map((u) => (
            <label key={u.id} className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-2 text-sm hover:bg-secondary/50 sm:py-1">
              <input
                type="checkbox"
                checked={invitees.includes(u.id)}
                onChange={(e) => setInvitees((prev) => e.target.checked ? [...prev, u.id] : prev.filter((id) => id !== u.id))}
                className="h-4 w-4 rounded border-border"
              />
              {u.name}
            </label>
          ))}
        </div>
      </div>

      <Retour ton="erreur">{error}</Retour>
      <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
        <Button type="button" variant="outline" onClick={onCancel} disabled={busy} className="w-full sm:w-auto">Annuler</Button>
        <Button type="submit" disabled={busy} className="w-full sm:w-auto">{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null} {ev ? "Enregistrer" : "Créer"}</Button>
      </div>
    </form>
  );
}
