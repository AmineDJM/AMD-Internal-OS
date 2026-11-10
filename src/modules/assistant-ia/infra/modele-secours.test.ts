import { afterEach, describe, expect, it } from "vitest";
import { modeleMimoSecours, modelesAssistant, pourMastra } from "./modele";

/**
 * LE SECOURS MiMo D'ADAM (Direction, 09/11/2026 : « utilise l'autre IA de la plateforme ») : le crédit OpenAI épuisé, le
 * tour repart chez MiMo. La liste des modèles le porte en second, marqué « secours » — `repondre.ts` ne l'essaie qu'après
 * un crédit épuisé.
 */
const ENV0 = { ...process.env };
afterEach(() => { process.env = { ...ENV0 }; });
const env = (e: Record<string, string>) => e as unknown as NodeJS.ProcessEnv;

describe("le secours MiMo d'Adam", () => {
  it("avec les deux clés : OpenAI d'abord, MiMo en secours — joint par Mastra à son adresse, comme OpenAI", () => {
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.mimo = "tp-test-mimo";
    process.env.MIMO_BASE_URL = "https://mimo.test/v1";
    delete process.env.ADAM_SECOURS;
    const ms = modelesAssistant();
    expect(ms.map((m) => [m.providerId, Boolean(m.secours)])).toEqual([["openai", false], ["mimo", true]]);
    expect(pourMastra(ms[1])).toEqual({ providerId: "mimo", modelId: ms[1].modelId, url: "https://mimo.test/v1", apiKey: "tp-test-mimo", api: "chat" });
  });

  it("sans clé MiMo, ou coupé : pas de secours ; sans clé OpenAI : rien (l'IA n'est pas configurée)", () => {
    expect(modeleMimoSecours(env({ OPENAI_API_KEY: "x" }))).toBeNull();
    expect(modeleMimoSecours(env({ mimo: "k", ADAM_SECOURS: "0" }))).toBeNull();
    expect(modeleMimoSecours(env({ mimo: "k", MIMO_MODEL: "mimo-autre" }))?.modelId).toBe("mimo-autre");
    delete process.env.OPENAI_API_KEY;
    process.env.mimo = "tp-test-mimo";
    expect(modelesAssistant()).toEqual([]);
  });
});
