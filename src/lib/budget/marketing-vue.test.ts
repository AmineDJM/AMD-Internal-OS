import { describe, it, expect } from "vitest";
import {
  CLE_SANS, alertesBudget, arbreCategories, cessible, disponible, effetAllocation, filtresDepuis, formuleCumul, idsDeLaCategorie,
  libellePeriode, lignesParCategorie, moisEntre, partRepartie, pctPeriodeEcoulee, propositionReallocation, resteIntegration, santeCategorie,
  periodesProposees, refusReallocation, roulerCategories, rythme, serieMensuelle, topDemandes, vueFiltree,
  type DonneesMarketing, type Fait,
} from "./marketing-vue";

const MOIS = moisEntre("2026-01", "2026-12");

const donnees = (over: Partial<DonneesMarketing> = {}): DonneesMarketing => ({
  enveloppe: { id: "e", nom: "Budget Marketing 2026", total: 1200, debut: "2026-01-01T00:00:00.000Z", fin: "2026-12-31T00:00:00.000Z" },
  categories: [{ id: "a", nom: "Prise en charge", alloue: 600, paye: 0, engage: 0 }, { id: "b", nom: "Sponsoring", alloue: 500, paye: 0, engage: 0 }],
  sansCategorie: { total: 0, count: 0 },
  faits: [
    { cat: "a", mois: "2026-03", nature: "Billetterie", demande: "SPONSORING:1", montant: 300 },
    { cat: "a", mois: "2026-07", nature: "Hôtellerie", demande: "SPONSORING:1", montant: 200 },
    { cat: "b", mois: "2026-07", nature: "Sponsoring d'associations", demande: "SPONSORING:2", montant: 100 },
    { cat: null, mois: "2026-08", nature: "Non renseignée", demande: null, montant: 50 },
  ],
  engagements: [{ cat: "a", demande: "SPONSORING:1", montant: 150 }, { cat: "b", demande: null, montant: 20 }],
  demandes: {
    "SPONSORING:1": { cle: "SPONSORING:1", libelle: "Congrès A", href: "/sponsoring/1", type: "Sponsoring" },
    "SPONSORING:2": { cle: "SPONSORING:2", libelle: "Association B", href: "/sponsoring/2", type: "Sponsoring" },
  },
  moisEnveloppe: MOIS,
  n1: null,
  ...over,
});

describe("les catégories, sous-catégories repliées", () => {
  it("une sous-catégorie consomme sa catégorie de tête ; l'alloué reste celui de la tête", () => {
    const { tetes, versTete } = roulerCategories([
      { id: "t", name: "Événements", parentId: null, allocated: 1000, consumed: 100, committed: 10 },
      { id: "s", name: "Table ronde", parentId: "t", allocated: 400, consumed: 300, committed: 5 },
    ]);
    expect(versTete.s).toBe("t");
    expect(tetes).toEqual([{ id: "t", nom: "Événements", alloue: 1000, paye: 400, engage: 15 }]);
  });
});

describe("le disponible et le rythme", () => {
  it("disponible = enveloppe − payé − engagé", () => {
    expect(disponible(38_656_000, 29_794_438, 1_674_925)).toBe(7_186_637);
  });
  it("le rythme compare l'utilisé à l'année écoulée, avec une marge de 5 points", () => {
    expect(rythme(81, 78).cle).toBe("AU_RYTHME");
    expect(rythme(90, 78).cle).toBe("EN_AVANCE");
    expect(rythme(40, 78).cle).toBe("EN_RETARD");
  });
  it("la part de l'année écoulée est bornée à [0, 100]", () => {
    const d = new Date("2026-01-01T00:00:00Z"), f = new Date("2026-12-31T00:00:00Z");
    expect(pctPeriodeEcoulee(d, f, new Date("2025-06-01T00:00:00Z"))).toBe(0);
    expect(pctPeriodeEcoulee(d, f, new Date("2027-06-01T00:00:00Z"))).toBe(100);
    expect(Math.round(pctPeriodeEcoulee(d, f, new Date("2026-07-02T00:00:00Z")))).toBe(50);
  });
});

