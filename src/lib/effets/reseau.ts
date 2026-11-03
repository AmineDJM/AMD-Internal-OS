import { etatDuGeste, noterEffetExterne } from "./magasin";

/**
 * LE PORT RÉSEAU (J7, décision 0029) — le filet sous les ports nommés (courriel, notification poussée, site, stockage).
 *
 * Un webhook, l'API d'un fournisseur, un service qu'on branchera demain : ils sortent par `fetch`, sans passer par
 * un port qu'on aurait pensé à écrire. Pendant un geste :
 *   • en SIMULATION, toute requête qui ÉCRIT (autre que GET / HEAD) vers un hôte non local est NEUTRALISÉE — notée
 *     (« appel sortant vers hooks.exemple.dz »), jamais émise ; l'action reçoit une réponse 202 vide ;
 *   • en RÉEL journalisé, elle part, et elle est notée — l'annulation dira qu'elle ne se reprend pas. Les appels au
 *     fournisseur de modèles ne sont pas notés : ils ne changent rien chez personne ;
 *   • à l'ESSAI d'un agent (une simulation dont le modèle doit répondre), l'appel au fournisseur de modèles part, et lui seul.
 * Hors geste, `fetch` est celui de la plateforme, sans un test de plus que la lecture du magasin.
 */

const HOTES_LOCAUX = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const HOTES_MODELES = /(^|\.)(openai\.com|anthropic\.com|googleapis\.com|mistral\.ai|azure\.com)$/;

/** L'hôte d'une URL de base configurée (passerelle, fournisseur auto-hébergé) — vide si absente ou illisible. */
const hoteDe = (url: string | undefined): string => {
  try { return url?.trim() ? new URL(url.trim()).hostname : ""; } catch { return ""; }
};

/**
 * UN FOURNISSEUR DE MODÈLES : les domaines connus, ou l'hôte d'une URL de base réglée (`OPENAI_BASE_URL`,
 * `ANTHROPIC_BASE_URL`, `MIMO_BASE_URL`) — la passerelle par laquelle les modèles de l'ERP passent réellement.
 */
export function estHoteDeModele(hote: string): boolean {
  if (HOTES_MODELES.test(hote) || /(^|\.)xiaomimimo\.com$/.test(hote)) return true;
  const e = process.env;
  return [e.OPENAI_BASE_URL, e.ANTHROPIC_BASE_URL, e.MIMO_BASE_URL].map(hoteDe).some((h) => h && h === hote);
}

function lireRequete(input: unknown, init?: { method?: string }): { methode: string; url: URL | null } {
  const brut = typeof input === "string" ? input : input instanceof URL ? input.href : (input as { url?: string })?.url ?? "";
  const methode = (init?.method ?? (input as { method?: string })?.method ?? "GET").toUpperCase();
  try {
    return { methode, url: new URL(brut) };
  } catch {
    return { methode, url: null };
  }
}

const g = globalThis as { __amdPortReseau?: true };

export function installerPortReseau(): void {
  if (g.__amdPortReseau || typeof globalThis.fetch !== "function") return;
  const plateforme = globalThis.fetch.bind(globalThis);
  const relais = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const etat = etatDuGeste();
    if (!etat) return plateforme(input, init);
    const { methode, url } = lireRequete(input, init);
    if (methode === "GET" || methode === "HEAD" || !url || HOTES_LOCAUX.has(url.hostname)) return plateforme(input, init);
    if (etat.mode === "REEL" && HOTES_MODELES.test(url.hostname)) return plateforme(input, init);
    // L'ESSAI D'UN AGENT : le modèle répond (sinon il n'y a rien à juger) — il ne change rien chez personne. Tout autre
    // appel qui écrit reste neutralisé, comme en simulation.
    if (etat.mode === "SIMULATION" && etat.essai && estHoteDeModele(url.hostname)) return plateforme(input, init);
    const neutralise = noterEffetExterne({ acte: "RESEAU", cible: `${methode} ${url.host}${url.pathname}`.slice(0, 200), origine: "fetch" });
    if (neutralise) return new Response("{}", { status: 202, headers: { "content-type": "application/json", "x-amd-simulation": "1" } });
    return plateforme(input, init);
  }) as typeof fetch;
  globalThis.fetch = relais;
  g.__amdPortReseau = true;
}
