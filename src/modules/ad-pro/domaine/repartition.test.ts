import { describe, it, expect } from "vitest";
import { lireRepartition, NATURES_REPARTITION, LIGNES_MAX } from "./repartition";
import { ITEM_KIND_LABELS } from "./postes";

/**
 * LA RÉPARTITION D'UN SPONSORING INDIRECT (§118.175) — lue telle que le formulaire l'envoie.
 *
 * L'exemple de la Direction est le premier cas : 1 000 000 DZD = 400 000 d'imprimerie + 600 000
 * d'hôtellerie. Les autres nomment chacun la faute qu'ils empêchent.
 */
const json = (x: unknown) => JSON.stringify(x);

describe("répartir un sponsoring indirect par nature", () => {
  it("l'exemple de la Direction : 400 000 d'imprimerie + 600 000 d'hôtellerie = 1 000 000", () => {
    const r = lireRepartition(json([
      { kind: "PRINTING", montant: "400 000", precision: "Affiches et programmes" },
      { kind: "ACCOMMODATION", montant: 600000, payeA: "Hôtel Ibis Sétif" },
    ]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.total).toBe(1_000_000);
    expect(r.lignes.map((l) => l.kind)).toEqual(["PRINTING", "ACCOMMODATION"]);
    expect(r.lignes[1]?.payeA).toBe("Hôtel Ibis Sétif");
  });

  it("tout ce qui manque se dit en UNE fois, ligne par ligne (§118.18)", () => {
    const r = lireRepartition(json([
      { kind: "", montant: "200000" },
      { kind: "TICKETING", montant: "" },
      { kind: "CATERING", montant: "-5" },
    ]));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/ligne 1 : choisissez la nature/);
    expect(r.error).toMatch(/ligne 2 : le montant est manquant/);
    expect(r.error).toMatch(/ligne 3 : le montant doit être positif/);
  });

  it("une ligne ouverte puis laissée vide est écartée, pas reprochée", () => {
    const r = lireRepartition(json([{ kind: "PRINTING", montant: "1" }, { kind: "", montant: "", precision: " ", payeA: "" }]));
    expect(r.ok && r.lignes.length).toBe(1);
  });

  it("aucune nature : le refus montre l'exemple", () => {
    const r = lireRepartition(json([]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/imprimerie 400 000/);
  });

  it("ni sponsoring direct, ni indirect, ni matériel du stock, ni matériel promotionnel : ce ne sont pas des natures d'une prise en charge", () => {
    for (const k of ["ASSOCIATION_SUPPORT", "INDIRECT_SUPPORT", "STOCK_MATERIAL", "PROMO_MATERIAL"]) {
      expect(NATURES_REPARTITION as readonly string[], k).not.toContain(k);
      const r = lireRepartition(json([{ kind: k, montant: "10" }]));
      expect(r.ok, k).toBe(false);
    }
  });

  it("chaque nature proposée a son libellé — une nature sans libellé serait un choix illisible", () => {
    for (const k of NATURES_REPARTITION) expect(ITEM_KIND_LABELS[k], k).toBeTruthy();
    expect(ITEM_KIND_LABELS.PRINTING).toBe("Imprimerie");
  });

  it("une limite OPÉRATIONNELLE, qui accepte son propre chiffre (§118.2)", () => {
    const lignes = Array.from({ length: LIGNES_MAX }, () => ({ kind: "OTHER", montant: "1" }));
    expect(lireRepartition(json(lignes)).ok).toBe(true);
    expect(lireRepartition(json([...lignes, { kind: "OTHER", montant: "1" }])).ok).toBe(false);
  });

  it("un envoi illisible est refusé — jamais lu comme une répartition vide", () => {
    expect(lireRepartition("{pas du json").ok).toBe(false);
    expect(lireRepartition(json({ kind: "PRINTING" })).ok).toBe(false);
  });

  it("les centimes ne fabriquent pas un écart fantôme", () => {
    const r = lireRepartition(json([{ kind: "PRINTING", montant: "0,1" }, { kind: "OTHER", montant: "0,2" }]));
    expect(r.ok && r.total).toBe(0.3);
  });
});
