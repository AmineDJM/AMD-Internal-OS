import { describe, expect, it } from "vitest";
import {
  detecterFractionnement, phraseFractionnement, seuilsDeFractionnement, type DemandeComparable,
} from "./fractionnement";

const jour = (n: number) => new Date(Date.UTC(2026, 10, 1 + n));
const d = (id: string, montant: number, j: number, extra: Partial<DemandeComparable> = {}): DemandeComparable => ({
  id, reference: id.toUpperCase(), montant, date: jour(j), demandeurId: "ali", beneficiaire: "SARL Atlas", ligneBudgetaire: null, ...extra,
});
const SEUILS = seuilsDeFractionnement({ adProDgThreshold: 1_000_000, bcValidationThreshold: 0, bcValidationThresholdCentre: 200_000 });

describe("anti-fractionnement — le cumul sur 30 jours du même demandeur", () => {
  it("trois demandes de 400 000 au même fournisseur en 20 jours franchissent la porte DG (1 M) — chacune sous le seuil", () => {
    const cible = d("c", 400_000, 20);
    const s = detecterFractionnement(cible, [d("a", 400_000, 0), d("b", 400_000, 10), cible], SEUILS);
    expect(s?.seuil.cle).toBe("DG_AD_PRO");
    expect(s?.cumul).toBe(1_200_000);
    expect(s?.liees.map((l) => l.id)).toEqual(["a", "b"]);
    expect(phraseFractionnement(s!)).toMatch(/Possible fractionnement : 3 demandes .* au même bénéficiaire .* 1\s200\s000 DZD, au-delà du seuil de 1\s000\s000 DZD \(porte du Directeur Général/);
  });

  it("le nom du bénéficiaire se compare casse, accents et espaces mis à part", () => {
    const cible = d("c", 600_000, 5, { beneficiaire: "sarl  atlas" });
    expect(detecterFractionnement(cible, [d("a", 600_000, 0, { beneficiaire: "SARL Atlas" })], SEUILS)?.cumul).toBe(1_200_000);
  });

  it("hors fenêtre de 30 jours, rien ne se cumule", () => {
    const cible = d("c", 600_000, 45);
    expect(detecterFractionnement(cible, [d("a", 600_000, 0)], SEUILS)?.seuil.cle).not.toBe("DG_AD_PRO");
  });

  it("la fenêtre est de 30 jours, pas de ±30 : deux voisines à J-25 et J+25 ne se cumulent pas ensemble", () => {
    const cible = d("c", 400_000, 30);
    // Chaque fenêtre de 30 jours ne contient que la cible et UNE voisine : 800 000, sous la porte DG.
    expect(detecterFractionnement(cible, [d("a", 400_000, 5), d("b", 400_000, 55)], SEUILS)).toBeNull();
    // Rapprochées dans un même mois, les trois la franchissent.
    expect(detecterFractionnement(cible, [d("a", 400_000, 5), d("b", 400_000, 34)], SEUILS)?.liees).toHaveLength(2);
  });

  it("un autre demandeur, ou un autre bénéficiaire sans ligne commune, ne lie rien", () => {
    const cible = d("c", 600_000, 5);
    expect(detecterFractionnement(cible, [d("a", 600_000, 0, { demandeurId: "zoe" })], SEUILS)).toBeNull();
    expect(detecterFractionnement(cible, [d("a", 600_000, 0, { beneficiaire: "Atlas" })], SEUILS)).toBeNull();
  });

  it("la même ligne budgétaire lie deux demandes à des bénéficiaires différents", () => {
    const cible = d("c", 600_000, 5, { beneficiaire: "Hôtel A", ligneBudgetaire: "L1" });
    const s = detecterFractionnement(cible, [d("a", 600_000, 0, { beneficiaire: "Hôtel B", ligneBudgetaire: "L1" })], SEUILS);
    expect(s?.liees[0].par).toBe("LIGNE_BUDGETAIRE");
    expect(phraseFractionnement(s!)).toMatch(/sur la même ligne budgétaire/);
  });

  it("une demande déjà au-dessus du seuil a franchi sa porte : elle n'est pas un fractionnement de ce seuil", () => {
    expect(detecterFractionnement(d("c", 1_200_000, 5), [d("a", 300_000, 0)], [SEUILS[0]])).toBeNull();
    expect(detecterFractionnement(d("c", 300_000, 5), [d("a", 1_200_000, 0)], [SEUILS[0]])).toBeNull();
  });

  it("un ordre sans demandeur nommé (émis par le système) ne lie personne", () => {
    const cible = d("c", 600_000, 5, { demandeurId: null });
    expect(detecterFractionnement(cible, [d("a", 600_000, 0, { demandeurId: null })], SEUILS)).toBeNull();
  });

  it("au seuil exact, la porte stricte n'est pas franchie ; la règle « à partir de » l'est", () => {
    const strict = seuilsDeFractionnement({ adProDgThreshold: 1_000_000, bcValidationThreshold: 0, bcValidationThresholdCentre: 0 });
    expect(detecterFractionnement(d("c", 500_000, 5), [d("a", 500_000, 0)], strict)).toBeNull();
    const regle = seuilsDeFractionnement({ adProDgThreshold: 0, bcValidationThreshold: 0, bcValidationThresholdCentre: 0, reglesDeValidation: [{ nom: "Gros achats", minAmount: 1_000_000 }] });
    expect(detecterFractionnement(d("c", 500_000, 5), [d("a", 500_000, 0)], regle)?.seuil.libelle).toMatch(/Gros achats/);
  });

  it("un seuil à 0 est désarmé : il n'y a rien à contourner", () => {
    expect(seuilsDeFractionnement({ adProDgThreshold: 0, bcValidationThreshold: 0, bcValidationThresholdCentre: 0 })).toEqual([]);
  });
});
