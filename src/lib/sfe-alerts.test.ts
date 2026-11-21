import { describe, it, expect } from "vitest";
import {
  alertKey, alertsForRep, alerteDejaEnvoyee, fieldAlerts, monthlyReviewLine, verrouApresEnvoi, DEFAULT_THRESHOLDS, type RepSnapshot,
} from "./sfe-alerts";

const ilYA = (base: Date, jours: number) => new Date(base.getTime() - jours * 86_400_000);

const rep = (over: Partial<RepSnapshot> = {}): RepSnapshot => ({
  repId: "r1", repName: "Amine", panelSize: 40, plannedVisits: 55, requiredVisits: 50,
  realVisits: 30, coveredDoctors: 25, lastVisitLoggedAt: null, ...over,
});

const LE_5 = new Date(2026, 8, 5);
const LE_16 = new Date(2026, 8, 16);
const LE_27 = new Date(2026, 8, 27);

describe("NON ARMÉ — la configuration d'abord, et elle ne vise pas le KAM", () => {
  it("sans panel : une seule alerte, adressée à celui qui CONFIGURE", () => {
    const a = alertsForRep(rep({ panelSize: 0, lastVisitLoggedAt: ilYA(LE_16, 30) }), LE_16);
    expect(a).toHaveLength(1);
    expect(a[0].kind).toBe("NON_ARME");
    expect(a[0].audience).toBe("configurator");
    expect(a[0].body).toMatch(/aucun praticien/i);
  });

  it("sans requis de segmentation : même règle — accuser l'homme d'un défaut d'outil serait faux", () => {
    const a = alertsForRep(rep({ requiredVisits: 0, lastVisitLoggedAt: ilYA(LE_16, 30) }), LE_16);
    expect(a).toHaveLength(1);
    expect(a[0].kind).toBe("NON_ARME");
    expect(a[0].body).toMatch(/aucune visite requise par la segmentation/i);
  });

  it("l'absence d'affectation ne désarme plus : la référence est le requis, le planifié n'est qu'une information", () => {
    const a = alertsForRep(rep({ plannedVisits: 0, lastVisitLoggedAt: ilYA(LE_16, 1) }), LE_16);
    expect(a.map((x) => x.kind)).not.toContain("NON_ARME");
  });

  it("elle COUPE les autres : un KAM non armé ne reçoit pas d'alerte de silence en plus", () => {
    const a = alertsForRep(rep({ panelSize: 0, requiredVisits: 0, realVisits: 0 }), LE_27);
    expect(a.map((x) => x.kind)).toEqual(["NON_ARME"]);
  });
});

