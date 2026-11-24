"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";
import { createReminder } from "@/lib/actions/reminder-actions";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";

/**
 * AJOUT RAPIDE D'UN RAPPEL — « Me rappeler de… », « Quand », « Ajouter ». La MÊME action que « Me rappeler »
 * (`createReminder`) : un rappel n'a qu'un circuit. Les moments se calculent à l'heure LOCALE du navigateur,
 * au clic (jamais à l'affichage : une page ouverte depuis le matin proposerait « dans 1 h » d'il y a trois heures).
 *
 * « CE SOIR » APRÈS 18 H (maquette validée, 24/11/2026) : le rappel partait déjà pour le lendemain soir, mais le
 * choix disait encore « Ce soir ». Le libellé suit l'heure — relue à l'ouverture de la liste des choix.
 */
const SOIR = 18;
const MOMENTS: { cle: string; label: (apresSoir: boolean) => string; at: (n: Date) => Date }[] = [
  { cle: "demain", label: () => "Demain à 9 h", at: (n) => { const d = new Date(n); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); return d; } },
  { cle: "1h", label: () => "Dans 1 heure", at: (n) => new Date(n.getTime() + 3_600_000) },
  {
    cle: "soir",
    label: (apresSoir) => (apresSoir ? "Demain soir à 18 h" : "Ce soir à 18 h"),
    at: (n) => { const d = new Date(n); d.setHours(SOIR, 0, 0, 0); if (d.getTime() <= n.getTime() + 60_000) d.setDate(d.getDate() + 1); return d; },
  },
  { cle: "3j", label: () => "Dans 3 jours", at: (n) => { const d = new Date(n); d.setDate(d.getDate() + 3); d.setHours(9, 0, 0, 0); return d; } },
];

export interface RappelCree {
  id: string;
  titre: string;
  quand: string;
}

export function RappelRapide({ onCree }: { onCree?: (r: RappelCree) => void } = {}) {
  const { rafraichir } = useRafraichir();
  const [titre, setTitre] = React.useState("");
  const [moment, setMoment] = React.useState("demain");
  // « Choisir une date… » (recette du 23/11/2026) : le jour et l'heure exacts, à l'heure du navigateur.
  const [precis, setPrecis] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<{ ok: boolean; t: string } | null>(null);
  // Lu après le montage (le serveur ne connaît pas l'heure du navigateur), puis à chaque ouverture des choix.
  const [apresSoir, setApresSoir] = React.useState(false);
  const relireHeure = React.useCallback(() => setApresSoir(new Date().getHours() >= SOIR), []);
  React.useEffect(relireHeure, [relireHeure]);
  const idTexte = React.useId();
  const idQuand = React.useId();

  async function envoyer(e: React.FormEvent) {
    e.preventDefault();
    const t = titre.trim();
    if (!t) { setMsg({ ok: false, t: "Écrivez d'abord de quoi vous rappeler." }); return; }
    const now = new Date();
    let at: Date;
    if (moment === "precis") {
      // `datetime-local` se lit à l'heure du navigateur : « 2026-11-24T14:30 » est 14 h 30 ICI.
      at = new Date(precis);
      if (!precis || Number.isNaN(at.getTime())) { setMsg({ ok: false, t: "Choisissez le jour et l'heure du rappel." }); return; }
      if (at.getTime() <= now.getTime()) { setMsg({ ok: false, t: "Ce moment est déjà passé : choisissez une date à venir." }); return; }
    } else {
      at = (MOMENTS.find((m) => m.cle === moment) ?? MOMENTS[0]).at(now);
    }
    setBusy(true); setMsg(null);
    const fd = new FormData();
    fd.set("title", t);
    fd.set("remindAt", at.toISOString());
    fd.set("link", "/mon-espace");
    try {
      const r = await createReminder(fd);
      if (r.ok) {
        setTitre(""); setPrecis("");
        setMsg({ ok: true, t: `Rappel ajouté pour le ${at.toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short" })}.` });
        if (r.id) onCree?.({ id: r.id, titre: t, quand: at.toISOString() });
        rafraichir();
      }
      else setMsg({ ok: false, t: r.error ?? "Le rappel n'a pas pu être créé." });
    } catch {
      setMsg({ ok: false, t: actionFailureMessage("THROWN") });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={envoyer} className="flex flex-col gap-2">
      <label htmlFor={idTexte} className="text-xs font-semibold text-muted-foreground">Me rappeler de…</label>
      <input
        id={idTexte}
        type="text"
        value={titre}
        onChange={(e) => setTitre(e.target.value)}
        placeholder="Rappeler le CHU de Blida"
        maxLength={200}
        className="h-10 min-w-0 rounded-[var(--radius)] border border-border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
      />
      <div className="flex gap-2">
        <label htmlFor={idQuand} className="sr-only">Quand</label>
        <select
          id={idQuand}
          value={moment}
          onChange={(e) => setMoment(e.target.value)}
          onFocus={relireHeure}
          onPointerDown={relireHeure}
          className="h-10 min-w-0 flex-1 rounded-[var(--radius)] border border-border bg-background px-2 text-sm"
        >
          {MOMENTS.map((m) => <option key={m.cle} value={m.cle}>{m.label(apresSoir)}</option>)}
          <option value="precis">Choisir une date…</option>
        </select>
        <button
          type="submit"
          disabled={busy}
          className="inline-flex h-10 shrink-0 items-center justify-center gap-1 rounded-[var(--radius)] bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-ring disabled:opacity-50"
        >
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />} Ajouter
        </button>
      </div>
      {moment === "precis" && (
        <input
          type="datetime-local"
          value={precis}
          onChange={(e) => setPrecis(e.target.value)}
          aria-label="Jour et heure du rappel"
          className="h-10 min-w-0 rounded-[var(--radius)] border border-border bg-background px-2 text-sm"
        />
      )}
      {msg && <p role="status" className={`text-xs ${msg.ok ? "text-success" : "text-destructive"}`}>{msg.t}</p>}
    </form>
  );
}
