import fs from "node:fs";
import path from "node:path";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES DÉMÉNAGEMENTS — un fichier qui change d'adresse laisse une adresse de réexpédition.
 *
 * Migrer un module déplace des fichiers (`src/lib/coffre/cle.ts` → `src/modules/coffre/infra/cle.ts`).
 * Le dépôt est travaillé par plusieurs sessions en parallèle : une branche ouverte avant le
 * déménagement importe encore l'ancien chemin, et sa fusion casserait le build sans que personne
 * n'ait rien fait de faux. Deux remèdes classiques, deux défauts :
 *   - laisser un fichier relais à l'ancienne place (`export * from "…"`) : git ne voit plus le
 *     déplacement (l'ancien fichier existe toujours), et la retouche d'une autre branche sur l'ancien
 *     fichier entre en CONFLIT avec le relais au lieu de suivre le fichier dans son module ;
 *   - ne rien laisser : la branche parallèle ne compile plus après fusion.
 *
 * D'où l'adresse de réexpédition : une entrée EXACTE de `compilerOptions.paths` dans `tsconfig.json`
 * (`"@/lib/coffre/cle": ["./src/modules/coffre/infra/cle"]`). TypeScript, Next.js (webpack) et `tsx`
 * la lisent nativement ; Vitest la lit par `vitest.config.ts`, qui la dérive de ce même fichier. Il
 * n'y a donc QU'UNE table, et aucun fichier relais : git suit le déplacement.
 *
 * L'adresse est TEMPORAIRE. `src/modules/frontieres.test.ts` exige qu'aucun fichier n'importe un
 * ancien chemin : le code du dépôt parle la nouvelle langue dès le déménagement, l'adresse ne sert
 * qu'au code qui arrive d'une autre branche — et le test lui dit quoi écrire à la place. Une entrée
 * se retire quand plus aucune branche ouverte n'en a besoin (le guide `docs/architecture/MODULES.md`).
 *
 * Lu par les tests, les scripts et la configuration — jamais par du code d'exécution.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface Demenagement {
  /** L'ancien spécificateur, tel qu'on l'écrivait (`@/lib/coffre/cle`). */
  ancien: string;
  /** L'ancien fichier, depuis la racine du dépôt, sans extension (`src/lib/coffre/cle`). */
  ancienChemin: string;
  /** Le nouveau fichier, depuis la racine du dépôt, sans extension (`src/modules/coffre/infra/cle`). */
  nouveauChemin: string;
}

/** Les adresses de réexpédition déclarées dans `tsconfig.json` (toutes les entrées exactes, sans `*`). */
export function demenagements(racine = process.cwd()): Demenagement[] {
  const tsconfig = JSON.parse(fs.readFileSync(path.join(racine, "tsconfig.json"), "utf8")) as {
    compilerOptions?: { paths?: Record<string, string[]> };
  };
  return Object.entries(tsconfig.compilerOptions?.paths ?? {})
    .filter(([cle]) => !cle.includes("*"))
    .map(([ancien, [cible]]) => ({
      ancien,
      ancienChemin: `src/${ancien.replace(/^@\//, "")}`,
      nouveauChemin: path.posix.normalize(cible!.replace(/^\.\//, "")),
    }));
}
