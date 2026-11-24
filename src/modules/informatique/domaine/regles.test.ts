import { describe, expect, it } from "vitest";
import { bornesDuMois, dateDeLImputation, libelleMois, lireMois, moisDe, moisDeLAnneeJusqua, moisPrecedent } from "./mois";
import {
  detailAStocker, gesteImputation, lireDetail, lireTaux, montantDzd, repartirParSociete, societeDeLaPersonne, versMicroUsd,
  type AppelAgrege, type RattachementPersonne,
} from "./imputation";
import { CLE_LIGNE_ABONNEMENTS, CLE_LIGNE_IA, CLE_LIGNE_MATERIEL, choisirEnveloppe, lignesManquantes, rapprocher } from "./budget";
import { coutAnnuel, etatGarantie, lireDate, lireMontant, rappelDu } from "./registres";

describe("le mois d'imputation — heure d'Alger", () => {
  it("lit un mois, refuse le reste", () => {
    expect(lireMois("2026-11")).toBe("2026-11");
    expect(lireMois(" 2026-01 ")).toBe("2026-01");
    for (const v of ["2026-13", "2026-1", "26-11", "", null, 202611]) expect(lireMois(v)).toBeNull();
  });
  it("un appel à 23 h 30 à Alger le 31 appartient au mois qui finit", () => {
    expect(moisDe(new Date("2026-10-31T22:30:00Z"))).toBe("2026-10");
    expect(moisDe(new Date("2026-10-31T23:30:00Z"))).toBe("2026-11");
  });
  it("bornes, mois précédent, libellé, date de la ligne", () => {
    const { debut, fin } = bornesDuMois("2026-01");
    expect(debut.toISOString()).toBe("2025-12-31T23:00:00.000Z");
    expect(fin.toISOString()).toBe("2026-01-31T23:00:00.000Z");
    expect(moisPrecedent("2026-01")).toBe("2025-12");
    expect(libelleMois("2026-11")).toBe("novembre 2026");
    expect(dateDeLImputation("2026-02").toISOString()).toBe("2026-02-28T12:00:00.000Z");
    expect(moisDeLAnneeJusqua("2026-03")).toEqual(["2026-01", "2026-02", "2026-03"]);
  });
});

