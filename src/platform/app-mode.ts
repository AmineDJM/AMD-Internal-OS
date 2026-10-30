/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE MODE D'APPLICATION — un même dépôt, un même build, deux sites (décision 0027, point 10).
 *
 * Le service Render `adventum-ia` tourne avec `APP_MODE=adventum-ia` : la racine ouvre l'app Adventum IA (`/ia`), un
 * lien de l'Assistant de l'ERP (`/assistant?c=…`, notifications) ouvre la même conversation dans l'app, et toute
 * autre route de l'ERP est renvoyée vers l'ERP (`ERP_URL`) — ou refusée (404) si l'adresse de l'ERP n'est pas posée,
 * et toujours refusée pour une API qui n'est pas celle de l'app. Sans `APP_MODE`, rien ne change : c'est l'ERP.
 *
 * PUR et sans import : lu par le middleware (runtime edge) et par ses tests.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const MODE_ADVENTUM_IA = "adventum-ia";

export type DecisionMode =
  | { type: "suivre" }
  | { type: "rediriger"; vers: string }
  | { type: "refuser" };

/** Ce que l'app sert elle-même : ses pages, la connexion, et les API dont ses écrans ont besoin. */
const PERMIS = [
  "/ia", "/login", "/change-password", "/adventum-ia/", "/ia-sw.js", "/_next/", "/favicon.ico", "/office-embed",
  "/api/assistant-ia/", "/api/auth/", "/api/drive/", "/api/documents/", "/api/artifact/", "/api/push/", "/api/health",
  "/api/onlyoffice/", "/api/rh/document/",
];

/** Les pages d'atterrissage de l'ERP (après connexion) : dans l'app, c'est l'app. */
const ATTERRISSAGES = new Set(["/", "/mon-espace", "/aujourdhui", "/assistant/beta"]);

const permis = (chemin: string): boolean =>
  PERMIS.some((p) => (p.endsWith("/") ? chemin.startsWith(p) || chemin === p.slice(0, -1) : chemin === p || chemin.startsWith(`${p}/`) || chemin.startsWith(`${p}?`)));

export function decisionMode(mode: string | undefined | null, chemin: string, recherche: string, erpUrl?: string | null): DecisionMode {
  if (mode !== MODE_ADVENTUM_IA) return { type: "suivre" };
  if (chemin === "/assistant" || chemin === "/assistant/") return { type: "rediriger", vers: `/ia${recherche}` };
  if (ATTERRISSAGES.has(chemin)) return { type: "rediriger", vers: "/ia" };
  if (permis(chemin)) return { type: "suivre" };
  if (chemin.startsWith("/api/")) return { type: "refuser" };
  const erp = (erpUrl ?? "").trim().replace(/\/+$/, "");
  return /^https?:\/\//.test(erp) ? { type: "rediriger", vers: `${erp}${chemin}${recherche}` } : { type: "refuser" };
}

/** La page d'après connexion : l'app en mode Adventum IA, « Mon espace » sinon. */
export const pageApresConnexion = (mode: string | undefined | null): string => (mode === MODE_ADVENTUM_IA ? "/ia" : "/mon-espace");
