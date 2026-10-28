"use client";

import * as React from "react";
import { Loader2, X, CircleCheckBig } from "lucide-react";
import { Input } from "@/components/ui/input";
import { closeAdProOtherRequest } from "@/lib/actions/ad-pro-other-actions";
import { BoutonDecisif } from "@/components/ui/bouton-decisif";
import { actionFailureMessage } from "@/lib/action-outcome";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { Retour } from "@/components/ui/retour";

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
  const { rafraichir } = useRafraichir();
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
    // UN APPEL QUI LÈVE (connexion coupée, redéploiement) ne fige plus le panneau (audit 27/10/2026,
    // FRONTEND-UX-01) : sans cette garde, `busy` restait posé et les quatre gestes tournaient pour
    // toujours, sans un mot. Le message dit de vérifier avant de recommencer — jamais « réessayez ».
    let r: { ok: boolean; error?: string; message?: string };
    try {
      r = await fn(fd);
    } catch (e) {
      console.error("[ad-pro autres] l'action serveur a levé", e);
      setErr(actionFailureMessage("THROWN"));
      return;
    } finally {
      setBusy(null);
    }
    if (!r.ok) { setErr(r.error ?? "L'opération a échoué."); return; }
    setMotifAnnulation("");
    if (r.message) setAnnonce(r.message);
    rafraichir();
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
      <Retour ton="erreur">{err}</Retour>
    </div>
  );
}
