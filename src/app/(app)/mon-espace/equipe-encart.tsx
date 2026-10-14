"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { relanceTaskRequest } from "@/lib/actions/task-actions";
import type { MembreEncart } from "@/lib/espace/aujourdhui";

/**
 * MON ÉQUIPE, EN ENCART — qui est en retard, sur quoi ; et la relance en un clic quand elle EXISTE :
 * celle d'une tâche que vous avez demandée à cette personne (`relanceTaskRequest`, qui rejoue la règle
 * `peutRelancer` — demandeur seul, délai de courtoisie). Sans tâche relançable, pas de bouton : on ne
 * promet pas un geste que le serveur refuserait. Le détail vit dans « Mon équipe ».
 */
export function EquipeEncart({ membres, personnesEnRetard, retards }: { membres: MembreEncart[]; personnesEnRetard: number; retards: number }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [faits, setFaits] = React.useState<Record<string, string>>({});

  async function relancer(m: MembreEncart) {
    if (!m.relanceTacheId) return;
    setBusy(m.employeeId);
    const fd = new FormData();
    fd.set("id", m.relanceTacheId);
    const r = await relanceTaskRequest(fd);
    setBusy(null);
    setFaits((f) => ({ ...f, [m.employeeId]: r.ok ? "Relancé" : r.error ?? "Relance refusée" }));
    if (r.ok) router.refresh();
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        {personnesEnRetard > 0
          ? `${personnesEnRetard} personne${personnesEnRetard > 1 ? "s" : ""} en retard · ${retards} tâche${retards > 1 ? "s" : ""} au total`
          : "Personne n'a de tâche en retard."}
      </p>
      <ul className="divide-y divide-border">
        {membres.map((m) => (
          <li key={m.employeeId} className="grid grid-cols-[32px_minmax(0,1fr)] gap-x-2.5 gap-y-1 py-2 first:pt-0">
            <span className="row-span-2 grid h-8 w-8 place-items-center rounded-full bg-primary/10 text-[11px] font-bold text-primary" aria-hidden>{m.initiales}</span>
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
              <span className="min-w-0 break-words text-sm font-medium">{m.nom}</span>
              {m.enRetard > 0 && <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-[11px] font-semibold text-destructive">{m.enRetard} en retard</span>}
              {m.statut && <span className="rounded-full bg-accent px-2 py-0.5 text-[11px] font-semibold text-accent-foreground">{m.statut}</span>}
            </div>
            <div className="col-start-2 flex flex-wrap items-center justify-between gap-2">
              <span className="min-w-0 break-words text-xs text-muted-foreground">{m.bloque}</span>
              {faits[m.employeeId] ? (
                <span className="text-xs text-muted-foreground" role="status">{faits[m.employeeId]}</span>
              ) : m.relanceTacheId ? (
                <button
                  type="button"
                  onClick={() => relancer(m)}
                  disabled={busy !== null}
                  title="Relancer la plus ancienne tâche en retard que vous lui avez demandée"
                  className="inline-flex h-8 items-center gap-1 rounded-md border border-border px-2.5 text-xs font-medium hover:bg-secondary disabled:opacity-50"
                >
                  {busy === m.employeeId && <Loader2 className="h-3 w-3 animate-spin" aria-hidden />} Relancer
                </button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      <Link href="/mon-equipe" className="inline-flex text-xs text-primary hover:underline">Toute l&apos;équipe</Link>
    </div>
  );
}
