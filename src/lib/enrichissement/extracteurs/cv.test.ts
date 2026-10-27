import { describe, expect, it } from "vitest";
import { extraireCv, MOTEUR_CV } from "./cv";

const tous = (r: ReturnType<typeof extraireCv>, attribut: string) => r.faits.filter((f) => f.attribut === attribut);
const un = (r: ReturnType<typeof extraireCv>, attribut: string) => tous(r, attribut)[0];

/** Un CV de délégué médical algérien, tel qu'extrait d'un PDF (données fictives). */
const CV_FR = `Dr Yasmine KACI
Pharmacienne — Déléguée médicale
Cité 500 logements, Bt 12, Bab Ezzouar, Alger
Tél : 0550 12 34 56 / 021 23 45 67
E-mail : yasmine.kaci@exemple.dz
Née le 14/02/1991 à Tizi Ouzou
Nationalité : Algérienne

FORMATION
2015 – 2017
Master en pharmacologie clinique, Université d'Alger 1
2014 : Diplôme d'État de Docteur en pharmacie, Faculté de médecine d'Alger
2008 : Baccalauréat sciences expérimentales, mention Bien

EXPÉRIENCE PROFESSIONNELLE
Depuis mars 2020 : Déléguée médicale, Laboratoire Exemple Pharma — Alger Centre
- Visite des prescripteurs (cardiologues, généralistes)
- Animation de staffs hospitaliers
2017 - 2020
Pharmacienne assistante, Pharmacie du Centre, Bab Ezzouar

LANGUES
Arabe (langue maternelle) • Français (courant) • Anglais (B2)

COMPÉTENCES
Pack Office, CRM Veeva`;

const CV_EN = `JOHN A. SMITH
Senior Regulatory Affairs Manager
Phone: +44 20 7946 0958 | Email: J.Smith@example.co.uk
Date of birth: March 5, 1980
Nationality: British

PROFESSIONAL EXPERIENCE
2016 - present | Regulatory Affairs Manager, Example Biotech Ltd, London
2010 - 2016 | Regulatory Officer at Sample Pharma plc

EDUCATION
2004 PhD in Pharmaceutical Sciences, University of Example
2001 MSc Pharmacology

Languages: English (native), French (fluent), Arabic (basic)`;

describe("extraireCv — CV français", () => {
  const r = extraireCv({ texte: CV_FR, nomFichier: "CV-Kaci.pdf" });

  it("est local, par règles, et ne rend que des faits du titulaire", () => {
    expect(r).toMatchObject({ nature: "CV", moteur: MOTEUR_CV, local: true });
    expect(r.faits.every((f) => f.sujetRef === "titulaire" && f.role === "TITULAIRE" && !f.sensible)).toBe(true);
  });

  it("lit l'identité : civilité, nom en capitales, prénoms, naissance, lieu, nationalité", () => {
    expect(un(r, "personne.civilite")?.valeur).toBe("Dr");
    expect(un(r, "personne.nom")).toMatchObject({ valeur: "KACI", valeurNormalisee: "KACI" });
    expect(un(r, "personne.prenoms")?.valeur).toBe("Yasmine");
    expect(un(r, "personne.naissance")?.valeurNormalisee).toBe("1991-02-14");
    expect(un(r, "personne.lieuNaissance")?.valeur).toBe("Tizi Ouzou");
    expect(un(r, "personne.nationalite")?.valeurNormalisee).toBe("DZA");
  });

  it("lit les coordonnées en E.164 et l'e-mail en minuscules", () => {
    expect(tous(r, "personne.telephone").map((f) => f.valeurNormalisee)).toEqual(["+213550123456", "+21321234567"]);
    expect(un(r, "personne.email")?.valeurNormalisee).toBe("yasmine.kaci@exemple.dz");
  });

  it("lit les diplômes de la rubrique Formation, l'année seule rattachée", () => {
    const d = tous(r, "personne.diplome").map((f) => f.valeur);
    expect(d).toHaveLength(3);
    expect(d[0]).toBe("2015 – 2017 : Master en pharmacologie clinique, Université d'Alger 1");
    expect(d[1]).toContain("Docteur en pharmacie");
    expect(d[2]).toContain("Baccalauréat");
  });

  it("lit les expériences datées, pas leurs puces", () => {
    const e = tous(r, "personne.experience").map((f) => f.valeur);
    expect(e).toEqual([
      "Depuis mars 2020 : Déléguée médicale, Laboratoire Exemple Pharma — Alger Centre",
      "2017 - 2020 : Pharmacienne assistante, Pharmacie du Centre, Bab Ezzouar",
    ]);
  });

  it("tire la fonction du poste en cours, avec une confiance modeste", () => {
    expect(un(r, "personne.fonction")).toMatchObject({ valeur: "Déléguée médicale", confiance: 0.5 });
  });

  it("lit les langues avec leur niveau, normalisées en ISO 639", () => {
    const l = tous(r, "personne.langue");
    expect(l.map((f) => f.valeurNormalisee)).toEqual(["ar", "fr", "en"]);
    expect(l[1]!.valeur).toBe("Français (courant)");
  });

  it("ne prend pas « Français (courant) » pour une nationalité, ni la rubrique Compétences pour un diplôme", () => {
    expect(tous(r, "personne.nationalite")).toHaveLength(1);
    expect(tous(r, "personne.diplome").some((f) => /veeva/i.test(f.valeur))).toBe(false);
  });
});

