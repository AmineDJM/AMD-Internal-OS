import { describe, expect, it } from "vitest";
import { CHAMPS_SENSIBLES } from "./domaine/champs";
import { peutLire } from "./domaine/politique";
import { NATURES_COFFRE } from "./domaine/natures";
import { champJamaisExpose, serialize } from "@/lib/api/query";
import { COLONNES_MASQUEES } from "@/lib/sandbox/sql";
import { censurerObjet } from "@/modules/assistant-ia/partage";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * AUCUN MODÈLE D'IA N'ACCÈDE AUX DONNÉES DU COFFRE (décision de la Direction, refonte V2-E).
 *
 * Toutes les portes par lesquelles une valeur pourrait atteindre un modèle ou une machine, éprouvées
 * contre le CATALOGUE du coffre (`champs.ts`) — une colonne ajoutée au coffre et oubliée ici fait
 * échouer le banc :
 *   1. la politique refuse tout lecteur `IA`, quelle que soit la nature ou l'usage ;
 *   2. l'API v1 (agents et intégrations externes) ne sérialise jamais ces colonnes ;
 *   3. le bac à sable SQL de l'assistant les masque ;
 *   4. le filtre de confidentialité du contexte d'un modèle les censure.
 * Le 5ᵉ verrou est structurel : `frontiere.test.ts` (l'assistant n'importe jamais ce qui déchiffre).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

describe("Aucun modèle d'IA n'accède au coffre", () => {
  it("la politique refuse un modèle d'IA, pour toute nature, tout titulaire et tout usage", () => {
    for (const n of NATURES_COFFRE) for (const usage of ["CONSULTATION", "PIECE_OFFICIELLE"] as const) {
      for (const t of [{ genre: "PERSONNE" as const, userId: null }, { genre: "ORGANISATION" as const }]) {
        expect(peutLire({ genre: "IA", nom: "assistant" }, n, t, usage)).toMatchObject({ autorise: false, motif: "MODELE_IA" });
      }
    }
  });

  it("l'API v1 ne rend aucune colonne du coffre, même dans une relation imbriquée", () => {
    for (const c of CHAMPS_SENSIBLES) expect(champJamaisExpose(c.champ), `${c.modele}.${c.champ}`).toBe(true);
    const fiche = Object.fromEntries(CHAMPS_SENSIBLES.map((c) => [c.champ, "DZ3500400174401234567891"]));
    const rendu = JSON.stringify(serialize({ id: "e1", fullName: "Amina", contact: fiche, liste: [fiche] }));
    expect(rendu).not.toContain("DZ35");
    expect(rendu).toContain("Amina");
  });

  it("le bac à sable SQL de l'assistant masque chaque colonne du coffre", () => {
    for (const c of CHAMPS_SENSIBLES) expect(COLONNES_MASQUEES.has(c.champ), `${c.modele}.${c.champ}`).toBe(true);
  });

  it("le filtre de confidentialité censure chaque colonne du coffre avant le contexte d'un modèle", () => {
    for (const c of CHAMPS_SENSIBLES) {
      const { resultat, censure } = censurerObjet({ [c.champ]: "185000" });
      expect(censure, `${c.modele}.${c.champ}`).toBe(true);
      expect(JSON.stringify(resultat)).not.toContain("185000");
    }
  });
});
