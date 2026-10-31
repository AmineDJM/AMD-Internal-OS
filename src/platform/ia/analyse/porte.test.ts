import { describe, expect, it } from "vitest";
import { inspecter, lireChemin, passerLaPorte, tester, valider, type ExecutionBac } from "./porte";

/**
 * LA PORTE DE QUALITÉ — generate → inspect → execute → test → validate → expose. Chaque étape
 * refuse pour une raison NOMMÉE, et un résultat qui ne passe pas n'est jamais exposé : c'est
 * l'étape qui a refusé qui est rendue, avec la correction à faire.
 */
const executeur = (f: (data: unknown) => unknown) => async (_code: string, data: unknown): Promise<ExecutionBac> => {
  try { return { ok: true, resultat: f(data), ms: 3 }; } catch (e) { return { ok: false, resultat: undefined, erreur: e instanceof Error ? e.message : String(e), ms: 1 }; }
};

describe("inspecter — avant toute exécution", () => {
  it("refuse le vide, le trop long, les accès système, le réseau, les boucles sans borne, le JS sans return, le Python sans result", () => {
    expect(inspecter("", "js").ok).toBe(false);
    expect(inspecter("return 1;".padEnd(50_000, " "), "js").detail).toMatch(/trop long/);
    expect(inspecter("const fs = require('fs'); return fs.readFileSync('/etc/passwd');", "js").detail).toMatch(/accès système/);
    expect(inspecter("return fetch('https://x').then(r => r.json());", "js").detail).toMatch(/réseau/);
    expect(inspecter("while (true) {} return 1;", "js").detail).toMatch(/boucle/);
    expect(inspecter("const t = data.map(Number);", "js").detail).toMatch(/return/);
    expect(inspecter("import os\nresult = os.listdir('/')", "python").detail).toMatch(/module système/);
    expect(inspecter("print(sum(data))", "python").detail).toMatch(/result/);
    expect(inspecter("return lib.sum(data.map((r) => r.montant));", "js").ok).toBe(true);
    expect(inspecter("result = sum(r['montant'] for r in data)", "python").ok).toBe(true);
  });
});

describe("tester et valider — des attentes closes, une forme promise", () => {
  it("lit un chemin, compare, borne, compte", () => {
    const r = { total: 142_800, lignes: [{ ref: "F-1", montant: 120_000 }, { ref: "F-2", montant: 22_800 }], note: "TTC" };
    expect(lireChemin(r, "lignes[1].montant")).toBe(22_800);
    expect(lireChemin(r, "lignes.length")).toBe(2);
    expect(lireChemin(r, "")).toBe(r);
    expect(lireChemin(r, "absent.x")).toBeUndefined();
    const t = tester(r, [
      { chemin: "total", op: "egal", valeur: 142800 },
      { chemin: "total", op: "entre", bornes: [100_000, 200_000] },
      { chemin: "lignes", op: "longueur", valeur: 2 },
      { chemin: "lignes[0].ref", op: "contient", valeur: "F-" },
      { chemin: "note", op: "type", valeur: "string" },
      { chemin: "lignes", op: "nonVide" },
    ]);
    expect(t.verdict.ok).toBe(true);
    expect(t.passes).toBe(6);
    const faux = tester(r, [{ chemin: "total", op: "egal", valeur: 142_000, libelle: "total TTC" }]);
    expect(faux.verdict.ok).toBe(false);
    expect(faux.echecs[0]).toMatch(/total TTC — obtenu 142800/);
  });
  it("valide la forme : objet avec clés, liste bornée d'objets, nombre, texte ; refuse NaN et Infinity", () => {
    expect(valider({ total: 1 }, { forme: "objet", cles: ["total"] }).ok).toBe(true);
    expect(valider({ total: 1 }, { forme: "objet", cles: ["total", "n"] }).detail).toMatch(/clés manquantes : n/);
    expect(valider([{ a: 1 }, { b: 2 }], { forme: "liste", cles: ["a"] }).detail).toMatch(/élément 1 sans a/);
    expect(valider([1, 2, 3], { forme: "liste", max: 2 }).ok).toBe(false);
    expect(valider(12, { forme: "nombre" }).ok).toBe(true);
    expect(valider("12", { forme: "nombre" }).ok).toBe(true);
    expect(valider({ x: Number.NaN }, null).detail).toMatch(/non fini/);
    expect(valider(undefined, null).detail).toMatch(/aucun résultat/);
    expect(valider("ok", { forme: "texte", max: 1 }).ok).toBe(false);
  });
});

describe("passerLaPorte — cinq étapes, un rapport", () => {
  const data = [{ montant: 120_000 }, { montant: 22_800 }];
  it("expose un résultat qui passe les quatre étapes, avec le détail de chacune", async () => {
    const r = await passerLaPorte({
      code: "return { total: lib.sum(data.map((x) => x.montant)), n: data.length };", langage: "js", data,
      attentes: [{ chemin: "total", op: "egal", valeur: 142_800 }, { chemin: "n", op: "egal", valeur: 2 }],
      schema: { forme: "objet", cles: ["total", "n"] },
      executer: executeur((d) => ({ total: (d as { montant: number }[]).reduce((s, x) => s + x.montant, 0), n: (d as unknown[]).length })),
    });
    expect(r.expose).toBe(true);
    expect(r.refusePar).toBeNull();
    expect(r.etapes.map((e) => `${e.etape}:${e.ok}`)).toEqual(["inspection:true", "execution:true", "tests:true", "validation:true"]);
    expect(r.testsPasses).toBe(2);
    expect((r.resultat as { total: number }).total).toBe(142_800);
  });
  it("un calcul FAUX n'est pas exposé : l'étape « tests » refuse, la correction dit quoi corriger — et jamais l'attente", async () => {
    const r = await passerLaPorte({
      code: "return { total: lib.sum(data.map((x) => x.montant)) * 1.19 };", langage: "js", data,
      attentes: [{ chemin: "total", op: "egal", valeur: 142_800, libelle: "total TTC" }],
      executer: executeur(() => ({ total: 169_932 })),
    });
    expect(r.expose).toBe(false);
    expect(r.resultat).toBeUndefined();
    expect(r.refusePar).toBe("tests");
    expect(r.correction).toMatch(/corriger le calcul, pas l'attente/);
    expect(r.testsPasses).toBe(0);
  });
  it("une forme fausse n'est pas exposée (validation) ; un code interdit n'est même pas exécuté (inspection) ; une exception est une étape", async () => {
    let executions = 0;
    const compteur = async (): Promise<ExecutionBac> => { executions += 1; return { ok: true, resultat: [1, 2], ms: 1 }; };
    const forme = await passerLaPorte({ code: "return [1, 2];", langage: "js", data, schema: { forme: "objet", cles: ["total"] }, executer: compteur });
    expect(forme.expose).toBe(false);
    expect(forme.refusePar).toBe("validation");
    const interdit = await passerLaPorte({ code: "return fetch('https://evil').then(r => r.text());", langage: "js", data, executer: compteur });
    expect(interdit.refusePar).toBe("inspection");
    expect(executions).toBe(1);
    const plante = await passerLaPorte({ code: "return data.x.y;", langage: "js", data, executer: async () => { throw new Error("TypeError: cannot read y"); } });
    expect(plante.refusePar).toBe("execution");
    expect(plante.correction).toMatch(/cannot read y/);
  });
});
