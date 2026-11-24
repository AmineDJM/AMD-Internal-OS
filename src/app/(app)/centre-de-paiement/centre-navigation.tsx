import Link from "next/link";
import { Building2 } from "lucide-react";
import { cn, formatCurrency } from "@/lib/utils";
import type { EntiteDuCentre } from "@/modules/finances/api";

const CHEMIN = "/centre-de-paiement";

/** L'adresse d'une vue — l'entité, lisible, partageable, et sans rechargement bloquant. */
export function hrefCentre(entite: string | null): string {
  return entite ? `${CHEMIN}?entite=${encodeURIComponent(entite)}` : CHEMIN;
}

/**
 * LES ENTITÉS EN HAUT (§118.211) — une pastille par société que la personne voit, avec ce qui y
 * attend une décision. Changer d'entité est un lien : la page se remplace sans rechargement
 * complet. C'est le SEUL filtre du centre : toutes les origines partagent la même file.
 * Sur téléphone, la rangée défile DANS son cadre — jamais la page.
 */
export function BarreEntites({ entites, choisie }: { entites: EntiteDuCentre[]; choisie: string | null }) {
  return (
    <nav aria-label="Entités" className="-mx-1 overflow-x-auto px-1 pb-1">
      <ul className="flex min-w-max gap-2">
        {entites.map((e) => {
          const active = e.cle === choisie;
          return (
            <li key={e.cle}>
              <Link
                href={hrefCentre(e.cle)} scroll={false}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex min-h-11 items-center gap-2 rounded-xl border px-3 py-2 text-sm font-medium transition-colors",
                  active ? "border-primary bg-primary/10 text-foreground" : "border-border bg-background text-muted-foreground hover:bg-secondary hover:text-foreground",
                )}
              >
                <Building2 className="h-4 w-4 shrink-0" aria-hidden />
                <span className="whitespace-nowrap">{e.label}</span>
                <span
                  className={cn(
                    "rounded-full px-2 py-0.5 text-xs tabular-nums",
                    e.enAttente > 0 ? "bg-warning/15 font-semibold text-warning" : "bg-secondary text-muted-foreground",
                  )}
                  title={e.enAttente > 0 ? `${e.enAttente} en attente — ${formatCurrency(e.montantEnAttente)}` : "Rien en attente"}
                >
                  {e.enAttente}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
