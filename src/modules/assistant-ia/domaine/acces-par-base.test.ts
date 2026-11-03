import { describe, expect, it } from "vitest";
import { appliquerBases, familleOuverte, perimetreCouvrant, resoudreAccesIa, type FamilleIa } from "./acces-regles";

/** D5 (décision 0057) — l'accès par base par-dessus les familles de l'assistant (sous l'application stricte). */
const tous = (v: boolean) => Object.fromEntries(["SALAIRES", "BUDGETS", "CONTRATS_RH", "FICHES", "DRIVE", "REGLEMENTAIRE", "AD_PRO", "ECRITURES", "VISUELS"].map((f) => [f, v])) as Record<FamilleIa, boolean>;
const employe = () => resoudreAccesIa({ superAdmin: false, droits: tous(true) });
const sa = () => resoudreAccesIa({ superAdmin: true, droits: tous(true) });
const vide = { fermees: [], ouvertes: [], perimetres: [] };

describe("D5 — les bases par-dessus les familles de l'assistant", () => {
  it("sans application stricte (bases nulles) : rien ne change", () => {
    expect(appliquerBases(employe(), null)).toEqual(employe());
    expect(appliquerBases(sa(), null).superAdmin).toBe(true);
  });

  it("une base fermée ferme ses familles — Super Admin compris, qui garde le reste", () => {
    const e = appliquerBases(employe(), { ...vide, fermees: ["BUDGETS"] });
    expect(familleOuverte(e, "BUDGETS")).toBe(false);
    expect(familleOuverte(e, "DRIVE")).toBe(true);
    const s = appliquerBases(sa(), { ...vide, fermees: ["SALAIRES"] });
    expect(s.superAdmin).toBe(false);
    expect(familleOuverte(s, "SALAIRES")).toBe(false);
    expect(perimetreCouvrant(s, "SALAIRES", "x")).toBeNull();
    expect(perimetreCouvrant(s, "CONTRATS_RH", "x")).not.toBeNull(); // le reste de sa souveraineté
  });

  it("une ouverture NOMINATIVE de la Paie ouvre la famille ET un périmètre d'origine « base » ; une fermeture de la console prime", () => {
    const ouverture = { fermees: [], ouvertes: ["SALAIRES"], perimetres: [{ famille: "SALAIRES", du: "2026-11-01T00:00:00.000Z", au: null, ref: "r1", motif: "Audit" }] };
    const e = appliquerBases(employe(), ouverture);
    expect(familleOuverte(e, "SALAIRES")).toBe(true);
    expect(perimetreCouvrant(e, "SALAIRES", "entite")).toMatchObject({ origine: "BASE", ref: "r1", motif: "Audit" });
    const fermeeParLaConsole = appliquerBases(employe(), ouverture, ["SALAIRES"]);
    expect(familleOuverte(fermeeParLaConsole, "SALAIRES")).toBe(false);
    expect(perimetreCouvrant(fermeeParLaConsole, "SALAIRES", "entite")).toBeNull();
  });

  it("une ouverture de RÔLE (sans périmètre) ouvre la famille sans ouvrir les valeurs sensibles d'autrui", () => {
    const e = appliquerBases(employe(), { fermees: [], ouvertes: ["SALAIRES"], perimetres: [] });
    expect(familleOuverte(e, "SALAIRES")).toBe(true);
    expect(perimetreCouvrant(e, "SALAIRES", "entite")).toBeNull();
  });
});
