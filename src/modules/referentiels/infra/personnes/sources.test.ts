import { describe, expect, it } from "vitest";
import {
  completude, complements, idPersonnePour, identiteDepuis, lireLigne, nomReplie, refDe, roleApporte, separerTitre, SELECTION,
} from "./sources";

/** Ce que chaque table dit d'une personne — et surtout ce qu'elle ne dit pas (aucune donnée sensible, aucun devinage). */
describe("Les sources de Personnes", () => {
  it("l'identifiant d'une Personne née d'une racine est déterministe, et distinct d'une racine à l'autre", () => {
    expect(idPersonnePour("User:a")).toBe(idPersonnePour("User:a"));
    expect(idPersonnePour("User:a")).not.toBe(idPersonnePour("Employee:a"));
    expect(idPersonnePour(refDe("MedicalDoctor", "x"))).toMatch(/^per_[0-9a-f]{25}$/);
  });

  it("le titre écrit devant le nom devient la civilité ; un libellé seul n'est pas découpé en nom / prénoms", () => {
    expect(separerTitre("Dr BENALI Ahmed")).toEqual({ civilite: "Dr", reste: "BENALI Ahmed" });
    expect(separerTitre("Pr. Kaci Rym")).toEqual({ civilite: "Pr", reste: "Kaci Rym" });
    expect(separerTitre("Mohamed Amine")).toEqual({ civilite: null, reste: "Mohamed Amine" });
    expect(identiteDepuis({ libelle: "Benali Ahmed" })).toMatchObject({ nom: "Benali Ahmed", prenoms: null });
    expect(identiteDepuis({ nom: "Benali", prenom: "Ahmed" })).toMatchObject({ nom: "Benali", prenoms: "Ahmed" });
    expect(identiteDepuis({ nom: "  ", prenom: null, libelle: "" })).toBeNull();
  });

  it("la clé de recherche replie, trie et retire les titres", () => {
    expect(nomReplie({ nom: "BENALI", prenoms: "Ahmed" })).toBe(nomReplie({ nom: "Ahmed Ben Ali", prenoms: null }));
  });

  it("les racines sont les liens que l'ERP porte déjà, et seulement eux", () => {
    const e = lireLigne("Employee", { id: "e1", personneId: null, fullName: "Kaci Rym", birthDate: new Date("1990-01-02"), userId: "u1" });
    expect(e.racine).toEqual({ source: "User", id: "u1" });
    expect(e.identite?.naissance?.toISOString().slice(0, 10)).toBe("1990-01-02");
    expect(lireLigne("CareBeneficiary", { id: "b", personneId: null, lastName: null, firstName: null, doctorId: "d1" }).racine).toEqual({ source: "MedicalDoctor", id: "d1" });
    expect(lireLigne("RecruitmentCandidate", { id: "c", personneId: null, fullName: "X Y", employeeId: "e1" }).racine).toEqual({ source: "Employee", id: "e1" });
    expect(lireLigne("AdProVoyageur", { id: "v", personneId: null, nom: "Benali", prenom: "Ahmed" }).racine).toBeNull();
  });

  it("le compte technique et la fiche d'un tiers ne deviennent pas des personnes", () => {
    expect(lireLigne("User", { id: "u", personneId: null, name: "Adam", isSystem: true }).ignorer).toBe("compte technique");
    expect(lireLigne("DirectoryEntry", { id: "d", personneId: null, displayName: "Biopharm", userId: null, employeeId: null, contactId: "c" }).ignorer).toMatch(/tiers/);
  });

  it("le professeur devient « Pr » ; les autres titres universitaires ne se devinent pas", () => {
    expect(lireLigne("MedicalDoctor", { id: "m", personneId: null, name: "BENALI Ahmed", lastName: null, firstName: null, title: "PROFESSEUR" }).identite?.civilite).toBe("Pr");
    expect(lireLigne("MedicalDoctor", { id: "m", personneId: null, name: "BENALI Ahmed", lastName: null, firstName: null, title: "ASSISTANT" }).identite?.civilite).toBeNull();
  });

  it("aucune colonne sensible n'est lue par la reprise", () => {
    const colonnes = Object.values(SELECTION).flatMap((s) => Object.keys(s));
    for (const sensible of ["iban", "nationalId", "cnasNumber", "baseSalary", "grossSalary", "passwordHash"]) expect(colonnes).not.toContain(sensible);
  });

  it("une reprise complète les champs vides, n'écrase jamais", () => {
    const apport = { nom: "X", prenoms: "Ahmed", civilite: "Dr", naissance: new Date("1980-01-01") };
    expect(complements({ prenoms: null, civilite: "Pr", naissance: null }, apport)).toEqual({ prenoms: "Ahmed", naissance: apport.naissance });
    expect(complements({ prenoms: "Amine", civilite: "Pr", naissance: new Date() }, apport)).toEqual({});
  });

  it("la complétude compte les attributs attendus renseignés", () => {
    expect(completude({ nom: "X" })).toBe(20);
    expect(completude({ nom: "X", prenoms: "Y", civilite: "Dr", naissance: new Date(), nationalite: "DZ" })).toBe(100);
  });

  it("l'entrée d'annuaire d'un collègue n'en fait pas un « contact d'un tiers »", () => {
    expect(roleApporte({ source: "DirectoryEntry", racine: { source: "User", id: "u" } })).toBeNull();
    expect(roleApporte({ source: "DirectoryEntry", racine: null })).toBe("CONTACT_TIERS");
    expect(roleApporte({ source: "AdProHebergement", racine: null })).toBe("VOYAGEUR");
  });
});
