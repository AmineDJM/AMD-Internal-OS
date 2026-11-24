import { describe, expect, it } from "vitest";
import {
  calculerRetenue, libelleTaux, lireTauxSaisi, MENTION_A_CONFIRMER, moisDeLaRetenue, phraseRetenue, TAUX_RETENUE_DEFAUT,
  tauxEnVigueur, totalRetenues,
} from "./retenues";

describe("le calcul brut / retenue / net", () => {
  it("la retenue au dinar, le net est le reste : brut = net + retenue, exactement", () => {
    expect(calculerRetenue(100_000, 10)).toEqual({ brut: 100_000, taux: 10, retenue: 10_000, net: 90_000 });
    const c = calculerRetenue(123_456.78, 15);
    expect(c.retenue).toBe(18_519); // 18 518,517 → 18 519
    expect(Math.round((c.net + c.retenue) * 100)).toBe(12_345_678);
  });
  it("arrondi au dinar le plus proche, la moitié au-dessus — sans dérive de virgule flottante", () => {
    expect(calculerRetenue(105, 10).retenue).toBe(11); // 10,5 → 11
    expect(calculerRetenue(104, 10).retenue).toBe(10); // 10,4 → 10
    expect(calculerRetenue(1_000.05, 30).retenue).toBe(300); // 300,015 → 300
    expect(calculerRetenue(0.1 + 0.2, 50).retenue).toBe(0);
  });
  it("un taux nul ou un montant nul ne retient rien", () => {
    expect(calculerRetenue(50_000, 0)).toMatchObject({ retenue: 0, net: 50_000 });
    expect(calculerRetenue(0, 10)).toMatchObject({ retenue: 0, net: 0 });
  });
});

describe("les taux — réglables, jamais présentés comme certains", () => {
  it("sans réglage : les défauts, marqués « à confirmer par le cabinet »", () => {
    const t = tauxEnVigueur([]);
    expect(t.HONORAIRES_MEDECIN).toEqual({ regime: "HONORAIRES_MEDECIN", taux: TAUX_RETENUE_DEFAUT.HONORAIRES_MEDECIN, confirmeParCabinet: false });
    expect(libelleTaux(t.PRESTATAIRE_ETRANGER)).toContain(MENTION_A_CONFIRMER);
  });
  it("le réglage du Super Admin l'emporte ; confirmé, la mention disparaît", () => {
    const t = tauxEnVigueur([{ regime: "HONORAIRES_MEDECIN", taux: 15, confirmeParCabinet: true }]);
    expect(t.HONORAIRES_MEDECIN.taux).toBe(15);
    expect(libelleTaux(t.HONORAIRES_MEDECIN)).toBe("15 %");
    expect(t.PRESTATAIRE_ETRANGER.confirmeParCabinet).toBe(false);
  });
  it("la saisie : un pourcentage entre 0 et 100", () => {
    expect(lireTauxSaisi("12,5")).toEqual({ ok: true, taux: 12.5 });
    expect(lireTauxSaisi("10 %")).toEqual({ ok: true, taux: 10 });
    expect(lireTauxSaisi("120").ok).toBe(false);
    expect(lireTauxSaisi("-1").ok).toBe(false);
    expect(lireTauxSaisi("").ok).toBe(false);
    expect(lireTauxSaisi("abc").ok).toBe(false);
  });
});

describe("le mois et la phrase", () => {
  it("le mois du paiement se lit à l'heure d'Alger", () => {
    expect(moisDeLaRetenue(new Date("2026-11-30T23:30:00Z"))).toBe("2026-12");
    expect(moisDeLaRetenue(new Date("2026-11-30T22:30:00Z"))).toBe("2026-11");
  });
  it("la phrase dit brut, retenue, net — et que le taux est à confirmer", () => {
    const p = phraseRetenue(calculerRetenue(100_000, 10), "HONORAIRES_MEDECIN", false);
    expect(p).toMatch(/Brut 100.000 DZD/);
    expect(p).toMatch(/10.000 DZD · net à verser 90.000 DZD/);
    expect(p).toContain(MENTION_A_CONFIRMER);
  });
  it("le total des retenues au centime", () => {
    expect(totalRetenues([{ montant: 0.1 }, { montant: 0.2 }])).toBe(0.3);
  });
});
