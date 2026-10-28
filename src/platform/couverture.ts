import fs from "node:fs";
import path from "node:path";
import { coucheDe, domainOf } from "./domains";
import { cibleInterne, dependances } from "./imports";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA COUVERTURE DES CLIQUETS D'ARCHITECTURE — rapport d'audit 08, ARCH-01, ARCH-02, ARCH-05.
 *
 * Les cliquets de `domains.ts` et `boundary-scan.ts` ne regardent que `src/lib/` et
 * `src/platform/`, et seulement les fichiers rangés dans une couche. Mesuré au 27/10/2026 :
 * 43 % de `src/lib/` hors de toute couche, `src/app/` (≈ 1 050 fichiers) et `src/components/`
 * jamais mesurés, 128 pages qui parlent à Prisma. Un compteur qui baisse pendant que le couplage
 * réel monte est pire qu'aucun compteur.
 *
 * Ce module MESURE ce que les autres ne voient pas ; `couverture.test.ts` tient chaque chiffre
 * comme un cliquet (il ne peut que baisser). Lecture des imports par `imports.ts` — relatifs
 * compris, comme tous les gardes depuis ARCH-01. Lu par les tests et les scripts seulement.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules") walk(p, out); }
    else if (/\.tsx?$/.test(e.name)) out.push(p.split(path.sep).join("/"));
  }
  return out;
}

const estTest = (f: string) => /\.test\.tsx?$/.test(f);

export interface Couverture {
  /** Fichiers de production de `src/lib/` rangés dans AUCUNE couche (ni domaine, ni socle, ni façade…). */
  horsCarte: string[];
  /** `page.tsx` / `layout.tsx` qui importent `@/lib/prisma` (une page lit par une porte, pas par la base). */
  pagesPrisma: string[];
  /** `route.ts` qui importent `@/lib/prisma`. */
  routesPrisma: string[];
  /** Imports `src/components/` → `src/app/` : un composant partagé qui dépend d'une page (inversion). */
  composantsVersApp: string[];
  /** Imports du kit d'interface du socle (`components/ui`, `components/shared`) vers un domaine de `src/lib/` ou un module. */
  kitVersMetier: string[];
  /** Tests (hors `src/platform/` et `src/modules/`) qui lisent le source par un chemin `src/…` littéral. */
  testsDeTexte: string[];
}

/** Lit un chemin `src/…` écrit en dur dans `readFileSync(…)`, `lire(…)`, `lireSource(…)`, `join(…, "src/…")`. */
const LECTURE_PAR_CHEMIN = /(?:readFileSync|lire|lireSource|existsSync)\(\s*(?:path\.join\(\s*|join\(\s*)?(?:process\.cwd\(\),\s*|RACINE,\s*|ROOT,\s*)?["'`]src\//;

export function mesurerCouverture(racine = process.cwd()): Couverture {
  const cwd = process.cwd();
  process.chdir(racine);
  try {
    const lib = walk("src/lib").filter((f) => !estTest(f));
    const app = walk("src/app").filter((f) => !estTest(f));
    const comps = walk("src/components").filter((f) => !estTest(f));
    const importsDe = (f: string) => dependances(fs.readFileSync(f, "utf8")).map((d) => cibleInterne(d.spec, f)).filter((t): t is string => !!t);

    const pagesPrisma: string[] = [];
    const routesPrisma: string[] = [];
    for (const f of app) {
      if (!importsDe(f).includes("src/lib/prisma")) continue;
      if (/\/(page|layout)\.tsx?$/.test(f)) pagesPrisma.push(f);
      else if (/\/route\.ts$/.test(f)) routesPrisma.push(f);
    }

    const composantsVersApp: string[] = [];
    const kitVersMetier: string[] = [];
    for (const f of comps) {
      for (const t of importsDe(f)) {
        if (t.startsWith("src/app/")) composantsVersApp.push(`${f} → ${t}`);
        if (/^src\/components\/(ui|shared)\//.test(f) && (domainOf(t) || domainOf(`${t}/`) || t.startsWith("src/modules/"))) {
          kitVersMetier.push(`${f} → ${t}`);
        }
      }
    }

    const testsDeTexte = walk("src")
      .filter((f) => estTest(f) && !f.startsWith("src/platform/") && !f.startsWith("src/modules/"))
      .filter((f) => LECTURE_PAR_CHEMIN.test(fs.readFileSync(f, "utf8")));

    return {
      horsCarte: lib.filter((f) => coucheDe(f) === null),
      pagesPrisma, routesPrisma, composantsVersApp, kitVersMetier, testsDeTexte,
    };
  } finally {
    process.chdir(cwd);
  }
}