describe("le coût de l'IA réparti par société", () => {
  const personnes = new Map<string, RattachementPersonne>([
    ["a", { societeEmploye: "A", societeDepartement: "B", departementId: "dA", departementNom: "Marketing" }],
    ["b", { societeEmploye: null, societeDepartement: "B", departementId: "dB", departementNom: "Regulatory" }],
    ["c", { societeEmploye: null, societeDepartement: null, departementId: null, departementNom: null }],
  ]);
  const appels: AppelAgrege[] = [
    { userId: "a", feature: "assistant_ia", coutUsd: "1.250000", appels: 3, sansTarif: 0 },
    { userId: "a", feature: "brain", coutUsd: "0.100000", appels: 1, sansTarif: 1 },
    { userId: "b", feature: "assistant_ia", coutUsd: "2", appels: 2, sansTarif: 0 },
    { userId: "c", feature: null, coutUsd: "0.3", appels: 1, sansTarif: 0 },
    { userId: null, feature: "briefing", coutUsd: "0.7", appels: 4, sansTarif: 0 },
  ];

  it("la société de la personne : sa fiche d'abord, puis son département (comme l'argent)", () => {
    expect(societeDeLaPersonne(personnes.get("a"))).toBe("A");
    expect(societeDeLaPersonne(personnes.get("b"))).toBe("B");
    expect(societeDeLaPersonne(personnes.get("c"))).toBeNull();
    expect(societeDeLaPersonne(undefined)).toBeNull();
  });

  it("chaque société reçoit SES appels, avec le détail par fonction et par département ; le reste est dit, jamais réparti", () => {
    const r = repartirParSociete(appels, personnes);
    expect(r.parSociete.map((p) => [p.companyId, p.microUsd, p.appels, p.sansTarif])).toEqual([["B", 2_000_000, 2, 0], ["A", 1_350_000, 4, 1]]);
    const a = r.parSociete.find((p) => p.companyId === "A")!;
    expect(a.parFonction.map((f) => [f.libelle, f.microUsd])).toEqual([["Assistant IA", 1_250_000], ["Adventum Brain", 100_000]]);
    expect(a.parDepartement).toEqual([{ cle: "dA", libelle: "Marketing", microUsd: 1_350_000, appels: 4 }]);
    expect(r.nonRattache).toEqual({ microUsd: 1_000_000, appels: 5, sansTarif: 0, personnes: 1, sansPersonne: 4 });
  });

  it("des milliers de petits coûts s'additionnent sans dérive (micro-dollars entiers)", () => {
    const beaucoup = Array.from({ length: 10_000 }, () => ({ userId: "a", feature: "x", coutUsd: "0.000123", appels: 1, sansTarif: 0 }));
    expect(repartirParSociete(beaucoup, personnes).parSociete[0].microUsd).toBe(1_230_000);
    expect(versMicroUsd("abc")).toBe(0);
  });

  it("le taux n'est jamais deviné ; le montant tombe au centime", () => {
    expect(lireTaux("135,5")).toBe(135.5);
    for (const v of ["", "0", "-3", "abc", null, 1e9]) expect(lireTaux(v)).toBeNull();
    expect(montantDzd(1_350_000, 135.5)).toBe(182.93);
    expect(montantDzd(0, 135)).toBe(0);
  });

  it("le détail se stocke et se relit sans lever", () => {
    const r = repartirParSociete(appels, personnes);
    const d = detailAStocker(r.parSociete[1]);
    expect(lireDetail(JSON.parse(JSON.stringify(d)))).toEqual(d);
    expect(lireDetail(null)).toEqual({ parFonction: [], parDepartement: [] });
    expect(lireDetail({ parFonction: [null, 3, { cle: "x" }] }).parFonction).toEqual([{ cle: "x", libelle: "", coutUsd: 0, appels: 0 }]);
  });
});

describe("l'imputation est idempotente par (société, mois)", () => {
  const calcul = { microUsd: 1_000_000, taux: 135, montantDzd: 135, appels: 3 };
  it("rien imputé : créer — sauf un mois vide, qui n'encombre pas le budget", () => {
    expect(gesteImputation(null, calcul)).toBe("CREER");
    expect(gesteImputation(null, { microUsd: 0, taux: 135, montantDzd: 0, appels: 0 })).toBe("RIEN");
  });
  it("rejouée à l'identique : rien ne change ; un coût, un taux ou une ligne retirée : la même ligne est mise à jour", () => {
    const deja = { microUsd: 1_000_000, taux: 135, montantDzd: 135, ligneExiste: true };
    expect(gesteImputation(deja, calcul)).toBe("INCHANGEE");
    expect(gesteImputation({ ...deja, ligneExiste: false }, calcul)).toBe("METTRE_A_JOUR");
    expect(gesteImputation(deja, { ...calcul, microUsd: 2_000_000, montantDzd: 270 })).toBe("METTRE_A_JOUR");
    expect(gesteImputation(deja, { ...calcul, taux: 140, montantDzd: 140 })).toBe("METTRE_A_JOUR");
    expect(gesteImputation(deja, { microUsd: 0, taux: 135, montantDzd: 0, appels: 0 })).toBe("METTRE_A_JOUR");
  });
});

