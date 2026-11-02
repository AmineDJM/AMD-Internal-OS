import { etatDuGeste, noterEffetExterne } from "./magasin";

/**
 * LE PORT RÉSEAU (J7, décision 0029) — le filet sous les ports nommés (courriel, notification poussée, site, stockage).
 *
 * Un webhook, l'API d'un fournisseur, un service qu'on branchera demain : ils sortent par `fetch`, sans passer par
 * un port qu'on aurait pensé à écrire. Pendant un geste :
 *   • en SIMULATION, toute requête qui ÉCRIT (autre que GET / HEAD) vers un hôte non local est NEUTRALISÉE — notée
 *     (« appel sortant vers hooks.exemple.dz »), jamais émise ; l'action reçoit une réponse 202 vide ;
 *   • en RÉEL journalisé, elle part, et elle est notée — l'annulation dira qu'elle ne se reprend pas. Les appels au
 *     fournisseur de modèles ne sont pas notés : ils ne changent rien chez personne.
 * Hors geste, `fetch` est celui de la plateforme, sans un test de plus que la lecture du magasin.
 */

const HOTES_LOCAUX = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const HOTES_MODELES = /(^|\.)(openai\.com|anthropic\.com|googleapis\.com|mistral\.ai|azure\.com)$/;

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
    const neutralise = noterEffetExterne({ acte: "RESEAU", cible: `${methode} ${url.host}${url.pathname}`.slice(0, 200), origine: "fetch" });
    if (neutralise) return new Response("{}", { status: 202, headers: { "content-type": "application/json", "x-amd-simulation": "1" } });
    return plateforme(input, init);
  }) as typeof fetch;
  globalThis.fetch = relais;
  g.__amdPortReseau = true;
}
