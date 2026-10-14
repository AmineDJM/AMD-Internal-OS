import { describe, expect, it } from "vitest";
import {
  STATUTS_EN_CIRCUIT, compterParFiltre, depenseDuPoste, gesteImputation, libelleEtat, montantEngageDuPoste, refusAnnulation,
  refusConsommation, refusImputation, tuilesDepenses, type FaitsDepensePoste,
} from "./depense-poste";
import { STATUTS_ORDRE_ENGAGES } from "./engage";
import { disponible } from "./marketing-vue";

const bc = (id: string, montant: number | null, signe = true, annule = false) => ({ id, montant, signe, annule });
const faits = (over: Partial<FaitsDepensePoste> = {}): FaitsDepensePoste => ({
  accorde: true,
  bcs: [bc("a", 4_200_000), bc("b", 180_000)],
  montantAccorde: 5_000_000,
  imputeeLe: null,
  annuleeLe: null,
  ordres: [],
  ...over,
});
const ordre = (statut: string, montant: number, centralStatus: string | null = "AWAITING") => ({ id: `${statut}-${montant}`, montant, statut, centralStatus });

describe("l'état de la dépense d'un poste", () => {
  it("BC pas tous signés → hors écran ; tous signés, non imputé → À imputer, sans peser sur le budget", () => {
    expect(depenseDuPoste(faits({ bcs: [bc("a", 100), bc("b", 50, false)] })).etat).toBeNull();
    const d = depenseDuPoste(faits());
    expect(d.etat).toBe("A_IMPUTER");
    expect(d.engage).toBe(0);
    expect(d.montantEngage).toBe(4_380_000);
  });

  it("un BC annulé ne compte plus ; un poste non accordé ne s'impute pas", () => {
    expect(depenseDuPoste(faits({ bcs: [bc("a", 100), bc("b", 50, false, true)] })).etat).toBe("A_IMPUTER");
    expect(depenseDuPoste(faits({ accorde: false })).etat).toBeNull();
  });

  it("imputé → Engagée : engagé = somme des BC signés", () => {
    const d = depenseDuPoste(faits({ imputeeLe: "2026-10-10" }));
    expect(d.etat).toBe("ENGAGEE");
    expect(d.engage).toBe(4_380_000);
    expect(d.consomme).toBe(0);
  });

  it("consommée : l'état se lit sur l'ordre — centre de paiement, réponse attendue, refus, Finances", () => {
    const base = { imputeeLe: "2026-10-10" };
    expect(depenseDuPoste(faits({ ...base, ordres: [ordre("PENDING", 4_000_000, "AWAITING")] }))).toMatchObject({ etat: "CONSOMMEE", lieu: "CENTRE_PAIEMENT", engage: 0, enCircuit: 4_000_000, consomme: 4_000_000 });
    expect(depenseDuPoste(faits({ ...base, ordres: [ordre("PENDING", 10, "INFO_REQUESTED")] })).lieu).toBe("REPONSE_DEMANDEE");
    expect(depenseDuPoste(faits({ ...base, ordres: [ordre("PENDING", 10, "REFUSED")] })).lieu).toBe("REFUSEE");
    expect(depenseDuPoste(faits({ ...base, ordres: [ordre("PENDING", 10, "APPROVED")] })).lieu).toBe("FINANCES");
    expect(depenseDuPoste(faits({ ...base, ordres: [ordre("PENDING", 10, "NOT_REQUIRED")] })).lieu).toBe("FINANCES");
  });

  it("le montant consommé remplace l'engagé : la différence est rendue au budget", () => {
    const d = depenseDuPoste(faits({ imputeeLe: "2026-10-10", ordres: [ordre("PENDING", 3_000_000)] }));
    expect(d.engage + d.consomme).toBe(3_000_000);
  });

  it("payée quand tous les ordres vivants sont réglés ; un ordre annulé rend l'état Engagée", () => {
    expect(depenseDuPoste(faits({ imputeeLe: "x", ordres: [ordre("PAID", 3_000_000, "APPROVED")] }))).toMatchObject({ etat: "PAYEE", paye: 3_000_000, consomme: 3_000_000, enCircuit: 0 });
    expect(depenseDuPoste(faits({ imputeeLe: "x", ordres: [ordre("CANCELLED", 3_000_000, "REFUSED")] })).etat).toBe("ENGAGEE");
  });

  it("un poste payé par sa fiche, sans imputation, reste payé (l'ordre fait foi)", () => {
    expect(depenseDuPoste(faits({ ordres: [ordre("PAID", 10, "APPROVED")] })).etat).toBe("PAYEE");
  });

  it("annulée : rien ne pèse", () => {
    const d = depenseDuPoste(faits({ imputeeLe: "x", annuleeLe: "y" }));
    expect(d).toMatchObject({ etat: "ANNULEE", engage: 0, consomme: 0 });
  });

  it("montant engagé : BC sans montant lisible → l'accordé ; sans BC (versement direct) → l'accordé", () => {
    expect(montantEngageDuPoste([bc("a", null), bc("b", null)], 900)).toBe(900);
    expect(montantEngageDuPoste([bc("a", null), bc("b", 300)], 900)).toBe(300);
    expect(montantEngageDuPoste([], 900)).toBe(900);
  });

  it("les statuts « en circuit » sont ceux de l'engagé de la vue d'ensemble", () => {
    expect([...STATUTS_EN_CIRCUIT]).toEqual([...STATUTS_ORDRE_ENGAGES]);
  });

  it("libellés : l'étape porte le vrai guichet", () => {
    expect(libelleEtat("CONSOMMEE", "CENTRE_PAIEMENT")).toBe("Consommée · au centre de paiement");
    expect(libelleEtat("CONSOMMEE", "FINANCES")).toBe("Consommée · chez les Finances");
    expect(libelleEtat("A_IMPUTER", null)).toBe("À imputer");
  });

  it("les filtres comptent chaque état", () => {
    expect(compterParFiltre(["A_IMPUTER", "ENGAGEE", "ENGAGEE", "CONSOMMEE", "PAYEE"])).toEqual({ TOUT: 5, A_IMPUTER: 1, ENGAGEE: 2, CONSOMMEE: 1, PAYEE: 1, ANNULEE: 0 });
  });
});

