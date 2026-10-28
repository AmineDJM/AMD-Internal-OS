import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ICONES_COQUE } from "./icones-coque";
import { IconeCoque } from "./icone-coque";
import { iconeParNom } from "./icon";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA COQUE NE TIRE QUE SES ICÔNES (audit performance PERF-05).
 *
 * `ICONES_COQUE` est une table d'imports nommés : ce qu'elle oublie ne se dessine qu'au prix du jeu
 * complet chargé à la demande. Ce cliquet relit les SOURCES des noms de la coque et exige :
 *   1. que chaque nom y soit (un oubli échoue ici, pas sur l'écran d'un délégué en 4G) ;
 *   2. qu'elle ne porte AUCUN nom que ces sources n'emploient plus (chaque entrée coûte des octets) ;
 *   3. que la même icône qu'avant soit dessinée (`iconeParNom` — le résolveur du jeu complet) ;
 *   4. qu'aucun composant de `components/layout` ne réimporte le jeu complet.
 * Plancher de noms lus : un parcours cassé qui ne trouverait rien serait vert sans rien garder (§118.17).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const RACINE = process.cwd();
const COQUE = join(RACINE, "src/components/layout");
/** Les fichiers qui donnent un nom d'icône à la coque : menu, pôles, Office, résultats de recherche. */
const SOURCES_DE_NOMS = ["src/lib/labels/navigation.ts", "src/lib/labels/onglets.ts", "src/lib/navigation.ts", "src/lib/office/apps.ts", "src/lib/queries/search.ts"];
const sansCommentaires = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
const composantsDeLaCoque = readdirSync(COQUE).filter((f) => f.endsWith(".tsx"));

function nomsEmployes(): Map<string, string> {
  const noms = new Map<string, string>();
  for (const f of SOURCES_DE_NOMS) {
    for (const m of readFileSync(join(RACINE, f), "utf8").matchAll(/\bicon:\s*["']([A-Z][A-Za-z0-9]+)["']/g)) noms.set(m[1], f);
  }
  for (const f of composantsDeLaCoque) {
    for (const m of readFileSync(join(COQUE, f), "utf8").matchAll(/<IconeCoque\s+name="([A-Z][A-Za-z0-9]+)"/g)) noms.set(m[1], f);
  }
  return noms;
}

describe("icônes de la coque — la table statique", () => {
  const employes = nomsEmployes();
  const table = new Set(Object.keys(ICONES_COQUE));

  it("PLANCHER : le parcours lit bien les noms de la coque", () => {
    expect(employes.size).toBeGreaterThanOrEqual(60);
  });

  it("chaque nom employé par la coque est dans la table", () => {
    const manquants = [...employes].filter(([nom]) => !table.has(nom)).map(([nom, f]) => `${nom} (${f})`);
    expect(manquants, "ajoutez l'import nommé dans icones-coque.ts").toEqual([]);
  });

  it("la table ne garde aucun nom que la coque n'emploie plus", () => {
    expect([...table].filter((nom) => !employes.has(nom))).toEqual([]);
  });

  it("chaque entrée est la MÊME icône que le résolveur du jeu complet", () => {
    const differentes = Object.entries(ICONES_COQUE).filter(([nom, C]) => iconeParNom(nom) !== C).map(([nom]) => nom);
    expect(differentes).toEqual([]);
  });

  it("`IconeCoque` dessine une icône de la table", () => {
    expect(renderToStaticMarkup(React.createElement(IconeCoque, { name: "ChevronDown" }))).toContain("<svg");
  });

  it("aucun composant de la coque ne réimporte le jeu complet", () => {
    const fautifs = composantsDeLaCoque.filter((f) => {
      const src = sansCommentaires(readFileSync(join(COQUE, f), "utf8"));
      return /from\s+["']@\/components\/ui\/icon["']/.test(src)
        || /import\s+\*\s+as\s+\w+\s+from\s+["']lucide-react["']/.test(src)
        || /import\s*{[^}]*\bicons\b[^}]*}\s*from\s+["']lucide-react["']/.test(src);
    });
    expect(fautifs).toEqual([]);
  });
});
