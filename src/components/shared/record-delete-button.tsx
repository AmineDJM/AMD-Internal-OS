"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Trash2, Loader2, AlertTriangle } from "lucide-react";
import { deleteOwnRecord } from "@/lib/actions/admin-delete-actions";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";

/**
 * Bouton « Supprimer » posé sur la fiche d'un objet que SON CRÉATEUR a le droit de retirer
 * (courrier, document légal). N'est rendu que si `enabled` — mais le serveur revérifie de toute
 * façon le créateur et le type.
 *
 * Le ton diffère volontairement de la suppression Super Admin : ici la suppression est
 * **réversible** (elle passe par la corbeille de l'administrateur), donc on ne brandit pas
 * « irréversible ». On dit la vérité — retiré de vos listes, récupérable par un administrateur —
 * pour que la personne supprime sans peur un doublon, et sans croire non plus qu'elle a tout effacé.
 */
export function RecordDeleteButton({
  kind,
  id,
  name,
  enabled,
  label = "Supprimer",
  typeLabel = "élément",
}: {
  kind: string;
  id: string;
  name: string;
  enabled: boolean;
  label?: string;
  /** « ce courrier », « ce document » — pour une phrase juste. */
  typeLabel?: string;
}) {
  const router = useRouter();
  const { rafraichir } = useRafraichir();
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  if (!enabled) return null;

  async function confirmDelete() {
    setBusy(true);
    setError(null);
    const fd = new FormData();
    fd.set("kind", kind);
    fd.set("id", id);
    try {
      const r = await deleteOwnRecord(fd);
      if (r.ok) {
        setOpen(false);
        router.push(r.redirect ?? "/mon-espace");
        rafraichir();
      } else {
        setBusy(false);
        setError(r.error ?? "Suppression impossible.");
      }
    } catch {
      setBusy(false);
      setError(actionFailureMessage("THROWN"));
    }
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)} className="text-destructive hover:bg-destructive/10">
        <Trash2 className="h-4 w-4" /> {label}
      </Button>

      <Sheet
        open={open}
        onClose={() => !busy && setOpen(false)}
        title={`Supprimer ${typeLabel}`}
        description="Retiré de vos listes — un administrateur peut le restaurer."
      >
        <div className="space-y-4">
          <div className="flex gap-3 rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm text-warning">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
            <div className="space-y-1">
              <p className="font-medium">{`Ce ${typeLabel === "élément" ? "élément" : typeLabel.replace(/^ce[t]? /, "")} disparaîtra de vos listes.`}</p>
              <p>Ses pièces jointes et commentaires partent avec lui. La suppression est <span className="font-semibold">réversible</span> : un administrateur peut la restaurer depuis la corbeille.</p>
            </div>
          </div>

          <div className="rounded-lg border border-border bg-secondary/40 px-3 py-2 text-sm">
            <p className="text-xs text-muted-foreground">À supprimer</p>
            <p className="break-words font-medium">{name}</p>
          </div>

          {error && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}

          <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
            <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
              Annuler
            </Button>
            <Button variant="destructive" onClick={confirmDelete} disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              Supprimer
            </Button>
          </div>
        </div>
      </Sheet>
    </>
  );
}
