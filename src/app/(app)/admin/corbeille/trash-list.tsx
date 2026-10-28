"use client";

import * as React from "react";
import { Loader2, Undo2, Flame, Paperclip } from "lucide-react";
import { restoreDeletedRecord, destroyDeletedRecord } from "@/lib/actions/admin-delete-actions";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatDateTime } from "@/lib/utils";
import { BoutonDecisif } from "@/components/ui/bouton-decisif";
import { Retour } from "@/components/ui/retour";
import { useKeyedAction } from "@/components/shared/use-action";

export interface TrashItem {
  id: string;
  kind: string;
  label: string;
  name: string;
  deletedAt: string;
  deletedBy: string | null;
  restoredAt: string | null;
  documents: number;
  /** Ce qui est parti AVEC l'élément et revient avec lui (lot, §118.162) — vide sinon. */
  emportes: string[];
}

export function TrashList({ items, peutDetruire = true }: {
  items: TrashItem[];
  /** Détruire pour de bon (irréversible) reste au seul Super Admin : la corbeille du directeur des opérations restaure seulement. */
  peutDetruire?: boolean;
}) {
  const geste = useKeyedAction();
  const busyId = geste.busy;
  const err = geste.error;

  async function run(item: TrashItem, action: "restore" | "destroy") {
    const fd = new FormData(); fd.set("id", item.id);
    await geste.run(item.id, async () => {
      const r = action === "restore" ? await restoreDeletedRecord(fd) : await destroyDeletedRecord(fd);
      return r.ok ? r : { ok: false, error: r.error ?? (action === "restore" ? "La restauration n'a pas abouti." : "La destruction n'a pas abouti.") };
    });
  }

  return (
    <div className="space-y-2">
      <Retour ton="erreur">{err}</Retour>
      <div className="surface divide-y divide-border">
        {items.map((it) => (
          <div key={it.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5 sm:px-4">
            <div className="min-w-0 flex-1 basis-56">
              <p className="text-sm font-medium [overflow-wrap:anywhere]">
                {it.name}
                {it.documents > 0 && <span className="ml-2 inline-flex items-center gap-1 text-xs text-muted-foreground"><Paperclip className="h-3.5 w-3.5" /> {it.documents}</span>}
              </p>
              <p className="text-xs text-muted-foreground">
                {it.label} · supprimé le {formatDateTime(it.deletedAt)}{it.deletedBy ? ` par ${it.deletedBy}` : ""}
              </p>
              {it.emportes.length > 0 && (
                <p className="text-xs text-muted-foreground">Parti avec lui, revient avec lui : {it.emportes.join(", ")}</p>
              )}
            </div>
            {it.restoredAt ? (
              <Badge tone="success" dot={false}>Restauré le {formatDateTime(it.restoredAt)}</Badge>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                <BoutonDecisif size="sm" variant="outline" disabled={busyId !== null} onClick={() => run(it, "restore")} confirmation={`restaurer ${it.label} « ${it.name} »${it.emportes.length ? ` avec ${it.emportes.join(", ")}` : ""}`}>
                  {busyId === it.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Undo2 className="h-4 w-4" />} Restaurer
                </BoutonDecisif>
                {peutDetruire && <BoutonDecisif size="sm" variant="outline" disabled={busyId !== null} onClick={() => run(it, "destroy")} className="text-destructive hover:bg-destructive/10" confirmation={`détruire DÉFINITIVEMENT ${it.label} « ${it.name} » (irréversible)`}>
                  <Flame className="h-4 w-4" /> Détruire
                </BoutonDecisif>}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
