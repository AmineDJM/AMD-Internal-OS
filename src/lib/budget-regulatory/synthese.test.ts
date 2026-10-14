import { describe, expect, it } from "vitest";
import type { CelluleBv, LigneBv } from "./bv";
import { avancementPeriode, courbeProjection, libelleMois, moisDe, prochainsBv, resumePrevision, syntheseSimple, type PointCumul } from "./synthese";

const cel = (p: Partial<CelluleBv> = {}): CelluleBv => ({ statut: "A_VENIR", paye: 0, demande: 0, date: null, dansEnveloppe: 0, aImputer: [], ...p });
const ligne = (id: string, p: Partial<LigneBv> = {}): LigneBv => ({
  dossierId: id, reference: `REG-${id}`, dci: `DCI ${id}`, nom: null, bv25: cel(), bv75: cel(), autres: 0, prevision75: 0, ...p,
});

describe("moisDe / libelleMois", () => {
  it("lit le mois en UTC et refuse l'illisible", () => {
    expect(moisDe("2026-11-30T23:00:00.000Z")).toBe("2026-11");
    expect(moisDe(new Date("2026-01-01T00:00:00Z"))).toBe("2026-01");
    expect(moisDe(null)).toBeNull();
    expect(moisDe("pas une date")).toBeNull();
  });
  it("écrit le mois en français, « — » s'il est inconnu", () => {
    expect(libelleMois("2026-11")).toBe("novembre");
    expect(libelleMois("2026-08", true)).toBe("août 2026");
    expect(libelleMois(null)).toBe("—");
    expect(libelleMois("2026-13")).toBe("—");
  });
});

describe("prochainsBv — ce qui reste à demander ou à régler", () => {
  const lignes = [
    ligne("B", { nom: "Dolutégravir", bv25: cel({ statut: "PAYE", paye: 450_000 }), prevision75: 1_350_000 }),
    ligne("A", { dci: "Darunavir", bv25: cel({ statut: "PAYE", paye: 450_000 }), prevision75: 1_350_000 }),
    ligne("C", { nom: "Pralatrexate", bv25: cel({ statut: "DEMANDE", demande: 450_000, date: "2026-10-05T10:00:00.000Z" }) }),
    ligne("D", { bv25: cel({ statut: "PAYE", paye: 100 }), bv75: cel({ statut: "PAYE", paye: 300 }) }),
  ];
  const depot = { A: "2026-11-12T00:00:00.000Z", B: "2026-12-03T00:00:00.000Z" };

  it("le 75 % attendu tombe au mois du dépôt prévu, le BV demandé au mois de sa demande", () => {
    const r = prochainsBv(lignes, depot);
    expect(r.map((x) => [x.reference, x.nature, x.mois, x.etat])).toEqual([
      ["REG-C", "25", "2026-10", "DEMANDE"],
      ["REG-A", "75", "2026-11", "A_DEMANDER"],
      ["REG-B", "75", "2026-12", "A_DEMANDER"],
    ]);
    expect(r[1].produit).toBe("Darunavir");
    expect(r[2].produit).toBe("Dolutégravir");
    expect(r[1].montant).toBe(1_350_000);
  });

  it("sans dépôt prévu : pas de mois (jamais inventé), et il passe en dernier", () => {
    const r = prochainsBv(lignes, { A: null });
    expect(r.map((x) => x.mois)).toEqual(["2026-10", null, null]);
    expect(r.map((x) => x.reference)).toEqual(["REG-C", "REG-A", "REG-B"]);
  });

  it("un dossier dont les deux BV sont payés n'a plus rien à venir", () => {
    expect(prochainsBv([lignes[3]], {})).toEqual([]);
  });

  it("un 75 % demandé et pas réglé figure comme « demandé »", () => {
    const l = ligne("E", { bv75: cel({ statut: "DEMANDE", demande: 900, date: "2026-09-02T00:00:00.000Z" }) });
    expect(prochainsBv([l], {})).toMatchObject([{ nature: "75", etat: "DEMANDE", mois: "2026-09", montant: 900 }]);
  });
});

describe("resumePrevision — le BV 75 % à venir en un chiffre", () => {
  it("additionne les prévisions et compte les dossiers qui les portent", () => {
    expect(resumePrevision([{ prevision75: 300 }, { prevision75: 0 }, { prevision75: 450 }])).toEqual({ montant: 750, dossiers: 2 });
    expect(resumePrevision([])).toEqual({ montant: 0, dossiers: 0 });
  });
});

