import path from "node:path";

/**
 * LES DÉPENDANCES D'UN FICHIER, LUES UNE SEULE FOIS ET DE LA MÊME FAÇON PARTOUT.
 *
 * Les cliquets d'architecture (`domains.ts`, `boundary-scan.ts`, `src/modules/frontieres.test.ts`)
 * comptent des imports. Chacun avait sa propre expression régulière, et aucune ne lisait les
 * imports RELATIFS : `import … from "./hr/stand-in-resolve"` dans `rbac.ts` (au socle) échappait
 * à l'invariant « le socle n'importe aucun domaine », pendant que la même ligne écrite
 * `@/lib/hr/stand-in-resolve` l'aurait fait tomber. Un cliquet qu'un `./` suffit à contourner
 * mesure la discipline de ceux qui écrivent `@/`, pas la dette.
 *
 * Ce module ne dépend que de `node:path` : il est lu par les tests et les scripts d'audit, jamais
 * par du code d'exécution.
 */

/** `import … from`, `export … from` (une réexportation crée la même dépendance), `import("…")`. */
const STATIC_RE = /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?)\s*from\s*["']([^"']+)["']/g;
const DYNAMIC_RE = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

/** Tous les spécificateurs écrits dans une source, tels quels (`@/…`, `./…`, `react`…). */
export function specificateurs(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(STATIC_RE)) out.push(m[1]);
  for (const m of source.matchAll(DYNAMIC_RE)) out.push(m[1]);
  return out;
}

/** Une dépendance lue dans une source : son spécificateur, et si elle ne transporte que des TYPES. */
export interface Dependance {
  spec: string;
  /**
   * `import type …`, `export type … from`, ou des accolades où chaque nom est `type X` : effacé à la
   * compilation, aucun code ne suit. Un `domaine/` pur peut décrire la forme d'une ligne Prisma
   * (`import type { Prisma } from "@prisma/client"`) sans jamais toucher la base.
   */
  typeSeul: boolean;
}

const STATIC_DETAIL_RE = /(?:^|\n)\s*((?:import|export)\s+(type\s+)?([\s\S]*?)\s*from\s*["']([^"']+)["'])/g;

/** Comme `specificateurs`, en disant pour chaque import s'il est de TYPE seulement. */
export function dependances(source: string): Dependance[] {
  const out: Dependance[] = [];
  for (const m of source.matchAll(STATIC_DETAIL_RE)) {
    const accolades = m[3]!.trim().match(/^\{([\s\S]*)\}$/);
    const noms = accolades ? accolades[1]!.split(",").map((n) => n.trim()).filter(Boolean) : [];
    const toutType = noms.length > 0 && noms.every((n) => n.startsWith("type "));
    out.push({ spec: m[4]!, typeSeul: !!m[2] || toutType });
  }
  for (const m of source.matchAll(DYNAMIC_RE)) out.push({ spec: m[1]!, typeSeul: false });
  return out;
}

/**
 * La cible INTERNE d'un spécificateur, en chemin `src/…` sans extension — `null` pour un paquet.
 * `@/lib/rbac` et `../rbac` (depuis `src/lib/hr/x.ts`) rendent tous deux `src/lib/rbac`.
 */
export function cibleInterne(spec: string, depuis: string): string | null {
  if (spec.startsWith("@/")) return `src/${spec.slice(2)}`;
  if (spec.startsWith("./") || spec.startsWith("../")) {
    return path.posix.normalize(path.posix.join(path.posix.dirname(depuis), spec));
  }
  return null;
}
