import { describe, it, expect } from "vitest";
import {
  tidy, therapeuticClassOf, priorityOf, channelOf, manufacturingOf,
  splitProduct, formOf, parseDosage, dosageFrom, stripContainerSize,
  importComments, isProductRow, mapSheetRow, type SheetProductRow,
} from "./sheet-import";

const row = (over: Partial<SheetProductRow> = {}): SheetProductRow => ({
  specialty: "Neuro", prioritization: "1", product: "Fingolimod", form: "GELULE  0,5MG ",
  packaging: "B/28", commercialization: "Hop", status: "Fabrication",
  qtyCity: "", qtyPch: "2724.32", fobPrice: "688.64", marketSize: " $1,876,067 ",
  actors: "1", n1: "HIKMA 100%", n2: "", n3: "", ...over,
});

describe("tidy", () => {
  it("absorbe les retours à la ligne et les espaces insécables de la feuille", () => {
    expect(tidy("CPR.PELL. LP 500 MG \r\n")).toBe("CPR.PELL. LP 500 MG");
    expect(tidy(" 20,508,691  ")).toBe("20,508,691");
  });
});

describe("therapeuticClassOf", () => {
  it("développe les abréviations de spécialité", () => {
    expect(therapeuticClassOf("Neuro")).toBe("Neurologie");
    expect(therapeuticClassOf("Inf et REA")).toBe("Infectiologie & Réanimation");
  });

  it("garde le libellé inconnu plutôt que de le perdre", () => {
    expect(therapeuticClassOf("Cardio")).toBe("Cardio");
    expect(therapeuticClassOf("")).toBeNull();
  });
});

describe("priorityOf", () => {
  it("traduit 1..4, du plus urgent au moins urgent", () => {
    expect(priorityOf("1")).toBe("CRITICAL");
    expect(priorityOf("2")).toBe("HIGH");
    expect(priorityOf("3")).toBe("MEDIUM");
    expect(priorityOf("4")).toBe("LOW");
  });

  it("une case VIDE n'est pas une priorité basse — c'est un arbitrage qui reste à faire", () => {
    expect(priorityOf("")).toBe("MEDIUM");
    expect(priorityOf("NA")).toBe("MEDIUM");
  });
});

describe("channelOf", () => {
  it("Off = officine, Hop = hôpital, les deux = les deux", () => {
    expect(channelOf("Off")).toBe("RETAIL");
    expect(channelOf("Hop")).toBe("HOSPITAL");
    expect(channelOf("Off/Hop")).toBe("BOTH");
    expect(channelOf("Hop/Off")).toBe("BOTH");
  });

  it("sans indication, ne ferme aucun canal", () => {
    expect(channelOf("NA")).toBe("BOTH");
    expect(channelOf("")).toBe("BOTH");
  });
});

describe("manufacturingOf", () => {
  it("Fabrication = full process déclaré, Importation = importation", () => {
    expect(manufacturingOf("Fabrication")).toBe("FULL_PROCESS");
    expect(manufacturingOf("Importation")).toBe("IMPORTATION");
  });

  it("« Importation puis Fabrication » PART de l'importation — la fabrication viendra par variation", () => {
    expect(manufacturingOf("Importation\r\nFabrication")).toBe("IMPORTATION");
  });

  it("sans statut, on ne déclare pas une fabrication locale", () => {
    expect(manufacturingOf("")).toBe("IMPORTATION");
    expect(manufacturingOf("NA")).toBe("IMPORTATION");
  });
});

describe("splitProduct", () => {
  it("sépare la DCI du nom commercial sur « : »", () => {
    expect(splitProduct("VALPROIC ACID  : Depakine")).toEqual({
      dci: "VALPROIC ACID", brandName: "Depakine", molecules: null,
    });
  });

  it("met la DCI en MAJUSCULES, comme tout le référentiel", () => {
    expect(splitProduct(" Triptoreline").dci).toBe("TRIPTORELINE");
  });

  it("découpe une association sur « + » et la liste", () => {
    expect(splitProduct("Tamsulosine + Tadalafil")).toEqual({
      dci: "TAMSULOSINE + TADALAFIL", brandName: null, molecules: ["TAMSULOSINE", "TADALAFIL"],
    });
  });

  it("ne découpe PAS un « Ou » : c'est une alternative à trancher, pas une association", () => {
    const r = splitProduct("MINOCYCLINE Ou LYMECYCLINE");
    expect(r.dci).toBe("MINOCYCLINE OU LYMECYCLINE");
    expect(r.molecules).toBeNull();
  });
});

