import { describe, expect, it } from "vitest";
import { censurerTexte, censurerObjet } from "./filtre-confidentialite";

describe("filtre-confidentialite — décision Q14", () => {
  it("laisse passer les textes métier normaux sans altération", () => {
    const texte = "Le dossier Paracétamol B/30 est actuellement en étape 3 auprès de l'ANPP.";
    const { texte: resultat, censure, occurrences } = censurerTexte(texte);
    expect(censure).toBe(false);
    expect(occurrences).toBe(0);
    expect(resultat).toBe(texte);
  });

  it("censure les mentions explicites de salaires", () => {
    const texte = "Son salaire net est de 180 000 DZD pour le poste de délégué.";
    const { texte: resultat, censure } = censurerTexte(texte);
    expect(censure).toBe(true);
    expect(resultat).not.toContain("180 000");
    expect(resultat).toContain("[CONFIDENTIEL]");
  });

  it("censure les montants suivis de net / brut", () => {
    const texte = "Proposition retenue : 250 000 DA net par mois.";
    const { texte: resultat, censure } = censurerTexte(texte);
    expect(censure).toBe(true);
    expect(resultat).not.toContain("250 000");
    expect(resultat).toContain("[CONFIDENTIEL]");
  });

  it("censure les coordonnées bancaires (IBAN et RIB)", () => {
    const iban = "DZ0000799999000123456789";
    const texte = `Effectuer le virement sur le compte ${iban} avant mardi.`;
    const { texte: resultat, censure } = censurerTexte(texte);
    expect(censure).toBe(true);
    expect(resultat).not.toContain(iban);
    expect(resultat).toContain("[CONFIDENTIEL]");
  });

  it("censure les numéros d'identification nationale (NIN 18 chiffres) et passeports", () => {
    const texte = "Numéro NIN : 123456789012345678 et Passeport N° A1234567B";
    const { texte: resultat, censure } = censurerTexte(texte);
    expect(censure).toBe(true);
    expect(resultat).not.toContain("123456789012345678");
    expect(resultat).not.toContain("A1234567B");
    expect(resultat).toContain("[CONFIDENTIEL]");
  });

  it("censure récursivement les clés sensibles dans un objet structuré", () => {
    const objet = {
      id: "emp-1",
      name: "Amine Djouamai",
      role: "SUPER_ADMIN",
      department: "Direction",
      baseSalary: 350000,
      rib: "00799900012345678901",
      coordonnees: {
        ville: "Alger",
        nationalId: "123456789012345678",
      },
    };

    const { resultat, censure } = censurerObjet(objet);
    expect(censure).toBe(true);
    expect(resultat.name).toBe("Amine Djouamai");
    expect(resultat.role).toBe("SUPER_ADMIN");
    expect(resultat.baseSalary).toBe("[CONFIDENTIEL]");
    expect(resultat.rib).toBe("[CONFIDENTIEL]");
    expect(resultat.coordonnees.ville).toBe("Alger");
    expect(resultat.coordonnees.nationalId).toBe("[CONFIDENTIEL]");
  });
});
