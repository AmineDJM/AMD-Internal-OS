import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Garde transversal du module RH (il lit tout `src/`) : à la racine du module, pas dans `domaine/`,
 * qui reste pur. Les règles qu'il protège sont testées dans `domaine/virement-paie.test.ts`.
 */

/**
 * LE POINT D'APPEL, PAS LE CORPS (§118.49). La règle de l'ancien circuit ne protège que si CHAQUE
 * lecteur de production la passe : l'écran qui propose l'envoi, l'action qui le couvre, le
 * planificateur qui annonce le versement. Un quatrième lecteur ajouté demain sans elle
 * ressortirait les salaires versés « à envoyer » — le cliquet le nomme.
 */
describe("Cliquet — chaque lecteur de production passe la règle de l'ancien circuit", () => {
  const fichiers = (dir = "src"): string[] => readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return fichiers(p);
    return /\.(ts|tsx)$/.test(n) && !/\.(test|spec)\.tsx?$/.test(n) ? [p] : [];
  });
  const sansCommentaires = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
  /** Le texte d'un appel, de sa parenthèse à celle qui l'équilibre. */
  const appel = (src: string, i: number) => {
    let prof = 0;
    for (let j = i; j < src.length; j += 1) {
      if (src[j] === "(") prof += 1;
      else if (src[j] === ")") { prof -= 1; if (prof === 0) return src.slice(i, j + 1); }
    }
    return src.slice(i);
  };
  const appels = (motif: RegExp) => fichiers()
    .filter((f) => !f.endsWith("virement-paie.ts"))
    .flatMap((f) => {
      const code = sansCommentaires(readFileSync(f, "utf8"));
      return [...code.matchAll(motif)].map((m) => ({ fichier: f, texte: appel(code, (m.index ?? 0) + m[0].length - 1) }));
    });

  it("PLANCHER : l'écran et l'action lisent l'état d'un salaire — un parcours cassé rendrait le cliquet vert sur rien", () => {
    expect(appels(/\betatSalaire\(/g).length).toBeGreaterThanOrEqual(2);
  });

  it("chaque `etatSalaire(` de production passe `avantLeCentre` — le refus nomme le fichier", () => {
    const fautifs = appels(/\betatSalaire\(/g).filter((a) => !/\bavantLeCentre\s*:/.test(a.texte)).map((a) => a.fichier);
    expect(fautifs, "lit l'état d'un salaire sans la règle de l'ancien circuit : un salaire déjà versé ressortirait « à envoyer »").toEqual([]);
  });

  it("chaque `clauseSalairesVersesANotifier(` de production passe l'instant de la bascule", () => {
    const tous = appels(/\bclauseSalairesVersesANotifier\(/g);
    expect(tous.length, "PLANCHER : le planificateur l'appelle").toBeGreaterThanOrEqual(1);
    const fautifs = tous.filter((a) => !/,/.test(a.texte)).map((a) => a.fichier);
    expect(fautifs, "annonce les versements sans l'ancien circuit : une saisie d'avant la bascule resterait muette").toEqual([]);
  });
});
