import { describe, expect, it } from "vitest";
import { echeancesPaiement, justificatifsManquants, resumerSignaux, santeBudget, signauxBudget, trierSignaux } from "./intelligence";

/**
 * L'INTELLIGENCE FINANCIÈRE, règle par règle : le rythme comparé au calendrier, la projection,
 * la prévision incohérente, la catégorie dépassée, le justificatif manquant, l'échéance selon sa
 * nature. Chaque cas donne des chiffres qu'on peut refaire à la main.
 */
const maintenant = new Date("2026-07-01T00:00:00Z"); // mi-année : 50 % du temps (à un jour près)
const annee = { debut: "2026-01-01", fin: "2026-12-31" };

describe("santé d'une enveloppe", () => {
  it("un budget consommé au rythme du calendrier est SAIN, et le calcul est dit", () => {
    const s = santeBudget({ id: "e", nom: "Marketing", alloue: 1_000_000, consomme: 480_000, ...annee }, maintenant);
    expect(s.sante).toBe("SAIN");
    expect(s.tauxTemps).toBeCloseTo(0.497, 2);
    expect(s.projectionFin).toBeCloseTo(965_000, -4);
    expect(s.calcul).toMatch(/48 % consommé à 50 % du temps/);
  });
  it("un budget qui file plus vite que le temps est À RISQUE, avec l'écart projeté", () => {
    const s = santeBudget({ id: "e", nom: "IT", alloue: 1_000_000, consomme: 700_000, ...annee }, maintenant);
    expect(s.sante).toBe("A_RISQUE");
    expect(s.ecartProjete).toBeGreaterThan(350_000);
  });
  it("consommé > alloué : DÉPASSÉ ; trop tôt dans la période : SANS RYTHME (pas de projection inventée)", () => {
    expect(santeBudget({ id: "e", nom: "x", alloue: 100, consomme: 120, ...annee }, maintenant).sante).toBe("DEPASSE");
    const tot = santeBudget({ id: "e", nom: "x", alloue: 100, consomme: 1, ...annee }, new Date("2026-01-05T00:00:00Z"));
    expect(tot.sante).toBe("SANS_RYTHME");
    expect(tot.projectionFin).toBeNull();
  });
});

describe("signaux budgétaires", () => {
  it("dépassement CRITIQUE, rythme HAUTE au-delà de 20 % d'écart projeté, catégorie dépassée, prévision sous le réel", () => {
    const s = signauxBudget({
      id: "e", nom: "Congrès", alloue: 1_000_000, consomme: 1_050_000, ...annee, prevision: 900_000,
      categories: [{ id: "c1", nom: "Stands", alloue: 200_000, consomme: 260_000 }, { id: "c2", nom: "Voyages", alloue: 300_000, consomme: 100_000 }],
    }, maintenant);
    const codes = s.map((x) => x.code);
    expect(codes).toEqual(expect.arrayContaining(["budget_depasse", "categorie_depassee", "prevision_incoherente"]));
    expect(s.find((x) => x.code === "budget_depasse")?.gravite).toBe("CRITIQUE");
    expect(s.find((x) => x.code === "categorie_depassee")).toMatchObject({ gravite: "HAUTE", montant: 60_000 });
    expect(s.find((x) => x.code === "prevision_incoherente")?.montant).toBe(150_000);
    const rythme = signauxBudget({ id: "e", nom: "IT", alloue: 1_000_000, consomme: 700_000, ...annee }, maintenant);
    expect(rythme[0]).toMatchObject({ code: "budget_rythme", gravite: "HAUTE" });
    expect(signauxBudget({ id: "e", nom: "ok", alloue: 1_000_000, consomme: 400_000, ...annee, prevision: 950_000 }, maintenant)).toEqual([]);
  });
});

describe("justificatifs et échéances", () => {
  it("un ordre réglé sans facture exigée est HAUTE ; non réglé, NORMALE ; annulé, ignoré ; facture liée, rien", () => {
    const s = justificatifsManquants([
      { id: "1", reference: "OD-1", libelle: "Stand", montant: 50_000, statut: "PAID", factureExigee: true, factureLiee: false, regleLe: "2026-06-01" },
      { id: "2", reference: "OD-2", libelle: "Voyage", montant: 20_000, statut: "PENDING", factureExigee: true, factureLiee: false },
      { id: "3", reference: "OD-3", libelle: "Annulé", montant: 5_000, statut: "CANCELLED", factureExigee: true, factureLiee: false },
      { id: "4", reference: "OD-4", libelle: "Ok", montant: 5_000, statut: "PAID", factureExigee: true, factureLiee: true },
    ]);
    expect(s.map((x) => [x.entite?.ref, x.gravite])).toEqual([["OD-1", "HAUTE"], ["OD-2", "NORMALE"]]);
  });
  it("une date IMPOSÉE à 5 jours est CRITIQUE, une modérée à 5 jours est BASSE, un retard imposé est CRITIQUE, un paiement réglé n'apparaît pas", () => {
    const s = echeancesPaiement([
      { id: "a", reference: "PAY-1", libelle: "Douane", montant: 1_000_000, statut: "SUBMITTED", echeance: "2026-07-06", nature: "FIXED" },
      { id: "b", reference: "PAY-2", libelle: "Fournisseur", montant: 200_000, statut: "SUBMITTED", echeance: "2026-07-06", nature: "MODERATE" },
      { id: "c", reference: "PAY-3", libelle: "Loyer", montant: 300_000, statut: "SUBMITTED", echeance: "2026-06-20", nature: "FIXED" },
      { id: "d", reference: "PAY-4", libelle: "Réglé", montant: 300_000, statut: "PAID", echeance: "2026-06-20", nature: "FIXED" },
      { id: "e", reference: "PAY-5", libelle: "Loin", montant: 300_000, statut: "SUBMITTED", echeance: "2026-12-20", nature: "FIXED" },
    ], maintenant, 30);
    expect(s.map((x) => [x.entite?.ref, x.code, x.gravite])).toEqual([
      ["PAY-3", "paiement_en_retard", "CRITIQUE"], ["PAY-1", "paiement_echeance", "CRITIQUE"], ["PAY-2", "paiement_echeance", "BASSE"],
    ]);
    expect(s[0].calcul).toMatch(/-11 j/);
  });
  it("tri et résumé", () => {
    const tries = trierSignaux([
      { code: "x", gravite: "BASSE", titre: "b", detail: "" }, { code: "y", gravite: "CRITIQUE", titre: "c", detail: "", echeance: "2026-09-02" },
      { code: "z", gravite: "CRITIQUE", titre: "a", detail: "", echeance: "2026-09-01" },
    ]);
    expect(tries.map((s) => s.titre)).toEqual(["a", "c", "b"]);
    expect(resumerSignaux(tries).phrase).toBe("3 signaux (2 critiques, 1 basse)");
    expect(resumerSignaux([]).phrase).toBe("aucun signal");
  });
});
