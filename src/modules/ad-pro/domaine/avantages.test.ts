import { describe, expect, it } from "vitest";
import {
  adresseRegistre, agregerRegistre, anneeDeLAvantage, CLE_NON_RATTACHES, concentrationDesAvantages, ficheDuProfessionnel, filtrerAvantages, FILTRES_AVANTAGES_VIDES,
  lireFiltresAvantages, partPayee, resoudreFusions, resteAPayer, type Avantage, type ProfessionnelAvantages,
} from "./avantages";

/** Le registre des avantages aux professionnels de santé — les règles pures (agrégation, concentration, non-rattachés). */

let seq = 0;
const av = (o: Partial<Avantage>): Avantage => ({
  id: `a${++seq}`, doctorId: "d1", nomLibre: null, date: "2026-03-10T09:00:00.000Z", nature: "PEC_BILLET", objet: "Congrès X — Billet",
  engageDzd: 100_000, payeDzd: 100_000, societeId: "s1", demandeur: null, reference: null, href: null, ...o,
});
const pro = (id: string, o: Partial<ProfessionnelAvantages> = {}): [string, ProfessionnelAvantages] =>
  [id, { doctorId: id, nom: `Dr ${id}`, specialite: "Cardiologie", etablissement: "CHU", wilaya: "Alger", lettre: "A", ...o }];

