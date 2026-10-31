import { describe, expect, it } from "vitest";
import {
  coutDeLAppel, dollarsArrondis, dollarsExacts, enMicro, facturer, GRILLE_TARIFS, picoEnDollars, sommeDollars, tarifDuModele, usageTranscription,
} from "./tarifs";

/**
 * LA GRILLE ET LE CALCUL DU COÛT, TYPE DE JETON PAR TYPE DE JETON (lot K8, décision 0035).
 * Chaque attendu est calculé À LA MAIN depuis la grille publique relevée le 31/10/2026.
 */
describe("la grille", () => {
  it("chaque prix est un décimal exact, et chaque ligne dit sa source et sa date", () => {
    for (const [modele, t] of Object.entries(GRILLE_TARIFS)) {
      for (const k of ["entree", "entreeCache", "sortie", "audioEntree", "audioEntreeCache", "audioSortie", "imageEntree", "imageEntreeCache", "imageSortie", "parMinute", "parSeconde", "parPage"] as const) {
        if (t[k] != null) expect(() => enMicro(t[k] as string), `${modele}.${k}`).not.toThrow();
      }
      expect(t.source, modele).toBeTruthy();
      expect(t.verifieLe, modele).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("gpt-6.1-terra est à 1 $ / 0,05 $ / 5 $ — pas au tarif de gpt-5.6-terra (2 / 0,2 / 12) qu'appliquait l'ancien défaut", () => {
    expect(tarifDuModele("gpt-6.1-terra")).toMatchObject({ entree: "1", entreeCache: "0.05", sortie: "5" });
    expect(tarifDuModele("gpt-5.6-terra")).toMatchObject({ entree: "2", entreeCache: "0.2", sortie: "12" });
  });

  it("un suffixe de date retombe sur sa base ; un nom inconnu ou voisin n'en emprunte AUCUN", () => {
    expect(tarifDuModele("gpt-5.6-terra-2026-03-01")).toBe(GRILLE_TARIFS["gpt-5.6-terra"]);
    expect(tarifDuModele("gpt-5.6-terra-hors-tour")).toBeNull();
    expect(tarifDuModele("gpt-x")).toBeNull();
    expect(tarifDuModele("mistral-ocr-latest")).toBeNull();
  });
});

describe("le calcul, en entiers", () => {
  it("un seul jeton d'entrée de gpt-6.1-terra vaut 0,000001 $ ; un million, 1 $", () => {
    expect(coutDeLAppel("gpt-6.1-terra", { entree: 1, sortie: 0 })).toBe("0.000001");
    expect(coutDeLAppel("gpt-6.1-terra", { entree: 1_000_000, sortie: 0 })).toBe("1.000000");
  });

  it("le cache est une PART de l'entrée, facturée au tarif réduit", () => {
    // 10 000 entrée dont 8 000 en cache, 500 sortie : 2 000 × 1 + 8 000 × 0,05 + 500 × 5 (par million)
    const f = facturer({ entree: 10_000, entreeCache: 8_000, sortie: 500 }, tarifDuModele("gpt-6.1-terra"));
    expect(f.postes).toEqual({ texteEntree: "0.002000", texteEntreeCache: "0.000400", texteSortie: "0.002500" });
    expect(f.usd).toBe("0.004900");
  });

  it("le raisonnement est DÉJÀ dans la sortie : il ne s'ajoute pas une seconde fois", () => {
    const sans = coutDeLAppel("gpt-5.6-terra", { entree: 0, sortie: 1_000 });
    const avec = coutDeLAppel("gpt-5.6-terra", { entree: 0, sortie: 1_000, raisonnement: 800 });
    expect(avec).toBe(sans);
    expect(avec).toBe("0.012000");
  });

  it("la voix temps réel : texte, audio et cache audio, chacun à son tarif", () => {
    // gpt-realtime-2.1 : texte 4 / 24, audio 32 / 64, cache 0,40.
    const f = facturer({ entree: 3_000, audioEntree: 2_000, audioEntreeCache: 500, entreeCache: 700, sortie: 1_500, audioSortie: 1_000 }, tarifDuModele("gpt-realtime-2.1"));
    // texte : 1 000 en entrée dont 200 en cache ; audio : 2 000 dont 500 en cache ; sortie : 500 texte + 1 000 audio.
    expect(f.postes).toEqual({
      texteEntree: "0.003200", texteEntreeCache: "0.000080", texteSortie: "0.012000",
      audioEntree: "0.048000", audioEntreeCache: "0.000200", audioSortie: "0.064000",
    });
    expect(f.usd).toBe("0.127480");
  });

  it("l'image : texte et image en entrée, image en sortie", () => {
    // gpt-image-2.5-sunburst : texte 5, image 8 en entrée, 30 en sortie. Mesure du 31/10 : 75 + 0 en entrée, 439 en sortie.
    expect(coutDeLAppel("gpt-image-2.5-sunburst", { entree: 75, sortie: 439, imageSortie: 439 })).toBe("0.013545");
  });

  it("la durée : Whisper à 0,006 $ la minute, GPT-Live à 0,05 $ la minute (à la seconde), Sora à la seconde", () => {
    expect(coutDeLAppel("whisper-1", { entree: 0, sortie: 0, dureeMs: 90_000 })).toBe("0.009000");
    expect(coutDeLAppel("gpt-live-1", { entree: 1_230, sortie: 0, dureeMs: 123_000, equivalents: true })).toBe("0.102500");
    expect(coutDeLAppel("sora-2-pro", { entree: 0, sortie: 0, dureeMs: 8_000 })).toBe("2.400000");
  });

  it("un modèle facturé à la durée SANS durée rendue : coût inconnu, jamais 0 $", () => {
    expect(coutDeLAppel("whisper-1", { entree: 0, sortie: 0 })).toBeNull();
    expect(coutDeLAppel("gpt-transcribe", { entree: 500, sortie: 40 })).toBeNull();
  });

  it("la recherche web se paie à l'appel (0,01 $), en plus des jetons", () => {
    expect(coutDeLAppel("gpt-5.6-luna", { entree: 0, sortie: 0, recherchesWeb: 3 })).toBe("0.030000");
  });

  it("l'API Batch : chaque poste à moitié prix", () => {
    expect(coutDeLAppel("gpt-5.6-luna", { entree: 1_000_000, sortie: 1_000_000, lot: true })).toBe("0.700000");
  });

  it("un modèle hors grille : `null` (« tarif inconnu »), même sans rien consommé", () => {
    expect(coutDeLAppel("gpt-x", { entree: 100, sortie: 10 })).toBeNull();
    expect(coutDeLAppel("gpt-x", { entree: 0, sortie: 0 })).toBeNull();
    expect(facturer({ entree: 10, sortie: 0, pages: 3 }, null).sansPrix).toContain("pages");
  });

  it("un type de jeton consommé SANS prix rend le tout inconnu (un total partiel ne se lit pas comme un total)", () => {
    // gpt-5.6-terra n'a pas de tarif audio.
    const f = facturer({ entree: 100, audioEntree: 50, sortie: 0 }, tarifDuModele("gpt-5.6-terra"));
    expect(f.usd).toBeNull();
    expect(f.sansPrix).toEqual(["audioEntree"]);
  });

  it("une part incohérente (plus de cache que d'entrée) ne fabrique pas de jetons", () => {
    expect(coutDeLAppel("gpt-6.1-terra", { entree: 100, entreeCache: 1_000, sortie: 0 })).toBe("0.000005");
  });

  it("arrondi demi vers le haut, au micro-dollar, une seule fois", () => {
    expect(picoEnDollars(499_999n)).toBe("0.000000");
    expect(picoEnDollars(500_000n)).toBe("0.000001");
    expect(sommeDollars(["0.000001", "0.000002", null, "1.5"])).toBe("1.500003");
    // 1 jeton de cache à 0,05 $/M = 0,00000005 $ → 0 ; 10 jetons → 0,0000005 → 0,000001.
    expect(coutDeLAppel("gpt-6.1-terra", { entree: 10, entreeCache: 10, sortie: 0 })).toBe("0.000001");
  });

  it("l'affichage : six décimales exactes, et l'arrondi lisible à côté", () => {
    expect(dollarsExacts("1234.012345")).toBe("1 234,012345 $");
    expect(dollarsExacts(null)).toBe("tarif inconnu");
    expect(dollarsArrondis("0.004900")).toBe("< 0,01 $");
    expect(dollarsArrondis("12.345678")).toBe("≈ 12,35 $");
  });
});

describe("l'usage d'une transcription, tel que l'API le rend", () => {
  it("gpt-4o-transcribe : des jetons, audio ventilé", () => {
    expect(usageTranscription({ usage: { type: "tokens", input_tokens: 120, output_tokens: 30, input_token_details: { audio_tokens: 110, text_tokens: 10 } } }))
      .toEqual({ inputTokens: 120, outputTokens: 30, audioInputTokens: 110, durationMs: 0, equivalents: false });
  });
  it("Whisper : une durée (usage.seconds, ou duration du verbose_json)", () => {
    expect(usageTranscription({ usage: { type: "duration", seconds: 12.5 } }).durationMs).toBe(12_500);
    expect(usageTranscription({ duration: 3.2 }).durationMs).toBe(3_200);
  });
  it("rien de rendu : des équivalents, coût inconnu", () => {
    expect(usageTranscription({ text: "bonjour" })).toMatchObject({ equivalents: true, durationMs: 0 });
  });
});
