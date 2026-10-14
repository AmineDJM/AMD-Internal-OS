import { describe, expect, it } from "vitest";
import { TYPES_DOCUMENT } from "@/lib/artifact/factory/commercial";
import { avecModeleParType, lireModelesParType, papiersUtilisables, resoudrePapierEnTete, TYPES_MODELE } from "./modeles";

const A = "societe-A", B = "societe-B";
const lh = (id: string, companyId: string | null, extra: Partial<{ kind: string; isActive: boolean }> = {}) =>
  ({ id, companyId, kind: "word", isActive: true, ...extra });

const bibliotheque = [
  lh("a-general", A),
  lh("a-bc", A),
  lh("a-retire", A, { isActive: false }),
  lh("a-excel", A, { kind: "cell" }),
  lh("commun", null),
  lh("b-bc", B),
];

describe("la règle du papier d'une pièce — choisi > modèle de la nature > défaut > premier de l'entité", () => {
  it("le papier CHOISI passe avant tout", () => {
    const r = resoudrePapierEnTete(bibliotheque, { societeId: A, choisi: "commun", parNature: "a-bc", defaut: "a-general" });
    expect(r).toMatchObject({ papier: { id: "commun" }, source: "choisi", choisiIntrouvable: false });
  });

  it("sans choix : le modèle désigné pour la nature (un BC prend le modèle de BC)", () => {
    const r = resoudrePapierEnTete(bibliotheque, { societeId: A, parNature: "a-bc", defaut: "a-general" });
    expect(r).toMatchObject({ papier: { id: "a-bc" }, source: "nature" });
  });

  it("sans modèle pour la nature : le papier par défaut de l'entité", () => {
    const r = resoudrePapierEnTete(bibliotheque, { societeId: A, parNature: null, defaut: "commun" });
    expect(r).toMatchObject({ papier: { id: "commun" }, source: "defaut" });
  });

  it("sans rien de désigné : le premier papier Word ACTIF de l'entité, puis un commun", () => {
    expect(resoudrePapierEnTete(bibliotheque, { societeId: A })).toMatchObject({ papier: { id: "a-general" }, source: "entite" });
    expect(resoudrePapierEnTete(bibliotheque, { societeId: "societe-C" })).toMatchObject({ papier: { id: "commun" }, source: "commun" });
    expect(resoudrePapierEnTete([lh("b-bc", B)], { societeId: A })).toMatchObject({ papier: null, source: null, choisiIntrouvable: false });
  });

  it("JAMAIS le papier d'une autre entité — ni désigné par la nature, ni par défaut : on descend d'un cran", () => {
    const r = resoudrePapierEnTete(bibliotheque, { societeId: A, parNature: "b-bc", defaut: "b-bc" });
    expect(r.papier?.id).toBe("a-general");
    expect(r.source).toBe("entite");
  });

  it("un papier CHOISI d'une autre entité, retiré ou non-Word est refusé (la fabrique répond « introuvable »)", () => {
    for (const choisi of ["b-bc", "a-retire", "a-excel", "inexistant"]) {
      expect(resoudrePapierEnTete(bibliotheque, { societeId: A, choisi })).toMatchObject({ papier: null, choisiIntrouvable: true });
    }
  });

  it("un modèle désigné puis retiré est sauté", () => {
    expect(resoudrePapierEnTete(bibliotheque, { societeId: A, parNature: "a-retire", defaut: "a-bc" })).toMatchObject({ papier: { id: "a-bc" }, source: "defaut" });
  });

  it("papiersUtilisables : les siens d'abord, puis les communs, jamais ceux d'une autre entité", () => {
    expect(papiersUtilisables(bibliotheque, A).map((l) => l.id)).toEqual(["a-general", "a-bc", "commun"]);
    expect(papiersUtilisables(bibliotheque, B).map((l) => l.id)).toEqual(["b-bc", "commun"]);
  });
});

describe("settings.modelesParType — lecture et écriture sans toucher au reste du profil", () => {
  it("lit les entrées bien formées, ignore le reste", () => {
    expect(lireModelesParType(null)).toEqual({});
    expect(lireModelesParType({ modelesParType: [] })).toEqual({});
    expect(lireModelesParType({ modelesParType: { BON_DE_COMMANDE: " x ", DEVIS: 3, INCONNU: "y", FACTURE: "" } })).toEqual({ BON_DE_COMMANDE: "x" });
  });

  it("écrit une nature et garde les autres clés (marque, numérotation) ; vide = retire", () => {
    const avant = { marque: { couleurs: { accent: "0B2545" } }, numerotation: { FACTURE: "{n:3}/FS/{aa}" }, modelesParType: { DEVIS: "d" } };
    const apres = avecModeleParType(avant, "BON_DE_COMMANDE", "bc");
    expect(apres).toEqual({ ...avant, modelesParType: { DEVIS: "d", BON_DE_COMMANDE: "bc" } });
    expect(avant.modelesParType).toEqual({ DEVIS: "d" }); // pas de mutation
    expect(avecModeleParType(apres, "DEVIS", null).modelesParType).toEqual({ BON_DE_COMMANDE: "bc" });
  });

  it("couvre exactement les natures que la fabrique émet (TYPES_DOCUMENT)", () => {
    expect([...TYPES_MODELE].sort()).toEqual([...TYPES_DOCUMENT].sort());
  });
});
