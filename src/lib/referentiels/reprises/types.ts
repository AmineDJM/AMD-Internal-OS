/**
 * LE CONTRAT COMMUN DES REPRISES (refonte des données, vague 2) — `docs/architecture/refonte-vague-2.md`.
 *
 * Une reprise remplit un référentiel depuis l'existant. Elle ne tourne JAMAIS toute seule au déploiement :
 * le Super Admin la lance depuis `Administration › Refonte des données` — un aperçu à blanc (rien n'est
 * écrit), puis l'exécution par lots, chaque lot reprenant où le précédent s'est arrêté (`suite`). Elle est
 * idempotente : rejouée, elle ne recrée rien.
 *
 * Module PUR (types seulement) : chaque reprise vit dans `reprises/<cle>.ts`, la liste dans `index.ts`.
 */

export interface BilanReprise {
  /** Lignes source lues. */
  lues: number;
  /** Lignes du référentiel créées (ou remplacées). */
  creees: number;
  /** Lignes existantes rattachées à leur fiche. */
  liees: number;
  /** Doublons PROPOSÉS — jamais fusionnés d'office. */
  doublonsProposes: number;
  /** Lignes laissées de côté (vides, mal formées…) : la raison est dans `erreurs` quand elle compte. */
  ignorees: number;
  /** Une ligne par anomalie, sans jamais recopier une valeur sensible. */
  erreurs: string[];
}

export interface Reprise {
  cle: string;
  titre: string;
  description: string;
  /** À blanc : ce que l'exécution ferait, sur toute la source, sans rien écrire. */
  apercu(): Promise<BilanReprise>;
  /** Un lot de `taille` lignes source après `apresId` ; `suite` = où reprendre, `null` quand tout est passé. */
  executer(opts: { taille: number; apresId?: string | null }): Promise<BilanReprise & { suite: string | null }>;
}

export const bilanVide = (): BilanReprise => ({ lues: 0, creees: 0, liees: 0, doublonsProposes: 0, ignorees: 0, erreurs: [] });