describe("avancementPeriode", () => {
  it("donne la part de la période écoulée, bornée à 0-100", () => {
    const a = "2026-01-01T00:00:00.000Z";
    const b = "2027-01-01T00:00:00.000Z";
    expect(avancementPeriode(a, b, new Date("2026-07-02T12:00:00.000Z"))).toBe(50);
    expect(avancementPeriode(a, b, new Date("2025-06-01T00:00:00.000Z"))).toBe(0);
    expect(avancementPeriode(a, b, new Date("2028-01-01T00:00:00.000Z"))).toBe(100);
    expect(avancementPeriode(b, a, new Date())).toBe(0);
  });
});

describe("courbeProjection — le réel, puis les BV 75 % attendus en pointillé", () => {
  const pts: PointCumul[] = [
    { month: "2026-01", label: "janv.", cumulative: 100 },
    { month: "2026-02", label: "févr.", cumulative: 300 },
    { month: "2026-03", label: "mars", cumulative: 300 },
    { month: "2026-04", label: "avr.", cumulative: 300 },
    { month: "2026-05", label: "mai", cumulative: 300 },
  ];
  const now = new Date("2026-02-15T00:00:00Z");

  it("le réel s'arrête au mois en cours, la projection en part et s'additionne mois par mois", () => {
    const c = courbeProjection(pts, [{ mois: "2026-04", montant: 1000 }, { mois: "2026-05", montant: 500 }], now);
    expect(c.indexMaintenant).toBe(1);
    expect(c.reel).toEqual([100, 300, null, null, null]);
    expect(c.projete).toEqual([null, 300, 300, 1300, 1800]);
    expect(c.nonDates).toEqual({ nombre: 0, montant: 0 });
  });

  it("un BV attendu ce mois-ci ou en retard tombe au mois suivant ; hors période, aux bornes", () => {
    const c = courbeProjection(pts, [{ mois: "2026-02", montant: 10 }, { mois: "2025-06", montant: 20 }, { mois: "2027-01", montant: 40 }], now);
    expect(c.projete).toEqual([null, 300, 330, 330, 370]);
  });

  it("un BV sans mois n'est pas placé : il est compté à part", () => {
    const c = courbeProjection(pts, [{ mois: null, montant: 700 }, { mois: "2026-03", montant: 100 }], now);
    expect(c.projete).toEqual([null, 300, 400, 400, 400]);
    expect(c.nonDates).toEqual({ nombre: 1, montant: 700 });
  });

  it("aujourd'hui hors période : avant → premier mois, après → dernier mois", () => {
    expect(courbeProjection(pts, [], new Date("2025-01-01T00:00:00Z")).indexMaintenant).toBe(0);
    const apres = courbeProjection(pts, [{ mois: "2026-03", montant: 50 }], new Date("2027-06-01T00:00:00Z"));
    expect(apres.indexMaintenant).toBe(4);
    expect(apres.reel).toEqual([100, 300, 300, 300, 300]);
    expect(apres.projete[4]).toBe(350);
  });

  it("série vide : rien à tracer", () => {
    expect(courbeProjection([], [{ mois: "2026-03", montant: 1 }], now).labels).toEqual([]);
  });
});

