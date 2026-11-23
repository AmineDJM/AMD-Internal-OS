import { describe, expect, it } from "vitest";
import { libellePosteScinde, lireLignesCochees, nomAgence, phraseDuChoix, planDuChoix, totalDesLignes, valeurDeLigne } from "./choix-agences";

const ligne = (id: string, quantity: number | null, unitPrice: number | null, extra: { valideeAilleurs?: string; refusValidation?: string } = {}) => ({
  id, position: Number(id.replace(/\D/g, "")) || 0, reference: `Article ${id}`, unit: null, quantity, unitPrice, lue: null, aVerifier: null,
  valideeAilleurs: extra.valideeAilleurs ?? null, refusValidation: extra.refusValidation ?? null,
});
const TVA19 = { tvaRate: 19, extraTaxLabel: null, extraTaxRate: null, announcedTotal: null };
const SANS_TVA = { tvaRate: null, extraTaxLabel: null, extraTaxRate: null, announcedTotal: null };
const alpha = { pieceId: "dA", agence: "Alpha", entete: TVA19, lignes: [ligne("a1", 2, 1000), ligne("a2", 1, 500), ligne("a3", 3, 100)] };
const beta = { pieceId: "dB", agence: "Beta", entete: SANS_TVA, lignes: [ligne("b1", 10, 300), ligne("b2", 1, 50)] };
const gamma = { pieceId: "dC", agence: "Gamma", entete: TVA19, lignes: [ligne("c1", 1, 100)] };

describe("choix des agences — lire les cases cochées", () => {
  it("regroupe par devis, sans doublon, et ignore les valeurs vides", () => {
    const r = lireLignesCochees([valeurDeLigne("dA", "a1"), "dA:a2", "dA:a1", "", "dB:b1"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect([...r.parDevis.entries()]).toEqual([["dA", ["a1", "a2"]], ["dB", ["b1"]]]);
  });
  it("refuse une valeur mal formée — un formulaire forgé n'est pas une sélection vide", () => {
    expect(lireLignesCochees(["dA"]).ok).toBe(false);
    expect(lireLignesCochees([":a1"]).ok).toBe(false);
    expect(lireLignesCochees(["dA:"]).ok).toBe(false);
  });
});

describe("choix des agences — le total des lignes cochées (l'arithmétique du BC)", () => {
  it("TTC quand la TVA est imprimée, HT sinon ; seules les lignes cochées comptent", () => {
    expect(totalDesLignes(alpha, new Set(["a1", "a2"]))).toEqual({ montant: 2975, ttc: true, nombre: 2 });
    expect(totalDesLignes(beta, new Set(["b1"]))).toEqual({ montant: 3000, ttc: false, nombre: 1 });
    expect(totalDesLignes(alpha, new Set())).toEqual({ montant: 0, ttc: true, nombre: 0 });
  });
});

describe("choix des agences — le plan", () => {
  it("rien de coché : refusé, la phrase dit quoi faire", () => {
    const r = planDuChoix([alpha, beta], new Map());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("Cochez au moins une ligne");
    expect(planDuChoix([alpha], new Map([["dA", []]])).ok).toBe(false);
  });
  it("une agence : un seul retenu, les autres devis écartés", () => {
    const r = planDuChoix([alpha, beta, gamma], new Map([["dA", ["a1"]]]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.retenues).toEqual([{ pieceId: "dA", agence: "Alpha", ligneIds: ["a1"], montant: 2380, ttc: true }]);
    expect(r.ecartes).toEqual(["dB", "dC"]);
  });
  it("plusieurs agences : le plus gros total en tête (il reste sur le poste d'origine), à égalité l'ordre des devis", () => {
    const r = planDuChoix([alpha, beta, gamma], new Map([["dA", ["a2"]], ["dB", ["b1"]]]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.retenues.map((x) => [x.pieceId, x.montant])).toEqual([["dB", 3000], ["dA", 595]]);
    expect(r.ecartes).toEqual(["dC"]);
    const egal = planDuChoix([{ ...gamma, pieceId: "dX", agence: "X" }, gamma], new Map([["dC", ["c1"]], ["dX", ["c1"]]]));
    expect(egal.ok && egal.retenues.map((x) => x.pieceId)).toEqual(["dX", "dC"]);
  });
  it("refuse une ligne étrangère au devis, déjà commandée ailleurs, incomplète, ou un devis qui ne vaut rien", () => {
    expect(planDuChoix([alpha], new Map([["dA", ["b1"]]])).ok).toBe(false);
    expect(planDuChoix([alpha], new Map([["dZ", ["a1"]]])).ok).toBe(false);
    const ailleurs = { ...alpha, lignes: [ligne("a1", 1, 10, { valideeAilleurs: "Stand" })] };
    const r1 = planDuChoix([ailleurs], new Map([["dA", ["a1"]]]));
    expect(!r1.ok && r1.error).toContain("« Stand »");
    const incomplete = { ...alpha, lignes: [ligne("a1", null, 10, { refusValidation: "la quantité est illisible" })] };
    const r2 = planDuChoix([incomplete], new Map([["dA", ["a1"]]]));
    expect(!r2.ok && r2.error).toContain("la quantité est illisible");
    const gratuit = { ...alpha, lignes: [ligne("a1", 1, 0)] };
    expect(planDuChoix([gratuit], new Map([["dA", ["a1"]]])).ok).toBe(false);
  });
});

describe("choix des agences — les mots", () => {
  it("le libellé d'un poste né de la scission, le nom de l'agence", () => {
    expect(libellePosteScinde(" Stand ", "Agence Atlas")).toBe("Stand — Agence Atlas");
    expect(nomAgence({ fournisseur: " ", fournisseurLu: { nom: "Atlas SARL" }, reference: "DV-1", titre: "Devis" })).toBe("Atlas SARL");
    expect(nomAgence({ fournisseur: null, fournisseurLu: null, reference: null, titre: "Devis 1/2" })).toBe("Devis 1/2");
  });
  it("la phrase de confirmation dit ce qui va se passer", () => {
    expect(phraseDuChoix([])).toContain("Cochez les lignes");
    expect(phraseDuChoix([{ agence: "Alpha", nombre: 2 }])).toContain("1 agence retenue (Alpha)");
    expect(phraseDuChoix([{ agence: "Alpha", nombre: 2 }, { agence: "Beta", nombre: 1 }]))
      .toContain("2 agences retenues : le poste sera scindé en 2 postes, un BC par agence");
  });
});
