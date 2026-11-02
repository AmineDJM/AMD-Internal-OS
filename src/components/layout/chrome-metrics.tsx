"use client";

import * as React from "react";

/**
 * MESURE DU CHROME — la hauteur réelle des barres, pas une estimation.
 *
 * Trois écrans occupent toute la hauteur disponible au lieu de défiler (assistant, messagerie,
 * éditeur Office). Pour savoir où s'arrêter, ils doivent connaître la hauteur de ce qui les
 * entoure : l'en-tête, les bandeaux éventuels, et la barre d'onglets basse.
 *
 * Ces hauteurs étaient recopiées en dur dans chaque écran — `3.5rem` ici, `7.5rem` là — des
 * valeurs qui ne correspondaient à aucune barre réelle. D'où le champ de saisie de l'assistant
 * caché derrière la barre d'onglets, et les boutons qu'on n'atteignait pas.
 *
 * On MESURE, pour deux raisons qu'une constante ne peut pas couvrir :
 *   • les bandeaux **passent à la ligne** sur un écran étroit — leur hauteur double ;
 *   • la barre d'onglets est `display: none` sur ordinateur — mesurée, elle vaut alors 0,
 *     sans qu'on ait besoin d'une règle média de plus qui pourrait diverger.
 */

/** Publie la hauteur d'un élément dans une variable CSS de `<html>`, et la tient à jour. */
function usePublishedHeight(ref: React.RefObject<HTMLElement | null>, cssVar: string): void {
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const root = document.documentElement;

    const publish = () => root.style.setProperty(cssVar, `${el.offsetHeight}px`);
    publish();

    // Repli d'un bandeau, rotation de l'écran, apparition d'un badge : la hauteur bouge.
    const ro = new ResizeObserver(publish);
    ro.observe(el);
    return () => {
      ro.disconnect();
      root.style.removeProperty(cssVar);
    };
  }, [ref, cssVar]);
}

/**
 * Enveloppe le chrome HAUT (bandeaux + en-tête) et publie sa hauteur dans `--app-chrome-top`.
 * `shrink-0` : c'est un enfant de la colonne flex de la coque, il ne doit pas se comprimer.
 */
export function ChromeMetrics({ children }: { children: React.ReactNode }) {
  const ref = React.useRef<HTMLDivElement>(null);
  usePublishedHeight(ref, "--app-chrome-top");
  return (
    // L'ENCOCHE. La page déclare `viewport-fit=cover` — c'est ce qui rend `env(safe-area-inset-*)`
    // utilisable — mais personne ne réservait la bande du HAUT : installée depuis « Ajouter à
    // l'écran d'accueil », l'application dessinait sa barre SOUS l'heure et la batterie, et le
    // menu comme l'avatar se trouvaient à moitié cachés. On réserve la bande, et on la peint de
    // la couleur de la barre : sans fond, on verrait le contenu défiler derrière l'encoche.
    // La hauteur mesurée inclut cette réserve — les écrans pleine hauteur restent justes.
    <div
      ref={ref}
      data-app-chrome
      className="shrink-0 bg-card pt-[env(safe-area-inset-top)]"
    >
      {children}
    </div>
  );
}

/** Publie la hauteur de la barre d'onglets basse dans `--app-chrome-bottom` (0 sur ordinateur). */
export function useTabBarHeight(ref: React.RefObject<HTMLElement | null>): void {
  usePublishedHeight(ref, "--app-chrome-bottom");
}
