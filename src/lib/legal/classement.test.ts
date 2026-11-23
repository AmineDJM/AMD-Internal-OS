import { describe, expect, it } from "vitest";
import { cheminDeClassement, cheminLisible, natureDuMot, nomDeDossier } from "./classement";

describe("le classement des pièces Ad & Pro dans Legal (recette du 23/11/2026)", () => {
  it("range une pièce d'événement sous Événements › année › événement", () => {
    expect(cheminDeClassement("EVENT", 2026, "TEST recette 21/11 — Journée régionale de cardiologie"))
      .toEqual(["Événements", "2026", "TEST recette 21/11 — Journée régionale de cardiologie"]);
    expect(cheminDeClassement("SPONSORING", 2026, "SP-2026-014")?.[0]).toBe("Sponsorings");
    expect(cheminDeClassement("INCONNU", 2026, "x")).toBeNull();
  });

  it("un nom de dossier reste propre et borné", () => {
    expect(nomDeDossier("  Journée\n de   cardiologie ")).toBe("Journée de cardiologie");
    expect(nomDeDossier("x".repeat(200))).toHaveLength(120);
    expect(nomDeDossier("   ")).toBe("Sans nom");
  });

  it("« BC », « facture », « devis » désignent la nature — ils ne sont pas écrits dans le titre", () => {
    expect(natureDuMot("BC")).toBe("PURCHASE_ORDER");
    expect(natureDuMot("factures")).toBe("INVOICE");
    expect(natureDuMot("Devis")).toBe("QUOTE");
    expect(natureDuMot("cardiologie")).toBeNull();
  });

  it("le chemin se lit d'un trait", () => {
    expect(cheminLisible(["Événements", "2026", "Journée"])).toBe("Événements › 2026 › Journée");
  });
});
