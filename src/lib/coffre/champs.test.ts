import { describe, expect, it } from "vitest";
import { CHAMPS_SENSIBLES, champSensible, classerValeur, estUnMasque, masqueDepuisClair } from "./champs";
import { cleRib, NATURES_COFFRE } from "./natures";

const base = "007999990001234567";
const RIB = base + cleRib(base);
const IBAN = "DZ3500400174401234567891";
const c = (m: string, f: string) => champSensible(m, f)!;

describe("le catalogue des colonnes sensibles", () => {
  it("couvre l'inventaire §3 : IBAN, NIN et quatre salaires du salarié, RIB du partenaire, RIB et IBAN de la société", () => {
    expect(CHAMPS_SENSIBLES.map((x) => `${x.modele}.${x.champ}`)).toEqual([
      "Employee.iban", "Employee.nationalId", "Employee.baseSalary", "Employee.grossSalary", "Employee.netToPay", "Employee.employerCost",
      "CompanyContact.rib", "CompanyLegalIdentity.rib", "CompanyLegalIdentity.iban",
    ]);
    for (const x of CHAMPS_SENSIBLES) for (const n of x.natures) expect(NATURES_COFFRE).toContain(n);
    // Une organisation n'a au coffre que des coordonnées bancaires.
    for (const x of CHAMPS_SENSIBLES.filter((y) => y.titulaire === "ORGANISATION")) expect(x.natures.every((n) => n === "IBAN" || n === "RIB")).toBe(true);
  });

  it("classe la colonne « RIB / IBAN » selon ce qui y est saisi, validé par sa clé", () => {
    expect(classerValeur(c("Employee", "iban"), ` ${IBAN.toLowerCase()} `)).toEqual({ ok: true, nature: "IBAN", valeur: IBAN });
    expect(classerValeur(c("Employee", "iban"), RIB.replace(/(\d{5})/g, "$1 "))).toEqual({ ok: true, nature: "RIB", valeur: RIB });
    const faux = classerValeur(c("Employee", "iban"), "00799999000123456700");
    expect(faux).toMatchObject({ ok: false, vide: false });
    expect(JSON.stringify(faux)).not.toContain("00799999000123456700");
  });

  it("un salaire : Decimal ou nombre ; zéro et vide sont VIDES, pas une rémunération", () => {
    const s = c("Employee", "baseSalary");
    expect(classerValeur(s, 185000)).toEqual({ ok: true, nature: "SALAIRE", valeur: "185000.00" });
    expect(classerValeur(s, { toString: () => "185000.5" })).toEqual({ ok: true, nature: "SALAIRE", valeur: "185000.50" });
    for (const v of [0, "0", "0.00", null, undefined, "  "]) expect(classerValeur(s, v)).toEqual({ ok: false, vide: true });
  });

  it("le masque d'une colonne en clair : quatre derniers, jamais un chiffre de salaire", () => {
    expect(masqueDepuisClair(c("CompanyContact", "rib"), RIB)).toBe(`•••• ${RIB.slice(-4)}`);
    expect(masqueDepuisClair(c("Employee", "baseSalary"), 185000)).toBe("•••••• DZD");
    expect(masqueDepuisClair(c("Employee", "nationalId"), "12 34")).toBe("•••• 1234");
    expect(masqueDepuisClair(c("Employee", "nationalId"), null)).toBeNull();
  });

  it("reconnaît un masque renvoyé par un formulaire (la valeur en place est gardée)", () => {
    expect(estUnMasque("•••• 1234")).toBe(true);
    expect(estUnMasque(RIB)).toBe(false);
    expect(estUnMasque(null)).toBe(false);
  });
});
