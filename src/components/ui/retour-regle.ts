/**
 * LE RETOUR D'UN GESTE — sa règle, PURE et sans import (V3-B, audit 27/10/2026 FRONTEND-UX-05).
 *
 * ── POURQUOI ────────────────────────────────────────────────────────────────────────────────
 *
 * Le parc disait le résultat d'un geste de quatre façons : `window.alert()` (45 appels — boîte
 * grise bloquante), un `<p>` rouge sans rôle (muet pour un lecteur d'écran), un « Échec. » qui ne
 * dit ni quoi ni que faire, ou rien du tout. `ui/retour.tsx` porte deux formes, une seule règle :
 *
 *   - `<Retour ton>` — le BANDEAU dans l'écran, à côté du geste (l'erreur d'un formulaire) ;
 *   - `useRetours()` — l'AVIS flottant, quand le geste n'a pas de place pour parler (un bouton
 *     dans une ligne de tableau, un menu).
 *
 * Ce module décide comment chacun est ANNONCÉ et combien de temps il RESTE — c'est ce qui se teste.
 */

export type TonRetour = "erreur" | "alerte" | "succes" | "info";

/** Un avis flottant affiché. */
export interface AvisRetour {
  id: number;
  ton: TonRetour;
  message: string;
}

/** Combien d'avis à la fois : au-delà, la pile couvre l'écran au téléphone. */
export const AVIS_MAX = 3;

/**
 * Le rôle ARIA : une erreur ou une alerte INTERROMPT le lecteur d'écran (`alert`, assertif) ; un
 * succès ou une information attend la fin de la phrase en cours (`status`, poli).
 */
export function roleDuRetour(ton: TonRetour): "alert" | "status" {
  return ton === "erreur" || ton === "alerte" ? "alert" : "status";
}

/**
 * Combien de temps un avis reste affiché, en ms — ou `null` : il reste jusqu'à ce qu'on le ferme.
 *
 * Une ERREUR ne s'efface jamais seule : elle dit souvent quoi vérifier (« l'enregistrement a pu
 * aboutir »), et une personne qui a détourné les yeux deux secondes la perdrait. Les autres restent
 * le temps de les lire — environ 60 ms par caractère, jamais moins de 4 s, jamais plus de 10 s.
 */
export function dureeDuRetour(ton: TonRetour, message: string): number | null {
  if (ton === "erreur" || ton === "alerte") return null;
  return Math.min(10_000, Math.max(4_000, message.length * 60));
}

/**
 * Ajoute un avis à la pile. Le même message déjà affiché n'est pas doublé (un double clic sur un
 * geste refusé ne doit pas empiler deux fois la même phrase) : il remonte en tête, renouvelé. Au-delà
 * de `max`, le plus ancien sort.
 */
export function empiler(pile: AvisRetour[], avis: AvisRetour, max = AVIS_MAX): AvisRetour[] {
  const sans = pile.filter((a) => !(a.ton === avis.ton && a.message === avis.message));
  return [...sans, avis].slice(-max);
}
