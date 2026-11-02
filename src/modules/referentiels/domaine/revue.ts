import type { NiveauDoublon } from "./doublons";

/**
 * L'ORDRE DE REVUE DES DOUBLONS — une règle, écrite une fois.
 *
 * Les deux écrans où une personne tranche (doublons de personnes, doublons d'organisations)
 * montrent d'abord les paires les plus sûres : niveau CERTAIN, puis PROBABLE, puis POSSIBLE ; à
 * niveau égal, le score le plus haut. La règle vivait copiée dans les deux pages ; elle vit ici,
 * pure et testée (`revue.test.ts`).
 */
export const RANG_NIVEAU: Readonly<Record<NiveauDoublon, number>> = { CERTAIN: 3, PROBABLE: 2, POSSIBLE: 1 };

/** Les propositions dans l'ordre de revue — une COPIE triée, l'entrée n'est pas modifiée. Un niveau inconnu passe en dernier. */
export function ordreDeRevue<T extends { niveau: string; score: number }>(propositions: readonly T[]): T[] {
  const rang = (n: string) => RANG_NIVEAU[n as NiveauDoublon] ?? 0;
  return [...propositions].sort((a, b) => rang(b.niveau) - rang(a.niveau) || b.score - a.score);
}
