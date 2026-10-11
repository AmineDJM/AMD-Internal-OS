import { describe, it, expect } from "vitest";
import { NATURES, NATURE_NON_RENSEIGNEE, natureDeLaDepense, repartirParNature } from "./natures";

describe("la nature d'une dépense — lue, jamais devinée", () => {
  it("le poste Ad & Pro dit la nature", () => {
    expect(natureDeLaDepense({ poste: "TICKETING" })).toBe(NATURES.BILLETTERIE);
    expect(natureDeLaDepense({ poste: "ACCOMMODATION" })).toBe(NATURES.HOTELLERIE);
    expect(natureDeLaDepense({ poste: "ASSOCIATION_SUPPORT" })).toBe(NATURES.SPONSORING_DIRECT);
    expect(natureDeLaDepense({ poste: "DINNER" })).toBe(NATURES.REPAS);
  });
  it("les cases d'une prise en charge disent la nature quand elles concordent", () => {
    expect(natureDeLaDepense({ services: ["REGISTRATION", "REGISTRATION"] })).toBe(NATURES.INSCRIPTIONS);
    expect(natureDeLaDepense({ services: ["HOTEL", "TICKET"] })).toBe(NATURE_NON_RENSEIGNEE);
  });
  it("la rubrique comptable ne compte que si elle dit une nature ; sinon « Non renseignée »", () => {
    expect(natureDeLaDepense({ rubrique: "VOYAGE" })).toBe(NATURES.DEPLACEMENTS);
    expect(natureDeLaDepense({ rubrique: "EVENEMENT" })).toBe(NATURE_NON_RENSEIGNEE);
    expect(natureDeLaDepense({})).toBe(NATURE_NON_RENSEIGNEE);
  });
  it("un ordre qui paie billet et hôtel se répartit au prorata des montants LUS des cases", () => {
    const r = repartirParNature(1000, [{ service: "TICKET", montant: 600 }, { service: "HOTEL", montant: 200 }]);
    expect(r).toEqual([{ nature: NATURES.BILLETTERIE, montant: 750 }, { nature: NATURES.HOTELLERIE, montant: 250 }]);
  });
  it("sans montant sur les cases, rien n'est réparti au hasard", () => {
    expect(repartirParNature(1000, [{ service: "TICKET", montant: null }, { service: "HOTEL", montant: null }])).toEqual([{ nature: NATURE_NON_RENSEIGNEE, montant: 1000 }]);
  });
});
