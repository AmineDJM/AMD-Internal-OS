"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { ongletActif } from "@/lib/navigation";

export interface ModuleTab {
  label: string;
  href: string;
  /** Onglet masqué si l'utilisateur n'a pas le droit (false). Par défaut visible. */
  show?: boolean;
  /**
   * L'adresse qui ALLUME l'onglet quand le lien porte des paramètres (Force de vente : `?bu=…&y=…` suivent d'une vue à
   * l'autre). Absent = le lien lui-même.
   */
  chemin?: string;
  /** Un compteur discret à côté du libellé (« Tâches 7 ») — absent ou 0 : rien. */
  compte?: number;
  /** Le ton du compteur : discret par défaut, « warning » pour ce qui attend une décision (Intégration 2026). */
  tonCompte?: "warning";
}

/**
 * Barre d'onglets d'un module fusionné (ex. Finances · Espace comptable). Chaque
 * onglet reste sa propre route, gardée par son propre module ; on n'affiche que
 * les onglets autorisés. Si un seul onglet est accessible, aucune barre n'est rendue.
 *
 * `arrows` ajoute deux CHEVRONS qui mènent au sous-module précédent et suivant. Ils servent
 * quand les sous-modules se parcourent dans l'ordre — les Finances se lisent ainsi : on regarde
 * le tableau de bord, on passe aux paiements à faire, on finit dans la comptabilité. Aux
 * extrémités, le chevron est désactivé plutôt que masqué : un bouton qui disparaît déplace les
 * autres sous le curseur.
 */
export function ModuleTabs({ tabs, arrows = false }: { tabs: ModuleTab[]; arrows?: boolean }) {
  const pathname = usePathname();
  // `href` = l'adresse qui allume l'onglet ; `lien` = celle où il mène (les deux se confondent sans `chemin`).
  const visible = tabs.filter((t) => t.show !== false).map((t) => ({ ...t, href: t.chemin ?? t.href, lien: t.href }));

  // Le plus PRÉCIS des onglets qui correspondent, et lui seul (§118.164) : sans cela, un
  // sous-module rangé sous l'adresse d'un autre allumait les deux.
  const actif = ongletActif(pathname, visible.map((t) => t.href));
  const isActive = (href: string) => href === actif;
  const index = visible.findIndex((t) => isActive(t.href));
  const prev = index > 0 ? visible[index - 1] : null;
  const next = index >= 0 && index < visible.length - 1 ? visible[index + 1] : null;

  const arrowCls = "flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors";

  // AU TÉLÉPHONE, UNE SEULE LIGNE QUI GLISSE — six onglets repliés sur trois lignes mangeaient le tiers de l'écran et
  // cassaient le repère « où suis-je ». L'onglet actif est ramené dans le champ à l'arrivée : on ne le cherche pas.
  const barre = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    // Le défilement de la BARRE seule — `scrollIntoView` ferait aussi bouger la page.
    const bar = barre.current;
    const el = bar?.querySelector<HTMLElement>("[aria-current=page]");
    if (bar && el && bar.scrollWidth > bar.clientWidth) bar.scrollLeft = el.offsetLeft - (bar.clientWidth - el.offsetWidth) / 2;
  }, [actif]);

  // UN SEUL ONGLET, AUCUNE BARRE — le retour vient APRÈS les crochets : React les veut dans le même ordre à chaque rendu.
  if (visible.length <= 1) return null;

  return (
    <div ref={barre} className="no-scrollbar relative -mx-3 flex snap-x items-center gap-1 overflow-x-auto overscroll-x-contain border-b border-border px-3 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0">
      {arrows && (
        prev ? (
          <Link href={prev.lien} aria-label={`Sous-module précédent : ${prev.label}`} title={prev.label} className={cn(arrowCls, "hover:bg-secondary hover:text-foreground")}>
            <ChevronLeft className="h-4 w-4" />
          </Link>
        ) : (
          <span aria-hidden className={cn(arrowCls, "opacity-30")}><ChevronLeft className="h-4 w-4" /></span>
        )
      )}
      {visible.map((t) => (
        <Link
          key={t.href}
          href={t.lien}
          // L'onglet actif se DIT aussi aux lecteurs d'écran : la couleur seule ne se lit pas.
          aria-current={isActive(t.href) ? "page" : undefined}
          className={cn(
            "shrink-0 snap-start whitespace-nowrap border-b-2 px-3.5 py-2.5 text-sm font-medium transition-colors sm:py-2",
            isActive(t.href)
              ? "border-primary text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground",
          )}
        >
          {t.label}
          {t.compte ? (
            <span className={cn("ml-1.5 inline-block rounded-full px-1.5 text-[0.6875rem] font-medium tabular-nums", t.tonCompte === "warning" ? "bg-warning/15 font-semibold text-warning" : "bg-muted text-muted-foreground")}>{t.compte}</span>
          ) : null}
        </Link>
      ))}
      {arrows && (
        next ? (
          <Link href={next.lien} aria-label={`Sous-module suivant : ${next.label}`} title={next.label} className={cn(arrowCls, "hover:bg-secondary hover:text-foreground")}>
            <ChevronRight className="h-4 w-4" />
          </Link>
        ) : (
          <span aria-hidden className={cn(arrowCls, "opacity-30")}><ChevronRight className="h-4 w-4" /></span>
        )
      )}
    </div>
  );
}
