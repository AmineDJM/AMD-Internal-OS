import { describe, expect, it } from "vitest";
import { consigneDuTour, tourDeLaDeclaration, TOURS_DU_PHARMACIEN } from "./parcours";
import { lirePostesPourDeclaration } from "./declaration-postes";

/**
 * « À FAIRE — INFORMATION MÉDICALE » (Direction, 23/11/2026) — le TOUR d'un dossier se déduit de sa frise : la lecture en
 * validation est chez le Directeur des Opérations, pas « à déclarer » chez le pharmacien ; et un brouillon jamais soumis ne
 * retient plus la déclaration.
 */
describe("le tour d'une déclaration", () => {
  const base = { lot: "A_DEMANDER" as const, bonsChezPharmacien: true };

  it("la lecture : à soumettre (ou à reprendre) chez le pharmacien, en validation chez le Directeur des Opérations", () => {
    expect(tourDeLaDeclaration({ ...base, courante: "DECLARER", lecture: "A_DEMANDER" })).toBe("LECTURE");
    expect(tourDeLaDeclaration({ ...base, courante: "DECLARER", lecture: "A_REVOIR" })).toBe("LECTURE");
    expect(tourDeLaDeclaration({ ...base, courante: "DECLARER", lecture: "REFUSEE" })).toBe("LECTURE");
    expect(tourDeLaDeclaration({ ...base, courante: "DECLARER", lecture: "EN_VALIDATION" })).toBe("CHEZ_DO");
  });

  it("le dépôt ANPP, la validation du pharmacien, la validation finale, les pièces", () => {
    expect(tourDeLaDeclaration({ ...base, courante: "DEPOT", lecture: "ACCORDEE" })).toBe("DEPOT");
    expect(tourDeLaDeclaration({ ...base, courante: "PHARMACIEN", lecture: "ACCORDEE" })).toBe("VALIDER");
    expect(tourDeLaDeclaration({ ...base, courante: "DIRECTION", lecture: "ACCORDEE" })).toBe("CHEZ_DO");
    expect(tourDeLaDeclaration({ ...base, courante: "PIECES", lecture: "ACCORDEE" })).toBe("PIECES");
    expect(tourDeLaDeclaration({ ...base, courante: null, lecture: "ACCORDEE" }), "validé : plus rien à faire").toBeNull();
  });

  it("les bons de versement : chez le pharmacien, en validation, ou en paiement", () => {
    expect(tourDeLaDeclaration({ courante: "BONS", lecture: "A_DEMANDER", lot: "A_DEMANDER", bonsChezPharmacien: true })).toBe("BONS");
    expect(tourDeLaDeclaration({ courante: "BONS", lecture: "A_DEMANDER", lot: "EN_VALIDATION", bonsChezPharmacien: false })).toBe("CHEZ_DO");
    expect(tourDeLaDeclaration({ courante: "BONS", lecture: "A_DEMANDER", lot: "QUITTANCE_A_DEMANDER", bonsChezPharmacien: false })).toBe("AILLEURS");
  });

  it("« À vous » : la lecture, le dépôt, la validation, les bons — jamais ce qui attend les autres", () => {
    expect([...TOURS_DU_PHARMACIEN].sort()).toEqual(["BONS", "DEPOT", "LECTURE", "VALIDER"]);
  });

  it("une phrase par tour, qui nomme l'ANPP", () => {
    const i = { lecture: "ACCORDEE" as const, intentSkip: false, circuit: "EVENT" as const, chez: null };
    expect(consigneDuTour("DEPOT", i)).toBe("Déposez la déclaration à l'ANPP, joignez le récépissé, enregistrez la référence, puis validez.");
    expect(consigneDuTour("VALIDER", { ...i, intentSkip: true })).toMatch(/^Sans déclaration accordée : validez/);
    expect(consigneDuTour("LECTURE", { ...i, lecture: "A_DEMANDER" })).toMatch(/ANPP/);
    expect(consigneDuTour("PIECES", { ...i, chez: "Amel A." })).toBe("Pièces attendues — chez Amel A. : relancez si elles tardent.");
  });
});

describe("les postes au regard de la déclaration", () => {
  const p = (status: string, extra: Partial<{ voie: string; agence: boolean; montant: number }> = {}) => ({
    status, voie: extra.voie ?? null, amountGranted: extra.montant ?? 1000, amountEstimated: null,
    execution: { agenceRetenueAt: extra.agence ? new Date() : null },
  });

  it("UN BROUILLON NE BLOQUE PAS : seuls les postes soumis comptent (un refusé non plus)", () => {
    const l = lirePostesPourDeclaration([p("APPROVED"), p("DRAFT"), p("REJECTED")]);
    expect(l).toMatchObject({ total: 1, valides: 1, prets: true, brouillons: 1, blocages: [] });
    expect(l.montant).toBe(1000);
  });

  it("ce qui retient l'ouverture se dit : en attente, à revoir, agence à choisir", () => {
    const l = lirePostesPourDeclaration([p("APPROVED"), p("PENDING"), p("REVISION"), p("APPROVED", { voie: "AGENCE" }), p("DRAFT")]);
    expect(l.prets).toBe(false);
    expect(l).toMatchObject({ total: 4, valides: 1, brouillons: 1 });
    expect(l.blocages).toEqual([
      "1 poste en attente de la Direction Marketing",
      "1 poste à revoir par le demandeur",
      "1 poste « agence » sans agence choisie",
    ]);
  });

  it("que des brouillons : rien de soumis, rien ne s'ouvre", () => {
    expect(lirePostesPourDeclaration([p("DRAFT")])).toMatchObject({ total: 0, prets: false, blocages: ["aucun poste soumis"], brouillons: 1 });
  });
});
