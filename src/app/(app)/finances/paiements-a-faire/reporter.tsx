"use client";

import * as React from "react";
import { Loader2, Lock } from "lucide-react";
import { useFormAction } from "@/components/shared/use-action";
import { deferExpenseOrder } from "@/modules/finances/actions-depenses";
import { Sheet } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Retour } from "@/components/ui/retour";
import { formatCurrency } from "@/lib/utils";
import { deferralWarning, deadlineNatureOf } from "@/modules/finances/partage";
import type { LigneBanque } from "./orders-table";

/** Les motifs qu'on choisit d'un clic (maquette validée) — le texte reste libre. */
const MOTIFS = ["À la demande du fournisseur", "Trésorerie insuffisante cette semaine", "Pièce manquante au dossier"];

/**
 * REPORTER LE PAIEMENT À UNE DATE, AVEC SON MOTIF. On ne demande pas « voulez-vous reporter ? » mais « à quand, et
 * pourquoi ? » : un report sans date est un oubli qui porte un nom, et le demandeur lit le motif (il est prévenu).
 * L'ordre reste dû : il passe dans « Reportés » et revient seul dans « À payer » le jour dit.
 */
export function ReporterPanneau({ ligne, onClose }: { ligne: LigneBanque; onClose: () => void }) {
  const [motif, setMotif] = React.useState(ligne.deferredReason ?? "");
  const { action: reporter, busy, err, setErr } = useFormAction(deferExpenseOrder, {
    prepare: (fd) => { fd.set("id", ligne.id); fd.set("reason", motif.trim()); },
    onOk: onClose, succes: `${ligne.beneficiaire} reporté. Le demandeur est prévenu.`,
  });
  const avertissement = deferralWarning(ligne.deadlineNature);
  const fixe = deadlineNatureOf(ligne.deadlineNature) === "FIXED";
  return (
    <Sheet
      open onClose={() => { if (!busy) { setErr(null); onClose(); } }} width="md" title="Reporter le paiement"
      description={`${ligne.beneficiaire} · ${formatCurrency(ligne.montant)} · échéance actuelle : ${ligne.echeance ?? "—"}`}
    >
      <form action={reporter} className="space-y-3">
        {avertissement && (
          <p className={`flex items-start gap-2 rounded-lg px-3 py-2 text-xs ${fixe ? "bg-destructive/10 text-destructive" : "bg-warning/10 text-foreground"}`}>
            <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {avertissement}
          </p>
        )}
        <div className="space-y-1">
          <Label htmlFor={`defer-${ligne.id}`}>Reporter au</Label>
          <Input id={`defer-${ligne.id}`} name="until" type="date" required defaultValue={ligne.deferredUntil?.slice(0, 10) ?? ""} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`motif-${ligne.id}`}>Motif (visible par le demandeur)</Label>
          <Input id={`motif-${ligne.id}`} value={motif} required onChange={(e) => setMotif(e.target.value)} placeholder="Pourquoi ce paiement attend-il ?" />
          <div className="flex flex-wrap gap-1.5">
            {MOTIFS.map((m) => (
              <button key={m} type="button" onClick={() => setMotif(m)} className={`min-h-9 rounded-full border px-3 text-xs ${motif === m ? "border-primary bg-primary/10 text-primary" : "border-border hover:bg-secondary"}`}>{m}</button>
            ))}
          </div>
        </div>
        <Retour ton="erreur">{err}</Retour>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" className="w-full sm:w-auto" disabled={busy} onClick={onClose}>Annuler</Button>
          <Button type="submit" className="w-full sm:w-auto" disabled={busy || !motif.trim()}>{busy && <Loader2 className="h-4 w-4 animate-spin" />} Reporter</Button>
        </div>
      </form>
    </Sheet>
  );
}
