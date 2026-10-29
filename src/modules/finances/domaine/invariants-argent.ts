/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES INVARIANTS DE L'ARGENT SORTI — un ordre réglé, une écriture, la même somme (audit argent 2026-10-27).
 *
 * Le règlement (`settleExpenseOrder`) est le seul écrivain de `PAID` et pose, dans la même transaction,
 * UNE écriture de trésorerie sortante que l'ordre pointe (`transactionId`). De là découlent des égalités
 * que toute la chaîne doit tenir, quels que soient les circuits d'origine :
 *
 *   1. un ordre PAYÉ pointe une écriture ;                       (`ORDRE_PAYE_SANS_ECRITURE`)
 *   2. cette écriture existe ;                                     (`ECRITURE_INTROUVABLE`)
 *   3. elle porte le montant de l'ordre, au centime ;              (`MONTANT_DIVERGENT`)
 *   4. c'est une SORTIE réglée ;                                   (`SENS_OU_STATUT`)
 *   5. elle ne règle qu'un seul ordre ;                            (`ECRITURE_PARTAGEE`)
 *   6. un ordre non payé ne pointe aucune écriture.                (`ORDRE_NON_PAYE_AVEC_ECRITURE`)
 *
 * Conséquence lue par la trésorerie et le budget : Σ des ordres réglés = Σ de leurs écritures.
 *
 * Module PUR (aucune base) : les bancs le nourrissent de lignes lues, et une vérification de production
 * peut le nourrir des siennes sans rien écrire.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface OrdreInvariant {
  id: string;
  reference: string;
  status: string;
  amount: number;
  transactionId: string | null;
}

export interface EcritureInvariant {
  id: string;
  amount: number;
  direction: string;
  status: string;
}

export type RegleArgent =
  | "ORDRE_PAYE_SANS_ECRITURE"
  | "ECRITURE_INTROUVABLE"
  | "MONTANT_DIVERGENT"
  | "SENS_OU_STATUT"
  | "ECRITURE_PARTAGEE"
  | "ORDRE_NON_PAYE_AVEC_ECRITURE";

export interface ViolationArgent {
  regle: RegleArgent;
  ordreId: string;
  detail: string;
}

/** Deux montants égaux au centime — les colonnes sont en Decimal(14,2), la logique en `number`. */
export const memeMontant = (a: number, b: number): boolean => Math.round(a * 100) === Math.round(b * 100);

export function violationsArgent(ordres: readonly OrdreInvariant[], ecritures: readonly EcritureInvariant[]): ViolationArgent[] {
  const out: ViolationArgent[] = [];
  const ecriture = new Map(ecritures.map((e) => [e.id, e]));
  const reglesPar = new Map<string, string[]>();

  for (const o of ordres) {
    if (o.status !== "PAID") {
      if (o.transactionId) out.push({ regle: "ORDRE_NON_PAYE_AVEC_ECRITURE", ordreId: o.id, detail: `${o.reference} (${o.status}) pointe l'écriture ${o.transactionId}` });
      continue;
    }
    if (!o.transactionId) {
      out.push({ regle: "ORDRE_PAYE_SANS_ECRITURE", ordreId: o.id, detail: `${o.reference} payé sans écriture de règlement` });
      continue;
    }
    reglesPar.set(o.transactionId, [...(reglesPar.get(o.transactionId) ?? []), o.reference]);
    const e = ecriture.get(o.transactionId);
    if (!e) {
      out.push({ regle: "ECRITURE_INTROUVABLE", ordreId: o.id, detail: `${o.reference} pointe ${o.transactionId}, absente du livre` });
      continue;
    }
    if (!memeMontant(e.amount, o.amount)) {
      out.push({ regle: "MONTANT_DIVERGENT", ordreId: o.id, detail: `${o.reference} : ordre ${o.amount}, écriture ${e.amount}` });
    }
    if (e.direction !== "OUT" || e.status !== "SETTLED") {
      out.push({ regle: "SENS_OU_STATUT", ordreId: o.id, detail: `${o.reference} : écriture ${e.direction} / ${e.status}` });
    }
  }
  for (const [tx, refs] of reglesPar) {
    if (refs.length < 2) continue;
    for (const o of ordres.filter((x) => x.transactionId === tx && x.status === "PAID")) {
      out.push({ regle: "ECRITURE_PARTAGEE", ordreId: o.id, detail: `l'écriture ${tx} règle ${refs.join(", ")}` });
    }
  }
  return out;
}

/** Σ des ordres réglés et Σ de leurs écritures — égales quand `violationsArgent` est vide. */
export function totauxReglements(ordres: readonly OrdreInvariant[], ecritures: readonly EcritureInvariant[]): { ordres: number; ecritures: number } {
  const ecriture = new Map(ecritures.map((e) => [e.id, e]));
  const payes = ordres.filter((o) => o.status === "PAID");
  const centimes = (n: number) => Math.round(n * 100);
  return {
    ordres: payes.reduce((a, o) => a + centimes(o.amount), 0) / 100,
    ecritures: [...new Set(payes.map((o) => o.transactionId).filter((x): x is string => Boolean(x)))]
      .reduce((a, id) => a + centimes(ecriture.get(id)?.amount ?? 0), 0) / 100,
  };
}
