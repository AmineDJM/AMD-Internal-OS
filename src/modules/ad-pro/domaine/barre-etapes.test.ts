import { describe, expect, it } from "vitest";
import { barreDesEtapes, titreDuCircuit, type EntreeBarre, type EtapeLue } from "./barre-etapes";

/**
 * LA BARRE « OÙ EN EST LA DEMANDE » — cinq natures, avant et après la prévalidation, la déclaration pas encore puis ouverte.
 */

const demande: EtapeLue = { cle: "__demande__", titre: "Demande", etat: "done", detail: "12 nov. · Y. Habes" };
const enCours = (aVous = false): EntreeBarre["circuit"] => ({
  statut: "IN_PROGRESS", aVous,
  frise: [
    demande,
    { cle: "preliminary", titre: "Superviseur national", etat: "done", detail: "13 nov. · K. Bey" },
    { cle: "marketing", titre: "Direction Marketing", etat: "current", detail: "Amina Saadi" },
  ],
});
const approuve: EntreeBarre["circuit"] = {
  statut: "APPROVED", aVous: false,
  frise: [
    demande,
    { cle: "preliminary", titre: "Superviseur national", etat: "done", detail: "13 nov. · K. Bey" },
    { cle: "marketing", titre: "Direction Marketing", etat: "done", detail: "18 nov. · A. Saadi" },
  ],
};
const declarationPasEncore = { etat: "todo" as const, detail: "après les devis validés et le budget choisi", aVous: false };
const declarationOuverte = { etat: "current" as const, detail: "chez R. Lounis", aVous: false };

const vue = (e: EntreeBarre) => barreDesEtapes(e).map((x) => `${x.titre}:${x.etat}${x.sousTitre ? `(${x.sousTitre})` : ""}`);

