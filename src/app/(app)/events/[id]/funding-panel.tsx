"use client";

import * as React from "react";
import { Loader2, Send } from "lucide-react";
import { submitEventForApproval } from "@/modules/ad-pro/actions-evenements";
import { WorkflowPanel } from "@/components/workflow/workflow-panel";
import type { WorkflowView } from "@/lib/queries/workflow";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { InfoBulle } from "@/components/ui/info-bulle";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { useAction } from "@/components/shared/use-action";

interface Props {
  eventId: string;
  requestSubmitted: boolean; // l'événement est-il déjà entré dans le circuit ?
  canSubmit: boolean;
  workflow: WorkflowView | null;
  /**
   * Rendu de la carte « La demande » (Direction, 07/10) : la prise en charge n'est plus un bloc à part — sa frise et sa
   * phrase de statut ouvrent la carte, ses gestes (soumettre, décider, relancer) sont ceux de l'encart de statut.
   */
  compact?: boolean;
}

/**
 * Financement d'un événement : tant qu'il n'est pas soumis, un bouton l'envoie dans le
 * circuit de prise en charge. Une fois soumis, le circuit est piloté par le moteur de
 * workflow configurable (WorkflowPanel).
 */
export function EventFundingPanel({ eventId, requestSubmitted, canSubmit, workflow, compact = false }: Props) {
  if (!requestSubmitted) {
    if (compact) {
      return (
        <div className="rounded-lg border border-border bg-secondary/40 px-3 py-2.5 sm:px-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
            <p className="min-w-0 font-semibold">{canSubmit ? "Prise en charge non soumise" : "Sans demande de prise en charge"}</p>
            {canSubmit && <SubmitButton id={eventId} compact />}
          </div>
        </div>
      );
    }
    if (!canSubmit) return <p className="text-sm text-muted-foreground">Cet événement n'est pas soumis à un circuit de prise en charge (financement).</p>;
    return <SubmitButton id={eventId} />;
  }
  if (!workflow) return <p className="text-sm text-muted-foreground">Circuit indisponible.</p>;
  // UNE DEMANDE REFUSÉE OU RETIRÉE PEUT REPARTIR (audit 360°, R01 — §118.186) : on a refusé la PRISE
  // EN CHARGE, pas l'événement. Le panneau garde l'historique et le motif du refus ; la relance
  // demande ce qui a changé.
  const relancable = canSubmit && (workflow.status === "REJECTED" || workflow.status === "CANCELLED");
  if (compact) {
    return <WorkflowPanel entityType="EVENT" entityId={eventId} view={workflow} compact gestes={relancable ? <RelaunchForm id={eventId} /> : null} />;
  }
  return (
    <div className="space-y-4">
      <WorkflowPanel entityType="EVENT" entityId={eventId} view={workflow} />
      {relancable && <RelaunchForm id={eventId} />}
    </div>
  );
}

/** RELANCER une prise en charge refusée ou retirée — un nouveau cycle, avec ce qui a changé. */
function RelaunchForm({ id }: { id: string }) {
  const { enCours, rafraichir } = useRafraichir();
  const [pendingAction, start] = React.useTransition();
  const pending = pendingAction || enCours;
  const [note, setNote] = React.useState("");
  const [err, setErr] = React.useState<string | null>(null);
  const relancer = () =>
    start(async () => {
      setErr(null);
      const fd = new FormData();
      fd.set("id", id);
      fd.set("note", note.trim());
      const r = await submitEventForApproval(fd);
      if (!r.ok) { setErr(r.error ?? "Relance impossible."); return; }
      setNote("");
      rafraichir();
    });
  return (
    <div className="space-y-2 border-t border-border pt-3">
      <p className="text-sm font-medium">Soumettre une nouvelle demande de prise en charge</p>
      <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ce qui a changé depuis le refus (obligatoire) — budget revu, format, pièces…" className="min-h-[56px]" />
      {err && <p className="break-words text-xs text-destructive">{err}</p>}
      <Button size="sm" onClick={relancer} disabled={pending || !note.trim()} className="w-full sm:w-auto">
        {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Relancer la demande
      </Button>
    </div>
  );
}

/**
 * SOUMETTRE — le circuit DÉPEND DE QUI SOUMET, et le formulaire n'a rien à en dire.
 *
 * Personne n'approuve la demande qu'il émet lui-même : `parcoursAdPro` lit le RANG du demandeur
 * et pose la demande sur la bonne étape. Ce panneau ne portait plus que deux réglages qui ne
 * changeaient rien — le référent Direction Marketing, retiré des nouvelles demandes par décision
 * de la Direction (22/09/2026), et le choix « passer d'abord par l'arbitrage », dont l'effet
 * serveur avait déjà disparu quand Direction Marketing est devenue l'étape qui TRANCHE toute
 * demande Ad & Pro (§118.138). Un réglage sans effet est un mensonge fait à qui le règle.
 */
function SubmitButton({ id, compact = false }: { id: string; compact?: boolean }) {
  // Gardé (levée, délai) et rafraîchi par `useAction`.
  const { busy: pending, err, run } = useAction();

  const submit = () => {
    const fd = new FormData();
    fd.set("id", id);
    void run(() => submitEventForApproval(fd));
  };
  if (compact) {
    // Le geste, et le pourquoi derrière un ⓘ (Direction, 07/10).
    return (
      <div className="space-y-1">
        <div className="flex items-center gap-1.5">
          <Button size="sm" onClick={submit} disabled={pending} className="flex-1 sm:flex-none">
            {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Soumettre pour prise en charge
          </Button>
          <InfoBulle className="shrink-0" label="Le parcours de la prise en charge">
            Le parcours dépend de QUI soumet : un délégué passe par son superviseur national, le National Sales par la Direction
            des opérations, tout autre demandeur va directement chez Direction Marketing, qui tranche. Les étapes situées au niveau
            ou en dessous de votre rang sont franchies automatiquement.
          </InfoBulle>
        </div>
        {err && <p className="break-words text-xs text-destructive">{err}</p>}
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">
        Soumettez cet événement au circuit de prise en charge : il suit ensuite les étapes
        configurées. Le parcours dépend de QUI soumet : un délégué passe par son superviseur
        national, le National Sales par la Direction des opérations, tout autre demandeur va
        directement chez Direction Marketing, qui tranche. Les étapes situées au niveau ou en
        dessous de votre rang sont franchies automatiquement.
      </p>
      {err && <p className="break-words text-xs text-destructive">{err}</p>}
      <Button size="sm" onClick={submit} disabled={pending} className="w-full sm:w-auto">
        {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Soumettre pour prise en charge
      </Button>
    </div>
  );
}
