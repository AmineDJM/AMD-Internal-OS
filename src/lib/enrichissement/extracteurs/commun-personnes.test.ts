import { describe, expect, it } from "vitest";
import {
  borner, decouperNom, dedoublonner, fait, LONGUEUR_MAX_EXTRAIT, LONGUEUR_MAX_VALEUR, normaliserDate,
  normaliserSite, normaliserTelephone, pageDe, paysIso3, paysMrz, separerCivilite, trouverTelephones,
} from "./commun-personnes";

describe("normaliserTelephone", () => {
  it.each([
    ["0550 12 34 56", "+213550123456"],
    ["06.61.22.33.44", "+213661223344"],
    ["07-70-11-22-33", "+213770112233"],
    ["021 23 45 67", "+21321234567"],
    ["+213 (0) 550 12 34 56", "+213550123456"],
    ["00213 661 22 33 44", "+213661223344"],
    ["+213 21 23 45 67", "+21321234567"],
    ["+33 6 12 34 56 78", "+33612345678"],
  ])("%s → %s", (brut, e164) => expect(normaliserTelephone(brut)).toBe(e164));

  it.each(["2015 - 2018", "16000", "0812 34 56 78", "1234567890"])("refuse « %s »", (brut) => expect(normaliserTelephone(brut)).toBeNull());

  it("recoupe deux numéros collés", () => {
    expect(trouverTelephones("Tél : 0550 12 34 56 - 0661 98 76 54").map((t) => t.e164)).toEqual(["+213550123456", "+213661987654"]);
  });
});

describe("normaliserDate", () => {
  it.each([
    ["12/03/1985", "1985-03-12"],
    ["12.03.1985", "1985-03-12"],
    ["1985-03-12", "1985-03-12"],
    ["12 mars 1985", "1985-03-12"],
    ["1er août 1990", "1990-08-01"],
    ["14 Février 1991", "1991-02-14"],
    ["March 5, 1980", "1980-03-05"],
    ["5 March 1980", "1980-03-05"],
  ])("%s → %s", (brut, iso) => expect(normaliserDate(brut)).toBe(iso));

  it.each(["31/02/1990", "12/13/1985", "mars 1985", "demain"])("refuse « %s »", (brut) => expect(normaliserDate(brut)).toBeNull());
});

describe("pays", () => {
  it("noms et gentilés FR/EN → alpha-3", () => {
    expect(paysIso3("Algérienne")).toBe("DZA");
    expect(paysIso3("ALGERIE")).toBe("DZA");
    expect(paysIso3("French")).toBe("FRA");
    expect(paysIso3("Tunisien.")).toBe("TUN");
    expect(paysIso3("Atlantide")).toBeNull();
  });
  it("codes MRZ : « D » → DEU, le reste tel quel", () => {
    expect(paysMrz("D<<")).toBe("DEU");
    expect(paysMrz("DZA")).toBe("DZA");
    expect(paysMrz("12A")).toBeNull();
  });
});

describe("fait", () => {
  it("recopie la sensibilité du catalogue, borne valeur et extrait, arrondit la confiance", () => {
    const f = fait({ sujetRef: "titulaire", sujetType: "PERSONNE", role: "TITULAIRE", attribut: "personne.nin", valeur: "x".repeat(500), valeurNormalisee: "1", confiance: 1.7, page: 1, extrait: "y".repeat(500) });
    expect(f.sensible).toBe(true);
    expect(f.valeur.length).toBe(LONGUEUR_MAX_VALEUR);
    expect(f.preuve.extrait.length).toBe(LONGUEUR_MAX_EXTRAIT);
    expect(f.confiance).toBe(1);
  });
  it("refuse un attribut hors catalogue ou d'un autre sujet", () => {
    const base = { sujetRef: "t", sujetType: "PERSONNE" as const, role: "TITULAIRE" as const, valeur: "v", valeurNormalisee: "v", confiance: 1, page: null, extrait: "" };
    expect(() => fait({ ...base, attribut: "personne.pointure" })).toThrow(/hors catalogue/);
    expect(() => fait({ ...base, attribut: "organisation.nif" })).toThrow(/sujet/);
  });
  it("dedoublonner garde la lecture la plus sûre", () => {
    const base = { sujetRef: "t", sujetType: "PERSONNE" as const, role: "TITULAIRE" as const, attribut: "personne.email", valeur: "a@b.dz", valeurNormalisee: "a@b.dz", page: 1, extrait: "" };
    const d = dedoublonner([fait({ ...base, confiance: 0.5 }), fait({ ...base, confiance: 0.9 })]);
    expect(d).toHaveLength(1);
    expect(d[0]!.confiance).toBe(0.9);
  });
});

describe("noms", () => {
  it("civilité en tête", () => {
    expect(separerCivilite("Pr. Ali Ouali")).toEqual({ civilite: "Pr", reste: "Ali Ouali" });
    expect(separerCivilite("Mme Nadia Bouzid")).toEqual({ civilite: "Mme", reste: "Nadia Bouzid" });
    expect(separerCivilite("Nadia Bouzid").civilite).toBeNull();
  });
  it("nom par la casse, puis par l'e-mail, sinon rien", () => {
    expect(decouperNom("BENALI Mohamed Amine")).toEqual({ nom: "BENALI", prenoms: "Mohamed Amine" });
    expect(decouperNom("Mohamed Amine BEN ALI")).toEqual({ nom: "BEN ALI", prenoms: "Mohamed Amine" });
    expect(decouperNom("Karim Haddad", "k.haddad@x.dz")).toEqual({ nom: "Haddad", prenoms: "Karim" });
    expect(decouperNom("Karim Haddad")).toBeNull();
    expect(decouperNom("Karim Haddad", "karim@x.dz")).toBeNull();
  });
});

describe("divers", () => {
  it("pageDe compte les sauts de page", () => {
    const t = "a\fb\fc";
    expect(pageDe(t, 0)).toBe(1);
    expect(pageDe(t, 2)).toBe(2);
    expect(pageDe(t, 4)).toBe(3);
    expect(pageDe(t, -1)).toBeNull();
  });
  it("borner et normaliserSite", () => {
    expect(borner("  a   b ", 10)).toBe("a b");
    expect(borner("abcdef", 4)).toBe("abc…");
    expect(normaliserSite("HTTPS://WWW.Exemple.DZ/")).toBe("exemple.dz");
  });
});
