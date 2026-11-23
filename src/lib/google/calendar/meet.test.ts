import { afterEach, describe, expect, it, vi } from "vitest";
import { creerReunionMeet, LienMeetAbsent } from "./meet";

/**
 * L'APPEL À GOOGLE, sans réseau : `fetch` est remplacé, et chaque requête est gardée pour être lue.
 * On prouve ce que l'événement porte (visioconférence Meet, aucun courriel, transparent) et qu'un
 * lien n'est rendu que si Google l'a donné.
 */

type Appel = { url: string; method: string; body: Record<string, unknown> | null };
const appels: Appel[] = [];

function repondre(...reponses: unknown[]) {
  let i = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    appels.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
    const r = reponses[Math.min(i++, reponses.length - 1)];
    return new Response(JSON.stringify(r), { status: 200, headers: { "content-type": "application/json" } });
  }));
}

const CRENEAU = {
  start: { dateTime: "2026-11-25T09:00:00", timeZone: "Africa/Algiers" },
  end: { dateTime: "2026-11-25T10:00:00", timeZone: "Africa/Algiers" },
};
const sansAttente = async () => undefined;

afterEach(() => { appels.length = 0; vi.unstubAllGlobals(); });

describe("créer une réunion Google Meet", () => {
  it("l'événement demande une visioconférence Meet, sans invité ni courriel, sans bloquer l'agenda", async () => {
    repondre({ id: "ev1", hangoutLink: "https://meet.google.com/abc-defg-hij", htmlLink: "https://www.google.com/calendar/event?eid=x" });
    const r = await creerReunionMeet("jeton", { titre: "Point hebdo", description: "d", creneau: CRENEAU, attendre: sansAttente });

    expect(r).toEqual({ lien: "https://meet.google.com/abc-defg-hij", evenementId: "ev1", htmlLink: "https://www.google.com/calendar/event?eid=x" });
    expect(appels).toHaveLength(1);
    const { url, method, body } = appels[0];
    expect(method).toBe("POST");
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://www.googleapis.com/calendar/v3/calendars/primary/events");
    expect(u.searchParams.get("conferenceDataVersion")).toBe("1");
    expect(u.searchParams.get("sendUpdates")).toBe("none");
    expect(body).toMatchObject({
      summary: "Point hebdo",
      start: CRENEAU.start,
      end: CRENEAU.end,
      transparency: "transparent",
      conferenceData: { createRequest: { conferenceSolutionKey: { type: "hangoutsMeet" } } },
    });
    expect(body).not.toHaveProperty("attendees");
    const requestId = (body?.conferenceData as { createRequest: { requestId: string } }).createRequest.requestId;
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("création encore en cours (`pending`) : l'événement est relu jusqu'au lien", async () => {
    repondre(
      { id: "ev2", conferenceData: { createRequest: { status: { statusCode: "pending" } } } },
      { id: "ev2", conferenceData: { createRequest: { status: { statusCode: "pending" } } } },
      { id: "ev2", hangoutLink: "https://meet.google.com/xyz-abcd-efg", conferenceData: { createRequest: { status: { statusCode: "success" } } } },
    );
    const r = await creerReunionMeet("jeton", { titre: "t", description: "d", creneau: CRENEAU, attendre: sansAttente });
    expect(r.lien).toBe("https://meet.google.com/xyz-abcd-efg");
    expect(appels.map((a) => a.method)).toEqual(["POST", "GET", "GET"]);
    expect(appels[1].url).toContain("/events/ev2");
  });

  it("Google refuse la visioconférence (`failure`) : aucun lien, un refus nommé", async () => {
    repondre({ id: "ev3", conferenceData: { createRequest: { status: { statusCode: "failure" } } } });
    await expect(creerReunionMeet("jeton", { titre: "t", description: "d", creneau: CRENEAU, attendre: sansAttente }))
      .rejects.toMatchObject({ name: "LienMeetAbsent", raison: "google-refuse" });
  });

  it("`pending` qui dure : on s'arrête, sans inventer de lien", async () => {
    repondre({ id: "ev4", conferenceData: { createRequest: { status: { statusCode: "pending" } } } });
    const p = creerReunionMeet("jeton", { titre: "t", description: "d", creneau: CRENEAU, attendre: sansAttente });
    await expect(p).rejects.toBeInstanceOf(LienMeetAbsent);
    await expect(p).rejects.toMatchObject({ raison: "sans-lien" });
    expect(appels.length).toBeLessThanOrEqual(5);
  });

  it("un « lien » hors de meet.google.com n'est jamais rendu", async () => {
    repondre({ id: "ev5", hangoutLink: "https://autre.example/abc-defg-hij" });
    await expect(creerReunionMeet("jeton", { titre: "t", description: "d", creneau: CRENEAU, attendre: sansAttente }))
      .rejects.toBeInstanceOf(LienMeetAbsent);
  });
});
