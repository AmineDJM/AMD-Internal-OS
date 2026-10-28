/**
 * LA CONFIGURATION GOOGLE D'ADAM — ce que le serveur doit connaître, et rien de plus.
 *
 * Aucune valeur ne porte de préfixe `NEXT_PUBLIC_` : le secret d'application ne doit jamais
 * atteindre un navigateur, et un nom public rendrait cette faute possible sans que personne
 * ne la remarque (même règle que la messagerie Microsoft, `lib/mail/config.ts`).
 *
 * Module PUR — il reçoit l'environnement en argument, donc il se teste sans variables réelles.
 */

export type Env = Record<string, string | undefined>;

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** L'adresse d'Adam attendue : une AUTRE boîte connectée par erreur doit être refusée. */
  adamEmail: string | null;
  /** Sujet Pub/Sub pour le push Gmail (`projects/<id>/topics/<topic>`), si configuré. */
  pubsubTopic: string | null;
  /** Adresse de service autorisée à pousser (vérification du jeton Pub/Sub). */
  pubsubAudience: string | null;
}

/**
 * LES DROITS DEMANDÉS — le moindre privilège COMPATIBLE avec ce qu'Adam doit faire.
 *
 * • `gmail.modify` plutôt que `mail.google.com` : tout lire et tout écrire — brouillons, envoi,
 *   étiquettes, corbeille — SAUF la suppression définitive, qui contourne la corbeille. Adam n'a
 *   aucune raison de détruire un message sans retour possible, et ne pas demander ce droit est la
 *   seule façon de garantir qu'un défaut ne le fera jamais.
 * • `calendar` : lire ET écrire les événements (créer, décaler, inviter) — le lire seul rendrait
 *   la moitié des demandes du PDG impossibles.
 * • `drive` : chercher et lire des fichiers que l'application n'a PAS créés (`drive.file` ne voit
 *   que les siens), les déposer, les partager. C'est le prix d'un vrai Drive ; il est demandé
 *   explicitement, pas par confort.
 * • `documents` / `spreadsheets` / `presentations` : créer et modifier les fichiers bureautiques
 *   Google produits par le Chief.
 * • `contacts.readonly` : résoudre « Deepak » vers une adresse. Adam n'écrit pas le carnet
 *   d'adresses de quelqu'un d'autre — la lecture suffit à relier les personnes.
 *
 * Aucun droit d'administration de domaine : l'identité d'Adam est une boîte personnelle, pas un
 * annuaire d'entreprise.
 */
export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/presentations",
  "https://www.googleapis.com/auth/contacts.readonly",
] as const;

export const GOOGLE_SCOPE_STRING = GOOGLE_SCOPES.join(" ");

/** Ce que chaque droit sert — affiché à l'écran de connexion : un consentement se comprend. */
export const SCOPE_PURPOSE: Record<string, string> = {
  openid: "Établir l'identité du compte connecté",
  email: "Connaître l'adresse du compte connecté (c'est elle qui vérifie que c'est bien Adam)",
  profile: "Connaître le nom affiché du compte connecté",
  "https://www.googleapis.com/auth/gmail.modify": "Lire, classer, préparer et envoyer les messages (jamais de suppression définitive)",
  "https://www.googleapis.com/auth/calendar": "Lire l'agenda, proposer des créneaux, créer et décaler des réunions",
  "https://www.googleapis.com/auth/drive": "Chercher, lire, déposer et partager des fichiers",
  "https://www.googleapis.com/auth/documents": "Créer et modifier des documents Google",
  "https://www.googleapis.com/auth/spreadsheets": "Créer et modifier des feuilles de calcul",
  "https://www.googleapis.com/auth/presentations": "Créer et modifier des présentations",
  "https://www.googleapis.com/auth/contacts.readonly": "Relier une personne à son adresse (lecture seule)",
};

const REQUIRED = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI"];

export function resolveGoogleConfig(env: Env): GoogleConfig | null {
  const clientId = env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  const redirectUri = env.GOOGLE_REDIRECT_URI?.trim();
  if (!clientId || !clientSecret || !redirectUri) return null;
  return {
    clientId,
    clientSecret,
    redirectUri: redirectUri.replace(/\/+$/, ""),
    adamEmail: env.GOOGLE_ADAM_EMAIL?.trim().toLowerCase() || null,
    pubsubTopic: env.GOOGLE_PUBSUB_TOPIC?.trim() || null,
    pubsubAudience: env.GOOGLE_PUBSUB_AUDIENCE?.trim() || null,
  };
}

/** Ce qui manque, NOMMÉ — « non configuré » envoie relire un panneau où tout paraît rempli. */
export function missingGoogleVars(env: Env): string[] {
  return REQUIRED.filter((k) => !env[k]?.trim());
}

/**
 * L'adresse connectée est-elle celle d'Adam ?
 *
 * Sans ce contrôle, un consentement donné par erreur depuis un autre compte Google brancherait
 * silencieusement UNE AUTRE boîte sur le Chief : Adam lirait les messages de quelqu'un d'autre et,
 * pire, écrirait en son nom. Quand `GOOGLE_ADAM_EMAIL` n'est pas renseigné, on n'invente pas de
 * règle — la première boîte connectée fait foi, et l'écran le dit.
 */
export function isExpectedAccount(cfg: GoogleConfig, address: string): boolean {
  if (!cfg.adamEmail) return true;
  return address.trim().toLowerCase() === cfg.adamEmail;
}

export const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
export const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1";
export const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3";
export const DRIVE_BASE = "https://www.googleapis.com/drive/v3";
export const DRIVE_UPLOAD_BASE = "https://www.googleapis.com/upload/drive/v3";
export const DOCS_BASE = "https://docs.googleapis.com/v1";
export const SHEETS_BASE = "https://sheets.googleapis.com/v4";
export const SLIDES_BASE = "https://slides.googleapis.com/v1";
export const PEOPLE_BASE = "https://people.googleapis.com/v1";
