/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA MASSE SALARIALE DE LA CAMPAGNE, SANS DOUBLE COMPTE (Super Admin, 24/11/2026 — décisions de l'audit des dépenses).
 *
 * La masse salariale INCLUT l'IRG et la CNAS, affichés SÉPARÉMENT à l'intérieur : trois lignes du pôle —
 *   • « net + primes » (ce que paie le virement) : 12 × le net courant des fiches, plus les primes réellement versées
 *     l'année précédente, CHACUNE AU MOIS DE SON VERSEMENT (un 13e mois de décembre reste en décembre — jamais
 *     « dernière paie × 12 ») ;
 *   • l'IRG (`MS_IRG`) et la CNAS (`MS_CNAS`), depuis les RETENUES INSCRITES sur les fiches salariés (`retIrg`, `retSS9`,
 *     `retSS35`) — jamais un pourcentage ajouté par-dessus le coût employeur ;
 *   • contrôle affiché : net + primes + IRG + CNAS = coût employeur des fiches.
 *
 * Module PUR : il n'importe que les clés des lignes, depuis la porte pure du module Finances.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import { LIGNES_MASSE_SALARIALE } from "@/modules/finances/partage";

const r2 = (n: number) => Math.round(n * 100) / 100;
const positif = (n: number | null | undefined) => (n !== null && n !== undefined && Number.isFinite(n) && n > 0 ? n : 0);

export interface PaieDuMois { mois: number; net: number; primes: number }

export interface PrevisionMasseNette {
  /** Le net mensuel courant, hors primes. */
  netMensuel: number;
  /** D'où vient ce net : les fiches salariés, ou la dernière paie connue (primes retirées). */
  base: "FICHES" | "PAIE" | "AUCUNE";
  /** Les primes de l'année précédente, au mois de leur versement. */
  primesParMois: number[];
  /** Le profil de l'année : net + primes du mois (sert de poids pour répartir le montant de la ligne). */
  parMois: number[];
  total: number;
}

/**
 * LA MASSE SALARIALE NETTE D'UN PÔLE pour l'année budgétée. `netsFiches` : le net à payer de chaque fiche active ;
 * `paies` : les paies de l'année précédente (net versé et primes, par mois, tous salariés confondus).
 */
export function prevoirMasseNette(netsFiches: readonly (number | null)[], paies: readonly PaieDuMois[]): PrevisionMasseNette {
  const primesParMois = Array.from({ length: 12 }, () => 0);
  const netsParMois = new Map<number, number>();
  for (const p of paies) {
    if (!(p.mois >= 1 && p.mois <= 12)) continue;
    primesParMois[p.mois - 1] = r2(primesParMois[p.mois - 1]! + positif(p.primes));
    netsParMois.set(p.mois, r2((netsParMois.get(p.mois) ?? 0) + positif(p.net) - positif(p.primes)));
  }
  const fiches = netsFiches.reduce<number>((a, n) => a + positif(n), 0);
  const dernier = [...netsParMois.keys()].sort((a, b) => b - a)[0];
  const netMensuel = fiches > 0 ? r2(fiches) : dernier ? Math.max(0, netsParMois.get(dernier) ?? 0) : 0;
  const base = fiches > 0 ? "FICHES" : dernier ? "PAIE" : "AUCUNE";
  const parMois = primesParMois.map((p) => r2(netMensuel + p));
  return { netMensuel, base, primesParMois, parMois, total: r2(parMois.reduce((a, x) => a + x, 0)) };
}

/**
 * RÉPARTIR UN MONTANT ANNUEL SELON UN PROFIL (les poids de douze mois) — au centime, le reste sur le dernier mois non nul.
 * Sans profil (ou un profil nul), en douzièmes. Le pôle qui change le montant garde ainsi la saisonnalité des primes.
 */
