/**
 * LE FOCUS D'UNE COUCHE MODALE — règle PURE, sans import (audit 27/10/2026, FRONTEND-UX-02).
 *
 * `Sheet` se déclare `role="dialog" aria-modal="true"` : c'est une PROMESSE faite au lecteur
 * d'écran et au clavier — « tout se passe ici ». Sans gestion du focus, la promesse était fausse :
 * le focus restait sur le bouton qui avait ouvert la feuille, DERRIÈRE le voile ; Tab parcourait
 * la page masquée (la barre latérale, la liste) avant d'atteindre le formulaire ; et à la
 * fermeture, le focus tombait sur `<body>` — la personne au clavier repartait du haut de l'écran.
 *
 * Trois gestes, et ce module porte le seul qui demande un calcul : où va Tab au bord de la couche.
 * (Poser le focus à l'ouverture et le rendre à la fermeture vivent dans `sheet.tsx`.)
 */

/** Ce qu'on peut atteindre au clavier dans une couche. */
export const SELECTEUR_FOCUSABLE = [
  "a[href]", "button:not([disabled])", "input:not([disabled]):not([type=hidden])",
  "select:not([disabled])", "textarea:not([disabled])", "[tabindex]:not([tabindex='-1'])",
].join(",");

/**
 * L'index où le focus doit SAUTER quand Tab sortirait de la couche — ou `null` quand le
 * navigateur peut faire seul (on est au milieu de la liste).
 *
 * - Tab sur le dernier élément → le premier ; Maj+Tab sur le premier → le dernier.
 * - Focus hors de la liste (sur le conteneur lui-même, ou déjà sorti) → l'extrémité du sens.
 * - Liste vide → `null` : rien à atteindre, le conteneur garde le focus.
 */
export function sautDeFocus(nombre: number, courant: number, arriere: boolean): number | null {
  if (nombre === 0) return null;
  if (courant < 0) return arriere ? nombre - 1 : 0;
  if (!arriere && courant === nombre - 1) return 0;
  if (arriere && courant === 0) return nombre - 1;
  return null;
}
