import { describe, it, expect } from "vitest";
import type { FaitExtrait } from "@/lib/enrichissement/types";
import { extraireRegistre, natureRegistre, MOTEUR_REGISTRE } from "./registre-commerce";

// Un extrait du registre du commerce, OCR local, anonymisé — deux pages (saut de page `\f`).
const EXTRAIT_RC = [
  "RÉPUBLIQUE ALGÉRIENNE DÉMOCRATIQUE ET POPULAIRE",
  "Ministère du Commerce et de la Promotion des Exportations",
  "CENTRE NATIONAL DU REGISTRE DU COMMERCE — Antenne locale d'Alger (Hussein Dey)",
  "EXTRAIT DU REGISTRE DU COMMERCE",
  "Personne morale",
  "N° du registre du commerce : 16/00-0812345 B 08",
  "Dénomination : ATLAS MÉDICAL DISTRIBUTION",
  "Sigle : AMD-DISTRIB",
  "Forme juridique : Société à responsabilité limitée",
  "Capital social : 5 000 000,00 DA",
  "Siège social : Cité 1200 logements, Bt 14 n° 3, Bab Ezzouar, Alger",
  "\fActivités exercées : 407 001 Commerce de gros de produits pharmaceutiques",
  "Gérant : Monsieur HAMIDI Sofiane, né le 12/04/1979 à Blida",
  "Fait à Alger le 03/02/2026",
  "Le préposé au registre",
].join("\n");

const CARTE_FISCALE = [
  "DIRECTION GÉNÉRALE DES IMPÔTS",
  "CARTE D'IMMATRICULATION FISCALE",
  "Numéro d'identification fiscale (NIF) : 0008 1600 1234 567",
  "Nom ou raison sociale : ATLAS MÉDICAL DISTRIBUTION SARL",
  "Adresse : Cité 1200 logements, Bab Ezzouar, Alger",
  "Article d'imposition : 16080123456",
  "Date de délivrance : 10/03/2008",
].join("\n");

const un = (faits: FaitExtrait[], attribut: string) => {
  const xs = faits.filter((f) => f.attribut === attribut);
  expect(xs, attribut).toHaveLength(1);
  return xs[0];
};

describe("la nature au titre", () => {
  it("registre, carte fiscale, attestation NIF — ou rien", () => {
    expect(natureRegistre(EXTRAIT_RC)).toBe("REGISTRE_COMMERCE");
    expect(natureRegistre(CARTE_FISCALE)).toBe("CARTE_IMMATRICULATION_FISCALE");
    expect(natureRegistre("ATTESTATION D'IMMATRICULATION FISCALE\nNIF : 000816001234567")).toBe("ATTESTATION_NIF");
    expect(natureRegistre("Bon de livraison")).toBeNull();
  });
});

describe("l'extrait du registre du commerce", () => {
  const r = extraireRegistre({ texte: EXTRAIT_RC });

  it("est lu localement, par règles", () => {
    expect(r).toMatchObject({ nature: "REGISTRE_COMMERCE", moteur: MOTEUR_REGISTRE, local: true });
    expect(r.faits.every((f) => f.sujetRef === "titulaire" && f.role === "TITULAIRE" && f.sujetType === "ORGANISATION")).toBe(true);
  });

  it("l'identité de la société, chaque valeur sous son étiquette", () => {
    expect(un(r.faits, "organisation.rc")).toMatchObject({ valeur: "16/00-0812345 B 08", valeurNormalisee: "16000812345B08", confiance: 0.95, preuve: { page: 1 } });
    expect(un(r.faits, "organisation.raisonSociale")).toMatchObject({ valeur: "ATLAS MÉDICAL DISTRIBUTION", confiance: 0.85 });
    expect(un(r.faits, "organisation.nomCommercial").valeur).toBe("AMD-DISTRIB");
    expect(un(r.faits, "organisation.formeJuridique").valeur).toBe("SARL");
    expect(un(r.faits, "organisation.capital")).toMatchObject({ valeur: "5 000 000,00 DA", valeurNormalisee: "5000000.00 DZD" });
    expect(un(r.faits, "organisation.adresse").valeur).toBe("Cité 1200 logements, Bt 14 n° 3, Bab Ezzouar, Alger");
  });

  it("le représentant, sans sa date de naissance, lu en page 2", () => {
    expect(un(r.faits, "organisation.representant")).toMatchObject({ valeur: "Monsieur HAMIDI Sofiane", preuve: { page: 2 } });
  });

  it("l'autorité qui délivre (CNRC, ministère) n'est jamais prise pour le titulaire", () => {
    expect(r.faits.some((f) => /centre national|ministere/i.test(f.valeur))).toBe(false);
    expect(r.faits.some((f) => f.sensible)).toBe(false);
  });
});

describe("la carte d'immatriculation fiscale", () => {
  const r = extraireRegistre({ texte: CARTE_FISCALE });

  it("NIF, AI, raison sociale (et la forme qu'elle porte), adresse", () => {
    expect(r.nature).toBe("CARTE_IMMATRICULATION_FISCALE");
    expect(un(r.faits, "organisation.nif")).toMatchObject({ valeurNormalisee: "000816001234567", confiance: 0.95 });
    expect(un(r.faits, "organisation.ai").valeurNormalisee).toBe("16080123456");
    expect(un(r.faits, "organisation.raisonSociale").valeurNormalisee).toBe("atlas medical distribution");
    expect(un(r.faits, "organisation.formeJuridique")).toMatchObject({ valeur: "SARL", confiance: 0.65 });
    expect(un(r.faits, "organisation.adresse").valeurNormalisee).toBe("cite 1200 logements bab ezzouar alger");
    expect(r.notes).toEqual([]);
  });
});

describe("ce qui ne se propose pas", () => {
  it("deux NIF différents : aucun", () => {
    const r = extraireRegistre({ texte: `${CARTE_FISCALE}\nNIF : 000916002345678`, nature: "ATTESTATION_NIF" });
    expect(r.faits.some((f) => f.attribut === "organisation.nif")).toBe(false);
    expect(r.notes.some((n) => n.startsWith("2 NIF différents"))).toBe(true);
  });

  it("un NIF trop court, un capital illisible : non proposés, et dit", () => {
    const r = extraireRegistre({ texte: "ATTESTATION NIF\nNIF : 12345\nRaison sociale : SARL TEST\nCapital social : 1.200" });
    expect(r.faits.some((f) => f.attribut === "organisation.nif")).toBe(false);
    expect(r.faits.some((f) => f.attribut === "organisation.capital")).toBe(false);
    expect(r.notes).toContain("Le NIF attendu sur cette pièce ne se lit pas (ou sa forme n'est pas reconnue).");
    expect(r.notes.some((n) => n.startsWith("Capital social illisible"))).toBe(true);
  });

  it("le n° d'immatriculation d'un registre est son RC", () => {
    const r = extraireRegistre({ texte: "EXTRAIT DU REGISTRE DU COMMERCE\nN° d'immatriculation : 31/00-0098765 A 12\nRaison sociale : EURL OUEST PRINT", nature: "REGISTRE_COMMERCE" });
    expect(un(r.faits, "organisation.rc").valeurNormalisee).toBe("31000098765A12");
    expect(un(r.faits, "organisation.formeJuridique").valeur).toBe("EURL");
  });
});
