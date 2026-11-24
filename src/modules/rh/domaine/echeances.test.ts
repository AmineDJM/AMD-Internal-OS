import { describe, expect, it } from "vitest";
import { echeancesDeLaFiche, finDEssai, type FicheEcheances } from "./echeances";

const J = (j: number) => new Date(Date.UTC(2026, 10, 24 + j));
const AUJOURDHUI = J(0);
const HORIZON = J(31);
const fiche = (p: Partial<FicheEcheances> = {}): FicheEcheances => ({
  fullName: "Samir Haddad", contractType: "CDD", contractEnd: null, trialEnd: null, trialRenewed: false, trialRenewalEnd: null,
  prochaineVisiteMedicale: null, ...p,
});

describe("les échéances d'une fiche salarié", () => {
  it("fin de CDD dans la fenêtre, et toujours là une fois dépassée (la fiche est encore active)", () => {
    expect(echeancesDeLaFiche(fiche({ contractEnd: J(20) }), AUJOURDHUI, HORIZON)).toEqual([{ genre: "contrat", libelle: "Fin de CDD — Samir Haddad", date: J(20) }]);
    expect(echeancesDeLaFiche(fiche({ contractEnd: J(-5) }), AUJOURDHUI, HORIZON)).toHaveLength(1);
    expect(echeancesDeLaFiche(fiche({ contractEnd: J(40) }), AUJOURDHUI, HORIZON)).toEqual([]);
  });

  it("un CDI n'a pas de fin, même si une date traîne sur la fiche", () => {
    expect(echeancesDeLaFiche(fiche({ contractType: "CDI", contractEnd: J(5) }), AUJOURDHUI, HORIZON)).toEqual([]);
    expect(echeancesDeLaFiche(fiche({ contractType: "STAGE", contractEnd: J(5) }), AUJOURDHUI, HORIZON)[0].libelle).toBe("Fin de stage — Samir Haddad");
  });

  it("la période d'essai renouvelée prime ; passée, elle ne se rappelle plus (l'essai est acquis)", () => {
    expect(finDEssai({ trialEnd: J(-10), trialRenewed: true, trialRenewalEnd: J(15) })).toEqual(J(15));
    expect(finDEssai({ trialEnd: J(10), trialRenewed: false, trialRenewalEnd: J(40) })).toEqual(J(10));
    expect(echeancesDeLaFiche(fiche({ trialEnd: J(0) }), AUJOURDHUI, HORIZON).map((e) => e.genre)).toEqual(["essai"]);
    expect(echeancesDeLaFiche(fiche({ trialEnd: J(-1) }), AUJOURDHUI, HORIZON)).toEqual([]);
  });

  it("la visite médicale du travail : dans la fenêtre, et en retard tant qu'aucune nouvelle date n'est saisie", () => {
    expect(echeancesDeLaFiche(fiche({ prochaineVisiteMedicale: J(-30) }), AUJOURDHUI, HORIZON)).toEqual([
      { genre: "visite", libelle: "Visite médicale du travail — Samir Haddad", date: J(-30) },
    ]);
  });
});
