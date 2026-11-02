import { cleBrute } from "./lecture";

/**
 * CE QUI RESTE À TRANCHER DANS UN IMPORT — une décision par valeur BRUTE (« R400 » est ce produit, « CHU ORAN » est
 * cet établissement), appliquée à toutes ses lignes et mémorisée. Règle pure : l'écran de revue la montre, la commande
 * `confirmerCorrespondance` l'applique.
 */
export interface GroupeARevoir {
  nature: "ETABLISSEMENT" | "PRODUIT";
  brut: string;
  lignes: number;
  proposition: { id: string; nom: string; pourquoi: string } | null;
}

export interface LigneARevoir {
  etablissementBrut: string | null;
  produitBrut: string | null;
  molecule: string | null;
  institutionId: string | null;
  productId: string | null;
  anomalies: unknown;
}

/**
 * Regroupe les lignes « à revoir » par valeur brute. Un établissement non rattaché fait un groupe ; un produit non
 * rattaché aussi, sauf une molécule seule SANS proposition (elle compte déjà « hors référentiel » au calcul du marché).
 */
export function groupesARevoir(lignes: readonly LigneARevoir[]): GroupeARevoir[] {
  const groupes = new Map<string, GroupeARevoir>();
  for (const l of lignes) {
    const an = (l.anomalies ?? {}) as { propositionProduit?: { id: string; nom: string; pourquoi: string } | null };
    if (!l.institutionId && l.etablissementBrut) {
      const k = `E|${cleBrute(l.etablissementBrut)}`;
      const g = groupes.get(k) ?? { nature: "ETABLISSEMENT" as const, brut: l.etablissementBrut, lignes: 0, proposition: null };
      g.lignes++; groupes.set(k, g);
    }
    const brutP = l.produitBrut ?? l.molecule;
    if (!l.productId && brutP && (an.propositionProduit || !l.molecule)) {
      const k = `P|${cleBrute(brutP)}`;
      const g = groupes.get(k) ?? { nature: "PRODUIT" as const, brut: brutP, lignes: 0, proposition: an.propositionProduit ?? null };
      g.lignes++; groupes.set(k, g);
    }
  }
  return [...groupes.values()];
}
