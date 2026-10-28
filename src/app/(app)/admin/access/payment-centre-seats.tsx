"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ShieldCheck, Loader2, UserPlus, X, AlertCircle, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select, Label } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { grantPaymentCentreSeat, revokePaymentCentreSeat } from "@/modules/finances/actions-sieges";

export interface SeatHolder {
  userId: string;
  name: string;
  role: string;
  note: string | null;
  grantedBy: string | null;
  grantedAt: string;
}

export interface SeatCandidate {
  id: string;
  name: string;
  role: string;
}

/**
 * LE CERCLE DU CENTRE DE PAIEMENT — qui y siège, et par quel titre.
 *
 * ── POURQUOI CET ÉCRAN EXISTE À CÔTÉ DE LA GRILLE DES MODULES ────────────────────────────────
 *
 * Parce que la grille NE SUFFISAIT PAS, et le laissait croire. Cocher `PAYMENT_CENTRE` pour
 * quelqu'un n'ouvrait rien : l'écran du centre ne consulte pas ce module, il consulte
 * `sitsOnPaymentCentre`, qui lisait le rôle et lui seul. L'administrateur cochait, la personne
 * trouvait une page vide, et aucun des deux n'avait de quoi comprendre.
 *
 * Le siège nommé est donc une DÉSIGNATION, pas une case : elle porte un nom, un motif, un auteur
 * et une date — parce qu'elle donne le pouvoir d'engager l'argent de la société.
 *
 * ── CE QU'ON MONTRE, ET POURQUOI LES DEUX ENSEMBLE ──────────────────────────────────────────
 *
 * Ceux qui siègent PAR LEUR RÔLE (PDG, Super Admin) et ceux qui siègent PAR DÉSIGNATION. Ne
 * montrer que les seconds ferait croire que le cercle se limite à eux — et l'on retirerait un
 * siège en pensant fermer une porte qui resterait grande ouverte.
 */
export function PaymentCentreSeats({
  seats, candidates, byRole,
}: {
  seats: SeatHolder[];
  candidates: SeatCandidate[];
  byRole: { id: string; name: string; role: string }[];
}) {
  const router = useRouter();
  const [userId, setUserId] = React.useState("");
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState<string | null>(null);
  const [err, setErr] = React.useState<string | null>(null);

  const run = async (key: string, fn: (fd: FormData) => Promise<{ ok: boolean; error?: string }>, fields: Record<string, string>) => {
    setBusy(key); setErr(null);
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    const r = await fn(fd);
    setBusy(null);
    if (!r.ok) { setErr(r.error ?? "L'opération a échoué."); return; }
    setUserId(""); setNote("");
    router.refresh();
  };

  return (
    <div className="space-y-4">
      <p className="flex items-start gap-2 rounded-lg border border-border bg-secondary/30 px-3 py-2 text-xs">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
        <span>
          Le siège donne <strong>exactement une chose</strong> : voir la file des autorisations de paiement et trancher.
          Aucun autre module, aucune vue globale, aucun droit sur les Finances. Cocher « Centre de paiement » dans la
          grille des modules ci-dessus <strong>n&apos;y suffit pas</strong> — c&apos;est cette liste qui fait foi.
        </span>
      </p>

      <div className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Par leur rôle</h3>
        {byRole.length === 0 ? (
          <p className="text-sm text-muted-foreground">Personne — ce qui veut dire que plus aucun paiement ne peut être autorisé.</p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {byRole.map((u) => (
              <li key={u.id} className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-sm">
                <ShieldCheck className="h-3.5 w-3.5 text-success" /> {u.name}
                <span className="text-xs text-muted-foreground">{u.role}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Désignés nommément ({seats.length})</h3>
        {seats.length === 0 ? (
          <p className="text-sm text-muted-foreground">Aucune désignation. Le cercle se limite aux rôles ci-dessus.</p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {seats.map((s) => (
              <li key={s.userId} className="flex flex-wrap items-start justify-between gap-2 px-3 py-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{s.name} <Badge tone="neutral" dot={false}>{s.role}</Badge></p>
                  {/* LE MOTIF SE LIT ICI, pas dans le journal d'audit : c'est en regardant cette
                      liste qu'on se demande si un siège a encore une raison d'être. */}
                  {s.note && <p className="text-xs text-muted-foreground">{s.note}</p>}
                  <p className="text-xs text-muted-foreground">Désigné par {s.grantedBy ?? "—"} · {s.grantedAt}</p>
                </div>
                <Button
                  size="sm" variant="outline" disabled={busy !== null}
                  onClick={() => void run(`revoke-${s.userId}`, revokePaymentCentreSeat, { userId: s.userId })}
                >
                  {busy === `revoke-${s.userId}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />} Retirer le siège
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-2 rounded-lg border border-border p-3">
        <Label>Désigner quelqu&apos;un</Label>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto]">
          <Select value={userId} onChange={(e) => setUserId(e.target.value)}>
            <option value="">Choisir une personne…</option>
            {candidates.map((c) => <option key={c.id} value={c.id}>{c.name} — {c.role}</option>)}
          </Select>
          <Input
            value={note} onChange={(e) => setNote(e.target.value)}
            placeholder="Pourquoi cette personne siège (obligatoire)"
          />
          <Button
            disabled={busy !== null || !userId || !note.trim()}
            title={!userId ? "Choisissez la personne." : !note.trim() ? "Le motif est obligatoire." : undefined}
            onClick={() => void run("grant", grantPaymentCentreSeat, { userId, note })}
          >
            {busy === "grant" ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />} Désigner
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Le motif est obligatoire : un siège dont on ne sait ni qui l&apos;a accordé ni pourquoi est un siège que
          personne n&apos;ose retirer. La personne est prévenue.
        </p>
      </div>

      {err && (
        <p className="flex items-center gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="h-4 w-4" /> {err}
        </p>
      )}
    </div>
  );
}
