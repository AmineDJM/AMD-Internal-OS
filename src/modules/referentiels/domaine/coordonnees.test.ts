import { describe, expect, it } from "vitest";
import { adresseDepuisFiche, hoteDuSite, pointsDepuisFiche, sourceImport } from "./coordonnees";

const P = { personneId: "p1" } as const;
const O = { organisationId: "o1" } as const;

describe("adresseDepuisFiche", () => {
  it("reprend l'adresse avec la wilaya de la fiche", () => {
    const r = adresseDepuisFiche({ titulaire: P, type: "AUTRE", adresse: "  12 rue  Didouche Mourad ", wilayaCode: "16", codePostal: "16000", source: sourceImport("MedicalDoctor", "d1") });
    expect(r.adresse).toMatchObject({ personneId: "p1", organisationId: null, ligne1: "12 rue Didouche Mourad", wilayaCode: "16", codePostal: "16000", source: "IMPORT:MedicalDoctor:d1" });
  });

  it("sans code sur la fiche : la wilaya, la ville, puis le texte de l'adresse", () => {
    expect(adresseDepuisFiche({ titulaire: O, type: "SIEGE", adresse: "Zone industrielle", wilaya: "Sétif", source: "s" }).adresse?.wilayaCode).toBe("19");
    expect(adresseDepuisFiche({ titulaire: O, type: "SIEGE", adresse: "Cité 500 logements, Batna", source: "s" }).adresse?.wilayaCode).toBe("05");
    expect(adresseDepuisFiche({ titulaire: O, type: "SIEGE", adresse: "Lot 5 bis", source: "s" }).adresse?.wilayaCode).toBeNull();
  });

  it("refuse une adresse vide ou à l'étranger, ignore un code postal mal formé", () => {
    expect(adresseDepuisFiche({ titulaire: P, type: "DOMICILE", adresse: " - ", source: "s" })).toMatchObject({ adresse: null, raison: "vide" });
    expect(adresseDepuisFiche({ titulaire: O, type: "SIEGE", adresse: "Plot 4, Hyderabad", pays: "Inde", source: "s" })).toMatchObject({ adresse: null, raison: "etranger" });
    expect(adresseDepuisFiche({ titulaire: P, type: "AUTRE", adresse: "Rue A", codePostal: "16 000 Alger", source: "s" }).adresse?.codePostal).toBeNull();
  });

  it("une même adresse d'un même titulaire a la même clé, quelle que soit sa graphie ou sa source", () => {
    const a = adresseDepuisFiche({ titulaire: P, type: "AUTRE", adresse: "12, Rue Didouche-Mourad", source: "IMPORT:MedicalDoctor:d1" }).adresse!;
    const b = adresseDepuisFiche({ titulaire: P, type: "DOMICILE", adresse: "12 rue didouche mourad", source: "IMPORT:Employee:e1" }).adresse!;
    const c = adresseDepuisFiche({ titulaire: O, type: "SIEGE", adresse: "12 rue didouche mourad", source: "s" }).adresse!;
    expect(a.cle).toBe(b.cle);
    expect(a.cle).not.toBe(c.cle);
  });
});

describe("pointsDepuisFiche", () => {
  it("un téléphone par numéro lisible, en E.164, avec sa nature", () => {
    const { points, illisibles } = pointsDepuisFiche({ titulaire: P, telephones: [{ valeur: "0555 12 34 56 / 021 23 45 67" }], source: "s" });
    expect(points.map((p) => [p.valeurNormalisee, p.libelle])).toEqual([["+213555123456", "Mobile"], ["+21321234567", "Fixe"]]);
    expect(illisibles).toEqual([]);
  });

  it("garde la saisie quand le champ ne porte qu'un numéro, et le libellé donné", () => {
    const { points } = pointsDepuisFiche({ titulaire: O, telephones: [{ valeur: "0661-23-45-67", libelle: "Secondaire" }], source: "s" });
    expect(points[0]).toMatchObject({ type: "TELEPHONE", valeur: "0661-23-45-67", valeurNormalisee: "+213661234567", libelle: "Secondaire", organisationId: "o1", personneId: null });
  });

  it("dédoublonne la même valeur vue deux fois sur la même fiche", () => {
    const { points } = pointsDepuisFiche({ titulaire: P, telephones: [{ valeur: "0555123456" }, { valeur: "+213 555 12 34 56" }], emails: [{ valeur: "A.Benali@Mail.dz" }, { valeur: "a.benali@mail.dz" }], source: "s" });
    expect(points.map((p) => p.valeurNormalisee)).toEqual(["+213555123456", "a.benali@mail.dz"]);
  });

  it("liste les valeurs illisibles au lieu de les reprendre", () => {
    const { points, illisibles } = pointsDepuisFiche({ titulaire: P, telephones: [{ valeur: "0000000000" }], emails: [{ valeur: "pas un mail" }], sites: [{ valeur: "voir catalogue" }], source: "s" });
    expect(points).toEqual([]);
    expect(illisibles).toHaveLength(3);
  });

  it("les sites se comparent par leur hôte", () => {
    const { points } = pointsDepuisFiche({ titulaire: O, sites: [{ valeur: "https://www.saidal.dz/fr" }], source: "s" });
    expect(points[0]).toMatchObject({ type: "SITE", valeur: "https://www.saidal.dz/fr", valeurNormalisee: "saidal.dz" });
  });

  it("la clé dépend du titulaire, du type et de la valeur normalisée — pas de la source", () => {
    const a = pointsDepuisFiche({ titulaire: P, emails: [{ valeur: "x@y.dz" }], source: "IMPORT:User:u1" }).points[0];
    const b = pointsDepuisFiche({ titulaire: P, emails: [{ valeur: "X@Y.DZ" }], source: "IMPORT:MedicalDoctor:d1" }).points[0];
    expect(a.cle).toBe(b.cle);
  });
});

describe("hoteDuSite", () => {
  it.each([
    ["saidal.dz", "saidal.dz"], ["http://www.Exemple.com/a?b", "exemple.com"], ["www.labo-x.fr", "labo-x.fr"],
    ["contact@x.dz", null], ["n/a", null], ["", null], ["localhost", null], ["voir le site", null],
  ])("« %s » → %s", (v, h) => {
    expect(hoteDuSite(v)).toBe(h);
  });
});
