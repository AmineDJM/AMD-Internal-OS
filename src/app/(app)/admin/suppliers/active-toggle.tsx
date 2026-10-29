"use client";

import { Loader2, Power } from "lucide-react";
import { toggleSupplier, toggleSupplierUser } from "@/lib/actions/supplier-actions";
import { useAction } from "@/components/shared/use-action";

export function ActiveToggle({ kind, id, active }: { kind: "supplier" | "user"; id: string; active: boolean }) {
  // La pastille n'a pas de place où parler : un refus part en avis flottant.
  const { busy: pending, run } = useAction({ signalerErreurs: true });
  return (
    <button
      disabled={pending}
      onClick={() => {
        const fd = new FormData(); fd.set("id", id);
        void run(async () => {
          const r = await (kind === "supplier" ? toggleSupplier(fd) : toggleSupplierUser(fd));
          return r.ok ? r : { ok: false, error: r.error ?? (active ? "La désactivation n'a pas abouti." : "L'activation n'a pas abouti.") };
        });
      }}
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${active ? "border-success/30 bg-success/10 text-success" : "border-border bg-secondary text-muted-foreground"}`}
      title={active ? "Actif — cliquer pour désactiver" : "Désactivé — cliquer pour activer"}
    >
      {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Power className="h-3 w-3" />}
      {active ? "Actif" : "Désactivé"}
    </button>
  );
}
