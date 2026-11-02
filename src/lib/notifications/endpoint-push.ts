/**
 * L'ADRESSE D'UN ABONNEMENT PUSH vient du navigateur — donc de qui veut. Le serveur y POSTe ensuite à
 * chaque notification (`webpush.sendNotification`) : une adresse libre en faisait un relais vers le réseau
 * interne (`http://localhost:…`, `http://169.254.169.254/…`), déclenchable en s'envoyant un message
 * (audit du 27/10/2026, RH-DOCUMENTS-COMMS).
 *
 * On n'accepte donc que les services push des navigateurs, en HTTPS, sur le port par défaut. Module pur
 * (aucun import) : la route d'abonnement le lit à l'entrée, `sendPushToUser` le relit à l'envoi pour les
 * abonnements enregistrés avant la règle.
 */

/** Hôtes des services push des navigateurs (Chrome/Edge/Opera, Firefox, Safari, Windows). */
const HOTES_EXACTS = new Set(["fcm.googleapis.com", "android.googleapis.com", "web.push.apple.com"]);
const SUFFIXES = [".push.services.mozilla.com", ".notify.windows.com", ".push.apple.com"];

/** Longueur maximale raisonnable d'une adresse d'abonnement (celles des navigateurs font < 600 caractères). */
export const LONGUEUR_MAX_ENDPOINT = 2048;

export function endpointPushAutorise(endpoint: unknown): endpoint is string {
  if (typeof endpoint !== "string" || endpoint.length === 0 || endpoint.length > LONGUEUR_MAX_ENDPOINT) return false;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.port !== "" || url.username || url.password) return false;
  const hote = url.hostname.toLowerCase();
  return HOTES_EXACTS.has(hote) || SUFFIXES.some((s) => hote.endsWith(s));
}
