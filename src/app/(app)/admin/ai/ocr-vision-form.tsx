"use client";

import * as React from "react";
import { Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Retour } from "@/components/ui/retour";
import { useAction } from "@/components/shared/use-action";
import { reglerOcrVision } from "@/lib/actions/ai-settings-actions";
import { cn } from "@/lib/utils";

/**
 * L'OCR VISION DES CONVERSIONS (décision 0019) — le Super Admin l'active et fixe son plafond mensuel. La page dit la
 * dépense du mois ; ce qui ne part JAMAIS au modèle est rappelé (la garde est dans le code, pas dans ce réglage).
 */
export function OcrVisionForm({ initial, depenseMois }: { initial: { actif: boolean; plafondUsd: number }; depenseMois: number }) {
  const [actif, setActif] = React.useState(initial.actif);
  const [plafond, setPlafond] = React.useState(String(initial.plafondUsd));
  const [ok, setOk] = React.useState(false);
  const { busy, err, run } = useAction();
  const dirty = actif !== initial.actif || Number(plafond) !== initial.plafondUsd;

  async function enregistrer() {
    const fd = new FormData();
    if (actif) fd.set("ocrVisionEnabled", "on");
    fd.set("ocrVisionPlafondUsd", plafond);
    await run(() => reglerOcrVision(fd), () => { setOk(true); setTimeout(() => setOk(false), 1800); });
  }

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">OCR vision des conversions (pages scannées difficiles)</p>
          <p className="text-xs text-muted-foreground">
            Une page scannée que la lecture locale (tesseract) lit mal — arabe vocalisé, scan dégradé — est transcrite par le modèle
            de vision de l&apos;Assistant IA, au nom de la personne qui convertit, puis vérifiée contre la lecture locale. Jamais pour
            une pièce confidentielle, du coffre (identité, paie, RIB), un contrat ou une pièce d&apos;un dossier RH : là, la lecture
            locale reste et l&apos;écran dit pourquoi. Coupé par défaut.
          </p>
        </div>
        <button type="button" role="switch" aria-checked={actif} onClick={() => setActif((a) => !a)} aria-label="Activer l'OCR vision"
          className={cn("relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors", actif ? "bg-success" : "bg-border")}>
          <span className={cn("inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform", actif ? "translate-x-5" : "translate-x-0.5")} />
        </button>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:gap-4">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Plafond mensuel ($)
          <Input type="number" min={0} max={10000} step={1} value={plafond} onChange={(e) => setPlafond(e.target.value)} className="w-full sm:w-32" />
        </label>
        <p className="text-xs text-muted-foreground">Dépensé ce mois-ci : <span className="font-medium text-foreground">{depenseMois.toFixed(2)} $</span></p>
      </div>
      <Retour ton="erreur">{err}</Retour>
      <div className="flex items-center justify-end gap-3">
        {ok && <span className="flex items-center gap-1.5 text-sm text-success"><Check className="h-4 w-4" /> Enregistré</span>}
        <Button onClick={enregistrer} disabled={busy || !dirty} className="w-full sm:w-auto">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Enregistrer
        </Button>
      </div>
    </div>
  );
}
