/**
 * LE CONTRAT COMMUN DES REPRISES (refonte des données, vague 2 — `docs/architecture/refonte-vague-2.md`).
 *
 * Une reprise remplit un référentiel depuis l'existant. Elle ne tourne JAMAIS seule au déploiement : le Super Admin
 * la lance depuis Administration › Refonte des données — un APERÇU à blanc (rien n'est écrit), puis des LOTS, chacun
 * journalisé. Elle est REJOUABLE : identifiants déterministes ou clés uniques, un second passage n'ajoute rien.
 *
 * Plusieurs lots écrivent des reprises en parallèle : ce fichier est le seul point d'accord. Une reprise =
 * un module `reprises/<cle>.ts` qui exporte un objet `Reprise`, et une ligne dans `index.ts`.
 *
 * Module PUR (types seuls) : importable par l'écran client.
 */

/** Le compte rendu d'un aperçu ou d'un lot. */
export interface BilanReprise {
  /** Lignes sources lues. */
  lues: number;
  /** Lignes du référentiel créées (à blanc : qui SERAIENT créées). */
  creees: number;
  /** Lignes sources rattachées à une ligne du référentiel (existante ou créée). */
  liees: number;
  /** Doublons PROPOSÉS (jamais fusionnés d'office). */
  doublonsProposes: number;
  /** Lignes sources laissées telles quelles (rien à reprendre, ou cas ambigu listé dans `erreurs`). */
  ignorees: number;
  /** Ce qu'un humain doit regarder : cas ambigus, refus, échecs — une phrase par cas. */
  erreurs: string[];
}

export interface Reprise {
  /** Identifiant stable (`lieux-wilaya`, `personnes`…) : clé du journal et de l'action. */
  cle: string;
  titre: string;
  /** Ce que la reprise lit, ce qu'elle écrit, ce qu'elle ne fait jamais. */
  description: string;
  /** À blanc : compte tout l'existant, n'écrit rien. */
  apercu(): Promise<BilanReprise>;
  /** Un lot de `taille` lignes après le curseur `apresId` ; `suite` = curseur du lot suivant, `null` = terminé. */
  executer(opts: { taille: number; apresId?: string | null }): Promise<BilanReprise & { suite: string | null }>;
}
