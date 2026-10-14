"use client";

import * as React from "react";
import { CheckCircle2, Loader2, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { marquerExamenDoublon } from "@/lib/actions/doublons-factures-actions";

/**
 * « À EXAMINER / EXAMINÉ » d'un groupe de doublons — le seul geste de l'écran. Il ne touche à aucune facture : il dit
 * que les Finances ont regardé ce groupe (journal d'audit). Qui ne peut pas modifier les Finances lit l'état, sans bouton.
 */
export function BoutonExamen({ signature, examine, par, le, peutExaminer }: {
  signature: string; examine: boolean; par: string | null; le: string | null; peutExaminer: boolean;
}) {
  const { rafraichir } = useRafraichir();
  const [busy, setBusy] = React.useState(false);
  const [erreur, setErreur] = React.useState<string | null>(null);
  const basculer = async () => {
    setBusy(true); setErreur(null);
    const fd = new FormData();
    fd.set("signature", signature);
    fd.set("examine", examine ? "0" : "1");
    const r = await marquerExamenDoublon(fd);
    setBusy(false);
    if (!r.ok) { setErreur(r.error ?? "Échec."); return; }
    rafraichir();
  };
  const etat = examine
    ? `Examiné${par ? ` par ${par}` : ""}${le ? ` le ${new Date(le).toLocaleDateString("fr-FR")}` : ""}`
    : "À examiner";
  return (
    <div className="flex flex-col items-start gap-1 sm:items-end">
      <span className={`text-xs ${examine ? "text-success" : "text-warning"}`}>{etat}</span>
      {peutExaminer && (
        <Button size="sm" variant="outline" className="h-10 sm:h-8" disabled={busy} onClick={() => void basculer()}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : examine ? <RotateCcw className="h-3.5 w-3.5" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
          {examine ? "Remettre à examiner" : "Marquer examiné"}
        </Button>
      )}
      {erreur && <span className="text-xs text-destructive">{erreur}</span>}
    </div>
  );
}
