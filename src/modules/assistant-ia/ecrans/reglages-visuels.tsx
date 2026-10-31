"use client";

import * as React from "react";
import { Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Retour } from "@/components/ui/retour";
import { useAction } from "@/components/shared/use-action";
import { cn } from "@/lib/utils";
import { enregistrerReglagesVisuels } from "@/modules/assistant-ia/actions-consommation";
import { DUREES_VIDEO, MODELES_IMAGE, MODELES_VIDEO, type ReglagesVisuels } from "@/modules/assistant-ia/partage";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES VISUELS GÉNÉRÉS — la console du Super Admin (lot K2, décision 0032), dans Administration › IA, à côté de l'OCR
 * vision : un interrupteur par nature (images, vidéos du modèle, vidéos de données), un plafond de dépense par mois civil
 * (le coût RÉEL de chaque génération est journalisé), le modèle, la durée max d'une vidéo. Qui y a droit, personne par
 * personne : la famille « Images & vidéos générées » de la console des accès (`/admin/ai/acces`).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

function Bascule({ coche, onClick, libelle }: { coche: boolean; onClick: () => void; libelle: string }) {
  return (
    <button type="button" role="switch" aria-checked={coche} aria-label={libelle} onClick={onClick}
      className={cn("relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors", coche ? "bg-primary" : "bg-muted-foreground/30")}>
      <span className={cn("inline-block h-5 w-5 rounded-full bg-white shadow transition-transform", coche ? "translate-x-6" : "translate-x-1")} />
    </button>
  );
}

const CHAMP = "h-11 w-full rounded-md border border-input bg-background px-2 text-base sm:h-9 sm:text-sm";

export function ReglagesVisuelsForm({ initial, depenseImagesUsd, depenseVideosUsd, videoIndisponible }: {
  initial: ReglagesVisuels; depenseImagesUsd: number; depenseVideosUsd: number; videoIndisponible: string | null;
}) {
  const [r, setR] = React.useState<ReglagesVisuels>(initial);
  const [ok, setOk] = React.useState(false);
  const { busy, err, run } = useAction();
  const sale = JSON.stringify(r) !== JSON.stringify(initial);
  const poser = <K extends keyof ReglagesVisuels>(k: K, v: ReglagesVisuels[K]) => { setR((p) => ({ ...p, [k]: v })); setOk(false); };

  async function enregistrer() {
    const fd = new FormData();
    if (r.imagesActives) fd.set("imagesActives", "on");
    if (r.videosActives) fd.set("videosActives", "on");
    if (r.donneesActives) fd.set("donneesActives", "on");
    fd.set("imagesPlafondUsd", String(r.imagesPlafondUsd));
    fd.set("videosPlafondUsd", String(r.videosPlafondUsd));
    fd.set("modeleImage", r.modeleImage);
    fd.set("modeleVideo", r.modeleVideo);
    fd.set("videoSecondesMax", String(r.videoSecondesMax));
    await run(() => enregistrerReglagesVisuels(fd), () => { setOk(true); setTimeout(() => setOk(false), 1800); });
  }

  return (
    <div className="space-y-4">
      <div className="divide-y divide-border rounded-xl border border-border">
        <section className="space-y-3 p-3 sm:p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium">Images générées et modifiées</p>
              <p className="text-xs text-muted-foreground">Une image demandée à l&apos;Assistant IA (ou retouchée depuis une pièce jointe) — environ 0,01 à 0,05 $ l&apos;image. Jamais de donnée confidentielle dans la description (filtrée).</p>
            </div>
            <Bascule coche={r.imagesActives} onClick={() => poser("imagesActives", !r.imagesActives)} libelle="Images générées" />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">Modèle
              <select className={CHAMP} value={r.modeleImage} onChange={(e) => poser("modeleImage", e.target.value)}>
                {MODELES_IMAGE.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">Plafond mensuel ($)
              <input className={CHAMP} type="number" min={0} max={10000} step={1} value={r.imagesPlafondUsd} onChange={(e) => poser("imagesPlafondUsd", Number(e.target.value))} />
            </label>
            <p className="self-end text-xs text-muted-foreground">Dépensé ce mois-ci : <span className="font-medium text-foreground">{depenseImagesUsd.toFixed(2)} $</span></p>
          </div>
        </section>

        <section className="space-y-3 p-3 sm:p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium">Vidéos générées par un modèle</p>
              <p className="text-xs text-muted-foreground">Lancées en arrière-plan ; facturées à la seconde. Coupées par défaut.</p>
              {videoIndisponible ? <p className="mt-1 text-xs text-warning">Indisponible chez le fournisseur : {videoIndisponible}.</p> : null}
            </div>
            <Bascule coche={r.videosActives} onClick={() => poser("videosActives", !r.videosActives)} libelle="Vidéos générées" />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">Modèle
              <select className={CHAMP} value={r.modeleVideo} onChange={(e) => poser("modeleVideo", e.target.value)}>
                {MODELES_VIDEO.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">Durée max (s)
              <select className={CHAMP} value={r.videoSecondesMax} onChange={(e) => poser("videoSecondesMax", Number(e.target.value))}>
                {DUREES_VIDEO.map((d) => <option key={d} value={d}>{d} s</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">Plafond mensuel ($)
              <input className={CHAMP} type="number" min={0} max={10000} step={1} value={r.videosPlafondUsd} onChange={(e) => poser("videosPlafondUsd", Number(e.target.value))} />
            </label>
            <p className="self-end text-xs text-muted-foreground">Dépensé ce mois-ci : <span className="font-medium text-foreground">{depenseVideosUsd.toFixed(2)} $</span></p>
          </div>
        </section>

        <section className="flex items-start justify-between gap-3 p-3 sm:p-4">
          <div className="min-w-0">
            <p className="text-sm font-medium">Vidéos de données</p>
            <p className="text-xs text-muted-foreground">Graphique animé (8 s, MP4) des chiffres lus dans l&apos;ERP, rendu par le serveur (worker) : aucun coût de modèle.</p>
          </div>
          <Bascule coche={r.donneesActives} onClick={() => poser("donneesActives", !r.donneesActives)} libelle="Vidéos de données" />
        </section>
      </div>
      <p className="text-xs text-muted-foreground">Qui peut générer : la famille « Images &amp; vidéos générées » de la console des accès (Administration › IA › Accès), fermée par défaut.</p>
      <Retour ton="erreur">{err}</Retour>
      <div className="flex flex-col-reverse items-stretch gap-2 sm:flex-row sm:items-center sm:justify-end sm:gap-3">
        {ok && <span className="flex items-center justify-center gap-1.5 text-sm text-success"><Check className="h-4 w-4" /> Enregistré</span>}
        <Button onClick={enregistrer} disabled={busy || !sale} className="w-full sm:w-auto">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          Enregistrer les visuels
        </Button>
      </div>
    </div>
  );
}
