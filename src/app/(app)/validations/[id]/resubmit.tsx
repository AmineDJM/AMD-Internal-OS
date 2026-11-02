"use client";

import * as React from "react";
import { Loader2, RotateCcw } from "lucide-react";
import { resoumettreValidation } from "@/lib/actions/validation-actions";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";

/**
 * RESOUMETTRE UNE DEMANDE RENVOYÉE (audit 360°, R08) — sur elle-même, et elle reprend à l'étape
 * qui l'a renvoyée.
 *
 * Ce qui a été corrigé est EXIGÉ : c'est la première chose que le validateur lira. Le texte et le
 * montant reviennent pré-remplis : on corrige ce qu'il faut, on ne retape rien — et ce qu'on ne
 * touche pas reste ce qu'il était. Les pièces ajoutées rejoignent celles de la demande.
 */
export function ResubmitValidation({ id, description, montant }: {
  id: string; description: string | null; montant: number | null;
}) {
  const { enCours, rafraichir } = useRafraichir();
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [note, setNote] = React.useState("");

  return (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true); setErr(null);
        const fd = new FormData(e.currentTarget);
        fd.set("id", id);
        try {
          const r = await resoumettreValidation(fd);
          if (!r.ok) { setErr(r.error ?? "Resoumission impossible."); return; }
          rafraichir();
        } catch {
          setErr(actionFailureMessage("THROWN"));
        } finally {
          setBusy(false);
        }
      }}
    >
      <label className="block space-y-1 text-sm">
        <span className="font-medium">Ce que vous avez corrigé</span>
        <Textarea name="note" required value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ex. : montant corrigé, devis signé joint…" className="min-h-[60px]" />
      </label>
      <label className="block space-y-1 text-sm">
        <span className="font-medium">Détails de la demande</span>
        <Textarea name="description" defaultValue={description ?? ""} className="min-h-[80px]" />
      </label>
      {montant !== null && (
        <label className="block space-y-1 text-sm">
          <span className="font-medium">Montant (DZD)</span>
          <Input name="amount" type="number" inputMode="decimal" min={0} step="any" defaultValue={String(montant)} />
          <span className="block text-xs text-muted-foreground">Relevé, il fait repartir les accords déjà donnés : un accord ne couvre pas plus que ce qu&apos;il a vu.</span>
        </label>
      )}
      <label className="block space-y-1 text-sm">
        <span className="font-medium">Pièces à ajouter</span>
        <Input name="files" type="file" multiple />
      </label>
      {err && <p className="text-xs text-destructive">{err}</p>}
      <Button type="submit" size="sm" className="w-full sm:w-auto" disabled={busy || enCours || !note.trim()}>
        {busy || enCours ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />} Resoumettre
      </Button>
    </form>
  );
}
