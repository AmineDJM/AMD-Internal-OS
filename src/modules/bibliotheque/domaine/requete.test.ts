import { describe, expect, it } from "vitest";
import { LIMITE_MAX, normaliserRequete } from "./requete";

describe("La requête et ses filtres", () => {
  it("ne garde que les filtres connus, sans doublon", () => {
    const r = normaliserRequete("  contrat   de travail ", { formats: "pdf,inconnu,pdf", sources: ["RH", "X"], familles: "DOCUMENT,ZZZ" });
    expect(r.texte).toBe("contrat de travail");
    expect(r.filtres).toEqual({ formats: ["pdf"], sources: ["RH"], familles: ["DOCUMENT"] });
  });
  it("ordonne la période et inclut toute la journée de fin", () => {
    const r = normaliserRequete("x", { du: "2026-10-29", au: "2026-10-01" });
    expect(r.filtres.du!.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(r.filtres.au!.toISOString().startsWith("2026-10-29")).toBe(true);
  });
  it("valide l'objet (une clé d'accès), plafonne la limite", () => {
    expect(normaliserRequete("x", { objet: "DRIVE_NODE:abc" }).filtres.objet).toBe("DRIVE_NODE:abc");
    expect(normaliserRequete("x", { objet: "drop table" }).filtres.objet).toBeUndefined();
    expect(normaliserRequete("x", {}, 10_000).limite).toBe(LIMITE_MAX);
    expect(normaliserRequete("x", {}, 0).limite).toBe(1);
  });
});
