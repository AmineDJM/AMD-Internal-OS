import { describe, expect, it } from "vitest";
import {
  cleNomPersonne, cleOrganisation, clePhonetiquePersonne, comparerNoms, extraireTelephones, motsDuNom, nomComplet, normaliserArticleImposition,
  normaliserEmail, normaliserNifStrict, normaliserNis, normaliserRcStrict, normaliserTelephone, normaliserWilaya, plier,
} from "@/lib/referentiels/normalisation";

/**
 * Les cas sont des graphies RÉELLES relevées dans les annuaires de l'ERP (noms et numéros anonymisés :
 * les formes sont vraies, les personnes ne le sont pas).
 */

describe("plier", () => {
  it("retire accents, casse et ponctuation ; tirets et apostrophes séparent", () => {
    expect(plier("  Aït-Ahmed  ")).toBe("ait ahmed");
    expect(plier("M'Hamed")).toBe("m hamed");
    expect(plier("BÉJAÏA")).toBe("bejaia");
    expect(plier(null)).toBe("");
  });
});

describe("noms de personnes — clé orthographique", () => {
  const memeCle: [string, string][] = [
    ["Dr BENALI Ahmed", "Ahmed Benali"],
    ["Ahmed Ben Ali", "BENALI AHMED"],
    ["Pr. Karim Aït-Ahmed", "Karim Ait Ahmed"],
    ["Mme Fatma Zohra Ould Ali", "Ould-Ali Fatma Zohra"],
    ["Abd El Kader Brahimi", "Abdelkader BRAHIMI"],
    ["Abdel Kader Brahimi", "Brahimi Abdelkader"],
    ["Med Saidi", "Mohamed SAIDI"],
    ["Docteur Chérif Raihana", "Raihana Cherif"],
    ["M. Bel Kacem Nabil", "Nabil Belkacem"],
    ["Mlle Yasmine Bou Mediene", "Boumediene Yasmine"],
  ];
  it.each(memeCle)("« %s » = « %s »", (a, b) => {
    expect(cleNomPersonne(a)).toBe(cleNomPersonne(b));
  });

  it("garde distinct ce qui l'est", () => {
    expect(cleNomPersonne("Ben Ali")).not.toBe(cleNomPersonne("Ali"));
    expect(cleNomPersonne("Mohamed Benali")).not.toBe(cleNomPersonne("Mahmoud Benali"));
  });

  it("retire titres et initiales, rend vide un nom sans mot", () => {
    expect(motsDuNom("Dr A. Benali")).toEqual(["benali"]);
    expect(cleNomPersonne("Dr")).toBe("");
    expect(cleNomPersonne("M.")).toBe("");
    expect(cleNomPersonne("")).toBe("");
  });

  it("une particule en dernier mot reste un mot", () => {
    expect(motsDuNom("Ali Ben")).toEqual(["ali", "ben"]);
  });
});

describe("noms de personnes — clé phonétique (translittérations arabe → latin)", () => {
  const memePhon: [string, string][] = [
    ["Benali", "Bin Ali"],
    ["Benali", "Ben Aly"],
    ["Mohamed", "Mohammed"],
    ["Mohamed", "Muhammad"],
    ["Mohamed", "Mohamad"],
    ["Abdelkader", "Abdulkader"],
    ["Abdelkader", "Abd El Kader"],
    ["Abdallah", "Abdellah"],
    ["Abdallah", "Abd Allah"],
    ["Khaled", "Khalid"],
    ["Karim", "Kerim"],
    ["Youcef", "Youssef"],
    ["Youcef", "Yusuf"],
    ["Yacine", "Yassine"],
    ["Kacem", "Kassem"],
    ["Belkacem", "Belkassem"],
    ["Djamel", "Jamel"],
    ["Djamila", "Jamila"],
    ["Chérif", "Sherif"],
    ["Aicha", "Aïcha"],
    ["Amine", "Amin"],
    ["Amel", "Amal"],
    ["Mustapha", "Moustafa"],
    ["Boumediene", "Boumedienne"],
    ["Hadj Ahmed Lamia", "Lamya Hadj-Ahmed"],
  ];
  it.each(memePhon)("« %s » ≈ « %s »", (a, b) => {
    expect(clePhonetiquePersonne(a)).toBe(clePhonetiquePersonne(b));
  });

  const distincts: [string, string][] = [
    ["Karim", "Karima"],
    ["Amin", "Amina"],
    ["Nabil", "Nabila"],
    ["Said", "Saidi"],
    ["Brahim", "Brahimi"],
    ["Hamid", "Hamidi"],
    ["Mohamed", "Mahmoud"],
    ["Amina", "Yamina"],
    ["Ben Ali", "Ali"],
  ];
  it.each(distincts)("« %s » ≠ « %s »", (a, b) => {
    expect(clePhonetiquePersonne(a)).not.toBe(clePhonetiquePersonne(b));
  });
});

