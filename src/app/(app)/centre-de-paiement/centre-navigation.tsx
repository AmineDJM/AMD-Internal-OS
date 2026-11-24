import Link from "next/link";
import { cn, formatCurrency } from "@/lib/utils";
import type { EntiteDuCentre } from "@/modules/finances/api";

const CHEMIN = "/centre-de-paiement";

/** L'adresse d'une vue — l'entité, lisible, partageable, et sans rechargement bloquant. */
export function hrefCentre(entite: string | null): string {
  return entite ? `${CHEMIN}?entite=${encodeURIComponent(entite)}` : CHEMIN;
}

/**
 * LES SOCIÉTÉS, EN PASTILLES DANS L'EN-TÊTE (maquette du 24/11/2026) — une par société que la personne voit, avec le
 * nombre de paiements qui y attendent une décision. Changer de société est un lien : la page se remplace sans
 * rechargement complet. C'est le SEUL filtre du centre : toutes les origines partagent la même file. Au téléphone, la
 * rangée défile DANS son cadre — jamais la page.
 */
export function BarreEntites({ entites, choisie }: { entites: EntiteDuCentre[]; choisie: string | null }) {
  return (
    <nav aria-label="Entités" className="min-w-0 overflow-x-auto rounded-[10px] border border-border bg-card p-1">
      <ul className="flex min-w-max gap-1">
        {entites.map((e) => {
          const active = e.cle === choisie;
          return (
            <li key={e.cle}>
              <Link
                href={hrefCentre(e.cle)} scroll={false}
                aria-current={active ? "page" : undefined}
                title={e.enAttente > 0 ? `${e.enAttente} à décider — ${formatCurrency(e.montantEnAttente)}` : "Rien à décider"}
                className={cn(
                  "flex min-h-10 items-center gap-1.5 whitespace-nowrap rounded-[7px] px-3 text-sm transition-colors",
                  active ? "bg-primary/10 font-semibold text-primary" : "text-muted-foreground hover:bg-secondary hover:text-foreground",
                )}
              >
                {e.label}
                <span className={cn("text-xs tabular-nums", e.enAttente > 0 ? "font-semibold" : "opacity-60")}>{e.enAttente}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
