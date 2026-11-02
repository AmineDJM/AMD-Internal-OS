"use client";

import * as React from "react";

import { Loader2, Check, X, Upload, Ban } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { Retour } from "@/components/ui/retour";
import { useKeyedAction } from "@/components/shared/use-action";
import { submitDocumentRequest, decideDocumentRequest, cancelDocumentRequest } from "@/lib/actions/document-request-actions";

/**
 * LES DEUX CÔTÉS D'UNE DEMANDE DE PIÈCE.
 *
 * Celui à qui l'on demande DÉPOSE puis signale ; celui qui a demandé ACCEPTE ou REFUSE. Personne
 * ne voit les boutons de l'autre — accepter sa propre pièce viderait la demande de son sens,
 * puisqu'elle existe précisément pour qu'un tiers confirme avoir reçu ce qu'il attendait.
 */
export function RespondPanel({
  id, canSubmit, canDecide, canCancel, attachmentCount,
}: { id: string; canSubmit: boolean; canDecide: boolean; canCancel: boolean; attachmentCount: number }) {
  const geste = useKeyedAction();
  const { busy, error: err } = geste;
  const [note, setNote] = React.useState("");

  const run = async (key: string, fn: (fd: FormData) => Promise<{ ok: boolean; error?: string }>, fields: Record<string, string>) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    if (await geste.run(key, () => fn(fd))) setNote("");
  };

  if (!canSubmit && !canDecide && !canCancel) return null;

  return (
    <div className="space-y-4">
      {canSubmit && (
        <div className="surface space-y-2 p-4">
          <h3 className="text-sm font-semibold">Votre dépôt</h3>
          <p className="text-xs text-muted-foreground">
            Joignez la ou les pièces ci-contre, puis signalez le dépôt — c&apos;est ce qui prévient la
            personne qui les attend.
          </p>
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Un mot d'accompagnement (facultatif)" />
          <Button
            className="w-full" disabled={busy !== null || attachmentCount === 0}
            onClick={() => run("submit", submitDocumentRequest, { id, note })}
          >
            {busy === "submit" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} J&apos;ai déposé les pièces
          </Button>
          {/* Signaler un dépôt vide enverrait le demandeur chercher un fichier inexistant. */}
          {attachmentCount === 0 && <p className="text-xs text-warning">Joignez au moins une pièce avant de signaler le dépôt.</p>}
        </div>
      )}

      {canDecide && (
        <div className="surface space-y-2 p-4">
          <h3 className="text-sm font-semibold">Est-ce bien ce que vous attendiez ?</h3>
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Si vous refusez, dites ce qui manque — la demande repart avec ce motif." />
          <div className="flex gap-2">
            <Button className="flex-1" disabled={busy !== null} onClick={() => run("ok", decideDocumentRequest, { id, accept: "1", note })}>
              {busy === "ok" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Pièce reçue
            </Button>
            <Button variant="outline" className="flex-1 text-destructive" disabled={busy !== null} onClick={() => run("no", decideDocumentRequest, { id, accept: "0", note })}>
              {busy === "no" ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />} Redemander
            </Button>
          </div>
        </div>
      )}

      {canCancel && (
        <Button variant="outline" className="w-full text-muted-foreground" disabled={busy !== null} onClick={() => run("cancel", cancelDocumentRequest, { id })}>
          {busy === "cancel" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Ban className="h-4 w-4" />} Annuler la demande
        </Button>
      )}

      <Retour ton="erreur">{err}</Retour>
    </div>
  );
}