describe("extraireCv — CV anglais", () => {
  const r = extraireCv({ texte: CV_EN });

  it("lit le téléphone étranger et l'e-mail", () => {
    expect(un(r, "personne.telephone")?.valeurNormalisee).toBe("+442079460958");
    expect(un(r, "personne.email")?.valeurNormalisee).toBe("j.smith@example.co.uk");
  });

  it("sépare nom et prénoms grâce à l'e-mail quand tout est en capitales", () => {
    expect(un(r, "personne.nom")?.valeur).toBe("SMITH");
    expect(un(r, "personne.prenoms")?.valeur).toBe("JOHN A.");
  });

  it("lit la date anglaise, la nationalité, les expériences et la fonction en cours", () => {
    expect(un(r, "personne.naissance")?.valeurNormalisee).toBe("1980-03-05");
    expect(un(r, "personne.nationalite")?.valeurNormalisee).toBe("GBR");
    expect(tous(r, "personne.experience")).toHaveLength(2);
    expect(un(r, "personne.fonction")?.valeur).toBe("Regulatory Affairs Manager");
  });

  it("lit les diplômes EN et la ligne « Languages: » hors rubrique", () => {
    expect(tous(r, "personne.diplome").map((f) => f.valeur)).toEqual(["2004 PhD in Pharmaceutical Sciences, University of Example", "2001 MSc Pharmacology"]);
    expect(tous(r, "personne.langue").map((f) => f.valeurNormalisee)).toEqual(["en", "fr", "ar"]);
  });
});

describe("extraireCv — ce qui n'est pas lu est dit", () => {
  it("un CV maigre : peu de faits, des notes", () => {
    const r = extraireCv({ texte: "Karim Haddad\nCommercial terrain, motivé et dynamique." });
    expect(un(r, "personne.nom")).toBeUndefined();
    expect(r.notes.some((n) => n.includes("Karim Haddad") && n.includes("séparer"))).toBe(true);
    expect(r.notes).toEqual(expect.arrayContaining([
      "Aucune adresse e-mail lue.",
      "Aucune rubrique « Expérience » trouvée : aucune expérience proposée.",
      "Aucune langue reconnue.",
    ]));
  });

  it("un texte vide : aucune extraction, une note", () => {
    const r = extraireCv({ texte: "  \n\f ", nomFichier: "cv.docx" });
    expect(r.faits).toEqual([]);
    expect(r.notes[0]).toContain("cv.docx");
  });

  it("une plage d'années n'est pas prise pour un téléphone", () => {
    const r = extraireCv({ texte: "EXPÉRIENCE\n2008 - 2012 : Délégué médical, Exemple SPA" });
    expect(tous(r, "personne.telephone")).toEqual([]);
  });

  it("étiquettes « Nom : » et « Prénom(s) : » prioritaires", () => {
    const r = extraireCv({ texte: "CURRICULUM VITAE\nNom : Meziane\nPrénom(s) : Lydia\nSpécialité : Cardiologie\nDate de naissance : 1er avril 1988" });
    expect(un(r, "personne.nom")?.valeurNormalisee).toBe("MEZIANE");
    expect(un(r, "personne.prenoms")?.valeur).toBe("Lydia");
    expect(un(r, "personne.specialite")?.valeur).toBe("Cardiologie");
    expect(un(r, "personne.naissance")?.valeurNormalisee).toBe("1988-04-01");
  });
});
