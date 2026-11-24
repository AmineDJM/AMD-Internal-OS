import type { Repere, TotauxReperes } from "@/lib/pieces-lues/entetes";
import { CHAMP_TVA_AUTRES, champHt, champTva, estTauxTva, libelleTaux } from "@/modules/finances/partage";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA TVA D'UNE FACTURE LUE — ce que le formulaire Legal peut proposer de ses totaux imprimés (lot « tva »).
 *
 * Les montants viennent du REPÉRAGE déterministe (`entetes.ts`), jamais d'un modèle (P3) : le total HT, la TVA
 * imprimée par taux, le timbre et les taxes additionnelles. Chaque champ proposé porte sa preuve, et sa SOURCE dit la
 * confiance qu'on peut y mettre :
 *
 *   RÈGLES  la valeur est imprimée telle quelle (« Total HT », « TVA 19 % ») ;
 *   CALCUL  elle s'en DÉDUIT — base d'un taux = TVA ÷ taux quand la pièce en porte plusieurs, part à 0 % = HT moins
 *           les bases taxées, taux unique déduit du rapport TVA / HT, 0 % quand TTC = HT — l'opération en preuve.
 *
 * Rien n'est proposé quand les totaux imprimés se contredisent, ou qu'une pièce ne dit rien de sa TVA. La personne
 * VALIDE en enregistrant ; le serveur rejuge la cohérence (HT + TVA + timbre = TTC). Module PUR.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface MarqueTva {
  source: "REGLES" | "CALCUL";
  preuve: string;
  ou: string | null;
}

export interface TvaProposee {
  valeurs: Record<string, string>;
  marques: Record<string, MarqueTva>;
}

const ou = (r: Pick<Repere<unknown>, "ligne">): string => `ligne ${r.ligne}`;
const regles = (r: Repere<unknown>): MarqueTva => ({ source: "REGLES", preuve: r.extrait, ou: ou(r) });
const fr = (n: number): string => n.toLocaleString("fr-FR", { maximumFractionDigits: 2 });
const arrondi = (x: number): number => Math.round(x * 100) / 100;
const pct = (fraction: number): number => Math.round(fraction * 10_000) / 100;

/** Un rapport TVA / HT qui tombe sur un taux en vigueur, à 0,2 point près — `null` sinon. */
function tauxDuRapport(tva: number, ht: number): number | null {
  if (ht <= 0) return null;
  const r = (tva / ht) * 100;
  for (const t of [19, 9]) if (estTauxTva(t) && Math.abs(r - t) <= 0.2) return t;
  return null;
}

export function tvaProposee(t: TotauxReperes | null): TvaProposee {
  const valeurs: Record<string, string> = {};
  const marques: Record<string, MarqueTva> = {};
  if (!t) return { valeurs, marques };
  // DES TOTAUX QUI SE CONTREDISENT ne proposent rien : la personne saisit ce que dit la pièce.
  if (t.conflits.some((c) => c.quoi === "HT" || c.quoi === "TVA" || c.quoi === "TVA_TOTAL")) return { valeurs, marques };
  const poser = (champ: string, v: number, m: MarqueTva) => { valeurs[champ] = String(arrondi(v)); marques[champ] = m; };

  const ht = t.totalHt?.valeur ?? null;
  const parTaux = t.tva
    .filter((x) => x.montant.valeur !== null && estTauxTva(pct(x.taux)))
    .map((x) => ({ taux: pct(x.taux), montant: x.montant.valeur as number, repere: x.montant }));

  if (parTaux.length === 1 && ht !== null) {
    const [x] = parTaux;
    poser(champHt(x!.taux), ht, regles(t.totalHt!));
    if (x!.taux !== 0) poser(champTva(x!.taux), x!.montant, regles(x!.repere));
  } else if (parTaux.length >= 2) {
    let taxees = 0;
    for (const x of parTaux) {
      if (x.taux === 0) continue;
      const base = arrondi(x.montant / (x.taux / 100));
      taxees += base;
      poser(champTva(x.taux), x.montant, regles(x.repere));
      poser(champHt(x.taux), base, { source: "CALCUL", preuve: `${x.repere.extrait} → ${fr(x.montant)} ÷ ${x.taux} % = ${fr(base)} DZD de base.`, ou: ou(x.repere) });
    }
    if (ht !== null && ht - taxees > 1) {
      poser(champHt(0), ht - taxees, { source: "CALCUL", preuve: `Total HT ${fr(ht)} − bases taxées ${fr(taxees)} = ${fr(ht - taxees)} DZD à 0 %.`, ou: ou(t.totalHt!) });
    }
  } else if (ht !== null && t.totalTva?.valeur != null) {
    const taux = tauxDuRapport(t.totalTva.valeur, ht);
    if (taux !== null) {
      poser(champHt(taux), ht, regles(t.totalHt!));
      poser(champTva(taux), t.totalTva.valeur, {
        source: "CALCUL", preuve: `${t.totalTva.extrait} → ${fr(t.totalTva.valeur)} ÷ ${fr(ht)} HT ≈ ${libelleTaux(taux)}.`, ou: ou(t.totalTva),
      });
    }
  } else if (ht !== null && t.totalTtc?.valeur != null && t.tva.length === 0 && Math.abs(t.totalTtc.valeur - ht - autresTaxes(t)) < 0.01) {
    poser(champHt(0), ht, { source: "CALCUL", preuve: `Total TTC = total HT (${fr(ht)} DZD), sans TVA imprimée → 0 %.`, ou: ou(t.totalHt!) });
  }

  const autres = autresTaxes(t);
  if (autres > 0 && Object.keys(valeurs).length > 0) {
    const r = t.timbre ?? t.taxes[0]?.montant;
    poser(CHAMP_TVA_AUTRES, autres, { source: "REGLES", preuve: r ? r.extrait : "Timbre et taxes imprimés.", ou: r ? ou(r) : null });
  }
  return { valeurs, marques };
}

/** Le timbre et les taxes additionnelles imprimés — hors base de TVA. */
function autresTaxes(t: TotauxReperes): number {
  return arrondi((t.timbre?.valeur ?? 0) + t.taxes.reduce((a, x) => a + (x.montant.valeur ?? 0), 0));
}
