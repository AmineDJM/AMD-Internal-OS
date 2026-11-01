"use client";

import * as React from "react";
import { Loader2, Check, X } from "lucide-react";
import { decideAdvance } from "@/modules/rh/actions";
import { StatusBadge } from "@/components/shared/status-badge";
import { Badge } from "@/components/ui/badge";
import { InfoBulle } from "@/components/ui/info-bulle";
import { ADVANCE_STATUS } from "@/lib/labels";
import { formatCurrency, formatDate, initials, cn } from "@/lib/utils";
import { BoutonDecisif } from "@/components/ui/bouton-decisif";

export interface AdvanceRow {
  id: string;
  employee: string;
  amount: number;
  reason: string | null;
  status: string;
  createdAt: string;
}

function DecideButton({ id, decision, label, icon: IconCmp, danger }: { id: string; decision: "APPROVED" | "REJECTED"; label: string; icon: typeof Check; danger?: boolean }) {
  const [saving, setSaving] = React.useState(false);
  return (
    <form action={async (fd) => { setSaving(true); await decideAdvance(fd); setSaving(false); }} className="inline">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="decision" value={decision} />
      <BoutonDecisif brut type="submit" disabled={saving}
        className={cn("inline-flex min-h-9 items-center gap-1 rounded-md border px-3 py-1.5 text-xs font-medium disabled:opacity-50 sm:min-h-0 sm:px-2.5 sm:py-1",
          danger ? "border-border text-destructive hover:bg-destructive/10" : "border-success/30 text-success hover:bg-success/10")}>
        {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <IconCmp className="h-3.5 w-3.5" />} {label}
      </BoutonDecisif>
    </form>
  );
}

const jour = (iso: string) => formatDate(iso, { day: "numeric", month: "short" });

/**
 * LES AVANCES SUR SALAIRE — une carte compacte sur la page de paie (maquette « Paie », 07/10) : une
 * ligne par avance à trancher (Accorder / Refuser — `decideAdvance`, inchangé), l'historique replié.
 */
export function AdvanceApprovals({ rows }: { rows: AdvanceRow[] }) {
  const aTrancher = rows.filter((r) => r.status === "PENDING");
  const tranchees = rows.filter((r) => r.status !== "PENDING");

  return (
    <section className="surface" aria-labelledby="avances-titre">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-3 sm:px-4">
        <h2 id="avances-titre" className="flex items-center gap-1 text-sm font-semibold">
          Avances sur salaire
          <InfoBulle label="Les avances sur salaire" align="left">
            Une fois accordée, un ordre de dépense est transmis au comptable pour règlement.
          </InfoBulle>
        </h2>
        {aTrancher.length > 0
          ? <Badge tone="warning" dot={false}>{aTrancher.length} à trancher</Badge>
          : <Badge tone="neutral" dot={false}>Rien à trancher</Badge>}
      </div>

      {aTrancher.length === 0 ? (
        <p className="px-3 py-3 text-sm text-muted-foreground sm:px-4">Aucune avance en attente.</p>
      ) : (
        <ul className="divide-y divide-border">
          {aTrancher.map((r) => (
            <li key={r.id} className="grid grid-cols-1 items-center gap-2 px-3 py-2.5 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:gap-4 sm:px-4">
              <Qui nom={r.employee} detail={`${r.reason ? `« ${r.reason} » · ` : ""}demandé le ${jour(r.createdAt)}`} titre={r.reason ?? undefined} />
              <span className="text-sm font-semibold tabular-nums sm:text-right">{formatCurrency(r.amount)}</span>
              <div className="flex flex-wrap items-center gap-1.5 sm:justify-end">
                <DecideButton id={r.id} decision="APPROVED" label="Accorder" icon={Check} />
                <DecideButton id={r.id} decision="REJECTED" label="Refuser" icon={X} danger />
              </div>
            </li>
          ))}
        </ul>
      )}

      {tranchees.length > 0 && (
        <details className="group border-t border-border">
          <summary className="cursor-pointer list-none px-3 py-2.5 text-xs font-medium text-muted-foreground hover:text-foreground sm:px-4">
            <span className="group-open:hidden">Voir l&apos;historique ({tranchees.length})</span>
            <span className="hidden group-open:inline">Masquer l&apos;historique</span>
          </summary>
          <ul className="divide-y divide-border border-t border-border">
            {tranchees.map((r) => (
              <li key={r.id} className="grid grid-cols-1 items-center gap-2 px-3 py-2 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:gap-4 sm:px-4">
                <Qui nom={r.employee} detail={`${r.reason ? `« ${r.reason} » · ` : ""}${jour(r.createdAt)}`} titre={r.reason ?? undefined} />
                <span className="text-sm tabular-nums sm:text-right">{formatCurrency(r.amount)}</span>
                <span className="flex flex-wrap items-center gap-1.5 sm:justify-end">
                  <StatusBadge map={ADVANCE_STATUS} value={r.status} />
                  {r.status === "APPROVED" && <span className="text-xs text-muted-foreground">ordre transmis au comptable</span>}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function Qui({ nom, detail, titre }: { nom: string; detail: string; titre?: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <span aria-hidden className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[0.6875rem] font-semibold text-primary">
        {initials(nom || "?")}
      </span>
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{nom}</p>
        <p className="truncate text-xs text-muted-foreground" title={titre}>{detail}</p>
      </div>
    </div>
  );
}
