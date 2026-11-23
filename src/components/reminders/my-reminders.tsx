"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowRight, Bell, BellRing, Bot, Check, Clock, ExternalLink, Loader2, Repeat, X } from "lucide-react";
import { arreterRappelAssistant, cancelReminder, completeReminder, snoozeReminder } from "@/lib/actions/reminder-actions";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { useRetours } from "@/components/ui/retour";
import { actionFailureMessage } from "@/lib/action-outcome";
import { cn } from "@/lib/utils";
import { classerRappels, ONGLETS_RAPPELS, ongletInitial, type OngletRappels, type RappelVue } from "@/lib/rappels/vue";

/**
 * « MES RAPPELS » (recette du 23/11/2026) — tous les rappels de la personne : les siens, ceux que
 * l'assistant a posés pour elle, et les échéances et relances que la plateforme lui envoie. Quatre
 * onglets (`lib/rappels/vue.ts`). Dans l'encart de « Mon espace », chaque onglet montre les premiers
 * (`limite`) et un lien mène à la page complète `/mon-espace/rappels`, qui montre tout.
 */

const fmt = (iso: string) =>
  new Date(iso).toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Algiers" });

/** Demain 9 h, heure du navigateur — « Reporter » ne tombe pas au milieu de la nuit. */
function demainNeufHeures(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d.toISOString();
}

