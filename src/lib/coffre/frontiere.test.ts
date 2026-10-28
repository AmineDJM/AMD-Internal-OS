import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * LA FRONTIÈRE DU COFFRE.
 *
 * 1. Aucun composant `"use client"` n'atteint le coffre, même indirectement : il chiffre avec
 *    `node:crypto`, que le garde général (`client-bundle-guard.test.ts`) ne liste pas, et ses clés
 *    n'ont rien à faire dans un navigateur. Seuls `natures.ts` et `politique.ts`, purs, sont permis.
 * 2. L'assistant et les agents n'atteignent AUCUN module du coffre : un modèle d'IA ne le lit pas,
 *    et le code qui lui prépare un contexte ne doit même pas pouvoir l'importer.
 *
 * 3. LES PORTES D'ÉCRITURE (`PORTES_ECRITURE`) : un module hors du coffre qui ne fait que DÉPOSER
 *    et calculer une EMPREINTE, jamais lire (l'enrichissement des fiches, lot V2-A). Le graphe de
 *    l'ERP étant presque connexe (le battement et l'aiguillage des actions rejoignent l'assistant),
 *    la remontée de l'assistant s'arrête à ces portes — en échange, chacune est relue ici : aucun
 *    appel à `lire`, `chercher` ni `dechiffrer`, aucun export du service. Déposer n'est pas lire.
 *
 * Même marche que le garde général (imports statiques, dynamiques ; arrêt aux modules
 * `"use server"` pour les composants client, puisque Next les remplace par un appel distant).
 */

const SRC = path.join(process.cwd(), "src");
const COFFRE = path.join(SRC, "lib", "coffre") + path.sep;
const PURS = new Set([path.join(COFFRE, "natures.ts"), path.join(COFFRE, "politique.ts")]);
const PORTES_ECRITURE = new Set([path.join(SRC, "lib", "enrichissement", "porte-coffre.ts")]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "node_modules" || name === "data") continue;
      walk(p, out);
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\sfrom\s+)?["']([^"']+)["']/g;
const DYNAMIC_IMPORT_RE = /\bimport\(\s*["']([^"']+)["']\s*\)/g;

function importsOf(file: string): string[] {
  const src = readFileSync(file, "utf8");
  const out: string[] = [];
  for (const m of src.matchAll(IMPORT_RE)) if (!/^\s*(?:import|export)\s+type\s/.test(m[0])) out.push(m[1]);
  for (const m of src.matchAll(DYNAMIC_IMPORT_RE)) out.push(m[1]);
  return out;
}

function resolve(spec: string, fromFile: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = path.join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(fromFile), spec);
  else return null;
  for (const cand of [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")]) {
    if (existsSync(cand) && statSync(cand).isFile()) return cand;
  }
  return null;
}

const isServerAction = (file: string) => /^\s*["']use server["']/.test(readFileSync(file, "utf8"));

/** Premier chemin d'import de `entry` vers un module du coffre non permis ; `null` s'il n'y en a pas. */
function cheminVersCoffre(entry: string, permis: ReadonlySet<string>, traverserActions: boolean): string[] | null {
  const seen = new Set<string>();
  const stack: { file: string; trail: string[] }[] = [{ file: entry, trail: [entry] }];
  while (stack.length) {
    const { file, trail } = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of importsOf(file)) {
      const next = resolve(spec, file);
      if (!next || seen.has(next)) continue;
      if (next.startsWith(COFFRE) && !permis.has(next)) return [...trail, next];
      if (!traverserActions && isServerAction(next)) continue;
      if (traverserActions && PORTES_ECRITURE.has(next)) continue;
      stack.push({ file: next, trail: [...trail, next] });
    }
  }
  return null;
}

const rel = (p: string) => path.relative(process.cwd(), p);
const tous = walk(SRC);

describe("Frontière du coffre", () => {
  it("aucun composant client n'atteint le coffre (hors natures/politique, purs)", () => {
    const clients = tous.filter((f) => /^\s*["']use client["']/.test(readFileSync(f, "utf8")));
    expect(clients.length).toBeGreaterThan(20);
    const fautifs = clients.map((f) => cheminVersCoffre(f, PURS, false)).filter((t): t is string[] => t !== null).map((t) => t.map(rel).join(" → "));
    expect(fautifs).toEqual([]);
  });

  it("natures.ts et politique.ts restent purs (aucun import hors d'eux-mêmes)", () => {
    for (const f of PURS) {
      for (const spec of importsOf(f)) expect(PURS.has(resolve(spec, f) ?? ""), `${rel(f)} importe « ${spec} »`).toBe(true);
    }
  });

  it("l'assistant et les agents n'atteignent aucun module du coffre, pas même par une action serveur", () => {
    const ia = tous.filter((f) => {
      const r = rel(f).split(path.sep).join("/");
      return r.startsWith("src/lib/agent/") || r.startsWith("src/components/assistant-beta/") || r.startsWith("src/app/(app)/assistant/");
    });
    expect(ia.length).toBeGreaterThan(0);
    const fautifs = ia.map((f) => cheminVersCoffre(f, new Set(), true)).filter((t): t is string[] => t !== null).map((t) => t.map(rel).join(" → "));
    expect(fautifs).toEqual([]);
  });

  it("une porte d'écriture ne fait que déposer et calculer une empreinte — jamais lire", () => {
    for (const porte of PORTES_ECRITURE) {
      const src = readFileSync(porte, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      expect(src, rel(porte)).not.toMatch(/\.lire\(|\.chercher\(|\bdechiffrer\b|lireAvecJournal|chercherParEmpreinte/);
      expect([...src.matchAll(/^export\s+(?:async\s+)?(?:function|const|class)\s+(\w+)/gm)].map((m) => m[1]), rel(porte)).toEqual(["porteDuCoffre"]);
    }
  });

  it("le garde détecte bien un import du coffre (le test n'est pas vide)", () => {
    expect(cheminVersCoffre(path.join(COFFRE, "service.ts"), new Set(), true)).not.toBeNull();
  });
});
