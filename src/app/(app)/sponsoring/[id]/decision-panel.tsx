"use client";

import * as React from "react";
import { Gavel, Loader2, AlertCircle } from "lucide-react";
import { sponsoringAppeal } from "@/modules/ad-pro/actions-sponsoring";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { InfoBulle } from "@/components/ui/info-bulle";
import { useAction } from "@/components/shared/use-action";

/**
 * Appel du délégué après la décision. Le circuit de validation lui-même est piloté par le moteur de
 * workflow configurable (WorkflowPanel) ; l'appel reste une action propre au sponsoring, qui rouvre le
 * circuit à l'ÉTAPE QUI A TRANCHÉ (§118.186, R04) — `etape` la nomme, pour que la phrase dise vrai :
 * elle promettait « la Direction Marketing » quand le circuit rouvrait à la porte du DG.
 */
export function AppealPanel({ id, etape }: { id: string; etape: string | null }) {
  const [open, setOpen] = React.useState(false);
  const [reason, setReason] = React.useState("");
  // Gardé (levée, délai) et rafraîchi par `useAction`.
  const { busy: pending, err, setErr, run } = useAction();

  const submit = () => {
    const fd = new FormData();
    fd.set("id", id);
    fd.set("reason", reason);
    void run(() => sponsoringAppeal(fd), () => { setOpen(false); setReason(""); });
  };

  if (!open) {
    // Le geste, et son pourquoi derrière un ⓘ (Direction, 07/10 : pas de phrase explicative à l'écran).
    return (
      <div className="flex items-center gap-1.5">
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}><Gavel className="h-4 w-4" /> Faire appel</Button>
        <InfoBulle label="Faire appel">
          Vous n&apos;êtes pas d&apos;accord avec la décision ? Le dossier repart pour un nouvel examen{etape ? ` — « ${etape} »` : ""}.
        </InfoBulle>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <Textarea value={reason} onChange={(e) => setReason(e.target.value)} className="min-h-[70px]" placeholder="Expliquez pourquoi vous demandez un réexamen…" />
      {err && <div className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> <span className="min-w-0 break-words">{err}</span></div>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={pending || !reason.trim()} onClick={submit}>{pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Gavel className="h-4 w-4" />} Envoyer l'appel</Button>
        <Button size="sm" variant="ghost" onClick={() => { setOpen(false); setErr(null); }}>Annuler</Button>
      </div>
    </div>
  );
}
