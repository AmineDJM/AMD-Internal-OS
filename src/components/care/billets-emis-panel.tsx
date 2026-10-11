"use client";

import * as React from "react";
import { CheckCircle2, XCircle } from "lucide-react";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { resumeBillet, resumeHotel, type CellRow } from "@/lib/care-fiches";
import { BilletEmis, IconePoste, type Run } from "@/components/care/fiche-voyageur";

/**
 * LES BILLETS ÉMIS ET LES CONFIRMATIONS D'HÔTEL D'UNE PRISE EN CHARGE — l'écran de l'assistante de direction
 * (Direction, 10/2026) : une ligne par personne, chaque billet et chaque hôtel à réserver, et pour chacun le
 * dépôt de l'e-billet ou du voucher avec sa référence et ses horaires. Rien d'autre de la demande n'est ici.
 */
export function BilletsEmisPanel({ lignes }: { lignes: { id: string; name: string; postes: CellRow[] }[] }) {
  const { enCours, rafraichir } = useRafraichir();
  const [action, setAction] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);
  const busy = action ?? (enCours ? "rafraichir" : null);
  const run: Run = async (key, fn, okText) => {
    if (action) return { ok: false };
    setAction(key);
    setMsg(null);
    try {
      const r = await fn();
      setMsg({ ok: r.ok, text: r.ok ? (r.message ?? okText ?? "Enregistré.") : (r.error ?? "Échec.") });
      if (r.ok) rafraichir();
      return r;
    } finally {
      setAction(null);
    }
  };
  return (
    <div className="space-y-3">
      {msg && (
        <p className={`flex items-start gap-2 rounded-xl px-3 py-2 text-sm ${msg.ok ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive"}`}>
          {msg.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0" />} {msg.text}
        </p>
      )}
      {lignes.length === 0 && <p className="text-sm text-muted-foreground">Aucun billet ni hôtel à réserver sur cette demande.</p>}
      {lignes.map((l) => (
        <section key={l.id} className="rounded-xl border border-border bg-card">
          <p className="border-b border-border px-4 py-2.5 text-sm font-semibold [overflow-wrap:anywhere]">{l.name}</p>
          <div className="divide-y divide-border">
            {l.postes.map((c) => (
              <div key={c.id} className="space-y-2 px-4 py-3">
                <p className="flex flex-wrap items-center gap-2 text-sm">
                  <IconePoste kind={c.serviceKind} className="h-4 w-4 text-muted-foreground" />
                  <span className="font-medium">{c.label}</span>
                  <span className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{c.serviceKind === "TICKET" ? resumeBillet(c) : resumeHotel(c)}</span>
                </p>
                <BilletEmis c={c} busy={busy} run={run} />
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
