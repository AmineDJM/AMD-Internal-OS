import { describe, expect, it } from "vitest";
import { extraireCarteVisite, MOTEUR_CARTE_VISITE } from "./carte-visite";

type R = ReturnType<typeof extraireCarteVisite>;
const tous = (r: R, attribut: string) => r.faits.filter((f) => f.attribut === attribut);
const un = (r: R, attribut: string) => tous(r, attribut)[0];

/** Une carte de visite d'un fournisseur algérien, telle que lue par l'OCR (données fictives). */
const CARTE_DZ = `EXEMPLE PHARMA DISTRIBUTION SARL
Dr Karim HADDAD
Directeur commercial
Zone industrielle Oued Smar, Lot 45
16270 Alger
Mob : 0661 22 33 44
Tél : 023 92 10 20   Fax : 023 92 10 21
k.haddad@exemple-pharma.dz
contact@exemple-pharma.dz
www.exemple-pharma.dz`;

describe("extraireCarteVisite", () => {
  const r = extraireCarteVisite({ texte: CARTE_DZ, nomFichier: "carte-haddad.jpg" });

  it("est locale, par règles", () => {
    expect(r).toMatchObject({ nature: "CARTE_VISITE", moteur: MOTEUR_CARTE_VISITE, local: true });
    expect(r.faits.some((f) => f.sensible)).toBe(false);
  });

  it("lit la personne : civilité, nom, prénoms, fonction, mobile, e-mail nominatif", () => {
    expect(un(r, "personne.civilite")?.valeur).toBe("Dr");
    expect(un(r, "personne.nom")?.valeur).toBe("HADDAD");
    expect(un(r, "personne.prenoms")?.valeur).toBe("Karim");
    expect(un(r, "personne.fonction")?.valeur).toBe("Directeur commercial");
    expect(tous(r, "personne.telephone").map((f) => f.valeurNormalisee)).toEqual(["+213661223344"]);
    expect(un(r, "personne.email")?.valeurNormalisee).toBe("k.haddad@exemple-pharma.dz");
    for (const f of r.faits.filter((x) => x.sujetType === "PERSONNE")) expect(f).toMatchObject({ sujetRef: "titulaire", role: "TITULAIRE" });
  });

  it("lit l'organisation, rôle MENTIONNE : raison sociale, standard, e-mail générique, site, adresse", () => {
    const org = r.faits.filter((f) => f.sujetType === "ORGANISATION");
    expect(org.every((f) => f.sujetRef === "organisation" && f.role === "MENTIONNE")).toBe(true);
    expect(un(r, "organisation.raisonSociale")?.valeur).toBe("EXEMPLE PHARMA DISTRIBUTION SARL");
    expect(tous(r, "organisation.telephone").map((f) => f.valeurNormalisee)).toEqual(["+21323921020"]);
    expect(un(r, "organisation.email")?.valeurNormalisee).toBe("contact@exemple-pharma.dz");
    expect(un(r, "organisation.siteWeb")?.valeurNormalisee).toBe("exemple-pharma.dz");
    expect(un(r, "organisation.adresse")?.valeur).toBe("Zone industrielle Oued Smar, Lot 45, 16270 Alger");
  });

  it("le fax est noté, pas proposé", () => {
    expect(r.faits.some((f) => f.valeurNormalisee === "+21323921021")).toBe(false);
    expect(r.notes.some((n) => n.includes("fax") && n.includes("+21323921021"))).toBe(true);
  });

  it("carte anglaise : « Prénom Nom » départagé par l'e-mail, nom commercial sans forme juridique", () => {
    const c = extraireCarteVisite({
      texte: "Sarah Johnson\nKey Account Manager — North Africa\nExample Laboratories\nM: +33 6 12 34 56 78\nsarah.johnson@example-labs.com\nhttps://example-labs.com",
    });
    expect(un(c, "personne.nom")?.valeur).toBe("Johnson");
    expect(un(c, "personne.prenoms")?.valeur).toBe("Sarah");
    expect(un(c, "personne.fonction")?.valeur).toContain("Key Account Manager");
    expect(un(c, "organisation.nomCommercial")?.valeur).toBe("Example Laboratories");
    expect(un(c, "personne.telephone")?.valeurNormalisee).toBe("+33612345678");
    expect(un(c, "organisation.siteWeb")?.valeurNormalisee).toBe("example-labs.com");
  });

  it("sans organisation lisible : rien d'inventé depuis le domaine, une note", () => {
    const c = extraireCarteVisite({ texte: "Amel BRAHIMI\nDéléguée médicale\n0770 11 22 33\na.brahimi@exemple.dz" });
    expect(c.faits.filter((f) => f.sujetType === "ORGANISATION")).toEqual([]);
    expect(c.notes.some((n) => n.includes("exemple.dz") && n.includes("non deviné"))).toBe(true);
    expect(un(c, "personne.fonction")?.valeur).toBe("Déléguée médicale");
  });

  it("deux mobiles sur une ligne sont lus séparément", () => {
    const c = extraireCarteVisite({ texte: "Amel BRAHIMI\nGSM : 0550 12 34 56 - 0661 98 76 54" });
    expect(tous(c, "personne.telephone").map((f) => f.valeurNormalisee)).toEqual(["+213550123456", "+213661987654"]);
  });

  it("un texte vide : une note", () => {
    const c = extraireCarteVisite({ texte: "", nomFichier: "vide.png" });
    expect(c.faits).toEqual([]);
    expect(c.notes[0]).toContain("vide.png");
  });
});
