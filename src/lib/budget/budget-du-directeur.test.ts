import { describe, expect, it } from "vitest";
import { cleDuBudget, dirigeLeBudget, domaineDuDepartement, refusReallocationEntreEnveloppes, refusTotalBudget, type EnveloppeDeBudget } from "./budget-du-directeur";

const env = (o: Partial<EnveloppeDeBudget> & { id: string }): EnveloppeDeBudget =>
  ({ domaine: "OPERATIONS", companyId: "A", periodStart: "2026-01-01T00:00:00Z", departementCampagneId: null, ...o });

describe("le budget d'un directeur — réallouer librement, le total intouchable (24/11/2026)", () => {
  it("le pôle d'un département : celui de la campagne, sinon celui que son nom dit", () => {
    expect(domaineDuDepartement({ name: "Direction des opérations", code: "OPS" })).toBe("OPERATIONS");
    expect(domaineDuDepartement({ name: "Direction commerciale", code: "COM" }, "GENERAL")).toBe("GENERAL");
  });

  it("un même budget = même pôle, même société, même exercice ; une enveloppe générale suit le département de sa campagne", () => {
    expect(cleDuBudget(env({ id: "1" }))).toBe(cleDuBudget(env({ id: "2" })));
    expect(cleDuBudget(env({ id: "1" }))).not.toBe(cleDuBudget(env({ id: "3", companyId: "B" })));
    expect(cleDuBudget(env({ id: "1" }))).not.toBe(cleDuBudget(env({ id: "4", periodStart: "2027-01-01T00:00:00Z" })));
    expect(cleDuBudget(env({ id: "g1", domaine: "GENERAL", departementCampagneId: "fin" }))).toBe(cleDuBudget(env({ id: "g2", domaine: "GENERAL", departementCampagneId: "fin" })));
    expect(cleDuBudget(env({ id: "g3", domaine: "GENERAL" }))).toBe("ENV:g3");
  });

  it("le directeur tient le budget de SON pôle dans SA société seulement", () => {
    const ops = [{ id: "d", companyId: "A", domaine: "OPERATIONS" }];
    expect(dirigeLeBudget(env({ id: "1" }), ops)).toBe(true);
    expect(dirigeLeBudget(env({ id: "1", companyId: "B" }), ops)).toBe(false);
    expect(dirigeLeBudget(env({ id: "1", domaine: "MARKETING" }), ops)).toBe(false);
    expect(dirigeLeBudget(env({ id: "g", domaine: "GENERAL", departementCampagneId: "d" }), ops)).toBe(true);
  });

  it("entre deux enveloppes : même budget exigé, puis le directeur ou le Super Admin — ni plafond ni validation", () => {
    const a = env({ id: "1" }), b = env({ id: "2" }), autre = env({ id: "3", companyId: "B" });
    const base = { gereLaSource: true, estDirecteur: false, estSuperAdmin: false };
    expect(refusReallocationEntreEnveloppes({ ...base, source: a, cible: a })).toBeNull();
    expect(refusReallocationEntreEnveloppes({ ...base, gereLaSource: false, source: a, cible: a })).toMatch(/pas confié/);
    expect(refusReallocationEntreEnveloppes({ ...base, source: a, cible: b })).toMatch(/directeur/);
    expect(refusReallocationEntreEnveloppes({ ...base, estDirecteur: true, source: a, cible: b })).toBeNull();
    expect(refusReallocationEntreEnveloppes({ ...base, estDirecteur: true, source: a, cible: autre })).toMatch(/même budget/);
    expect(refusReallocationEntreEnveloppes({ ...base, estSuperAdmin: true, source: a, cible: autre })).toMatch(/même budget/);
  });

  it("le total relu après l'écriture doit égaler celui d'avant", () => {
    expect(refusTotalBudget(1_500_000, 1_500_000)).toBeNull();
    expect(refusTotalBudget(1_500_000, 1_400_000)).toMatch(/total/);
  });
});
