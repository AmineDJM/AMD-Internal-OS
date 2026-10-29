"use client";

import { useState } from "react";
import { useAction, type OptionsGeste } from "@/components/shared/use-action";
import { CalendarClock, Loader2, Pause, Play, Plus, Repeat, Trash2 } from "lucide-react";
import {
  createStockRecurrence, updateStockRecurrence, setStockRecurrenceStatus, deleteStockRecurrence,
} from "@/lib/actions/stock-recurrence-actions";
import { RECURRENCES_STOCK, RECURRENCE_STOCK_DEFAUT, HEURE_DEFAUT, libelleRecurrence } from "@/lib/stocks/recurrence";
import type { RecurrenceStockDTO } from "@/lib/queries/stock-recurrence";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { formatDate } from "@/lib/utils";

/**
 * LES RÉCURRENCES DE DEMANDE D'ÉTAT DE STOCK — posées une fois, elles repartent seules.
 *
 * ── POURQUOI CE PANNEAU EST ICI, à côté de la demande ponctuelle ────────────────────────
 *
 * Le geste est le même à un mot près : « demande à Karim l'état de ses trois hôpitaux » et
 * « demande-le-lui chaque mois ». Les séparer dans deux écrans obligerait à connaître d'avance
 * lequel des deux on veut, alors que c'est en préparant la demande qu'on se dit qu'elle
 * reviendra. Et la garde est la MÊME (`canRequestStockState`) : poser une récurrence n'est pas
 * plus léger que demander une fois — c'est demander indéfiniment.
 *
 * ── CE QUE CHAQUE LIGNE MONTRE, ET POURQUOI ──────────────────────────────────────────────
 *
 * La cadence en clair, la personne, les hôpitaux NOMMÉS, la prochaine échéance, et le nombre de
 * demandes DÉJÀ envoyées. Ce dernier chiffre est le seul qui prouve que la récurrence marche :
 * sans lui, une planification muette depuis six mois est indiscernable d'une planification qui
 * tourne (§118.14 — une brique sans effet constatable n'existe pas).
 */
const JOURS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];

type Res = { ok: boolean; error?: string };

