"use client";

import * as React from "react";
import { UserPlus, Loader2 } from "lucide-react";
import { requestThirdPartyInput } from "@/lib/actions/congress-request-actions";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { Select, Textarea, Label } from "@/components/ui/input";
import { useAction } from "@/components/shared/use-action";
import { Retour } from "@/components/ui/retour";

/**
 * « Impliquer une tierce personne » pour un congrès (INTL / NATIONAL) ou un
 * événement (EVENT). La personne reçoit une demande dans SON espace et un dossier
 * de suivi indiquant l'événement — sans budget ni accès au module.
 */
export function ThirdPartyInvolveButton({ type, id, people }: { type: string; id: string; people: { id: string; name: string }[] }) {
  const [open, setOpen] = React.useState(false);
  const { busy, err, run } = useAction();

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}><UserPlus className="h-4 w-4" /> Impliquer une tierce personne</Button>
      <Sheet open={open} onClose={() => setOpen(false)} title="Impliquer une tierce personne" description="La personne recevra une demande dans son espace et un sujet indiquant l'événement — sans détail de budget, et sans accès au module." width="md">
        <form
          action={async (fd) => {
            fd.set("type", type); fd.set("id", id);
            const demander = async () => {
              const r = await requestThirdPartyInput(fd);
              return r.ok ? r : { ...r, error: r.error ?? "La demande n'a pas été envoyée." };
            };
            await run(demander, () => setOpen(false));
          }}
          className="space-y-4"
        >
          <div className="space-y-1.5">
            <Label>Personne</Label>
            <Select name="personId" required defaultValue="">
              <option value="" disabled>— Choisir —</option>
              {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Message (optionnel)</Label>
            <Textarea name="note" rows={3} placeholder="Ce que vous attendez de cette personne…" />
          </div>
          <Retour ton="erreur">{err}</Retour>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><Button type="button" variant="outline" onClick={() => setOpen(false)}>Annuler</Button><Button type="submit" disabled={busy}>{busy && <Loader2 className="h-4 w-4 animate-spin" />} Envoyer</Button></div>
        </form>
      </Sheet>
    </>
  );
}