describe("À traiter", () => {
  it("dépassement → Réallouer, sans catégorie → Les imputer, répartition au-delà de l'enveloppe → Ajuster", () => {
    const a = alertesBudget({
      categories: [{ id: "a", nom: "PEC internationale", alloue: 100, paye: 120, engage: 22 }, { id: "b", nom: "Sponsoring", alloue: 1000, paye: 10, engage: 0 }],
      sansCategorie: { total: 3_326_237, count: 12 },
      total: 1099,
    });
    expect(a.map((x) => x.geste)).toEqual(["REALLOUER", "IMPUTER", "AJUSTER"]);
    expect(a[0]).toMatchObject({ categorieId: "a", niveau: "danger", titre: "PEC internationale : 142 % de son allocation" });
    expect(a[1].detail).toBe("12 dépenses à imputer");
  });
  it("rien à dire, rien d'affiché", () => {
    expect(alertesBudget({ categories: [{ id: "a", nom: "A", alloue: 100, paye: 50, engage: 10 }], sansCategorie: { total: 0, count: 0 }, total: 100 })).toEqual([]);
  });
});

describe("réallouer — l'enveloppe ne bouge pas, le motif est obligatoire", () => {
  const ok = { sourceId: "a", cibleId: "b", montant: 100, motif: "Congrès décalé", source: { envelopeId: "e", parentId: null, alloue: 500 }, cible: { envelopeId: "e", parentId: null } };
  it("accepte un déplacement valide", () => { expect(refusReallocation(ok)).toBeNull(); });
  it("refuse sans motif, au-delà de l'alloué, entre enveloppes, vers soi-même, un montant nul", () => {
    expect(refusReallocation({ ...ok, motif: " " })).toMatch(/motif/);
    expect(refusReallocation({ ...ok, montant: 600 })).toMatch(/n'a que/);
    expect(refusReallocation({ ...ok, cible: { envelopeId: "x", parentId: null } })).toMatch(/même enveloppe/);
    expect(refusReallocation({ ...ok, cibleId: "a" })).toMatch(/différentes/);
    expect(refusReallocation({ ...ok, montant: 0 })).toMatch(/positif/);
    expect(refusReallocation({ ...ok, source: { envelopeId: "e", parentId: "t", alloue: 500 } })).toMatch(/tête/);
  });
});

describe("les filtres s'appliquent à toutes les lectures", () => {
  it("la période filtre le payé ; la catégorie aussi ; l'engagé reste à date", () => {
    const v = vueFiltree(donnees(), { debut: "2026-07", fin: "2026-09", cat: null }, false);
    expect(v.totaux.paye).toBe(350);
    expect(v.totaux.engage).toBe(170);
    expect(v.payeParCat.map((p) => p.id)).toEqual(["a", "b", CLE_SANS]);
    const va = vueFiltree(donnees(), { debut: "2026-01", fin: "2026-12", cat: "a" }, false);
    expect(va.totaux.paye).toBe(500);
    expect(va.natures.map((n) => n.nature)).toEqual(["Billetterie", "Hôtellerie"]);
    expect(va.barres.map((b) => b.id)).toEqual(["a"]);
  });
  it("le cumul part de l'ouverture et se compare au rythme régulier, même filtré sur un trimestre", () => {
    const s = serieMensuelle({ faits: donnees().faits, filtres: { debut: "2026-07", fin: "2026-09", cat: null }, moisEnveloppe: MOIS, base: 1200 });
    expect(s.map((p) => p.mois)).toEqual(["2026-07", "2026-08", "2026-09"]);
    expect(s[0]).toMatchObject({ total: 300, cumul: 600, rythme: 700 });
    expect(s[0].parCat).toEqual({ a: 200, b: 100 });
    expect(s[1].parCat).toEqual({ [CLE_SANS]: 50 });
  });
  it("les demandes qui pèsent le plus additionnent le payé de la période et l'engagé", () => {
    const top = topDemandes({ faits: donnees().faits, engagements: donnees().engagements, demandes: donnees().demandes, filtres: { debut: "2026-01", fin: "2026-12", cat: null } });
    expect(top.map((d) => [d.libelle, d.paye, d.engage])).toEqual([["Congrès A", 500, 150], ["Association B", 100, 0]]);
  });
  it("N-1 : les faits de l'an dernier, ramenés sur l'année, se filtrent pareil", () => {
    const n1Faits: Fait[] = [{ cat: "a", mois: "2026-03", nature: "x", demande: null, montant: 40 }, { cat: "b", mois: "2026-08", nature: "x", demande: null, montant: 60 }];
    const d = donnees({ n1: { annee: 2025, enveloppe: "BM 2025", total: 1000, alloueParCat: { a: 500 }, faits: n1Faits } });
    const v = vueFiltree(d, { debut: "2026-07", fin: "2026-12", cat: null }, true);
    expect(v.totaux.payeN1).toBe(60);
    expect(v.barres.find((b) => b.id === "b")?.payeN1).toBe(60);
    expect(v.mois[0].cumulN1).toBe(40);
    expect(vueFiltree(d, { debut: "2026-07", fin: "2026-12", cat: null }, false).totaux.payeN1).toBeNull();
  });
});

describe("le tableau par catégorie, les périodes et l'adresse", () => {
  it("le tableau lit toute l'enveloppe : reste = alloué − payé − engagé", () => {
    const l = lignesParCategorie(donnees());
    expect(l[0]).toMatchObject({ id: "a", alloue: 600, paye: 500, engage: 150, reste: -50 });
    expect(Math.round(l[0].pct)).toBe(108);
  });
  it("propose l'année, les trimestres, puis les mois", () => {
    const p = periodesProposees(MOIS);
    expect(p[0]).toMatchObject({ cle: "annee", libelle: "Année", debut: "2026-01", fin: "2026-12" });
    expect(p[3]).toMatchObject({ libelle: "3e trimestre", debut: "2026-07", fin: "2026-09" });
    expect(p).toHaveLength(1 + 4 + 12);
    expect(libellePeriode({ debut: "2026-07", fin: "2026-09", cat: null }, MOIS)).toBe("3e trimestre 2026");
    expect(libellePeriode({ debut: "2026-01", fin: "2026-12", cat: null }, MOIS)).toBe("Année 2026");
  });
  it("les filtres d'une adresse sont bornés à l'enveloppe ; une catégorie inconnue est ignorée", () => {
    expect(filtresDepuis(MOIS, { debut: "2025-01", fin: "2027-01", cat: "zz" }, [{ id: "a" }])).toEqual({ debut: "2026-01", fin: "2026-12", cat: null });
    expect(filtresDepuis(MOIS, { debut: "2026-04", fin: "2026-06", cat: "a" }, [{ id: "a" }])).toEqual({ debut: "2026-04", fin: "2026-06", cat: "a" });
  });
});

// ───────────────────────────── Maquette « onglets » (10/2026) ─────────────────────────────

const CATS = [
  { id: "evt", name: "Événements", parentId: null, allocated: 6_422_485, consumed: 100_000, committed: 0 },
  { id: "sym", name: "Symposium", parentId: "evt", allocated: 2_433_267, consumed: 410_950, committed: 0 },
  { id: "staff", name: "Staff post-event", parentId: "evt", allocated: 1_550_251, consumed: 975_133.48, committed: 20_000 },
  { id: "spons", name: "Sponsoring", parentId: null, allocated: 8_100_000, consumed: 7_993_208.5, committed: 50_000 },
  { id: "form", name: "Formation", parentId: null, allocated: 0, consumed: 350_000, committed: 0 },
  { id: "vide", name: "Consulting", parentId: null, allocated: 1_800_000, consumed: 0, committed: 0 },
];

describe("l'arbre des catégories — une catégorie comprend ses sous-catégories", () => {
  const arbre = arbreCategories(CATS);
  const evt = arbre.find((n) => n.id === "evt")!;
  it("cumule payé et engagé des sous-catégories ; l'alloué reste celui de la catégorie", () => {
    expect(evt.paye).toBeCloseTo(100_000 + 410_950 + 975_133.48, 2);
    expect(evt.engage).toBe(20_000);
    expect(evt.alloue).toBe(6_422_485);
    expect(evt.payePropre).toBe(100_000);
    expect(evt.sous.map((s) => s.id)).toEqual(["sym", "staff"]);
    expect(evt.sousAlloue).toBe(2_433_267 + 1_550_251);
    expect(evt.surRepartie).toBe(false);
  });
  it("le total de l'enveloppe est la somme des têtes — jamais compté deux fois", () => {
    const total = arbre.reduce((a, n) => a + n.paye, 0);
    expect(total).toBeCloseTo(CATS.reduce((a, c) => a + c.consumed, 0), 2);
  });
  it("tri par alloué décroissant, les sous-catégories sous leur catégorie", () => {
    expect(arbre.map((n) => n.id)).toEqual(["spons", "evt", "vide", "form"]);
  });
  it("la santé : « Sans allocation » quand de l'argent est payé sur une allocation à 0", () => {
    expect(arbre.find((n) => n.id === "form")!.sante).toBe("SANS_ALLOCATION");
    expect(arbre.find((n) => n.id === "vide")!.sante).toBe("MAITRISE");
    expect(santeCategorie(0, 0)).toBe("AUCUNE");
    expect(santeCategorie(100, 85)).toBe("A_SURVEILLER");
    expect(santeCategorie(100, 100)).toBe("DEPASSE");
  });
  it("la formule du cumul : en propre + chaque sous-catégorie = total", () => {
    const f = formuleCumul(evt);
    expect(f.propre).toBe(100_000);
    expect(f.termes.map((t) => t.nom)).toEqual(["Symposium", "Staff post-event"]);
    expect(f.propre + f.termes.reduce((a, t) => a + t.montant, 0)).toBeCloseTo(f.total, 2);
  });
  it("signale des sous-catégories qui répartissent plus que leur catégorie", () => {
    const a = arbreCategories([
      { id: "t", name: "T", parentId: null, allocated: 1000, consumed: 0, committed: 0 },
      { id: "s1", name: "S1", parentId: "t", allocated: 700, consumed: 0, committed: 0 },
      { id: "s2", name: "S2", parentId: "t", allocated: 400, consumed: 0, committed: 0 },
    ]);
    expect(a[0].surRepartie).toBe(true);
    expect(a[0].cessible).toBe(0);
  });
  it("une catégorie et ses descendantes (filtre « catégorie »)", () => {
    expect([...idsDeLaCategorie("evt", CATS.map((c) => ({ id: c.id, parentId: c.parentId })))].sort()).toEqual(["evt", "staff", "sym"]);
    expect([...idsDeLaCategorie("sym", CATS.map((c) => ({ id: c.id, parentId: c.parentId })))]).toEqual(["sym"]);
  });
});

describe("réallouer — borné à ce qu'une catégorie peut céder", () => {
  it("cessible = alloué − max(payé + engagé, réparti dans les sous-catégories), jamais négatif", () => {
    expect(cessible({ alloue: 1000, payeEngage: 300, sousAlloue: 0 })).toBe(700);
    expect(cessible({ alloue: 1000, payeEngage: 300, sousAlloue: 800 })).toBe(200);
    expect(cessible({ alloue: 1000, payeEngage: 1200, sousAlloue: 0 })).toBe(0);
  });
  it("l'arbre porte la part cessible de chaque catégorie", () => {
    const a = arbreCategories(CATS);
    expect(a.find((n) => n.id === "evt")!.cessible).toBeCloseTo(6_422_485 - (2_433_267 + 1_550_251), 2);
    expect(a.find((n) => n.id === "spons")!.cessible).toBeCloseTo(8_100_000 - 8_043_208.5, 2);
    expect(a.find((n) => n.id === "form")!.cessible).toBe(0);
  });
  it("refuse au-delà du cessible, en nommant la catégorie", () => {
    const base = { sourceId: "a", cibleId: "b", motif: "Formation ARV non prévue", cible: { envelopeId: "e", parentId: null } };
    const source = { envelopeId: "e", parentId: null, alloue: 1000, cessible: 200, nom: "Consulting" };
    expect(refusReallocation({ ...base, montant: 200, source })).toBeNull();
    expect(refusReallocation({ ...base, montant: 201, source })).toMatch(/« Consulting » ne peut céder que 200 DZD/);
  });
  it("propose la source qui peut céder le plus et le montant qui couvre le dépassement", () => {
    const a = arbreCategories(CATS);
    const p = propositionReallocation("form", a);
    expect(p.besoin).toBe(350_000);
    expect(p.sourceId).toBe("evt");
    expect(p.montant).toBe(350_000);
    const petit = propositionReallocation("form", [
      { id: "form", alloue: 0, paye: 350_000, engage: 0, cessible: 0 },
      { id: "x", alloue: 100_000, paye: 0, engage: 0, cessible: 100_000 },
    ]);
    expect(petit).toEqual({ sourceId: "x", montant: 100_000, besoin: 350_000 });
    expect(propositionReallocation("form", [{ id: "form", alloue: 0, paye: 1, engage: 0, cessible: 0 }])).toEqual({ besoin: 1 });
  });
});

describe("À traiter — enrichi (maquette « onglets »)", () => {
  const sans = { total: 0, count: 0 };
  it("une catégorie payée sans allocation se dit, et se réalloue", () => {
    const a = alertesBudget({ categories: [{ id: "form", nom: "Formation", alloue: 0, paye: 350_000, engage: 0 }], sansCategorie: sans, total: 1_000_000 });
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ geste: "REALLOUER", categorieId: "form", titre: "Formation : payée sans allocation" });
  });
  it("les pièces manquantes et les absentes à décider de l'intégration remontent, après les dépassements", () => {
    const reste = resteIntegration({
      demandes: [{ attendues: 4, manquantes: 4 }, { attendues: 2, manquantes: 0 }, { attendues: 3, manquantes: 1 }],
      absentes: [{ decision: null }, { decision: "GARDER" }, { decision: null }],
    });
    expect(reste).toEqual({ piecesAttendues: 9, piecesManquantes: 5, demandesIncompletes: 2, aDecider: 2 });
    const a = alertesBudget({ categories: [{ id: "x", nom: "X", alloue: 10, paye: 20, engage: 0 }], sansCategorie: sans, total: 100, integration: reste });
    expect(a.map((x) => x.geste)).toEqual(["REALLOUER", "PIECES", "ABSENTES"]);
    expect(a[1]).toMatchObject({ integration: true, titre: "5 pièces manquantes sur les demandes intégrées" });
    expect(a[1].detail).toMatch(/^4 jointes sur 9 attendues \(2 demandes\)/);
    expect(a[2].titre).toBe("2 éléments « absents du fichier » à décider");
  });
  it("rien de l'intégration quand tout est joint et décidé", () => {
    expect(alertesBudget({ categories: [], sansCategorie: sans, total: 0, integration: { piecesAttendues: 3, piecesManquantes: 0, demandesIncompletes: 0, aDecider: 0 } })).toEqual([]);
  });
});