export function repartirSelonProfil(montant: number, poids?: readonly number[] | null): number[] {
  const p = poids && poids.length === 12 && poids.every((x) => Number.isFinite(x) && x >= 0) ? poids : null;
  const somme = p ? p.reduce((a, x) => a + x, 0) : 0;
  const centimes = Math.round(montant * 100);
  if (!p || somme <= 0) {
    const part = Math.trunc(centimes / 12);
    const mois = Array.from({ length: 12 }, () => part / 100);
    mois[11] = (centimes - part * 11) / 100;
    return mois;
  }
  const parts = p.map((x) => Math.round((centimes * x) / somme));
  const dernier = p.map((x, i) => (x > 0 ? i : -1)).filter((i) => i >= 0).pop()!;
  parts[dernier] = parts[dernier]! + (centimes - parts.reduce((a, x) => a + x, 0));
  return parts.map((c) => c / 100);
}

/** Les clés stables des sous-lignes de la masse salariale — celles du module Finances (Impôts & cotisations y impute). */
export const CLE_MS_IRG = LIGNES_MASSE_SALARIALE.MS_IRG;
export const CLE_MS_CNAS = LIGNES_MASSE_SALARIALE.MS_CNAS;

/** Les éléments d'une fiche salarié utiles à la prévision (mensuels). */
export interface FicheRetenues {
  net: number | null; retIrg: number | null; retSS9: number | null; retSS35: number | null; coutEmployeur: number | null;
}

/**
 * LA CNAS D'UNE FICHE. `retSS35` est-elle le TOTAL des cotisations (35 % = 26 % patronal + 9 % salarial) ou la seule
 * part patronale ? La fiche le dit quand le coût employeur est connu : celle des deux lectures qui boucle
 * net + IRG + CNAS = coût employeur l'emporte. Sinon, le rapport à `retSS9` tranche (35/9 ≈ 3,9 ; 26/9 ≈ 2,9).
 */
export function cnasDeLaFiche(f: FicheRetenues): number {
  const s9 = positif(f.retSS9), s35 = positif(f.retSS35);
  if (s35 === 0) return s9;
  if (s9 === 0) return s35;
  const total = s35, separees = r2(s9 + s35);
  const cout = positif(f.coutEmployeur);
  if (cout > 0) {
    const base = positif(f.net) + positif(f.retIrg);
    return Math.abs(base + total - cout) <= Math.abs(base + separees - cout) ? total : separees;
  }
  return s35 / s9 >= 3.4 ? total : separees;
}

export interface RetenuesMensuelles { net: number; irg: number; cnas: number; coutEmployeur: number; salaries: number }

/** Les retenues mensuelles d'une société : la somme de ses fiches actives. */
export function retenuesDesFiches(fiches: readonly FicheRetenues[]): RetenuesMensuelles {
  return fiches.reduce<RetenuesMensuelles>((a, f) => ({
    net: r2(a.net + positif(f.net)), irg: r2(a.irg + positif(f.retIrg)), cnas: r2(a.cnas + cnasDeLaFiche(f)),
    coutEmployeur: r2(a.coutEmployeur + positif(f.coutEmployeur)), salaries: a.salaries + 1,
  }), { net: 0, irg: 0, cnas: 0, coutEmployeur: 0, salaries: 0 });
}

export interface ControleCoutEmployeur {
  masseNette: number; irg: number; cnas: number;
  /** net + primes + IRG + CNAS, sur l'année. */
  reconstitue: number;
  /** Le coût employeur des fiches sur l'année, plus les primes prévues (une prime coûte au moins son montant). */
  coutEmployeur: number;
  ecart: number;
  /** L'écart reste sous 1 % (ou rien à comparer). */
  boucle: boolean;
}

/**
 * LE CONTRÔLE AFFICHÉ : net + primes, IRG et CNAS prévus reconstituent-ils le coût employeur des fiches (plus les
 * primes) ? `masseNette` = la ligne « net + primes ».
 */
export function controleCoutEmployeur(e: { masseNette: number; primes: number; irg: number; cnas: number; coutEmployeurFiches: number }): ControleCoutEmployeur {
  const reconstitue = r2(e.masseNette + e.irg + e.cnas);
  const coutEmployeur = r2(e.coutEmployeurFiches + e.primes);
  const ecart = r2(reconstitue - coutEmployeur);
  return { masseNette: e.masseNette, irg: e.irg, cnas: e.cnas, reconstitue, coutEmployeur, ecart, boucle: coutEmployeur <= 0 || Math.abs(ecart) <= coutEmployeur / 100 };
}
