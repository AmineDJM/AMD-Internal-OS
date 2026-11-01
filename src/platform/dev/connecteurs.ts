import { creerAgentDeveloppeur } from "./agent-routines";
import { configGithub, configRender, type Env } from "./config";
import { creerForgeGithub } from "./forge-github";
import { creerHebergeurRender } from "./hebergeur-render";
import type { AgentDeveloppeur, ForgeGit, Hebergeur } from "./ports";

/**
 * LA RACINE DE COMPOSITION DES CONNECTEURS (lot C2) — ce que le moteur des chantiers (C1) appelle pour obtenir ses
 * trois ports. Un port dont le jeton manque est `null` : le moteur le dit (« GitHub non configuré ») au lieu d'échouer
 * plus loin. Les adaptateurs sont SANS état durable (le cache ETag vit le temps du processus).
 */
export interface ConnecteursDev {
  agent: AgentDeveloppeur;
  forge: ForgeGit | null;
  hebergeur: Hebergeur | null;
}

export function connecteursDev(opts: { env?: Env; fetch?: typeof fetch } = {}): ConnecteursDev {
  const env = opts.env ?? process.env;
  const forge = configGithub(env).jeton ? creerForgeGithub({ env, fetch: opts.fetch }) : null;
  const hebergeur = configRender(env).jeton ? creerHebergeurRender({ env, fetch: opts.fetch }) : null;
  return { agent: creerAgentDeveloppeur({ env, fetch: opts.fetch, forge }), forge, hebergeur };
}
