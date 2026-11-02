import { describe, expect, it } from "vitest";
import { ATTEINTS_PAR_LES_TESTS_SEULS, PLAFONDS, mesurerCodeMort, mesurerDoublons } from "./qualite-code";

/**
 * LES CLIQUETS DU CODE MORT ET DES DOUBLONS — voir l'en-tête de `qualite-code.ts`.
 * Ils ne se relèvent jamais : un rouge ici se corrige en supprimant ou en fusionnant, pas en
 * touchant au plafond. `npm run qualite:mort` / `npm run qualite:doublons` disent quoi.
 */
describe("code mort (knip)", () => {
  const mesure = mesurerCodeMort();

  it("aucun fichier, export, type ni dépendance inutilisé — zéro, sans exception", () => {
    expect(mesure.problemes, "supprimer (ou brancher) ce que knip signale — `npm run qualite:mort`").toEqual([]);
  });

  it("le code que seuls des tests atteignent est NOMMÉ, et la liste ne fait que rétrécir", () => {
    const nommes = Object.keys(ATTEINTS_PAR_LES_TESTS_SEULS).sort();
    expect(mesure.fichiersTestsSeuls, "un fichier de production que seuls des tests importent : le brancher, ou le supprimer avec ses tests").toEqual(
      nommes.filter((f) => mesure.fichiersTestsSeuls.includes(f)),
    );
    const disparus = nommes.filter((f) => !mesure.fichiersTestsSeuls.includes(f));
    expect(disparus, "branché ou supprimé : retirer l'entrée de ATTEINTS_PAR_LES_TESTS_SEULS").toEqual([]);
  });
});

describe("doublons (jscpd)", () => {
  const mesure = mesurerDoublons();

  it(`clones ≤ ${PLAFONDS.clones}, lignes dupliquées ≤ ${PLAFONDS.lignesDupliquees}`, () => {
    const pires = mesure.pires.map((p) => `${p.lignes} l. ${p.a} ↔ ${p.b}`).join("\n");
    expect(mesure.clones, `fusionner plutôt que recopier — les plus longs :\n${pires}`).toBeLessThanOrEqual(PLAFONDS.clones);
    expect(mesure.lignesDupliquees, pires).toBeLessThanOrEqual(PLAFONDS.lignesDupliquees);
  });
});
