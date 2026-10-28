import { describe, expect, it } from "vitest";
import { estAmbigu, estEnAlgerie, rattacherFiche, toucheLeLieu } from "./rattachement";

const code = (...a: Parameters<typeof rattacherFiche>) => rattacherFiche(...a).code;

describe("rattacherFiche — la colonne wilaya prime, la ville parle si elle se tait", () => {
  it("lit la wilaya saisie par la liste fermée de l'application", () => {
    expect(code("MedicalDoctor", { wilaya: "Oran", city: null, region: null })).toBe("31");
    expect(code("MedicalInstitution", { wilaya: "Sidi Bel Abbès" })).toBe("22");
  });

  it("une wilaya vide laisse parler la ville, puis la région", () => {
    expect(code("CompanyContact", { wilaya: null, city: "Blida" })).toBe("09");
    expect(code("MedicalDoctor", { wilaya: "", city: "Rouiba", region: "Batna" })).toBe("05");
  });

  it("la wilaya pivot d'un secteur de vente", () => {
    expect(code("SalesSector", { wilayaPivot: "Constantine", city: null })).toBe("25");
  });

  it("garde le code du découpage en vigueur (69) et signale la prudence", () => {
    const r = rattacherFiche("MedicalDoctor", { wilaya: null, city: "Bou Saâda" });
    expect(r).toMatchObject({ code: "68" });
    expect(r.code !== null && r.prudence).toMatch(/M'Sila/);
  });
});

describe("rattacherFiche — refus motivés", () => {
  it("un texte ambigu reste nul, et c'est un cas à lister", () => {
    const r = rattacherFiche("MedicalDoctor", { wilaya: "Oran / Alger" });
    expect(r).toMatchObject({ code: null, raison: "plusieurs_wilayas" });
    expect(estAmbigu(r)).toBe(true);
  });

  it("une contradiction entre la wilaya et la ville ne se tranche pas par la ville", () => {
    expect(rattacherFiche("CompanyContact", { wilaya: "16 Oran", city: "Alger" })).toMatchObject({ code: null, raison: "contradiction" });
  });

  it("une fiche vide n'est pas une anomalie", () => {
    const r = rattacherFiche("CompanyContact", { wilaya: null, city: "  " });
    expect(r).toMatchObject({ code: null, raison: "vide" });
    expect(estAmbigu(r)).toBe(false);
  });

  it("un fournisseur étranger n'a pas de wilaya, même si sa ville ressemble à une wilaya", () => {
    const r = rattacherFiche("Supplier", { city: "Constantine", country: "Algérie" });
    expect(r.code).toBe("25");
    const etranger = rattacherFiche("Supplier", { city: "Constantine", country: "France" });
    expect(etranger).toMatchObject({ code: null, raison: "hors_algerie" });
    expect(estAmbigu(etranger)).toBe(false);
    expect(code("Supplier", { city: "Oran", country: null })).toBe("31");
  });
});

describe("estEnAlgerie / toucheLeLieu", () => {
  it("reconnaît l'Algérie sous ses graphies, un pays vide ne retire rien", () => {
    for (const p of ["", null, "DZ", "dz", "Algérie", "ALGERIE", "Algeria", "الجزائر"]) expect(estEnAlgerie(p)).toBe(true);
    for (const p of ["France", "Inde", "Tunisie"]) expect(estEnAlgerie(p)).toBe(false);
  });

  it("dit si une saisie touche une colonne de lieu (undefined = inchangé)", () => {
    expect(toucheLeLieu("MedicalDoctor", { phone: "0555" })).toBe(false);
    expect(toucheLeLieu("MedicalDoctor", { city: null })).toBe(true);
    expect(toucheLeLieu("Supplier", { country: "France" })).toBe(true);
    expect(toucheLeLieu("SalesSector", { wilaya: "Oran" })).toBe(false);
  });
});
