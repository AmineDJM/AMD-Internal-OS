import { describe, it, expect } from "vitest";
import {
  CLE_SANS, alertesBudget, disponible, filtresDepuis, libellePeriode, lignesParCategorie, moisEntre, pctPeriodeEcoulee,
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