describe("syntheseSimple — un BV 25 % engage tout le dossier", () => {
  // A : 25 % payé, 75 % attendu (3 × 450 000). B : 25 % demandé, pas réglé, 75 % attendu.
  // C : 25 % et 75 % payés (soldé). D : 25 % payé, 75 % demandé pas réglé.
  const A = ligne("A", { nom: "Darunavir", bv25: cel({ statut: "PAYE", paye: 450_000 }), prevision75: 1_350_000 });
  const B = ligne("B", { bv25: cel({ statut: "DEMANDE", demande: 200_000 }), prevision75: 600_000 });
  const C = ligne("C", { bv25: cel({ statut: "PAYE", paye: 100_000 }), bv75: cel({ statut: "PAYE", paye: 300_000 }) });
  const D = ligne("D", { bv25: cel({ statut: "PAYE", paye: 50_000 }), bv75: cel({ statut: "DEMANDE", demande: 150_000 }) });
  const totaux = { total: 10_000_000, consumed: 900_000, committed: 350_000 };

  it("compte et additionne les BV 25 % : payés, demandés, au total", () => {
    const s = syntheseSimple([A, B, C, D], totaux);
    expect(s.bv25.payes).toEqual({ nombre: 3, montant: 600_000 });
    expect(s.bv25.demandes).toEqual({ nombre: 1, montant: 200_000 });
    expect(s.bv25.total).toEqual({ nombre: 4, montant: 800_000 });
  });

  it("BV 75 % : payés, demandés, et à venir = 3 × le BV 25 % (payé OU seulement demandé)", () => {
    const s = syntheseSimple([A, B, C, D], totaux);
    expect(s.bv75.payes).toEqual({ nombre: 1, montant: 300_000 });
    expect(s.bv75.demandes).toEqual({ nombre: 1, montant: 150_000 });
    expect(s.bv75.aVenir).toEqual({ nombre: 2, montant: 1_950_000 });
  });

  it("engagé = engagé de l'enveloppe (BV demandés compris) + les 75 % attendus ; restant = budget − consommé − engagé", () => {
    const s = syntheseSimple([A, B, C, D], totaux);
    expect(s.engageDetail).toEqual({ enveloppe: 350_000, bvDemandes: 350_000, bv75AVenir: 1_950_000 });
    expect(s.consomme).toBe(900_000);
    expect(s.engage).toBe(350_000 + 1_950_000);
    expect(s.restant).toBe(10_000_000 - 900_000 - 2_300_000);
    expect(s.barre.consomme + s.barre.engage + s.barre.libre).toBeCloseTo(100);
    expect(s.barre.consomme).toBeCloseTo(9);
    expect(s.barre.engage).toBeCloseTo(23);
  });

  it("un BV demandé et pas réglé reste engagé, même s'il n'est pas (encore) dans l'enveloppe — jamais compté deux fois", () => {
    const horsEnveloppe = syntheseSimple([B], { total: 1_000_000, consumed: 0, committed: 0 });
    expect(horsEnveloppe.engage).toBe(200_000 + 600_000);
    const dansEnveloppe = syntheseSimple([B], { total: 1_000_000, consumed: 0, committed: 200_000 });
    expect(dansEnveloppe.engage).toBe(200_000 + 600_000);
    expect(dansEnveloppe.restant).toBe(200_000);
  });

  it("le BV 75 % payé n'est plus engagé : il est consommé, et le dossier est soldé", () => {
    const avant = syntheseSimple([A], { total: 2_000_000, consumed: 450_000, committed: 0 });
    expect(avant.engage).toBe(1_350_000);
    expect(avant.dossiers[0]).toMatchObject({
      produit: "Darunavir", bv25: { montant: 450_000, etat: "PAYE" }, bv75: { montant: 1_350_000, etat: "ENGAGE" },
      fraisTotaux: 1_800_000, resteAPayer: 1_350_000,
    });
    const apres = syntheseSimple(
      [{ ...A, bv75: cel({ statut: "PAYE", paye: 1_350_000 }), prevision75: 0 }],
      { total: 2_000_000, consumed: 1_800_000, committed: 0 },
    );
    expect(apres.engage).toBe(0);
    expect(apres.restant).toBe(200_000);
    expect(apres.dossiers[0]).toMatchObject({ bv75: { montant: 1_350_000, etat: "PAYE" }, fraisTotaux: 1_800_000, resteAPayer: 0 });
  });

  it("lignes du tableau : demandé, 75 % demandé, rien de connu", () => {
    const s = syntheseSimple([B, D, ligne("E", { bv25: cel({ statut: "PAYE_SANS_MONTANT" }) })], { total: 0, consumed: 0, committed: 0 });
    expect(s.dossiers[0]).toMatchObject({ bv25: { montant: 200_000, etat: "DEMANDE" }, bv75: { etat: "ENGAGE" }, fraisTotaux: 800_000, resteAPayer: 800_000 });
    expect(s.dossiers[1]).toMatchObject({ bv75: { montant: 150_000, etat: "DEMANDE" }, fraisTotaux: 200_000, resteAPayer: 150_000 });
    expect(s.dossiers[2]).toMatchObject({ bv25: { montant: null, etat: "PAYE" }, bv75: { montant: null, etat: "AUCUN" }, fraisTotaux: 0, resteAPayer: 0 });
    expect(s.bv25.payes.nombre).toBe(2);
  });

  it("dépassement : la barre se rapporte à consommé + engagé, le restant devient négatif", () => {
    const s = syntheseSimple([A], { total: 1_000_000, consumed: 450_000, committed: 0 });
    expect(s.restant).toBe(1_000_000 - 450_000 - 1_350_000);
    expect(s.barre.libre).toBe(0);
    expect(s.barre.consomme + s.barre.engage).toBeCloseTo(100);
    expect(syntheseSimple([], { total: 0, consumed: 0, committed: 0 }).barre).toEqual({ consomme: 0, engage: 0, libre: 0 });
  });
});
