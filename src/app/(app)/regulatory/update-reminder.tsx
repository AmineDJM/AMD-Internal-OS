"use client";

import * as React from "react";

import { BellRing, Loader2, Check, AlertCircle, Clock, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Sheet } from "@/components/ui/sheet";
import { Input, Label } from "@/components/ui/input";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";
import { sendRegulatoryUpdateReminder } from "@/lib/actions/regulatory-reminder-actions";
import { REMINDER_STALE_DAYS, REMINDER_COOLDOWN_DAYS } from "@/lib/regulatory/update-reminder";

/**
 * RELANCER LA MISE À JOUR DES DOSSIERS — une personne, ou tout le monde.
 *
 * Le panneau montre d'abord POURQUOI relancer : combien de dossiers chacun porte, combien
 * dorment depuis plus d'un mois, et quand on l'a relancé pour la dernière fois. Un bouton qui
 * enverrait une relance sans montrer cela serait un bouton qu'on n'ose pas cliquer.
 *
 * Le bouton n'apparaît que pour le Super Admin et le Directeur Général ; le serveur revérifie
 * de toute façon — ceci n'est que la première porte, pas la serrure.
 */
export interface ReminderPerson {
  userId: string;
  name: string;
  total: number;
  stale: number;
  /** ISO, ou null si jamais relancé. */
  lastRemindedAt: string | null;
}

/** Jours pleins écoulés — recalculés côté navigateur, à l'affichage seulement. */
function daysAgo(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
}

function LastReminder({ iso }: { iso: string | null }) {
  if (!iso) return <span className="text-xs text-muted-foreground">Jamais relancé</span>;
  const n = daysAgo(iso);
  const recent = n < REMINDER_COOLDOWN_DAYS;
  return (
    <span className={`inline-flex items-center gap-1 text-xs ${recent ? "text-warning" : "text-muted-foreground"}`}>
      <Clock className="h-3 w-3" />
      {n === 0 ? "Relancé aujourd'hui" : `Relancé il y a ${n} j`}
    </span>
  );
}

export function UpdateReminderButton({ people, unassigned }: { people: ReminderPerson[]; unassigned: number }) {
  const { rafraichir } = useRafraichir();
  const [open, setOpen] = React.useState(false);
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState<string | null>(null);
  const [done, setDone] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const totalStale = people.reduce((a, p) => a + p.stale, 0);

  async function send(recipientId: string | null) {
    setBusy(recipientId ?? "ALL");
    setError(null);
    setDone(null);
    const fd = new FormData();
    if (recipientId) fd.set("recipientId", recipientId);
    if (note.trim()) fd.set("note", note.trim());
    try {
      const r = await sendRegulatoryUpdateReminder(fd);
      if (!r.ok) { setError(r.error ?? "Relance impossible."); return; }
      setDone(r.message ?? "Relance envoyée.");
      rafraichir();
      setTimeout(() => setDone(null), 4000);
    } catch {
      setError(actionFailureMessage("THROWN"));
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <BellRing className="h-4 w-4" /> Relancer la mise à jour
        {totalStale > 0 && <Badge tone="warning" dot={false}>{totalStale}</Badge>}
      </Button>

      <Sheet
        open={open} onClose={() => setOpen(false)} width="lg"
        title="Relancer la mise à jour des dossiers"
        description={`Demande à chaque chargé de dossier de remettre son portefeuille à jour. Un dossier est signalé « en sommeil » après ${REMINDER_STALE_DAYS} jours sans mouvement.`}
      >
        <div className="space-y-4">
          <div className="space-y-1">
            <Label className="text-xs">Message joint (optionnel)</Label>
            <Input
              value={note} onChange={(e) => setNote(e.target.value)}
              placeholder="Ex. Avant le comité de vendredi." className="h-9 text-sm"
            />
            <p className="text-xs text-muted-foreground">
              Il accompagne la relance, seul ou pour tout le monde. Le décompte des dossiers, lui,
              est calculé par le serveur — il dit toujours la vérité.
            </p>
          </div>

          {people.length === 0 ? (
            <p className="rounded-lg border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
              Aucun dossier à traiter n&apos;a de chargé de dossier : il n&apos;y a personne à relancer.
            </p>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-secondary/30 px-3 py-2.5">
                <div className="min-w-0">
                  <p className="flex items-center gap-1.5 text-sm font-medium">
                    <Users className="h-4 w-4" /> Tout le monde
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {people.length} personne{people.length > 1 ? "s" : ""} ·{" "}
                    {people.reduce((a, p) => a + p.total, 0)} dossier
                    {people.reduce((a, p) => a + p.total, 0) > 1 ? "s" : ""} à traiter
                    {totalStale > 0 && ` · ${totalStale} en sommeil`}
                  </p>
                </div>
                <Button size="sm" onClick={() => send(null)} disabled={busy !== null}>
                  {busy === "ALL" ? <Loader2 className="h-4 w-4 animate-spin" /> : <BellRing className="h-4 w-4" />}
                  Relancer tout le monde
                </Button>
              </div>

              <ul className="divide-y rounded-xl border">
                {people.map((p) => (
                  <li key={p.userId} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{p.name}</p>
                      <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <span>{p.total} dossier{p.total > 1 ? "s" : ""}</span>
                        {p.stale > 0 && (
                          <Badge tone="warning" dot={false}>{p.stale} en sommeil</Badge>
                        )}
                        <LastReminder iso={p.lastRemindedAt} />
                      </p>
                    </div>
                    <Button
                      variant="outline" size="sm"
                      onClick={() => send(p.userId)} disabled={busy !== null}
                    >
                      {busy === p.userId ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <BellRing className="h-3.5 w-3.5" />}
                      Relancer
                    </Button>
                  </li>
                ))}
              </ul>
            </>
          )}

          {/* Les dossiers sans porteur ne sont relançables par personne — mais les taire donnerait
              une somme fausse : on croirait avoir couvert tout le tableau. */}
          {unassigned > 0 && (
            <p className="flex items-start gap-2 rounded-xl border border-warning/40 bg-warning/5 p-3 text-xs text-muted-foreground">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
              <span>
                <strong>{unassigned} dossier{unassigned > 1 ? "s" : ""} à traiter sans chargé de dossier.</strong>{" "}
                {unassigned > 1 ? "Ils n'entrent" : "Il n'entre"} dans aucune relance — il n&apos;y a personne à
                prévenir. {unassigned > 1 ? "Confiez-les" : "Confiez-le"} depuis la colonne « Chargé du dossier ».
              </span>
            </p>
          )}

          {error && (
            <p className="flex items-center gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <AlertCircle className="h-4 w-4" /> {error}
            </p>
          )}
          {done && (
            <p className="flex items-center gap-2 rounded-lg bg-success/10 px-3 py-2 text-sm text-success">
              <Check className="h-4 w-4" /> {done}
            </p>
          )}
        </div>
      </Sheet>
    </>
  );
}
