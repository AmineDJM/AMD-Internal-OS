import * as React from "react";
import { cn } from "@/lib/utils";
import type { GenreDemande } from "@/lib/validations/centre-affichage";

/** La couleur de l'étiquette d'une ligne, par famille de demande (maquette du 24/11/2026). */
const TEINTE: Record<GenreDemande, string> = {
  BV: "bg-primary/10 text-primary",
  BC: "bg-warning/15 text-warning",
  SEC: "bg-secondary text-foreground",
  IM: "bg-success/15 text-success",
  PIECE: "bg-accent text-accent-foreground",
  AUTRE: "bg-secondary text-muted-foreground",
};

export function Etiquette({ genre, children }: { genre: GenreDemande; children: React.ReactNode }) {
  return <span className={cn("mr-1 inline-block rounded-md px-1.5 py-px align-[1px] text-xs font-bold", TEINTE[genre])}>{children}</span>;
}
