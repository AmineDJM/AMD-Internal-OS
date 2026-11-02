import { describe, expect, it } from "vitest";
import { issueApresEchec, lectureDe, messageErreur, prochainEssai, raisonDIgnorer, TENTATIVES_MAX } from "./ingestion";

describe("Les règles de l'ingestion", () => {
  it("lit les documents, transcrit les enregistrements, ignore le reste en le disant", () => {
    expect(lectureDe("pdf")).toBe("lecteur");
    expect(lectureDe("image")).toBe("lecteur");
    expect(lectureDe("audio")).toBe("transcription");
    expect(lectureDe("archive")).toBeNull();
    expect(raisonDIgnorer("archive", 10)).toMatch(/aucun texte/);
    expect(raisonDIgnorer("pdf", 50 * 1024 * 1024)).toMatch(/40 Mo/);
    expect(raisonDIgnorer("audio", 30 * 1024 * 1024)).toMatch(/25 Mo/);
    expect(raisonDIgnorer("pdf", 1000)).toBeNull();
  });
  it("retente avec un délai croissant, plafonné, puis s'arrête", () => {
    const t0 = 0;
    expect(prochainEssai(1, t0).getTime()).toBe(60_000);
    expect(prochainEssai(2, t0).getTime()).toBe(4 * 60_000);
    expect(prochainEssai(20, t0).getTime()).toBe(360 * 60_000);
    expect(issueApresEchec(TENTATIVES_MAX - 1)).toBe("A_FAIRE");
    expect(issueApresEchec(TENTATIVES_MAX)).toBe("ECHEC");
  });
  it("une erreur s'écrit sur une ligne, bornée", () => {
    expect(messageErreur(new Error("a\n\nb"))).toBe("a b");
    expect(messageErreur("x".repeat(1000)).length).toBe(300);
  });
});