describe("comparerNoms", () => {
  it("IDENTIQUE quel que soit l'ordre et les titres", () => {
    expect(comparerNoms("Dr BENALI Ahmed", "Ahmed Ben Ali")).toBe("IDENTIQUE");
  });
  it("PHONETIQUE pour une autre graphie", () => {
    expect(comparerNoms("Mohammed Benali", "Muhammad Bin Ali")).toBe("PHONETIQUE");
  });
  it("COMPATIBLE avec un second prénom", () => {
    expect(comparerNoms("Mohamed Benali", "Mohamed Amine Benali")).toBe("COMPATIBLE");
  });
  it("PARTIEL quand l'un ne porte que le nom de famille", () => {
    expect(comparerNoms("Dr Benali", "Ahmed Benali")).toBe("PARTIEL");
  });
  it("DIFFERENT et INCONNU", () => {
    expect(comparerNoms("Ahmed Benali", "Karim Haddad")).toBe("DIFFERENT");
    expect(comparerNoms("Ahmed Benali", "Ahmed Haddad")).toBe("DIFFERENT");
    expect(comparerNoms("", "Ahmed Haddad")).toBe("INCONNU");
  });
});

describe("nomComplet", () => {
  it("prend la colonne complète si elle a deux mots, sinon nom + prénom", () => {
    expect(nomComplet({ complet: "Dr Ahmed Benali", nom: "Benali", prenom: "Ahmed" })).toBe("Dr Ahmed Benali");
    expect(nomComplet({ complet: "Benali", nom: "Benali", prenom: "Ahmed" })).toBe("Ahmed Benali");
    expect(nomComplet({ nom: "BENALI", prenom: null })).toBe("BENALI");
  });
});

describe("téléphones algériens → E.164", () => {
  const mobiles: [string, string][] = [
    ["0555 12 34 56", "+213555123456"],
    ["0555123456", "+213555123456"],
    ["+213 (0)5 55 12 34 56", "+213555123456"],
    ["+213 555 12 34 56", "+213555123456"],
    ["00213555123456", "+213555123456"],
    ["213555123456", "+213555123456"],
    ["555 12 34 56", "+213555123456"],
    ["06.61.23.45.67", "+213661234567"],
    ["07-70-11-22-33", "+213770112233"],
  ];
  it.each(mobiles)("mobile « %s » → %s", (v, e164) => {
    expect(normaliserTelephone(v)).toEqual({ e164, nature: "MOBILE" });
  });

  const fixes: [string, string][] = [
    ["021 23 45 67", "+21321234567"],
    ["(021) 23-45-67", "+21321234567"],
    ["+213 21 23 45 67", "+21321234567"],
    ["031 92 11 00", "+21331921100"],
    ["041.33.22.11", "+21341332211"],
  ];
  it.each(fixes)("fixe « %s » → %s", (v, e164) => {
    expect(normaliserTelephone(v)).toEqual({ e164, nature: "FIXE" });
  });

  it("un numéro étranger reste tel quel", () => {
    expect(normaliserTelephone("+33 6 12 34 56 78")).toEqual({ e164: "+33612345678", nature: "ETRANGER" });
    expect(normaliserTelephone("0033 1 45 67 89 00")).toEqual({ e164: "+33145678900", nature: "ETRANGER" });
  });

  it.each(["", "0000000000", "12345", "0555 12 34", "08 12 34 56 78", "N/A", "0555123456789", "+213 0000000000"])("illisible « %s » → null", (v) => {
    expect(normaliserTelephone(v)).toBeNull();
  });

  it("plusieurs numéros dans un champ", () => {
    expect(extraireTelephones("0661-23-45-67 / 021.23.45.67").map((t) => t.e164)).toEqual(["+213661234567", "+21321234567"]);
    expect(extraireTelephones("Tél : 0770112233 ; Fax : 041 33 22 11").map((t) => t.nature)).toEqual(["MOBILE", "FIXE"]);
    expect(extraireTelephones("0555 12 34 56 et 0555 12 34 56")).toHaveLength(1);
    expect(extraireTelephones(null)).toEqual([]);
  });
});

