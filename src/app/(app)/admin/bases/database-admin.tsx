"use client";

import * as React from "react";
import { Trash2, Loader2, Recycle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAction } from "@/components/shared/use-action";
import { formatBytes as fmtBytes } from "@/lib/utils";
import { purgeOrphanStorage, permanentlyDeleteDriveNode, permanentlyDeleteDocument } from "@/lib/actions/database-admin-actions";

/** Ramasse-miettes : détruit les blobs orphelins → libère l'espace disque réellement. */
export function PurgeOrphansButton({ count, bytes }: { count: number; bytes: number }) {
  // Le bouton n'a pas de place où parler : un refus part en avis flottant.
  const geste = useAction({ signalerErreurs: true });
  const busy = geste.busy;
  const [done, setDone] = React.useState<string | null>(null);
  const run = async () => {
    let bilan = "";
    await geste.run(async () => {
      setDone(null);
      const r = await purgeOrphanStorage();
      if (r.ok) bilan = `${r.count ?? 0} blob·s détruits · ${fmtBytes(r.bytes ?? 0)} libérés.`;
      return r.ok ? r : { ok: false, error: r.error ?? "Le stockage orphelin n'a pas été purgé." };
    }, () => setDone(bilan), {
      confirmer: `Détruire définitivement ${count} blob·s orphelins (${fmtBytes(bytes)}) ? Cette opération libère l'espace disque et est irréversible.`,
    });
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="outline" onClick={run} disabled={busy || count === 0} className="h-auto min-h-10 w-full whitespace-normal sm:w-auto">
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Recycle className="h-4 w-4" />}
        Purger le stockage orphelin{count > 0 ? ` (${fmtBytes(bytes)})` : ""}
      </Button>
      {done && <span className="text-sm text-success">{done}</span>}
      {count === 0 && !done && <span className="text-sm text-muted-foreground">Aucun blob orphelin — rien à libérer.</span>}
    </div>
  );
}

/** Suppression DÉFINITIVE d'un fichier/dossier Drive ou d'un document (libère le stockage). */
export function PermanentDeleteButton({ kind, id, name }: { kind: "drive" | "document"; id: string; name: string }) {
  // L'icône n'a pas de place où parler : un refus part en avis flottant.
  const { busy, run: executer } = useAction({ signalerErreurs: true });
  const run = async () => {
    const fd = new FormData(); fd.set("id", id);
    await executer(async () => {
      const r = kind === "drive" ? await permanentlyDeleteDriveNode(fd) : await permanentlyDeleteDocument(fd);
      return r.ok ? r : { ok: false, error: r.error ?? "La suppression définitive n'a pas abouti." };
    }, undefined, {
      confirmer: `Supprimer DÉFINITIVEMENT « ${name} » ?\nCette action est irréversible et libère le stockage. ${kind === "drive" ? "Un dossier emporte tout son contenu." : ""}`,
    });
  };
  return (
    <button title="Supprimer définitivement" aria-label={`Supprimer définitivement « ${name} »`} onClick={run} disabled={busy} className="rounded-lg p-2.5 text-muted-foreground sm:p-1.5 hover:bg-destructive/10 hover:text-destructive disabled:opacity-50">
      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
    </button>
  );
}
