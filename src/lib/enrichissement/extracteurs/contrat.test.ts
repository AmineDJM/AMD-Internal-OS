import { describe, it, expect } from "vitest";
import type { FaitExtrait } from "@/lib/enrichissement/types";
import { lireSyntheseModele } from "@/lib/pieces-lues/synthese-legale";
import { extraireContrat, MOTEUR_CONTRAT } from "./contrat";

// Un contrat de prestation, anonymisé — la formule des parties telle que les juristes l'écrivent.
const CONTRAT = [
  "CONTRAT DE PRESTATION DE SERVICES ÉVÉNEMENTIELS",
  "N° 2026/AP/047",
  "",
  "ENTRE LES SOUSSIGNÉS :",
  "La société ADVENTUM PHARMA, SARL au capital de 10 000 000,00 DA, dont le siège social est situé au",
  "Lot Bois des Cars 3, Dely Ibrahim, Alger, immatriculée au registre du commerce sous le n° 16/00-0012345 B 15,",
  "NIF 001516001234567, représentée par Monsieur Karim BOUZID, en sa qualité de Gérant,",
  "ci-après dénommée « le Client »,",
  "d'une part,",
  "ET :",
  "L'agence HORIZON ÉVÉNEMENTS EURL, au capital de 1 000 000,00 DA, sise au 22, boulevard Mohamed V, Oran,",
  "immatriculée au registre du commerce sous le n° 31/00-0456789 B 19, NIF : 001931004567890, NIS 001931010045678,",
  "représentée par Madame Lynda MEZIANE, agissant en qualité de Directrice générale,",
  "ci-après dénommée « le Prestataire »,",
  "d'autre part.",
  "",
  "IL A ÉTÉ CONVENU CE QUI SUIT :",
  "Article 1 — Objet. Le présent contrat a pour objet l'organisation logistique des Journées de cardiologie d'Oran. Le Prestataire s'y engage.",
  "Article 2 — Durée. Le contrat est conclu pour une durée de six (6) mois. Il prend effet à compter du 01/11/2026.",
  "Article 3 — Prix. Le montant global du contrat est fixé à 4 500 000,00 DA HT (quatre millions cinq cent mille dinars).",
  "Article 9 — Le contrat expire le 30/04/2027 sauf reconduction expresse.",
  "Fait en deux exemplaires à Alger, le 20 octobre 2026",
].join("\n");

const de = (faits: FaitExtrait[], sujetRef: string, attribut: string) => faits.filter((f) => f.sujetRef === sujetRef && f.attribut === attribut);
const un = (faits: FaitExtrait[], sujetRef: string, attribut: string) => {
  const xs = de(faits, sujetRef, attribut);
  expect(xs, `${sujetRef} / ${attribut}`).toHaveLength(1);
  return xs[0];
};

describe("les deux parties d'un contrat de prestation", () => {
  const r = extraireContrat({ texte: CONTRAT });

  it("lu localement, par règles", () => {
    expect(r).toMatchObject({ nature: "CONTRAT", moteur: MOTEUR_CONTRAT, local: true });
    expect(new Set(r.faits.map((f) => f.sujetRef))).toEqual(new Set(["partie-1", "partie-2"]));
    expect(r.faits.every((f) => f.role === "PARTIE" && !f.sensible)).toBe(true);
  });

  it("la première partie : raison sociale, forme, capital, siège, RC, NIF, représentant", () => {
    const f = r.faits;
    expect(un(f, "partie-1", "organisation.raisonSociale")).toMatchObject({ valeur: "ADVENTUM PHARMA", confiance: 0.75 });
    expect(un(f, "partie-1", "organisation.formeJuridique").valeur).toBe("SARL");
    expect(un(f, "partie-1", "organisation.capital").valeurNormalisee).toBe("10000000.00 DZD");
    expect(un(f, "partie-1", "organisation.adresse").valeur).toBe("Lot Bois des Cars 3, Dely Ibrahim, Alger");
    expect(un(f, "partie-1", "organisation.rc")).toMatchObject({ valeurNormalisee: "16000012345B15", confiance: 0.95 });
    expect(un(f, "partie-1", "organisation.nif").valeurNormalisee).toBe("001516001234567");
    expect(un(f, "partie-1", "organisation.representant")).toMatchObject({ valeur: "Monsieur Karim BOUZID (Gérant)", valeurNormalisee: "monsieur karim bouzid" });
  });

  it("la seconde partie, et la qualité que le contrat donne à chacune", () => {
    const f = r.faits;
    expect(un(f, "partie-2", "organisation.raisonSociale").valeur).toBe("HORIZON ÉVÉNEMENTS EURL");
    expect(un(f, "partie-2", "organisation.formeJuridique").valeur).toBe("EURL");
    expect(un(f, "partie-2", "organisation.adresse").valeur).toBe("22, boulevard Mohamed V, Oran");
    expect(un(f, "partie-2", "organisation.nis").valeurNormalisee).toBe("001931010045678");
    expect(un(f, "partie-2", "organisation.representant").valeur).toBe("Madame Lynda MEZIANE (Directrice générale)");
    expect(r.contrat.qualites).toEqual({ "partie-1": "le Client", "partie-2": "le Prestataire" });
  });

  it("les dates, la durée, l'objet et le montant — hors catalogue, rendus à côté avec leur preuve", () => {
    const c = r.contrat;
    expect(c.dateSignature?.valeur).toBe("2026-10-20");
    expect(c.dateDebut).toMatchObject({ valeur: "2026-11-01", source: "regles" });
    expect(c.dateFin?.valeur).toBe("2027-04-30");
    expect(c.duree?.valeur).toEqual({ nombre: 6, unite: "MOIS" });
    expect(c.objet?.valeur).toBe("l'organisation logistique des Journées de cardiologie d'Oran");
    expect(c.montant?.valeur).toMatchObject({ valeur: 4_500_000, devise: "DZD", taxes: "HT" });
    expect(c.montant?.extrait).toContain("4 500 000,00 DA HT");
  });
});

