import { describe, expect, it } from "vitest";
import {
  alerteBudget, alerteCourte, alerteTresorerie, budgetAvantApres, montantCourt, montantsEtEcarts, phraseBudget,
  phraseHistorique, PREMIER_PAIEMENT, trierFile,
} from "./contexte-decision";

/**
 * LA FICHE DE DÉCISION DU CENTRE — ses règles pures (maquette validée le 24/11/2026) : l'ordre de la file, la phrase
 * d'historique du bénéficiaire, les montants du devis à ce qu'on paie, le budget avant/après, les alertes.
 */

const MAINTENANT = new Date("2026-11-24T10:00:00Z");
const jours = (n: number) => new Date(MAINTENANT.getTime() + n * 86_400_000).toISOString();

describe("trierFile — échéance fixe proche, montant élevé, ancienneté", () => {
  const o = (id: string, montant: number, x: { echeance?: string | null; fixe?: boolean; age?: number } = {}) => ({
    id, montant, echeance: x.echeance ?? null, echeanceFixe: x.fixe ?? false, demandeLe: jours(-(x.age ?? 0)),
  });

  it("une échéance FIXE à moins d'une semaine passe devant tout, la plus proche en tête", () => {
    const file = trierFile([
      o("gros", 5_000_000, { age: 30 }),
      o("fixe-loin", 10_000, { echeance: jours(20), fixe: true }),
      o("fixe-6j", 10_000, { echeance: jours(6), fixe: true }),
      o("fixe-2j", 10_000, { echeance: jours(2), fixe: true }),
      o("fixe-depassee", 10_000, { echeance: jours(-1), fixe: true }),
    ], MAINTENANT);
    expect(file.map((f) => f.id)).toEqual(["fixe-depassee", "fixe-2j", "fixe-6j", "gros", "fixe-loin"]);
  });

  it("une échéance proche mais NON fixe ne double personne ; les montants élevés (≥ 50 000) passent avant les petits", () => {
    const file = trierFile([
      o("petit-vieux", 3_000, { age: 40 }),
      o("souple-demain", 3_000, { echeance: jours(1), fixe: false, age: 1 }),
      o("gros-recent", 80_000, { age: 1 }),
      o("gros-vieux", 60_000, { age: 10 }),
    ], MAINTENANT);
    expect(file.map((f) => f.id)).toEqual(["gros-vieux", "gros-recent", "petit-vieux", "souple-demain"]);
  });

  it("ne modifie pas la liste reçue", () => {
    const l = [o("b", 1, { age: 1 }), o("a", 1, { age: 2 })];
    trierFile(l, MAINTENANT);
    expect(l.map((x) => x.id)).toEqual(["b", "a"]);
  });
});

describe("phraseHistorique — le bénéficiaire en une phrase", () => {
  it("aucun paiement : « 1er paiement à ce bénéficiaire »", () => {
    expect(phraseHistorique({ nombre: 0, total: 0, dernier: null })).toBe(PREMIER_PAIEMENT);
  });
  it("combien, pour combien, le dernier quand", () => {
    const p = phraseHistorique({ nombre: 2, total: 1_600_000, dernier: "2026-10-12T10:00:00Z" });
    expect(p).toBe("2 paiements en 12 mois, 1,6 M DZD, dernier le 12 oct.");
  });
  it("montantCourt : le million en M, le reste au dinar", () => {
    expect(montantCourt(3_200_000)).toBe("3,2 M DZD");
    expect(montantCourt(450_000).replace(/\s/g, " ")).toBe("450 000 DZD");
  });
});

