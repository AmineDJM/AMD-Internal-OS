import { describe, expect, it } from "vitest";
import {
  refusSoumissionBC, refusValidationFinale, validateursDuFormulaire, lireSourceBC, type BCASoumettre,
} from "./prevalidation";

const bc = (p: Partial<BCASoumettre> = {}): BCASoumettre => ({ kind: "PURCHASE_ORDER", status: "ACTIVE", signe: false, porte: null, retenuPar: null, ...p });

describe("refusSoumissionBC — ce qu'on peut soumettre à une pré-validation", () => {
  it("accepte un BC neuf ou qui attend encore son centre", () => {
    expect(refusSoumissionBC(bc())).toBeNull();
    expect(refusSoumissionBC(bc({ porte: "EN_ATTENTE" }))).toBeNull();
    expect(refusSoumissionBC(bc({ porte: "A_REVOIR" }))).toBeNull();
  });
  it("refuse ce qu'un centre a déjà décidé, ce qui est signé ou annulé, et ce qui n'est pas un BC", () => {
    expect(refusSoumissionBC(bc({ porte: "VALIDE" }))).toMatch(/déjà validé/);
    expect(refusSoumissionBC(bc({ porte: "REFUSE" }))).toMatch(/refusé/);
    expect(refusSoumissionBC(bc({ signe: true }))).toMatch(/signé/);
    expect(refusSoumissionBC(bc({ status: "CANCELLED" }))).toMatch(/annulé/);
    expect(refusSoumissionBC(bc({ kind: "CONTRACT" }))).toMatch(/pas un bon de commande/);
  });
  it("refuse un BC déjà retenu par une AUTRE demande, pas par la sienne", () => {
    expect(refusSoumissionBC(bc({ retenuPar: "v1" }), "v2")).toMatch(/autre demande/);
    expect(refusSoumissionBC(bc({ retenuPar: "v1" }), "v1")).toBeNull();
  });
});

describe("refusValidationFinale — le CTA du demandeur", () => {
  const demandeur = { id: "u1", role: "MEDICAL_DELEGATE" };
  it("s'ouvre quand tous les validateurs ont accepté et que le BC est encore retenu", () => {
    expect(refusValidationFinale({ statut: "APPROVED", demandeurId: "u1", retenu: true }, demandeur)).toBeNull();
  });
  it("reste fermé tant que la pré-validation n'est pas acquise", () => {
    expect(refusValidationFinale({ statut: "PENDING", demandeurId: "u1", retenu: true }, demandeur)).toMatch(/pas encore accepté/);
    expect(refusValidationFinale({ statut: "REJECTED", demandeurId: "u1", retenu: true }, demandeur)).toMatch(/refusée/);
    expect(refusValidationFinale({ statut: "CHANGES_REQUESTED", demandeurId: "u1", retenu: true }, demandeur)).toMatch(/modification/);
  });
  it("ne se demande qu'une fois, et seulement par le demandeur (ou le Super Admin)", () => {
    expect(refusValidationFinale({ statut: "APPROVED", demandeurId: "u1", retenu: false }, demandeur)).toMatch(/déjà été demandée/);
    expect(refusValidationFinale({ statut: "APPROVED", demandeurId: "u1", retenu: true }, { id: "u2", role: "DIRECTION" })).toMatch(/Seul le demandeur/);
    expect(refusValidationFinale({ statut: "APPROVED", demandeurId: "u1", retenu: true }, { id: "sa", role: "SUPER_ADMIN" })).toBeNull();
  });
});

describe("validateursDuFormulaire — principal d'abord, sans doublon", () => {
  it("garde l'ordre et retire les vides et les doublons", () => {
    expect(validateursDuFormulaire(["a", "", "b", "a", null, " c "])).toEqual(["a", "b", "c"]);
  });
});

describe("lireSourceBC", () => {
  it("ne reconnaît que les trois sources", () => {
    expect(lireSourceBC("LEGAL")).toBe("LEGAL");
    expect(lireSourceBC("COMPOSER")).toBe("COMPOSER");
    expect(lireSourceBC("autre")).toBeNull();
    expect(lireSourceBC(null)).toBeNull();
  });
});
