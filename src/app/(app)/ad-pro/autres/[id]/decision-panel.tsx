"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, Check, X, CircleCheckBig, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { decideAdProOtherRequest, closeAdProOtherRequest, resoumettreAdProOtherRequest } from "@/lib/actions/ad-pro-other-actions";
import { BoutonDecisif } from "@/components/ui/bouton-decisif";
import { actionFailureMessage } from "@/lib/action-outcome";

/**
 * TRANCHER UNE DEMANDE « AUTRE ».
 *
 * Le circuit est court par construction : valider ou refuser, avec un motif ; puis marquer
 * terminé une fois exécutée. On n'affiche que ce qui a un sens à cet instant — un bouton qui
 * apparaît puis échoue fait douter de tout le reste de l'écran.
 */
export function OtherDecisionPanel({
  id, status, canDecide, canClose, canResubmit = false, description = "", amount = null,
}: {
  id: string; status: string; canDecide: boolean; canClose: boolean;
  /** Le demandeur d'une demande REFUSÉE la resoumet (audit 360°, rapport 17 R14). */
  canResubmit?: boolean;
  description?: string;
  amount?: number | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [annonce, setAnnonce] = React.useState<string | null>(null);
  const [note, setNote] = React.useState("");
  const [motifAnnulation, setMotifAnnulation] = React.useState("");
  const [correction, setCorrection] = React.useState("");

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
    setNote(""); setMotifAnnulation(""); setCorrection("");
    // Ce que le geste a fait AILLEURS (la porte du centre) se DIT — l'écran ne le jette pas (§118.168).
    if (r.message) setAnnonce(r.message);
    router.refresh();
  };

  if (!canDecide && !canClose && !canResubmit) return annonce ? <p className="rounded-lg bg-success/10 px-3 py-2 text-sm">{annonce}</p> : null;

  return (
    <div className="space-y-4">
      {canDecide && (
        <div className="surface space-y-2 p-4">
          <h3 className="text-sm font-semibold">Décision</h3>
          {/* Le motif est EXIGÉ pour refuser (audit 360°, rapport 17 R14) : c'est sur lui que le demandeur
              corrigera, puis resoumettra. L'action le revérifie. */}
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} aria-label="Motif de la décision" placeholder="Motif — obligatoire pour refuser" rows={3} />
          <div className="flex gap-2">
            <BoutonDecisif className="flex-1" disabled={busy !== null} onClick={() => run("ok", decideAdProOtherRequest, { id, approve: "1", note })}>
              {busy === "ok" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Valider
            </BoutonDecisif>
            <BoutonDecisif variant="outline" className="flex-1 text-destructive" disabled={busy !== null || !note.trim()} onClick={() => run("no", decideAdProOtherRequest, { id, approve: "0", note })}>
              {busy === "no" ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />} Refuser
            </BoutonDecisif>
          </div>
        </div>
      )}

      {canResubmit && (
        <form
          className="surface space-y-2 p-4"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            void run("resubmit", resoumettreAdProOtherRequest, {
              id, note: correction, description: String(f.get("description") ?? ""), amount: String(f.get("amount") ?? ""),
            });
          }}
        >
          <h3 className="text-sm font-semibold">Resoumettre la demande</h3>
          <p className="text-xs text-muted-foreground">Dites ce qui a changé depuis le refus ; corrigez la description ou le montant s&apos;il le faut.</p>
          <Input value={correction} onChange={(e) => setCorrection(e.target.value)} aria-label="Ce qui a changé" placeholder="Ce qui a changé (obligatoire)" />
          <Textarea name="description" defaultValue={description} aria-label="Description" rows={3} required />
          <Input name="amount" type="number" inputMode="decimal" min={0} step="any" defaultValue={amount == null ? "" : String(amount)} aria-label="Montant (DZD)" placeholder="Montant (DZD)" />
          <Button type="submit" className="w-full" disabled={busy !== null || !correction.trim()}>
            {busy === "resubmit" ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />} Resoumettre la demande
          </Button>
        </form>
      )}

      {canClose && (
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
      )}

      {annonce && <p className="rounded-lg bg-success/10 px-3 py-2 text-sm">{annonce}</p>}
      {err && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>}
    </div>
  );
}
