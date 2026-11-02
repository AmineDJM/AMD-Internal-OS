import { describe, expect, it } from "vitest";
import { messagePartiel } from "./partiel";

describe("messagePartiel — le texte qui s'écrit, tiré d'un JSON incomplet", () => {
  it("rend la valeur de « message » lue jusqu'ici, sans le JSON autour", () => {
    expect(messagePartiel('{"message": "Vous avez 3 dem')).toBe("Vous avez 3 dem");
    expect(messagePartiel('{"message": "Fini.", "components": [{"type"')).toBe("Fini.");
  });
  it("décode les échappements, et attend un échappement coupé en deux", () => {
    expect(messagePartiel('{"message": "Ligne 1\\nLigne \\"2\\" \\u00e9')).toBe('Ligne 1\nLigne "2" é');
    expect(messagePartiel('{"message": "Prix \\')).toBe("Prix ");
    expect(messagePartiel('{"message": "a\\u00')).toBe("a");
  });
  it("rien tant que « message » n'a pas commencé ; un texte libre est rendu tel quel", () => {
    expect(messagePartiel('{"compo')).toBe("");
    expect(messagePartiel("```json\n{\"message\": \"Ok")).toBe("Ok");
    expect(messagePartiel("Bonjour, voici")).toBe("Bonjour, voici");
  });
});
