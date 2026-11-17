import * as React from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UNE SECTION QUI SE REPLIE (Direction, 17/11/2026 — « garder l'information, mais cachée : on clique pour voir le détail ;
 * simple, lisible, découpé en sections »).
 *
 * Fermée, elle tient sur une ligne : son titre, ce qu'il faut en savoir (`resume`), et « À vous » quand la personne qui
 * regarde a quelque chose à y faire — alors elle s'ouvre d'elle-même (`ouvert`). Ouverte, elle montre tout, comme avant.
 * Un `<details>` natif : rien à charger, le clavier et les lecteurs d'écran le connaissent, et la page serveur l'utilise
 * sans devenir un composant client.
 *
 * `sansCadre` : le contenu est une carte à part entière (discussion, équipe…) ; son cadre est retiré pour ne pas empiler
 * deux bordures.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export function SectionRepliable({ titre, resume, ouvert = false, aVous = false, compte, sansCadre = false, id, children }: {
  titre: string;
  /** Ce qu'on lit sans ouvrir : un statut, des chiffres, une date. */
  resume?: React.ReactNode;
  ouvert?: boolean;
  /** La personne qui regarde a un geste à faire ici. */
  aVous?: boolean;
  compte?: number;
  sansCadre?: boolean;
  id?: string;
  children: React.ReactNode;
}) {
  return (
    <details id={id} open={ouvert || aVous} className="group scroll-mt-20 border-t border-border first:border-t-0">
      <summary className="flex cursor-pointer list-none items-center gap-2 py-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary [&::-webkit-details-marker]:hidden">
        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" aria-hidden />
        <span className="shrink-0 text-sm font-semibold">{titre}</span>
        {compte !== undefined && <span className="shrink-0 text-xs tabular-nums text-muted-foreground">({compte})</span>}
        {aVous && <span className="shrink-0 rounded-full bg-primary px-2 py-0.5 text-[11px] font-semibold text-primary-foreground">À vous</span>}
        {resume && (
          <span className="ml-auto min-w-0 truncate pl-3 text-right text-xs text-muted-foreground group-open:hidden">{resume}</span>
        )}
      </summary>
      <div className={cn("pb-4 pl-6", sansCadre && "[&>*]:border-0 [&>*]:bg-transparent [&>*]:p-0 [&>*]:shadow-none")}>{children}</div>
    </details>
  );
}

/** Le contenant des sections : une carte, des sections séparées d'un filet. */
export function Sections({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("rounded-[var(--radius)] border border-border bg-card px-4 shadow-sm sm:px-5", className)}>{children}</div>;
}
