import { describe, expect, it } from "vitest";
import { MODELE_RAPIDE_DEFAUT, MODELE_STANDARD_DEFAUT, modelePourRole, roleDuTour } from "./modeles-roles";

/** LA PASSERELLE DE RÔLES (J4) : un fournisseur, trois rôles, l'environnement les règle. */
describe("modèle par rôle (J4)", () => {
  it("défauts : standard à effort bas, raisonnement plus haut, rapide sur le modèle léger", () => {
    expect(modelePourRole("standard", {})).toEqual({ role: "standard", modelId: MODELE_STANDARD_DEFAUT, effort: "low" });
    expect(modelePourRole("raisonnement", {})).toMatchObject({ modelId: MODELE_STANDARD_DEFAUT, effort: "medium" });
    expect(modelePourRole("rapide", {})).toMatchObject({ modelId: MODELE_RAPIDE_DEFAUT });
  });

  it("l'environnement change modèle et effort ; un effort inconnu retombe sur le défaut", () => {
    expect(modelePourRole("standard", { ASSISTANT_IA_MODEL: "gpt-x", ASSISTANT_IA_EFFORT: "none" })).toMatchObject({ modelId: "gpt-x", effort: "none" });
    expect(modelePourRole("standard", { ASSISTANT_IA_EFFORT: "turbo" }).effort).toBe("low");
    expect(modelePourRole("rapide", { ASSISTANT_IA_MODEL_RAPIDE: "gpt-r" }).modelId).toBe("gpt-r");
  });

  it("effort adaptatif : une question est standard, une analyse ou un travail raisonne", () => {
    expect(roleDuTour({ texte: "Qui est Assia ?" })).toBe("standard");
    expect(roleDuTour({ texte: "Analyse toutes les demandes Ad & Pro de l'année" })).toBe("raisonnement");
    expect(roleDuTour({ texte: "Compare ces deux devis", pieces: 2 })).toBe("raisonnement");
    expect(roleDuTour({ texte: "Bonjour", travail: true })).toBe("raisonnement");
  });
});