describe("SILENCE — « on ne sait pas », jamais « il ne fait rien »", () => {
  it("aucune saisie depuis le seuil → alerte au superviseur, et la phrase dit le FAIT", () => {
    const a = alertsForRep(rep({ lastVisitLoggedAt: ilYA(LE_5, 6) }), LE_5);
    expect(a.map((x) => x.kind)).toContain("SILENCE");
    const s = a.find((x) => x.kind === "SILENCE")!;
    expect(s.audience).toBe("supervisor");
    expect(s.body).toMatch(/il y a 6 jours/);
    // La formulation n'accuse pas : pas de « inactif », pas de jugement.
    expect(s.body).not.toMatch(/inactif|ne travaille/i);
  });

  it("sous le seuil, rien : une alerte quotidienne se ferait couper, et la vraie serait ratée", () => {
    const a = alertsForRep(rep({ lastVisitLoggedAt: ilYA(LE_5, DEFAULT_THRESHOLDS.silenceDays - 1) }), LE_5);
    expect(a.map((x) => x.kind)).not.toContain("SILENCE");
  });

  it("un silence DEUX FOIS trop long monte en gravité", () => {
    const court = alertsForRep(rep({ lastVisitLoggedAt: ilYA(LE_5, 6) }), LE_5).find((x) => x.kind === "SILENCE")!;
    const long = alertsForRep(rep({ lastVisitLoggedAt: ilYA(LE_5, 20) }), LE_5).find((x) => x.kind === "SILENCE")!;
    expect(court.severity).toBe("warning");
    expect(long.severity).toBe("danger");
  });

  it("jamais aucune saisie : l'activité n'est pas mesurable — on le dit ainsi", () => {
    const s = alertsForRep(rep({ lastVisitLoggedAt: null }), LE_5).find((x) => x.kind === "SILENCE")!;
    expect(s.body).toMatch(/n'a jamais été saisie/i);
  });
});

describe("RETARD & COUVERTURE — au bon moment du mois, pas tous les jours", () => {
  it("le retard se juge à MI-MOIS : rien le 5, alerte le 16", () => {
    const base = { realVisits: 10, lastVisitLoggedAt: ilYA(LE_16, 1) }; // 10/50 requis = 20 %
    expect(alertsForRep(rep(base), LE_5).map((x) => x.kind)).not.toContain("RETARD");
    const a = alertsForRep(rep(base), LE_16);
    expect(a.map((x) => x.kind)).toContain("RETARD");
    expect(a.find((x) => x.kind === "RETARD")!.title).toMatch(/20 % du requis/);
  });

  it("le RETARD se juge sur le REQUIS, jamais sur le planifié ; le planifié s'affiche à côté", () => {
    // 20 visites : 40 % du requis (50) mais 36 % du planifié (55) — seul le requis compte.
    const limite = alertsForRep(rep({ realVisits: 20, requiredVisits: 50, plannedVisits: 90, lastVisitLoggedAt: ilYA(LE_16, 1) }), LE_16);
    expect(limite.map((x) => x.kind)).not.toContain("RETARD"); // 40 % n'est pas < 40 % ; avec 90 planifiées (22 %) il aurait sonné
    const a = alertsForRep(rep({ realVisits: 19, requiredVisits: 50, plannedVisits: 90, lastVisitLoggedAt: ilYA(LE_16, 1) }), LE_16);
    const r = a.find((x) => x.kind === "RETARD")!;
    expect(r.title).toMatch(/38 % du requis/);
    expect(r.body).toMatch(/19 visites sur 50 requises/);
    expect(r.body).toMatch(/90 planifiées/);
  });

  it("réalisation correcte à mi-mois : pas d'alerte", () => {
    const a = alertsForRep(rep({ realVisits: 30, lastVisitLoggedAt: ilYA(LE_16, 1) }), LE_16); // 60 %
    expect(a.map((x) => x.kind)).not.toContain("RETARD");
  });

  it("la COUVERTURE se juge en fin de mois — le volume peut être bon alors que le panel est mort", () => {
    // 50 visites sur 55 (91 %), mais seulement 8 praticiens vus sur 40 (20 %).
    const tournant = rep({ realVisits: 50, coveredDoctors: 8, lastVisitLoggedAt: ilYA(LE_27, 1) });
    expect(alertsForRep(tournant, LE_16).map((x) => x.kind)).not.toContain("COUVERTURE");
    const a = alertsForRep(tournant, LE_27);
    expect(a.map((x) => x.kind)).toContain("COUVERTURE");
    expect(a.find((x) => x.kind === "COUVERTURE")!.body).toMatch(/8 praticiens vus sur 40/);
  });

  it("après le 25, le RETARD ne double plus la couverture — deux alertes pour un même fait font couper", () => {
    const a = alertsForRep(rep({ realVisits: 5, coveredDoctors: 5, lastVisitLoggedAt: ilYA(LE_27, 1) }), LE_27);
    expect(a.map((x) => x.kind)).toContain("COUVERTURE");
    expect(a.map((x) => x.kind)).not.toContain("RETARD");
  });
});

describe("cycle et agrégat", () => {
  it("la clé d'anti-spam porte le TYPE et le MOIS : une par cycle, pas une par nuit", () => {
    expect(alertKey("SILENCE", new Date(2026, 8, 5))).toBe("SILENCE:2026-09");
    expect(alertKey("SILENCE", new Date(2026, 8, 27))).toBe("SILENCE:2026-09");
    expect(alertKey("SILENCE", new Date(2026, 9, 1))).not.toBe("SILENCE:2026-09");
  });

  it("les alertes d'un périmètre sortent les plus GRAVES d'abord", () => {
    const list = fieldAlerts([
      rep({ repId: "a", repName: "Ali", lastVisitLoggedAt: ilYA(LE_5, 6) }), // warning
      rep({ repId: "b", repName: "Brahim", lastVisitLoggedAt: ilYA(LE_5, 30) }), // danger
    ], LE_5);
    expect(list[0].repName).toBe("Brahim");
    expect(list[0].severity).toBe("danger");
  });

  it("la revue mensuelle tient dans la notification elle-même — le lien ne sert qu'à creuser", () => {
    const l = monthlyReviewLine([
      rep({ repId: "a", realVisits: 50, plannedVisits: 55, panelSize: 40, coveredDoctors: 30 }),
      rep({ repId: "b", realVisits: 20, plannedVisits: 55, panelSize: 40, coveredDoctors: 15 }),
    ]);
    // Sur le REQUIS (2 × 50), pas sur le planifié (2 × 55).
    expect(l).toMatch(/70 visites réalisées sur 100 requises \(70 %\)/);
    expect(l).toMatch(/panel couvert à 56 %/);
    expect(l).toMatch(/1 KAM sous 60 %/);
    expect(monthlyReviewLine([])).toMatch(/aucun kam/i);
  });
});

describe("le verrou anti-spam garde TOUTES les alertes du mois (recette 21/11/2026 : 6 notifications par minute)", () => {
  it("deux alertes du même KAM ne s'effacent plus l'une l'autre : le second passage n'envoie rien", () => {
    const silence = "SILENCE:2026-11", retard = "RETARD:2026-11";
    // Premier passage : rien d'envoyé, les deux partent, le verrou les garde toutes deux.
    let verrou: string | null = null;
    for (const cle of [silence, retard]) {
      expect(alerteDejaEnvoyee(verrou, cle)).toBe(false);
      verrou = verrouApresEnvoi(verrou, cle);
    }
    // Les passages suivants (chaque minute) : aucune ne repart.
    for (let passage = 0; passage < 3; passage++) {
      expect(alerteDejaEnvoyee(verrou, silence)).toBe(true);
      expect(alerteDejaEnvoyee(verrou, retard)).toBe(true);
    }
  });

  it("l'ancien verrou à une seule clé est lu tel quel ; les clés d'un mois passé tombent au premier envoi du nouveau mois", () => {
    expect(alerteDejaEnvoyee("SILENCE:2026-11", "SILENCE:2026-11")).toBe(true);
    expect(alerteDejaEnvoyee("SILENCE:2026-11", "SILENCE:2026-12")).toBe(false);
    expect(verrouApresEnvoi("SILENCE:2026-11|RETARD:2026-11", "SILENCE:2026-12")).toBe("SILENCE:2026-12");
    expect(verrouApresEnvoi("SILENCE:2026-12", "SILENCE:2026-12")).toBe("SILENCE:2026-12");
    expect(alerteDejaEnvoyee("NON_ARME:2026-11", "NON_ARME:2026-1")).toBe(false);
  });
});
