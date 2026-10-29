"use client";

import * as React from "react";

import { Loader2, CalendarClock, BellRing, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { useRetours } from "@/components/ui/retour";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";
import { setRegulatoryTargetDates, requestRegulatoryStatusUpdate } from "@/lib/actions/regulatory-actions";

/**
 * Panneau de SUPERVISION d'un dossier (Super Admin + rôles configurés) : dates cibles
 * (dépôt / enregistrement) et demande de mise à jour de statut au responsable / assistant
 * / participants du dossier.
 */
export function SupervisionControls({
  id, targetSubmissionDate, targetDate,
}: {
  id: string;
  targetSubmissionDate: string | null; // YYYY-MM-DD
  targetDate: string | null; // YYYY-MM-DD
}) {
  const { rafraichir } = useRafraichir();
  const retours = useRetours();
  const [sub, setSub] = React.useState(targetSubmissionDate ?? "");
  const [reg, setReg] = React.useState(targetDate ?? "");
  const [savingDates, setSavingDates] = React.useState(false);
  const [note, setNote] = React.useState("");
  const [requesting, setRequesting] = React.useState(false);
  const [sent, setSent] = React.useState(false);

  async function saveDates() {
    setSavingDates(true);
    const fd = new FormData();
    fd.set("id", id);
    if (sub) fd.set("targetSubmissionDate", sub);
    if (reg) fd.set("targetDate", reg);
    try {
      const r = await setRegulatoryTargetDates(fd);
      if (!r.ok) retours.erreur(r.error ?? "Les dates cibles n'ont pas été enregistrées.");
    } catch {
      retours.erreur(actionFailureMessage("THROWN"));
    } finally {
      setSavingDates(false);
      rafraichir();
    }
  }

  async function requestUpdate() {
    setRequesting(true);
    const fd = new FormData();
    fd.set("id", id);
    if (note.trim()) fd.set("note", note.trim());
    try {
      const r = await requestRegulatoryStatusUpdate(fd);
      if (!r.ok) { retours.erreur(r.error ?? "La demande de mise à jour n'a pas été envoyée."); return; }
      setNote("");
      setSent(true);
      setTimeout(() => setSent(false), 2000);
    } catch {
      retours.erreur(actionFailureMessage("THROWN"));
    } finally {
      setRequesting(false);
    }
  }

  return (
    <div className="space-y-3 rounded-lg border border-border bg-secondary/30 p-3">
      <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <CalendarClock className="h-3.5 w-3.5" /> Supervision Regulatory
      </p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div className="space-y-1">
          <Label className="text-xs">Date cible de dépôt</Label>
          <Input type="date" value={sub} onChange={(e) => setSub(e.target.value)} onBlur={saveDates} className="h-9 text-xs sm:h-8" />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Date cible d&apos;enregistrement</Label>
          <Input type="date" value={reg} onChange={(e) => setReg(e.target.value)} onBlur={saveDates} className="h-9 text-xs sm:h-8" />
        </div>
      </div>
      <div className="flex flex-wrap items-end gap-2 border-t border-border pt-2">
        <div className="min-w-0 flex-1 basis-[180px] space-y-1">
          <Label className="text-xs">Demander une mise à jour de statut</Label>
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optionnel)…" className="h-9 text-xs sm:h-8" />
        </div>
        <Button type="button" size="sm" variant="outline" onClick={requestUpdate} disabled={requesting}>
          {requesting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : sent ? <Check className="h-3.5 w-3.5 text-success" /> : <BellRing className="h-3.5 w-3.5" />}
          {sent ? "Demandé" : "Demander"}
        </Button>
      </div>
      {savingDates && <p className="text-xs text-muted-foreground"><Loader2 className="mr-1 inline h-3 w-3 animate-spin" /> Enregistrement…</p>}
    </div>
  );
}
