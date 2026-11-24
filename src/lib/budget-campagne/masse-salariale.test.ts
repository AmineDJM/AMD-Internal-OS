import { describe, expect, it } from "vitest";
import { CLES_RECONNUES, LIGNES_ADMINISTRATION, estPoleAdministration, fusionnerPrefill } from "./regles";
import { CLE_MS_CNAS, CLE_MS_IRG, cnasDeLaFiche, controleCoutEmployeur, prevoirMasseNette, repartirSelonProfil, retenuesDesFiches } from "./masse-salariale";

describe("masse salariale — au net + primes, sans double compte", () => {
  it("12 × le net des fiches + les primes de l'an passé, chacune au mois de son versement (pas « dernière paie × 12 »)", () => {
    const p = prevoirMasseNette([60_000, 40_000, null], [
      { mois: 11, net: 100_000, primes: 0 },
      { mois: 12, net: 200_000, primes: 100_000 }, // 13e mois de décembre
    ]);
    expect(p.base).toBe("FICHES");
    expect(p.netMensuel).toBe(100_000);
    expect(p.primesParMois[11]).toBe(100_000);
    expect(p.parMois[0]).toBe(100_000);
    expect(p.parMois[11]).toBe(200_000);
    expect(p.total).toBe(1_300_000); // et non 200 000 × 12
  });

  it("sans net sur les fiches, la dernière paie connue — primes retirées", () => {
    const p = prevoirMasseNette([null], [{ mois: 6, net: 90_000, primes: 30_000 }]);
    expect(p.base).toBe("PAIE");
    expect(p.netMensuel).toBe(60_000);
    expect(p.total).toBe(60_000 * 12 + 30_000);
    expect(prevoirMasseNette([], []).base).toBe("AUCUNE");
  });

  it("répartir selon un profil garde la saisonnalité, au centime ; sans profil, en douzièmes", () => {
    const profil = [...Array.from({ length: 11 }, () => 1), 2];
    const r = repartirSelonProfil(1300, profil);
    expect(r[0]).toBe(100);
    expect(r[11]).toBe(200);
    expect(Math.round(repartirSelonProfil(1000.01, profil).reduce((a, x) => a + x, 0) * 100)).toBe(100001);
    expect(repartirSelonProfil(1200, null)[5]).toBe(100);
    expect(repartirSelonProfil(1200, Array.from({ length: 12 }, () => 0))[5]).toBe(100);
  });

  it("la CNAS d'une fiche : retSS35 total (35 %) ou part patronale seule — le coût employeur tranche, sinon le rapport", () => {
    // brut 100 000 : SS 9 % = 9 000, IRG 15 000, net 76 000 ; patronal 26 000 → coût 126 000.
    const total = { net: 76_000, retIrg: 15_000, retSS9: 9_000, retSS35: 35_000, coutEmployeur: 126_000 };
    expect(cnasDeLaFiche(total)).toBe(35_000);
    const patronale = { ...total, retSS35: 26_000 };
    expect(cnasDeLaFiche(patronale)).toBe(35_000);
    expect(cnasDeLaFiche({ ...total, coutEmployeur: null })).toBe(35_000);
    expect(cnasDeLaFiche({ ...patronale, coutEmployeur: null })).toBe(35_000);
    expect(cnasDeLaFiche({ ...total, retSS35: null })).toBe(9_000);
  });

  it("les retenues d'une société et le contrôle : net + primes + IRG + CNAS = coût employeur", () => {
    const r = retenuesDesFiches([
      { net: 76_000, retIrg: 15_000, retSS9: 9_000, retSS35: 35_000, coutEmployeur: 126_000 },
      { net: 38_000, retIrg: 7_500, retSS9: 4_500, retSS35: 17_500, coutEmployeur: 63_000 },
    ]);
    expect(r).toEqual({ net: 114_000, irg: 22_500, cnas: 52_500, coutEmployeur: 189_000, salaries: 2 });
    const c = controleCoutEmployeur({ masseNette: 114_000 * 12 + 50_000, primes: 50_000, irg: r.irg * 12, cnas: r.cnas * 12, coutEmployeurFiches: r.coutEmployeur * 12 });
    expect(c.ecart).toBe(0);
    expect(c.boucle).toBe(true);
    // Une ligne « net + primes » prévue au coût employeur (l'ancien calcul) compterait IRG et CNAS deux fois : le contrôle le montre.
    expect(controleCoutEmployeur({ masseNette: 189_000 * 12, primes: 0, irg: r.irg * 12, cnas: r.cnas * 12, coutEmployeurFiches: 189_000 * 12 }).boucle).toBe(false);
  });

  it("la masse salariale hors force de vente, l'IRG et la CNAS ont une clé reconnue ; le profil suit la source au pré-remplissage", () => {
    expect(CLES_RECONNUES).toContain("MASSE_SALARIALE");
    expect([CLE_MS_IRG, CLE_MS_CNAS]).toEqual(["MS_IRG", "MS_CNAS"]);
    for (const k of [CLE_MS_IRG, CLE_MS_CNAS]) expect(CLES_RECONNUES).toContain(k);
    const profil = Array.from({ length: 12 }, () => 1);
    const { maj } = fusionnerPrefill(
      [{ key: "PAIE", source: "AUTO_PAIE", propose: 500, justification: null }],
      [{ key: "PAIE", label: "Masse salariale", categoryKey: "MASSE_SALARIALE", source: "AUTO_PAIE", realise2026: 10, propose: 900, profilMensuel: profil }],
    );
    expect(maj[0]).toMatchObject({ key: "PAIE", profilMensuel: profil });
    expect(maj[0]!.propose).toBeUndefined(); // le montant du pôle n'est pas écrasé
  });
});

describe("le budget de l'Administration", () => {
  it("ses lignes d'office : dons et mécénat, réserve pour imprévus, remboursement d'emprunt — vides, clés reconnues", () => {
    expect(LIGNES_ADMINISTRATION.map((l) => l.key)).toEqual(["DONS_MECENAT", "RESERVE_IMPREVUS", "REMBOURSEMENT_EMPRUNT"]);
    for (const l of LIGNES_ADMINISTRATION) {
      expect(l.propose).toBe(0);
      expect(CLES_RECONNUES).toContain(l.categoryKey);
    }
    expect(estPoleAdministration("Administration & Finances", "ADM")).toBe(true);
    expect(estPoleAdministration("Opérations", "OPS")).toBe(false);
  });
});
