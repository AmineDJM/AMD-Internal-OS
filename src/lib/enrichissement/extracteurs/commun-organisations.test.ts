import { describe, it, expect } from "vitest";
import {
  comptesDans, estPersonne, fait, formeJuridiqueDans, ibanValide, identifiantsDans, lignesDe, masquer, montantDans, montantNormalise,
  normaliserAdresse, normaliserRaisonSociale, normaliserSiteWeb, normaliserTelephone, periodeDans, ribValide, sansDoublons, valeurEtiquetee,
} from "./commun-organisations";

// RIB à clé juste, anonymes (clé = 97 − ((agence + compte) × 100 mod 97)) ; le premier vient d'un devis réel déjà au dépôt.
const RIB_REEL = "00400364400003094607";
const RIB_BNA = "00100123012345678938";

describe("les comptes bancaires se vérifient avant d'être proposés", () => {
  it("la clé d'un RIB algérien : juste, puis abîmée d'un chiffre", () => {
    expect(ribValide(RIB_REEL)).toBe(true);
    expect(ribValide(RIB_BNA)).toBe(true);
    expect(ribValide("00799999001234567803")).toBe(true); // un RIP d'Algérie Poste suit la même règle
    expect(ribValide("00400364400003094608")).toBe(false);
    expect(ribValide("00400364400003094707")).toBe(false);
    expect(ribValide("0040036440000309460")).toBe(false); // 19 chiffres
  });

  it("l'IBAN : modulo 97, espaces et casse indifférents", () => {
    expect(ibanValide("FR76 3000 6000 0112 3456 7890 189")).toBe(true);
    expect(ibanValide("DZ40 0040 0364 4000 0309 4607")).toBe(true);
    expect(ibanValide("FR76 3000 6000 0112 3456 7890 188")).toBe(false);
  });

  it("un compte se lit groupé ou non, sous son étiquette ou sur la ligne suivante — jamais sur une ligne NIF", () => {
    const lignes = lignesDe([
      "NIF : 00081900878679319002",
      "RIB : 004 00364 4000030946 07",
      "Coordonnées bancaires :",
      "001 00123 0123456789 38",
      "IBAN FR76 3000 6000 0112 3456 7890 189",
    ].join("\n"));
    const comptes = comptesDans(lignes);
    expect(comptes.map((c) => [c.type, c.valeur, c.valide])).toEqual([
      ["RIB", RIB_REEL, true],
      ["RIB", RIB_BNA, true],
      ["IBAN", "FR7630006000011234567890189", true],
    ]);
  });
});

describe("le fait : catalogue fermé, sensibilité recopiée, preuve sensible masquée", () => {
  it("un attribut hors catalogue est une faute du code", () => {
    expect(() => fait({ sujetRef: "x", role: "EMETTEUR", attribut: "organisation.couleur", valeur: "bleu", valeurNormalisee: "bleu", confiance: 1, page: null, extrait: "" })).toThrow(/hors catalogue/);
  });

  it("un RIB est sensible et sa preuve ne le recopie pas", () => {
    const f = fait({ sujetRef: "emetteur", role: "EMETTEUR", attribut: "organisation.rib", valeur: RIB_REEL, valeurNormalisee: RIB_REEL, confiance: 0.95, page: 1, extrait: "RIB : 004 00364 4000030946 07" });
    expect(f?.sensible).toBe(true);
    expect(f?.sujetType).toBe("ORGANISATION");
    expect(f?.preuve.extrait).not.toContain("4000030946");
    expect(f?.preuve.extrait).toBe("RIB : •04 •••64 ••••••••46 07");
    expect(masquer("Tél 0550 12 34 56")).toBe("Tél ••50 12 34 56");
  });

  it("une valeur vide ne fait pas de fait ; les doublons gardent la meilleure confiance", () => {
    expect(fait({ sujetRef: "x", role: "EMETTEUR", attribut: "organisation.nif", valeur: "  ", valeurNormalisee: "", confiance: 1, page: null, extrait: "" })).toBeNull();
    const a = fait({ sujetRef: "x", role: "EMETTEUR", attribut: "organisation.nif", valeur: "001", valeurNormalisee: "001", confiance: 0.6, page: null, extrait: "a" });
    const b = fait({ sujetRef: "x", role: "EMETTEUR", attribut: "organisation.nif", valeur: "0 01", valeurNormalisee: "001", confiance: 0.9, page: null, extrait: "b" });
    expect(sansDoublons([a, null, b])).toEqual([b]);
  });
});

