"use client";

import * as React from "react";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { CheckCircle2, Loader2, Clock, Sparkles, Hourglass, PauseCircle, AlertTriangle } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { formatEta, type PhaseState } from "@/lib/regulatory/intelligence/progress/analysis-progress";
import type { AnalysisProgressResult } from "@/lib/regulatory/intelligence/progress/query";

/**
 * CARTE DE PROGRESSION VIVANTE — ce que le pharmacien REGARDE pendant que la machine travaille.
 *
 * Rendue une première fois côté serveur (pas de clignotement au chargement), puis elle s'actualise
 * seule toutes les ~4 s tant que l'analyse tourne. Chaque tick réveille aussi le pipeline (côté
 * serveur) : regarder la barre suffit à faire avancer l'analyse. Quand tout est terminé, la carte
 * rafraîchit la page pour révéler le verdict et les constats — puis disparaît.
 */
export function AnalysisProgressCard({ versionId, initial }: { versionId: string; initial: AnalysisProgressResult }) {
  const { rafraichir } = useRafraichir();
  const [p, setP] = React.useState<AnalysisProgressResult>(initial);
  const wasRunning = React.useRef(initial.running);

  React.useEffect(() => {
    if (!p.running) return;
    let alive = true;
    const tick = async () => {
      try {
        const res = await fetch(`/api/regulatory/intelligence/progress/${versionId}`, { cache: "no-store" });
        if (!res.ok || !alive) return;
        const next = (await res.json()) as AnalysisProgressResult;
        if (!alive) return;
        setP(next);
        // Transition « ça tournait → c'est fini » : on révèle les résultats.
        if (wasRunning.current && !next.running) rafraichir();
        wasRunning.current = next.running;
      } catch { /* réseau : prochain tick */ }
    };
    const id = setInterval(tick, 4000);
    return () => { alive = false; clearInterval(id); };
  }, [versionId, p.running, rafraichir]);

  // UNE ANALYSE QUI N'A PAS EU LIEU DOIT SE VOIR. Sans ce bloc, une panne totale donnait
  // exactement le même écran qu'un dossier irréprochable : rien.
  if (!p.running && p.aiFailure) {
    return (
      <Card className="border-destructive/50">
        <CardContent className="space-y-2 p-4 sm:p-5">
          <p className="flex items-center gap-2 text-sm font-semibold text-destructive">
            <AlertTriangle className="h-4 w-4 shrink-0" /> La revue de fond n&apos;a pas pu s&apos;exécuter
          </p>
          <p className="text-xs text-muted-foreground">
            Ce dossier <strong>n&apos;a pas été examiné sur le fond</strong> : les contrôles de complétude ci-dessous
            restent valables, mais aucun constat d&apos;analyse n&apos;a pu être produit. Les constats précédents ont été conservés.
          </p>
          <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-2.5 py-1.5 font-mono text-[0.6875rem] text-destructive">
            {p.aiFailure}
          </p>
          <p className="text-[0.6875rem] text-muted-foreground">
            Relancez avec « Relancer l&apos;analyse » (porte de soumission) une fois la cause levée.
          </p>
        </CardContent>
      </Card>
    );
  }

  // Analyse aboutie mais SANS le moindre constat : à dire aussi — c'est une information, pas un vide.
  if (!p.running && p.aiFoundNothing) {
    return (
      <Card className="border-success/40">
        <CardContent className="p-4 sm:p-5">
          <p className="flex items-center gap-2 text-sm font-semibold text-success">
            <CheckCircle2 className="h-4 w-4 shrink-0" /> Revue de fond terminée — aucun écart relevé
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            L&apos;IA a lu le dossier sans relever d&apos;écart de fond. Ce n&apos;est pas une garantie de conformité :
            la relecture humaine reste requise, et les contrôles de complétude ci-dessous font foi.
          </p>
        </CardContent>
      </Card>
    );
  }

  // Rien à montrer si l'analyse est finie ET la page déjà à jour.
  if (!p.running && p.complete) return null;

  const eta = formatEta(p.etaSeconds);
  const barTone = p.stalled ? "bg-amber-500" : p.awaitingDeferred ? "bg-primary/70" : "bg-primary";

  return (
    <Card className="overflow-hidden border-primary/40">
      <CardContent className="space-y-3 p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
            {p.stalled ? <PauseCircle className="h-5 w-5" /> : p.awaitingDeferred ? <Hourglass className="h-5 w-5" /> : <Loader2 className="h-5 w-5 animate-spin" />}
          </span>
          <div className="min-w-0 flex-1">
            <p className="flex flex-wrap items-center gap-x-2 text-sm font-semibold">
              {p.awaitingDeferred ? "Revue de fond en attente" : "Analyse en cours"}
              <span className="text-muted-foreground">·</span>
              <span className="font-normal text-muted-foreground">{p.phaseLabel}</span>
            </p>
            <p className="text-[0.6875rem] text-muted-foreground">
              {p.stalled
                ? "En pause — reprend dès qu'un membre du service est connecté à la plateforme."
                : p.awaitingDeferred
                  ? "Les constats de fond arriveront sous 24 h (analyse à moitié prix). Vous serez prévenu."
                  : "Travail en arrière-plan : vous pouvez fermer cette page, l'analyse continue."}
            </p>
          </div>
          <span className="shrink-0 text-2xl font-bold tabular-nums text-primary">{p.percent}%</span>
        </div>

        {/* La barre — avec une bande lumineuse qui balaie tant que ça avance. */}
        <div className="relative h-2.5 w-full overflow-hidden rounded-full bg-secondary">
          <div className={`h-full rounded-full transition-all duration-700 ${barTone}`} style={{ width: `${p.percent}%` }} />
          {p.running && !p.stalled && !p.awaitingDeferred && (
            <div className="pointer-events-none absolute inset-y-0 left-0" style={{ width: `${p.percent}%` }}>
              <div className="reg-progress-sheen h-full w-1/3 bg-gradient-to-r from-transparent via-white/45 to-transparent" />
            </div>
          )}
        </div>

        {/* Temps restant — l'information qui calme l'attente. */}
        {eta && !p.awaitingDeferred && (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Clock className="h-3.5 w-3.5" /> Temps restant estimé : <span className="font-medium text-foreground">{eta}</span>
          </p>
        )}

        {/* Les étapes, du début à la fin — l'itinéraire complet, pas juste un pourcentage. */}
        <ol className="space-y-1.5 pt-1">
          {p.phases.map((ph) => (
            <li key={ph.key} className="flex items-center gap-2.5 text-sm">
              <StepIcon state={ph.state} />
              <span className={"min-w-0 " + (ph.state === "failed" ? "font-semibold text-destructive" : ph.state === "active" ? "font-semibold text-foreground" : ph.state === "done" ? "text-foreground" : "text-muted-foreground")}>
                {ph.label}
              </span>
              {ph.detail && (
                <span className="ml-auto shrink-0 text-[0.6875rem] tabular-nums text-muted-foreground">{ph.detail}</span>
              )}
            </li>
          ))}
        </ol>

        {p.awaitingDeferred && (
          <p className="flex items-start gap-2 rounded-lg border border-primary/20 bg-primary/5 px-2.5 py-1.5 text-[0.6875rem] text-muted-foreground">
            <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
            <span>Le bilan de conformité (complétude, bloqueurs) est <strong>déjà disponible ci-dessous</strong> — seuls les constats fins de l'IA sont encore en préparation.</span>
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function StepIcon({ state }: { state: PhaseState }) {
  if (state === "done") return <CheckCircle2 className="h-4 w-4 shrink-0 text-success" />;
  // Une étape ÉCHOUÉE doit se distinguer d'une étape faite : l'une a produit un résultat, l'autre non.
  if (state === "failed") return <AlertTriangle className="h-4 w-4 shrink-0 text-destructive" />;
  if (state === "active") return <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />;
  if (state === "skipped") return <span className="h-4 w-4 shrink-0 text-center text-muted-foreground/50">—</span>;
  return <span className="flex h-4 w-4 shrink-0 items-center justify-center"><span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40" /></span>;
}
