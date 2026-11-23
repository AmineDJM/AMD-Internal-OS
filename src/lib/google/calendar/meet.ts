import { randomUUID } from "node:crypto";
import { CALENDAR_BASE } from "../config";
import { googleJson } from "../client";
import { etatCreationMeet, lienMeetDe, type CreneauGoogle, type EvenementGoogleBrut } from "./meet-regles";

/**
 * CRÉER UNE RÉUNION GOOGLE MEET — un événement de l'agenda Google avec sa visioconférence.
 *
 * C'est la voie standard de Google : `events.insert` avec `conferenceDataVersion=1` et une
 * `conferenceData.createRequest` de type `hangoutsMeet` ; le lien revient dans `hangoutLink`.
 * La création de la visioconférence est ASYNCHRONE : tant que Google répond `pending`, on relit
 * l'événement (quelques secondes au plus) plutôt que de rendre un lien qui n'existe pas encore.
 *
 * L'événement est posé dans l'agenda du compte de l'entreprise :
 *   • SANS invité et `sendUpdates=none` — aucun courriel ne part au nom de l'entreprise ;
 *   • TRANSPARENT (« disponible ») — il ne doit pas fausser les créneaux libres qu'Adam calcule
 *     pour le PDG (`freeBusy` ignore les événements transparents) ;
 *   • sans rappel — le téléphone du compte ne sonne pas pour chaque réunion de l'ERP.
 *
 * L'insertion est une ÉCRITURE : `client.ts` ne la rejoue pas sur une panne (pas de doublon).
 */

export interface ReunionMeetCreee {
  lien: string;
  evenementId: string;
  htmlLink: string | null;
}

/** Google a répondu, mais sans lien Meet exploitable : `failure` (refus) ou `pending` qui dure (sans-lien). */
export class LienMeetAbsent extends Error {
  readonly raison: "google-refuse" | "sans-lien";
  constructor(raison: "google-refuse" | "sans-lien") {
    super(raison === "google-refuse" ? "Google a refusé la visioconférence." : "Le lien Meet n'est pas encore prêt.");
    this.name = "LienMeetAbsent";
    this.raison = raison;
  }
}

const RELECTURES = 4;
const PAUSE_MS = 800;
const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function creerReunionMeet(
  accessToken: string,
  opts: { titre: string; description: string; creneau: CreneauGoogle; calendarId?: string; attendre?: (ms: number) => Promise<void> },
): Promise<ReunionMeetCreee> {
  const agenda = `${CALENDAR_BASE}/calendars/${encodeURIComponent(opts.calendarId ?? "primary")}/events`;
  const attendre = opts.attendre ?? pause;

  let ev = await googleJson<EvenementGoogleBrut>({
    method: "POST",
    url: agenda,
    accessToken,
    query: { conferenceDataVersion: 1, sendUpdates: "none" },
    body: {
      summary: opts.titre,
      description: opts.description,
      start: opts.creneau.start,
      end: opts.creneau.end,
      transparency: "transparent",
      reminders: { useDefault: false, overrides: [] },
      conferenceData: {
        createRequest: { requestId: randomUUID(), conferenceSolutionKey: { type: "hangoutsMeet" } },
      },
    },
  });

  for (let i = 0; i < RELECTURES && !lienMeetDe(ev) && etatCreationMeet(ev) === "pending" && ev.id; i++) {
    await attendre(PAUSE_MS);
    ev = await googleJson<EvenementGoogleBrut>({
      url: `${agenda}/${encodeURIComponent(ev.id)}`,
      accessToken,
      query: { conferenceDataVersion: 1 },
    });
  }

  const lien = lienMeetDe(ev);
  if (lien) return { lien, evenementId: String(ev.id ?? ""), htmlLink: ev.htmlLink ?? null };
  throw new LienMeetAbsent(etatCreationMeet(ev) === "failure" ? "google-refuse" : "sans-lien");
}
