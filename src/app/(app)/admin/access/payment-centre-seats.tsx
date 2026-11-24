"use client";

import { ShieldCheck, Loader2, X, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Retour } from "@/components/ui/retour";
import { useKeyedAction } from "@/components/shared/use-action";
import { revokePaymentCentreSeat } from "@/modules/finances/actions-sieges";

export interface SeatHolder {
  userId: string;
  name: string;
  role: string;
  note: string | null;
  grantedBy: string | null;
  grantedAt: string;
}

/**
 * QUI DÉCIDE AU CENTRE DE PAIEMENT — la Direction générale, et elle seule (Super Admin, 24/11/2026).
 *
 * Le centre est réservé au Super Admin et au Directeur Général (`sitsOnPaymentCentre`) : aucun siège par pôle, aucune
 * désignation nommée. La console peut seulement le FERMER au Directeur Général (module « Centre de paiement » bloqué
 * dans la grille) ; elle ne l'ouvre à personne d'autre. Les désignations d'hier restent en base, SANS EFFET : on les
 * montre pour pouvoir les retirer, pas pour en ajouter.
 */
export function PaymentCentreSeats({
  seats, byRole,
}: {
  seats: SeatHolder[];
  byRole: { id: string; name: string; role: string }[];
}) {
  const geste = useKeyedAction();
  const busy = geste.busy;
  const err = geste.error;

  const retirer = (userId: string) => {
    const fd = new FormData();
    fd.set("userId", userId);
    void geste.run(`revoke-${userId}`, () => revokePaymentCentreSeat(fd));
  };

  return (
    <div className="space-y-4">
      <p className="flex items-start gap-2 rounded-lg border border-border bg-secondary/30 px-3 py-2 text-xs">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
        <span>
          Le centre de paiement est réservé à la <strong>Direction générale</strong> : le Super Admin et le Directeur Général.
          On n&apos;y désigne personne d&apos;autre. Bloquer le module « Centre de paiement » dans la grille ci-dessus le ferme
          au Directeur Général ; rien ne l&apos;ouvre à un autre compte.
        </span>
      </p>

      <div className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Décident au centre</h3>
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

      {seats.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Anciennes désignations, sans effet ({seats.length})</h3>
          <ul className="divide-y divide-border rounded-lg border border-border">
            {seats.map((s) => (
              <li key={s.userId} className="flex flex-wrap items-start justify-between gap-2 px-3 py-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{s.name} <Badge tone="neutral" dot={false}>{s.role}</Badge></p>
                  {s.note && <p className="text-xs text-muted-foreground">{s.note}</p>}
                  <p className="text-xs text-muted-foreground">Désigné par {s.grantedBy ?? "—"} · {s.grantedAt}</p>
                </div>
                <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => retirer(s.userId)}>
                  {busy === `revoke-${s.userId}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />} Retirer
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <Retour ton="erreur">{err}</Retour>
    </div>
  );
}
