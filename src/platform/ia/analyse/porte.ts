/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA PORTE DE QUALITÉ DU CODE COMME OUTIL (mandat 5 §34) — pur : elle reçoit un exécuteur, elle
 * ne connaît ni le bac, ni Prisma, ni le modèle.
 *
 *   generate → INSPECT → EXECUTE → TEST → VALIDATE → expose
 *
 * Un modèle écrit du code ; le code décide s'il a le droit de devenir un RÉSULTAT. Cinq étapes,
 * chacune avec un verdict nommé :
 *   1. inspecter  — la forme du code (taille, interdits statiques que l'isolation ne couvre pas :
 *                   tentatives réseau / fichiers / processus, boucles sans borne visibles, `return`
 *                   absent en JS) ; refuser AVANT d'exécuter ce qui n'a aucune chance d'être exposé ;
 *   2. exécuter   — dans le bac (fil isolé, processus limité) ; une exception est une étape, pas
 *                   une exception ;
 *   3. tester     — les ATTENTES déclarées par l'appelant : des assertions closes (`egal`, `superieur`,
 *                   `contient`, `longueur`, `nonVide`, `type`) lues sur le résultat par un chemin, et
 *                   des invariants numériques (`somme`, `bornes`) — jamais du code à exécuter ;
 *   4. valider    — la FORME du résultat contre le schéma promis (objet / liste / nombre / texte,
 *                   clés obligatoires, taille bornée, nombres finis) ;
 *   5. exposer    — seulement si tout tient. Sinon le rapport dit L'ÉTAPE qui a refusé et pourquoi,
 *                   et le résultat n'est pas exposé : un chiffre faux avec l'air d'un chiffre juste
 *                   est le défaut que cette porte existe pour supprimer.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type Langage = "js" | "python";
export type Etape = "inspection" | "execution" | "tests" | "validation";

export interface Attente {
  /** Un chemin dans le résultat : `total`, `lignes[0].montant`, `lignes.length`, `` (racine). */
  chemin: string;
  op: "egal" | "different" | "superieur" | "inferieur" | "contient" | "longueur" | "nonVide" | "type" | "entre";
  valeur?: unknown;
  /** Pour `entre` : [min, max]. */
  bornes?: [number, number];
  libelle?: string;
}

export interface SchemaSortie {
  forme: "objet" | "liste" | "nombre" | "texte" | "quelconque";
  /** Clés obligatoires (objet) ou clés obligatoires de CHAQUE élément (liste d'objets). */
  cles?: string[];
  /** Nombre maximal d'éléments d'une liste, ou de caractères d'un texte. */
  max?: number;
}

export interface ExecutionBac {
  ok: boolean;
  resultat: unknown;
  erreur?: string;
  ms: number;
  journal?: string[];
}

export interface VerdictEtape { etape: Etape; ok: boolean; detail: string; ms?: number }

export interface RapportPorte {
  /** Exposé seulement si les quatre étapes tiennent. */
  expose: boolean;
  resultat: unknown;
  etapes: VerdictEtape[];
  /** L'étape qui a refusé, s'il y en a une. */
  refusePar: Etape | null;
  /** Ce qu'il faudrait corriger — pour la boucle « generate → inspect → correct ». */
  correction: string | null;
  testsPasses: number;
  testsTotal: number;
}

