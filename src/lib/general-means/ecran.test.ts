import { describe, expect, it } from "vitest";
import {
  AUCUN_FILTRE, SANS_NATURE, filtrerDepenses, filtreActif, grouperParMois, moisCle, moisPrecedent, natureDeLaDepense,
  partDepensee, repartitionParNature, titreMois, totauxDuMois, partsParNature, repartitionDuMois, moisSuivant, moisParDefaut,
} from "./ecran";

const dep = (date: string, amount: number, p: Record<string, unknown> = {}) => ({
  label: "Dépense", notes: null as string | null, nature: null as string | null, fromPettyCash: true, lines: [] as { label: string }[], date, amount, ...p,
});

describe("mois", () => {
  it("lit le mois en UTC, nomme le mois et recule d'un mois en gérant l'année", () => {
    expect(moisCle("2026-10-31T23:30:00.000Z")).toBe("2026-10");
    expect(moisCle("n'importe quoi")).toBe("0000-00");
    expect(titreMois("2026-10")).toBe("Octobre 2026");
    expect(titreMois("0000-00")).toBe("Date inconnue");
    expect(moisPrecedent("2026-10")).toBe("2026-09");
    expect(moisPrecedent("2026-01")).toBe("2025-12");
  });
});

describe("grouperParMois — seul le mois en cours est ouvert", () => {
  const rows = [
    dep("2026-09-12T10:00:00Z", 100), dep("2026-10-08T10:00:00Z", 90), dep("2026-10-01T10:00:00Z", 8000),
    dep("2026-08-30T10:00:00Z", 50), dep("2026-09-02T10:00:00Z", 200),
  ];

  it("range par mois récent d'abord, avec le nombre et le total, et ouvre le mois en cours seul", () => {
    const g = grouperParMois(rows, "2026-10-15T00:00:00Z");
    expect(g.map((x) => [x.mois, x.count, x.total, x.ouvert])).toEqual([
      ["2026-10", 2, 8090, true], ["2026-09", 2, 300, false], ["2026-08", 1, 50, false],
    ]);
    expect(g[0].lignes.map((l) => l.amount)).toEqual([90, 8000]);
  });

  it("sans dépense ce mois-ci, le mois le plus récent s'ouvre : jamais un tableau entièrement fermé", () => {
    const g = grouperParMois(rows, "2026-11-03T00:00:00Z");
    expect(g.map((x) => x.ouvert)).toEqual([true, false, false]);
    expect(g[0].mois).toBe("2026-10");
  });

  it("aucune dépense : aucun groupe", () => {
    expect(grouperParMois([], "2026-10-15T00:00:00Z")).toEqual([]);
  });
});

describe("totauxDuMois", () => {
  it("compare le mois en cours au précédent, à cheval sur deux années", () => {
    const rows = [dep("2026-01-05T00:00:00Z", 10), dep("2025-12-20T00:00:00Z", 40), dep("2025-12-02T00:00:00Z", 5), dep("2025-11-02T00:00:00Z", 999)];
    expect(totauxDuMois(rows, "2026-01-20T00:00:00Z")).toEqual({ mois: "2026-01", courant: 10, precedentMois: "2025-12", precedent: 45 });
  });
});

describe("natureDeLaDepense", () => {
  const nom = new Map([["c1", "Café et eau"], ["c2", "Entretien"]]);
  it("prend le classement du ticket, sinon l'article classé le plus cher, sinon rien", () => {
    expect(natureDeLaDepense({ budgetCategoryId: "c1", lines: [] }, nom)).toBe("Café et eau");
    expect(natureDeLaDepense({ budgetCategoryId: null, lines: [{ amount: 10, budgetCategoryId: "c1" }, { amount: 30, budgetCategoryId: "c2" }, { amount: 99, budgetCategoryId: null }] }, nom)).toBe("Entretien");
    expect(natureDeLaDepense({ budgetCategoryId: null, lines: [{ amount: 5, budgetCategoryId: null }] }, nom)).toBeNull();
    expect(natureDeLaDepense({ budgetCategoryId: "inconnue", lines: [] }, nom)).toBeNull();
  });
});

describe("repartitionParNature", () => {
  it("somme par nature, la plus lourde d'abord, « Non classé » pour le reste", () => {
    const r = repartitionParNature([
      { amount: 10, nature: "Café" }, { amount: 30, nature: "Entretien" }, { amount: 5, nature: null }, { amount: 15, nature: "Café" },
    ]);
    expect(r).toEqual([
      { label: "Entretien", total: 30, count: 1 }, { label: "Café", total: 25, count: 2 }, { label: SANS_NATURE, total: 5, count: 1 },
    ]);
  });
  it("replie la queue dans « Autres » au-delà du maximum, sans perdre un dinar", () => {
    const rows = ["A", "B", "C", "D", "E"].map((n, i) => ({ amount: 100 - i * 10, nature: n }));
    const r = repartitionParNature(rows, 3);
    expect(r.map((p) => p.label)).toEqual(["A", "B", "Autres (3)"]);
    expect(r.reduce((a, p) => a + p.total, 0)).toBe(100 + 90 + 80 + 70 + 60);
  });
});

