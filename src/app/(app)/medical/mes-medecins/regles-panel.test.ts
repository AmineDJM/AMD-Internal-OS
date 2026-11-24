import { describe, expect, it } from "vitest";
import { cleDeNom, plier } from "@/modules/referentiels/partage";
import { filtrerPanel, homonymesDansLePanel, phraseDernierPassage } from "./regles-panel";

const m = (nom: string, o: Partial<{ specialite: string; etablissement: string; wilaya: string; lettre: string; retard: string }> = {}) => ({
  nom, specialite: o.specialite ?? null, etablissement: o.etablissement ?? null, wilaya: o.wilaya ?? null, lettre: o.lettre ?? null, retard: o.retard ?? null,
});

describe("« Mes médecins » — les règles d'affichage", () => {
  const panel = [
    m("Pr Karim Benali", { specialite: "Cardiologie", etablissement: "CHU Frantz-Fanon", lettre: "H" }),
    m("Dr Nadia Chérif", { specialite: "Endocrinologie", wilaya: "Blida", lettre: "A", retard: "Non vu depuis 21 jours" }),
    m("Dr Amine Rahmani", { lettre: "C", retard: "Non vu depuis 63 jours" }),
  ];
  it("la recherche ignore casse et accents, et lit spécialité, établissement, wilaya", () => {
    expect(filtrerPanel(panel, { q: "cherif", lettre: "Toutes", retardSeul: false }).map((d) => d.nom)).toEqual(["Dr Nadia Chérif"]);
    expect(filtrerPanel(panel, { q: "frantz", lettre: "Toutes", retardSeul: false }).map((d) => d.nom)).toEqual(["Pr Karim Benali"]);
    expect(filtrerPanel(panel, { q: "blida", lettre: "Toutes", retardSeul: false })).toHaveLength(1);
  });
  it("la lettre et « en retard seulement » se combinent", () => {
    expect(filtrerPanel(panel, { q: "", lettre: "Toutes", retardSeul: true })).toHaveLength(2);
    expect(filtrerPanel(panel, { q: "", lettre: "C", retardSeul: true }).map((d) => d.nom)).toEqual(["Dr Amine Rahmani"]);
    expect(filtrerPanel(panel, { q: "", lettre: "H", retardSeul: true })).toHaveLength(0);
  });
  it("le dernier passage, à l'heure du serveur", () => {
    const now = "2026-11-24T12:00:00.000Z";
    expect(phraseDernierPassage(null, now)).toBe("jamais vu");
    expect(phraseDernierPassage("2026-11-24T08:00:00.000Z", now)).toBe("vu aujourd'hui");
    expect(phraseDernierPassage("2026-11-03T08:00:00.000Z", now)).toBe("il y a 21 j");
  });
  it("les homonymes du panel : même nom (ordre, accents, titres ignorés), ou le seul nom de famille tapé", () => {
    expect(homonymesDansLePanel(panel, "Karim BENALI", cleDeNom, plier).map((d) => d.nom)).toEqual(["Pr Karim Benali"]);
    expect(homonymesDansLePanel(panel, " Benali", cleDeNom, plier).map((d) => d.nom)).toEqual(["Pr Karim Benali"]);
    expect(homonymesDansLePanel(panel, "Kamel Benali", cleDeNom, plier)).toHaveLength(0);
    expect(homonymesDansLePanel(panel, "B", cleDeNom, plier)).toHaveLength(0);
  });
});