describe("la convention avec une personne, la synthèse du modèle", () => {
  const CONVENTION = [
    "CONVENTION D'ORATEUR",
    "Entre :",
    "La société ADVENTUM PHARMA, SARL, NIF 001516001234567,",
    "d'une part,",
    "Et :",
    "Monsieur le Docteur Samir HADDAD, cardiologue, demeurant à Constantine,",
    "d'autre part.",
    "La présente convention est conclue pour la période du 01/12/2026 au 31/12/2026.",
    "Les honoraires sont fixés à 150 000,00 DA TTC.",
  ].join("\n");

  it("une partie personne n'est pas lue ici — c'est dit", () => {
    const r = extraireContrat({ texte: CONVENTION });
    expect(r.nature).toBe("CONVENTION");
    expect(new Set(r.faits.map((f) => f.sujetRef))).toEqual(new Set(["partie-1"]));
    expect(r.notes.some((n) => n.includes("personne"))).toBe(true);
    expect(r.contrat.dateDebut?.valeur).toBe("2026-12-01");
    expect(r.contrat.dateFin?.valeur).toBe("2026-12-31");
    expect(r.contrat.montant?.valeur).toMatchObject({ valeur: 150_000, taxes: "TTC" });
  });

  it("la synthèse du modèle complète ce que les règles n'ont pas lu, sans remplacer l'imprimé", () => {
    const texte = "CONTRAT DE MAINTENANCE\nLe présent contrat lie les parties pour l'entretien des climatiseurs.\nIl prend effet à compter du 05/01/2027.";
    const synthese = lireSyntheseModele({
      nature: { valeur: "CONTRACT", extrait: "CONTRAT DE MAINTENANCE" },
      titre: "Contrat de maintenance — ClimTech SARL",
      dateDebut: { valeur: "01/02/2027", extrait: "à compter du 01/02/2027" },
      dateFin: { valeur: "31/01/2028", extrait: "jusqu'au 31/01/2028" },
      duree: { nombre: "12", unite: "MOIS", extrait: "pour douze mois" },
      contrepartie: { nom: "ClimTech SARL", nif: "000916002345678", rc: "16/00-0911111 B 09", adresse: "Zone industrielle, Rouiba" },
      resume: "Maintenance des climatiseurs.", aSurveiller: "",
    });
    const r = extraireContrat({ texte, synthese });
    expect(r.local).toBe(false);
    expect(r.moteur).toBe(`${MOTEUR_CONTRAT}+synthese-legale`);
    expect(r.contrat.dateDebut).toMatchObject({ valeur: "2027-01-05", source: "regles" });
    expect(r.contrat.dateFin).toMatchObject({ valeur: "2028-01-31", source: "modele" });
    expect(un(r.faits, "partie-1", "organisation.raisonSociale")).toMatchObject({ valeur: "ClimTech SARL", confiance: 0.55 });
    expect(un(r.faits, "partie-1", "organisation.nif").valeurNormalisee).toBe("000916002345678");
    expect(un(r.faits, "partie-1", "organisation.rc").valeurNormalisee).toBe("16000911111B09");
    expect(r.notes.some((n) => n.includes("formule « Entre les soussignés"))).toBe(true);
  });

  it("une contrepartie du modèle déjà lue par les règles ne fait pas un second sujet", () => {
    const synthese = lireSyntheseModele({ contrepartie: { nom: "HORIZON ÉVÉNEMENTS EURL", nif: "", rc: "", adresse: "" } });
    const r = extraireContrat({ texte: CONTRAT, synthese });
    expect(new Set(r.faits.map((f) => f.sujetRef))).toEqual(new Set(["partie-1", "partie-2"]));
  });
});
