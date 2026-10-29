"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";
import { createReminder } from "@/lib/actions/reminder-actions";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";

/**
 * AJOUT RAPIDE D'UN RAPPEL — une ligne, un moment, « Ajouter ». La MÊME action que « Me rappeler »
 * (`createReminder`) : un rappel n'a qu'un circuit. Les moments se calculent à l'heure LOCALE du
 * navigateur, au clic (jamais à l'affichage : une page ouverte depuis le matin proposerait « dans 1 h »
 * d'il y a trois heures).
 */
const MOMENTS: { cle: string; label: string; at: (n: Date) => Date }[] = [
  { cle: "1h", label: "Dans 1 heure", at: (n) => new Date(n.getTime() + 3_600_000) },
  { cle: "soir", label: "Ce soir (18 h)", at: (n) => { const d = new Date(n); d.setHours(18, 0, 0, 0); return d; } },
  { cle: "demain", label: "Demain (9 h)", at: (n) => { const d = new Date(n); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); return d; } },
  { cle: "3j", label: "Dans 3 jours", at: (n) => { const d = new Date(n); d.setDate(d.getDate() + 3); d.setHours(9, 0, 0, 0); return d; } },
];

export function RappelRapide() {
  const { rafraichir } = useRafraichir();
  const [titre, setTitre] = React.useState("");
  const [moment, setMoment] = React.useState("demain");
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<{ ok: boolean; t: string } | null>(null);

  async function envoyer(e: React.FormEvent) {
    e.preventDefault();
    const t = titre.trim();
    if (!t) { setMsg({ ok: false, t: "Écrivez d'abord de quoi vous rappeler." }); return; }
    const now = new Date();
    let at = (MOMENTS.find((m) => m.cle === moment) ?? MOMENTS[0]).at(now);
    // « Ce soir » passé 18 h : demain soir, plutôt qu'un rappel déjà échu que le serveur refuserait.
    if (at.getTime() <= now.getTime() + 60_000) at = new Date(at.getTime() + 86_400_000);
    setBusy(true); setMsg(null);
    const fd = new FormData();
    fd.set("title", t);
    fd.set("remindAt", at.toISOString());
    fd.set("link", "/mon-espace");
    try {
      const r = await createReminder(fd);
      if (r.ok) { setTitre(""); setMsg({ ok: true, t: "Rappel ajouté." }); rafraichir(); }
      else setMsg({ ok: false, t: r.error ?? "Le rappel n'a pas pu être créé." });
    } catch {
      setMsg({ ok: false, t: actionFailureMessage("THROWN") });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={envoyer} className="grid grid-cols-2 gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
      <input
        type="text"
        value={titre}
        onChange={(e) => setTitre(e.target.value)}
        placeholder="Me rappeler de…"
        aria-label="Texte du rappel"
        maxLength={200}
        className="col-span-2 h-9 min-w-0 rounded-md border border-border bg-background px-2.5 text-sm outline-none focus:ring-2 focus:ring-ring sm:col-span-1"
      />
      <select
        value={moment}
        onChange={(e) => setMoment(e.target.value)}
        aria-label="Quand"
        className="h-9 min-w-0 rounded-md border border-border bg-background px-2 text-sm"
      >
        {MOMENTS.map((m) => <option key={m.cle} value={m.cle}>{m.label}</option>)}
      </select>
      <button
        type="submit"
        disabled={busy}
        className="inline-flex h-9 items-center justify-center gap-1 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
      >
        {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />} Ajouter
      </button>
      {msg && <p role="status" className={`col-span-2 text-xs sm:col-span-3 ${msg.ok ? "text-success" : "text-destructive"}`}>{msg.t}</p>}
    </form>
  );
}
