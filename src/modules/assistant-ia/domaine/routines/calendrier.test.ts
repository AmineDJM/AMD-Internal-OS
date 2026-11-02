import { describe, expect, it } from "vitest";
import { dateLongue, decrireCalendrier, prochaineExecution, prochaines, type Calendrier } from "./calendrier";

/** LE CALENDRIER D'UNE ROUTINE — heure d'Alger, intervalles, jours ouvrés, fin de mois, fin et plafond. */
const cal = (o: Partial<Calendrier>): Calendrier => ({
  frequence: "WEEKLY", intervalle: 1, jours: [0], jourDuMois: null, heure: 8, minute: 0,
  debutLe: new Date("2026-10-01T00:00:00Z"), finLe: null, maxExecutions: null, ...o,
});
const SAMEDI = new Date("2026-10-31T10:00:00Z"); // samedi 31 octobre 2026, 11:00 à Alger

describe("calendrier des routines", () => {
  it("chaque dimanche à 8 h (Alger) : le lendemain à 07:00 UTC", () => {
    expect(prochaineExecution(cal({}), SAMEDI)?.toISOString()).toBe("2026-11-01T07:00:00.000Z");
    expect(decrireCalendrier(cal({}))).toBe("chaque dimanche à 08:00 (heure d'Alger)");
  });

  it("strictement après : une routine qui vient de passer ne redevient pas due", () => {
    const t = new Date("2026-11-01T07:00:00Z");
    expect(prochaineExecution(cal({}), t)?.toISOString()).toBe("2026-11-08T07:00:00.000Z");
  });

  it("chaque jour à 8 h, passé 11 h : demain", () => {
    expect(prochaineExecution(cal({ frequence: "DAILY", jours: [] }), SAMEDI)?.toISOString()).toBe("2026-11-01T07:00:00.000Z");
  });

  it("jours ouvrés (dimanche → jeudi) à 7 h 30, un jeudi après-midi : dimanche", () => {
    const c = cal({ jours: [0, 1, 2, 3, 4], minute: 30, heure: 7 });
    expect(prochaineExecution(c, new Date("2026-10-29T12:00:00Z"))?.toISOString()).toBe("2026-11-01T06:30:00.000Z");
    expect(decrireCalendrier(c)).toBe("du dimanche au jeudi à 07:30 (heure d'Alger)");
  });

  it("le dernier jour du mois, et le 31 d'un mois de 30 jours", () => {
    const dernier = cal({ frequence: "MONTHLY", jours: [], jourDuMois: -1, heure: 18 });
    expect(prochaineExecution(dernier, new Date("2027-02-10T00:00:00Z"))?.toISOString()).toBe("2027-02-28T17:00:00.000Z");
    expect(decrireCalendrier(dernier)).toBe("le dernier jour de chaque mois à 18:00 (heure d'Alger)");
    const le31 = cal({ frequence: "MONTHLY", jours: [], jourDuMois: 31 });
    expect(prochaineExecution(le31, new Date("2026-11-05T00:00:00Z"))?.toISOString()).toBe("2026-11-30T07:00:00.000Z");
  });

  it("une semaine sur deux, à partir de l'ancre", () => {
    const c = cal({ jours: [1], heure: 9, intervalle: 2, debutLe: new Date("2026-10-25T23:00:00Z") });
    expect(prochaineExecution(c, new Date("2026-10-26T09:00:00Z"))?.toISOString()).toBe("2026-11-09T08:00:00.000Z");
  });

  it("une seule fois — puis plus rien", () => {
    const c = cal({ frequence: "ONCE", jours: [], debutLe: new Date("2026-11-03T09:00:00Z") });
    expect(prochaineExecution(c, SAMEDI, 0)?.toISOString()).toBe("2026-11-03T09:00:00.000Z");
    expect(prochaineExecution(c, SAMEDI, 1)).toBeNull();
    expect(decrireCalendrier(c)).toBe("une seule fois, le mardi 3 novembre 2026 à 10:00 (heure d'Alger)");
  });

  it("une fin et un plafond se respectent", () => {
    expect(prochaines(cal({ frequence: "DAILY", maxExecutions: 2 }), 5, SAMEDI)).toHaveLength(2);
    expect(prochaines(cal({ frequence: "DAILY", finLe: new Date("2026-11-02T22:59:00Z") }), 5, SAMEDI)).toHaveLength(2);
  });

  it("la date dite à Alger", () => {
    expect(dateLongue(new Date("2026-11-01T07:00:00Z"))).toBe("dimanche 1er novembre 2026 à 08:00");
  });
});
