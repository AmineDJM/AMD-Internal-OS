import * as React from "react";
import { ChevronRight } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES PIÈCES DE LA CARTE « LA DEMANDE » (Direction, 07/10 — fiches Sponsoring et Événements).
 *
 * « Détails de la demande », « Postes » et « Circuit de validation » ne font plus qu'une carte, lue dans l'ordre :
 * la frise et la phrase de statut (le panneau du circuit en rendu compact), les faits une seule fois, l'argent en
 * UN bandeau de quatre chiffres, ce qu'on lit à la demande replié, puis les postes. Et tout en bas de la fiche,
 * « Traçabilité ». Des blocs d'affichage purs — aucun droit, aucune donnée lue ici : la page les calcule.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Les faits de la demande, une seule fois, en grille compacte. */
export function Faits({ children }: { children: React.ReactNode }) {
  return <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-3 lg:grid-cols-5">{children}</dl>;
}

export function Fait({ label, valeur, large = false }: { label: string; valeur: React.ReactNode; large?: boolean }) {
  return (
    <div className={cn("min-w-0", large && "col-span-full")}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-medium [overflow-wrap:anywhere]">{valeur || "—"}</dd>
    </div>
  );
}

/** L'argent, en un bandeau de quatre chiffres (deux par ligne au téléphone). */
export function BandeauArgent({ children }: { children: React.ReactNode }) {
  return <div aria-label="Montants" className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">{children}</div>;
}

export function Chiffre({ label, valeur, note, ton, discret = false }: {
  label: string;
  valeur: string;
  note?: string | null;
  ton?: "succes" | "alerte" | "attente";
  /** Une valeur qui n'est pas un montant (« À la validation finale », « Non tranchée ») : plus petite, plus grise. */
  discret?: boolean;
}) {
  const couleurNote = ton === "succes" ? "text-success" : ton === "alerte" ? "text-destructive" : ton === "attente" ? "text-warning" : "text-muted-foreground";
  return (
    <div className="min-w-0 rounded-lg border border-border bg-secondary/20 px-3 py-2">
      <p className="truncate text-xs text-muted-foreground" title={label}>{label}</p>
      <p className={cn("truncate font-semibold tabular-nums", discret ? "text-sm text-muted-foreground" : "text-base", ton === "alerte" && !discret && "text-destructive")} title={valeur}>{valeur}</p>
      {note && <p className={cn("truncate text-[0.6875rem]", couleurNote)} title={note}>{note}</p>}
    </div>
  );
}

/** Ce qu'on lit à la demande : replié par défaut. */
export function Repli({ titre, children }: { titre: string; children: React.ReactNode }) {
  return (
    <details className="group border-t border-border/70 pt-3">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
        <ChevronRight className="h-3.5 w-3.5 shrink-0 transition-transform group-open:rotate-90" /> {titre}
      </summary>
      <div className="mt-2 max-w-prose space-y-2 text-sm">{children}</div>
    </details>
  );
}

/** L'intertitre des postes, dans la carte. */
export function IntertitrePostes({ n }: { n: number }) {
  return (
    <h3 className="border-t border-border/70 pt-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      Postes ({n})
    </h3>
  );
}

/**
 * TRAÇABILITÉ — créée le, modifiée le ; et, pour le Super Admin seulement, l'historique du circuit (Direction, 07/10).
 * La page décide qui reçoit `historique`.
 */
export function CarteTracabilite({ creeeLe, modifieeLe, historique }: {
  creeeLe: string;
  modifieeLe: string;
  historique?: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader><CardTitle>Traçabilité</CardTitle></CardHeader>
      <CardContent className="space-y-3 text-sm">
        <dl className="space-y-1">
          <div className="flex flex-wrap gap-x-1.5"><dt className="text-muted-foreground">Créée le</dt><dd className="font-medium">{creeeLe}</dd></div>
          <div className="flex flex-wrap gap-x-1.5"><dt className="text-muted-foreground">Modifiée le</dt><dd className="font-medium">{modifieeLe}</dd></div>
        </dl>
        {historique && (
          <div className="space-y-1.5 border-t border-border/70 pt-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Historique du circuit</p>
            {historique}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
