import { describe, expect, it } from "vitest";
import { executerJs, verifierCodeJs, JS_RESULTAT_MAX } from "./js";

/**
 * LE BAC JAVASCRIPT — ce qu'on prouve : le code voit `data` et `lib`, rien de l'hôte ; les
 * échappatoires classiques sont fermées (require, process, Function depuis un constructeur) ;
 * le délai et le volume de résultat sont des arrêts durs ; `data` est une COPIE.
 */
const data = [{ societe: "Adventum", montant: 10 }, { societe: "Pharmalliance", montant: 32 }, { societe: "Adventum", montant: 5 }];

describe("la forme, avant tout fil", () => {
  it("refuse require, process, globalThis, import(), eval, Function( — en nommant le mot", () => {
    for (const [code, mot] of [["return require('fs')", "require"], ["return process.env", "process"], ["return globalThis", "globalThis"], ["return import('x')", "import"], ["return eval('1')", "eval"], ["return Function('return 1')()", "Function"]] as const) {
      const v = verifierCodeJs(code);
      expect(v.ok, code).toBe(false);
      if (!v.ok) expect(v.motif).toContain(mot);
    }
    expect(verifierCodeJs("").ok).toBe(false);
    expect(verifierCodeJs("return 1").ok).toBe(true);
  });
});

describe("l'exécution isolée", () => {
  it("calcule avec lib, capture console.log, rend du JSON", async () => {
    const r = await executerJs("console.log('début', data.length); const g = lib.groupBy(data, 'societe'); return Object.entries(g).map(([k, v]) => ({ societe: k, total: lib.sum(v.map((x) => x.montant)) }));", data);
    expect(r.ok).toBe(true);
    expect(r.resultat).toEqual([{ societe: "Adventum", total: 15 }, { societe: "Pharmalliance", total: 32 }]);
    expect(r.journal).toEqual(["début 3"]);
    expect(r.ms).toBeLessThan(3_000);
  });
  it("le contexte est vide : pas de process, pas de génération de code depuis une chaîne", async () => {
    // `proc\u0065ss` et `requir\u0065` : le MÊME identifiant pour le moteur, mais invisible à la
    // forme — c'est la couche vm qu'on sonde ici, pas la regex.
    const r1 = await executerJs("return typeof this.proc\\u0065ss + '/' + typeof setTimeout + '/' + typeof fetch + '/' + typeof requir\\u0065", data);
    expect(r1.ok, r1.erreur).toBe(true);
    expect(r1.resultat).toBe("undefined/undefined/undefined/undefined");
    const r2 = await executerJs("const F = (function(){}).constructor; return F('return 1')()", data);
    expect(r2.ok).toBe(false);
    expect(r2.erreur).toMatch(/Code generation from strings disallowed/);
  });
  it("le délai est un arrêt dur", async () => {
    const r = await executerJs("while (true) {}", data, { delaiMs: 600 });
    expect(r.ok).toBe(false);
    expect(r.erreur).toMatch(/timed out|délai/);
    expect(r.ms).toBeLessThan(3_000);
  }, 10_000);
  it("un résultat au-delà d'un mégaoctet est refusé et la note dit quoi faire", async () => {
    const r = await executerJs("return new Array(200000).fill('xxxxxxxxxxxx')", data);
    expect(r.ok).toBe(false);
    expect(r.erreur).toMatch(/volumineux/);
    expect(r.notes[0]).toContain(String(JS_RESULTAT_MAX));
  });
  it("data est une copie : muter dans le bac ne touche pas l'hôte", async () => {
    const r = await executerJs("data[0].montant = 999; data.push({ x: 1 }); return data.length", data);
    expect(r.resultat).toBe(4);
    expect(data).toHaveLength(3);
    expect(data[0].montant).toBe(10);
  });
  it("une erreur du code est rendue, pas levée", async () => {
    const r = await executerJs("return data.map(x => x.montant.toFixed(2).nope())", data);
    expect(r.ok).toBe(false);
    expect(r.erreur).toMatch(/not a function/);
  });
});
