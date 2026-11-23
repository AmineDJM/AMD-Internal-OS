import { ALGIERS_TZ, utcToAlgiersInput } from "@/lib/calendar-tz";

/**
 * LE LIEN GOOGLE MEET EN UN CLIC — les règles PURES (aucune base, aucun réseau).
 *
 * Un lien Meet ne s'invente pas : il naît d'un ÉVÉNEMENT de l'agenda Google du compte de
 * l'entreprise (celui d'Adam), créé avec une demande de visioconférence (`conferenceData.createRequest`,
 * type `hangoutsMeet`). Ce module dit trois choses, et seulement elles :
 *   • le CRÉNEAU envoyé à Google, lu dans le formulaire tel que la personne l'a rempli ;
 *   • le LIEN relu dans la réponse — et seulement s'il pointe vraiment sur `meet.google.com` ;
 *   • la PHRASE à montrer quand ce n'est pas possible : ce qu'il faut connecter, et où.
 *
 * Il est lu par le serveur (`meet.ts`, `meet-entreprise.ts`) et ses TYPES par le champ client
 * (`components/google/champ-lien-meet.tsx`) : il n'importe rien de lourd, il peut voyager.
 */

/** Ce que l'écran envoie : le titre et les dates du formulaire, tels quels. */
export interface DemandeLienMeet {
  titre: string;
  /** `YYYY-MM-DD` (journée) ou `YYYY-MM-DDTHH:mm` (heure d'Alger, champ `datetime-local`). Vide : maintenant. */
  debut?: string | null;
  fin?: string | null;
  journeeEntiere?: boolean;
}

export type MomentGoogle = { dateTime: string; timeZone: string } | { date: string };
export interface CreneauGoogle { start: MomentGoogle; end: MomentGoogle }

const JOUR = /^\d{4}-\d{2}-\d{2}$/;
const JOUR_HEURE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/;
/** Au-delà, ce n'est plus une réunion : une saisie erronée ne doit pas poser un mois dans l'agenda d'Adam. */
const JOURS_MAX = 31;
const TITRE_MAX = 200;

function decalerJour(ymd: string, jours: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + jours)).toISOString().slice(0, 10);
}

/** `YYYY-MM-DDTHH:mm` décalé de `minutes` — arithmétique « murale », sans fuseau (Alger n'a pas d'heure d'été). */
function decalerMinutes(local: string, minutes: number): string {
  const m = local.match(JOUR_HEURE);
  if (!m) return local;
  const [, y, mo, d, h, mi] = m.map(Number);
  return new Date(Date.UTC(y, mo - 1, d, h, mi + minutes)).toISOString().slice(0, 16);
}

const jourDe = (v: string): string | null => (JOUR.test(v) ? v : JOUR_HEURE.test(v) ? v.slice(0, 10) : null);

/** La prochaine demi-heure pleine, à l'heure d'Alger — « maintenant » quand le formulaire n'a pas encore de date. */
export function prochaineDemiHeure(maintenant: Date): string {
  const local = utcToAlgiersInput(maintenant);
  const minutes = Number(local.slice(14, 16));
  const pas = minutes === 0 || minutes === 30 ? 0 : minutes < 30 ? 30 - minutes : 60 - minutes;
  return decalerMinutes(local, pas);
}

/**
 * LE CRÉNEAU DE L'ÉVÉNEMENT GOOGLE.
 *
 * • Une date seule, ou « journée entière » : un événement sur des JOURS (fin exclusive chez Google,
 *   d'où le jour suivant) — un congrès de trois jours en occupe trois.
 * • Une date et une heure : l'heure murale d'Alger, avec le fuseau NOMMÉ (jamais une date flottante,
 *   même règle que `provider.ts`). Sans fin, ou une fin avant le début : une heure.
 * • Rien : la prochaine demi-heure, pour une heure. Le lien Meet, lui, reste valable à toute heure.
 */
export function creneauGoogle(d: DemandeLienMeet, maintenant: Date): CreneauGoogle {
  const debut = (d.debut ?? "").trim();
  const fin = (d.fin ?? "").trim();
  const jourDebut = jourDe(debut);

  if (jourDebut && (d.journeeEntiere || JOUR.test(debut))) {
    const jourFin = jourDe(fin);
    const plafond = decalerJour(jourDebut, JOURS_MAX - 1);
    const dernier = jourFin && jourFin >= jourDebut ? (jourFin > plafond ? plafond : jourFin) : jourDebut;
    return { start: { date: jourDebut }, end: { date: decalerJour(dernier, 1) } };
  }

  const debutLocal = JOUR_HEURE.test(debut) ? debut.slice(0, 16) : prochaineDemiHeure(maintenant);
  const finSaisie = JOUR_HEURE.test(fin) ? fin.slice(0, 16) : null;
  const plafond = decalerMinutes(debutLocal, JOURS_MAX * 24 * 60);
  const finLocal = finSaisie && finSaisie > debutLocal ? (finSaisie > plafond ? plafond : finSaisie) : decalerMinutes(debutLocal, 60);
  return {
    start: { dateTime: `${debutLocal}:00`, timeZone: ALGIERS_TZ },
    end: { dateTime: `${finLocal}:00`, timeZone: ALGIERS_TZ },
  };
}

