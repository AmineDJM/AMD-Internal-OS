"use client";

import { Loader2, RotateCcw } from "lucide-react";
import { restoreRequest } from "@/lib/actions/admin-request-actions";
import { useFormAction } from "@/components/shared/use-action";
import { Button } from "@/components/ui/button";

export function RestoreButton({ id }: { id: string }) {
  // Le bouton n'a pas de place pour parler : un refus part en avis flottant.
  const { action, busy } = useFormAction(restoreRequest, { signalerErreurs: true });
  return (
    <form action={action}>
      <input type="hidden" name="id" value={id} />
      <Button type="submit" variant="outline" size="sm" disabled={busy}>
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />} Restaurer
      </Button>
    </form>
  );
}