describe("Réglages — la part répartie et l'effet d'une allocation", () => {
  it("part répartie de l'enveloppe", () => {
    expect(partRepartie(1000, [{ alloue: 600 }, { alloue: 300 }])).toEqual({ reparti: 900, pct: 90, nonReparti: 100, depassement: 0 });
    expect(partRepartie(1000, [{ alloue: 1200 }]).depassement).toBe(200);
  });
  it("une sous-catégorie se mesure à sa catégorie, une tête à l'enveloppe", () => {
    const categories = [{ id: "t", parentId: null, alloue: 1000 }, { id: "s1", parentId: "t", alloue: 600 }, { id: "u", parentId: null, alloue: 500 }];
    expect(effetAllocation({ total: 2000, categories, parentId: "t", alloue: 500 })).toEqual({ dans: "CATEGORIE", reparti: 1100, plafond: 1000, depassement: 100 });
    expect(effetAllocation({ total: 2000, categories, id: "s1", parentId: "t", alloue: 900 })).toMatchObject({ reparti: 900, depassement: 0 });
    expect(effetAllocation({ total: 2000, categories, id: "u", parentId: null, alloue: 1200 })).toEqual({ dans: "ENVELOPPE", reparti: 2200, plafond: 2000, depassement: 200 });
  });
});
