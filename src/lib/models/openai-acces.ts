/**
 * L'ACCÈS À OPENAI — la clé et l'adresse, lues à UN seul endroit.
 *
 * `OPENAI_BASE_URL` était relue dans cinq fichiers, sous DEUX conventions : la passerelle de
 * modèles, Luna et l'API Responses l'attendaient SANS `/v1` (elles ajoutaient `/v1/chat/…`), la
 * transcription l'attendait AVEC (`…/v1` puis `/audio/…`). Une même valeur posée dans Render
 * cassait donc l'un ou l'autre côté (`/v1/v1/…`, ou `/audio/…` sans version). Ici, les deux
 * graphies sont acceptées : la racine perd sa barre finale et son `/v1` éventuel, et le chemin
 * demandé est toujours servi sous `/v1`.
 *
 * Module PUR, sans import : il ne lit que l'environnement qu'on lui passe.
 */

const RACINE_PAR_DEFAUT = "https://api.openai.com";

/** La clé OpenAI, sans espaces parasites — `""` si elle n'est pas posée. */
export function cleOpenAI(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return (env.OPENAI_API_KEY ?? "").trim();
}

/** L'URL d'un point de l'API OpenAI : `urlOpenAI("/chat/completions")` → `https://api.openai.com/v1/chat/completions`. */
export function urlOpenAI(chemin: `/${string}`, env: Readonly<Record<string, string | undefined>> = process.env): string {
  const racine = (env.OPENAI_BASE_URL?.trim() || RACINE_PAR_DEFAUT).replace(/\/+$/, "").replace(/\/v1$/, "");
  return `${racine}/v1${chemin}`;
}
