import { describe, expect, it } from "vitest";
import { migrationsManquantes } from "./migrations-appliquees";

describe("migrations appliquées — la sonde refuse un schéma en retard", () => {
  it("rend les dossiers sans migration terminée, triés", () => {
    expect(migrationsManquantes(["20270102_b", "20270101_a", "20270103_c"], ["20270101_a"])).toEqual(["20270102_b", "20270103_c"]);
  });
  it("rien ne manque quand tout est appliqué (une migration en base absente du dépôt n'est pas un retard)", () => {
    expect(migrationsManquantes(["20270101_a"], ["20270101_a", "20261231_ancienne"])).toEqual([]);
  });
});
