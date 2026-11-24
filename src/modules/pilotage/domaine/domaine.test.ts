import { describe, expect, it } from "vitest";
import {
  buDuPerimetre, cleDeCible, identiteSignal, jourAlger, ligneDeSignalFinance, ligneSanteBudget, lotDeSignaux, resumeFinances,
  signalDeLEssentiel, signauxDeLaVoix, type LigneSignal,
} from "./signaux";
import { cleProposition, empreinteProposition, reprise, tauxAcceptation, verdictProposition } from "./propositions";
import { dimensionsDeVentePch, dimensionsDeVisite } from "./dimensions";
import { ficheFinale, planRepointage } from "./repointage";

const JOUR = "2026-11-24";

describe("signaux datés — la clé et l'idempotence", () => {
  it("le jour est celui d'Alger (UTC+1), pas celui du serveur", () => {
    expect(jourAlger(new Date("2026-11-24T22:59:00Z"))).toBe("2026-11-24");
    expect(jourAlger(new Date("2026-11-24T23:30:00Z"))).toBe("2026-11-25");
  });

  it("la clé d'une cible : type:id|précision, « groupe » sans cible, bornée", () => {
    expect(cleDeCible("produit", "p1", "abc")).toBe("produit:p1|abc");
    expect(cleDeCible(null)).toBe("groupe");
    expect(cleDeCible("x", "y".repeat(500)).length).toBe(300);
  });

  it("un lot rejoué : même identité = une seule ligne (la dernière gagne) ; lignes incomplètes et valeurs non finies écartées", () => {
    const l: LigneSignal = { jour: JOUR, source: "finances", nature: "disponible", cle: "Company:a", valeur: 1 };
    const lot = lotDeSignaux([l, { ...l, valeur: 2 }, { ...l, jour: "2026-11-25", valeur: Number.NaN }, { ...l, nature: "" }, { ...l, source: "inconnue" as never }]);
    expect(lot).toHaveLength(2);
    expect(lot.find((x) => x.jour === JOUR)?.valeur).toBe(2);
    expect(lot.find((x) => x.jour === "2026-11-25")?.valeur).toBeNull();
    expect(identiteSignal(l)).toBe(`finances|disponible|Company:a|${JOUR}`);
  });
});

describe("signaux datés — dérivations des calculs existants", () => {
  const voix = {
    jours: 30, rapports: 10, objectionsPrixAo: 2, parLuna: false,
    groupes: [{ categorie: "OBJECTION", rapports: 4, delegues: 2, citation: { texte: "trop cher", rapportId: "r1", coupe: false } }],
  };

  it("la Voix du terrain : une ligne par famille + le total, sur la BU du périmètre, repli dit", () => {
    const l = signauxDeLaVoix(voix, { perimetre: "mkt:bu:BU1", jour: JOUR, companyId: "C1" });
    expect(l.map((x) => x.nature)).toEqual(["RAPPORTS", "OBJECTION"]);
    expect(l.every((x) => x.buId === "BU1" && x.companyId === "C1" && x.producteur === "repli" && x.cle === "perimetre:mkt:bu:BU1|30j")).toBe(true);
    expect(l[1]!.valeur).toBe(4);
    expect(l[1]!.charge).toMatchObject({ part: 0.4, delegues: 2 });
    expect(buDuPerimetre("ops:all")).toBeNull();
    expect(buDuPerimetre("ops:BU2")).toBe("BU2");
  });

  it("l'essentiel Produits 360 : une ligne par produit et empreinte ; aucun point, aucune ligne", () => {
    expect(signalDeLEssentiel({ points: [], parLuna: true }, { productId: "p", empreinte: "e", jour: JOUR })).toBeNull();
    const s = signalDeLEssentiel({ points: [{ texte: "a" }], parLuna: true }, { productId: "p", empreinte: "e", jour: JOUR, companyId: "C" });
    expect(s).toMatchObject({ source: "produit_360", productId: "p", cle: "produit:p|e", producteur: "ia", valeur: 1, companyId: "C" });
  });

  it("les finances : un signal rattaché à sa société et à son entité ; la santé de l'enveloppe ; le résumé par société", () => {
    const a = ligneDeSignalFinance({ code: "justificatif_manquant", gravite: "HAUTE", titre: "t", montant: 500, entite: { type: "ExpenseOrder", id: "o1", ref: "OD-1" } }, { jour: JOUR, companyId: "C1" });
    expect(a).toMatchObject({ nature: "justificatif_manquant", cle: "ExpenseOrder:o1", companyId: "C1", valeur: 500, entiteType: "ExpenseOrder" });
    const b = ligneDeSignalFinance({ code: "budget_depasse", gravite: "CRITIQUE", titre: "t", entite: { type: "BudgetEnvelope", id: "e1" } }, { jour: JOUR, companyId: "C2" });
    expect(b.budgetEnvelopeId).toBe("e1");
    const sante = ligneSanteBudget({ id: "e1", nom: "Ops", alloue: 100, consomme: 50 }, { sante: "SAIN", tauxTemps: 0.5, tauxConsomme: 0.5, tauxEngage: 0, projectionFin: 100, ecartProjete: 0, calcul: "c" }, { jour: JOUR, companyId: "C2" });
    expect(sante).toMatchObject({ nature: "sante_budget", valeur: 100, gravite: "SAIN", companyId: "C2" });
    const r = resumeFinances([a, b, sante, { ...a, cle: "ExpenseOrder:o2" }], { jour: JOUR, companyId: "C1" });
    expect(r).toMatchObject({ nature: "resume", valeur: 2, charge: { parCode: { justificatif_manquant: 2 }, parGravite: { HAUTE: 2 } } });
  });
});

