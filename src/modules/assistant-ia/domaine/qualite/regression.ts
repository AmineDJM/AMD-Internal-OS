/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA RÉGRESSION D'UN PASSAGE (J5, décision 0022) — règle PURE : qu'est-ce qui a reculé depuis la référence ?
 *
 * La référence est le dernier passage TERMINÉ et complet (non arrêté par le plafond). Régresse :
 *   • la RÉUSSITE — moins de scénarios OK, ou un scénario OK à la référence qui ne l'est plus ;
 *   • la LATENCE — P50 ou P95 (premier mot, ou à défaut le total) de plus de 30 % ;
 *   • le COÛT — le coût moyen d'un scénario de plus de 30 %.
 * Et, sans référence aucune, un passage n'est VERT que s'il ne porte ni écriture sans carte ni scénario en erreur.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const SEUIL_HAUSSE = 0.3;
/** En dessous, un écart de latence est du bruit de mesure (le grain de l'écriture partielle est 350 ms). */
const PLANCHER_LATENCE_MS = 400;
/** En dessous, un écart de coût par scénario est du bruit (un dixième de cent). */
const PLANCHER_COUT_USD = 0.001;

export interface MesuresPassage {
  reussis: number;
  total: number;
  erreurs: number;
  ecrituresSansCarte: number;
  premierMotP50Ms: number | null;
  premierMotP95Ms: number | null;
  latenceP50Ms: number | null;
  latenceP95Ms: number | null;
  coutUsd: number;
  budgetAtteint: boolean;
  /** Les scénarios et leur verdict — pour nommer ceux qui ont basculé. */
  scenarios: { scenario: string; verdict: string }[];
}

export interface Regression {
  mesure: "réussite" | "latence P50" | "latence P95" | "coût" | "écriture sans carte" | "erreur";
  avant: string;
  apres: string;
  detail?: string;
}

const hausse = (avant: number | null, apres: number | null, plancher: number) =>
  avant != null && apres != null && avant > 0 && apres - avant > plancher && apres > avant * (1 + SEUIL_HAUSSE);
const pct = (avant: number, apres: number) => `${apres >= avant ? "+" : ""}${Math.round(((apres - avant) / avant) * 100)} %`;

/** Les régressions de `p` par rapport à `ref` (vide = rien n'a reculé). */
export function regressions(p: MesuresPassage, ref: MesuresPassage | null): Regression[] {
  const out: Regression[] = [];
  if (p.ecrituresSansCarte > 0) out.push({ mesure: "écriture sans carte", avant: "0", apres: String(p.ecrituresSansCarte) });
  if (p.erreurs > 0) out.push({ mesure: "erreur", avant: String(ref?.erreurs ?? 0), apres: String(p.erreurs) });
  if (!ref) return out;

  const okAvant = new Set(ref.scenarios.filter((s) => s.verdict === "OK").map((s) => s.scenario));
  const joues = new Set(p.scenarios.filter((s) => s.verdict !== "NON JOUÉ").map((s) => s.scenario));
  const perdus = p.scenarios.filter((s) => okAvant.has(s.scenario) && s.verdict !== "OK" && s.verdict !== "NON JOUÉ").map((s) => s.scenario);
  // Comparés sur les scénarios JOUÉS des deux côtés : un passage arrêté par son plafond n'est pas une baisse de réussite.
  const okRefJoues = ref.scenarios.filter((s) => s.verdict === "OK" && joues.has(s.scenario)).length;
  const okJoues = p.scenarios.filter((s) => s.verdict === "OK").length;
  if (okJoues < okRefJoues || perdus.length) {
    out.push({ mesure: "réussite", avant: `${okRefJoues}`, apres: `${okJoues}`, ...(perdus.length ? { detail: `n'est plus OK : ${perdus.join(", ")}` } : {}) });
  }

  const p50a = ref.premierMotP50Ms ?? ref.latenceP50Ms;
  const p50 = p.premierMotP50Ms ?? p.latenceP50Ms;
  const p95a = ref.premierMotP95Ms ?? ref.latenceP95Ms;
  const p95 = p.premierMotP95Ms ?? p.latenceP95Ms;
  if (hausse(p50a, p50, PLANCHER_LATENCE_MS)) out.push({ mesure: "latence P50", avant: `${p50a} ms`, apres: `${p50} ms`, detail: pct(p50a!, p50!) });
  if (hausse(p95a, p95, PLANCHER_LATENCE_MS)) out.push({ mesure: "latence P95", avant: `${p95a} ms`, apres: `${p95} ms`, detail: pct(p95a!, p95!) });

  const parScenario = (m: MesuresPassage) => {
    const n = m.scenarios.filter((s) => s.verdict !== "NON JOUÉ").length;
    return n ? m.coutUsd / n : null;
  };
  const ca = parScenario(ref);
  const cp = parScenario(p);
  if (hausse(ca, cp, PLANCHER_COUT_USD)) out.push({ mesure: "coût", avant: `${ca!.toFixed(4)} $/scénario`, apres: `${cp!.toFixed(4)} $/scénario`, detail: pct(ca!, cp!) });
  return out;
}

/** Vert : aucune régression. Un passage arrêté par son plafond n'est jamais vert — il n'a pas tout mesuré. */
export function estVert(p: MesuresPassage, ref: MesuresPassage | null): boolean {
  return !p.budgetAtteint && p.total > 0 && regressions(p, ref).length === 0;
}

/** La phrase de l'avis au Super Admin. */
export function phraseRegression(rs: Regression[]): string {
  return rs.map((r) => `${r.mesure} : ${r.avant} → ${r.apres}${r.detail ? ` (${r.detail})` : ""}`).join(" ; ");
}

/** Le centile `p` (0 à 100) d'une série — la même règle que les bancs (rang arrondi). */
export function centile(xs: readonly number[], p: number): number | null {
  if (!xs.length) return null;
  const t = [...xs].sort((a, b) => a - b);
  return t[Math.min(t.length - 1, Math.round((p / 100) * (t.length - 1)))]!;
}
