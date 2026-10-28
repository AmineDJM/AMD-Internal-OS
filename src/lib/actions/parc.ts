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
 * UNE CLÉ, PLUSIEURS FICHIERS — quand un fichier d'actions trop gros se découpe par responsabilité
 * (`ad-pro-item-actions`, 4 409 lignes, devenu `src/modules/ad-pro/actions-postes*.ts`), chaque
 * morceau garde la clé HISTORIQUE : on la déclare avec la LISTE de ses fichiers. Le contrat, la parité
 * et les traces ne voient aucune différence (`ad-pro-item-actions:emitItemExpenseOrder` reste la clé,
 * quel que soit le morceau qui la porte) ; l'aiguillage généré réunit les exports des morceaux.
 *
 * `contrat.test.ts` tient la règle : tout fichier d'actions d'un module est déclaré ici, toute
 * entrée d'ici existe sur le disque, une clé n'est portée par deux fichiers que s'ils sont déclarés
 * ENSEMBLE ici, et une même action n'est jamais exportée par deux morceaux.
 *
 * Lu par les tests et les scripts seulement (il lit le disque) — jamais par du code d'exécution.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/**
 * Les fichiers d'actions rangés dans un module : clé historique → chemin depuis la racine du dépôt,
 * ou la LISTE des chemins quand le fichier historique s'est découpé (chaque morceau garde la clé).
 */
export const ACTIONS_DES_MODULES: Readonly<Record<string, string | readonly string[]>> = {
  "ad-pro-centre-actions": "src/modules/ad-pro/actions-centre.ts",
  "ad-pro-conseil-actions": "src/modules/ad-pro/actions-conseil.ts",
  "ad-pro-discussion-actions": "src/modules/ad-pro/actions-discussion.ts",
  "ad-pro-edit-actions": "src/modules/ad-pro/actions-edition.ts",
  "ad-pro-item-actions": [
    "src/modules/ad-pro/actions-postes.ts", "src/modules/ad-pro/actions-postes-decision.ts", "src/modules/ad-pro/actions-postes-paiement.ts",
    "src/modules/ad-pro/actions-postes-materiel.ts", "src/modules/ad-pro/actions-postes-voyageurs.ts", "src/modules/ad-pro/actions-postes-lignes.ts",
  ],
  "ad-pro-medecins-actions": "src/modules/ad-pro/actions-medecins.ts",
  "ad-pro-other-actions": "src/modules/ad-pro/actions-autres.ts",
  "ad-pro-pieces-actions": "src/modules/ad-pro/actions-pieces.ts",
  "ad-pro-postes-luna-actions": "src/modules/ad-pro/actions-postes-luna.ts",
  "ad-pro-rattacher-legal": "src/modules/ad-pro/actions-rattacher-legal.ts",
  "ad-pro-transfer-actions": "src/modules/ad-pro/actions-transfert.ts",
  "care-actions": ["src/modules/ad-pro/actions-prise-en-charge.ts", "src/modules/ad-pro/actions-prise-en-charge-logistique.ts"],
  "coffre-actions": "src/modules/coffre/actions.ts",
  "congress-beneficiary-actions": "src/modules/ad-pro/actions-congres-beneficiaires.ts",
  "congress-request-actions": "src/modules/ad-pro/actions-congres.ts",
  "consommation-actions": "src/modules/consommation/actions.ts",
  "event-actions": "src/modules/ad-pro/actions-evenements.ts",
  "hr-actions": "src/modules/rh/actions.ts",
  "hr-document-actions": "src/modules/rh/actions-documents.ts",
  "payroll-hr-actions": "src/modules/rh/actions-paie.ts",
  "conge-discussion-actions": "src/modules/rh/actions-conges-discussion.ts",
  "stand-in-actions": "src/modules/rh/actions-interim.ts",
  "organisation-actions": "src/modules/referentiels/actions-organisations.ts",
  "personnes-actions": "src/modules/referentiels/actions-personnes.ts",
  "refonte-reprise-actions": "src/modules/referentiels/actions-reprises.ts",
  "sponsoring-actions": "src/modules/ad-pro/actions-sponsoring.ts",
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
  const ranges = Object.entries(ACTIONS_DES_MODULES).flatMap(([cle, chemins]) => cheminsDeLaCle(chemins).map((chemin) => ({
    cle, chemin, specificateur: `@/${chemin.replace(/^src\//, "").replace(/\.ts$/, "")}`,
  })));
  return [...communs, ...ranges].sort((a, b) => a.cle.localeCompare(b.cle));
}

/** Les chemins déclarés pour une clé : un seul fichier, ou les morceaux d'un fichier découpé. */
export function cheminsDeLaCle(chemins: string | readonly string[]): readonly string[] {
  return typeof chemins === "string" ? [chemins] : chemins;
}

/** Tous les fichiers d'actions déclarés dans les modules (les morceaux d'une clé découpée compris). */
export function cheminsDesActionsDesModules(): string[] {
  return Object.values(ACTIONS_DES_MODULES).flatMap((c) => [...cheminsDeLaCle(c)]);
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

/**
 * LE SOURCE D'UNE CLÉ — tous ses fichiers mis bout à bout (les morceaux d'un fichier découpé, dans l'ordre
 * déclaré). Pour les tests de structure qui lisaient le fichier d'avant : la règle vise la clé, pas l'adresse.
 */
export function sourceDeLaCle(cle: string, racine = process.cwd()): string {
  const chemins = parcDesActions(racine).filter((f) => f.cle === cle).map((f) => f.chemin);
  const declares = ACTIONS_DES_MODULES[cle];
  const ordre = declares ? [...cheminsDeLaCle(declares)] : chemins;
  if (chemins.length === 0) throw new Error(`sourceDeLaCle(« ${cle} ») : aucune clé de ce nom dans le parc.`);
  return ordre.map((c) => readFileSync(join(racine, c), "utf8")).join("\n");
}