export function MyReminders({ rappels, limite, maintenant }: { rappels: RappelVue[]; limite?: number; maintenant: string }) {
  const { rafraichir } = useRafraichir();
  const retours = useRetours();
  const [busyKey, setBusyKey] = React.useState<string | null>(null);
  const classes = React.useMemo(() => classerRappels(rappels, new Date(maintenant).getTime()), [rappels, maintenant]);
  const [onglet, setOnglet] = React.useState<OngletRappels>(() => ongletInitial(classes));

  async function act(fn: (fd: FormData) => Promise<{ ok: boolean; error?: string }>, r: RappelVue, succes: string, extra?: Record<string, string>) {
    setBusyKey(r.key);
    const fd = new FormData();
    fd.set("id", r.id);
    for (const [k, v] of Object.entries(extra ?? {})) fd.set(k, v);
    try {
      const res = await fn(fd);
      if (res.ok) { retours.succes(succes); rafraichir(); }
      else retours.erreur(res.error ?? "Le rappel n'a pas pu être modifié.");
    } catch {
      retours.erreur(actionFailureMessage("THROWN"));
    } finally {
      setBusyKey(null);
    }
  }

  const liste = classes[onglet];
  const visibles = limite ? liste.slice(0, limite) : liste;
  const def = ONGLETS_RAPPELS.find((o) => o.cle === onglet)!;

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap gap-1" role="tablist" aria-label="Mes rappels">
        {ONGLETS_RAPPELS.map((o) => {
          const n = classes[o.cle].length;
          const actif = onglet === o.cle;
          return (
            <button
              key={o.cle}
              type="button"
              role="tab"
              aria-selected={actif}
              onClick={() => setOnglet(o.cle)}
              className={cn(
                "inline-flex h-8 items-center gap-1 rounded-full border px-2.5 text-xs font-medium focus-ring",
                actif ? "border-primary bg-primary/10 text-primary" : "border-border bg-card text-muted-foreground hover:bg-secondary hover:text-foreground",
              )}
            >
              {o.libelle}
              <span className={cn("tabular-nums", o.cle === "echus" && n > 0 && !actif ? "font-semibold text-warning" : "")}>{n}</span>
            </button>
          );
        })}
      </div>

      {visibles.length === 0 ? (
        <p className="text-sm text-muted-foreground">{def.vide}</p>
      ) : (
        <ul className="space-y-1.5" role="tabpanel">
          {visibles.map((r) => {
            const busy = busyKey === r.key;
            const echu = onglet === "echus";
            const nonLu = r.source === "recu" && r.statut === "NON_LU";
            const Icone = r.source === "assistant" ? Bot : r.source === "recu" ? BellRing : Bell;
            return (
              <li
                key={r.key}
                className={cn(
                  "flex items-start gap-2 rounded-lg border px-3 py-2 text-sm",
                  echu ? "border-warning/40 bg-warning/5" : nonLu ? "border-primary/30 bg-primary/5" : "border-border",
                  onglet === "termines" && "opacity-75",
                )}
              >
                <Icone className={cn("mt-0.5 h-4 w-4 shrink-0", echu ? "text-warning" : "text-muted-foreground")} aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className={cn("break-words font-medium text-foreground", onglet === "termines" && r.statut === "CANCELLED" && "line-through")}>{r.titre}</p>
                  <p className="text-xs text-muted-foreground">
                    <Clock className="mr-1 inline h-3 w-3" aria-hidden />
                    {r.source === "recu" ? `Reçu le ${fmt(r.quand)}` : onglet === "termines" ? `${r.statut === "CANCELLED" || r.statut === "INACTIVE" ? "Arrêté" : "Terminé"} le ${fmt(r.quand)}` : fmt(r.quand)}
                    {echu && <span className="ml-1 font-medium text-warning">— échu</span>}
                    {r.source === "assistant" && <span className="ml-1">· posé par l&apos;assistant</span>}
                  </p>
                  {r.recurrence && (
                    <p className="text-xs text-muted-foreground"><Repeat className="mr-1 inline h-3 w-3" aria-hidden />{r.recurrence}</p>
                  )}
                  {r.note && <p className="mt-0.5 line-clamp-3 break-words text-xs text-muted-foreground">{r.note}</p>}
                  {r.lien && (
                    <Link href={r.lien} className="mt-0.5 inline-flex items-center gap-1 py-1 text-xs text-primary hover:underline sm:py-0">
                      <ExternalLink className="h-3 w-3" aria-hidden /> Ouvrir
                    </Link>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {busy && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" aria-hidden />}
                  {r.source === "perso" && (onglet === "a_venir" || onglet === "echus") && (
                    <>
                      <button type="button" title="Terminé" aria-label="Marquer terminé" disabled={busy} onClick={() => act(completeReminder, r, "Rappel terminé.")} className="rounded border border-success/40 p-2 text-success hover:bg-success/10 sm:p-1"><Check className="h-3.5 w-3.5" /></button>
                      <button type="button" title="Reporter à demain 9 h" aria-label="Reporter à demain 9 h" disabled={busy} onClick={() => act(snoozeReminder, r, "Rappel reporté à demain 9 h.", { remindAt: demainNeufHeures() })} className="rounded border border-border p-2 hover:bg-accent sm:p-1"><Clock className="h-3.5 w-3.5" /></button>
                      <button type="button" title="Annuler" aria-label="Annuler le rappel" disabled={busy} onClick={() => act(cancelReminder, r, "Rappel annulé.")} className="rounded border border-border p-2 text-muted-foreground hover:bg-accent sm:p-1"><X className="h-3.5 w-3.5" /></button>
                    </>
                  )}
                  {r.source === "assistant" && r.statut === "ACTIVE" && (
                    <button type="button" title="Arrêter ce rappel" aria-label="Arrêter ce rappel de l'assistant" disabled={busy} onClick={() => act(arreterRappelAssistant, r, "Rappel arrêté.")} className="rounded border border-border p-2 text-muted-foreground hover:bg-accent sm:p-1"><X className="h-3.5 w-3.5" /></button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {limite && (liste.length > visibles.length || rappels.length > 0) && (
        <Link href="/mon-espace/rappels" className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
          {liste.length > visibles.length ? `Voir les ${liste.length} — tous mes rappels` : "Tous mes rappels"} <ArrowRight className="h-3 w-3" aria-hidden />
        </Link>
      )}
    </div>
  );
}