describe("formOf", () => {
  it("reconnaît les abréviations manuscrites de la feuille", () => {
    expect(formOf("GELULE  0,5MG")).toBe("GELULE");
    expect(formOf("GELULE. LP")).toBe("GELULE");
    expect(formOf("CPR. PELLIC. 250 MG")).toBe("COMPRIME_PELLICULE");
    expect(formOf("CPR.GASTRORE 200 MG")).toBe("COMPRIME");
    expect(formOf("COMP 10 MG")).toBe("COMPRIME");
    expect(formOf("SOLN BUV. 20 %")).toBe("SOLUTION_BUVABLE");
    expect(formOf("CAPS.MOLLES")).toBe("CAPSULE_MOLLE");
    expect(formOf("POMMADE")).toBe("POMMADE");
    expect(formOf("CREME DERM.")).toBe("CREME");
  });

  it("ne confond pas GELULE avec GEL ni PDRE+SOLV avec INJ — l'ordre des règles est la règle", () => {
    expect(formOf("GEL DERM.")).toBe("GEL");
    expect(formOf("GELULE")).toBe("GELULE");
    expect(formOf("PDRE+SOLV P/SOL INJ IV ET PERF 10MG/10ML")).toBe("POUDRE_INJECTABLE");
    expect(formOf("INJ 20MG")).toBe("SOLUTION_INJECTABLE");
    expect(formOf("EMULSION INJECTABLE 10 ML")).toBe("EMULSION_INJECTABLE");
    expect(formOf("ÉMULSION POUR PERFUSION 20%")).toBe("EMULSION_INJECTABLE");
    expect(formOf("INJ EMULS 200MG")).toBe("EMULSION_INJECTABLE");
  });

  it("« CAPS/Ovule » est un ovule — la voie compte plus que le contenant", () => {
    expect(formOf("CAPS/Ovule")).toBe("OVULE");
  });

  it("préfère « Autre » à une forme inventée", () => {
    expect(formOf("SOLUTION LOCALE+SPATULE OU PINCEAU APPLICATEUR")).toBe("AUTRE");
    expect(formOf("")).toBeNull();
  });
});

describe("parseDosage", () => {
  it("sépare valeur et unité quand il n'y en a qu'un", () => {
    expect(parseDosage("GELULE 120 MG")).toEqual({ dosage: "120", dosageUnit: "MG" });
    expect(parseDosage("GELULE  0,5MG")).toEqual({ dosage: "0.5", dosageUnit: "MG" });
    expect(parseDosage("SOLN BUV. 20 %")).toEqual({ dosage: "20", dosageUnit: "PERCENT" });
    expect(parseDosage("Grannulés 3G")).toEqual({ dosage: "3", dosageUnit: "G" });
    expect(parseDosage("SOLN BUV. 100 MG /ML")).toEqual({ dosage: "100", dosageUnit: "MG_ML" });
  });

  it("garde l'expression ENTIÈRE quand il y a plusieurs dosages — en garder un seul mentirait", () => {
    expect(parseDosage("0,4 mg+5 MG").dosage).toBe("0.4 mg + 5 mg");
    expect(parseDosage("0,4 mg+5 MG").dosageUnit).toBeNull();
  });

  it("« 10MG/10ML » dose 10 mg : les millilitres sont le solvant, pas le dosage", () => {
    expect(parseDosage("PDRE+SOLV P/SOL INJ IV ET PERF 10MG/10ML")).toEqual({ dosage: "10", dosageUnit: "MG" });
    expect(parseDosage("B/1 40 ML")).toEqual({ dosage: null, dosageUnit: null });
  });

  it("corrige le « O » saisi à la place du zéro, et seulement là", () => {
    expect(parseDosage("O,1% - B/7 FL")).toEqual({ dosage: "0.1", dosageUnit: "PERCENT" });
    expect(parseDosage("POMMADE")).toEqual({ dosage: null, dosageUnit: null });
  });

  it("ne trouve rien plutôt que d'inventer", () => {
    expect(parseDosage("CPR. PELLIC")).toEqual({ dosage: null, dosageUnit: null });
  });
});

