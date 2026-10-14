import { describe, expect, it } from "vitest";
import type { PlanIntegration } from "./integration-2026";
import {
  appliquerDecisionsLocales, doublonsProbables, mentionDoublon, preselection, type AbsenteRecalculable, type ApercuRecalculable,
} from "./integration-absentes";

/**
 * « ABSENTES DU FICHIER » — garder / sortir AVANT la validation, sans relire le fichier (tests purs) : le recalcul de
 * l'aperçu à l'écran, et la sélection pré-cochée des doublons probables d'une ligne du fichier.
 */

const corr = {
  categories: { Sponsoring: { id: "spo" }, "Événements": { id: "evt" }, "Matériel promotionnel": { id: "promo" } },
  sousCategories: { "Réunions": { id: "reu" }, Symposium: { id: "sym" } },
};
const lignesEnv = [{ id: "spo", parentId: null }, { id: "evt", parentId: null }, { id: "reu", parentId: "evt" }, { id: "sym", parentId: "evt" }, { id: "promo", parentId: null }];

type PosteMin = { libelle: string; montant: number; ligne: number; categorie: string; sousCategorie: string | null };
const demande = (ligne: number, libelle: string, postes: Omit<PosteMin, "ligne">[]) => ({ cle: `D-L${ligne}`, ligne, libelle, postes: postes.map((p) => ({ ...p, ligne })) });
const plan = (...demandes: ReturnType<typeof demande>[]) => ({ demandes } as unknown as Pick<PlanIntegration, "demandes">);
const absente = (o: Partial<AbsenteRecalculable> & { cle: string }): AbsenteRecalculable => ({ libelle: "", montant: 0, categoryId: null, effet: "CONSOMME", decision: null, ...o });

describe("les doublons probables d'une ligne du fichier", () => {
  const p = plan(
    demande(19, "Société Algérienne d'Infectiologie — webinaire", [{ libelle: "Sponsoring", montant: 5_355_000, categorie: "Sponsoring", sousCategorie: null }]),
    demande(12, "Réunion régionale de Constantine", [{ libelle: "Restauration", montant: 82_000_000, categorie: "Événements", sousCategorie: "Réunions" }]),
    demande(37, "Kakémonos congrès SAI", [{ libelle: "Impression kakémonos", montant: 10_000_000, categorie: "Matériel promotionnel", sousCategorie: null }]),
  );

  it("même libellé normalisé (accents, casse, ponctuation) → doublon de la ligne, quelle que soit la catégorie", () => {
    const d = doublonsProbables([absente({ cle: "LIGNE:a", libelle: "societe algerienne d’infectiologie - WEBINAIRE", montant: 53_350, categoryId: "spo" })], p, corr, lignesEnv);
    expect(d.get("LIGNE:a")).toEqual({ ligne: 19, raison: "LIBELLE" });
    expect(mentionDoublon(d.get("LIGNE:a")!)).toContain("doublon probable de la ligne L19");
  });

  it("même montant à ±1 DZD dans la même catégorie (ou sa catégorie de tête) → doublon ; ailleurs, non", () => {
    const d = doublonsProbables([
      absente({ cle: "TX:1", libelle: "Billet orateur", montant: 820_000.6, categoryId: "evt" }), // tête de « Réunions »
      absente({ cle: "TX:2", libelle: "Kakémonos hors fichier", montant: 100_001, categoryId: "promo" }), // 1 DZD d'écart
      absente({ cle: "TX:3", libelle: "Autre", montant: 100_000, categoryId: "spo" }), // bon montant, mauvaise catégorie
      absente({ cle: "TX:4", libelle: "Autre encore", montant: 100_002, categoryId: "promo" }), // 2 DZD d'écart
    ], p, corr, lignesEnv);
    expect(d.get("TX:1")).toEqual({ ligne: 12, raison: "MONTANT" });
    expect(d.get("TX:2")).toEqual({ ligne: 37, raison: "MONTANT" });
    expect(d.has("TX:3")).toBe(false);
    expect(d.has("TX:4")).toBe(false);
  });

  it("un libellé générique (le nom d'une catégorie) ne fait pas un doublon ; une ligne du fichier n'a qu'un double", () => {
    const d = doublonsProbables([
      absente({ cle: "LIGNE:g", libelle: "Sponsoring", montant: 1, categoryId: "spo" }),
      absente({ cle: "LIGNE:x", libelle: "Kakémonos A", montant: 100_000, categoryId: "promo" }),
      absente({ cle: "LIGNE:y", libelle: "Kakémonos B", montant: 100_000, categoryId: "promo" }),
    ], p, corr, lignesEnv);
    expect(d.has("LIGNE:g")).toBe(false);
    expect(d.get("LIGNE:x")?.ligne).toBe(37);
    expect(d.has("LIGNE:y")).toBe(false);
  });

  it("la sélection proposée pré-règle « En sortir » sans jamais écraser un choix de la personne", () => {
    const d = new Map([["A", { ligne: 5, raison: "LIBELLE" as const }], ["B", { ligne: 6, raison: "MONTANT" as const }], ["C", { ligne: 7, raison: "MONTANT" as const }]]);
    expect(preselection({ B: "GARDER" }, d, new Set(["C"]))).toEqual({ A: "SORTIR", B: "GARDER" });
  });
});

