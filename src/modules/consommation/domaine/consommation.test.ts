import { describe, it, expect } from "vitest";
import { analyserClasseur, lirePeriode, periodeDuTexte, normaliserUnite, normaliserQuantite, reconnaitreColonne, type Feuilles } from "./lecture";
import { resolveur, cleDoublon, chevauche } from "./resolution";
import { calculerAffinites, fenetre, type LigneAffinite } from "./affinite";

/**
 * CONSUMPTION INTELLIGENCE — les cas du cahier des charges (§24-35, §78, §79), sans base.
 */

describe("périodes", () => {
  it("lit les écritures réelles d'une période — et n'en fabrique aucune", () => {
    expect(lirePeriode("janvier 2026")).toMatchObject({ debut: "2026-01-01", fin: "2026-01-31" });
    expect(lirePeriode("Janv-26")).toMatchObject({ debut: "2026-01-01" });
    expect(lirePeriode("02/2024")).toMatchObject({ debut: "2024-02-01", fin: "2024-02-29" });
    expect(lirePeriode("2025-11")).toMatchObject({ debut: "2025-11-01", fin: "2025-11-30" });
    expect(lirePeriode("T2 2025")).toMatchObject({ debut: "2025-04-01", fin: "2025-06-30" });
    expect(lirePeriode("S2 2025")).toMatchObject({ debut: "2025-07-01", fin: "2025-12-31" });
    expect(lirePeriode(2025)).toMatchObject({ debut: "2025-01-01", fin: "2025-12-31" });
    expect(lirePeriode(46023)).toMatchObject({ debut: "2026-01-01" }); // date Excel
    expect(lirePeriode("mars", 2026)).toMatchObject({ debut: "2026-03-01" });
    expect(lirePeriode("mars")).toBeNull();
    expect(lirePeriode("Raltégravir")).toBeNull();
    expect(lirePeriode(12)).toBeNull();
    expect(periodeDuTexte("Consommation CHU Oran — 1er semestre 2025")).toMatchObject({ debut: "2025-01-01", fin: "2025-06-30" });
  });
});

describe("unités", () => {
  it("normalise, et ne convertit une boîte que si la présentation dit combien", () => {
    expect(normaliserUnite("Cp")).toBe("UNITE");
    expect(normaliserUnite("Btes")).toBe("BOITE");
    expect(normaliserUnite("blister")).toBeNull();
    expect(normaliserQuantite(10, "boîte", "B/60")).toMatchObject({ quantite: 600, unite: "UNITE" });
    expect(normaliserQuantite(10, "boîte", null)).toMatchObject({ quantite: 10, unite: "BOITE", conversion: null });
  });
});

describe("colonnes", () => {
  it("synonymes, ressemblance, mémoire — avec leur confiance", () => {
    expect(reconnaitreColonne("Hôpital")).toMatchObject({ champ: "etablissement", confiance: 95, origine: "synonyme" });
    expect(reconnaitreColonne("Structure")).toMatchObject({ champ: "etablissement" });
    expect(reconnaitreColonne("Qté consommée 2025")).toMatchObject({ champ: "quantite", origine: "ressemblance" });
    expect(reconnaitreColonne("ETB")).toMatchObject({ champ: null });
    expect(reconnaitreColonne("ETB", new Map([["etb", "etablissement"]]))).toMatchObject({ champ: "etablissement", confiance: 99, origine: "memoire" });
  });
});

