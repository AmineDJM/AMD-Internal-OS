"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, Trash2 } from "lucide-react";
import { purgeSettledExpenseOrders } from "@/modules/finances/actions-depenses";
import { Button } from "@/components/ui/button";

/**
 * VIDER L'HISTORIQUE DES RÈGLEMENTS — réservé au Super Admin.
 *
 * La confirmation DIT ce qui part et ce qui reste, parce que la distinction n'est pas devinable :
 * on retire des lignes de la FILE, pas des écritures du LIVRE. La trace de l'argent sorti vit
 * dans la trésorerie et dans le journal d'audit ; elle n'est pas touchée.
 */
export function PurgeHistoryButton({ count }: { count: number }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [err, setErr] = React.useState<string | null>(null);

  if (count === 0) return null;

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        variant="outline"
        size="sm"
        className="text-destructive"
        disabled={busy}
        onClick={async () => {
          const ok = window.confirm(
            `Vider l'historique : ${count} ordre(s) réglé(s) ou annulé(s) disparaîtront de cet écran.\n\n`
            + "Les ÉCRITURES DE TRÉSORERIE et le journal d'audit sont conservés — c'est là que reste la trace de l'argent sorti.\n\n"
            + "Les ordres encore à régler ne sont pas touchés.",
          );
          if (!ok) return;
          setBusy(true); setErr(null); setMsg(null);
          const r = await purgeSettledExpenseOrders();
          setBusy(false);
          if (r.ok) { setMsg(r.message ?? "Historique vidé."); router.refresh(); }
          else setErr(r.error ?? "Purge impossible.");
        }}
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />} Vider l&apos;historique ({count})
      </Button>
      {msg && <p className="text-xs text-success">{msg}</p>}
      {err && <p role="alert" className="text-xs text-destructive">{err}</p>}
    </div>
  );
}