describe("le budget Informatique", () => {
  it("trois lignes de départ, reconnues par clé ; une ligne du même nom créée à la main est adoptée", () => {
    expect(lignesManquantes([]).map((l) => l.cle)).toEqual([CLE_LIGNE_IA, CLE_LIGNE_ABONNEMENTS, CLE_LIGNE_MATERIEL]);
    const r = lignesManquantes([
      { name: "IA", cle: CLE_LIGNE_IA, parentId: null },
      { name: "matériel", cle: null, parentId: null },
      { name: "Abonnements & licences", cle: null, parentId: "x" },
    ]);
    expect(r).toEqual([{ cle: CLE_LIGNE_ABONNEMENTS, nom: "Abonnements & licences" }, { cle: CLE_LIGNE_MATERIEL, nom: "Matériel", adopter: "matériel" }]);
  });
  it("l'enveloppe choisie : l'active, puis la plus récente", () => {
    const e = (id: string, isActive: boolean, d: string) => ({ id, isActive, periodStart: new Date(d) });
    expect(choisirEnveloppe([])).toBeNull();
    expect(choisirEnveloppe([e("a", false, "2026-01-01"), e("b", true, "2025-01-01"), e("c", true, "2026-01-01")])!.id).toBe("c");
  });
  it("rapprochement : consommé, cumul, reste — jamais un budget réparti en douzièmes", () => {
    const r = rapprocher(["2026-01", "2026-02", "2026-03"], new Map([["2026-01", 100.1], ["2026-03", 50]]), 120);
    expect(r).toEqual([
      { mois: "2026-01", consomme: 100.1, cumul: 100.1, reste: 19.9, depassement: false },
      { mois: "2026-02", consomme: 0, cumul: 100.1, reste: 19.9, depassement: false },
      { mois: "2026-03", consomme: 50, cumul: 150.1, reste: -30.1, depassement: true },
    ]);
    expect(rapprocher(["2026-01"], new Map([["2026-01", 10]]), 0)[0].reste).toBeNull();
  });
});

describe("les registres", () => {
  const maintenant = new Date("2026-11-24T10:00:00Z");
  it("dates et montants de formulaire : jamais devinés", () => {
    expect(lireDate("2026-02-30")).toBe("illisible");
    expect(lireDate("")).toBeNull();
    expect((lireDate("2026-02-28") as Date).toISOString()).toBe("2026-02-28T00:00:00.000Z");
    expect(lireMontant("4 500,50")).toBe(4500.5);
    expect(lireMontant("-1")).toBe("illisible");
    expect(lireMontant(null)).toBeNull();
  });
  it("le coût annuel d'un mensuel", () => {
    expect(coutAnnuel({ periodicite: "MENSUEL", montant: 20 })).toBe(240);
    expect(coutAnnuel({ periodicite: "ANNUEL", montant: 300 })).toBe(300);
  });
  it("le rappel sonne une fois par échéance, dans sa fenêtre", () => {
    const a = { statut: "ACTIF", echeance: new Date("2026-12-10T00:00:00Z"), rappelJours: 30, rappelEnvoyePour: null };
    expect(rappelDu(a, maintenant)).toBe(true);
    expect(rappelDu({ ...a, rappelEnvoyePour: a.echeance }, maintenant)).toBe(false);
    expect(rappelDu({ ...a, rappelEnvoyePour: new Date("2025-12-10T00:00:00Z") }, maintenant)).toBe(true);
    expect(rappelDu({ ...a, rappelJours: 7 }, maintenant)).toBe(false);
    expect(rappelDu({ ...a, statut: "RESILIE" }, maintenant)).toBe(false);
    expect(rappelDu({ ...a, echeance: null }, maintenant)).toBe(false);
    expect(rappelDu({ ...a, echeance: new Date("2026-09-01T00:00:00Z") }, maintenant)).toBe(false);
  });
  it("la garantie", () => {
    expect(etatGarantie(null, maintenant)).toBeNull();
    expect(etatGarantie(new Date("2026-11-01"), maintenant)).toBe("EXPIREE");
    expect(etatGarantie(new Date("2026-12-20"), maintenant)).toBe("BIENTOT");
    expect(etatGarantie(new Date("2028-01-01"), maintenant)).toBe("SOUS_GARANTIE");
  });
});
