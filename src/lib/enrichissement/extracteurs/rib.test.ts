import { describe, it, expect } from "vitest";
import type { FaitExtrait } from "@/lib/enrichissement/types";
import { NATURES_LOCALES } from "@/lib/enrichissement/types";
import { extraireRib, MOTEUR_RIB } from "./rib";

// RIB anonymisés, à clé juste (clé = 97 − ((agence + compte) × 100 mod 97)).
const RIB_SOCIETE = [
  "CRÉDIT POPULAIRE D'ALGÉRIE",
  "RELEVÉ D'IDENTITÉ BANCAIRE",
  "Titulaire du compte : SARL ATLAS MÉDICAL DISTRIBUTION",
  "Agence : Bab Ezzouar (00610)",
  "Code banque   Code agence   N° de compte   Clé RIB",
  "003           00610         0300112233     90",
  "IBAN : DZ40 0040 0364 4000 0309 4607",
].join("\n");

const RIB_PERSONNE = [
  "Algérie Poste",
  "Relevé d'identité postale",
  "Au nom de : M. BENALI Karim",
  "RIP : 007 99999 0012345678 03",
].join("\n");

const de = (faits: FaitExtrait[], attribut: string) => faits.filter((f) => f.attribut === attribut);

describe("le RIB d'une société", () => {
  const r = extraireRib({ texte: RIB_SOCIETE });

  it("une pièce locale, lue par règles", () => {
    expect(NATURES_LOCALES).toContain("RIB");
    expect(r).toMatchObject({ nature: "RIB", moteur: MOTEUR_RIB, local: true });
  });

  it("le titulaire, la banque (reconnue à l'en-tête) et son agence", () => {
    expect(de(r.faits, "organisation.raisonSociale")[0]).toMatchObject({ role: "TITULAIRE", valeur: "SARL ATLAS MÉDICAL DISTRIBUTION", confiance: 0.85 });
    expect(de(r.faits, "organisation.banque")[0]).toMatchObject({ valeur: "Crédit Populaire d'Algérie (CPA) — agence Bab Ezzouar (00610)", confiance: 0.65 });
  });

  it("le RIB en tableau et l'IBAN : sensibles, vérifiés, preuves masquées", () => {
    const comptes = de(r.faits, "organisation.rib");
    expect(comptes.map((c) => c.valeurNormalisee).sort()).toEqual(["00300610030011223390", "DZ4000400364400003094607"]);
    for (const c of comptes) {
      expect(c.sensible).toBe(true);
      expect(c.confiance).toBe(0.95);
      expect(c.preuve.extrait).not.toMatch(/\d{4,}/);
    }
  });
});

describe("le RIP d'une personne", () => {
  const r = extraireRib({ texte: RIB_PERSONNE });

  it("le compte va à la personne (`personne.rib`), le nom tel qu'imprimé, sans civilité", () => {
    expect(de(r.faits, "personne.rib")[0]).toMatchObject({ sujetType: "PERSONNE", valeur: "00799999001234567803", sensible: true });
    expect(de(r.faits, "personne.nom")[0]).toMatchObject({ valeur: "BENALI Karim", confiance: 0.55 });
    expect(r.faits.some((f) => f.sujetType === "ORGANISATION")).toBe(false);
  });

  it("la banque d'une personne n'a pas d'attribut : dite, pas proposée", () => {
    expect(r.notes.some((n) => n.includes("Algérie Poste (CCP)") && n.includes("non proposée"))).toBe(true);
  });
});

describe("ce qui ne se propose pas", () => {
  it("une clé fausse : aucun compte, et la note ne recopie pas le numéro", () => {
    const r = extraireRib({ texte: RIB_PERSONNE.replace("0012345678 03", "0012345679 03") });
    expect(de(r.faits, "personne.rib")).toEqual([]);
    const note = r.notes.find((n) => n.includes("clé de contrôle est fausse"));
    expect(note).toBeDefined();
    expect(note).not.toMatch(/\d{5,}/);
  });

  it("un titulaire sans civilité ni forme : lu comme organisation, à confiance réduite, et dit", () => {
    const r = extraireRib({ texte: "BNA — Banque Nationale d'Algérie\nIntitulé du compte : BOUDIAF NADIR\nRIB : 001 00123 0123456789 38" });
    expect(de(r.faits, "organisation.rib")[0].confiance).toBe(0.57);
    expect(r.notes.some((n) => n.includes("ni comme une personne"))).toBe(true);
  });

  it("l'appelant qui sait (pièce déposée sur une fiche Personne) tranche", () => {
    const r = extraireRib({ texte: "Intitulé du compte : BOUDIAF NADIR\nRIB : 001 00123 0123456789 38", titulaire: "PERSONNE" });
    expect(de(r.faits, "personne.rib")[0].confiance).toBe(0.95);
  });

  it("un relevé sans étiquette : la suite de vingt chiffres est le compte", () => {
    const r = extraireRib({ texte: "Banque : BADR agence Cheraga\nTitulaire : EURL OUEST PRINT\n001 00123 0123456789 38" });
    expect(de(r.faits, "organisation.rib")[0].valeur).toBe("00100123012345678938");
    expect(de(r.faits, "organisation.banque")[0]).toMatchObject({ valeur: "BADR agence Cheraga", confiance: 0.85 });
  });

  it("aucun compte lisible : dit", () => {
    const r = extraireRib({ texte: "Titulaire : SARL TEST\nRIB : illisible" });
    expect(r.faits.some((f) => f.sensible)).toBe(false);
    expect(r.notes).toContain("Aucun RIB (20 chiffres) ni IBAN ne se lit sur la pièce.");
  });
});
