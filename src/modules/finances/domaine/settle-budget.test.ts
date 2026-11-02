import { describe, it, expect } from "vitest";
import { budgetGate, needsBudgetChoice, BUDGET_CLASSIFY_PROMPT } from "./settle-budget";

describe("on classe avant de payer", () => {
  it("LE CHOIX FAIT AU RÈGLEMENT L'EMPORTE — c'est le plus récent et le plus informé", () => {
    const r = budgetGate({ chosen: "c-choisie", onOrder: "c-direction", auto: "c-auto", availableCount: 5 });
    expect(r.ok).toBe(true);
    expect(r.categoryId).toBe("c-choisie");
  });

  it("puis celui de la Direction, posé à la validation", () => {
    expect(budgetGate({ onOrder: "c-direction", auto: "c-auto", availableCount: 5 }).categoryId).toBe("c-direction");
  });

  it("puis l'attribution automatique, qui ne fait que deviner d'après le module", () => {
    expect(budgetGate({ auto: "c-auto", availableCount: 5 }).categoryId).toBe("c-auto");
  });

  it("une valeur VIDE n'est pas un choix — elle laisse passer la suivante", () => {
    expect(budgetGate({ chosen: "   ", onOrder: "c-direction", availableCount: 5 }).categoryId).toBe("c-direction");
    expect(budgetGate({ chosen: null, onOrder: "", auto: "c-auto", availableCount: 5 }).categoryId).toBe("c-auto");
  });
});

describe("quand rien ne répond", () => {
  it("LE RÈGLEMENT S'ARRÊTE, ET LE REFUS DIT QUOI FAIRE", () => {
    // Sans cela, l'écriture naît sans budget et rejoint les « à imputer » — une liste que
    // personne ne reprend, et l'enveloppe affiche une consommation fausse l'année suivante.
    const r = budgetGate({ availableCount: 12 });
    expect(r.ok).toBe(false);
    expect(r.categoryId).toBeNull();
    expect(r.reason).toBe(BUDGET_CLASSIFY_PROMPT);
    expect(r.reason).toMatch(/avant de la régler/);
    expect(needsBudgetChoice({ availableCount: 12 })).toBe(true);
  });

  it("MAIS UNE LISTE VIDE N'EST PAS UNE RÈGLE, C'EST UNE IMPASSE — on paie, à imputer", () => {
    // Une installation qui n'a pas encore ouvert ses enveloppes doit pouvoir payer ses factures.
    const r = budgetGate({ availableCount: 0 });
    expect(r.ok).toBe(true);
    expect(r.categoryId).toBeNull();
    expect(needsBudgetChoice({ availableCount: 0 })).toBe(false);
  });

  it("l'écran et le serveur posent LA MÊME question", () => {
    const cas = { onOrder: null, auto: null, availableCount: 3 };
    expect(needsBudgetChoice(cas)).toBe(!budgetGate(cas).ok);
    const classe = { auto: "c-auto", availableCount: 3 };
    expect(needsBudgetChoice(classe)).toBe(false);
  });
});
