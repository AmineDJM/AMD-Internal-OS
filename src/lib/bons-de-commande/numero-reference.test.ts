import { describe, expect, it } from "vitest";
import { compteurApres, memeNumero, phraseNumeroPris, refusNumeroLibre, sequenceDuNumero } from "./numero-reference";
import { formaterNumero } from "@/lib/artifact/factory/commercial";

/** LE NUMÉRO DE RÉFÉRENCE D'UN BC, MODIFIABLE (Direction, 14/10/2026) — la règle pure. */
describe("le numéro de référence d'un bon de commande", () => {
  it("la séquence se relit dans le motif de la série — l'inverse exact de `formaterNumero`", () => {
    for (const motif of ["{prefixe}-{aaaa}-{n:4}", "{n:3}/FS/{aa}", "{n:3}/DG/{aaaa}", "CMD {n}"]) {
      for (const n of [1, 37, 1234]) {
        const numero = formaterNumero("BC", 2026, n, motif);
        expect(sequenceDuNumero(numero, { prefixe: "BC", annee: 2026, motif }), `${motif} → ${numero}`).toBe(n);
      }
    }
    expect(sequenceDuNumero("bc-2026-0040", { prefixe: "BC", annee: 2026, motif: "{prefixe}-{aaaa}-{n:4}" })).toBe(40);
    // Hors motif (autre année, autre forme) : pas de séquence — le compteur n'y touche pas.
    expect(sequenceDuNumero("BC-2025-0040", { prefixe: "BC", annee: 2026, motif: "{prefixe}-{aaaa}-{n:4}" })).toBeNull();
    expect(sequenceDuNumero("CMD SPÉCIALE 7", { prefixe: "BC", annee: 2026, motif: "{prefixe}-{aaaa}-{n:4}" })).toBeNull();
  });

  it("le même numéro, quelle que soit la casse ou les espaces ; un vide n'est jamais « le même »", () => {
    expect(memeNumero("040/dg/2026", " 040 / DG / 2026 ")).toBe(true);
    expect(memeNumero("040/DG/2026", "041/DG/2026")).toBe(false);
    expect(memeNumero("", "")).toBe(false);
  });

  it("une saisie libre : obligatoire, lisible, avec un numéro", () => {
    expect(refusNumeroLibre("")).toMatch(/obligatoire/);
    expect(refusNumeroLibre("BC|12")).toMatch(/interdit/);
    expect(refusNumeroLibre("SANS CHIFFRE")).toMatch(/porter un numéro/);
    expect(refusNumeroLibre("x".repeat(41) + "1")).toMatch(/40 caractères/);
    expect(refusNumeroLibre("CMD SPÉCIALE 7")).toBeNull();
  });

  it("le compteur ne recule jamais : porté au moins au numéro saisi", () => {
    expect(compteurApres(50, 70)).toBe(70);
    expect(compteurApres(50, 10)).toBe(50);
    expect(compteurApres(50, null)).toBe(50);
  });

  it("le refus nomme le document qui porte déjà le numéro", () => {
    expect(phraseNumeroPris("040/DG/2026", { libelle: "un ordre de mission", reference: "040/DG/2026" })).toMatch(/déjà porté par un ordre de mission 040\/DG\/2026/);
  });
});
