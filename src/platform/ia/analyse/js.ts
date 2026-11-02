/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE BAC À SABLE JAVASCRIPT — du code écrit par un modèle, exécuté sans lui donner la machine.
 *
 * ── CE QUI EST ISOLÉ, ET PAR QUOI ────────────────────────────────────────────────────────
 *
 *   1. UN FIL À PART (`worker_threads`) avec `env: {}` — le code ne lit pas les variables de la
 *      production (clés, mots de passe de base) parce qu'elles n'existent pas dans son monde.
 *   2. DES LIMITES DE MÉMOIRE (`resourceLimits`) posées sur le fil — un `while(true){a.push(1)}`
 *      tue le fil, pas le serveur.
 *   3. UN CONTEXTE VIDE (`vm.runInNewContext`) : le code voit `data`, `lib`, `console.log` borné,
 *      et RIEN d'autre — ni `require`, ni `process`, ni `fetch`, ni `globalThis` du fil.
 *   4. UN DÉLAI dur : `vm` coupe le code synchrone, et le fil est TERMINÉ si l'ensemble déborde.
 *   5. UN RÉSULTAT BORNÉ : JSON sérialisable, 1 Mo au plus. Ce que le code ne rend pas n'existe pas.
 *
 * Le bac n'est PAS une machine virtuelle de sécurité au sens fort — un `vm` de Node se contourne
 * si l'on peut atteindre un objet du contexte hôte. C'est pourquoi le contexte est VIDE (aucun
 * objet hôte n'y entre : `data` est recopié par JSON, `lib` est défini DANS le fil) et pourquoi
 * le fil est lui-même une frontière (`env: {}`, limites). Deux couches, pas une promesse.
 *
 * PUR côté serveur : ni base, ni droits, ni réseau. Les droits sont portés par ce qui fournit
 * `data` (un outil de lecture, un fichier du Drive vérifié) — jamais par ce module.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import { Worker } from "node:worker_threads";
import { attendu } from "@/lib/journal";

export const JS_DELAI_MS = 5_000;
export const JS_MEMOIRE_MO = 128;
export const JS_RESULTAT_MAX = 1_048_576;
export const JS_CODE_MAX = 40_000;
export const JS_JOURNAL_MAX = 60;

export interface ResultatJs {
  ok: boolean;
  /** La valeur rendue par le code (dernière expression ou `return`), sérialisée par JSON. */
  resultat: unknown;
  /** Les `console.log` du code, bornés. */
  journal: string[];
  ms: number;
  erreur?: string;
  /** Ce qui a été TRONQUÉ ou refusé, dit à la personne. */
  notes: string[];
}

/**
 * LES AIDES DISPONIBLES DANS LE BAC — définies DANS le fil, en source, pour qu'aucune fonction
 * de l'hôte n'entre dans le contexte. Volontairement petites : le gros du calcul se fait par
 * `run_analysis` (opérations vérifiées) ; le code libre sert à ce que ces opérations ne couvrent pas.
 */
const LIB_SOURCE = `
const lib = Object.freeze({
  sum: (a) => a.reduce((s, v) => s + (Number(v) || 0), 0),
  mean: (a) => a.length ? a.reduce((s, v) => s + (Number(v) || 0), 0) / a.length : null,
  median: (a) => { const v = a.map(Number).filter((n) => Number.isFinite(n)).sort((x, y) => x - y); if (!v.length) return null; const m = Math.floor(v.length / 2); return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; },
  min: (a) => a.length ? Math.min(...a.map(Number)) : null,
  max: (a) => a.length ? Math.max(...a.map(Number)) : null,
  round: (n, d = 2) => Math.round(Number(n) * 10 ** d) / 10 ** d,
  groupBy: (rows, key) => { const m = {}; for (const r of rows) { const k = typeof key === "function" ? key(r) : r[key]; (m[k] ??= []).push(r); } return m; },
  sortBy: (rows, key, desc = false) => [...rows].sort((a, b) => { const x = typeof key === "function" ? key(a) : a[key]; const y = typeof key === "function" ? key(b) : b[key]; return (x > y ? 1 : x < y ? -1 : 0) * (desc ? -1 : 1); }),
  uniq: (a) => [...new Set(a)],
  countBy: (rows, key) => { const m = {}; for (const r of rows) { const k = typeof key === "function" ? key(r) : r[key]; m[k] = (m[k] ?? 0) + 1; } return m; },
  pick: (o, keys) => Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, o[k]])),
  toNumber: (v) => { if (typeof v === "number") return v; if (typeof v !== "string") return NaN; return Number(v.replace(/[\\s\\u00a0\\u202f]/g, "").replace(/,/g, ".").replace(/[^0-9.+-eE]/g, "")); },
  month: (v) => { const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 7); },
  daysBetween: (a, b) => { const x = new Date(a), y = new Date(b); if (Number.isNaN(x.getTime()) || Number.isNaN(y.getTime())) return null; return Math.round((y - x) / 86400000); },
});
`;

/** Le programme du fil : il reçoit { code, data, delai }, exécute dans un contexte vide, renvoie un JSON. */
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const vm = require("node:vm");
const journal = [];
const MAX_JOURNAL = ${JS_JOURNAL_MAX};
const ctx = {
  data: JSON.parse(workerData.data),
  console: { log: (...a) => { if (journal.length < MAX_JOURNAL) journal.push(a.map((x) => typeof x === "string" ? x : JSON.stringify(x)).join(" ").slice(0, 500)); } },
  JSON, Math, Number, String, Boolean, Array, Object, Date, Map, Set, RegExp, parseInt, parseFloat, isNaN, isFinite, Intl,
};
let ok = true, resultat, erreur;
try {
  vm.createContext(ctx, { codeGeneration: { strings: false, wasm: false } });
  vm.runInContext(${JSON.stringify(LIB_SOURCE)}, ctx, { timeout: 1000 });
  const wrapped = "(function(){\\n" + workerData.code + "\\n})()";
  resultat = vm.runInContext(wrapped, ctx, { timeout: workerData.delai, filename: "sandbox.js" });
} catch (e) {
  ok = false;
  erreur = e && e.message ? String(e.message).slice(0, 400) : String(e);
}
let serial;
try { serial = JSON.stringify(resultat === undefined ? null : resultat); }
catch (e) { ok = false; erreur = "résultat non sérialisable en JSON : " + (e && e.message ? e.message : e); serial = "null"; }
parentPort.postMessage({ ok, resultat: serial, journal, erreur });
`;

const INTERDIT_JS = /\b(require|process|globalThis|__proto__|WebAssembly|Atomics|SharedArrayBuffer)\b|\bimport\s*\(|\bFunction\s*\(|\beval\s*\(|constructor\s*\[/;

/** LA FORME : ce qu'on refuse avant d'ouvrir un fil — dit clairement, pour que le modèle corrige. */
export function verifierCodeJs(code: string): { ok: true } | { ok: false; motif: string } {
  const c = (code ?? "").trim();
  if (!c) return { ok: false, motif: "code vide" };
  if (c.length > JS_CODE_MAX) return { ok: false, motif: `code trop long (${JS_CODE_MAX} caractères au plus)` };
  const m = INTERDIT_JS.exec(c);
  if (m) return { ok: false, motif: `« ${m[0].trim()} » n'existe pas dans le bac à sable : le code ne voit que data, lib et console.log` };
  return { ok: true };
}