const INTERDITS: { motif: RegExp; raison: string; langages: Langage[] }[] = [
  { motif: /\brequire\s*\(\s*["'](?:fs|child_process|net|http|https|dns|worker_threads|cluster|os|vm)["']/, raison: "accès système (require) — le bac n'a ni fichiers, ni réseau, ni processus", langages: ["js"] },
  { motif: /\bimport\s*\(|\bfrom\s+["'](?:fs|child_process|net|http|https|dns)["']/, raison: "import de module système", langages: ["js"] },
  { motif: /\b(?:fetch|XMLHttpRequest|WebSocket)\s*\(/, raison: "appel réseau — le code ne lit que `data`", langages: ["js"] },
  { motif: /\bprocess\s*\.\s*(?:env|exit|kill|binding)/, raison: "accès au processus hôte", langages: ["js"] },
  { motif: /\b(?:eval|Function)\s*\(/, raison: "évaluation dynamique de code", langages: ["js"] },
  { motif: /\bwhile\s*\(\s*true\s*\)|\bfor\s*\(\s*;\s*;\s*\)/, raison: "boucle sans borne visible", langages: ["js"] },
  { motif: /^\s*(?:import|from)\s+(?:os|sys|subprocess|socket|shutil|pathlib|requests|urllib|http|ctypes|multiprocessing|threading)\b/m, raison: "module système ou réseau — le bac n'a ni fichiers, ni réseau, ni processus", langages: ["python"] },
  { motif: /\b(?:open|exec|eval|compile|__import__)\s*\(/, raison: "fichiers ou évaluation dynamique", langages: ["python"] },
  { motif: /\bwhile\s+True\s*:/, raison: "boucle sans borne visible", langages: ["python"] },
];

/** 1. INSPECTER — statique, avant toute exécution. */
export function inspecter(code: string, langage: Langage, opts: { tailleMax?: number } = {}): VerdictEtape {
  const tailleMax = opts.tailleMax ?? 40_000;
  if (!code.trim()) return { etape: "inspection", ok: false, detail: "code vide" };
  if (code.length > tailleMax) return { etape: "inspection", ok: false, detail: `code trop long (${code.length} > ${tailleMax} caractères)` };
  for (const i of INTERDITS) {
    if (i.langages.includes(langage) && i.motif.test(code)) return { etape: "inspection", ok: false, detail: `interdit : ${i.raison}` };
  }
  if (langage === "js" && !/\breturn\b/.test(code)) return { etape: "inspection", ok: false, detail: "le code JavaScript doit `return` son résultat" };
  if (langage === "python" && !/\bresult\s*=/.test(code)) return { etape: "inspection", ok: false, detail: "le code Python doit poser `result = …`" };
  return { etape: "inspection", ok: true, detail: `${code.length} caractères, aucun interdit` };
}

/** Lit `chemin` dans une valeur : `a.b[0].c`, `lignes.length`, `` = racine. `undefined` si absent. */
export function lireChemin(valeur: unknown, chemin: string): unknown {
  if (!chemin.trim()) return valeur;
  const parts = chemin.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean);
  let cur: unknown = valeur;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    if (p === "length" && (Array.isArray(cur) || typeof cur === "string")) { cur = cur.length; continue; }
    if (typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

const nombre = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") { const n = Number(v.replace(/\s/g, "").replace(",", ".")); return Number.isFinite(n) ? n : null; }
  return null;
};

/** 3. TESTER — des assertions closes sur le résultat. */
export function tester(resultat: unknown, attentes: readonly Attente[]): { verdict: VerdictEtape; passes: number; echecs: string[] } {
  const echecs: string[] = [];
  for (const a of attentes) {
    const v = lireChemin(resultat, a.chemin);
    const nom = a.libelle ?? `${a.chemin || "racine"} ${a.op}${a.valeur !== undefined ? ` ${JSON.stringify(a.valeur)}` : ""}`;
    let ok = false;
    switch (a.op) {
      case "egal": ok = JSON.stringify(v) === JSON.stringify(a.valeur) || (nombre(v) !== null && nombre(a.valeur) !== null && Math.abs((nombre(v) as number) - (nombre(a.valeur) as number)) < 1e-9); break;
      case "different": ok = JSON.stringify(v) !== JSON.stringify(a.valeur); break;
      case "superieur": ok = nombre(v) !== null && nombre(a.valeur) !== null && (nombre(v) as number) > (nombre(a.valeur) as number); break;
      case "inferieur": ok = nombre(v) !== null && nombre(a.valeur) !== null && (nombre(v) as number) < (nombre(a.valeur) as number); break;
      case "entre": { const n = nombre(v); ok = n !== null && Array.isArray(a.bornes) && n >= a.bornes[0] && n <= a.bornes[1]; break; }
      case "contient": ok = typeof v === "string" ? v.includes(String(a.valeur)) : Array.isArray(v) ? v.some((x) => JSON.stringify(x) === JSON.stringify(a.valeur) || x === a.valeur) : false; break;
      case "longueur": ok = (Array.isArray(v) || typeof v === "string") && v.length === Number(a.valeur); break;
      case "nonVide": ok = v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0) && !(typeof v === "string" && v.trim() === "") && !(typeof v === "object" && !Array.isArray(v) && Object.keys(v as object).length === 0); break;
      case "type": ok = a.valeur === "liste" ? Array.isArray(v) : a.valeur === "objet" ? (v !== null && typeof v === "object" && !Array.isArray(v)) : typeof v === a.valeur; break;
    }
    if (!ok) echecs.push(`${nom} — obtenu ${JSON.stringify(v)?.slice(0, 80) ?? "undefined"}`);
  }
  const passes = attentes.length - echecs.length;
  return {
    verdict: { etape: "tests", ok: echecs.length === 0, detail: attentes.length ? `${passes}/${attentes.length} attente(s) tenue(s)${echecs.length ? ` ; échecs : ${echecs.join(" ; ")}` : ""}` : "aucune attente déclarée (le résultat n'est pas testé, seulement validé)" },
    passes, echecs,
  };
}

const finis = (v: unknown, profondeur = 0): string | null => {
  if (profondeur > 6) return null;
  if (typeof v === "number" && !Number.isFinite(v)) return "un nombre non fini (NaN / Infinity)";
  if (Array.isArray(v)) { for (const x of v.slice(0, 2_000)) { const e = finis(x, profondeur + 1); if (e) return e; } return null; }
  if (v && typeof v === "object") { for (const x of Object.values(v as Record<string, unknown>).slice(0, 200)) { const e = finis(x, profondeur + 1); if (e) return e; } }
  return null;
};

/** 4. VALIDER — la forme promise. */
export function valider(resultat: unknown, schema: SchemaSortie | null | undefined): VerdictEtape {
  if (resultat === undefined) return { etape: "validation", ok: false, detail: "aucun résultat rendu (return / result absent)" };
  const nonFini = finis(resultat);
  if (nonFini) return { etape: "validation", ok: false, detail: `le résultat contient ${nonFini}` };
  if (!schema || schema.forme === "quelconque") return { etape: "validation", ok: true, detail: "forme libre, nombres finis" };
  const manque = (o: unknown): string[] => (schema.cles ?? []).filter((k) => !(o && typeof o === "object" && !Array.isArray(o) && k in (o as object)));
  switch (schema.forme) {
    case "nombre": return nombre(resultat) !== null && typeof resultat !== "object" ? { etape: "validation", ok: true, detail: "nombre" } : { etape: "validation", ok: false, detail: `un nombre était promis, obtenu ${typeof resultat}` };
    case "texte": return typeof resultat === "string" && (!schema.max || resultat.length <= schema.max) ? { etape: "validation", ok: true, detail: "texte" } : { etape: "validation", ok: false, detail: `un texte${schema.max ? ` de ${schema.max} caractères au plus` : ""} était promis` };
    case "objet": {
      if (!resultat || typeof resultat !== "object" || Array.isArray(resultat)) return { etape: "validation", ok: false, detail: `un objet était promis, obtenu ${Array.isArray(resultat) ? "liste" : typeof resultat}` };
      const m = manque(resultat);
      return m.length ? { etape: "validation", ok: false, detail: `clés manquantes : ${m.join(", ")}` } : { etape: "validation", ok: true, detail: `objet${schema.cles?.length ? ` avec ${schema.cles.join(", ")}` : ""}` };
    }
    case "liste": {
      if (!Array.isArray(resultat)) return { etape: "validation", ok: false, detail: `une liste était promise, obtenu ${typeof resultat}` };
      if (schema.max && resultat.length > schema.max) return { etape: "validation", ok: false, detail: `${resultat.length} éléments, ${schema.max} au plus` };
      if (schema.cles?.length) {
        const fautif = resultat.findIndex((x) => manque(x).length > 0);
        if (fautif >= 0) return { etape: "validation", ok: false, detail: `élément ${fautif} sans ${manque(resultat[fautif]).join(", ")}` };
      }
      return { etape: "validation", ok: true, detail: `liste de ${resultat.length}` };
    }
  }
}

export interface DemandePorte {
  code: string;
  langage: Langage;
  data: unknown;
  attentes?: readonly Attente[];
  schema?: SchemaSortie | null;
  executer: (code: string, data: unknown) => Promise<ExecutionBac>;
}

/** LA PORTE : cinq étapes, un rapport, et un résultat exposé seulement si tout tient. */
export async function passerLaPorte(d: DemandePorte): Promise<RapportPorte> {
  const etapes: VerdictEtape[] = [];
  const refus = (correction: string): RapportPorte => ({
    expose: false, resultat: undefined, etapes, refusePar: etapes[etapes.length - 1].etape, correction,
    testsPasses: etapes.find((e) => e.etape === "tests") ? Number(/^(\d+)\//.exec(etapes.find((e) => e.etape === "tests")!.detail)?.[1] ?? 0) : 0,
    testsTotal: d.attentes?.length ?? 0,
  });
  const insp = inspecter(d.code, d.langage);
  etapes.push(insp);
  if (!insp.ok) return refus(`Corriger le code avant toute exécution : ${insp.detail}.`);

  const t0 = Date.now();
  let ex: ExecutionBac;
  try { ex = await d.executer(d.code, d.data); } catch (err) { ex = { ok: false, resultat: undefined, erreur: err instanceof Error ? err.message : String(err), ms: Date.now() - t0 }; }
  etapes.push({ etape: "execution", ok: ex.ok, detail: ex.ok ? `exécuté en ${ex.ms} ms` : `échec : ${ex.erreur ?? "sans message"}`, ms: ex.ms });
  if (!ex.ok) return refus(`Le code a échoué à l'exécution : ${ex.erreur ?? "sans message"}. Corriger et réessayer.`);

  const attentes = d.attentes ?? [];
  const t = tester(ex.resultat, attentes);
  etapes.push(t.verdict);
  if (!t.verdict.ok) return { ...refus(`${t.echecs.length} attente(s) non tenue(s) : ${t.echecs.join(" ; ")}. Le résultat n'est pas exposé — corriger le calcul, pas l'attente.`), testsPasses: t.passes, testsTotal: attentes.length };

  const v = valider(ex.resultat, d.schema);
  etapes.push(v);
  if (!v.ok) return { ...refus(`La forme du résultat ne correspond pas à ce qui était promis : ${v.detail}.`), testsPasses: t.passes, testsTotal: attentes.length };

  return { expose: true, resultat: ex.resultat, etapes, refusePar: null, correction: null, testsPasses: t.passes, testsTotal: attentes.length };
}
