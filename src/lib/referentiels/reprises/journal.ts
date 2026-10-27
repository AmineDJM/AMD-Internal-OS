/**
 * LE JOURNAL DES REPRISES — l'`AuditLog` lui-même (module « Refonte des données », `field` = clé de la reprise,
 * `newValue` = le bilan en JSON). Pas de table de plus : chaque lot de la refonte écrit au même endroit, et
 * l'écran relit les dernières lignes de chaque reprise. Module PUR (importable par l'écran client).
 */

import type { BilanReprise } from "@/lib/referentiels/reprises/types";

export const MODULE_JOURNAL_REPRISES = "Refonte des données";

/** Les lignes traitées par un lot : assez pour avancer, assez peu pour tenir dans le délai d'une requête. */
export const TAILLE_LOT_REPRISE = 200;

export function resumeBilan(b: BilanReprise): string {
  const parts = [
    `${b.lues} lue(s)`,
    `${b.creees} créée(s)`,
    `${b.liees} reliée(s)`,
    b.doublonsProposes ? `${b.doublonsProposes} doublon(s) proposé(s)` : null,
    `${b.ignorees} ignorée(s)`,
    b.erreurs.length ? `${b.erreurs.length} erreur(s)` : null,
  ];
  return parts.filter(Boolean).join(", ");
}