describe("les gestes et leurs refus", () => {
  const mk = { id: "c1", domaine: "MARKETING" };
  it("imputer : seulement « À imputer », vers une catégorie du Budget Marketing", () => {
    expect(refusImputation({ etat: "A_IMPUTER", geste: "IMPUTER", cible: mk, actuelleId: null })).toBeNull();
    expect(refusImputation({ etat: "A_IMPUTER", geste: "IMPUTER", cible: { id: "g", domaine: "GENERAL" }, actuelleId: null })).toMatch(/Budget Marketing/);
    expect(refusImputation({ etat: "ENGAGEE", geste: "IMPUTER", cible: mk, actuelleId: "c0" })).toMatch(/déjà imputée/);
    expect(refusImputation({ etat: null, geste: "IMPUTER", cible: mk, actuelleId: null })).toMatch(/signés/);
  });
  it("changer de budget : engagée, consommée ou payée — jamais vers le même budget", () => {
    for (const etat of ["ENGAGEE", "CONSOMMEE", "PAYEE"] as const) {
      expect(gesteImputation(etat)).toBe("CHANGER");
      expect(refusImputation({ etat, geste: "CHANGER", cible: mk, actuelleId: "c0" })).toBeNull();
    }
    expect(refusImputation({ etat: "ENGAGEE", geste: "CHANGER", cible: mk, actuelleId: "c1" })).toMatch(/déjà son budget/);
    expect(refusImputation({ etat: "ANNULEE", geste: "CHANGER", cible: mk, actuelleId: "c0" })).toMatch(/annulée/);
  });
  it("consommer : une dépense engagée, 0 < montant ≤ engagé", () => {
    expect(refusConsommation({ etat: "ENGAGEE", montant: 100, montantEngage: 100 })).toBeNull();
    expect(refusConsommation({ etat: "ENGAGEE", montant: 101, montantEngage: 100 })).toMatch(/ne dépasse pas/);
    expect(refusConsommation({ etat: "ENGAGEE", montant: 0, montantEngage: 100 })).toMatch(/montant/);
    expect(refusConsommation({ etat: "CONSOMMEE", montant: 10, montantEngage: 100 })).toMatch(/déjà consommée/);
    expect(refusConsommation({ etat: "A_IMPUTER", montant: 10, montantEngage: 100 })).toMatch(/imputez/);
  });
  it("annuler : seulement une dépense engagée", () => {
    expect(refusAnnulation("ENGAGEE")).toBeNull();
    expect(refusAnnulation("CONSOMMEE")).toMatch(/ne s'annule plus/);
    expect(refusAnnulation("PAYEE")).toMatch(/ne s'annule plus/);
    expect(refusAnnulation("ANNULEE")).toMatch(/déjà annulée/);
  });
});

describe("les tuiles — les mêmes définitions que la vue d'ensemble", () => {
  it("engagé + consommé = non payé + payé ; le disponible est celui de la vue d'ensemble", () => {
    const t = tuilesDepenses({ total: 48_000_000, paye: 15_900_000, nonPaye: 8_150_000, enCircuit: 1_950_000 });
    expect(t).toEqual({ budget: 48_000_000, engage: 6_200_000, consomme: 17_850_000, paye: 15_900_000, disponible: 23_950_000 });
    expect(t.disponible).toBe(disponible(48_000_000, 15_900_000, 8_150_000));
  });
  it("un « en circuit » plus grand que le non-payé ne rend jamais un engagé négatif", () => {
    const t = tuilesDepenses({ total: 100, paye: 10, nonPaye: 5, enCircuit: 8 });
    expect(t.engage).toBe(0);
    expect(t.consomme).toBe(15);
    expect(t.disponible).toBe(disponible(100, 10, 5));
  });
});
