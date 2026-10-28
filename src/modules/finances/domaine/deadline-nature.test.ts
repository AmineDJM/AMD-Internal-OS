import { describe, it, expect } from "vitest";
import {
  deadlineNatureOf, deadlineNatureRank, deadlineNatureLabel,
  deferralNeedsReason, deferralWarning, DEADLINE_NATURE_OPTIONS,
} from "./deadline-nature";

describe("la nature d'une échéance de paiement", () => {
  it("reconnaît les trois natures et RIEN d'autre", () => {
    expect(deadlineNatureOf("FIXED")).toBe("FIXED");
    expect(deadlineNatureOf("IMPORTANT")).toBe("IMPORTANT");
    expect(deadlineNatureOf("MODERATE")).toBe("MODERATE");
  });

  it("une valeur inventée retombe sur « moyenne » — elle ne double personne dans la file", () => {
    // Le risque n'est pas théorique : un champ de formulaire trafiqué ou une colonne d'un
    // ancien import donnerait autrement un rang inconnu, et le tri en ferait n'importe quoi.
    expect(deadlineNatureOf("CRITIQUE")).toBe("MODERATE");
    expect(deadlineNatureOf(null)).toBe("MODERATE");
    expect(deadlineNatureOf(undefined)).toBe("MODERATE");
    expect(deadlineNatureOf("")).toBe("MODERATE");
  });

  it("le rang classe du plus lourd au plus souple", () => {
    expect(deadlineNatureRank("FIXED")).toBeLessThan(deadlineNatureRank("IMPORTANT"));
    expect(deadlineNatureRank("IMPORTANT")).toBeLessThan(deadlineNatureRank("MODERATE"));
    expect(deadlineNatureRank("n'importe quoi")).toBe(deadlineNatureRank("MODERATE"));
  });

  it("les libellés sont en français et disent la contrainte", () => {
    expect(deadlineNatureLabel("FIXED")).toMatch(/non négociable/i);
    expect(deadlineNatureLabel("IMPORTANT")).toBe("Importante");
    expect(deadlineNatureLabel("MODERATE")).toBe("Moyenne");
  });
});

describe("ce que la nature CHANGE — sinon elle ne serait qu'un décor", () => {
  it("seule l'échéance FIXE exige un motif pour être reportée", () => {
    expect(deferralNeedsReason("FIXED")).toBe(true);
    expect(deferralNeedsReason("IMPORTANT")).toBe(false);
    expect(deferralNeedsReason("MODERATE")).toBe(false);
    expect(deferralNeedsReason(null)).toBe(false);
  });

  it("l'avertissement se tait sur « moyenne » — un avertissement systématique cesse d'être lu", () => {
    expect(deferralWarning("MODERATE")).toBeNull();
    expect(deferralWarning(null)).toBeNull();
    expect(deferralWarning("IMPORTANT")).toMatch(/importante/i);
    expect(deferralWarning("FIXED")).toMatch(/non négociable/i);
  });
});

describe("les options du formulaire", () => {
  it("proposent les trois natures, la plus souple en premier (c'est le défaut)", () => {
    expect(DEADLINE_NATURE_OPTIONS.map((o) => o.value)).toEqual(["MODERATE", "IMPORTANT", "FIXED"]);
    for (const o of DEADLINE_NATURE_OPTIONS) expect(o.label.length).toBeGreaterThan(0);
  });
});
