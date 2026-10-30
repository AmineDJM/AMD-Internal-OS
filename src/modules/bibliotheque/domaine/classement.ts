/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA FUSION DES CLASSEMENTS — Reciprocal Rank Fusion (J1). Pur.
 *
 * Trois classements indépendants rendent des PASSAGES : le plein texte (les mots), les trigrammes du
 * titre (un nom approximatif), le vecteur (le sens). Leurs scores ne se comparent pas (un ts_rank n'est
 * pas une similarité cosinus) ; leurs RANGS, si. RRF : chaque liste donne à une pièce 1 / (k + rang) de
 * son meilleur passage, et la pièce additionne. Une pièce trouvée par deux voies passe devant une pièce
 * trouvée par une seule, même mieux placée — c'est exactement ce qu'on veut d'une recherche hybride.
 *
 * k = 60 : la constante de l'article d'origine (Cormack et al., 2009), qui amortit l'écart entre le
 * premier et le dixième rang sans l'écraser.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const K_RRF = 60;
export const VOIES = ["plein-texte", "titre", "vecteur"] as const;
export type Voie = (typeof VOIES)[number];

export interface Touche {
  pieceId: string;
  /** Le passage touché ; `null` pour une voie qui classe la pièce entière (le titre). */
  passageId: string | null;
}

export interface PieceClassee {
  pieceId: string;
  score: number;
  /** Le passage le mieux placé, toutes voies confondues (celui qu'on cite). */
  passageId: string | null;
  /** Le rang (1 = premier) de la pièce dans chaque voie qui l'a trouvée. */
  rangs: Partial<Record<Voie, number>>;
}

export function fusionner(listes: Partial<Record<Voie, readonly Touche[]>>, k: number = K_RRF): PieceClassee[] {
  const parPiece = new Map<string, PieceClassee & { meilleurPassage: number }>();
  for (const voie of VOIES) {
    const liste = listes[voie] ?? [];
    const vues = new Set<string>();
    liste.forEach((t, i) => {
      const rang = i + 1;
      const contribution = 1 / (k + rang);
      let p = parPiece.get(t.pieceId);
      if (!p) {
        p = { pieceId: t.pieceId, score: 0, passageId: null, rangs: {}, meilleurPassage: 0 };
        parPiece.set(t.pieceId, p);
      }
      // Une pièce ne compte qu'une fois par voie : par son meilleur passage.
      if (!vues.has(t.pieceId)) {
        vues.add(t.pieceId);
        p.score += contribution;
        p.rangs[voie] = rang;
      }
      if (t.passageId && contribution > p.meilleurPassage) {
        p.meilleurPassage = contribution;
        p.passageId = t.passageId;
      }
    });
  }
  return [...parPiece.values()]
    .map(({ meilleurPassage: _m, ...p }) => p)
    .sort((a, b) => b.score - a.score || a.pieceId.localeCompare(b.pieceId));
}
