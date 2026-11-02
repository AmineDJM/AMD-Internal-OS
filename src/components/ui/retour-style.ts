import type * as React from "react";
import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";
import type { TonRetour } from "./retour-regle";

/** La couleur et l'icône de chaque ton — partagées par le bandeau (`retour.tsx`) et les avis (`retours-pile.tsx`). */
export const STYLE: Record<TonRetour, { classe: string; Icone: React.ComponentType<{ className?: string }> }> = {
  erreur: { classe: "border-destructive/30 bg-destructive/10 text-destructive", Icone: XCircle },
  alerte: { classe: "border-warning/40 bg-warning/10 text-foreground", Icone: AlertTriangle },
  succes: { classe: "border-success/30 bg-success/10 text-foreground", Icone: CheckCircle2 },
  info: { classe: "border-border bg-secondary text-foreground", Icone: Info },
};
