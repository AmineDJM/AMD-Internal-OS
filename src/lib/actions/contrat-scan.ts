import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Prisma } from "@prisma/client";
import { parcDesActions, type FichierDActions } from "./parc";
import { contratsDuFichier, importsProjet, type ContratAction, type TableEnums, type TableRelations } from "./contrat";
import { PREFIXE_INTERNES } from "./contrat/internes";

/**
 * LA LECTURE DU PARC — la seule pièce qui touche au disque.
 *
 * Elle est séparée de `contrat.ts` pour la raison qui gouverne toute la frontière client :
 * `contrat.ts` est PUR et importable de partout ; un module qui lit des fichiers ne l'est
 * jamais. Ici on assume `fs` et Prisma, et on ne sert que le générateur et son cliquet.
 */

/** La racine sur laquelle `@/` se résout — la même que celle du `tsconfig`. */
const RACINE_SRC = join(process.cwd(), "src");

/** Les valeurs admises que le SCHÉMA déclare — un fait de la base, pas une liste écrite. */
export function enumsDuSchema(): TableEnums {
  return Object.fromEntries(
    Prisma.dmmf.datamodel.enums.map((e) => [e.name, e.values.map((v) => v.name)]),
  );
}

/**
 * CE QUE LE SCHÉMA DIT DES RÉFÉRENCES — `"CareBeneficiary.doctorId" → "MedicalDoctor"`.
 *
 * C'est ce qui permet à une personne d'écrire « Nivolex » là où l'action attend un `cuid`. La
 * table est DÉRIVÉE du DMMF, comme les énums : une table écrite à la main serait fausse le jour
 * où quelqu'un ajoute une relation, en silence (§118.73).
 *
 * Deux sortes d'entrées, et la seconde évite un cas particulier dans le module pur : la clé
 * PROPRE de chaque modèle (`"DriveNode.id" → "DriveNode"`), pour que le champ `id` d'une action
 * qui écrit un seul modèle se résolve par la même règle que tous les autres.
 *
 * Une relation à clé COMPOSÉE (plusieurs colonnes) est ignorée : un seul champ n'y désigne pas
 * une ligne, et prétendre le contraire ferait résoudre vers la mauvaise (§118.16).
 */
export function relationsDuSchema(): TableRelations {
  const table: Record<string, string> = {};
  for (const m of Prisma.dmmf.datamodel.models) {
    table[`${m.name}.id`] = m.name;
    for (const f of m.fields) {
      if (f.kind === "object" && f.relationFromFields?.length === 1) {
        table[`${m.name}.${f.relationFromFields[0]}`] = f.type;
      }
    }
  }
  return table;
}

/**
 * Les fichiers d'actions du parc — `src/lib/actions/` ET les `actions.ts` des modules, sous leur
 * clé déclarée (`parc.ts`). La clé, pas le chemin, est l'identité d'une action (ARCH-03).
 */
export function fichiersDActions(): FichierDActions[] {
  return parcDesActions();
}

/**
 * LE SOURCE DES MODULES `@/lib/...` QU'UN FICHIER IMPORTE.
 *
 * Pourquoi c'est ICI et pas dans `contrat.ts` : ce module-là est PUR et ne lit pas le disque —
 * il reçoit du texte. La lecture appartient au scanner, et l'y garder est ce qui permet de
 * tester la dérivation sans système de fichiers.
 *
 * `@/` se résout sur `src/`, comme le `tsconfig`. Un module introuvable est SILENCIEUSEMENT
 * ignoré, et c'est voulu : son absence rend simplement les faits d'écriture ceux du corps —
 * le comportement d'avant ce mécanisme. Jeter une exception ferait échouer la dérivation
 * entière parce qu'un import pointe vers un fichier `index.ts` d'un dossier, cas que ce
 * résolveur ne prétend pas couvrir.
 */
function sourcesImportees(source: string, cache: Map<string, string>, profondeur = 0): Record<string, string> {
  const out: Record<string, string> = {};
  for (const spec of new Set(Object.values(importsProjet(source)))) {
    let texte = cache.get(spec);
    if (texte === undefined) {
      texte = lireAvecReexports(join(RACINE_SRC, spec.replace(/^@\//, "")));
      cache.set(spec, texte);
    }
    if (!texte) continue;
    out[spec] = texte;
    // UNE AIDE INTERNE EST LE CODE DU FICHIER (`contrat/internes.ts`) : ce qu'ELLE importe se lit aussi, pour suivre
    // ses écrivains comme ceux de l'action. Un seul niveau, et seulement sous `actions/internes/`.
    if (profondeur === 0 && spec.startsWith(PREFIXE_INTERNES)) Object.assign(out, sourcesImportees(texte, cache, 1), out);
  }
  return out;
}

/**
 * Le source d'un module, PLUS celui des fichiers qu'il réexporte en relatif (`export { … } from "./infra/x"`).
 *
 * La porte d'un module (`src/modules/<m>/api.ts`, audit 08) ne contient que des réexportations : sans les suivre, une
 * action qui appelle `importerConsommation` par la porte serait décrite comme n'écrivant rien de plus que son journal.
 * Un seul niveau, et seulement en relatif : c'est la forme exacte d'une porte, rien de plus n'est deviné.
 */
function lireAvecReexports(base: string): string {
  for (const chemin of [`${base}.ts`, join(base, "index.ts")]) {
    let texte: string;
    try { texte = readFileSync(chemin, "utf8"); } catch { continue; }
    const suivis: string[] = [];
    for (const m of texte.matchAll(/export\s*\{[^}]*\}\s*from\s*"(\.{1,2}\/[^"]+)"/g)) {
      try { suivis.push(readFileSync(`${join(dirname(chemin), m[1]!)}.ts`, "utf8")); } catch { /* réexport introuvable : ignoré */ }
    }
    return [texte, ...suivis].join("\n");
  }
  return "";
}

/** Tous les contrats de l'ERP, dérivés de la source à l'instant où on appelle. */
export function scannerContrats(): ContratAction[] {
  const enums = enumsDuSchema();
  const relations = relationsDuSchema();
  const out: ContratAction[] = [];
  // LE SOURCE DES MODULES IMPORTÉS, mis en cache pour tout le scan : plusieurs fichiers
  // d'actions importent le même écrivain de domaine, et le relire à chaque fois multiplierait
  // les lectures disque sans rien changer au résultat.
  const cache = new Map<string, string>();
  for (const f of fichiersDActions()) {
    const source = readFileSync(join(process.cwd(), f.chemin), "utf8");
    out.push(...contratsDuFichier(f.cle, source, enums, relations, sourcesImportees(source, cache)));
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}