/** Lit le corps reçu par la route — tout ce qui n'est pas une chaîne est ignoré ; sans titre, la demande est illisible. */
export function lireDemandeLienMeet(corps: unknown): DemandeLienMeet | null {
  if (!corps || typeof corps !== "object") return null;
  const o = corps as Record<string, unknown>;
  const texte = (k: string) => (typeof o[k] === "string" ? (o[k] as string).trim() : "");
  const titre = texte("titre").replace(/\s+/g, " ").slice(0, TITRE_MAX);
  if (!titre) return null;
  return { titre, debut: texte("debut") || null, fin: texte("fin") || null, journeeEntiere: o.journeeEntiere === true };
}

/** Un lien Meet, et rien d'autre : `https://meet.google.com/<code>`. Tout autre hôte est refusé. */
export function estLienGoogleMeet(url: string | null | undefined): url is string {
  return typeof url === "string" && /^https:\/\/meet\.google\.com\/[a-z0-9][a-z0-9-]{5,}[a-z0-9](?:[?#]\S*)?$/i.test(url.trim());
}

/** L'événement tel que Google le rend — seuls les champs lus ici. */
export interface EvenementGoogleBrut {
  id?: string;
  htmlLink?: string;
  hangoutLink?: string;
  conferenceData?: {
    createRequest?: { status?: { statusCode?: string } };
    entryPoints?: { entryPointType?: string; uri?: string }[];
  };
}

/** Le lien Meet de la réponse : `hangoutLink`, sinon le point d'entrée vidéo — vérifié, jamais deviné. */
export function lienMeetDe(ev: EvenementGoogleBrut): string | null {
  const candidats = [
    ev.hangoutLink,
    ...(ev.conferenceData?.entryPoints ?? []).filter((e) => e.entryPointType === "video").map((e) => e.uri),
  ];
  return candidats.find(estLienGoogleMeet)?.trim() ?? null;
}

/** La création de la visioconférence est ASYNCHRONE chez Google : `pending` se relit, `failure` se dit. */
export function etatCreationMeet(ev: EvenementGoogleBrut): "success" | "pending" | "failure" | "inconnu" {
  const s = ev.conferenceData?.createRequest?.status?.statusCode;
  return s === "success" || s === "pending" || s === "failure" ? s : "inconnu";
}

/** Pourquoi le lien n'a pas pu être généré — chaque cas appelle une conduite différente. */
export type RefusMeet =
  | "droit"
  | "invalide"
  | "non-configure"
  | "non-connecte"
  | "suspendu"
  | "reconnecter"
  | "droit-agenda"
  | "google-refuse"
  | "google-indisponible"
  | "sans-lien";

const REGLAGES = "Chief of Staff → Réglages";

/** La phrase de chaque refus : ce qui manque, QUI peut le corriger, et OÙ. */
export const MESSAGE_REFUS_MEET: Record<RefusMeet, string> = {
  droit: "Vous n'avez pas le droit de créer une réunion ou un événement : le lien Google Meet ne peut pas être généré pour vous.",
  invalide: "Indiquez d'abord un titre : il sert de nom à la réunion dans Google Agenda.",
  "non-configure": "L'intégration Google n'est pas configurée sur le serveur (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI). En attendant, collez un lien à la main.",
  "non-connecte": `Aucun compte Google de l'entreprise n'est connecté. La Direction ou un Super Admin doit le connecter : ${REGLAGES} → Connecter Google. En attendant, collez un lien à la main.`,
  suspendu: `La liaison Google de l'entreprise est suspendue (coupe-circuit). La Direction ou un Super Admin peut la réactiver : ${REGLAGES}.`,
  reconnecter: `Le compte Google de l'entreprise doit être reconnecté (autorisation expirée ou révoquée). La Direction ou un Super Admin : ${REGLAGES} → Reconnecter.`,
  "droit-agenda": `Le compte Google de l'entreprise n'a pas accordé l'accès à Google Agenda, nécessaire pour créer un lien Meet. Reconnectez-le en cochant « Google Agenda » : ${REGLAGES} → Reconnecter.`,
  "google-refuse": "Google a refusé de créer la visioconférence sur le compte de l'entreprise. Vérifiez que Google Meet est activé pour ce compte et que l'API Google Agenda l'est dans le projet Google Cloud — ou collez un lien à la main.",
  "google-indisponible": "Google est momentanément injoignable ou limite les requêtes. Réessayez dans un instant.",
  "sans-lien": "Google a créé la réunion mais n'a pas encore rendu son lien Meet. Réessayez dans un instant.",
};

/** Les refus qu'on corrige dans les réglages Google — l'écran y renvoie qui peut le faire. */
export const REFUS_DE_CONNEXION: ReadonlySet<RefusMeet> = new Set(["non-connecte", "suspendu", "reconnecter", "droit-agenda"]);

/** Une erreur de l'appel Google (`GoogleApiError.kind` / `.reason`) traduite en refus. */
export function refusDepuisErreurGoogle(kind: string, reason: string): RefusMeet {
  if (kind === "unauthorized") return "reconnecter";
  if (kind === "forbidden") return /insufficient|scope/i.test(reason) ? "droit-agenda" : "google-refuse";
  if (kind === "throttled" || kind === "network") return "google-indisponible";
  if (reason === "notConfigured") return "non-configure";
  return "google-refuse";
}

/** Ce que la route rend à l'écran. `reglages` n'est donné qu'à qui peut agir (Direction, Super Admin). */
export type ReponseLienMeet =
  | { ok: true; lien: string; compte: string }
  | { ok: false; raison: RefusMeet; message: string; reglages?: string };
