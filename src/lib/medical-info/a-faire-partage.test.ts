import { describe, expect, it } from "vitest";
import { consigneDuTour, tourDeLaDeclaration, TOURS_DU_PHARMACIEN } from "./parcours";
import { lirePostesPourDeclaration, passeParUnDevis } from "./declaration-postes";

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
  /** Par défaut : un poste d'imprimerie dont le devis est validé — ce qui le rend prêt une fois accordé. */
  const p = (status: string, extra: Partial<{ voie: string; agence: boolean; montant: number; kind: string; devis: boolean }> = {}) => ({
    status, kind: extra.kind ?? "PRINTING", voie: extra.voie ?? null, amountGranted: extra.montant ?? 1000, amountEstimated: null,
    execution: { agenceRetenueAt: extra.agence ? new Date() : null }, devisValide: extra.devis ?? true,
  });

  it("LE DEVIS VALIDÉ D'ABORD (recette 24/11/2026) : un poste accordé sans devis validé retient la déclaration, et le montant ne le compte pas", () => {
    const l = lirePostesPourDeclaration([p("APPROVED", { montant: 1000 }), p("APPROVED", { montant: 500, devis: false }), p("APPROVED", { montant: 200, devis: false })]);
    expect(l).toMatchObject({ total: 3, valides: 1, prets: false, montant: 1000, blocages: ["2 postes accordés dont le devis n'est pas encore validé"] });
    expect(lirePostesPourDeclaration([p("APPROVED", { devis: false })]).blocages).toEqual(["1 poste accordé dont le devis n'est pas encore validé"]);
    // Un devis validé sur un poste pas encore accordé ne le rend pas prêt : l'accord reste exigé.
    expect(lirePostesPourDeclaration([p("PENDING", { devis: true })])).toMatchObject({ prets: false, valides: 0, blocages: ["1 poste en attente de la Direction Marketing"] });
  });

  it("UN POSTE SANS DEVIS est prêt dès qu'il est accordé : le sponsoring direct à l'association, la voie « direct », le matériel du stock", () => {
    const association = p("APPROVED", { kind: "ASSOCIATION_SUPPORT", devis: false, montant: 300_000 });
    expect(lirePostesPourDeclaration([association])).toMatchObject({ total: 1, valides: 1, prets: true, montant: 300_000, blocages: [] });
    expect(lirePostesPourDeclaration([p("APPROVED", { voie: "DIRECT", devis: false })]).prets).toBe(true);
    expect(lirePostesPourDeclaration([p("APPROVED", { kind: "STOCK_MATERIAL", devis: false, montant: 0 })]).prets).toBe(true);
    expect(passeParUnDevis({ kind: "ASSOCIATION_SUPPORT", voie: null })).toBe(false);
    expect(passeParUnDevis({ kind: "PRINTING", voie: "DIRECT" })).toBe(false);
    expect(passeParUnDevis({ kind: "STOCK_MATERIAL", voie: null })).toBe(false);
    expect(passeParUnDevis({ kind: "PRINTING", voie: null })).toBe(true);
    expect(passeParUnDevis({ kind: "STAND", voie: "AGENCE" })).toBe(true);
    // Le sponsoring direct accordé à côté d'un poste dont le devis attend : c'est ce dernier qui retient.
    expect(lirePostesPourDeclaration([association, p("APPROVED", { devis: false })])).toMatchObject({ valides: 1, prets: false });
  });

  it("UN POSTE « AGENCE » : l'agence choisie (qui valide les lignes retenues) le rend prêt — sans agence, il retient", () => {
    expect(lirePostesPourDeclaration([p("APPROVED", { voie: "AGENCE", agence: true, devis: true })]).prets).toBe(true);
    expect(lirePostesPourDeclaration([p("APPROVED", { voie: "AGENCE", agence: false, devis: false })]).blocages).toEqual(["1 poste « agence » sans agence choisie"]);
  });

  it("UN BROUILLON RETIENT LA DÉCLARATION et le dit ; un refusé ne compte pas", () => {
    const l = lirePostesPourDeclaration([p("APPROVED"), p("DRAFT"), p("REJECTED")]);
    expect(l).toMatchObject({ total: 2, valides: 1, prets: false, brouillons: 1, blocages: ["1 poste en brouillon — à soumettre ou à supprimer"] });
    expect(lirePostesPourDeclaration([p("APPROVED"), p("REJECTED")])).toMatchObject({ total: 1, valides: 1, prets: true, blocages: [] });
    expect(l.montant).toBe(1000);
  });

  it("ce qui retient l'ouverture se dit : en attente, à revoir, agence à choisir", () => {
    const l = lirePostesPourDeclaration([p("APPROVED"), p("PENDING"), p("REVISION"), p("APPROVED", { voie: "AGENCE" }), p("DRAFT")]);
    expect(l.prets).toBe(false);
    expect(l).toMatchObject({ total: 5, valides: 1, brouillons: 1 });
    expect(l.blocages).toEqual([
      "1 poste en brouillon — à soumettre ou à supprimer",
      "1 poste en attente de la Direction Marketing",
      "1 poste à revoir par le demandeur",
      "1 poste « agence » sans agence choisie",
    ]);
  });

  it("que des brouillons : rien ne s'ouvre, et on dit pourquoi", () => {
    expect(lirePostesPourDeclaration([p("DRAFT")])).toMatchObject({ total: 1, prets: false, blocages: ["1 poste en brouillon — à soumettre ou à supprimer"], brouillons: 1 });
    expect(lirePostesPourDeclaration([])).toMatchObject({ total: 0, prets: false, blocages: ["aucun poste"] });
  });
});