describe("propositions d'IA — le verdict et le taux", () => {
  it("un texte : identique → ACCEPTE, repris en partie → MODIFIE, réécrit → REJETE, vide → REJETE", () => {
    const p = "Hausse liée à l'ouverture de deux nouveaux secteurs commerciaux à l'Ouest.";
    expect(verdictProposition(p, `  ${p.toUpperCase()} `).verdict).toBe("ACCEPTE");
    expect(verdictProposition(p, "Hausse liée à l'ouverture de deux nouveaux secteurs (Oran, Tlemcen).").verdict).toBe("MODIFIE");
    expect(verdictProposition(p, "Report du budget non consommé de l'an passé.").verdict).toBe("REJETE");
    expect(verdictProposition(p, "").verdict).toBe("REJETE");
    expect(reprise("a b", "")).toBe(0);
  });

  it("une liste : tout retenu → ACCEPTE, une partie ou un ajout → MODIFIE, rien → REJETE", () => {
    const p = [{ nature: "VENUE", libelle: "Salle" }, { nature: "DINNER", libelle: "Dîner" }];
    expect(verdictProposition(p, [{ libelle: "salle", nature: "VENUE" }, { nature: "DINNER", libelle: "Dîner" }]).verdict).toBe("ACCEPTE");
    expect(verdictProposition(p, [p[0]]).verdict).toBe("MODIFIE");
    expect(verdictProposition(p, [...p, { nature: "OTHER", libelle: "Badges" }])).toMatchObject({ verdict: "MODIFIE", retenus: 2, ajoutes: 1 });
    expect(verdictProposition(p, [{ nature: "OTHER", libelle: "Badges" }]).verdict).toBe("REJETE");
  });

  it("un objet : champ par champ sur les champs PROPOSÉS — tous gardés, une partie, aucun", () => {
    const p = { poste: "Délégué", dateEmbauche: "2025-07-01" };
    expect(verdictProposition(p, { ...p, salarie: "X" }).verdict).toBe("ACCEPTE");
    expect(verdictProposition(p, { poste: "Délégué", dateEmbauche: "2025-08-01" })).toMatchObject({ verdict: "MODIFIE", retenus: 1, modifies: 1 });
    expect(verdictProposition({ Taxi: "c1" }, { Taxi: "c2" }).verdict).toBe("REJETE");
    expect(verdictProposition({ Taxi: "c1" }, { Taxi: null }).verdict).toBe("REJETE");
  });

  it("l'empreinte ne dépend ni de l'ordre des clés ni de la casse ; la clé porte l'auteur et la cible", () => {
    expect(empreinteProposition({ a: 1, b: "X" })).toBe(empreinteProposition({ b: "x", a: 1 }));
    expect(empreinteProposition({ a: 1 })).not.toBe(empreinteProposition({ a: 2 }));
    expect(cleProposition("u1", { type: "HrRequest", id: "r1" }, "t")).toMatch(/^HrRequest:r1:u1\|[0-9a-f]{16}$/);
    expect(cleProposition("u1", null, "t")).toMatch(/^sans-cible:u1\|/);
  });

  it("le taux : acceptées / closes ; une proposition trop vieille sans geste compte sans suite", () => {
    const m = new Date("2026-11-24T10:00:00Z");
    const vieux = new Date("2026-11-01T10:00:00Z");
    const t = tauxAcceptation([
      { source: "kpi", nature: "cibles", statut: "ACCEPTE", producteur: "ia", creeLe: m },
      { source: "kpi", nature: "cibles", statut: "MODIFIE", producteur: "ia", creeLe: m },
      { source: "kpi", nature: "cibles", statut: "REJETE", producteur: "ia", creeLe: m },
      { source: "kpi", nature: "cibles", statut: "PROPOSE", producteur: "ia", creeLe: vieux },
      { source: "kpi", nature: "cibles", statut: "PROPOSE", producteur: "ia", creeLe: m },
    ], m);
    expect(t).toEqual([expect.objectContaining({ proposees: 5, acceptees: 1, modifiees: 1, rejetees: 1, sansSuite: 1, enAttente: 1, taux: 0.25, tauxUtile: 0.5 })]);
  });
});

