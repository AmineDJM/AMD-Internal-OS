import { describe, expect, it } from "vitest";
import { ficheOuverte, naissanceVisible, rolesVisibles, type Regard } from "@/lib/referentiels/personnes/visibilite";

const regard = (r: Partial<Regard>): Regard => ({ lignesVues: [], salarieVuParLesRh: false, conduitLaRefonte: false, ...r });

describe("Ce que la fiche Personne montre à qui", () => {
  it("une Personne qu'on ne voit nulle part ailleurs ne s'ouvre pas (sauf au Super Admin)", () => {
    expect(ficheOuverte(regard({}))).toBe(false);
    expect(ficheOuverte(regard({ conduitLaRefonte: true }))).toBe(true);
    expect(ficheOuverte(regard({ lignesVues: [{ source: "MedicalDoctor", racine: null }] }))).toBe(true);
  });

  it("un rôle ne se montre que si une ligne VISIBLE l'apporte — la candidature d'un praticien reste au recrutement", () => {
    const r = regard({ lignesVues: [{ source: "MedicalDoctor", racine: null }] });
    expect(rolesVisibles(["PROFESSIONNEL_SANTE", "CANDIDAT", "COLLABORATEUR"], r)).toEqual(["PROFESSIONNEL_SANTE"]);
    expect(rolesVisibles(["PROFESSIONNEL_SANTE", "CANDIDAT"], regard({ conduitLaRefonte: true }))).toEqual(["PROFESSIONNEL_SANTE", "CANDIDAT"]);
  });

  it("l'entrée d'annuaire d'un collègue ne justifie pas le rôle « contact d'un tiers » porté par une autre fiche", () => {
    const r = regard({ lignesVues: [{ source: "DirectoryEntry", racine: { source: "User", id: "u" } }] });
    expect(rolesVisibles(["CONTACT_TIERS", "COLLABORATEUR"], r)).toEqual([]);
  });

  it("la date de naissance ne se montre qu'à qui ouvre le dossier salarié par la porte des RH", () => {
    expect(naissanceVisible(regard({ lignesVues: [{ source: "Employee", racine: null }] }))).toBe(false);
    expect(naissanceVisible(regard({ salarieVuParLesRh: true }))).toBe(true);
  });
});
