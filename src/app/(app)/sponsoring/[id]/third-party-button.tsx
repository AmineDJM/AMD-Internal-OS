"use client";

import * as React from "react";
import { UserPlus, Loader2 } from "lucide-react";
import { requestThirdPartyInput } from "@/modules/ad-pro/actions-sponsoring";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { Select, Textarea, Label } from "@/components/ui/input";
import { useFormAction } from "@/components/shared/use-action";
import { Retour } from "@/components/ui/retour";

/**
 * « Impliquer une tierce personne » : crée une demande de validation directe vers
 * la personne choisie (ex. assistante de direction), qu'elle traite depuis SON
 * espace « Demandes de validations » — sans accès au module Ad & Pro.
 */
export function ThirdPartyButton({ id, people }: { id: string; people: { id: string; name: string }[] }) {
  const [open, setOpen] = React.useState(false);
  const { action: impliquer, busy, err } = useFormAction(requestThirdPartyInput, {
    prepare: (fd) => fd.set("id", id),
    onOk: () => setOpen(false),
  });

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}><UserPlus className="h-4 w-4" /> Impliquer une tierce personne</Button>
      <Sheet open={open} onClose={() => setOpen(false)} title="Impliquer une tierce personne" description="La personne recevra une demande de validation qu'elle traitera depuis son espace, sans accès au module." width="md">
        <form
          action={impliquer}
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
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><Button type="button" variant="outline" onClick={() => setOpen(false)} className="w-full sm:w-auto">Annuler</Button><Button type="submit" disabled={busy} className="w-full sm:w-auto">{busy && <Loader2 className="h-4 w-4 animate-spin" />} Envoyer</Button></div>
        </form>
      </Sheet>
    </>
  );
}
