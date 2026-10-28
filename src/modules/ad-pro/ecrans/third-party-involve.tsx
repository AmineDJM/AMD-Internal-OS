"use client";

import * as React from "react";
import { UserPlus, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { requestThirdPartyInput } from "../actions-congres";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { Select, Textarea, Label } from "@/components/ui/input";

/**
 * « Impliquer une tierce personne » pour un congrès (INTL / NATIONAL) ou un
 * événement (EVENT). La personne reçoit une demande dans SON espace et un dossier
 * de suivi indiquant l'événement — sans budget ni accès au module.
 */
export function ThirdPartyInvolveButton({ type, id, people }: { type: string; id: string; people: { id: string; name: string }[] }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}><UserPlus className="h-4 w-4" /> Impliquer une tierce personne</Button>
      <Sheet open={open} onClose={() => setOpen(false)} title="Impliquer une tierce personne" description="La personne recevra une demande dans son espace et un sujet indiquant l'événement — sans détail de budget, et sans accès au module." width="md">
        <form
          action={async (fd) => {
            setBusy(true); setErr(null);
            fd.set("type", type); fd.set("id", id);
            const r = await requestThirdPartyInput(fd);
            setBusy(false);
            if (r.ok) { setOpen(false); router.refresh(); } else setErr(r.error ?? "Action impossible.");
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
          {err && <p className="text-sm text-destructive">{err}</p>}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><Button type="button" variant="outline" onClick={() => setOpen(false)}>Annuler</Button><Button type="submit" disabled={busy}>{busy && <Loader2 className="h-4 w-4 animate-spin" />} Envoyer</Button></div>
        </form>
      </Sheet>
    </>
  );
}
