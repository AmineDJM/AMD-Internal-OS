import { describe, it, expect, afterEach } from "vitest";
import { coutSessionVocale } from "./cost";
import { cumulerUsage, usageVide } from "@/components/chief/realtime-voice";

describe("le prix d'une session vocale", () => {
  afterEach(() => { delete process.env.ADAM_PRICE_REALTIME_AUDIO_IN; delete process.env.ADAM_MODEL_REALTIME; });

  it("texte et audio sont tarifés séparément, la part en cache au tarif réduit", () => {
    // 1 M de chaque : texte 4 + audio 32 + sortie texte 24 + sortie audio 64 = 124 $ ; cache texte 0,4 / audio 0,4.
    const plein = coutSessionVocale({ responses: 3, inputText: 1_000_000, inputAudio: 1_000_000, cachedText: 0, cachedAudio: 0, outputText: 1_000_000, outputAudio: 1_000_000 });
    expect(plein.costUsd).toBeCloseTo(124, 6);
    const enCache = coutSessionVocale({ responses: 3, inputText: 1_000_000, inputAudio: 1_000_000, cachedText: 500_000, cachedAudio: 500_000, outputText: 0, outputAudio: 0 });
    expect(enCache.costUsd).toBeCloseTo(0.5 * 4 + 0.5 * 0.4 + 0.5 * 32 + 0.5 * 0.4, 6);
  });

  it("le tarif audio se corrige par variable, et un modèle hors grille rend INCONNU", () => {
    process.env.ADAM_PRICE_REALTIME_AUDIO_IN = "10";
    expect(coutSessionVocale({ responses: 1, inputText: 0, inputAudio: 1_000_000, cachedText: 0, cachedAudio: 0, outputText: 0, outputAudio: 0 }).costUsd).toBeCloseTo(10, 6);
    process.env.ADAM_MODEL_REALTIME = "modele-vocal-inconnu";
    expect(coutSessionVocale({ responses: 1, inputText: 10, inputAudio: 0, cachedText: 0, cachedAudio: 0, outputText: 0, outputAudio: 0 }).costUsd).toBeNull();
  });

  it("les réponses s'additionnent depuis `response.done`, détail par détail — sans détail, tout est texte", () => {
    let t = usageVide();
    t = cumulerUsage(t, { input_tokens: 1_200, output_tokens: 300, input_token_details: { text_tokens: 1_000, audio_tokens: 200, cached_tokens: 640, cached_tokens_details: { text_tokens: 600, audio_tokens: 40 } }, output_token_details: { text_tokens: 50, audio_tokens: 250 } });
    t = cumulerUsage(t, { input_tokens: 100, output_tokens: 20 });
    t = cumulerUsage(t, undefined);
    expect(t).toEqual({ responses: 2, inputText: 1_100, inputAudio: 200, cachedText: 600, cachedAudio: 40, outputText: 70, outputAudio: 250 });
  });
});
