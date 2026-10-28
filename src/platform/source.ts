import fs from "node:fs";
import path from "node:path";
import { demenagements } from "./demenagements";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LIRE LE SOURCE DEPUIS UN TEST — sans enchaîner le test à l'adresse du fichier.
 *
 * Rapport d'audit 08, ARCH-05 : une centaine de tests lisent le code par son CHEMIN
 * (`readFileSync("src/lib/x.ts")`) pour vérifier une règle de structure. Déplacer le fichier
 * vers son module les rend rouges sans qu'aucun comportement n'ait changé : la migration
 * modulaire coûte plus cher qu'elle ne devrait, et l'équipe apprend que rouge ne veut pas dire
 * cassé.
 *
 * Deux portes, à préférer à `readFileSync` dans tout nouveau test de structure :
 *   - `lireSource(chemin)` suit les DÉMÉNAGEMENTS (`tsconfig.json`, voir `demenagements.ts`) :
 *     un test qui cite l'ancien chemin lit le fichier à sa nouvelle place ;
 *   - `sourceDuSymbole(nom)` trouve le fichier qui DÉCLARE un export (`export function nom`,
 *     `export const nom`…) : le test vise la règle par son nom, pas par son adresse.
 *
 * Le mieux reste de tester le COMPORTEMENT (appeler la fonction) ; ces portes sont pour les vraies
 * règles de structure. Lu par les tests seulement.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const EXTENSIONS = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];

/** Le chemin ACTUEL d'un fichier cité par son ancien chemin (avec ou sans extension) — inchangé s'il n'a pas bougé. */
export function cheminActuel(chemin: string, racine = process.cwd()): string {
  const net = chemin.split(path.sep).join("/").replace(/^\.\//, "");
  const sansExt = net.replace(/\.(tsx?|json)$/, "");
  const ext = net.slice(sansExt.length);
  const d = demenagements(racine).find((x) => x.ancienChemin === sansExt);
  if (!d) return net;
  for (const e of ext ? [ext] : EXTENSIONS) {
    const c = `${d.nouveauChemin}${e}`;
    if (fs.existsSync(path.join(racine, c)) && fs.statSync(path.join(racine, c)).isFile()) return c;
  }
  return `${d.nouveauChemin}${ext}`;
}

/** Le texte d'un fichier du dépôt, en suivant ses déménagements. */
export function lireSource(chemin: string, racine = process.cwd()): string {
  return fs.readFileSync(path.join(racine, cheminActuel(chemin, racine)), "utf8");
}

function fichiersTs(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules") fichiersTs(p, out); }
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

/**
 * Le fichier (chemin depuis la racine) qui DÉCLARE l'export `nom` sous `src/`. Lève si aucun ou
 * plusieurs le déclarent : un test de structure doit viser une règle sans ambiguïté.
 */
export function fichierDuSymbole(nom: string, racine = process.cwd()): string {
  const decl = new RegExp(`^export\\s+(?:default\\s+)?(?:async\\s+)?(?:function\\*?|const|let|class|interface|type|enum)\\s+${nom}\\b`, "m");
  const trouves = fichiersTs(path.join(racine, "src"))
    .filter((f) => decl.test(fs.readFileSync(f, "utf8")))
    .map((f) => path.relative(racine, f).split(path.sep).join("/"));
  if (trouves.length !== 1) {
    throw new Error(`sourceDuSymbole(« ${nom} ») : ${trouves.length} déclarations (${trouves.join(", ") || "aucune"}) — il en faut exactement une.`);
  }
  return trouves[0]!;
}

/** Le texte du fichier qui déclare l'export `nom`. */
export function sourceDuSymbole(nom: string, racine = process.cwd()): string {
  return fs.readFileSync(path.join(racine, fichierDuSymbole(nom, racine)), "utf8");
}