describe("filtrerDepenses", () => {
  const rows = [
    dep("2026-10-01T00:00:00Z", 1, { label: "Café en capsules", nature: "Café et eau", fromPettyCash: true }),
    dep("2026-10-02T00:00:00Z", 2, { label: "Facture électricien", nature: "Entretien", fromPettyCash: false, notes: "Société Électro" }),
    dep("2026-10-03T00:00:00Z", 3, { label: "Courses", nature: null, fromPettyCash: true, lines: [{ label: "Éponges" }] }),
  ];
  it("filtre par paiement et par nature (y compris « Non classé »)", () => {
    expect(filtrerDepenses(rows, { ...AUCUN_FILTRE, paiement: "CAISSE" })).toHaveLength(2);
    expect(filtrerDepenses(rows, { ...AUCUN_FILTRE, paiement: "HORS" }).map((r) => r.amount)).toEqual([2]);
    expect(filtrerDepenses(rows, { ...AUCUN_FILTRE, nature: SANS_NATURE }).map((r) => r.amount)).toEqual([3]);
    expect(filtrerDepenses(rows, { ...AUCUN_FILTRE, nature: "Entretien" }).map((r) => r.amount)).toEqual([2]);
  });
  it("cherche sans tenir compte des accents ni de la casse, dans l'objet, les précisions et les articles", () => {
    expect(filtrerDepenses(rows, { ...AUCUN_FILTRE, recherche: "electro" }).map((r) => r.amount)).toEqual([2]);
    expect(filtrerDepenses(rows, { ...AUCUN_FILTRE, recherche: "EPONGE" }).map((r) => r.amount)).toEqual([3]);
    expect(filtrerDepenses(rows, { ...AUCUN_FILTRE, recherche: "café capsule" }).map((r) => r.amount)).toEqual([1]);
    expect(filtrerDepenses(rows, { ...AUCUN_FILTRE, recherche: "introuvable" })).toEqual([]);
  });
  it("dit si un filtre est posé", () => {
    expect(filtreActif(AUCUN_FILTRE)).toBe(false);
    expect(filtreActif({ ...AUCUN_FILTRE, recherche: "  " })).toBe(false);
    expect(filtreActif({ ...AUCUN_FILTRE, paiement: "HORS" })).toBe(true);
  });
});

describe("partDepensee", () => {
  it("borne la barre de la caisse entre 0 et 100", () => {
    expect(partDepensee(12_940, 24_000)).toBe(54);
    expect(partDepensee(30_000, 24_000)).toBe(100);
    expect(partDepensee(10, 0)).toBe(0);
    expect(partDepensee(-5, 100)).toBe(0);
  });
});

describe("par nature, article par article et par mois (Direction, 10/2026)", () => {
  const nom = new Map([["cafe", "Café"], ["pap", "Papeterie"], ["tel", "Télécom"]]);

  it("chaque article va à sa catégorie ; le reste du ticket à celle du ticket, sinon « Non classé »", () => {
    expect(partsParNature({ amount: 1500, budgetCategoryId: null, lines: [
      { amount: 1000, budgetCategoryId: "cafe" }, { amount: 300, budgetCategoryId: "pap" }, { amount: 200, budgetCategoryId: null },
    ] }, nom)).toEqual([{ nature: "Café", amount: 1000 }, { nature: "Papeterie", amount: 300 }, { nature: null, amount: 200 }]);
    expect(partsParNature({ amount: 500, budgetCategoryId: "tel", lines: [{ amount: 500, budgetCategoryId: null }] }, nom))
      .toEqual([{ nature: "Télécom", amount: 500 }]);
    expect(partsParNature({ amount: 800, budgetCategoryId: null, lines: [] }, nom)).toEqual([{ nature: null, amount: 800 }]);
  });

  it("le mois additionne les parts de ses seules dépenses, la plus lourde d'abord", () => {
    const rows = [
      { date: "2026-10-03T10:00:00.000Z", parts: [{ nature: "Café", amount: 1000 }, { nature: "Papeterie", amount: 300 }] },
      { date: "2026-10-20T10:00:00.000Z", parts: [{ nature: "Papeterie", amount: 900 }] },
      { date: "2026-09-30T10:00:00.000Z", parts: [{ nature: "Café", amount: 5000 }] },
      { date: "2026-10-21T10:00:00.000Z", parts: [{ nature: null, amount: 50 }] },
    ];
    expect(repartitionDuMois(rows, "2026-10")).toEqual([
      { label: "Papeterie", total: 1200, count: 2 }, { label: "Café", total: 1000, count: 1 }, { label: SANS_NATURE, total: 50, count: 1 },
    ]);
    expect(repartitionDuMois(rows, "2026-08")).toEqual([]);
  });

  it("le mois montré d'office, et le mois suivant", () => {
    expect(moisParDefaut(2026, "2026-10-26T09:00:00.000Z")).toBe("2026-10");
    expect(moisParDefaut(2025, "2026-10-26T09:00:00.000Z")).toBe("2025-12");
    expect(moisParDefaut(2027, "2026-10-26T09:00:00.000Z")).toBe("2027-01");
    expect(moisSuivant("2026-12")).toBe("2027-01");
  });

  it("le filtre de nature lit les parts, et le filtre de mois ne garde que ce mois", () => {
    const rows = [
      dep("2026-10-03T10:00:00.000Z", 1300, { nature: "Café", parts: [{ nature: "Café", amount: 1000 }, { nature: "Papeterie", amount: 300 }] }),
      dep("2026-09-03T10:00:00.000Z", 300, { nature: "Papeterie", parts: [{ nature: "Papeterie", amount: 300 }] }),
    ];
    expect(filtrerDepenses(rows, { ...AUCUN_FILTRE, nature: "Papeterie" })).toHaveLength(2);
    expect(filtrerDepenses(rows, { ...AUCUN_FILTRE, nature: "Papeterie", mois: "2026-10" })).toHaveLength(1);
    expect(filtreActif({ ...AUCUN_FILTRE, mois: "2026-10" })).toBe(true);
  });
});