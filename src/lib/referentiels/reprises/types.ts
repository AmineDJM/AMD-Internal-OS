/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CONTRAT COMMUN DES REPRISES (refonte des données, vague 2 — `docs/architecture/refonte-vague-2.md`).
 *
 * Une reprise remplit un référentiel depuis les tables existantes. Elle ne tourne JAMAIS toute seule au
 * déploiement : le Super Admin la lance depuis `Administration › Refonte des données`, d'abord à blanc
 * (`apercu`), puis par lots (`executer`), et peut la rejouer sans effet de bord (identifiants
 * déterministes ou clés uniques). Chaque lot partage CE contrat : l'écran et l'action serveur ne
 * connaissent que lui.
 *
 * Module PUR : des types, rien d'autre.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Le compte rendu d'un aperçu ou d'un lot. */
export interface BilanReprise {
  /** Lignes sources lues. */
  lues: number;
  /** Lignes de référentiel créées (ou qui le seraient, à blanc). */
  creees: number;
  /** Lignes sources reliées à une ligne de référentiel qui existait déjà. */
  liees: number;
  /** Doublons PROPOSÉS — jamais fusionnés d'office. */
  doublonsProposes: number;
  /** Lignes laissées de côté, à dessein (déjà reliées, comptes techniques…). */
  ignorees: number;
  /** Les erreurs, en français, une par ligne en échec. */
  erreurs: string[];
}

export interface Reprise {
  /** Identifiant stable (« personnes-users ») : clé du journal et de l'action serveur. */
  cle: string;
  titre: string;
  description: string;
  /** À BLANC : compte ce que ferait l'exécution complète, n'écrit rien. */
  apercu(): Promise<BilanReprise>;
  /** UN LOT d'au plus `taille` lignes après le curseur `apresId` ; `suite` = le curseur suivant, `null` = terminé. */
  executer(opts: { taille: number; apresId?: string | null }): Promise<BilanReprise & { suite: string | null }>;
}

export const bilanVide = (): BilanReprise => ({ lues: 0, creees: 0, liees: 0, doublonsProposes: 0, ignorees: 0, erreurs: [] });