describe("registre des avantages — règles pures", () => {
  it("l'année se lit à l'heure d'Alger", () => {
    expect(anneeDeLAvantage("2025-12-31T23:30:00.000Z")).toBe(2026);
    expect(anneeDeLAvantage("2025-12-31T22:30:00.000Z")).toBe(2025);
  });

  it("engagé non payé = engagé − payé, jamais négatif ; un montant non attribuable ne reste rien", () => {
    expect(resteAPayer({ engageDzd: 150_000.5, payeDzd: 100_000 })).toBe(50_000.5);
    expect(resteAPayer({ engageDzd: 100, payeDzd: 120 })).toBe(0);
    expect(resteAPayer({ engageDzd: null, payeDzd: null })).toBe(0);
  });

  it("agrège par professionnel et par année ; les noms libres vont dans une seule ligne « non rattachés », en dernier", () => {
    const pros = new Map([pro("d1"), pro("d2", { specialite: "Oncologie", wilaya: "Oran" })]);
    const tous = [
      av({ doctorId: "d1", payeDzd: 60_000, engageDzd: 100_000 }),
      av({ doctorId: "d1", nature: "SPONSORING", payeDzd: 40_000, engageDzd: 40_000, date: "2026-06-01T00:00:00.000Z", objet: "Sponsoring A" }),
      av({ doctorId: "d1", date: "2025-05-01T00:00:00.000Z" }),
      av({ doctorId: "d2", payeDzd: 300_000, engageDzd: 300_000 }),
      av({ doctorId: null, nomLibre: "Pr Benali", payeDzd: 50_000, engageDzd: 50_000 }),
      av({ doctorId: null, nomLibre: "Dr Haddad", payeDzd: 0, engageDzd: 20_000 }),
      av({ doctorId: "d2", engageDzd: null, payeDzd: null, nature: "EVENEMENT" }),
    ];
    const f2026 = filtrerAvantages(tous, { ...FILTRES_AVANTAGES_VIDES, annee: 2026 }, pros);
    const r = agregerRegistre(f2026, pros);
    expect(r.payeDzd).toBe(450_000);
    expect(r.resteDzd).toBe(60_000);
    expect(r.lignes.map((l) => l.cle)).toEqual(["d2", "d1", CLE_NON_RATTACHES]);
    const d1 = r.lignes.find((l) => l.cle === "d1")!;
    expect(d1).toMatchObject({ nombre: 2, payeDzd: 100_000, resteDzd: 40_000, dernierObjet: "Sponsoring A", specialite: "Cardiologie", lettre: "A" });
    expect(d1.part).toBeCloseTo(100_000 / 450_000);
    const d2 = r.lignes.find((l) => l.cle === "d2")!;
    expect(d2.nombre).toBe(2);
    expect(d2.sansMontant).toBe(1);
    const libres = r.lignes.at(-1)!;
    expect(libres).toMatchObject({ doctorId: null, nombre: 2, payeDzd: 50_000, resteDzd: 20_000, noms: ["Dr Haddad", "Pr Benali"] });

    // Spécialité / wilaya : un nom libre n'en a pas, il sort ; la société et la nature filtrent l'avantage.
    expect(filtrerAvantages(tous, { ...FILTRES_AVANTAGES_VIDES, specialite: "Oncologie" }, pros).every((a) => a.doctorId === "d2")).toBe(true);
    expect(filtrerAvantages(tous, { ...FILTRES_AVANTAGES_VIDES, wilaya: "Alger" }, pros).every((a) => a.doctorId === "d1")).toBe(true);
    expect(filtrerAvantages(tous, { ...FILTRES_AVANTAGES_VIDES, nature: "SPONSORING" }, pros)).toHaveLength(1);
    expect(filtrerAvantages([...tous, av({ societeId: "s2" })], { ...FILTRES_AVANTAGES_VIDES, societeId: "s2" }, pros)).toHaveLength(1);
  });

  it("concentration : top 10 et top 20 % des bénéficiaires, sur le payé ; les non-rattachés comptent au total, pas au classement", () => {
    const pros = new Map(Array.from({ length: 12 }, (_, i) => pro(`p${i}`)));
    const tous = Array.from({ length: 12 }, (_, i) => av({ doctorId: `p${i}`, payeDzd: (i + 1) * 10_000, engageDzd: (i + 1) * 10_000 }));
    tous.push(av({ doctorId: null, nomLibre: "Inconnu", payeDzd: 220_000, engageDzd: 220_000 }));
    const c = concentrationDesAvantages(agregerRegistre(tous, pros));
    // Total payé = 780 000 + 220 000 = 1 000 000 ; top 10 = 120 000 + … + 30 000 = 750 000.
    expect(c.beneficiaires).toBe(12);
    expect(c.top10).toMatchObject({ professionnels: 10, payeDzd: 750_000 });
    expect(c.top10.part).toBeCloseTo(0.75);
    // 20 % de 12 = 2,4 → 3 professionnels : 120 000 + 110 000 + 100 000.
    expect(c.top20pct).toMatchObject({ professionnels: 3, payeDzd: 330_000 });
    expect(c.top20pct.part).toBeCloseTo(0.33);
    expect(concentrationDesAvantages(agregerRegistre([], pros))).toMatchObject({ beneficiaires: 0, top10: { part: null }, top20pct: { professionnels: 0, part: null } });
  });

  it("la fiche : chronologie la plus récente d'abord, totaux par année et par nature", () => {
    const f = ficheDuProfessionnel([
      av({ date: "2025-04-01T00:00:00.000Z", nature: "PEC_HOTEL", payeDzd: 30_000, engageDzd: 30_000 }),
      av({ date: "2026-02-01T00:00:00.000Z", nature: "PEC_BILLET", payeDzd: 0, engageDzd: 80_000 }),
      av({ date: "2026-09-01T00:00:00.000Z", nature: "PEC_BILLET", payeDzd: 50_000, engageDzd: 50_000 }),
    ]);
    expect(f.chronologie.map((a) => a.date.slice(0, 7))).toEqual(["2026-09", "2026-02", "2025-04"]);
    expect(f.parAnnee).toEqual([
      { annee: 2026, nombre: 2, payeDzd: 50_000, resteDzd: 80_000 },
      { annee: 2025, nombre: 1, payeDzd: 30_000, resteDzd: 0 },
    ]);
    expect(f.parNature.map((n) => [n.nature, n.nombre, n.payeDzd, n.resteDzd])).toEqual([["PEC_BILLET", 2, 50_000, 80_000], ["PEC_HOTEL", 1, 30_000, 0]]);
    expect(f.total).toEqual({ nombre: 3, payeDzd: 80_000, resteDzd: 80_000 });
  });

  it("les fiches fusionnées remontent à leur survivante (chaîne suivie, boucle coupée)", () => {
    const vers = resoudreFusions([{ absorbeeId: "a", gardeId: "b" }, { absorbeeId: "b", gardeId: "c" }, { absorbeeId: "x", gardeId: "y" }, { absorbeeId: "y", gardeId: "x" }]);
    expect(vers("a")).toBe("c");
    expect(vers("c")).toBe("c");
    expect(vers("z")).toBe("z");
    expect(["x", "y"]).toContain(vers("x"));
  });

  it("la part payée d'un montant attribué suit la proportion réglée de la demande, sans la dépasser", () => {
    expect(partPayee(100_000, 400_000, 200_000)).toBe(50_000);
    expect(partPayee(100_000, 400_000, 500_000)).toBe(100_000);
    expect(partPayee(100_000, 0, 0)).toBe(0);
  });

  it("les filtres de l'adresse : l'année en cours par défaut, « toutes », une nature inconnue ignorée", () => {
    const lire = (q: string) => { const p = new URLSearchParams(q); return lireFiltresAvantages((k) => p.get(k), 2026); };
    expect(lire("")).toEqual({ ...FILTRES_AVANTAGES_VIDES, annee: 2026 });
    expect(lire("annee=toutes&nature=PIRATE&societe=s1")).toEqual({ ...FILTRES_AVANTAGES_VIDES, societeId: "s1" });
    const f = lire("annee=2025&nature=SPONSORING&wilaya=Oran&specialite=Cardiologie");
    expect(f).toEqual({ annee: 2025, societeId: null, nature: "SPONSORING", specialite: "Cardiologie", wilaya: "Oran" });
    const url = adresseRegistre("/admin/avantages", f, "d1");
    expect(url.startsWith("/admin/avantages?")).toBe(true);
    const relu = new URLSearchParams(url.split("?")[1]);
    expect(lireFiltresAvantages((k) => relu.get(k), 2026)).toEqual(f);
    expect(relu.get("pro")).toBe("d1");
  });
});
