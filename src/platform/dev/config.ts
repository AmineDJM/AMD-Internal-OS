import type { NomDepot } from "./ports";

/**
 * LA CONFIGURATION DES CONNECTEURS (lot C2) — lue côté SERVEUR seulement, jamais par un modèle, jamais journalisée.
 *
 *   GitHub   GITHUB_TOKEN (fine-grained de la Direction : contents, pull-requests, checks, actions, metadata ; un compte
 *            HUMAIN — un commentaire `@claude` posté par un bot est refusé par l'Action), GITHUB_WEBHOOK_SECRET,
 *            CHANTIERS_DEPOTS (« proprietaire/nom » séparés par des virgules : les dépôts que les chantiers touchent),
 *            GITHUB_API_URL (défaut https://api.github.com), CHANTIERS_METHODE_FUSION (merge | squash | rebase — sinon
 *            celle que le dépôt autorise, merge d'abord ; C1, décision 0042).
 *   Render   RENDER_API_KEY, RENDER_WEBHOOK_SECRET (le « signing secret » du webhook), RENDER_API_URL
 *            (défaut https://api.render.com/v1).
 *   Claude   une routine PAR DÉPÔT, créée par la Direction sur claude.ai/code/routines : CLAUDE_ROUTINE_<ALIAS>_ID
 *            (`trig_…`), CLAUDE_ROUTINE_<ALIAS>_TOKEN (`sk-ant-oat01-…`, affiché une fois), CLAUDE_ROUTINE_<ALIAS>_DEPOT.
 *            ANTHROPIC_ROUTINES_URL (défaut https://api.anthropic.com) ne sert qu'aux bancs.
 *   MiMo     `mimo` (déjà posée sur Render ; MIMO_API_KEY accepté), MIMO_BASE_URL (défaut l'ancien point de l'ERP).
 *   Relais   CLAUDE_RELAIS_TOKEN : le jeton que le relais CLI (machine de la Direction) présente pour tirer ses ordres.
 *
 * Aucun identifiant claude.ai d'abonnement (OAuth, `claude setup-token`) n'est lu ici : les conditions d'Anthropic
 * l'interdisent côté serveur (décision 0043). Le jeton d'une routine n'est pas un identifiant de compte : il ne fait
 * que déclencher CETTE routine.
 */

export type Env = Record<string, string | undefined>;

const lire = (env: Env, nom: string): string | null => {
  const v = (env[nom] ?? "").trim();
  return v ? v : null;
};

export const BASE_GITHUB = "https://api.github.com";
export const BASE_RENDER = "https://api.render.com/v1";
export const BASE_ROUTINES = "https://api.anthropic.com";
export const BASE_MIMO = "https://token-plan-ams.xiaomimimo.com/v1";

export interface ConfigGithub { jeton: string | null; base: string; secretWebhook: string | null; depots: NomDepot[] }
export interface ConfigRender { jeton: string | null; base: string; secretWebhook: string | null }
export interface ConfigRoutine { alias: string; id: string | null; jeton: string | null; depot: NomDepot | null }
export interface ConfigMimo { cle: string | null; base: string }

const estDepot = (s: string): s is NomDepot => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s);

export function configGithub(env: Env = process.env): ConfigGithub {
  return {
    jeton: lire(env, "GITHUB_TOKEN"),
    base: lire(env, "GITHUB_API_URL") ?? BASE_GITHUB,
    secretWebhook: lire(env, "GITHUB_WEBHOOK_SECRET"),
    depots: (lire(env, "CHANTIERS_DEPOTS") ?? "").split(",").map((s) => s.trim()).filter(estDepot),
  };
}

export function configRender(env: Env = process.env): ConfigRender {
  return { jeton: lire(env, "RENDER_API_KEY"), base: lire(env, "RENDER_API_URL") ?? BASE_RENDER, secretWebhook: lire(env, "RENDER_WEBHOOK_SECRET") };
}

export function configMimo(env: Env = process.env): ConfigMimo {
  return { cle: lire(env, "mimo") ?? lire(env, "MIMO_API_KEY"), base: (lire(env, "MIMO_BASE_URL") ?? BASE_MIMO).replace(/\/+$/, "") };
}

export const baseRoutines = (env: Env = process.env): string => lire(env, "ANTHROPIC_ROUTINES_URL") ?? BASE_ROUTINES;

const RE_ROUTINE = /^CLAUDE_ROUTINE_([A-Z0-9_]+?)_(ID|TOKEN|DEPOT)$/;

/** Les alias de routine présents dans l'environnement (un seul des trois noms suffit à les faire voir — incomplets). */
export function aliasDeRoutines(env: Env = process.env): string[] {
  const alias = new Set<string>();
  for (const k of Object.keys(env)) {
    const m = k.match(RE_ROUTINE);
    if (m && (env[k] ?? "").trim()) alias.add(m[1]!);
  }
  return [...alias].sort();
}

export function configRoutine(alias: string, env: Env = process.env): ConfigRoutine {
  const a = alias.trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  const depot = lire(env, `CLAUDE_ROUTINE_${a}_DEPOT`);
  return { alias: a, id: lire(env, `CLAUDE_ROUTINE_${a}_ID`), jeton: lire(env, `CLAUDE_ROUTINE_${a}_TOKEN`), depot: depot && estDepot(depot) ? depot : null };
}

/** La routine d'un dépôt (celle dont `_DEPOT` le nomme). */
export function routineDuDepot(depot: string, env: Env = process.env): ConfigRoutine | null {
  for (const a of aliasDeRoutines(env)) {
    const r = configRoutine(a, env);
    if (r.depot && r.depot.toLowerCase() === depot.toLowerCase()) return r;
  }
  return null;
}

/** Le jeton du relais CLI (`scripts/relais-claude.ts`) — le relais le présente en `Bearer` ; ≥ 24 caractères. */
export const jetonRelais = (env: Env = process.env): string | null => lire(env, "CLAUDE_RELAIS_TOKEN");

/** C1 (décision 0042) : la méthode de fusion imposée par la Direction, si elle l'a posée — sinon celle du dépôt. */
export function methodeFusionImposee(env: Env = process.env): "merge" | "squash" | "rebase" | null {
  const m = lire(env, "CHANTIERS_METHODE_FUSION")?.toLowerCase();
  return m === "merge" || m === "squash" || m === "rebase" ? m : null;
}
