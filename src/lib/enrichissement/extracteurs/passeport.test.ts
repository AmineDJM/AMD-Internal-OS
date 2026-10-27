import { describe, expect, it } from "vitest";
import { ATTRIBUT_PAR_CLE } from "../types";
import { extrairePasseport, MOTEUR_PASSEPORT } from "./passeport";

const valeurDe = (r: ReturnType<typeof extrairePasseport>, attribut: string) => r.faits.find((f) => f.attribut === attribut);

/** Une page de passeport algérien telle que la rend l'OCR local (données fictives, MRZ cohérente). */
const PASSEPORT_DZ = `République Algérienne Démocratique et Populaire
PASSEPORT / PASSPORT
Type / Type P   Code / Code DZA   N° du passeport / Passport No. 198765432
Nom / Surname : BENALI
Prénoms / Given names : MOHAMED AMINE
Date de naissance / Date of birth : 12.03.1985
Lieu de naissance / Place of birth : ORAN
Sexe / Sex : M
P<DZABENALI<<MOHAMED<AMINE<<<<<<<<<<<<<<<<<<
1987654323DZA8503127M3304156<<<<<<<<<<<<<<04`;

describe("extrairePasseport", () => {
  it("lit un passeport algérien : faits du titulaire, sensibles marqués, local", () => {
    const r = extrairePasseport({ texte: PASSEPORT_DZ, nomFichier: "passeport-benali.pdf" });
    expect(r.nature).toBe("PASSEPORT");
    expect(r.moteur).toBe(MOTEUR_PASSEPORT);
    expect(r.local).toBe(true);
    expect(r.faits.every((f) => f.sujetRef === "titulaire" && f.role === "TITULAIRE" && f.sujetType === "PERSONNE")).toBe(true);

    expect(valeurDe(r, "personne.nom")).toMatchObject({ valeur: "Benali", valeurNormalisee: "BENALI", sensible: false });
    expect(valeurDe(r, "personne.prenoms")).toMatchObject({ valeur: "Mohamed Amine", valeurNormalisee: "MOHAMED AMINE" });
    expect(valeurDe(r, "personne.naissance")?.valeurNormalisee).toBe("1985-03-12");
    expect(valeurDe(r, "personne.sexe")?.valeurNormalisee).toBe("M");
    expect(valeurDe(r, "personne.nationalite")?.valeurNormalisee).toBe("DZA");
    expect(valeurDe(r, "personne.lieuNaissance")).toMatchObject({ valeur: "ORAN", valeurNormalisee: "oran" });

    const numero = valeurDe(r, "personne.passeport.numero")!;
    expect(numero).toMatchObject({ valeur: "198765432", sensible: true });
    expect(numero.confiance).toBeGreaterThanOrEqual(0.9);
    expect(valeurDe(r, "personne.passeport.expiration")).toMatchObject({ valeurNormalisee: "2033-04-15", sensible: true });
    expect(r.notes.some((n) => /contrôle/i.test(n))).toBe(false);
  });

  it("recopie la sensibilité du catalogue pour chaque fait", () => {
    const r = extrairePasseport({ texte: PASSEPORT_DZ });
    for (const f of r.faits) expect(f.sensible).toBe(ATTRIBUT_PAR_CLE.get(f.attribut)!.sensible);
  });

  it("ne laisse pas le numéro du passeport dans la preuve d'un fait non sensible", () => {
    const r = extrairePasseport({ texte: PASSEPORT_DZ });
    for (const f of r.faits.filter((x) => !x.sensible)) expect(f.preuve.extrait).not.toContain("198765432");
  });

  it("lit le spécimen OACI (TD3) et garde le code « UTO » tel quel", () => {
    const r = extrairePasseport({
      texte: "P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<\nL898902C36UTO7408122F1204159ZE184226B<<<<<10",
    });
    expect(valeurDe(r, "personne.nom")?.valeur).toBe("Eriksson");
    expect(valeurDe(r, "personne.prenoms")?.valeur).toBe("Anna Maria");
    expect(valeurDe(r, "personne.passeport.numero")?.valeur).toBe("L898902C3");
    expect(valeurDe(r, "personne.nationalite")?.valeurNormalisee).toBe("UTO");
    expect(valeurDe(r, "personne.sexe")?.valeur).toBe("F");
  });

  it("un chiffre de contrôle faux : confiance basse et note, valeur non corrigée", () => {
    // Le numéro lu « 198765433 » ne colle plus à son chiffre de contrôle (3).
    const texte = PASSEPORT_DZ.replace("1987654323DZA", "1987654333DZA");
    const r = extrairePasseport({ texte });
    const numero = valeurDe(r, "personne.passeport.numero")!;
    expect(numero.valeur).toBe("198765433");
    expect(numero.confiance).toBeLessThanOrEqual(0.3);
    expect(r.notes.some((n) => n.includes("numéro du passeport"))).toBe(true);
    // Le contrôle global tombe aussi : le reste est plafonné.
    expect(valeurDe(r, "personne.naissance")!.confiance).toBeLessThanOrEqual(0.5);
    expect(valeurDe(r, "personne.nom")!.confiance).toBeLessThan(0.9);
  });

  it("une page de saut (\\f) donne la page de la preuve", () => {
    const r = extrairePasseport({ texte: `Page de garde\f${PASSEPORT_DZ}` });
    expect(valeurDe(r, "personne.nom")?.preuve.page).toBe(2);
  });

  it("sans MRZ : aucun fait, une note qui le dit", () => {
    const r = extrairePasseport({ texte: "Scan illisible, seulement la photo.", nomFichier: "scan.jpg" });
    expect(r.faits).toEqual([]);
    expect(r.notes[0]).toContain("scan.jpg");
    expect(r.local).toBe(true);
  });

  it("tolère les espaces et les chevrons déguisés de l'OCR", () => {
    const texte = "P<DZA BENALI««MOHAMED‹AMINE<<<<<<<<<<<<<<<<<<\n1987654323 DZA 8503127 M 3304156 <<<<<<<<<<<<<< 04";
    const r = extrairePasseport({ texte });
    expect(valeurDe(r, "personne.nom")?.valeur).toBe("Benali");
    expect(valeurDe(r, "personne.passeport.numero")?.confiance).toBeGreaterThan(0.9);
  });
});
