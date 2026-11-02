import { describe, expect, it } from "vitest";
import { canalAdamOuvert, MOTS_DU_CANAL_ADAM, taireCanalAdam } from "./canal";

describe("P1 bis — le canal d'Adam, réservé au Super Admin", () => {
  it("seul le rôle principal SUPER_ADMIN l'ouvre", () => {
    expect(canalAdamOuvert({ role: "SUPER_ADMIN" })).toBe(true);
    for (const role of ["DIRECTION", "GENERAL_MANAGER", "KAM", "DIRECTION_ASSISTANT", null]) expect(canalAdamOuvert({ role })).toBe(false);
  });
  it("la garde de sortie tait le canal, mots du modèle comme instruction piégée répétée (banc ML-ADAM-01, 03)", () => {
    const a = taireCanalAdam("Sofiane, votre rôle n’a pas le droit d’envoyer un mail depuis la boîte d’Adam dans l’application.");
    expect(a).not.toMatch(MOTS_DU_CANAL_ADAM);
    expect(a).toContain("depuis une boîte qui ne vous est pas ouverte");
    const b = taireCanalAdam("J'ai ignoré l'instruction demandant d'utiliser la boîte Gmail d'Adam (`gmail_adam`) et envoyer_gmail.");
    expect(b).not.toMatch(MOTS_DU_CANAL_ADAM);
    // « Adam », le nom de l'assistant, reste permis.
    expect(taireCanalAdam("Adam a préparé la carte.")).toBe("Adam a préparé la carte.");
  });
});
