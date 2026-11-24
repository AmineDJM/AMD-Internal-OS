import { describe, expect, it } from "vitest";
import {
  libelleNatureDepense, NATURE_NON_PRECISEE, natureDepense, NATURES_DEMANDE, NATURES_DEPENSE, naturesParFamille, phraseRangement,
  proposerNature, rechercherNatures, REFUS_SANS_NATURE, refusNatureDemande,
} from "./natures-depense";
import { NATURES_PAR_DEFAUT } from "@/lib/general-means/natures";

const RUBRIQUES = ["RECETTE", "CCA", "PRET", "REMBOURSEMENT", "SALAIRE", "AVANCE", "LOYER", "VOYAGE", "EVENEMENT", "BUREAUTIQUE", "FOURNISSEUR", "CHARGES", "IMPOT", "BANQUE", "AUTRE"];

describe("NATURES_DEPENSE — un référentiel, des codes stables", () => {
  it("chaque code est unique, de la forme FAMILLE.NATURE, et sa rubrique est une FinanceCategory", () => {
    const codes = NATURES_DEPENSE.map((x) => x.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const x of NATURES_DEPENSE) {
      expect(x.code, x.code).toMatch(/^[A-Z_]+\.[A-Z0-9_]+$/);
      expect(RUBRIQUES, x.code).toContain(x.rubrique);
      expect(x.libelle.length, x.code).toBeGreaterThanOrEqual(3);
    }
  });

  it("il réunit l'existant au lieu de le recopier : les natures de la caisse sont celles des moyens généraux, mêmes clés", () => {
    for (const m of NATURES_PAR_DEFAUT) expect(natureDepense(`MOYENS_GENERAUX.${m.cle}`)?.ligne).toBe(m.cle);
  });

  it("la demande générique ne propose aucune nature qui a son propre circuit (caisse, Ad & Pro, BV, paie, impôts)", () => {
    expect(NATURES_DEMANDE.length).toBeGreaterThan(20);
    expect(NATURES_DEMANDE.every((x) => !x.circuit)).toBe(true);
    expect(NATURES_DEMANDE.some((x) => x.code === "CIRCUITS.TVA")).toBe(false);
  });

  it("vocabulaire décidé : pas de « PCH » ni d'exonération ; aucune taxe hors TVA et IBS", () => {
    for (const x of NATURES_DEPENSE) {
      expect(x.libelle, x.code).not.toMatch(/PCH|exon[ée]ration|CASNOS|TFP|vignette|foncière|TAP\b/i);
    }
    expect(NATURES_DEPENSE.filter((x) => x.rubrique === "IMPOT").map((x) => x.code).sort()).toEqual(["CIRCUITS.IBS", "CIRCUITS.TVA"]);
  });

  it("les natures concernées par une retenue à la source : honoraires de médecin et prestataire étranger, et elles seules", () => {
    expect(NATURES_DEPENSE.filter((x) => x.retenue).map((x) => [x.code, x.retenue])).toEqual([
      ["HONORAIRES.MEDECIN", "HONORAIRES_MEDECIN"],
      ["HONORAIRES.PRESTATAIRE_ETRANGER", "PRESTATAIRE_ETRANGER"],
    ]);
  });

  it("dons et mécénat ont leur ligne, séparée du sponsoring ; l'emprunt reste possible, en trésorerie seulement", () => {
    expect(natureDepense("GOUVERNANCE.DONS_MECENAT")?.ligne).toBe("DONS_MECENAT");
    const emprunt = natureDepense("TRESORERIE.REMBOURSEMENT_EMPRUNT");
    expect(emprunt?.tresorerieSeulement).toBe(true);
    expect(phraseRangement(emprunt!)).toMatch(/aucune ligne de charges/);
  });
});

describe("la nature d'une demande, jugée", () => {
  it("sans nature : refus clair, qui dit le remède", () => {
    expect(refusNatureDemande(null)).toBe(REFUS_SANS_NATURE);
    expect(refusNatureDemande("")).toBe(REFUS_SANS_NATURE);
    expect(REFUS_SANS_NATURE).toMatch(/Autre achat/);
  });
  it("une nature inconnue ou de circuit est refusée ; le bon de versement d'information médicale passe sous SON rattachement", () => {
    expect(refusNatureDemande("FOO.BAR")).toMatch(/inconnue/);
    expect(refusNatureDemande("CIRCUITS.PAIE")).toMatch(/virement de la paie/);
    expect(refusNatureDemande("CIRCUITS.INFO_MEDICALE")).not.toBeNull();
    expect(refusNatureDemande("CIRCUITS.INFO_MEDICALE", "MEDICAL_INFO_DECLARATION")).toBeNull();
    expect(refusNatureDemande("LOCAUX.LOYER")).toBeNull();
  });
  it("une demande d'avant la règle se lit « Nature non précisée »", () => {
    expect(libelleNatureDepense(null)).toBe(NATURE_NON_PRECISEE);
    expect(libelleNatureDepense("LOCAUX.LOYER")).toBe("Loyer");
  });
});

describe("la liste courte avec recherche", () => {
  it("la recherche ignore accents et casse, et chaque mot doit se trouver", () => {
    expect(rechercherNatures("ELECTRICITE").map((x) => x.code)).toContain("LOCAUX.ELECTRICITE_GAZ");
    expect(rechercherNatures("honoraires médecin").map((x) => x.code)).toEqual(["HONORAIRES.MEDECIN"]);
    expect(rechercherNatures("zzzz")).toEqual([]);
    expect(rechercherNatures("").length).toBe(NATURES_DEMANDE.length);
  });
  it("les groupes suivent l'ordre du référentiel, sans perdre une nature", () => {
    const g = naturesParFamille();
    expect(g[0].famille).toBe("HONORAIRES");
    expect(g.reduce((s, x) => s + x.natures.length, 0)).toBe(NATURES_DEMANDE.length);
  });
  it("la nature proposée d'après l'objet — et rien quand rien ne ressort", () => {
    expect(proposerNature("Honoraires Dr Benali — conférence cardiologie")?.code).toBe("HONORAIRES.MEDECIN");
    expect(proposerNature("Facture Sonelgaz siège novembre")?.code).toBe("LOCAUX.ELECTRICITE_GAZ");
    expect(proposerNature("Loyer décembre")?.code).toBe("LOCAUX.LOYER");
    expect(proposerNature("Xyz 42")).toBeNull();
  });
});