describe("les normalisations", () => {
  it("le téléphone en E.164 : fixe, mobile, international, (0), et ce qui n'en est pas un", () => {
    expect(normaliserTelephone("021 23 45 67")).toBe("+21321234567");
    expect(normaliserTelephone("0550 12 34 56")).toBe("+213550123456");
    expect(normaliserTelephone("+213 (0) 21 23 45 67")).toBe("+21321234567");
    expect(normaliserTelephone("00213 661 22 33 44")).toBe("+213661223344");
    expect(normaliserTelephone("036 81 41 41 (42)")).toBe("+21336814141");
    expect(normaliserTelephone("+33 1 45 67 89 10")).toBe("+33145678910");
    expect(normaliserTelephone("12 34")).toBeNull();
    expect(normaliserTelephone("0123 456 789 012")).toBeNull();
  });

  it("raison sociale, adresse, site web", () => {
    expect(normaliserRaisonSociale("SARL Imprimerie du Centre")).toBe(normaliserRaisonSociale("IMPRIMERIE DU CENTRE"));
    expect(normaliserAdresse("12, Rue Didouche-Mourad, ALGER")).toBe("12 rue didouche mourad alger");
    expect(normaliserSiteWeb("https://www.sac-cardio.dz/congres/")).toBe("sac-cardio.dz/congres");
  });

  it("les formes juridiques, en toutes lettres ou en sigle majuscule — pas « spa » d'un hôtel", () => {
    expect(formeJuridiqueDans("Société à responsabilité limitée")).toBe("SARL");
    expect(formeJuridiqueDans("ATLAS MÉDICAL S.A.R.L")).toBe("SARL");
    expect(formeJuridiqueDans("Entreprise unipersonnelle à responsabilité limitée")).toBe("EURL");
    expect(formeJuridiqueDans("SPA PROMBATI HOTEL")).toBe("SPA");
    expect(formeJuridiqueDans("Hôtel & spa des Pins")).toBeNull();
  });

  it("personne ou organisation", () => {
    expect(estPersonne("M. BENALI Karim")).toBe(true);
    expect(estPersonne("Dr Amel KHELIL")).toBe(true);
    expect(estPersonne("SARL Atlas Médical")).toBe(false);
    expect(estPersonne("Imprimerie du Centre")).toBe(false);
    expect(estPersonne("BOUDIAF Nadir")).toBeNull();
  });

  it("un montant et sa devise ; un nombre ambigu n'en est pas un", () => {
    expect(montantDans("1 000 000,00 DA")).toMatchObject({ valeur: 1_000_000, devise: "DZD" });
    expect(montantDans("2 500 000 dinars algériens")).toMatchObject({ valeur: 2_500_000, devise: "DZD" });
    expect(montantNormalise({ valeur: 1_000_000, devise: "DZD" })).toBe("1000000.00 DZD");
    expect(montantDans("1.200")).toBeNull();
  });
});

describe("le texte : pages, étiquettes, identifiants, périodes", () => {
  it("la page vient des sauts de page ; sans eux, elle n'est pas inventée", () => {
    expect(lignesDe("a\nb").map((l) => l.page)).toEqual([null, null]);
    // Un saut au milieu d'une ligne ne la coupe pas (les rangs restent ceux du repérage des en-têtes).
    expect(lignesDe("a\nb\fc\nd").map((l) => [l.texte, l.page])).toEqual([["a", 1], ["b c", 1], ["d", 2]]);
    expect(lignesDe("a\n\fb").map((l) => l.page)).toEqual([1, 2]);
  });

  it("une valeur d'étiquette sur sa ligne, sur la suivante, ou dans sa colonne", () => {
    const lignes = lignesDe("Raison sociale :\n  ATLAS MÉDICAL SARL\nForme juridique : SARL   |   Capital : 1 000 000 DA");
    expect(valeurEtiquetee(lignes, /^raison\s+sociale\s*:?\s*/)?.valeur).toBe("ATLAS MÉDICAL SARL");
    expect(valeurEtiquetee(lignes, /^forme\s+juridique\s*:?\s*/)?.valeur).toBe("SARL");
    expect(valeurEtiquetee(lignes, /^capital\s*:?\s*/)?.valeur).toBe("1 000 000 DA");
  });

  it("les identifiants d'une phrase de contrat", () => {
    const ids = identifiantsDans(lignesDe("immatriculée au registre du commerce sous le n° 16/00-0012345 B 15, NIF : 001516001234567, NIS 001516010012345, article d'imposition 16012345678"));
    expect(ids.map((x) => [x.champ, x.valeur])).toEqual([
      ["RC", "16000012345B15"],
      ["NIF", "001516001234567"],
      ["NIS", "001516010012345"],
      ["AI", "16012345678"],
    ]);
  });

  it("« rc » ou « ai » en minuscules dans une phrase ne sont pas des identifiants", () => {
    expect(identifiantsDans(lignesDe("j'ai 12345678 raisons"))).toEqual([]);
  });

  it("les périodes d'un programme", () => {
    const p = (t: string) => { const r = periodeDans(lignesDe(t)); return r ? [r.debut, r.fin] : null; };
    expect(p("Du 12 au 14 novembre 2026")).toEqual(["2026-11-12", "2026-11-14"]);
    expect(p("12-14 novembre 2026, Oran")).toEqual(["2026-11-12", "2026-11-14"]);
    expect(p("Les 12, 13 et 14 novembre 2026")).toEqual(["2026-11-12", "2026-11-14"]);
    expect(p("Du 30 novembre au 2 décembre 2026")).toEqual(["2026-11-30", "2026-12-02"]);
    expect(p("du 12/11/2026 au 14/11/2026")).toEqual(["2026-11-12", "2026-11-14"]);
    expect(p("Le 1er décembre 2026")).toEqual(["2026-12-01", "2026-12-01"]);
    expect(p("Programme scientifique")).toBeNull();
  });
});
