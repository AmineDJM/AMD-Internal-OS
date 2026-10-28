import { describe, expect, it } from "vitest";
import {
  candidatDeCompany, candidatDeCompanyContact, candidatDeMedicalInstitution, candidatDeSupplier, candidatDeTexte,
  cleTexteOrganisation, formeJuridiqueDuNom, idOrganisationDeFiche, idOrganisationDeTexte, identifiantsFiscaux,
  paysDepuisTexte, roleDepuisLeNom, roleDuPartenaire,
} from "./candidats";

describe("d'une fiche à son organisation", () => {
  it("l'identifiant est déterministe : la même fiche donne toujours la même organisation", () => {
    expect(idOrganisationDeFiche("SUPPLIER", "abc")).toBe("org-su-abc");
    expect(idOrganisationDeFiche("SUPPLIER", "abc")).not.toBe(idOrganisationDeFiche("COMPANY_CONTACT", "abc"));
    expect(idOrganisationDeTexte("societe algerienne cardiologie")).toBe(idOrganisationDeTexte("societe algerienne cardiologie"));
    expect(idOrganisationDeTexte("a")).not.toBe(idOrganisationDeTexte("b"));
  });

  it("la société du groupe prend sa dénomination au registre, son nom d'usage en nom court, ses quatre identifiants", () => {
    const c = candidatDeCompany({
      name: "Adventum", shortName: null,
      legalIdentity: { legalName: "ADVENTUM PHARMA SPA", legalForm: "spa", nif: "0016 1234 5678 901", nis: "1234 5678 9012 345", rcNumber: "16/00-1234567 B 12", taxArticle: "16123456789", website: "adventum.dz" },
    });
    expect(c.raisonSociale).toBe("ADVENTUM PHARMA SPA");
    expect(c.nomCourt).toBe("Adventum");
    expect(c.formeJuridique).toBe("SPA");
    expect(c.roles).toEqual(["SOCIETE_DU_GROUPE"]);
    expect(c.identifiants.map((i) => i.type)).toEqual(["NIF", "NIS", "RC", "AI"]);
    expect(c.identifiants[0]).toEqual({ type: "NIF", valeur: "0016 1234 5678 901", valeurNormalisee: "001612345678901" });
  });

  it("un identifiant illisible ou saisi « néant » n'identifie personne", () => {
    expect(identifiantsFiscaux({ nif: "000000000000000", rc: "néant", nis: "", ai: "12" })).toEqual([]);
  });

  it("deux saisies du même NIF ont la même valeur normalisée — la clé d'unicité", () => {
    const [a] = identifiantsFiscaux({ nif: "001 612 345 678 901" });
    const [b] = identifiantsFiscaux({ nif: "001612345678901" });
    expect(a.valeurNormalisee).toBe(b.valeurNormalisee);
  });

  it("le rôle d'un partenaire : la sphère publique est une autorité, sinon sa nature le dit", () => {
    expect(roleDuPartenaire("Imprimeur", "PUBLIC")).toBe("AUTORITE");
    expect(roleDuPartenaire("Agence de voyage", "PRIVE")).toBe("AGENCE");
    expect(roleDuPartenaire("Livreur", "PRIVE")).toBe("TRANSPORTEUR");
    expect(roleDuPartenaire("Imprimeur", "PRIVE")).toBe("FOURNISSEUR");
    expect(candidatDeCompanyContact({ name: "Imprimerie du Centre SARL", kind: "Imprimeur", sphere: "PRIVE", website: null, nif: null, rc: null }).formeJuridique).toBe("SARL");
  });

  it("un fournisseur Regulatory est fournisseur et laboratoire, dans son pays — jamais deviné", () => {
    expect(candidatDeSupplier({ name: "Hetero Labs", country: "Inde", website: null })).toMatchObject({ pays: "IN", roles: ["FOURNISSEUR", "LABORATOIRE"] });
    expect(paysDepuisTexte("Atlantide")).toBe("ZZ");
    expect(paysDepuisTexte(null, "ZZ")).toBe("ZZ");
    expect(paysDepuisTexte("fr")).toBe("FR");
  });

  it("un établissement est un établissement de santé ; le grossiste répartiteur est un client", () => {
    expect(candidatDeMedicalInstitution({ name: "CHU Mustapha", type: "CHU" }).roles).toEqual(["ETABLISSEMENT_SANTE"]);
    expect(candidatDeMedicalInstitution({ name: "Biopure", type: "GROSSISTE" }).roles).toEqual(["CLIENT"]);
  });
});

describe("les textes « institution » des demandes", () => {
  it("deux graphies du même nom ont la même clé (accents, casse, sigles, forme juridique)", () => {
    expect(cleTexteOrganisation("C.H.U Mustapha-Pacha")).toBe(cleTexteOrganisation("chu mustapha pacha"));
    expect(cleTexteOrganisation("Société Algérienne de Cardiologie")).toBe(cleTexteOrganisation("societe algerienne de cardiologie"));
  });

  it("un texte qui ne désigne personne n'a pas de clé : on ne réunit pas tous les CHU en un", () => {
    for (const t of ["", "   ", "Néant", "CHU", "Clinique médicale", "Association", "Autre", null]) expect(cleTexteOrganisation(t)).toBeNull();
  });

  it("le rôle que le nom laisse lire — AUTRE quand rien n'est reconnu", () => {
    expect(roleDepuisLeNom("Société Algérienne de Cardiologie")).toBe("SOCIETE_SAVANTE");
    expect(roleDepuisLeNom("Association des diabétiques de Blida")).toBe("SOCIETE_SAVANTE");
    expect(roleDepuisLeNom("Société algérienne de distribution")).toBe("AUTRE");
    expect(roleDepuisLeNom("CHU Mustapha")).toBe("ETABLISSEMENT_SANTE");
    expect(roleDepuisLeNom("Ministère de la Santé")).toBe("AUTORITE");
    expect(roleDepuisLeNom("Groupe Benali")).toBe("AUTRE");
    expect(candidatDeTexte("  Société  Algérienne de Cardiologie ").raisonSociale).toBe("Société Algérienne de Cardiologie");
  });

  it("la forme juridique est lue dans le nom, points compris", () => {
    expect(formeJuridiqueDuNom("S.P.A Biopharm")).toBe("SPA");
    expect(formeJuridiqueDuNom("Biopharm")).toBeNull();
  });
});
