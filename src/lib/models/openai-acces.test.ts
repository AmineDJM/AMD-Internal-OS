import { describe, expect, it } from "vitest";
import { cleOpenAI, urlOpenAI } from "./openai-acces";

describe("l'accès à OpenAI — une seule lecture de la clé et de l'adresse", () => {
  it("sans OPENAI_BASE_URL : l'API publique, toujours sous /v1", () => {
    expect(urlOpenAI("/chat/completions", {})).toBe("https://api.openai.com/v1/chat/completions");
  });

  it("les DEUX graphies de OPENAI_BASE_URL donnent la même adresse — avec ou sans /v1, barre finale comprise", () => {
    for (const base of ["https://ia.test", "https://ia.test/", "https://ia.test/v1", "https://ia.test/v1/"]) {
      expect(urlOpenAI("/audio/transcriptions", { OPENAI_BASE_URL: base })).toBe("https://ia.test/v1/audio/transcriptions");
    }
  });

  it("la clé est rognée ; absente ou blanche, elle vaut \"\"", () => {
    expect(cleOpenAI({ OPENAI_API_KEY: "  sk-x \n" })).toBe("sk-x");
    expect(cleOpenAI({ OPENAI_API_KEY: "   " })).toBe("");
    expect(cleOpenAI({})).toBe("");
  });
});
