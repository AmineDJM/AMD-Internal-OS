"use client";

import * as React from "react";
import type { VizType, WorkspaceBlock } from "@/platform/ia/workspace/protocol";
import { Card, Chip } from "../primitives";
import { VizFigure } from "./viz-figure";

/**
 * LE BLOC « REPRÉSENTATION » (§35) — la carte autour de la figure : le titre, la forme et la source
 * en méta, les ALERTES d'abord (ce qui tromperait se lit avant le dessin, pas après), la figure,
 * puis la raison de la forme et la note. Le dessin lui-même vit dans `viz-figure.tsx`.
 */
const FORME: Record<VizType, string> = {
  barres: "Barres", barres_empilees: "Barres empilées", courbe: "Courbe", aires: "Aires", nuage: "Nuage de points",
  histogramme: "Histogramme", secteurs: "Secteurs", cascade: "Cascade", entonnoir: "Entonnoir", heatmap: "Carte de chaleur",
  gantt: "Gantt", matrice: "Matrice", graphe: "Réseau", arbre: "Arbre", flux: "Flux", carte: "Carte", cartes: "Indicateurs",
};

export function VizBlock({ b }: { b: Extract<WorkspaceBlock, { kind: "viz" }> }) {
  const meta = [FORME[b.type], b.unite ? `en ${b.unite}` : null, b.source].filter(Boolean).join(" · ");
  const alertes = b.alertes ?? [];
  return (
    <Card title={b.title} meta={meta || undefined} actions={b.actions}>
      {alertes.length ? (
        <ul className="chief-viz-alertes chief-list" data-testid="viz-alertes">
          {alertes.map((a, i) => {
            const trompeur = /^TROMPEUR/i.test(a);
            return (
              <li key={i}>
                <Chip label={trompeur ? "Trompeur" : "À vérifier"} ton={trompeur ? "alerte" : "attention"} />
                <span>{a.replace(/^(TROMPEUR|DOUTEUX)\s*·\s*/i, "")}</span>
              </li>
            );
          })}
        </ul>
      ) : null}
      <VizFigure b={b} />
      {b.raison || b.note ? <p className="chief-block-note">{[b.raison, b.note].filter(Boolean).join(" — ")}</p> : null}
    </Card>
  );
}
