import { describe, it, expect } from "vitest";
import { currentPeriod, periodLabel, normalizeRechargeDay, nextRechargeDate, shouldRemindRecharge, grantedTopUpAmount } from "./petty-cash";

/**
 * LE SOLDE A DÉMÉNAGÉ. Il se calculait ici, par mois ; la caisse est devenue CONTINUE et son
 * arithmétique vit dans `general-means/continuous-cash.test.ts`. Ce qui reste ici n'a pas changé :
 * la lecture d'une période, et le réglage mensuel du rechargement — une échéance d'agenda, pas
 * un cloisonnement de l'argent.
 */
describe("currentPeriod / periodLabel", () => {
  it("forme la clé du mois sur deux chiffres", () => {
    expect(currentPeriod(new Date("2026-03-09T10:00:00Z"))).toBe("2026-03");
    expect(currentPeriod(new Date("2026-12-31T10:00:00Z"))).toBe("2026-12");
  });

  it("écrit le mois en toutes lettres", () => {
    expect(periodLabel("2026-08")).toBe("août 2026");
    expect(periodLabel("2026-01")).toBe("janvier 2026");
  });

  it("laisse passer ce qu'elle ne sait pas lire plutôt que d'inventer un mois", () => {
    expect(periodLabel("n'importe quoi")).toBe("n'importe quoi");
    expect(periodLabel("2026-13")).toBe("2026-13");
  });
});

describe("normalizeRechargeDay", () => {
  it("borne à 28 — « le 31 février » n'existe pas et ne doit pas se traduire en silence", () => {
    expect(normalizeRechargeDay(15)).toBe(15);
    expect(normalizeRechargeDay(28)).toBe(28);
    expect(normalizeRechargeDay(31)).toBe(1);
    expect(normalizeRechargeDay(0)).toBe(1);
    expect(normalizeRechargeDay("abc")).toBe(1);
  });
});

describe("nextRechargeDate", () => {
  it("garde le mois en cours tant que le jour n'est pas passé", () => {
    const now = new Date(2026, 7, 3, 14, 0); // 3 août
    expect(nextRechargeDate(5, now).getMonth()).toBe(7);
    expect(nextRechargeDate(5, now).getDate()).toBe(5);
  });

  it("compte encore le JOUR MÊME — sinon le rappel du dernier jour sauterait un mois", () => {
    const now = new Date(2026, 7, 5, 18, 0);
    expect(nextRechargeDate(5, now).getMonth()).toBe(7);
  });

  it("passe au mois suivant une fois le jour dépassé", () => {
    const now = new Date(2026, 7, 20, 9, 0);
    const next = nextRechargeDate(5, now);
    expect(next.getMonth()).toBe(8);
    expect(next.getDate()).toBe(5);
  });
});

describe("shouldRemindRecharge — 48 h avant, et UNE seule fois", () => {
  const plan = (over: Partial<{ rechargeDay: number; isActive: boolean; lastReminderPeriod: string | null }> = {}) =>
    ({ rechargeDay: 5, isActive: true, lastReminderPeriod: null, ...over });

  it("prévient dans la fenêtre des 48 h", () => {
    // Rechargement le 5 à 9 h ; on est le 3 à 15 h → dans les 48 h.
    const r = shouldRemindRecharge(plan(), new Date(2026, 7, 3, 15, 0));
    expect(r.due).toBe(true);
    expect(r.period).toBe("2026-08");
  });

  it("ne prévient pas trop tôt", () => {
    expect(shouldRemindRecharge(plan(), new Date(2026, 7, 1, 9, 0)).due).toBe(false);
  });

  it("ne renvoie PAS le même rappel — le planificateur repasse toutes les minutes", () => {
    const already = plan({ lastReminderPeriod: "2026-08" });
    expect(shouldRemindRecharge(already, new Date(2026, 7, 3, 15, 0)).due).toBe(false);
    // Mais l'échéance SUIVANTE, elle, se rappellera.
    const next = shouldRemindRecharge(already, new Date(2026, 8, 3, 15, 0));
    expect(next.period).toBe("2026-09");
    expect(next.due).toBe(true);
  });

  it("se tait sur un plan désactivé", () => {
    expect(shouldRemindRecharge(plan({ isActive: false }), new Date(2026, 7, 3, 15, 0)).due).toBe(false);
  });
});

describe("grantedTopUpAmount — les RH écrivent le montant", () => {
  it("retient ce que les RH ont écrit, pas ce qui a été demandé", () => {
    expect(grantedTopUpAmount({ amountRequested: 50_000 }, 30_000)).toBe(30_000);
    // Accorder zéro est une décision, pas une absence de décision.
    expect(grantedTopUpAmount({ amountRequested: 50_000 }, 0)).toBe(0);
  });

  it("retombe sur le demandé quand rien n'est écrit", () => {
    expect(grantedTopUpAmount({ amountRequested: 50_000 }, null)).toBe(50_000);
    expect(grantedTopUpAmount({ amountRequested: 50_000 }, undefined)).toBe(50_000);
  });
});
