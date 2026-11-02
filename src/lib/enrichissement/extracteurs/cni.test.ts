import { describe, expect, it } from "vitest";
import { ATTRIBUT_PAR_CLE } from "../types";
import { extraireCni, lireMrzTd1, MOTEUR_CNI } from "./cni";

const SPECIMEN_OACI_TD1 = "I<UTOD231458907<<<<<<<<<<<<<<<\n7408122F1204159UTO<<<<<<<<<<<6\nERIKSSON<<ANNA<MARIA<<<<<<<<<<";

/** Recto + verso d'une CNI biométrique algérienne (données fictives, MRZ cohérente). */
const CNI_DZ = `الجمهورية الجزائرية الديمقراطية الشعبية
REPUBLIQUE ALGERIENNE DEMOCRATIQUE ET POPULAIRE
CARTE NATIONALE D'IDENTITE
Nom : BOUZID
Prénom(s) : NADIA SARAH
Date de naissance : 25.07.1990
Lieu de naissance : CONSTANTINE
رقم التعريف الوطني NIN : 109 900 725 012 345 678
\f
IDDZA4012345676<<<<<<<<<<<<<<<
9007253F3108206DZA<<<<<<<<<<<0
BOUZID<<NADIA<SARAH<<<<<<<<<<<`;

const fait = (r: ReturnType<typeof extraireCni>, attribut: string) => r.faits.find((f) => f.attribut === attribut);

describe("lireMrzTd1", () => {
  it("lit le spécimen OACI TD1 (9303 partie 5) avec tous ses contrôles justes", () => {
    const lu = lireMrzTd1(SPECIMEN_OACI_TD1)!;
    expect(lu).toMatchObject({
      typeDocument: "I", pays: "UTO", numero: "D23145890", nom: "ERIKSSON", prenoms: "ANNA MARIA",
      nationalite: "UTO", naissance: "1974-08-12", sexe: "F", expiration: "2012-04-15", controlesFaux: [],
    });
  });

  it("dit chaque contrôle faux sans corriger", () => {
    const lu = lireMrzTd1(SPECIMEN_OACI_TD1.replace("7408122F", "7408132F"))!;
    expect(lu.naissance).toBe("1974-08-13");
    expect(lu.controlesFaux).toEqual(["date de naissance", "contrôle composite"]);
    expect(lireMrzTd1(SPECIMEN_OACI_TD1.replace("D231458907", "D231458917"))!.controlesFaux).toContain("numéro de la carte");
  });

  it("lit un numéro long qui déborde dans les données facultatives (9303-5, note j)", () => {
    const lu = lireMrzTd1("I<UTOAB1234567<89011<<<<<<<<<<\n7408122F1204159UTO<<<<<<<<<<<8\nERIKSSON<<ANNA<MARIA<<<<<<<<<<")!;
    expect(lu.numero).toBe("AB12345678901");
    expect(lu.controlesFaux).toEqual([]);
  });

  it("corrige les confusions OCR sur les positions numériques seulement", () => {
    const lu = lireMrzTd1(SPECIMEN_OACI_TD1.replace("7408122F1204159", "74O8122F12O4159"))!;
    expect(lu.naissance).toBe("1974-08-12");
    expect(lu.expiration).toBe("2012-04-15");
    expect(lu.controlesFaux).toEqual([]);
  });

  it("ne confond pas une MRZ de passeport (TD3) avec une TD1", () => {
    expect(lireMrzTd1("P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<\nL898902C36UTO7408122F1204159ZE184226B<<<<<10")).toBeNull();
  });
});

describe("extraireCni", () => {
  it("lit une CNI biométrique algérienne : MRZ au verso, NIN et lieu au recto", () => {
    const r = extraireCni({ texte: CNI_DZ, nomFichier: "cni-bouzid.pdf" });
    expect(r).toMatchObject({ nature: "CNI", moteur: MOTEUR_CNI, local: true });
    expect(fait(r, "personne.nom")).toMatchObject({ valeur: "Bouzid", valeurNormalisee: "BOUZID", confiance: 0.9 });
    expect(fait(r, "personne.prenoms")?.valeur).toBe("Nadia Sarah");
    expect(fait(r, "personne.naissance")?.valeurNormalisee).toBe("1990-07-25");
    expect(fait(r, "personne.sexe")?.valeurNormalisee).toBe("F");
    expect(fait(r, "personne.nationalite")?.valeurNormalisee).toBe("DZA");
    expect(fait(r, "personne.cni.numero")).toMatchObject({ valeur: "401234567", sensible: true, confiance: 0.95 });
    expect(fait(r, "personne.cni.numero")?.preuve.page).toBe(2);
    expect(fait(r, "personne.nin")).toMatchObject({ valeur: "109900725012345678", sensible: true });
    expect(fait(r, "personne.nin")?.preuve.page).toBe(1);
    expect(fait(r, "personne.lieuNaissance")?.valeur).toBe("CONSTANTINE");
    expect(r.notes.some((n) => n.includes("Expiration de la carte lue (2031-08-20)"))).toBe(true);
    for (const f of r.faits) expect(f.sensible).toBe(ATTRIBUT_PAR_CLE.get(f.attribut)!.sensible);
  });

  it("un contrôle composite faux plafonne toute la MRZ et le dit", () => {
    const r = extraireCni({ texte: CNI_DZ.replace("<<<<<<<<<<<0", "<<<<<<<<<<<9") });
    expect(fait(r, "personne.naissance")!.confiance).toBeLessThanOrEqual(0.5);
    expect(fait(r, "personne.cni.numero")!.confiance).toBeLessThanOrEqual(0.5);
    expect(r.notes.some((n) => n.includes("contrôle composite"))).toBe(true);
  });

  it("recto seul : zone visuelle lue avec une confiance moindre", () => {
    const recto = CNI_DZ.split("\f")[0]!;
    const r = extraireCni({ texte: recto, nomFichier: "recto.jpg" });
    expect(r.notes[0]).toContain("recto.jpg");
    expect(fait(r, "personne.nom")).toMatchObject({ valeur: "Bouzid", confiance: 0.6 });
    expect(fait(r, "personne.prenoms")?.valeur).toBe("Nadia Sarah");
    expect(fait(r, "personne.naissance")).toMatchObject({ valeur: "25.07.1990", valeurNormalisee: "1990-07-25" });
    expect(fait(r, "personne.nin")?.valeurNormalisee).toBe("109900725012345678");
    expect(fait(r, "personne.cni.numero")).toBeUndefined();
  });

  it("un NIN qui n'a pas 18 chiffres n'est pas proposé", () => {
    const r = extraireCni({ texte: CNI_DZ.replace("109 900 725 012 345 678", "109 900 725 012") });
    expect(fait(r, "personne.nin")).toBeUndefined();
    expect(r.notes.some((n) => n.includes("NIN"))).toBe(true);
  });

  it("le spécimen OACI passe aussi par l'extracteur, avec la note d'un État non algérien", () => {
    const r = extraireCni({ texte: SPECIMEN_OACI_TD1 });
    expect(fait(r, "personne.cni.numero")?.valeur).toBe("D23145890");
    expect(r.notes.some((n) => n.includes("UTO"))).toBe(true);
  });
});
