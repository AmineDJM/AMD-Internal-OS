"use client";

import * as React from "react";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { Badge } from "@/components/ui/badge";
import type { AnalysisProgressResult } from "@/lib/regulatory/intelligence/progress/query";

/**
 * BADGE VIVANT de la liste des dossiers — « Analyse en cours » cesse d'être un mot figé pour
 * devenir un pourcentage qui monte, avec une pastille qui pulse. Seules les cartes en cours
 * d'analyse s'actualisent (poll doux à 8 s) ; les autres affichent un badge statique. Quand une
 * analyse se termine, la liste se rafraîchit d'elle-même pour montrer le nouveau statut.
 */
const ACTIVE = new Set(["INGESTING", "INGESTED", "ANALYSING"]);

export function LiveAnalysisBadge({
  versionId, status, label, tone,
}: {
  versionId: string | null;
  status: string;
  label: string;
  tone: "neutral" | "info" | "success" | "warning" | "danger" | "purple";
}) {
  const { rafraichir } = useRafraichir();
  const [pct, setPct] = React.useState<number | null>(null);
  const active = ACTIVE.has(status) && !!versionId;

  React.useEffect(() => {
    if (!active || !versionId) return;
    let alive = true;
    const tick = async () => {
      try {
        const res = await fetch(`/api/regulatory/intelligence/progress/${versionId}`, { cache: "no-store" });
        if (!res.ok || !alive) return;
        const p = (await res.json()) as AnalysisProgressResult;
        if (!alive) return;
        setPct(p.percent);
        if (!p.running) rafraichir(); // terminé → la liste reflète le nouveau statut
      } catch { /* réseau : prochain tick */ }
    };
    void tick();
    const id = setInterval(tick, 8000);
    return () => { alive = false; clearInterval(id); };
  }, [active, versionId, rafraichir]);

  if (!active) return <Badge tone={tone} dot>{label}</Badge>;

  return (
    <Badge tone={tone} className="gap-1.5">
      <span className="relative flex h-1.5 w-1.5">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-60" />
        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-current" />
      </span>
      {label}
      {pct != null && <span className="tabular-nums font-semibold">· {pct}%</span>}
    </Badge>
  );
}
