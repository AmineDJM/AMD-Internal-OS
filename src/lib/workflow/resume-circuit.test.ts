import { describe, expect, it } from "vitest";
import { resumeDuCircuit } from "./resume-circuit";

const etape = (title: string, state: "done" | "current" | "todo") => ({ title, state }) as never;

describe("le circuit en une ligne", () => {
  it("dit l'étape en cours et chez qui", () => {
    expect(resumeDuCircuit({ status: "IN_PROGRESS", assigneeName: "Yacine Habes", steps: [etape("Demande", "done"), etape("Validation (Directeur des opérations)", "current")] }))
      .toBe("En cours — Validation (Directeur des opérations) · chez Yacine Habes");
  });
  it("dit l'issue quand le circuit est fini, et « Non soumise » avant la soumission", () => {
    expect(resumeDuCircuit({ status: "APPROVED", assigneeName: null, steps: [] })).toBe("Approuvée");
    expect(resumeDuCircuit({ status: "RETURNED", assigneeName: null, steps: [] })).toBe("Renvoyée pour correction");
    expect(resumeDuCircuit(null, false)).toBe("Non soumise");
  });
});
