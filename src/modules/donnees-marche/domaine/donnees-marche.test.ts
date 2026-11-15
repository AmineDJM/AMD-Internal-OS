import { describe, expect, it } from "vitest";
import { dateIso, normEntete } from "./commun";
import { dateDuTitre, lireNomenclature, ongletDe } from "./nomenclature";
import { lireIqvia } from "./iqvia";

describe("primitives", () => {
  it("lit les dates sous toutes leurs formes, et refuse un texte qui n'en est pas une", () => {
    expect(dateIso(38929)).toBe("2006-07-31");
    expect(dateIso(new Date(Date.UTC(2025, 7, 10)))).toBe("2025-08-10");
    expect(dateIso("07/03/2009")).toBe("2009-03-07");
    expect(dateIso("RETRAIT ")).toBeNull();
  });
  it("normalise un en-tête", () => {
    expect(normEntete("MAT Jul 2026\nVALEURS")).toBe("MAT JUL 2026 VALEURS");
    expect(normEntete("DATE D'ENREGISTREMENT  FINAL ")).toBe("DATE D'ENREGISTREMENT FINAL");
  });
});

const ENTETE_NOM = ["N°", "N°ENREGISTREMENT", "CODE", "DENOMINATION COMMUNE INTERNATIONALE", "NOM DE MARQUE", "FORME", "DOSAGE",
  "CONDITIONNEMENT", "LISTE", "P1", "P2", "OBS", "LABORATOIRES DETENTEUR DE LA DECISION D'ENREGISTREMENT",
  "PAYS DU LABORATOIRE DETENTEUR DE LA DECISION D'ENREGISTREMENT", "DATE D'ENREGISTREMENT INITIAL ", "DATE D'ENREGISTREMENT  FINAL ", "TYPE", "STATUT"];

describe("nomenclature", () => {
  it("reconnaît l'onglet et la date d'arrêté", () => {
    expect(ongletDe("Retraits", "")).toBe("RETRAIT");
    expect(ongletDe("Non Renouvelés ", "")).toBe("NON_RENOUVELE");
    expect(ongletDe("Nomenclature Juin 2026", "")).toBe("EN_VIGUEUR");
    expect(dateDuTitre("NOMENCLATURE NATIONALE … AU 30 JUIN 2026  ( 5381 DE )")).toBe("2026-06-30");
  });
  it("lit une décision par ligne, F et I sur la même DCI, et ignore titres et lignes vides", () => {
    const f = { nom: "Nomenclature Juin 2026", lignes: [
      [], ["NOMENCLATURE NATIONALE DES PRODUITS PHARMACEUTIQUES AU 30 JUIN 2026"], [], ENTETE_NOM,
      [1, "352/01 A 003/06/22", "01 A 003", "CETIRIZINE DICHLORHYDRATE", "ARTIZ", "COMPRIME", "10MG", "B/10", "LISTE II", "HOP", "OFF", null, "EL KENDI", "ALGERIE", 38929, 45879, "GE", "F"],
      [2, "035/01 A 003/17/23", "01 A 003", "CETIRIZINE DICHLORHYDRATE", "ZYRTEC", "COMPRIME", "10MG", "B/15", "LISTE II", "HOP", "OFF", null, "UCB", "BELGIQUE", 38929, 45000, "RE", "i"],
      [null, null, null, null],
    ] };
    const r = lireNomenclature([f])!;
    expect(r.dateArrete).toBe("2026-06-30");
    expect(r.lignes).toHaveLength(2);
    expect(r.lignes.map((l) => l.statut)).toEqual(["F", "I"]);
    expect(r.lignes[0]!.code).toBe("01 A 003");
    expect(r.lignes[0]!.dateInitiale).toBe("2006-07-31");
    expect(r.parOnglet.EN_VIGUEUR).toBe(2);
  });
  it("rend null quand aucune feuille n'est une nomenclature", () => {
    expect(lireNomenclature([{ nom: "x", lignes: [["A", "B"]] }])).toBeNull();
  });
});

describe("IQVIA", () => {
  const entete = ["ATC4", "PRODUIT", "PRESENTATION", "MOLECULE", "LABORATOIRE", "Jul 2026\nUNITES", "Jul 2026\nVALEURS",
    "YTD Jul 2026\nUNITES", "YTD Jul 2026\nVALEURS", "MAT Jul 2026\nUNITES", "MAT Jul 2026\nVALEURS", "MAT Jul 2026\nVALEURS Growth % PY"];
  it("ne compte une association qu'une fois et réunit ses molécules", () => {
    const r = lireIqvia([{ nom: "ATC Prod Mol Lab", lignes: [
      entete,
      ["C09D3 ARA 2", "EXVAL", "CP.PEL 5MG/ 160 MG 30", "AMLODIPINE", "EL KENDI", 10, 1000, 60, 6000, 120, 12000, 0.03],
      ["C09D3 ARA 2", "EXVAL", "CP.PEL 5MG/ 160 MG 30", "VALSARTAN", "EL KENDI", 10, 1000, 60, 6000, 120, 12000, 0.03],
      ["C10A1 STATINES", "CRESTOR", "CPR 10 MG 30", "ROSUVASTATIN", "ASTRAZENECA", 1, 100, 6, 600, 12, 1200, null],
      ["Grand Total", null, null, null, null, 11, 1100, 66, 6600, 132, 13200, 0.05],
    ] }])!;
    expect(r.periode).toBe("MAT Jul 2026");
    expect(r.presentations).toHaveLength(2);
    expect(r.presentations[0]!.molecules).toEqual(["AMLODIPINE", "VALSARTAN"]);
    expect(r.presentations[0]!.matValeur).toBe(12000);
    expect(r.presentations[0]!.moisUnites).toBe(10);
    expect(r.presentations[1]!.matCroissance).toBeNull();
    expect(r.totalRecompte).toBe(13200);
    expect(r.totalAnnonce).toBe(13200);
  });
});