export function RecurrencesPanel({ recurrences, hospitals, users }: {
  recurrences: RecurrenceStockDTO[];
  hospitals: { id: string; name: string }[];
  users: { id: string; label: string }[];
}) {
  const { busy, err: error, setErr: setError, run } = useAction();
  const [ouvert, setOuvert] = useState(false);
  const [edite, setEdite] = useState<RecurrenceStockDTO | null>(null);
  const [cadence, setCadence] = useState<string>(RECURRENCE_STOCK_DEFAUT);
  const [coches, setCoches] = useState<string[]>([]);

  const lancer = async (fn: () => Promise<Res>, geste?: OptionsGeste) => {
    await run(fn, () => { setOuvert(false); setEdite(null); setCoches([]); }, geste);
  };

  const ouvrirNeuve = () => {
    setEdite(null); setCadence(RECURRENCE_STOCK_DEFAUT); setCoches([]); setOuvert(true); setError(null);
  };
  const ouvrirEdition = (r: RecurrenceStockDTO) => {
    setEdite(r); setCadence(r.recurrence); setCoches(r.hospitalIds); setOuvert(true); setError(null);
  };

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          <Repeat className="h-4 w-4" /> Demandes récurrentes ({recurrences.length})
        </h2>
        <Button type="button" size="sm" variant="outline" onClick={ouvrirNeuve}>
          <Plus className="h-4 w-4" /> Poser une récurrence
        </Button>
      </div>

      {error && <p className="rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}

      {/* CE QUI MANQUE SE DIT : un panneau vide sans phrase laisse croire à une panne. */}
      {recurrences.length === 0 && !ouvert && (
        <p className="rounded-lg border border-border bg-secondary/40 px-3 py-2.5 text-sm text-muted-foreground">
          Aucune demande récurrente. Posez-en une pour que le relevé d&apos;un hôpital soit demandé
          automatiquement — sans quoi il faut y penser chaque mois, et un mois sur trois personne n&apos;y pense.
        </p>
      )}

      {recurrences.length > 0 && (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {recurrences.map((r) => (
            <li key={r.id} className="space-y-1.5 px-3 py-2.5 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="min-w-0 font-medium [overflow-wrap:anywhere]">{r.name}</span>
                <span className={`rounded-full px-2 py-0.5 text-xs ${r.status === "ACTIVE" ? "bg-success/15 text-success" : "bg-secondary text-muted-foreground"}`}>
                  {r.status === "ACTIVE" ? "Active" : "En pause"}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                {r.cadence} · <strong className="text-foreground">{r.assigneeName}</strong>
                {r.hospitalNames.length > 0
                  ? <> · {r.hospitalNames.join(", ")}</>
                  : <> · <span className="italic">sans hôpital ciblé</span></>}
              </p>
              <p className="text-xs text-muted-foreground">
                {r.status === "ACTIVE" ? <>Prochaine : {formatDate(r.nextRunAt.toISOString())} · </> : null}
                {/* LA PREUVE QUE ÇA TOURNE. « 0 envoyée » sur une récurrence mensuelle posée il y
                    a six mois est exactement ce qu'on veut voir. */}
                <strong className="text-foreground">{r.runCount}</strong> demande{r.runCount > 1 ? "s" : ""} envoyée{r.runCount > 1 ? "s" : ""}
                {r.lastRunAt ? <> · dernière le {formatDate(r.lastRunAt.toISOString())}</> : null}
              </p>
              {r.sansAuteur && (
                <p className="rounded border border-warning/40 bg-warning/10 px-2 py-1 text-xs">
                  Le compte qui a posé cette récurrence n&apos;existe plus : elle ne partira pas.
                  Reposez-la à votre nom — c&apos;est l&apos;autorité de son auteur qui fait partir la demande.
                </p>
              )}
              <div className="flex flex-wrap gap-1.5 pt-0.5">
                <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => ouvrirEdition(r)}>Modifier</Button>
                <Button type="button" size="sm" variant="ghost" disabled={busy}
                  onClick={() => lancer(() => {
                    const fd = new FormData();
                    fd.set("id", r.id);
                    fd.set("status", r.status === "ACTIVE" ? "PAUSED" : "ACTIVE");
                    return setStockRecurrenceStatus(fd);
                  })}>
                  {r.status === "ACTIVE" ? <><Pause className="h-3.5 w-3.5" /> Mettre en pause</> : <><Play className="h-3.5 w-3.5" /> Reprendre</>}
                </Button>
                <Button type="button" size="sm" variant="ghost" disabled={busy}
                  onClick={() => {
                    const fd = new FormData();
                    fd.set("id", r.id);
                    // LA CONSÉQUENCE, pas « êtes-vous sûr ? » : ce qui est déjà parti reste.
                    void lancer(() => deleteStockRecurrence(fd), {
                      confirmer: `Retirer « ${r.name} » ? Les ${r.runCount} demande(s) déjà envoyée(s) restent dans les tâches de ${r.assigneeName} — seules les prochaines s'arrêtent.`,
                    });
                  }}>
                  <Trash2 className="h-3.5 w-3.5" /> Retirer
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {ouvert && (
        <form
          action={async (fd) => {
            for (const id of coches) fd.append("hospitalIds", id);
            if (edite) { fd.set("id", edite.id); await lancer(() => updateStockRecurrence(fd)); }
            else await lancer(() => createStockRecurrence(fd));
          }}
          className="surface space-y-3 p-3 sm:p-4"
        >
          <p className="flex items-center gap-2 text-sm font-medium">
            <CalendarClock className="h-4 w-4" /> {edite ? `Modifier « ${edite.name} »` : "Nouvelle demande récurrente"}
          </p>

          <div className="flex flex-wrap items-end gap-3">
            <div className="w-full min-w-0 flex-1 space-y-1.5 sm:w-auto sm:min-w-56">
              <Label htmlFor="rec-name">Nom — ce que vous relirez dans trois mois</Label>
              <Input id="rec-name" name="name" required defaultValue={edite?.name ?? ""} placeholder="Ex. Relevé mensuel secteur Est" />
            </div>
            <div className="w-full min-w-0 flex-1 space-y-1.5 sm:w-auto sm:min-w-56">
              <Label htmlFor="rec-assignee">Demander à</Label>
              <Select id="rec-assignee" name="assigneeId" required defaultValue={edite?.assigneeId ?? ""}>
                <option value="" disabled>Choisir une personne…</option>
                {users.map((u) => <option key={u.id} value={u.id}>{u.label}</option>)}
              </Select>
            </div>
          </div>

          <div className="flex flex-wrap items-end gap-3">
            <div className="w-full space-y-1.5 sm:w-auto sm:min-w-44">
              <Label htmlFor="rec-cadence">Cadence</Label>
              <Select id="rec-cadence" name="recurrence" value={cadence} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setCadence(e.target.value)}>
                {RECURRENCES_STOCK.map((r) => <option key={r} value={r}>{libelleRecurrence(r)}</option>)}
              </Select>
            </div>
            <div className="min-w-0 flex-1 space-y-1.5 sm:flex-none sm:min-w-28">
              <Label htmlFor="rec-hour">Heure (Alger)</Label>
              <Input id="rec-hour" name="hourLocal" type="number" inputMode="numeric" min={0} max={23}
                defaultValue={edite?.hourLocal ?? HEURE_DEFAUT} />
            </div>
            {cadence === "WEEKLY" && (
              <div className="w-full space-y-1.5 sm:w-auto sm:min-w-40">
                <Label htmlFor="rec-dow">Jour de la semaine</Label>
                <Select id="rec-dow" name="dayOfWeek" defaultValue={String(edite?.dayOfWeek ?? 0)}>
                  {JOURS.map((j, i) => <option key={j} value={i}>{j}</option>)}
                </Select>
              </div>
            )}
            {cadence === "MONTHLY" && (
              <div className="min-w-0 flex-1 space-y-1.5 sm:flex-none sm:min-w-32">
                <Label htmlFor="rec-dom">Jour du mois</Label>
                <Input id="rec-dom" name="dayOfMonth" type="number" inputMode="numeric" min={1} max={31} defaultValue={edite?.dayOfMonth ?? 1} />
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <Label>Hôpitaux concernés — un ou plusieurs (aucun = demande générale)</Label>
            {hospitals.length === 0 ? (
              <p className="text-xs text-muted-foreground">Aucun hôpital défini (le Super Admin les crée dans l&apos;onglet « Stock hôpitaux »).</p>
            ) : (
              <div className="flex max-h-32 flex-wrap gap-1.5 overflow-y-auto">
                {hospitals.map((h) => (
                  <button key={h.id} type="button"
                    onClick={() => setCoches((v) => v.includes(h.id) ? v.filter((x) => x !== h.id) : [...v, h.id])}
                    className={`min-h-8 rounded-full border px-2.5 py-1 text-xs transition-colors ${coches.includes(h.id) ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:border-primary/40"}`}>
                    {h.name}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="rec-note">Précision (produit / échéance…)</Label>
            <Input id="rec-note" name="note" defaultValue={edite?.note ?? ""} placeholder="Ex. Stock d'Amoxival 500 pour le comité du 5" />
          </div>

          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Repeat className="h-4 w-4" />}
              {edite ? "Enregistrer" : "Poser la récurrence"}
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => { setOuvert(false); setEdite(null); }}>
              Annuler
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
