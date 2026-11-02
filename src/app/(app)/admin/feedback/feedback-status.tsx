"use client";

import { Loader2 } from "lucide-react";
import { updateFeedbackStatus } from "@/lib/actions/feedback-actions";
import { FEEDBACK_STATUS } from "@/lib/labels";
import { useAction } from "@/components/shared/use-action";

export function FeedbackStatusSelect({ id, status }: { id: string; status: string }) {
  // Le sélecteur vit dans une ligne, sans place où parler : un refus part en avis flottant.
  const { busy: pending, run } = useAction({ signalerErreurs: true });
  return (
    <span className="inline-flex items-center gap-1.5">
      {pending && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
      <select
        value={status}
        disabled={pending}
        onChange={(e) => {
          const fd = new FormData();
          fd.set("id", id);
          fd.set("status", e.target.value);
          void run(async () => {
            const r = await updateFeedbackStatus(fd);
            return r.ok ? r : { ok: false, error: r.error ?? "Le statut n'a pas été changé." };
          });
        }}
        className="h-10 rounded-lg border border-input bg-card px-2 text-base outline-none sm:h-8 sm:text-xs focus-visible:ring-2 focus-visible:ring-ring"
      >
        {Object.entries(FEEDBACK_STATUS).map(([v, d]) => (
          <option key={v} value={v}>{d.label}</option>
        ))}
      </select>
    </span>
  );
}
