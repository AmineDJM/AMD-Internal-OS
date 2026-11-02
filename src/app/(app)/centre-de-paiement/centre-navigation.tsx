import Link from "next/link";
import { Building2 } from "lucide-react";
import { cn, formatCurrency } from "@/lib/utils";
import {
  SECTION_CENTRE_LABEL, SECTION_CENTRE_SLUG, SECTIONS_CENTRE, type SectionCentre,
} from "@/modules/finances/partage";
import type { EntiteDuCentre, SectionDuCentre } from "@/modules/finances/api";

const CHEMIN = "/centre-de-paiement";

/** L'adresse d'une vue — l'entité ET la section, lisibles, partageables, et sans rechargement bloquant. */
export function hrefCentre(entite: string | null, section: SectionCentre): string {
  const p = new URLSearchParams();
  if (entite) p.set("entite", entite);
  p.set("section", SECTION_CENTRE_SLUG[section]);
  return `${CHEMIN}?${p.toString()}`;
}

/**
 * LES ENTITÉS EN HAUT (§118.211) — une pastille par société que la personne voit, avec ce qui y
 * attend une décision. Changer d'entité est un lien : la page se remplace sans rechargement
 * complet, et la section regardée est conservée (on compare « Regulatory » d'une société à l'autre).
 * Sur téléphone, la rangée défile DANS son cadre — jamais la page.
 */
export function BarreEntites({ entites, choisie, section }: { entites: EntiteDuCentre[]; choisie: string | null; section: SectionCentre }) {
  return (
    <nav aria-label="Entités" className="-mx-1 overflow-x-auto px-1 pb-1">
      <ul className="flex min-w-max gap-2">
        {entites.map((e) => {
          const active = e.cle === choisie;
          return (
            <li key={e.cle}>
              <Link
                href={hrefCentre(e.cle, section)} scroll={false}
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

/** LES TROIS SECTIONS d'une entité — Regulatory, Sales & Marketing, Autres, chacune avec son compte. */
export function OngletsSections({ sections, choisie, entite }: { sections: SectionDuCentre[]; choisie: SectionCentre; entite: string | null }) {
  return (
    <nav aria-label="Types de demandes de paiement" className="grid grid-cols-3 gap-1.5 border-b border-border sm:flex sm:gap-1">
      {SECTIONS_CENTRE.map((s) => {
        const info = sections.find((x) => x.section === s)!;
        const active = s === choisie;
        return (
          <Link
            key={s}
            href={hrefCentre(entite, s)} scroll={false}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex min-h-11 flex-col items-center justify-center gap-0.5 border-b-2 px-2 py-1.5 text-center text-sm font-medium transition-colors sm:flex-row sm:gap-2 sm:px-3.5",
              active ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            <span>{SECTION_CENTRE_LABEL[s]}</span>
            <span className="flex items-center gap-1 text-xs tabular-nums">
              <span className={cn("rounded-full px-1.5 py-0.5", info.enAttente > 0 ? "bg-warning/15 font-semibold text-warning" : "bg-secondary text-muted-foreground")} title="En attente d'une décision">
                {info.enAttente}
              </span>
              <span className="text-muted-foreground" title="Tous les paiements de cette section">/ {info.total}</span>
            </span>
          </Link>
        );
      })}
    </nav>
  );
}