describe("la barre des étapes d'une fiche Ad & Pro", () => {
  it("SPONSORING avant la prévalidation : cinq étapes, la prévalidation chez qui la tient, le reste à venir", () => {
    const e: EntreeBarre = {
      nature: "SPONSORING", circuit: enCours(), deposee: { detail: null },
      postes: { ouverts: false, termines: false, aVous: false, n: 0 },
      validationFinale: { etat: "todo", detail: "Direction Marketing", aVous: false },
      declaration: declarationPasEncore,
    };
    expect(vue(e)).toEqual([
      "Demande:fait(12 nov. · Y. Habes)",
      "Prévalidation:en_cours(Direction Marketing — chez Amina Saadi)",
      "Postes:a_venir",
      "Validation finale:a_venir",
      "Déclaration:a_venir",
    ]);
    // La déclaration grisée dit seulement, au survol, ce qu'elle attend.
    expect(barreDesEtapes(e).at(-1)?.aide).toBe("après les devis validés et le budget choisi");
  });

  it("SPONSORING : c'est à la personne qui regarde — « chez vous »", () => {
    const e: EntreeBarre = {
      nature: "SPONSORING", circuit: enCours(true), deposee: { detail: null },
      postes: { ouverts: false, termines: false, aVous: false, n: 0 }, validationFinale: null, declaration: null,
    };
    expect(barreDesEtapes(e)[1]?.sousTitre).toBe("Direction Marketing — chez vous");
  });

  it("SPONSORING après la prévalidation : postes en cours chez la Direction Marketing, puis la validation finale", () => {
    const e: EntreeBarre = {
      nature: "SPONSORING", circuit: approuve, deposee: { detail: null },
      postes: { ouverts: true, termines: false, aVous: false, n: 3, chez: "la Direction Marketing" },
      validationFinale: { etat: "todo", detail: "Direction Marketing", aVous: false },
      declaration: declarationPasEncore,
    };
    expect(vue(e)).toEqual([
      "Demande:fait(12 nov. · Y. Habes)",
      "Prévalidation:fait(18 nov. · A. Saadi)",
      "Postes:en_cours(chez la Direction Marketing)",
      "Validation finale:a_venir",
      "Déclaration:a_venir",
    ]);
  });

  it("SPONSORING clôturé, déclaration ouverte : la déclaration dit chez qui ; à la personne qui la tient, « chez vous »", () => {
    const e: EntreeBarre = {
      nature: "SPONSORING", circuit: approuve, deposee: { detail: null },
      postes: { ouverts: false, termines: true, aVous: false, n: 2 },
      validationFinale: { etat: "done", detail: "20 nov. · A. Saadi", aVous: false },
      declaration: declarationOuverte,
    };
    expect(vue(e).slice(2)).toEqual(["Postes:fait(2 postes)", "Validation finale:fait(20 nov. · A. Saadi)", "Déclaration:en_cours(chez R. Lounis)"]);
    expect(barreDesEtapes({ ...e, declaration: { ...declarationOuverte, aVous: true } }).at(-1)?.sousTitre).toBe("chez vous");
  });

  it("ÉVÉNEMENT non soumis : la demande est à soumettre, la validation à venir — quatre étapes", () => {
    const e: EntreeBarre = {
      nature: "EVENT", circuit: null, deposee: { detail: "3 nov.", aSoumettre: true, aVous: true },
      postes: { ouverts: false, termines: false, aVous: false, n: 0 }, validationFinale: null,
      declaration: declarationPasEncore,
    };
    expect(vue(e)).toEqual(["Demande:en_cours(à soumettre — chez vous)", "Validation:a_venir", "Postes:a_venir", "Déclaration:a_venir"]);
  });

  it("ÉVÉNEMENT validé, un poste attend la personne qui regarde", () => {
    const e: EntreeBarre = {
      nature: "EVENT", circuit: approuve, deposee: { detail: null },
      postes: { ouverts: true, termines: false, aVous: true, n: 2 }, validationFinale: null, declaration: declarationPasEncore,
    };
    expect(vue(e)).toEqual(["Demande:fait(12 nov. · Y. Habes)", "Validation:fait(18 nov. · A. Saadi)", "Postes:en_cours(chez vous)", "Déclaration:a_venir"]);
  });

  it("AUTRE DEMANDE : pas de déclaration — trois étapes ; renvoyée, elle est « à corriger — chez le demandeur »", () => {
    const e: EntreeBarre = {
      nature: "AD_PRO_OTHER", circuit: { ...enCours()!, statut: "RETURNED" }, deposee: { detail: null },
      postes: { ouverts: false, termines: false, aVous: false, n: 0 }, validationFinale: null, declaration: null,
    };
    expect(vue(e)).toEqual(["Demande:fait(12 nov. · Y. Habes)", "Prévalidation:en_cours(à corriger — chez le demandeur)", "Postes:a_venir"]);
    expect(barreDesEtapes({ ...e, circuit: { ...e.circuit!, aVous: true } })[1]?.sousTitre).toBe("à corriger — chez vous");
  });

  it("PRISE EN CHARGE NATIONALE refusée : la case du circuit le dit, avec qui et quand", () => {
    const e: EntreeBarre = {
      nature: "CONGRESS_NATIONAL",
      circuit: { statut: "REJECTED", aVous: false, frise: [demande, { cle: "marketing", titre: "Direction Marketing", etat: "rejected", detail: "18 nov. · A. Saadi" }] },
      deposee: { detail: null }, postes: { ouverts: false, termines: false, aVous: false, n: 0 }, validationFinale: null,
      declaration: declarationPasEncore,
    };
    expect(vue(e).slice(0, 2)).toEqual(["Demande:fait(12 nov. · Y. Habes)", "Validation:refuse(refusée · 18 nov. · A. Saadi)"]);
  });

  it("PRISE EN CHARGE INTERNATIONALE à une seule étape : le titre de la case suffit, la date de la demande vient de la fiche", () => {
    const e: EntreeBarre = {
      nature: "CONGRESS_INTERNATIONAL",
      circuit: { statut: "IN_PROGRESS", aVous: false, frise: [{ cle: "marketing", titre: "Direction Marketing", etat: "current", detail: "Direction Marketing" }] },
      deposee: { detail: "2 nov." }, postes: { ouverts: false, termines: false, aVous: false, n: 0 }, validationFinale: null,
      declaration: declarationOuverte,
    };
    expect(vue(e)).toEqual(["Demande:fait(2 nov.)", "Validation:en_cours(chez Direction Marketing)", "Postes:a_venir", "Déclaration:en_cours(chez R. Lounis)"]);
  });

  it("jamais plus de cinq étapes, et le circuit s'appelle selon la nature", () => {
    for (const nature of ["SPONSORING", "EVENT", "AD_PRO_OTHER", "CONGRESS_NATIONAL", "CONGRESS_INTERNATIONAL"] as const) {
      const n = barreDesEtapes({
        nature, circuit: approuve, deposee: { detail: null },
        postes: { ouverts: true, termines: false, aVous: false, n: 1 },
        validationFinale: { etat: "todo", aVous: false }, declaration: declarationPasEncore,
      }).length;
      expect(n).toBeLessThanOrEqual(5);
    }
    expect(titreDuCircuit("SPONSORING")).toBe("Prévalidation");
    expect(titreDuCircuit("AD_PRO_OTHER")).toBe("Prévalidation");
    expect(titreDuCircuit("EVENT")).toBe("Validation");
    expect(titreDuCircuit("CONGRESS_NATIONAL")).toBe("Validation");
  });
});
