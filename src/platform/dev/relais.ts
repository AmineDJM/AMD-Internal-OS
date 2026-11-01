import { createHash, timingSafeEqual } from "node:crypto";

/**
 * LE RELAIS CLAUDE CODE (CLI) — la part PURE (lot C2, décision 0041 § 3 bis, Direction 01/11/2026 : « Claude Code Cloud
 * par Routines + CLI cloud »).
 *
 * La CLI `claude` connectée au compte claude.ai de la Direction (`claude auth login`) est la seule à pouvoir parler à
 * une session cloud EXISTANTE (`claude -p "…" --cloud <id>`). Les conditions d'Anthropic interdisent d'en mettre les
 * identifiants sur le serveur de l'ERP : la CLI tourne donc sur UNE MACHINE DE LA DIRECTION (`scripts/relais-claude.ts`),
 * qui TIRE les ordres de l'ERP en HTTPS avec son jeton de relais, les exécute, et rend le résultat. L'ERP ne voit jamais
 * un identifiant claude.ai ; le relais ne voit jamais un secret de l'ERP (seulement son propre jeton).
 *
 * Commandes (vérifiées le 01/11/2026 sur code.claude.com/docs/en/claude-code-on-the-web et /cli-reference) :
 *   CREER    `claude --cloud "<tâche>"` depuis une copie du dépôt sur la branche réservée, POUSSÉE (le VM clone la
 *            branche courante du dépôt GitHub, pas la copie locale). Sortie non documentée en JSON : le relais y lit
 *            l'identifiant `session_…` / `cse_…` ou l'URL claude.ai/code.
 *   MESSAGE  `claude -p --cloud <session-id> --output-format json`, texte sur l'entrée standard (documenté) → JSON
 *            `{ok, session_id, url}` ou `{ok:false, session_id, error}` ; erreurs de configuration sur stderr, sans JSON.
 *   ÉTAT     `claude auth status` → JSON (`authMethod` : none | claude.ai | oauth_token | api_key | …), code 0 si connecté.
 */

export type TypeOrdre = "CREER" | "MESSAGE";
export type StatutOrdre = "EN_ATTENTE" | "EN_COURS" | "FAIT" | "ECHEC" | "INCERTAIN";

/** Ce que le relais reçoit (jamais un secret). */
export interface OrdreRelais {
  id: string;
  type: TypeOrdre;
  depot: string | null;
  branche: string | null;
  sessionId: string | null;
  texte: string;
}

/** Ce que le relais rend : la sortie BRUTE de la commande (bornée). L'ERP l'interprète (`interpreter`) — le relais reste
 *  bête, et la lecture est testée ici. */
export interface SortieRelais {
  id: string;
  /** Code de sortie de `claude` ; `null` si le processus n'a pas fini (délai dépassé, tué). */
  code: number | null;
  stdout: string;
  stderr: string;
  delaiDepasse: boolean;
  /** Une étape git a échoué AVANT `claude` (rien n'a été lancé). */
  avantClaude?: string | null;
}

/** L'état que le relais déclare à chaque tirage (battement de cœur) : sorties brutes de `claude -v` et `claude auth status`. */
export interface EtatDeclare { version: string | null; authStatus: string | null; authCode: number | null }

/** Un ordre EN_COURS sans résultat depuis ce délai devient INCERTAIN (le relais est peut-être tombé en l'exécutant). */
export const DELAI_ORDRE_EN_COURS_MS = 20 * 60_000;
/** Un ordre jamais tiré expire (rien n'a été envoyé : ECHEC, re-lançable). */
export const DUREE_VIE_ORDRE_MS = 60 * 60_000;
/** Le relais est « vu » s'il a tiré depuis ce délai. */
export const RELAIS_VIVANT_MS = 2 * 60_000;

const empreinte = (s: string) => createHash("sha256").update(s, "utf8").digest();

/** Le jeton présenté par le relais est-il le bon ? Comparaison en temps constant des empreintes. Sans jeton : fermé. */
export function jetonRelaisValide(autorisation: string | null, attendu: string | null | undefined): boolean {
  if (!attendu || attendu.length < 24 || !autorisation?.startsWith("Bearer ")) return false;
  return timingSafeEqual(empreinte(autorisation.slice(7).trim()), empreinte(attendu));
}

