/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * DES FICHES AUX PAIRES DE PERSONNES — les doublons PROPOSÉS par la reprise R1 (lot V2-B).
 *
 * Le moteur (`referentiels/doublons.ts`) compare des FICHES (une ligne de chaque table). Une Personne en
 * réunit plusieurs : on ramène chaque proposition à la paire de Personnes qu'elle désigne, on oublie celles
 * qui tombent sur une même Personne (l'ERP les relie déjà), et l'on garde, pour chaque paire, la
 * proposition la plus forte — avec, en réserve, combien d'autres fiches la soutiennent.
 *
 * Module PUR.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import { proposerDoublonsPersonnes, type FichePersonne, type NiveauDoublon } from "@/lib/referentiels/doublons";

export interface FicheDePersonne {
  fiche: FichePersonne;
  personneId: string;
}

export interface PaireProposee {
  /** A < B : une paire ne se lit que dans un sens. */
  a: string;
  b: string;
  niveau: NiveauDoublon;
  score: number;
  raisons: string[];
  reserves: string[];
}

const RANG: Record<NiveauDoublon, number> = { CERTAIN: 3, PROBABLE: 2, POSSIBLE: 1 };

export const clePaire = (p: Pick<PaireProposee, "a" | "b">): string => `${p.a}|${p.b}`;

export function pairesDePersonnes(entrees: readonly FicheDePersonne[]): PaireProposee[] {
  const personneDe = new Map(entrees.map((e) => [e.fiche.ref, e.personneId]));
  const { propositions } = proposerDoublonsPersonnes(entrees.map((e) => e.fiche));
  const meilleures = new Map<string, PaireProposee & { soutiens: number }>();
  for (const p of propositions) {
    const x = personneDe.get(p.a);
    const y = personneDe.get(p.b);
    if (!x || !y || x === y) continue;
    const [a, b] = x < y ? [x, y] : [y, x];
    const k = clePaire({ a, b });
    const avant = meilleures.get(k);
    if (!avant) { meilleures.set(k, { a, b, niveau: p.niveau, score: p.score, raisons: p.raisons, reserves: p.reserves, soutiens: 0 }); continue; }
    avant.soutiens++;
    if (RANG[p.niveau] > RANG[avant.niveau] || (p.niveau === avant.niveau && p.score > avant.score)) {
      Object.assign(avant, { niveau: p.niveau, score: p.score, raisons: p.raisons, reserves: p.reserves });
    }
  }
  return [...meilleures.entries()]
    .sort(([k1], [k2]) => k1.localeCompare(k2))
    .map(([, { soutiens, ...p }]) => (soutiens ? { ...p, raisons: [...p.raisons, `${soutiens} autre(s) rapprochement(s) entre leurs fiches`] } : p));
}
