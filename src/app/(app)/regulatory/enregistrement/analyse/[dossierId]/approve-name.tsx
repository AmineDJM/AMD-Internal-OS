"use client";

import * as React from "react";

import { Check, Loader2 } from "lucide-react";
import { approveDocumentName } from "@/lib/regulatory/intelligence/actions";
import { useAction } from "@/components/shared/use-action";

/** Approuve le nom de fichier proposé (le renommage définitif de la copie de travail). */
export function ApproveNameButton({ documentId }: { documentId: string }) {
  // Un petit bouton dans une ligne : un refus part en avis flottant.
  const { busy, run } = useAction({ signalerErreurs: true });

  async function approve() {
    const fd = new FormData();
    fd.set("documentId", documentId);
    await run(() => approveDocumentName(fd));
  }

  return (
    <button type="button" disabled={busy} onClick={approve}
      className="inline-flex items-center gap-1 rounded border border-success/40 px-2 py-1 text-[0.6875rem] text-success sm:px-1.5 sm:py-0.5 hover:bg-success/10 disabled:opacity-50"
      title="Approuver ce nom">
      {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />} approuver
    </button>
  );
}
