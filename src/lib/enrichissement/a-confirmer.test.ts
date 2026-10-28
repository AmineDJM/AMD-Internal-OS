import { describe, expect, it } from "vitest";
import { colonnesOrganisation, colonnesPersonne, peutTrancher, typeIdentifiantOrganisation } from "./a-confirmer";

describe("qui tranche un fait lu sur une pièce", () => {
  it("celui qui a déposé la pièce, et le Super Admin ; personne d'autre", () => {
    expect(peutTrancher({ userId: "u1", superAdmin: false }, { deposeParId: "u1" })).toBe(true);
    expect(peutTrancher({ userId: "u2", superAdmin: false }, { deposeParId: "u1" })).toBe(false);
    expect(peutTrancher({ userId: "u2", superAdmin: false }, { deposeParId: null })).toBe(false);
    expect(peutTrancher({ userId: "sa", superAdmin: true }, { deposeParId: null })).toBe(true);
  });
});

describe("ce qu'une confirmation écrit sur la fiche", () => {
  it("le nom, les prénoms, la date de naissance d'une Personne ; rien pour une coordonnée (historique seul)", () => {
    expect(colonnesPersonne("personne.nom", " BENALI ")).toEqual({ nom: "BENALI" });
    expect(colonnesPersonne("personne.naissance", "1984-04-12")?.naissance?.toISOString()).toBe("1984-04-12T00:00:00.000Z");
    expect(colonnesPersonne("personne.naissance", "12/04/1984")).toBeNull();
    expect(colonnesPersonne("personne.telephone", "+213555000000")).toBeNull();
  });
  it("la raison sociale d'une Organisation ; un NIF devient un identifiant", () => {
    expect(colonnesOrganisation("organisation.raisonSociale", "Imprimerie du Centre")).toEqual({ raisonSociale: "Imprimerie du Centre" });
    expect(typeIdentifiantOrganisation("organisation.nif")).toBe("NIF");
    expect(typeIdentifiantOrganisation("organisation.adresse")).toBeNull();
  });
});