const RE_SESSION = /\b((?:session|cse)_[A-Za-z0-9]{8,})\b/;
const RE_URL = /https:\/\/claude\.ai\/code\/((?:session|cse)_[A-Za-z0-9]{8,})[^\s]*/;

/** La sortie TEXTE de `claude --cloud "<tâche>"` (non documentée en JSON) → identifiant et lien de la session. */
export function lireSortieCreation(sortie: string): { sessionId: string | null; url: string | null } {
  const u = sortie.match(RE_URL);
  const id = u?.[1] ?? sortie.match(RE_SESSION)?.[1] ?? null;
  return { sessionId: id, url: id ? `https://claude.ai/code/${id}` : null };
}

/** La sortie JSON documentée de `claude -p --cloud <id> --output-format json`. `null` si ce n'est pas ce JSON. */
export function lireSortieMessage(sortie: string): { ok: boolean; sessionId: string | null; url: string | null; erreur: string | null } | null {
  const ligne = sortie.trim().split("\n").reverse().find((l) => l.trim().startsWith("{"));
  if (!ligne) return null;
  try {
    const j = JSON.parse(ligne) as { ok?: unknown; session_id?: unknown; url?: unknown; error?: unknown };
    if (typeof j.ok !== "boolean") return null;
    return { ok: j.ok, sessionId: typeof j.session_id === "string" ? j.session_id : null, url: typeof j.url === "string" ? j.url : null, erreur: typeof j.error === "string" ? j.error : null };
  } catch {
    return null;
  }
}

/** Le JSON documenté de `claude auth status` → méthode et connexion. Hors forme : rien d'inventé. */
export function lireAuthStatus(sortie: string | null, code: number | null): { authMethod: string | null; connecte: boolean | null } {
  if (sortie === null) return { authMethod: null, connecte: null };
  try {
    const j = JSON.parse(sortie) as { authMethod?: unknown };
    const authMethod = typeof j.authMethod === "string" ? j.authMethod : null;
    return { authMethod, connecte: code === null ? null : code === 0 && authMethod === "claude.ai" };
  } catch {
    return { authMethod: null, connecte: code === null ? null : code === 0 };
  }
}

export interface Interpretation { statut: Exclude<StatutOrdre, "EN_ATTENTE" | "EN_COURS">; sessionId: string | null; url: string | null; erreur: string | null }

const extrait = (t: string) => t.trim().split("\n").filter(Boolean).slice(-3).join(" ").slice(0, 400);

/**
 * La sortie brute d'un ordre → son issue. Prudence d'abord : un délai dépassé est INCERTAIN (une session a pu naître, un
 * message a pu partir) ; une création qui sort 0 sans identifiant lisible aussi ; une erreur git AVANT `claude` est un
 * ECHEC sans effet (re-lançable).
 */
export function interpreter(type: TypeOrdre, s: SortieRelais): Interpretation {
  if (s.avantClaude) return { statut: "ECHEC", sessionId: null, url: null, erreur: `préparation du dépôt : ${s.avantClaude.slice(0, 300)}` };
  if (s.delaiDepasse || s.code === null) return { statut: "INCERTAIN", sessionId: null, url: null, erreur: "délai dépassé : la commande a pu agir — vérifier sur claude.ai/code" };
  if (type === "MESSAGE") {
    const j = lireSortieMessage(s.stdout);
    if (j) return { statut: j.ok ? "FAIT" : "ECHEC", sessionId: j.sessionId, url: j.url, erreur: j.ok ? null : j.erreur ?? "envoi refusé" };
    return { statut: "ECHEC", sessionId: null, url: null, erreur: extrait(s.stderr) || `claude a rendu ${s.code} sans JSON` };
  }
  const c = lireSortieCreation(`${s.stdout}\n${s.stderr}`);
  if (s.code === 0 && c.sessionId) return { statut: "FAIT", ...c, erreur: null };
  if (s.code === 0) return { statut: "INCERTAIN", sessionId: null, url: null, erreur: "claude --cloud a réussi sans identifiant lisible : vérifier sur claude.ai/code" };
  return { statut: c.sessionId ? "INCERTAIN" : "ECHEC", ...c, erreur: extrait(s.stderr) || extrait(s.stdout) || `claude a rendu ${s.code}` };
}
