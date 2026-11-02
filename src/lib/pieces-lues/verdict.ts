import type { Reconciliation } from "@/lib/pieces-lues/tableau";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE VERDICT D'UNE LECTURE DE PIÈCE COMMERCIALE (lot B1, décision 0049) — par INVARIANTS, jamais par un modèle. Pur.
 *
 *   I1  chaque ligne se recoupe : quantité × prix unitaire = montant imprimé ;
 *   I2  la numérotation se suit : aucun numéro absent entre le premier et le dernier ;
 *   I3  Σ montants des lignes = total HT imprimé (au dinar) ;
 *   I4  l'émetteur est nommé, et ce n'est PAS une société du groupe (le groupe est le client).
 *
 * FIABLE : I1 à I4 tiennent. À VÉRIFIER : des lignes existent mais un invariant tombe — les lignes douteuses sont
 * NOMMÉES dans le détail. ILLISIBLE : aucune ligne chiffrée. Le verdict est gardé avec la lecture
 * (`LecturePiece.verdict`) : ce qui a été établi ne se redemande pas.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type StatutLecture = "FIABLE" | "A_VERIFIER" | "ILLISIBLE";

export interface VerdictLecture {
  statut: StatutLecture;
  /** Les invariants tombés, dits en clair (vide si FIABLE). */
  raisons: string[];
  methode: string | null;
  sommeLignes: number | null;
  htImprime: number | null;
  ecart: number | null;
  manquantes: number[];
  douteuses: { numero: number; designation: string; raison: string }[];
}

export function verdictDeLecture(a: {
  methode: string | null;
  nbLignes: number;
  reconciliation: Reconciliation | null;
  emetteurNom: string | null;
  emetteurDuGroupe: boolean;
}): VerdictLecture {
  const r = a.reconciliation;
  const base = {
    methode: a.methode, sommeLignes: r?.sommeLignes ?? null, htImprime: r?.htImprime ?? null, ecart: r?.ecart ?? null,
    manquantes: r?.manquantes ?? [], douteuses: r?.douteuses ?? [],
  };
  if (a.nbLignes === 0 || !r) return { statut: "ILLISIBLE", raisons: ["aucune ligne chiffrée n'a pu être lue"], ...base };
  const raisons: string[] = [];
  if (r.douteuses.some((d) => /quantité × prix/.test(d.raison))) raisons.push("I1 : une ligne ne se recoupe pas (quantité × prix ≠ montant)");
  if (r.manquantes.length) raisons.push(`I2 : numéros absents (${r.manquantes.join(", ")})`);
  if (r.htImprime === null) raisons.push("I3 : total HT imprimé non lu");
  else if (r.ecart !== null && Math.abs(r.ecart) >= 0.5) raisons.push(`I3 : Σ lignes (${r.sommeLignes}) ≠ HT imprimé (${r.htImprime})`);
  if (!a.emetteurNom) raisons.push("I4 : émetteur non nommé");
  else if (a.emetteurDuGroupe) raisons.push("I4 : l'émetteur lu est une société du groupe (le client) — fournisseur à confirmer");
  if (!raisons.length && r.douteuses.length) raisons.push("une ligne porte un doute de lecture");
  return { statut: raisons.length ? "A_VERIFIER" : "FIABLE", raisons, ...base };
}
