/**
 * GÉNÈRE `src/lib/actions/contrat.genere.ts` depuis la SOURCE des actions.
 *
 * Pourquoi un artefact versionné plutôt qu'une lecture à l'exécution : en production, les
 * fichiers `src/lib/actions/*.ts` ne sont pas sur le disque — Next.js les a compilés. Adam a
 * pourtant besoin de ces contrats à l'exécution. On dérive donc au moment du build, et le
 * cliquet (`contrat.test.ts`) REDÉRIVE à chaque test et compare : une dérive fait échouer les
 * tests en nommant l'action, personne n'entretient ce fichier à la main.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { scannerContrats } from "../src/lib/actions/contrat-scan";
import { parcDesActions } from "../src/lib/actions/parc";

const contrats = scannerContrats();
const illisibles = contrats.filter((c) => c.illisible);

/**
 * LES CONTRATS SORTENT EN JSON, PAS EN TYPESCRIPT — et ce n'est pas cosmétique.
 *
 * La première version écrivait un `.ts` de 349 ko : 715 littéraux d'objet denses, une ligne
 * chacun. Mesuré : l'extraction de Graphify — la carte d'architecture dont TOUT le travail
 * suivant dépend pour se repérer — passait de 60 secondes à un blocage INDÉFINI. Retirer ce
 * seul fichier la fait revenir en moins de 300 s (18 103 nœuds). Un analyseur d'AST doit typer
 * ce que le compilateur typerait ; 349 ko de littéraux, c'est du travail qu'aucun humain ne lui
 * demandait.
 *
 * Une DONNÉE générée est une donnée : elle sort en `.json`, et un module de trois lignes
 * l'importe en lui redonnant son type. La ligne par action est conservée — un diff doit
 * continuer de nommer l'action dont le contrat a bougé.
 */
const lignes = contrats.map((c) => "  " + JSON.stringify(c)).join(",\n");
writeFileSync(
  join(process.cwd(), "src", "lib", "actions", "contrat.genere.json"),
  `[\n${lignes}\n]\n`,
  "utf8",
);

const chargeur = `// ⚠️  Module de CHARGEMENT — les données vivent dans \`contrat.genere.json\`, produit par
// \`npm run actions:contrat\` depuis la SOURCE du parc (src/lib/actions/ et\n// les actions.ts des modules, voir parc.ts). Le cliquet
// \`contrat.test.ts\` redérive et compare : toute dérive échoue.
//
// Pourquoi du JSON et non du TypeScript : 715 littéraux d'objet en \`.ts\` faisaient BLOQUER
// l'extraction Graphify indéfiniment (mesuré). Une donnée générée est une donnée.
import type { ContratAction } from "./contrat";
import donnees from "./contrat.genere.json";

export const CONTRATS_ACTIONS: readonly ContratAction[] = donnees as readonly ContratAction[];

/** Index par id — \`fichier:fonction\`, la même clé que le registre de parité. */
export const CONTRAT_PAR_ID: ReadonlyMap<string, ContratAction> =
  new Map(CONTRATS_ACTIONS.map((c) => [c.id, c]));
`;
writeFileSync(join(process.cwd(), "src", "lib", "actions", "contrat.genere.ts"), chargeur, "utf8");

/**
 * LA TABLE D'AIGUILLAGE — un spécificateur STATIQUE par fichier, chargé PARESSEUSEMENT.
 *
 * Trois formes étaient possibles et deux sont mauvaises. Un `import()` à chemin calculé fait
 * fabriquer à l'empaqueteur un module de contexte pour tout le dossier — analysable par
 * personne. Des imports statiques de tout le parc tireraient chaque dépendance lourde
 * (`mupdf`, `sharp`, `nodemailer`) dans le paquet de qui touche l'aiguillage. Une table de
 * fonctions paresseuses à spécificateurs littéraux garde les deux propriétés : l'empaqueteur
 * voit chaque chemin, et rien n'est chargé tant qu'on n'appelle pas.
 */
const presents = new Set(contrats.map((c) => c.fichier));
// La CLÉ d'un fichier (`parc.ts`), pas son chemin : une action rangée dans un module garde sa clé,
// et seul son spécificateur change (`@/modules/<m>/actions`).
const fichiers = parcDesActions().filter((f) => presents.has(f.cle));
// Une clé portée par plusieurs morceaux (un fichier d'actions découpé, `parc.ts`) : une entrée, qui
// charge les morceaux et réunit leurs exports. Une clé d'un seul fichier garde sa forme d'avant.
const parCle = new Map<string, string[]>();
for (const f of fichiers) parCle.set(f.cle, [...(parCle.get(f.cle) ?? []), f.specificateur]);
const entree = ([cle, specs]: [string, string[]]): string => specs.length === 1
  ? `  ${JSON.stringify(cle)}: () => import(${JSON.stringify(specs[0])}) as unknown as Promise<Record<string, unknown>>,`
  : `  ${JSON.stringify(cle)}: () => Promise.all([\n${specs.map((s) => `    import(${JSON.stringify(s)}) as unknown as Promise<Record<string, unknown>>,`).join("\n")}\n  ]).then(reunir),`;
const decoupees = [...parCle.values()].some((s) => s.length > 1);
const aiguillage = `// ⚠️  FICHIER GÉNÉRÉ — ne pas éditer à la main. Voir \`npm run actions:contrat\`.
//
// Chaque entrée est un spécificateur LITTÉRAL : l'empaqueteur les voit tous, et rien n'est
// chargé avant l'appel. \`executer.test.ts\` résout les ${contrats.length} actions et échoue en
// nommant celle qui a disparu — c'est le contrôle d'appelant que le compilateur ne fait pas ici.
${decoupees ? `
/** Les exports des morceaux d'une clé découpée, réunis (exports nommés et objet \`default\` de l'interop CommonJS). */
const reunir = (morceaux: Record<string, unknown>[]): Record<string, unknown> =>
  Object.assign({}, ...morceaux.map((m) => ({ ...(m.default && typeof m.default === "object" ? m.default as Record<string, unknown> : {}), ...m })));
` : ""}
export const MODULES_ACTIONS: Readonly<Record<string, () => Promise<Record<string, unknown>>>> = {
${[...parCle.entries()].map(entree).join("\n")}
};
`;
writeFileSync(join(process.cwd(), "src", "lib", "actions", "aiguillage.genere.ts"), aiguillage, "utf8");
console.info(`[CONTRAT] aiguillage : ${parCle.size} modules (${fichiers.length} fichiers)`);

const appelables = contrats.length - illisibles.length;
console.info(`[CONTRAT] ${contrats.length} actions — ${appelables} appelables, ${illisibles.length} illisibles`);
const parCause = new Map<string, number>();
for (const c of illisibles) {
  const cause = c.illisible!.split("—")[0]!.split("(")[0]!.trim();
  parCause.set(cause, (parCause.get(cause) ?? 0) + 1);
}
for (const [cause, n] of [...parCause.entries()].sort((a, b) => b[1] - a[1])) {
  console.info(`   ${String(n).padStart(4)}  ${cause}`);
}