describe("stripContainerSize / dosageFrom", () => {
  it("« B 30 » compte des boîtes, pas des milligrammes", () => {
    expect(stripContainerSize("5 MG/B 30")).toBe("5 MG/");
    expect(stripContainerSize("B/1 40 ML")).toBe("40 ML");
  });

  it("les grammes d'un TUBE pèsent le tube, pas le principe actif", () => {
    expect(stripContainerSize("0,5% / 1 tube 15 G / 45 G")).toBe("0,5% / 1");
    expect(stripContainerSize("Tube 30 G / 60 G")).toBe("");
    expect(stripContainerSize("O,1% - B/7 FL PDRE+AMP SOLV de 1ml")).toBe("O,1% -");
  });

  it("va chercher le dosage dans le conditionnement quand la forme n'en porte pas", () => {
    expect(dosageFrom("CPR. PELLIC. ", "5 MG/B 30")).toEqual({ dosage: "5", dosageUnit: "MG" });
    expect(dosageFrom("GELULE. LP", "0,4 MG/B 30")).toEqual({ dosage: "0.4", dosageUnit: "MG" });
    expect(dosageFrom("SOL BUV ", "40MG/ML \r\nB/01 FL DE 105ML+UNE CUILLERE")).toEqual({ dosage: "40", dosageUnit: "MG_ML" });
  });

  it("un tube sans dosage reste SANS dosage — mieux vaut vide qu'un chiffre faux", () => {
    expect(dosageFrom("POMMADE ", "Tube 30 G / 60 G")).toEqual({ dosage: null, dosageUnit: null });
    expect(dosageFrom("CREME DERM.", "0,5% / 1 tube 15 G / 45 G")).toEqual({ dosage: "0.5", dosageUnit: "PERCENT" });
  });

  it("la forme reste prioritaire quand elle porte déjà le dosage", () => {
    expect(dosageFrom("CPR. PELLIC. 250 MG", "B/60")).toEqual({ dosage: "250", dosageUnit: "MG" });
  });
});

describe("importComments", () => {
  it("garde la ligne d'origine et les chiffres de marché — c'est l'arbitrage du métier", () => {
    const c = importComments(row(), "Sélection PF Produits");
    expect(c).toContain("Importé depuis « Sélection PF Produits »");
    expect(c).toContain("Libellé d'origine : GELULE 0,5MG — B/28");
    expect(c).toContain("Statut visé (feuille) : Fabrication");
    expect(c).toContain("quantité marché PCH 2724.32");
    expect(c).toContain("prix FOB 688.64");
    expect(c).toContain("Concurrence : HIKMA 100%");
  });

  it("n'écrit pas de ligne de marché quand il n'y a aucun chiffre", () => {
    const c = importComments(row({ qtyCity: "", qtyPch: "", fobPrice: "", marketSize: " $- ", actors: "", n1: "", n2: "", n3: "" }), "S");
    expect(c).not.toContain("Marché :");
    expect(c).not.toContain("Concurrence :");
  });
});

describe("isProductRow", () => {
  it("une ligne sans DCI (total, séparateur) n'est pas un produit", () => {
    expect(isProductRow(row())).toBe(true);
    expect(isProductRow(row({ product: "" }))).toBe(false);
  });
});

describe("mapSheetRow — la ligne complète", () => {
  it("traduit une ligne hospitalière fabriquée localement", () => {
    expect(mapSheetRow(row(), "Sélection PF Produits")).toMatchObject({
      dci: "FINGOLIMOD",
      molecules: null,
      pharmaceuticalForm: "GELULE",
      dosage: "0.5",
      dosageUnit: "MG",
      packaging: "B/28",
      therapeuticClass: "Neurologie",
      channel: "HOSPITAL",
      manufacturingStatus: "FULL_PROCESS",
      priority: "CRITICAL",
    });
  });

  it("traduit une ligne dont le dosage n'est QUE dans le conditionnement", () => {
    const m = mapSheetRow(row({
      specialty: "Uro", prioritization: "1", product: "TAMSULOSINE", form: "GELULE. LP",
      packaging: "0,4 MG/B 30", commercialization: "Off", status: "Fabrication",
    }), "S");
    expect(m).toMatchObject({
      dci: "TAMSULOSINE", pharmaceuticalForm: "GELULE", dosage: "0.4", dosageUnit: "MG",
      packaging: "0,4 MG/B 30", channel: "RETAIL", therapeuticClass: "Urologie",
    });
  });

  it("traduit une association sans priorisation ni statut", () => {
    const m = mapSheetRow(row({
      specialty: "Uro", prioritization: "2", product: "Tamsulosine + Tadalafil",
      form: "Gélule ou capsule molle  LP", packaging: "0,4 mg+5 MG/ B 30 ",
      commercialization: "NA", status: "",
    }), "S");
    expect(m.dci).toBe("TAMSULOSINE + TADALAFIL");
    expect(m.molecules).toEqual(["TAMSULOSINE", "TADALAFIL"]);
    expect(m.dosage).toBe("0.4 mg + 5 mg");
    expect(m.dosageUnit).toBeNull();
    expect(m.channel).toBe("BOTH");
    expect(m.manufacturingStatus).toBe("IMPORTATION");
  });
});
