import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE PARC DES ACTIONS SERVEUR — OÙ VIT CHAQUE FICHIER D'ACTIONS, ET SOUS QUELLE CLÉ.
 *
 * La clé d'une action est `"<fichier>:<fonction>"` (`"coffre-actions:basculerCoffre"`). Elle est
 * écrite dans le registre de parité d'Adam (`assistant/action-registry.ts`), dans le contrat généré
 * (`contrat.genere.json`), dans l'aiguillage (`aiguillage.genere.ts`) et dans les traces d'audit.
 * Elle était aussi, jusqu'ici, un CHEMIN : seul `src/lib/actions/` était lu, si bien que ranger une
 * action dans son module (`src/modules/<m>/actions.ts`) la faisait disparaître du contrat, de la
 * parité et d'Adam — rapport d'audit 08, ARCH-03, « le premier verrou de la migration ».
 *
 * La clé est désormais un NOM, déclaré ici, indépendant du chemin :
 *   - un fichier de `src/lib/actions/` garde sa clé implicite (son nom sans `.ts`) ;
 *   - un fichier rangé dans un module (`actions.ts`, ou `actions-<cas>.ts` s'il en a plusieurs) est
 *     déclaré dans `ACTIONS_DES_MODULES` avec sa clé
 *     HISTORIQUE — déménager une action ne change donc aucune clé, aucune ligne du registre de
 *     parité, aucune trace d'audit : seul l'aiguillage généré pointe le nouveau chemin.
 *
 * `contrat.test.ts` tient la règle : tout fichier d'actions d'un module est déclaré ici, toute
 * entrée d'ici existe sur le disque, et aucune clé n'est portée par deux fichiers.
 *
 * Lu par les tests et les scripts seulement (il lit le disque) — jamais par du code d'exécution.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Les fichiers d'actions rangés dans un module : clé historique → chemin depuis la racine du dépôt. */
export const ACTIONS_DES_MODULES: Readonly<Record<string, string>> = {
  "actualisation-soldes-actions": "src/modules/finances/actions-soldes.ts",
  "coffre-actions": "src/modules/coffre/actions.ts",
  "consommation-actions": "src/modules/consommation/actions.ts",
  "expense-actions": "src/modules/finances/actions-depenses.ts",
  "finance-actions": "src/modules/finances/actions-tresorerie.ts",
  "organisation-actions": "src/modules/referentiels/actions-organisations.ts",
  "payment-centre-actions": "src/modules/finances/actions-centre.ts",
  "payment-centre-seat-actions": "src/modules/finances/actions-sieges.ts",
  "payment-request-actions": "src/modules/finances/actions-demandes.ts",
  "personnes-actions": "src/modules/referentiels/actions-personnes.ts",
  "refonte-reprise-actions": "src/modules/referentiels/actions-reprises.ts",
  "relance-paiement-actions": "src/modules/finances/actions-relances.ts",
};

/** Ce qui vit dans `src/lib/actions/` sans être un fichier d'actions : le contrat lui-même, les types. */
export const HORS_PARC: ReadonlySet<string> = new Set([
  "types.ts", "contrat.ts", "contrat-scan.ts", "contrat.genere.ts",
  "generique.ts", "executer.ts", "aiguillage.genere.ts", "parc.ts",
]);

export interface FichierDActions {
  /** La clé du fichier dans le contrat et le registre de parité (`"coffre-actions"`). */
  cle: string;
  /** Son chemin depuis la racine du dépôt (`"src/modules/coffre/actions.ts"`). */
  chemin: string;
  /** Le spécificateur qui l'importe depuis `src/lib/actions/` (aiguillage généré). */
  specificateur: string;
}

/** Tous les fichiers d'actions de l'ERP — ceux de `src/lib/actions/` et ceux des modules — triés par clé. */
export function parcDesActions(racine = process.cwd()): FichierDActions[] {
  const dossier = join(racine, "src", "lib", "actions");
  const communs = readdirSync(dossier)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !HORS_PARC.has(f))
    .map((f) => ({ cle: f.replace(/\.ts$/, ""), chemin: `src/lib/actions/${f}`, specificateur: `./${f.replace(/\.ts$/, "")}` }));
  const ranges = Object.entries(ACTIONS_DES_MODULES).map(([cle, chemin]) => ({
    cle, chemin, specificateur: `@/${chemin.replace(/^src\//, "").replace(/\.ts$/, "")}`,
  }));
  return [...communs, ...ranges].sort((a, b) => a.cle.localeCompare(b.cle));
}

/**
 * Les fichiers d'actions présents à la racine des modules (`actions.ts`, ou `actions-<cas>.ts` quand un module
 * en a plusieurs — chacun garde sa clé) : chacun DOIT être déclaré dans `ACTIONS_DES_MODULES`.
 */
export function actionsDesModulesSurLeDisque(racine = process.cwd()): string[] {
  const modules = join(racine, "src", "modules");
  if (!existsSync(modules)) return [];
  return readdirSync(modules, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .flatMap((e) => readdirSync(join(modules, e.name))
      .filter((f) => /^actions(-[a-z-]+)?\.ts$/.test(f))
      .map((f) => `src/modules/${e.name}/${f}`))
    .sort();
}

/** Les clés `"<fichier>:<fonction>"` de toutes les actions exportées du parc. */
export function clesDesActions(racine = process.cwd()): Set<string> {
  const cles = new Set<string>();
  for (const f of parcDesActions(racine)) {
    for (const m of readFileSync(join(racine, f.chemin), "utf8").matchAll(/^export async function ([A-Za-z0-9_]+)/gm)) {
      cles.add(`${f.cle}:${m[1]}`);
    }
  }
  return cles;
}
