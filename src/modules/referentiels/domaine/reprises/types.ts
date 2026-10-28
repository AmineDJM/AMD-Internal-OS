/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CONTRAT COMMUN DES REPRISES (refonte des données, vague 2 — `docs/architecture/refonte-vague-2.md`).
 *
 * Une reprise remplit un référentiel depuis les tables existantes. Elle ne tourne JAMAIS toute seule au
 * déploiement : le Super Admin la lance depuis Administration › Refonte des données — d'abord un APERÇU
 * chiffré à blanc (rien n'est écrit), puis l'exécution PAR LOTS, chaque lot rendant le curseur du suivant.
 * Rejouée, elle ne refait rien : identifiants déterministes ou clés uniques.
 *
 * Plusieurs lots écrivent leurs reprises en parallèle : ce type est le seul point qu'ils partagent.
 * Module PUR (types seuls).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Le compte rendu d'un aperçu ou d'un lot. */
export interface BilanReprise {
  /** Lignes sources lues. */
  lues: number;
  /** Lignes du référentiel créées (ou qui le seraient, à l'aperçu). */
  creees: number;
  /** Lignes sources rattachées à une ligne du référentiel qui existait déjà. */
  liees: number;
  /** Doublons proposés à une décision humaine (jamais fusionnés d'office). */
  doublonsProposes: number;
  /** Lignes sources laissées telles quelles (déjà reprises, illisibles, en attente d'une autre reprise). */
  ignorees: number;
  /** Ce qui a échoué, en français — une ligne en échec n'arrête pas le lot. */
  erreurs: string[];
}

export interface Reprise {
  /** Identifiant stable (`organisations`, `personnes`…) — celui de l'action et du journal. */
  cle: string;
  titre: string;
  description: string;
  /** À BLANC : ce que l'exécution ferait, sans rien écrire. */
  apercu(): Promise<BilanReprise>;
  /** Un lot de `taille` lignes après le curseur `apresId` ; `suite` = curseur du lot suivant, nul à la fin. */
  executer(opts: { taille: number; apresId?: string | null }): Promise<BilanReprise & { suite: string | null }>;
}

export const bilanVide = (): BilanReprise => ({ lues: 0, creees: 0, liees: 0, doublonsProposes: 0, ignorees: 0, erreurs: [] });
