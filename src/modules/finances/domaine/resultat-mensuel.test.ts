import { describe, expect, it } from "vitest";
import { lirePeriode, resultatParMois, moisAlger, debutDuMoisAlger, finDeLaPeriodeAlger, PERIODE_MAX_MOIS } from "./resultat-mensuel";

/**
 * LE RÉSULTAT MENSUEL — la période se lit sans deviner, la paie compte dans son mois de paie, et
 * chaque écriture une seule fois (Direction, 04/10/2026).
 */
describe("lirePeriode", () => {
  it("6 mois par défaut, glissants jusqu'au mois courant", () => {
    const p = lirePeriode({}, "2026-10");
    expect(p.choix).toBe("6m");
    expect(p.mois).toEqual(["2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"]);
    expect(p.avertissement).toBeNull();
  });

  it("1 mois, 3 mois, 1 an — et une année qui se franchit", () => {
    expect(lirePeriode({ periode: "1m" }, "2026-10").mois).toEqual(["2026-10"]);
    expect(lirePeriode({ periode: "3m" }, "2026-02").mois).toEqual(["2025-12", "2026-01", "2026-02"]);
    const an = lirePeriode({ periode: "12m" }, "2026-10");
    expect(an.mois).toHaveLength(12);
    expect(an.debut).toBe("2025-11");
  });

  it("une période donnée du… au…, mois entiers", () => {
    const p = lirePeriode({ periode: "perso", du: "2026-01", au: "2026-03" }, "2026-10");
    expect(p.choix).toBe("perso");
    expect(p.mois).toEqual(["2026-01", "2026-02", "2026-03"]);
    expect(p.avertissement).toBeNull();
    const jours = lirePeriode({ periode: "perso", du: "2026-01-15", au: "2026-02-10" }, "2026-10");
    expect(jours.mois).toEqual(["2026-01", "2026-02"]);
    expect(jours.avertissement).toMatch(/au mois/);
  });

  it("ce qui ne se lit pas retombe sur 6 mois EN LE DISANT", () => {
    const inverse = lirePeriode({ periode: "perso", du: "2026-05", au: "2026-01" }, "2026-10");
    expect(inverse.choix).toBe("6m");
    expect(inverse.avertissement).toMatch(/après le dernier/);
    const manque = lirePeriode({ periode: "perso", du: "2026-05" }, "2026-10");
    expect(manque.avertissement).toMatch(/premier et le dernier mois/);
    const inconnue = lirePeriode({ periode: "2ans" }, "2026-10");
    expect(inconnue.avertissement).toMatch(/inconnue/);
    const longue = lirePeriode({ periode: "perso", du: "2020-01", au: "2026-01" }, "2026-10");
    expect(longue.avertissement).toMatch(new RegExp(`${PERIODE_MAX_MOIS} mois`));
    // Exactement la limite passe : elle accepte son propre chiffre.
    expect(lirePeriode({ periode: "perso", du: "2024-01", au: "2026-12" }, "2026-10").mois).toHaveLength(PERIODE_MAX_MOIS);
  });
});

describe("le mois d'Alger", () => {
  it("le 31 décembre à 23 h 30 UTC est déjà janvier à Alger", () => {
    expect(moisAlger(new Date("2026-12-31T23:30:00Z"))).toBe("2027-01");
    expect(moisAlger(new Date("2026-12-31T22:30:00Z"))).toBe("2026-12");
    expect(debutDuMoisAlger("2027-01").toISOString()).toBe("2026-12-31T23:00:00.000Z");
    expect(finDeLaPeriodeAlger(lirePeriode({ periode: "1m" }, "2026-12")).toISOString()).toBe("2026-12-31T23:00:00.000Z");
  });
});

describe("resultatParMois", () => {
  const periode = lirePeriode({ periode: "perso", du: "2026-09", au: "2026-10" }, "2026-10");
  const sept = new Date("2026-09-15T10:00:00Z");
  const oct = new Date("2026-10-03T10:00:00Z");

  it("LA PAIE DE SEPTEMBRE VIRÉE EN OCTOBRE est une dépense de SEPTEMBRE", () => {
    const r = resultatParMois({
      periode,
      ecritures: [
        { id: "paie", date: oct, direction: "OUT", amount: 500_000 },
        { id: "fournisseur", date: oct, direction: "OUT", amount: 100_000 },
        { id: "vente", date: sept, direction: "IN", amount: 1_000_000 },
      ],
      moisDePaie: new Map([["paie", "2026-09"]]),
      paieSansEcriture: [],
    });
    expect(r.lignes[0]).toMatchObject({ mois: "2026-09", recettes: 1_000_000, depenses: 500_000, dontPaie: 500_000, resultat: 500_000 });
    expect(r.lignes[1]).toMatchObject({ mois: "2026-10", depenses: 100_000, dontPaie: 0, resultat: -100_000 });
    expect(r.total).toEqual({ recettes: 1_000_000, depenses: 600_000, dontPaie: 500_000, resultat: 400_000 });
  });

  it("une écriture lue deux fois ne compte qu'une fois ; une paie hors période est écartée", () => {
    const r = resultatParMois({
      periode,
      ecritures: [
        { id: "paie", date: sept, direction: "OUT", amount: 300_000 },
        { id: "paie", date: sept, direction: "OUT", amount: 300_000 },
        { id: "paie-aout", date: sept, direction: "OUT", amount: 70_000 },
      ],
      moisDePaie: new Map([["paie", "2026-09"], ["paie-aout", "2026-08"]]),
      paieSansEcriture: [{ mois: "2026-10", montant: 45_000.5 }, { mois: "2026-12", montant: 9 }],
    });
    expect(r.lignes[0]!.depenses).toBe(300_000);
    expect(r.lignes[1]).toMatchObject({ depenses: 45_000.5, dontPaie: 45_000.5 });
    expect(r.total.depenses).toBe(345_000.5);
  });

  it("les centimes ne dérivent pas", () => {
    const r = resultatParMois({
      periode,
      ecritures: Array.from({ length: 10 }, (_, i) => ({ id: `e${i}`, date: sept, direction: "OUT" as const, amount: 0.1 })),
      moisDePaie: new Map(), paieSansEcriture: [],
    });
    expect(r.lignes[0]!.depenses).toBe(1);
  });
});