describe("dimensions dérivées (L3, L9)", () => {
  it("une visite : wilaya du médecin, BU du délégué, société de la BU d'abord", () => {
    expect(dimensionsDeVisite({ doctor: { wilayaCode: "31", companyId: "CM" }, buDuDelegue: { id: "B", companyId: "CB" } }))
      .toEqual({ wilayaCode: "31", buId: "B", companyId: "CB", origineSociete: "bu" });
    expect(dimensionsDeVisite({ doctor: { wilayaCode: null, companyId: "CM" }, buDuDelegue: null }))
      .toEqual({ wilayaCode: null, buId: null, companyId: "CM", origineSociete: "medecin" });
  });

  it("une vente PCH : l'établissement d'abord ; une DR à une wilaya la donne ; à plusieurs, la liste sans trancher", () => {
    const dr = new Map([["DRO", ["31", "13", "31"]], ["DRA", ["16"]]]);
    expect(dimensionsDeVentePch({ dr: "DRO", wilayaEtablissement: "46" }, dr)).toMatchObject({ wilayaCode: "46", origine: "etablissement" });
    expect(dimensionsDeVentePch({ dr: "dra ", wilayaEtablissement: null }, dr)).toMatchObject({ wilayaCode: "16", origine: "dr" });
    expect(dimensionsDeVentePch({ dr: "DRO", wilayaEtablissement: null }, dr)).toEqual({ wilayaCode: null, wilayasPossibles: ["13", "31"], origine: "dr" });
    expect(dimensionsDeVentePch({ dr: "XX", wilayaEtablissement: null }, dr).origine).toBeNull();
  });
});

describe("le graphe d'influence à la fusion (L4)", () => {
  const L = (id: string, from: string, to: string, statut = "PROPOSEE", type = "SUIT_AVIS") => ({ id, fromDoctorId: from, toDoctorId: to, type, statut });

  it("déplace, repère le doublon (en reprenant la décision humaine) et la boucle", () => {
    const plan = planRepointage([
      L("1", "A", "X", "CONFIRMEE"), // doublon de 4, décidé
      L("2", "Y", "A"), // déplacé
      L("3", "A", "G"), // boucle
      L("4", "G", "X", "PROPOSEE"),
      L("5", "A", "X", "PROPOSEE", "COMITE"), // autre type : déplacé
    ], "A", "G");
    expect(plan.deplacer).toEqual([{ id: "2", fromDoctorId: "Y", toDoctorId: "G" }, { id: "5", fromDoctorId: "G", toDoctorId: "X" }]);
    expect(plan.doublons).toEqual([{ retirerId: "1", garderId: "4", reprendreDecision: true }]);
    expect(plan.boucles).toEqual(["3"]);
    expect(planRepointage([L("1", "A", "X")], "A", "A")).toEqual({ deplacer: [], doublons: [], boucles: [] });
  });

  it("la fiche finale suit une chaîne de fusions, et refuse une boucle", () => {
    expect(ficheFinale("A", new Map([["A", "B"], ["B", "C"]]))).toBe("C");
    expect(ficheFinale("Z", new Map([["A", "B"]]))).toBeNull();
    expect(ficheFinale("A", new Map([["A", "B"], ["B", "A"]]))).toBeNull();
  });
});