describe("e-mails", () => {
  it("plie la casse et `mailto:`", () => {
    expect(normaliserEmail("mailto:Ahmed.BENALI@chu-oran.dz")?.cle).toBe("ahmed.benali@chu-oran.dz");
  });
  it("Gmail : sans points ni « +étiquette », googlemail = gmail", () => {
    expect(normaliserEmail("Ahmed.Benali+pro@GoogleMail.com")?.cle).toBe("ahmedbenali@gmail.com");
    expect(normaliserEmail("a.benali@yahoo.fr")?.cle).toBe("a.benali@yahoo.fr");
  });
  it("reconnaît une boîte générique et un webmail", () => {
    expect(normaliserEmail("contact@saidal.dz")).toMatchObject({ generique: true, webmail: false, domaine: "saidal.dz" });
    expect(normaliserEmail("secretariat.chu@gmail.com")?.generique).toBe(false);
    expect(normaliserEmail("Secretariat@chu-oran.dz")?.generique).toBe(true);
    expect(normaliserEmail("dr.benali@gmail.com")).toMatchObject({ generique: false, webmail: true });
  });
  it("rejette ce qui n'est pas une adresse", () => {
    expect(normaliserEmail("benali@")).toBeNull();
    expect(normaliserEmail("")).toBeNull();
  });
});

describe("identifiants d'organisation", () => {
  it("NIF : chiffres, 15 à 20, sans les zéros de « néant »", () => {
    expect(normaliserNifStrict("001 916 012 345 678")).toBe("001916012345678");
    expect(normaliserNifStrict("000000000000000")).toBeNull();
    expect(normaliserNifStrict("NEANT")).toBeNull();
  });
  it("RC : lettres et chiffres en majuscules", () => {
    expect(normaliserRcStrict("16/00-1234567 B 21")).toBe(normaliserRcStrict("16/00-1234567B21"));
    expect(normaliserRcStrict("00/00-0000000")).toBeNull();
  });
  it("NIS et article d'imposition", () => {
    expect(normaliserNis("0 9991 6012 3456 78")).toBe("099916012345678");
    expect(normaliserNis("néant")).toBeNull();
    expect(normaliserArticleImposition("16 01 2345 678")).toBe("16012345678");
    expect(normaliserArticleImposition("123")).toBeNull();
  });
});

describe("cleOrganisation", () => {
  it("retire la forme juridique et recolle les sigles", () => {
    expect(cleOrganisation("C.H.U Mustapha-Pacha")).toBe("chu mustapha pacha");
    expect(cleOrganisation("Hetero Labs SARL")).toBe(cleOrganisation("HETERO LABS"));
    expect(cleOrganisation("S.P.A Prombati Hotel")).toBe("prombati hotel");
  });
});

describe("wilayas", () => {
  it.each([
    ["16 - Alger", "alger"], ["Alger", "alger"], ["Wilaya d'Alger", "alger"], ["Algiers", "alger"],
    ["Béjaïa", "bejaia"], ["Bougie", "bejaia"], ["06", "bejaia"], ["31", "oran"], ["Tizi-Ouzou", "tizi ouzou"],
    ["BBA", "bordj bou arreridj"], ["M'Sila", "msila"],
  ])("« %s » → %s", (v, w) => {
    expect(normaliserWilaya(v)).toBe(w);
  });
  it("vide → null", () => {
    expect(normaliserWilaya("  ")).toBeNull();
    expect(normaliserWilaya(null)).toBeNull();
  });
});