// Deux fichiers, mêmes données, formes différentes : en lignes, et en colonnes de mois avec l'établissement en nom de feuille.
const LONG: Feuilles = {
  Conso: [
    ["Consommation des ARV — 2026"],
    ["Etablissement", "Désignation", "DCI", "Mois", "Qté", "Unité"],
    ["CHU Oran", "Raltégravir 400 mg", "Raltégravir", "janvier 2026", 120, "cp"],
    ["CHU Oran", "Raltégravir 400 mg", "Raltégravir", "février 2026", 80, "cp"],
    ["CHU Oran", "Dolutégravir 50 mg", "Dolutégravir", "janvier 2026", 400, "cp"],
    ["Total", null, null, null, 600, null],
  ],
};
const LARGE: Feuilles = {
  "CHU Oran": [
    ["Produit", "Molécule", "Unité", "Janv-26", "Févr-26"],
    ["Raltégravir 400 mg", "Raltégravir", "Comprimé", 120, 80],
    ["Dolutégravir 50 mg", "Dolutégravir", "Comprimé", 400, null],
  ],
};

describe("§78 — deux fichiers hétérogènes deviennent le MÊME format canonique", () => {
  it("en lignes et en colonnes de mois", () => {
    const canon = (f: Feuilles) => analyserClasseur(f).feuilles.flatMap((x) => x.lignes).map((l) => ({
      etab: l.etablissementBrut, mol: l.molecule, debut: l.periode?.debut, q: l.quantite, u: l.unite,
    })).sort((a, b) => `${a.mol}${a.debut}`.localeCompare(`${b.mol}${b.debut}`));
    const a = canon(LONG), b = canon(LARGE);
    expect(a).toHaveLength(3);
    expect(a).toEqual(b);
    const large = analyserClasseur(LARGE).feuilles[0];
    expect(large.format).toBe("LARGE");
    expect(large.anomalies.join(" ")).toMatch(/lue comme l'établissement/);
  });
  it("chaque ligne garde sa feuille et sa ligne d'origine ; les totaux ne sont pas des lignes", () => {
    const l = analyserClasseur(LONG).feuilles[0].lignes;
    expect(l.map((x) => x.ligneSource)).toEqual([3, 4, 5]);
    expect(l[0].feuille).toBe("Conso");
  });
});

const ETABS = [{ id: "oran", name: "CHU Oran", isActive: true }, { id: "b1", name: "EPH Bordj", isActive: true }, { id: "b2", name: "EPH Bordj", isActive: true }];
const PRODUITS = [{ id: "ral", code: "PRD-2026-001", canonicalName: "Raltégravir 400 mg", identityKey: "x", dci: "RALTEGRAVIR", dosage: "400", dosageUnit: "mg", form: null, packaging: null, aliases: ["RAL 400MG"] }];

describe("§79 — résolution : rien d'inventé", () => {
  const r = resolveur(ETABS, PRODUITS, { etablissements: new Map(), produits: new Map() });
  const base = { feuille: "f", ligneSource: 2, periode: { debut: "2026-01-01", fin: "2026-01-31", libelle: "janvier 2026" }, molecule: null, dosage: null, presentation: null, quantiteSource: 10, uniteSource: "cp", quantite: 10, unite: "UNITE", valeur: null, devise: null, anomalies: [] };
  it("alias connu → sûr ; produit inconnu → à revoir, aucun rapprochement inventé", () => {
    expect(r({ ...base, etablissementBrut: "CHU ORAN", produitBrut: "RAL 400MG" })).toMatchObject({ institutionId: "oran", productId: "ral", statut: "OK" });
    const inconnu = r({ ...base, etablissementBrut: "CHU Oran", produitBrut: "X9-ZZZ" });
    expect(inconnu.statut).toBe("A_REVOIR");
    expect(inconnu.productId).toBeNull();
    expect(inconnu.raisons.join(" ")).toMatch(/aucun rapprochement inventé/);
  });
  it("rapprochement partiel = PROPOSITION à confirmer, pas une décision", () => {
    const p = r({ ...base, etablissementBrut: "CHU Oran", produitBrut: "Raltegravir" });
    expect(p.statut).toBe("A_REVOIR");
    expect(p.propositionProduit?.id).toBe("ral");
    expect(p.confiance).toBeLessThan(90);
  });
  it("homonymes d'établissement → à revoir ; molécule concurrente hors référentiel → compte pour le marché", () => {
    expect(r({ ...base, etablissementBrut: "EPH Bordj", produitBrut: "RAL 400MG" }).statut).toBe("A_REVOIR");
    expect(r({ ...base, etablissementBrut: "CHU Oran", produitBrut: null, molecule: "Dolutégravir" })).toMatchObject({ statut: "OK", productId: null });
  });
  it("la mémoire d'une confirmation s'applique au fichier suivant", () => {
    const m = resolveur(ETABS, PRODUITS, { etablissements: new Map([["hopital d oran", "oran"]]), produits: new Map([["r400", "ral"]]) });
    expect(m({ ...base, etablissementBrut: "Hôpital d'Oran", produitBrut: "R400" })).toMatchObject({ institutionId: "oran", productId: "ral", confiance: 99, statut: "OK" });
  });
});

describe("§31 — doublons et chevauchements", () => {
  it("même établissement, produit, période, quantité = même clé ; un mois dans un trimestre chevauche", () => {
    const a = { institutionId: "oran", etablissementBrut: "CHU Oran", productId: "ral", produitBrut: "x", molecule: null, periodeDebut: "2026-01-01", periodeFin: "2026-01-31", quantite: 120 };
    expect(cleDoublon(a)).toBe(cleDoublon({ ...a, produitBrut: "autre écriture" }));
    expect(cleDoublon(a)).not.toBe(cleDoublon({ ...a, quantite: 121 }));
    expect(chevauche({ debut: "2026-01-01", fin: "2026-03-31" }, { debut: "2026-02-01", fin: "2026-02-28" })).toBe(true);
    expect(chevauche({ debut: "2026-01-01", fin: "2026-01-31" }, { debut: "2026-01-01", fin: "2026-01-31" })).toBe(false);
  });
});

describe("§32-34 — affinité par établissement", () => {
  const L = (institutionId: string, productId: string | null, molecule: string | null, mois: string, quantite: number, unite = "UNITE"): LigneAffinite =>
    ({ institutionId, productId, molecule, periodeDebut: `${mois}-01`, periodeFin: `${mois}-28`, quantite, unite });
  const cfg = { productId: "ral", panier: { productIds: [], molecules: ["dolutégravir", "darunavir"] }, periode: "ROLLING_3M" as const };
  it("produit ÷ marché configuré, sur la fenêtre calée sur la dernière donnée", () => {
    const r = calculerAffinites([
      L("oran", "ral", "Raltégravir", "2026-03", 100), L("oran", null, "Dolutégravir", "2026-03", 300), L("oran", null, "Darunavir", "2026-02", 100),
      L("oran", "ral", "Raltégravir", "2025-06", 999), // hors fenêtre
      L("tlem", null, "Dolutégravir", "2026-03", 50),
    ], cfg);
    expect(r.fenetre).toMatchObject({ debut: "2026-01-01", fin: "2026-03-28" });
    const oran = r.parEtablissement.find((a) => a.institutionId === "oran")!;
    expect(oran.valeur).toBeCloseTo(0.2);
    expect(r.parEtablissement.find((a) => a.institutionId === "tlem")?.valeur).toBe(0);
  });
  it("les unités différentes ne s'additionnent pas — elles sont exclues et comptées", () => {
    const r = calculerAffinites([L("oran", "ral", null, "2026-03", 100), L("oran", null, "Dolutégravir", "2026-03", 300), L("oran", null, "Dolutégravir", "2026-03", 5, "BOITE")], cfg);
    expect(r.parEtablissement[0]).toMatchObject({ valeur: 0.25, exclues: 1 });
  });
  it("sans période personnalisée complète, pas de fenêtre — rien n'est supposé", () => {
    expect(fenetre({ ...cfg, periode: "PERSONNALISEE" }, "2026-03-31")).toBeNull();
  });
});
