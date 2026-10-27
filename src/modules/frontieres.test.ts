import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cibleInterne, specificateurs } from "@/platform/imports";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES FRONTIÈRES DES MODULES (`src/modules/<module>/`) — rapport d'audit 08, structure cible.
 *
 *   api.ts      la seule porte serveur : commandes, requêtes, types publics ;
 *   domaine/    règles PURES : ni Prisma, ni Next, ni Node, ni React, ni `infra/`, ni `ecrans/` ;
 *   infra/      la base et les fichiers, appelés par `api.ts` ;
 *   ecrans/     composants React du module, importés par les pages de `src/app/` seulement.
 *
 * Les règles, toutes à ZÉRO (un module migré naît propre, il n'a pas de dette « à résorber ») :
 *   1. hors du module, on n'importe que `api` — ou un `ecrans/*` depuis `src/app/` ;
 *   2. `domaine/` est pur ;
 *   3. un module n'importe un autre module que par son `api` ;
 *   4. le socle (L0 de `platform/domains.ts`) n'importe aucun module — les façades et les domaines
 *      de `src/lib/`, eux, consomment les `api.ts` : c'est le sens voulu de la migration.
 *
 * Et une dette HÉRITÉE, mesurée par module : les imports d'un module vers l'ancien `src/lib/`
 * hors socle. Elle ne peut que baisser — la liste est exacte, une entrée neuve fait échouer.
 *
 * ESLint (`no-restricted-imports`, `.eslintrc.json`) dit la règle 1 dans l'éditeur ; ce test la
 * TIENT, imports relatifs compris (`platform/imports.ts`).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Les imports d'un module vers `src/lib/` hors socle, connus et nommés. Ne peut que rétrécir. */
const DETTE_HERITEE: Record<string, string[]> = {
  consommation: [
    // `normalizeHeader` (repli d'en-tête de tableur) vit dans l'import de l'annuaire médical.
    "src/modules/consommation/domaine/affinite.ts → src/lib/medical/directory-sheet",
    "src/modules/consommation/domaine/lecture.ts → src/lib/medical/directory-sheet",
    // Le référentiel produits : cible = `@/modules/produits/api`.
    "src/modules/consommation/domaine/resolution.ts → src/lib/products/identity",
  ],
};

/** Le socle : ce qu'un module a le droit de lire sans que ce soit une dette. */
const SOCLE = [
  "src/lib/prisma", "src/lib/session", "src/lib/rbac", "src/lib/utils", "src/lib/labels", "src/lib/audit",
  "src/lib/annuaires/", "src/lib/chemins/", "src/components/ui/", "src/components/shared/", "src/platform/imports",
];
/** Les actions serveur restent dans `src/lib/actions/` tant que leur contrat est indexé par nom de fichier (ARCH-03). */
const ACTIONS = "src/lib/actions/";
const INTERDITS_DOMAINE = /^(@prisma\/client|next(\/|$)|react(\/|$)|node:|fs$|path$|crypto$|xlsx$)/;

const RACINE = process.cwd();
function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules") walk(p, out); }
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(path.relative(RACINE, p).split(path.sep).join("/"));
  }
  return out;
}

const moduleDe = (f: string): string | null => f.match(/^src\/modules\/([^/]+)\//)?.[1] ?? null;
const partieDe = (f: string): string => f.split("/")[3]?.replace(/\.tsx?$/, "") ?? "";

interface Arete { from: string; spec: string; to: string | null }
const aretes: Arete[] = walk("src").concat(walk("scripts")).flatMap((from) =>
  specificateurs(fs.readFileSync(from, "utf8")).map((spec) => ({ from, spec, to: cibleInterne(spec, from) })));

const modules = fs.existsSync("src/modules")
  ? fs.readdirSync("src/modules", { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : [];

describe("modules — les frontières tiennent", () => {
  it("chaque module a sa porte `api.ts`", () => {
    for (const m of modules) expect(fs.existsSync(`src/modules/${m}/api.ts`), `src/modules/${m}/api.ts`).toBe(true);
  });

  it("1 · hors du module, on n'entre que par `api` (ou un écran, depuis une page)", () => {
    const fautes = aretes.filter(({ from, to }) => {
      const m = to && moduleDe(`${to}/`);
      if (!m || moduleDe(from) === m) return false;
      const partie = partieDe(`${to}.ts`);
      if (partie === "api") return false;
      if (partie === "ecrans" && from.startsWith("src/app/")) return false;
      return true;
    });
    expect(fautes.map((a) => `${a.from} ⇒ ${a.spec}`), "import profond dans un module : passer par son api.ts").toEqual([]);
  });

  it("2 · `domaine/` est pur", () => {
    const fautes = aretes.filter(({ from, spec, to }) => {
      if (!moduleDe(from) || partieDe(from) !== "domaine") return false;
      if (INTERDITS_DOMAINE.test(spec)) return true;
      if (to === "src/lib/prisma") return true;
      return !!to && moduleDe(`${to}/`) === moduleDe(from) && ["infra", "ecrans", "api"].includes(partieDe(`${to}.ts`));
    });
    expect(fautes.map((a) => `${a.from} ⇒ ${a.spec}`)).toEqual([]);
  });

  it("4 · le socle n'importe aucun module", () => {
    const fautes = aretes.filter(({ from, to }) => !moduleDe(from) && SOCLE.some((s) => from === `${s}.ts` || from.startsWith(s))
      && !!to && !!moduleDe(`${to}/`));
    expect(fautes.map((a) => `${a.from} ⇒ ${a.spec}`)).toEqual([]);
  });

  it("la dette héritée vers `src/lib/` ne grossit pas (et la liste reste exacte)", () => {
    for (const m of modules) {
      const mesuree = aretes
        .filter(({ from, to }) => moduleDe(from) === m && !!to && to.startsWith("src/lib/")
          && !to.startsWith(ACTIONS) && !SOCLE.some((s) => to === s || to.startsWith(s)))
        .map(({ from, to }) => `${from} → ${to}`);
      const connue = DETTE_HERITEE[m] ?? [];
      expect([...new Set(mesuree)].sort(), `dette héritée du module ${m} — une entrée neuve est un couplage ajouté ; une entrée disparue se RETIRE de DETTE_HERITEE`).toEqual([...connue].sort());
    }
  });

  it("un module ne reste pas à moitié déménagé dans `src/lib/`", () => {
    for (const m of modules) expect(fs.existsSync(`src/lib/${m}`), `src/lib/${m} existe encore`).toBe(false);
  });
});
