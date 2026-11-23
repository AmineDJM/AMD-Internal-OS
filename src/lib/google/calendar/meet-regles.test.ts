import { describe, expect, it } from "vitest";
import {
  creneauGoogle, estLienGoogleMeet, etatCreationMeet, lienMeetDe, lireDemandeLienMeet, prochaineDemiHeure,
  refusDepuisErreurGoogle, MESSAGE_REFUS_MEET, REFUS_DE_CONNEXION, type RefusMeet,
} from "./meet-regles";

// 23/11/2026 10:10 UTC = 11:10 à Alger (UTC+1, sans heure d'été).
const MAINTENANT = new Date(Date.UTC(2026, 10, 23, 10, 10));

describe("le créneau envoyé à Google", () => {
  it("une date et une heure : l'heure murale d'Alger, fuseau NOMMÉ, une heure par défaut", () => {
    expect(creneauGoogle({ titre: "x", debut: "2026-11-25T09:00" }, MAINTENANT)).toEqual({
      start: { dateTime: "2026-11-25T09:00:00", timeZone: "Africa/Algiers" },
      end: { dateTime: "2026-11-25T10:00:00", timeZone: "Africa/Algiers" },
    });
  });

  it("une fin saisie après le début est gardée ; une fin AVANT le début est ignorée", () => {
    expect(creneauGoogle({ titre: "x", debut: "2026-11-25T09:00", fin: "2026-11-25T11:30" }, MAINTENANT).end)
      .toEqual({ dateTime: "2026-11-25T11:30:00", timeZone: "Africa/Algiers" });
    expect(creneauGoogle({ titre: "x", debut: "2026-11-25T09:00", fin: "2026-11-25T08:00" }, MAINTENANT).end)
      .toEqual({ dateTime: "2026-11-25T10:00:00", timeZone: "Africa/Algiers" });
  });

  it("une heure qui passe minuit change de jour", () => {
    expect(creneauGoogle({ titre: "x", debut: "2026-12-31T23:30" }, MAINTENANT).end)
      .toEqual({ dateTime: "2027-01-01T00:30:00", timeZone: "Africa/Algiers" });
  });

  it("des dates seules (événement Ad & Pro) : des JOURS, fin exclusive chez Google", () => {
    expect(creneauGoogle({ titre: "x", debut: "2026-11-25" }, MAINTENANT)).toEqual({ start: { date: "2026-11-25" }, end: { date: "2026-11-26" } });
    expect(creneauGoogle({ titre: "x", debut: "2026-11-25", fin: "2026-11-27" }, MAINTENANT)).toEqual({ start: { date: "2026-11-25" }, end: { date: "2026-11-28" } });
    expect(creneauGoogle({ titre: "x", debut: "2026-02-28", fin: "2026-02-28" }, MAINTENANT).end).toEqual({ date: "2026-03-01" });
  });

  it("« journée entière » cochée : la date du champ, même s'il porte encore une heure", () => {
    expect(creneauGoogle({ titre: "x", debut: "2026-11-25T09:00", journeeEntiere: true }, MAINTENANT))
      .toEqual({ start: { date: "2026-11-25" }, end: { date: "2026-11-26" } });
  });

  it("une saisie absurde ne pose pas des mois dans l'agenda : 31 jours au plus", () => {
    expect(creneauGoogle({ titre: "x", debut: "2026-01-01", fin: "2026-12-31" }, MAINTENANT).end).toEqual({ date: "2026-02-01" });
  });

  it("sans date : la prochaine demi-heure à Alger, pour une heure", () => {
    expect(prochaineDemiHeure(MAINTENANT)).toBe("2026-11-23T11:30");
    expect(prochaineDemiHeure(new Date(Date.UTC(2026, 10, 23, 10, 0)))).toBe("2026-11-23T11:00");
    expect(prochaineDemiHeure(new Date(Date.UTC(2026, 10, 23, 22, 45)))).toBe("2026-11-24T00:00");
    expect(creneauGoogle({ titre: "x" }, MAINTENANT)).toEqual({
      start: { dateTime: "2026-11-23T11:30:00", timeZone: "Africa/Algiers" },
      end: { dateTime: "2026-11-23T12:30:00", timeZone: "Africa/Algiers" },
    });
  });
});

