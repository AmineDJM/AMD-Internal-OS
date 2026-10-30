/**
 * LE RÉSULTAT D'UN PASSAGE DU BANC (J5, décision 0022) — le format que le processus de banc écrit (`BANC_SORTIE`) et que
 * le worker relit, et les agrégats qu'il en tire (réussite, latence P50 / P95, jetons, coût). Pur.
 */
import { centile, type MesuresPassage } from "./regression";

export const VERDICTS = ["OK", "ÉCHEC", "SANS OUTIL", "ERREUR", "NON JOUÉ"] as const;
export type Verdict = (typeof VERDICTS)[number];

export interface ScenarioBanc {
  scenario: string;
  famille: string;
  verdict: Verdict;
  motifs: string[];
  ms: number | null;
  premierMotMs: number | null;
  appels: number;
  entree: number;
  cache: number;
  sortie: number;
  coutUsd: number;
}

export interface ResultatBanc {
  scenarios: ScenarioBanc[];
  depenseUsd: number;
  budgetAtteint: boolean;
  erreur?: string | null;
}

const ent = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? Math.round(x) : 0);
const entOuNul = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? Math.round(x) : null);

/** Relit ce qu'un processus a écrit — sans lui faire confiance (un champ illisible devient neutre). */
export function lireResultatBanc(x: unknown): ResultatBanc {
  const o = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
  const scenarios = (Array.isArray(o.scenarios) ? o.scenarios : []).flatMap((s): ScenarioBanc[] => {
    if (!s || typeof s !== "object") return [];
    const r = s as Record<string, unknown>;
    if (typeof r.scenario !== "string" || !r.scenario) return [];
    const verdict = (VERDICTS as readonly string[]).includes(String(r.verdict)) ? (r.verdict as Verdict) : "ERREUR";
    return [{
      scenario: r.scenario.slice(0, 80), famille: String(r.famille ?? "jarvis").slice(0, 40), verdict,
      motifs: (Array.isArray(r.motifs) ? r.motifs : []).map((m) => String(m).slice(0, 300)).slice(0, 12),
      ms: entOuNul(r.ms), premierMotMs: entOuNul(r.premierMotMs), appels: ent(r.appels), entree: ent(r.entree), cache: ent(r.cache), sortie: ent(r.sortie),
      coutUsd: typeof r.coutUsd === "number" && Number.isFinite(r.coutUsd) ? r.coutUsd : 0,
    }];
  });
  const depense = Number(o.depenseUsd);
  return {
    scenarios,
    depenseUsd: Number.isFinite(depense) ? depense : scenarios.reduce((t, s) => t + s.coutUsd, 0),
    budgetAtteint: o.budgetAtteint === true,
    erreur: typeof o.erreur === "string" ? o.erreur.slice(0, 500) : null,
  };
}

/** Les agrégats d'un passage — ce que le tableau de bord affiche et ce que la régression compare. */
export function agreger(r: ResultatBanc): MesuresPassage & { jetonsEntree: number; jetonsCache: number; jetonsSortie: number } {
  const joues = r.scenarios.filter((s) => s.verdict !== "NON JOUÉ");
  // Les latences : celles des tours de conversation (les familles longues — travaux, atelier — à part).
  const conversation = joues.filter((s) => s.famille !== "travaux" && s.famille !== "atelier" && s.famille !== "bibliotheque" && s.scenario.indexOf("longue") < 0);
  const ms = conversation.map((s) => s.ms).filter((x): x is number => x != null);
  const mots = conversation.map((s) => s.premierMotMs).filter((x): x is number => x != null);
  return {
    reussis: joues.filter((s) => s.verdict === "OK").length,
    total: r.scenarios.length,
    erreurs: joues.filter((s) => s.verdict === "ERREUR").length,
    ecrituresSansCarte: joues.filter((s) => s.motifs.some((m) => /ÉCRITURE SANS CONFIRMATION/.test(m))).length,
    latenceP50Ms: centile(ms, 50), latenceP95Ms: centile(ms, 95),
    premierMotP50Ms: centile(mots, 50), premierMotP95Ms: centile(mots, 95),
    coutUsd: Math.round(r.depenseUsd * 1e6) / 1e6,
    budgetAtteint: r.budgetAtteint,
    jetonsEntree: joues.reduce((t, s) => t + s.entree, 0),
    jetonsCache: joues.reduce((t, s) => t + s.cache, 0),
    jetonsSortie: joues.reduce((t, s) => t + s.sortie, 0),
    scenarios: r.scenarios.map((s) => ({ scenario: s.scenario, verdict: s.verdict })),
  };
}
