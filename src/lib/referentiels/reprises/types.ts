/**
 * LE CONTRAT COMMUN DES REPRISES (refonte des données, vague 2 — `docs/architecture/refonte-vague-2.md`).
 *
 * Une reprise remplit un référentiel depuis l'existant, DANS l'application (jamais depuis un poste de
 * développement), lancée par le Super Admin depuis Administration › Refonte des données : un aperçu
 * chiffré à blanc, puis des lots. Elle est rejouable sans effet de bord (identifiants déterministes ou
 * clés uniques) et ne fusionne jamais : un doublon est PROPOSÉ.
 *
 * Module PUR (types seuls) : l'écran l'importe.
 */

export interface BilanReprise {
  /** Lignes source lues. */
  lues: number;
  /** Lignes créées dans le référentiel (ou en file). */
  creees: number;
  /** Lignes source rattachées à une ligne existante. */
  liees: number;
  /** Doublons proposés (jamais fusionnés). */
  doublonsProposes: number;
  /** Lignes source écartées, raison dans `erreurs` quand elle n'est pas évidente. */
  ignorees: number;
  erreurs: string[];
}

export interface Reprise {
  cle: string;
  titre: string;
  description: string;
  /** Ce que l'exécution ferait, sans rien écrire. */
  apercu(): Promise<BilanReprise>;
  /** Un lot de `taille` lignes après `apresId` ; `suite` : le curseur du lot suivant, `null` : terminé. */
  executer(opts: { taille: number; apresId?: string | null }): Promise<BilanReprise & { suite: string | null }>;
}

export const bilanVide = (): BilanReprise => ({ lues: 0, creees: 0, liees: 0, doublonsProposes: 0, ignorees: 0, erreurs: [] });
