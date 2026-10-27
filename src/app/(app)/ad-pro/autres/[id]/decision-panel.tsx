"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, X, CircleCheckBig } from "lucide-react";
import { Input } from "@/components/ui/input";
import { closeAdProOtherRequest } from "@/lib/actions/ad-pro-other-actions";
import { BoutonDecisif } from "@/components/ui/bouton-decisif";

/**
 * LA SUITE D'UNE DEMANDE « AUTRE » — la marquer terminée, ou l'annuler.
 *
 * Depuis le 27/10/2026 (décision #17), elle se DÉCIDE par le circuit commun : le panneau du circuit
 * (`WorkflowPanel`) porte la validation, le refus, le renvoi pour correction, la resoumission et
 * l'appel. Il ne reste ici que ce qui vient APRÈS (ou à côté) : « Terminée » une fois exécutée, ou
 * l'annulation, motif exigé. On n'affiche que ce qui a un sens à cet instant — un bouton qui apparaît
 * puis échoue fait douter de tout le reste de l'écran.
 */
export function OtherDecisionPanel({ id, status, canClose }: { id: string; status: string; canClose: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [annonce, setAnnonce] = React.useState<string | null>(null);
  const [motifAnnulation, setMotifAnnulation] = React.useState("");

  const run = async (
    key: string,
    fn: (fd: FormData) => Promise<{ ok: boolean; error?: string; message?: string }>,
    fields: Record<string, string>,
  ) => {
    setBusy(key); setErr(null); setAnnonce(null);
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    const r = await fn(fd);
    setBusy(null);
    if (!r.ok) { setErr(r.error ?? "L'opération a échoué."); return; }
    setMotifAnnulation("");
    if (r.message) setAnnonce(r.message);
    router.refresh();
  };

  if (!canClose) return annonce ? <p className="rounded-lg bg-success/10 px-3 py-2 text-sm">{annonce}</p> : null;

  return (
    <div className="space-y-4">
      <div className="surface space-y-2 p-4">
        <h3 className="text-sm font-semibold">Suite</h3>
        <Input value={motifAnnulation} onChange={(e) => setMotifAnnulation(e.target.value)} aria-label="Motif de l'annulation" placeholder="Motif — obligatoire pour annuler" />
        <div className="flex flex-wrap gap-2">
          {status === "APPROVED" && (
            <BoutonDecisif variant="outline" className="flex-1" disabled={busy !== null} onClick={() => run("done", closeAdProOtherRequest, { id, cancel: "0" })}>
              {busy === "done" ? <Loader2 className="h-4 w-4 animate-spin" /> : <CircleCheckBig className="h-4 w-4" />} Terminée
            </BoutonDecisif>
          )}
          <BoutonDecisif variant="outline" className="flex-1 text-destructive" disabled={busy !== null || !motifAnnulation.trim()} onClick={() => run("cancel", closeAdProOtherRequest, { id, cancel: "1", note: motifAnnulation })}>
            {busy === "cancel" ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />} Annuler
          </BoutonDecisif>
        </div>
      </div>

      {annonce && <p className="rounded-lg bg-success/10 px-3 py-2 text-sm">{annonce}</p>}
      {err && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>}
    </div>
  );
}
