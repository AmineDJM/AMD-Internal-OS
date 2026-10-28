import { describe, expect, it } from "vitest";
import { decisionRattachement, phraseRattachement } from "./rattachement-paie";
import { masseMensuelleParEntite } from "./payroll-mass";

const nom = (id: string) => ({ A: "Adventum", B: "Pharmagène" } as Record<string, string>)[id] ?? id;

describe("decisionRattachement — une paie partie ne change pas d'entité en silence", () => {
  it("rien de parti : on rattache", () => {
    expect(decisionRattachement([{ id: "s", nom: "Amel", salairesPartis: [] }], { id: "A", nom: "Adventum" }, nom))
      .toEqual({ ok: true, ancienCircuit: 0 });
  });

  it("parti par l'entité CIBLE : rien ne bouge en réalité", () => {
    const d = decisionRattachement(
      [{ id: "s", nom: "Amel", salairesPartis: [{ year: 2026, month: 3, companyId: "A", reference: "OD-1" }] }],
      { id: "A", nom: "Adventum" }, nom,
    );
    expect(d.ok).toBe(true);
  });

  it("parti au nom d'une AUTRE entité : refus qui nomme le salarié, le mois, l'entité et la pièce", () => {
    const d = decisionRattachement(
      [
        { id: "s1", nom: "Amel", salairesPartis: [] },
        { id: "s2", nom: "Karim", salairesPartis: [{ year: 2026, month: 4, companyId: "B", reference: "OD-2026-044" }] },
      ],
      { id: "A", nom: "Adventum" }, nom,
    );
    expect(d.ok).toBe(false);
    if (!d.ok) {
      expect(d.refus).toMatch(/Rien n'est rattaché/);
      expect(d.refus).toContain("Karim — paie de avril 2026 partie au nom de Pharmagène (OD-2026-044)");
      expect(d.refus).not.toContain("Amel");
    }
  });

  it("versé par l'ancien circuit sans entité connue : on rattache, et on le compte pour le dire", () => {
    const d = decisionRattachement(
      [{ id: "s", nom: "Amel", salairesPartis: [{ year: 2026, month: 1, companyId: null, reference: null }, { year: 2026, month: 2, companyId: null, reference: null }] }],
      { id: "A", nom: "Adventum" }, nom,
    );
    expect(d).toEqual({ ok: true, ancienCircuit: 2 });
  });
});

describe("phraseRattachement", () => {
  it("dit qui a bougé, ce qui pourra partir, l'ancien circuit et ce qui a été rattaché entre-temps", () => {
    const p = phraseRattachement({ noms: ["Amel", "Karim"], cible: "Adventum", saisis: 1, ancienCircuit: 3, dejaRattaches: ["Sofia"] });
    expect(p).toMatch(/^2 salariés rattachés à Adventum : Amel, Karim\./);
    expect(p).toMatch(/1 salaire saisi pourra partir au centre/);
    expect(p).toMatch(/3 salaires déjà versés par l'ancien circuit/);
    expect(p).toContain("Déjà rattaché entre-temps, non modifié : Sofia.");
  });
});

describe("masseMensuelleParEntite — mensuelle ET annuelle", () => {
  it("par entité et par mois ; le total est la somme des mois ; un mois illisible est écarté", () => {
    const m = masseMensuelleParEntite([
      { companyId: "A", month: 1, cost: 150_000, net: 100_000 },
      { companyId: "A", month: 1, cost: 0.1, net: 0.2 },
      { companyId: "A", month: 3, cost: 160_000, net: 110_000 },
      { companyId: null, month: 2, cost: 90_000, net: 60_000 },
      { companyId: "A", month: 13, cost: 1, net: 1 },
    ]);
    const a = m.get("A")!;
    expect(a.mois[0]).toEqual({ cost: 150_000.1, net: 100_000.2 });
    expect(a.mois[1]).toEqual({ cost: 0, net: 0 });
    expect(a.mois[2]).toEqual({ cost: 160_000, net: 110_000 });
    expect(a.total).toEqual({ cost: 310_000.1, net: 210_000.2 });
    expect(m.get(null)!.total).toEqual({ cost: 90_000, net: 60_000 });
  });
});
