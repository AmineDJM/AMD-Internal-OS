import { describe, expect, it } from "vitest";
import { autresActions, depuis, lignesARelire, type EntreeFile } from "./file-actions";

const maintenant = new Date(2026, 10, 24, 10);
const liens: EntreeFile["liens"] = {
  relire: (id) => `/planning?relire=${id}`,
  plan: (id) => `/plan?${id ?? ""}`,
  rapports: (rep) => `/rapports?delegue=${rep}`,
  territoire: (bu) => `/bu?${bu ?? ""}`,
  coaching: (rep) => `/coaching?${rep}`,
  casPv: (id, n) => (n === 1 ? `/cas/${id}` : "/rapports"),
  nonVues: "/planning?liste=non-vues",
};
const entree = (x: Partial<EntreeFile> = {}): EntreeFile => ({
  maintenant, aRelire: { total: 0, lignes: [] }, plansSoumis: [], retards: [], panelsVides: [], coachings: [], casPv: { total: 0, premierId: null }, liens, ...x,
});

describe("la file d'actions du superviseur — une ligne, un fait, un bouton", () => {
  it("un rapport à relire : le possible cas de PV dit sa raison et sa citation ; « Relire » ouvre le panneau", () => {
    const [pv, banal] = lignesARelire(entree({
      aRelire: {
        total: 2,
        lignes: [
          { visitId: "v1", date: new Date(2026, 10, 22), delegue: "Amel", praticien: "Dr Achour", pvIa: "PROBABLE", raison: "Éruption chez une patiente.", extrait: "Une patiente a fait une éruption" },
          { visitId: "v2", date: new Date(2026, 10, 21), delegue: "Karim", praticien: null, pvIa: "AUCUN", raison: "Objection sur le prix.", extrait: null },
        ],
      },
    }));
    expect(pv).toMatchObject({ ton: "ko", titre: "Amel — Dr Achour, 22/11", sous: "Probable cas de pharmacovigilance : Éruption chez une patiente.", citation: "Une patiente a fait une éruption", bouton: { libelle: "Relire", href: "/planning?relire=v1" } });
    expect(banal).toMatchObject({ ton: "i", titre: "Karim — praticien non précisé, 21/11", sous: "Objection sur le prix.", citation: null });
  });

  it("les autres faits, dans l'ordre : décider, voir les retards, corriger le panel, coacher, ouvrir la PV", () => {
    const a = autresActions(entree({
      plansSoumis: [{ repId: "k1", nom: "Amel", planId: "p1", soumisLe: new Date(2026, 10, 21, 9) }],
      retards: [{ repId: "k1", nom: "Amel", rapportsEnRetard: 0 }, { repId: "k2", nom: "Karim", rapportsEnRetard: 3 }],
      panelsVides: [{ repId: "k3", nom: "Lina", buId: "bu1", cause: "SANS_SECTEUR" }],
      coachings: [{ repId: "k2", nom: "Karim", dernier: null }],
      casPv: { total: 1, premierId: "c1" },
    }));
    expect(a.map((x) => [x.titre, x.bouton?.libelle, x.bouton?.href])).toEqual([
      ["Plan de tournée de Amel — soumis il y a 3 j", "Décider", "/plan?p1"],
      ["3 rapports non faits — Karim", "Voir ses rapports", "/rapports?delegue=k2"],
      ["Panel vide — Lina : aucun territoire choisi dans sa BU", "Corriger le territoire", "/bu?bu1"],
      ["Pas de coaching depuis 60 j — Karim", "Nouvelle fiche", "/coaching?k2"],
      ["1 signalement de pharmacovigilance de l'équipe en cours", "Ouvrir", "/cas/c1"],
    ]);
  });

  it("sans le droit, pas de bouton qui mènerait à un refus", () => {
    const a = autresActions(entree({
      liens: { ...liens, rapports: null, territoire: null, coaching: null },
      retards: [{ repId: "k2", nom: "Karim", rapportsEnRetard: 1 }],
      panelsVides: [{ repId: "k3", nom: "Lina", buId: null, cause: "AUCUN_PRATICIEN" }],
      coachings: [{ repId: "k2", nom: "Karim", dernier: new Date(2026, 7, 1) }],
    }));
    expect(a.map((x) => x.bouton)).toEqual([null, null, null]);
    expect(a[0].titre).toBe("1 rapport non fait — Karim");
  });

  it("depuis : aujourd'hui, hier, il y a n j", () => {
    expect([new Date(2026, 10, 24, 8), new Date(2026, 10, 23, 8), new Date(2026, 10, 20, 8), null].map((d) => depuis(d, maintenant)))
      .toEqual(["aujourd'hui", "hier", "il y a 4 j", "date inconnue"]);
  });
});