describe("la demande lue par la route", () => {
  it("sans titre, illisible ; le reste n'est lu que s'il est une chaîne", () => {
    expect(lireDemandeLienMeet(null)).toBeNull();
    expect(lireDemandeLienMeet({ titre: "   " })).toBeNull();
    expect(lireDemandeLienMeet({ titre: 42 })).toBeNull();
    expect(lireDemandeLienMeet({ titre: "  Point   hebdo ", debut: 5, journeeEntiere: "oui" }))
      .toEqual({ titre: "Point hebdo", debut: null, fin: null, journeeEntiere: false });
  });

  it("le titre est borné", () => {
    expect(lireDemandeLienMeet({ titre: "a".repeat(500) })?.titre).toHaveLength(200);
  });
});

describe("le lien relu dans la réponse de Google — jamais deviné", () => {
  it("`hangoutLink` d'abord, sinon le point d'entrée vidéo", () => {
    expect(lienMeetDe({ hangoutLink: "https://meet.google.com/abc-defg-hij" })).toBe("https://meet.google.com/abc-defg-hij");
    expect(lienMeetDe({
      conferenceData: { entryPoints: [
        { entryPointType: "phone", uri: "tel:+33-1-23" },
        { entryPointType: "video", uri: "https://meet.google.com/xyz-abcd-efg" },
      ] },
    })).toBe("https://meet.google.com/xyz-abcd-efg");
  });

  it("un lien qui n'est pas sur meet.google.com est refusé", () => {
    expect(lienMeetDe({ hangoutLink: "https://evil.example/meet.google.com/abc-defg-hij" })).toBeNull();
    expect(lienMeetDe({ hangoutLink: "http://meet.google.com/abc-defg-hij" })).toBeNull();
    expect(lienMeetDe({})).toBeNull();
    expect(estLienGoogleMeet("https://meet.google.com/abc-defg-hij?authuser=0")).toBe(true);
    expect(estLienGoogleMeet("https://meet.google.com/")).toBe(false);
  });

  it("l'état de la création se lit tel que Google le donne", () => {
    expect(etatCreationMeet({ conferenceData: { createRequest: { status: { statusCode: "pending" } } } })).toBe("pending");
    expect(etatCreationMeet({ conferenceData: { createRequest: { status: { statusCode: "failure" } } } })).toBe("failure");
    expect(etatCreationMeet({})).toBe("inconnu");
  });
});

describe("chaque refus dit quoi connecter", () => {
  it("les erreurs Google sont traduites", () => {
    expect(refusDepuisErreurGoogle("unauthorized", "refreshFailed")).toBe("reconnecter");
    expect(refusDepuisErreurGoogle("forbidden", "insufficientPermissions")).toBe("droit-agenda");
    expect(refusDepuisErreurGoogle("forbidden", "ACCESS_TOKEN_SCOPE_INSUFFICIENT")).toBe("droit-agenda");
    expect(refusDepuisErreurGoogle("forbidden", "")).toBe("google-refuse");
    expect(refusDepuisErreurGoogle("throttled", "rateLimitExceeded")).toBe("google-indisponible");
    expect(refusDepuisErreurGoogle("network", "network")).toBe("google-indisponible");
    expect(refusDepuisErreurGoogle("unknown", "notConfigured")).toBe("non-configure");
    expect(refusDepuisErreurGoogle("invalid", "invalid")).toBe("google-refuse");
  });

  it("les refus de connexion nomment l'écran où les corriger", () => {
    for (const r of REFUS_DE_CONNEXION) expect(MESSAGE_REFUS_MEET[r as RefusMeet]).toContain("Chief of Staff → Réglages");
  });
});
