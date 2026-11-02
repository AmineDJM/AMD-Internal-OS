/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES ÉTATS CHAUDS — le précalcul par écriture qui remplace le recalcul à la question (F5).
 *
 * ── LE COÛT QUE CE MODULE SUPPRIME ──────────────────────────────────────────────────────
 *
 * Les vues qui « reviennent sans cesse » (les signaux exécutifs, l'état consolidé) se
 * recalculaient à CHAQUE appel : une dizaine de requêtes, dont des balayages, pour un
 * résultat qui bouge à l'échelle de la journée. Ici le résultat est PERSISTÉ : la question
 * devient la lecture d'UNE ligne, et le battement garde la ligne tiède.
 *
 * ── LES TROIS PROPRIÉTÉS NON NÉGOCIABLES ────────────────────────────────────────────────
 *
 * 1. `subjectId` est une clé de DROITS, pas un simple cache-key : l'état calculé pour une
 *    personne (son périmètre d'entité, ses engagements) n'est JAMAIS servi à une autre.
 *    L'omniscience ne contourne pas les droits — elle les épouse.
 * 2. La FRAÎCHEUR se dit, elle ne se devine pas : chaque lecture rend l'instant de calcul,
 *    la voie (précalculé ou calculé à l'instant) et le coût MESURÉ du calcul. « Rapide »
 *    n'est pas une affirmation, c'est `costMs` comparé à une lecture de ligne.
 * 3. Un état invalidé par un FAIT MÉTIER (`staleAt`, posé par le registre d'événements)
 *    n'est plus servi : mieux vaut payer un recalcul que servir un état démenti.
 *
 * Le repli est TOUJOURS le calcul en direct (écriture au passage) : ce module accélère,
 * il ne devient jamais un point de défaillance — une table vide donne le comportement
 * d'avant F5, juste plus lent.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { sansBloquer } from "@/lib/journal";

export interface LectureChaude<T> {
  valeur: T;
  /** PRECALCULE = servi depuis la table ; CALCULE = payé à l'instant (et persisté au passage). */
  voie: "PRECALCULE" | "CALCULE";
  calculeLe: Date;
  /** Le coût MESURÉ du calcul qui a produit cette valeur (ms) — jamais estimé. */
  coutMesureMs: number;
}

/**
 * LIT un état chaud, ou le calcule et le PERSISTE au passage (écriture au travers).
 *
 * Servi depuis la table seulement si : la ligne existe, n'a pas dépassé `ttlMs`, et n'a pas
 * été invalidée par un fait métier. Tout le reste recalcule — et l'appelant sait par `voie`
 * laquelle des deux choses s'est produite.
 */
export async function lireEtatChaud<T>(
  kind: string,
  subjectId: string,
  opts: { ttlMs: number; calcul: () => Promise<T> },
): Promise<LectureChaude<T>> {
  const ligne = await prisma.assistantHotState
    .findUnique({ where: { kind_subjectId: { kind, subjectId } } })
    .catch(sansBloquer("hot-state.lireEtatChaud.assistantHotState", null));
  if (ligne && !ligne.staleAt && Date.now() - ligne.computedAt.getTime() < opts.ttlMs) {
    return { valeur: ligne.payload as T, voie: "PRECALCULE", calculeLe: ligne.computedAt, coutMesureMs: ligne.costMs };
  }
  return rechaufferEtatChaud(kind, subjectId, opts.calcul);
}

/**
 * RECALCULE et persiste — le geste du battement (et du repli de lecture).
 *
 * L'échec d'écriture n'avale jamais le résultat : la valeur calculée est rendue quand même,
 * seule la mise en réserve est perdue. Accélérer ne doit pas pouvoir faire échouer.
 */
export async function rechaufferEtatChaud<T>(
  kind: string,
  subjectId: string,
  calcul: () => Promise<T>,
): Promise<LectureChaude<T>> {
  const debut = Date.now();
  const valeur = await calcul();
  const coutMesureMs = Date.now() - debut;
  const calculeLe = new Date();
  await prisma.assistantHotState
    .upsert({
      where: { kind_subjectId: { kind, subjectId } },
      create: { kind, subjectId, payload: valeur as Prisma.InputJsonValue, computedAt: calculeLe, costMs: coutMesureMs },
      update: { payload: valeur as Prisma.InputJsonValue, computedAt: calculeLe, costMs: coutMesureMs, staleAt: null },
    })
    .catch(sansBloquer("hot-state.rechaufferEtatChaud.assistantHotState"));
  return { valeur, voie: "CALCULE", calculeLe, coutMesureMs };
}

/**
 * INVALIDE tous les états d'une nature — appelé par le registre d'événements quand un fait
 * métier s'inscrit. Marque, ne supprime pas : la ligne garde son instant de calcul, et le
 * prochain lecteur (ou le battement) paie le recalcul. Ne touche que les lignes pas encore
 * marquées — l'invalidation est idempotente et bon marché.
 */
export async function invaliderEtatsChauds(kind: string): Promise<number> {
  const r = await prisma.assistantHotState
    .updateMany({ where: { kind, staleAt: null }, data: { staleAt: new Date() } })
    .catch(sansBloquer("hot-state.invaliderEtatsChauds.assistantHotState", { count: 0 }));
  return r.count;
}