describe("montantsEtEcarts — du devis à ce qu'on paie", () => {
  it("tout concorde : les jalons, puis « À payer », sans rouge ni alerte", () => {
    const r = montantsEtEcarts(450_000, [
      { libelle: "Devis", valeur: 450_000 }, { libelle: "Accordé", valeur: 450_000, plafond: "ACCORDE" },
      { libelle: "BC", valeur: 450_000, plafond: "BC" }, { libelle: "Facture", valeur: 450_000 },
    ]);
    expect(r.montants.map((m) => m.libelle)).toEqual(["Devis", "Accordé", "BC", "Facture", "À payer"]);
    expect(r.montants.some((m) => m.ecart)).toBe(false);
    expect(r.alertes).toEqual([]);
  });

  it("au-delà de la marge de 10 % du BC : alerte rouge avec les deux chiffres, facture et « à payer » en rouge", () => {
    const r = montantsEtEcarts(232_000, [
      { libelle: "BC n°1", valeur: 210_500, plafond: "BC", nomme: "BC n°1 signé" }, { libelle: "Facture", valeur: 232_000 },
    ]);
    expect(r.alertes).toHaveLength(1);
    expect(r.alertes[0].titre).toBe("Montant au-dessus du BC");
    expect(r.alertes[0].detail.replace(/\s/g, " ")).toMatch(/BC n°1 signé : 210 500 DZD ; à payer 232 000 \(\+10,2 %\)/);
    expect(r.montants.filter((m) => m.ecart).map((m) => m.libelle)).toEqual(["Facture", "À payer"]);
  });

  it("dans la marge du BC : pas d'alerte ; au-dessus de l'accordé (sans marge) : alerte", () => {
    expect(montantsEtEcarts(105_000, [{ libelle: "BC", valeur: 100_000, plafond: "BC" }]).alertes).toEqual([]);
    expect(montantsEtEcarts(105_000, [{ libelle: "Accordé", valeur: 100_000, plafond: "ACCORDE" }]).alertes[0].titre).toBe("Montant au-dessus de l'accordé");
  });

  it("aucun jalon : aucune frise (pas de « À payer » seul, le montant est déjà en tête de fiche)", () => {
    expect(montantsEtEcarts(1000, []).montants).toEqual([]);
    expect(montantsEtEcarts(1000, [{ libelle: "Devis", valeur: null }]).montants).toEqual([]);
  });
});

describe("le budget, avant et après", () => {
  it("l'ordre est déjà dans l'engagé : après = alloué − consommé − engagé ; avant = après + montant", () => {
    expect(budgetAvantApres({ alloue: 1_000_000, consomme: 200_000, engage: 300_000, montant: 150_000 })).toEqual({ avant: 650_000, apres: 500_000 });
  });
  it("sous zéro après le paiement : « Budget dépassé »", () => {
    const b = { etat: "IMPUTE" as const, ligne: "Marketing › Événements", ...budgetAvantApres({ alloue: 100_000, consomme: 0, engage: 150_000, montant: 150_000 }) };
    expect(alerteBudget(b)?.titre).toBe("Budget dépassé");
    expect(alerteBudget({ ...b, apres: 0 })).toBeNull();
    expect(alerteBudget({ etat: "NON_IMPUTE" })).toBeNull();
  });
  it("chaque état se dit en une phrase", () => {
    expect(phraseBudget({ etat: "IMPUTE", ligne: "x", avant: 3_200_000, apres: 2_750_000 })).toBe("Disponible 3,2 M DZD → 2,8 M DZD après ce paiement");
    expect(phraseBudget({ etat: "HORS_ENVELOPPE", phrase: "Hors enveloppe" })).toBe("Hors enveloppe");
    expect(phraseBudget({ etat: "NON_IMPUTE" })).toMatch(/Non imputé/);
    expect(phraseBudget({ etat: "INCONNU" })).toMatch(/non lu/);
  });
});

describe("les alertes de trésorerie et la ligne de la file", () => {
  it("trésorerie : alerte quand le paiement dépasse le disponible ; rien quand elle est inconnue", () => {
    expect(alerteTresorerie(500_000, 400_000)?.titre).toBe("Trésorerie insuffisante");
    expect(alerteTresorerie(300_000, 400_000)).toBeNull();
    expect(alerteTresorerie(300_000, null)).toBeNull();
  });
  it("la ligne de la file dit les titres, rouges d'abord", () => {
    expect(alerteCourte([])).toBeNull();
    expect(alerteCourte([
      { titre: "Bénéficiaire nouveau", detail: "", niveau: "ATTENTION" },
      { titre: "Doublon possible", detail: "", niveau: "BLOQUANT" },
    ])).toBe("Doublon possible · Bénéficiaire nouveau");
  });
});