/**
 * EXÉCUTER du JavaScript sur des données, isolé. Le code doit `return` ce qu'il veut rendre.
 * `data` est recopié par JSON : le bac reçoit une COPIE, jamais une référence de l'hôte.
 */
export async function executerJs(code: string, data: unknown, opts: { delaiMs?: number } = {}): Promise<ResultatJs> {
  const t0 = Date.now();
  const notes: string[] = [];
  const forme = verifierCodeJs(code);
  if (!forme.ok) return { ok: false, resultat: null, journal: [], ms: 0, erreur: `Code refusé — ${forme.motif}.`, notes };
  const delai = Math.min(Math.max(opts.delaiMs ?? JS_DELAI_MS, 200), JS_DELAI_MS);
  let dataJson: string;
  try { dataJson = JSON.stringify(data ?? null) ?? "null"; }
  catch { return { ok: false, resultat: null, journal: [], ms: 0, erreur: "les données ne sont pas sérialisables en JSON", notes }; }

  return new Promise<ResultatJs>((resolve) => {
    let fini = false;
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      env: {},
      workerData: { code, data: dataJson, delai },
      resourceLimits: { maxOldGenerationSizeMb: JS_MEMOIRE_MO, maxYoungGenerationSizeMb: 32, codeRangeSizeMb: 16 },
      stdout: true, stderr: true,
    });
    const conclure = (r: ResultatJs) => { if (fini) return; fini = true; clearTimeout(garde); worker.terminate().catch(attendu("fermeture au mieux : la ressource est abandonnée de toute façon")); resolve({ ...r, ms: Date.now() - t0 }); };
    // La garde du FIL : `vm` coupe le code synchrone, mais une promesse qui ne se résout jamais
    // ou un fil qui s'attarde à sérialiser doit aussi finir. Marge de 1 s au-dessus du délai vm.
    const garde = setTimeout(() => conclure({ ok: false, resultat: null, journal: [], ms: 0, erreur: `délai dépassé (${delai} ms) : le fil a été arrêté`, notes }), delai + 1_000);
    worker.once("message", (m: { ok: boolean; resultat: string; journal: string[]; erreur?: string }) => {
      if (m.resultat.length > JS_RESULTAT_MAX) {
        notes.push(`résultat tronqué : ${m.resultat.length} octets, ${JS_RESULTAT_MAX} au plus — rendre moins de lignes ou agréger`);
        conclure({ ok: false, resultat: null, journal: m.journal ?? [], ms: 0, erreur: "résultat trop volumineux", notes });
        return;
      }
      let resultat: unknown = null;
      try { resultat = JSON.parse(m.resultat); } catch { /* le fil a déjà sérialisé, ceci n'arrive pas */ }
      conclure({ ok: m.ok, resultat, journal: m.journal ?? [], ms: 0, ...(m.erreur ? { erreur: m.erreur } : {}), notes });
    });
    worker.once("error", (e) => {
      const msg = e instanceof Error ? e.message : String(e);
      const court = /ERR_WORKER_OUT_OF_MEMORY|heap out of memory|Array buffer allocation failed/i.test(msg) ? `mémoire dépassée (${JS_MEMOIRE_MO} Mo) : le fil a été arrêté` : msg.slice(0, 400);
      conclure({ ok: false, resultat: null, journal: [], ms: 0, erreur: court, notes });
    });
    worker.once("exit", (code) => { if (!fini) conclure({ ok: false, resultat: null, journal: [], ms: 0, erreur: code === 0 ? "le fil s'est arrêté sans résultat" : `le fil s'est arrêté (code ${code}) — mémoire ou délai dépassé`, notes }); });
  });
}