describe("l'aperçu recalculé à l'écran", () => {
  const apercu: ApercuRecalculable = {
    lignes: [
      { id: "promo", parentId: null, apres: { consomme: 3_155_675, engage: 0 } },
      { id: "spo", parentId: null, apres: { consomme: 8_063_208.5, engage: 50_000 } },
    ],
    totalApres: { consomme: 11_218_883.5, engage: 50_000 },
    absentes: [
      absente({ cle: "LIGNE:k", montant: 100_000, categoryId: "promo" }),
      absente({ cle: "TX:m", montant: 20_000, categoryId: "spo" }),
      absente({ cle: "ORDRE:o", montant: 50_000, categoryId: "spo", effet: "ENGAGE" }),
      absente({ cle: "TX:sans", montant: 999, categoryId: null }),
    ],
  };

  it("sortir retire le montant du consommé (ou de l'engagé) de SA catégorie ; garder le rend ; l'avant ne bouge pas", () => {
    const v = appliquerDecisionsLocales(apercu, { "LIGNE:k": "SORTIR", "ORDRE:o": "SORTIR", "TX:m": "GARDER", "TX:sans": "SORTIR" });
    expect(v.lignes.find((l) => l.id === "promo")!.apres.consomme).toBe(3_055_675);
    expect(v.lignes.find((l) => l.id === "spo")!.apres).toEqual({ consomme: 8_063_208.5, engage: 0 });
    expect(v.totalApres).toEqual({ consomme: 11_118_883.5, engage: 0 });
    expect(v.absentes.find((a) => a.cle === "LIGNE:k")!.decision).toBe("SORTIR");
    // Revenir sur le choix rend exactement l'aperçu du serveur.
    const r = appliquerDecisionsLocales(v, { "LIGNE:k": "GARDER", "ORDRE:o": "GARDER" });
    expect(r.lignes.find((l) => l.id === "promo")!.apres.consomme).toBe(3_155_675);
    expect(r.totalApres).toEqual(apercu.totalApres);
  });

  it("un aperçu calculé avec un élément déjà sorti le rend quand on le garde", () => {
    const sorti: ApercuRecalculable = { ...apercu, lignes: [{ id: "promo", parentId: null, apres: { consomme: 3_055_675, engage: 0 } }], totalApres: { consomme: 3_055_675, engage: 0 }, absentes: [absente({ cle: "LIGNE:k", montant: 100_000, categoryId: "promo", decision: "SORTIR" })] };
    expect(appliquerDecisionsLocales(sorti, { "LIGNE:k": "GARDER" }).totalApres.consomme).toBe(3_155_675);
    expect(appliquerDecisionsLocales(sorti, {}).totalApres).toEqual(sorti.totalApres);
  });
});
