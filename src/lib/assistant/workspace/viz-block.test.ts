import { describe, expect, it } from "vitest";
import { composeWorkspace } from "./compose";
import { VIZ_TYPES, WORKSPACE_LIMITS } from "@/platform/ia/workspace/protocol";
import { FAMILLE, construireViz, profiler, readDashboardBlock, readVizBlock } from "@/platform/ia/workspace/viz-block";

/**
 * LA REPRÉSENTATION GÉNÉRIQUE (§35) — le lecteur refuse ce qui ne passe pas champ par champ, les
 * constructeurs agrègent par le code, et le tableau de bord relit chaque tuile. Aucune forme n'a
 * de composant dédié : ce fichier vérifie la DONNÉE, `viz-figure.test.ts` vérifie le dessin.
 */
const J = (o: unknown) => JSON.stringify(o);
const ok = (type: string, donnees: unknown) => readVizBlock({ kind: "viz", type, donnees }, "T");

describe("le lecteur — une forme, sa famille, ses bornes", () => {
  it("toutes les formes ont une famille, et une déclaration valide passe pour chacune", () => {
    for (const t of VIZ_TYPES) expect(FAMILLE[t]).toBeTruthy();
    expect(ok("barres", { categories: ["A", "B"], series: [{ label: "V", valeurs: [1, 2] }] })?.kind).toBe("viz");
    expect(ok("courbe", { categories: ["2026-01", "2026-02", "2026-03"], valeurs: [1, 2, 3] })?.kind).toBe("viz");
    expect(ok("nuage", { points: [{ x: 1, y: 2 }, { x: "3", y: "4,5" }] })).toMatchObject({ donnees: { points: [{ x: 1, y: 2 }, { x: 3, y: 4.5 }] } });
    expect(ok("heatmap", { lignes: ["a"], colonnes: ["x", "y"], valeurs: [[1, null]] })?.kind).toBe("viz");
    expect(ok("matrice", { lignes: ["a"], colonnes: ["x"], cellules: [["ok"]], tons: [["succes"]] })).toMatchObject({ donnees: { tons: [["succes"]] } });
    expect(ok("gantt", { taches: [{ label: "t", debut: "2026-01-01", fin: "2026-02-01" }] })?.kind).toBe("viz");
    expect(ok("graphe", { noeuds: [{ id: "a", label: "A" }, { id: "b" }], arcs: [{ de: "a", a: "b" }] })).toMatchObject({ donnees: { noeuds: [{ id: "a" }, { id: "b", label: "b" }] } });
    expect(ok("flux", { noeuds: [{ id: "a" }, { id: "b" }], arcs: [{ de: "a", a: "b", poids: 4 }] })?.kind).toBe("viz");
    expect(ok("arbre", { racine: { label: "r", enfants: [{ label: "e", valeur: 2 }] } })?.kind).toBe("viz");
    expect(ok("carte", { lieux: [{ label: "Alger", lat: 36.7, lon: 3.05 }] })?.kind).toBe("viz");
    expect(ok("cartes", { cartes: [{ titre: "Décisions", valeur: 7 }] })).toMatchObject({ donnees: { cartes: [{ titre: "Décisions", valeur: "7" }] } });
  });

  it("refuse une forme inconnue, une famille qui ne correspond pas, des données vides — rien n'est « affiché à peu près »", () => {
    expect(ok("camembert3d", { categories: ["a"], series: [{ valeurs: [1] }] })).toBeNull();
    expect(ok("barres", { points: [{ x: 1, y: 2 }] })).toBeNull();
    expect(ok("barres", { categories: ["a"], series: [{ valeurs: ["n/a"] }] })).toBeNull();
    expect(ok("flux", { noeuds: [{ id: "a" }, { id: "b" }], arcs: [] })).toBeNull();
    expect(ok("carte", { lieux: [{ label: "nulle part", lat: 120, lon: 3 }] })).toBeNull();
    expect(readVizBlock({ kind: "viz", type: "barres" }, "T")).toBeNull();
  });

  it("borne : 40 catégories, 6 séries ; arcs vers des nœuds absents écartés ; dates inversées écartées ; href externe écarté", () => {
    const cats = Array.from({ length: 60 }, (_, i) => `c${i}`);
    const b = ok("barres", { categories: cats, series: Array.from({ length: 9 }, (_, j) => ({ label: `s${j}`, valeurs: cats.map((_, i) => i + j) })) });
    if (b?.kind !== "viz") throw new Error("bloc attendu");
    expect(b.donnees.categories).toHaveLength(WORKSPACE_LIMITS.vizCategories);
    expect(b.donnees.series).toHaveLength(WORKSPACE_LIMITS.vizSeries);
    expect(b.donnees.series?.[0]?.valeurs).toHaveLength(WORKSPACE_LIMITS.vizCategories);

    const g = ok("graphe", { noeuds: [{ id: "a" }, { id: "b", href: "https://evil.example" }, { id: "c", href: "/directory/c" }], arcs: [{ de: "a", a: "b" }, { de: "a", a: "zz" }, { de: "a", a: "a" }] });
    if (g?.kind !== "viz") throw new Error("bloc attendu");
    expect(g.donnees.arcs).toHaveLength(1);
    expect(g.donnees.noeuds?.[1]?.href).toBeNull();
    expect(g.donnees.noeuds?.[2]?.href).toBe("/directory/c");

    const t = ok("gantt", { taches: [{ label: "ok", debut: "2026-01-01", fin: "2026-01-10", progression: 140 }, { label: "inversée", debut: "2026-02-01", fin: "2026-01-10" }, { label: "sans date", debut: "bientôt", fin: "plus tard" }] });
    if (t?.kind !== "viz") throw new Error("bloc attendu");
    expect(t.donnees.taches).toHaveLength(1);
    expect(t.donnees.taches?.[0]?.progression).toBe(100);
  });

  it("les alertes, la raison, l'unité et la source traversent ; un ton inventé tombe", () => {
    const b = readVizBlock({ kind: "viz", type: "secteurs", unite: "DZD", raison: "cinq parts", source: "read_budget", alertes: ["TROMPEUR · axe"], donnees: { categories: ["a", "b"], series: [{ label: "v", valeurs: [1, 2], ton: "fuchsia" }] } }, "T");
    if (b?.kind !== "viz") throw new Error("bloc attendu");
    expect(b).toMatchObject({ unite: "DZD", raison: "cinq parts", source: "read_budget", alertes: ["TROMPEUR · axe"] });
    expect(b.donnees.series?.[0]?.ton).toBeUndefined();
  });
});

describe("le tableau de bord — des tuiles relues une à une", () => {
  const tuile = (i: number) => ({ kind: "viz", title: `T${i}`, type: "barres", donnees: { categories: ["a"], series: [{ valeurs: [i] }] } });

  it("passe par composeWorkspace : une tuile invalide tombe, un tableau de bord imbriqué est refusé, six tuiles au plus", () => {
    const c = composeWorkspace("render_view", J({
      ok: true,
      _blocs: [{
        kind: "dashboard", title: "Bord", colonnes: 3,
        tuiles: [
          tuile(1),
          { kind: "viz", title: "cassée", type: "barres", donnees: {} },
          { kind: "dashboard", title: "imbriqué", tuiles: [tuile(9)] },
          { kind: "progress", title: "Jauge", gauges: [{ label: "a", valeur: 1, total: 2 }] },
          tuile(2), tuile(3), tuile(4), tuile(5), tuile(6),
        ],
      }],
    }));
    const b = c?.blocks[0];
    if (b?.kind !== "dashboard") throw new Error("dashboard attendu");
    expect(b.colonnes).toBe(3);
    expect(b.tuiles).toHaveLength(WORKSPACE_LIMITS.tuiles);
    expect(b.tuiles.map((t) => t.kind)).toEqual(["viz", "progress", "viz", "viz", "viz", "viz"]);
  });

  it("sans tuile valide, pas de bloc ; les colonnes se déduisent du nombre de tuiles", () => {
    const lire = (x: unknown) => readVizBlock(x as Record<string, unknown>, "x");
    expect(readDashboardBlock({ tuiles: [{ kind: "viz", type: "barres", title: "x", donnees: {} }] }, "T", lire)).toBeNull();
    const d = readDashboardBlock({ tuiles: Array.from({ length: 5 }, () => ({ kind: "viz", type: "cartes", title: "x", donnees: { cartes: [{ titre: "a", valeur: 1 }] } })) }, "T", lire);
    expect(d?.kind === "dashboard" ? d.colonnes : null).toBe(3);
  });
});

describe("les constructeurs — des lignes à une forme, par le code", () => {
  const lignes = [
    { societe: "Adventum", categorie: "Marketing", mois: "2026-03", montant: 150_000 },
    { societe: "Adventum", categorie: "Marketing", mois: "2026-01", montant: 120_000 },
    { societe: "Pharmalliance", categorie: "Marketing", mois: "2026-02", montant: 80_000 },
    { societe: "Adventum", categorie: "IT", mois: "2026-02", montant: 40_000 },
    { societe: "Pharmalliance", categorie: "IT", mois: "2026-03", montant: 10_000 },
  ];

  it("barres : somme par catégorie, triée par valeur ; compte quand il n'y a pas de mesure ; colonnes résolues sans accents ni casse", () => {
    const c = construireViz({ type: "barres", x: "Société", y: ["Montant"] }, lignes);
    if ("erreur" in c) throw new Error(c.erreur);
    expect(c.donnees.categories).toEqual(["Adventum", "Pharmalliance"]);
    expect(c.donnees.series?.[0]?.valeurs).toEqual([310_000, 90_000]);
    expect(c.colonnes).toMatchObject({ x: "societe", y: ["montant"], agregat: "somme" });
    const n = construireViz({ type: "barres", x: "categorie", agregat: "compte" }, lignes);
    if ("erreur" in n) throw new Error(n.erreur);
    expect(n.donnees.series?.[0]).toMatchObject({ label: "Effectif", valeurs: [3, 2] });
  });

  it("une colonne introuvable est REFUSÉE avec la liste des colonnes — jamais devinée", () => {
    const e = construireViz({ type: "barres", x: "region", y: ["montant"] }, lignes);
    expect("erreur" in e ? e.erreur : "").toMatch(/introuvable.*region.*colonnes disponibles : societe, categorie, mois, montant/);
  });

  it("le pivot en séries (barres empilées) et le temps en ordre chronologique (courbe)", () => {
    const p = construireViz({ type: "barres_empilees", x: "societe", y: ["montant"], serie: "categorie" }, lignes);
    if ("erreur" in p) throw new Error(p.erreur);
    expect(p.donnees.series?.map((s) => s.label)).toEqual(["Marketing", "IT"]);
    expect(p.donnees.series?.[0]?.valeurs).toEqual([270_000, 80_000]);
    const t = construireViz({ type: "courbe", x: "mois", y: ["montant"] }, lignes);
    if ("erreur" in t) throw new Error(t.erreur);
    expect(t.donnees.categories).toEqual(["2026-01", "2026-02", "2026-03"]);
    expect(t.donnees.series?.[0]?.valeurs).toEqual([120_000, 120_000, 160_000]);
  });

  it("secteurs : au-delà de six parts, les cinq plus fortes et « Autres » — dit dans les notes", () => {
    const beaucoup = Array.from({ length: 9 }, (_, i) => ({ poste: `P${i}`, montant: 100 - i * 10 }));
    const s = construireViz({ type: "secteurs", x: "poste", y: ["montant"] }, beaucoup);
    if ("erreur" in s) throw new Error(s.erreur);
    expect(s.donnees.categories).toHaveLength(6);
    expect(s.donnees.categories?.[5]).toBe("Autres");
    expect(s.donnees.series?.[0]?.valeurs?.[5]).toBe(50 + 40 + 30 + 20);
    expect(s.notes.join(" ")).toMatch(/9 parts/);
  });

  it("histogramme : des classes d'effectif à pas lisible ; cascade : l'ordre d'apparition est gardé", () => {
    const h = construireViz({ type: "histogramme", x: "montant" }, Array.from({ length: 50 }, (_, i) => ({ montant: 1000 + i * 137 })));
    if ("erreur" in h) throw new Error(h.erreur);
    expect((h.donnees.categories ?? []).length).toBeGreaterThanOrEqual(5);
    expect(h.donnees.series?.[0]?.valeurs?.reduce<number>((a, v) => a + (v ?? 0), 0)).toBe(50);
    const c = construireViz({ type: "cascade", x: "etape", y: ["variation"] }, [{ etape: "Voté", variation: 3000 }, { etape: "Engagé T1", variation: -820 }, { etape: "Réaffecté", variation: 250 }]);
    if ("erreur" in c) throw new Error(c.erreur);
    expect(c.donnees.categories).toEqual(["Voté", "Engagé T1", "Réaffecté"]);
  });

  it("nuage, heatmap, gantt, graphe, arbre, carte, cartes — chaque famille depuis ses colonnes", () => {
    const n = construireViz({ type: "nuage", x: "delai", y: ["montant"], label: "fournisseur" }, [{ fournisseur: "A", delai: 10, montant: 5 }, { fournisseur: "B", delai: 40, montant: 2 }]);
    if ("erreur" in n) throw new Error(n.erreur);
    expect(n.donnees.points).toEqual([{ x: 10, y: 5, label: "A", taille: null, groupe: null }, { x: 40, y: 2, label: "B", taille: null, groupe: null }]);

    const hm = construireViz({ type: "heatmap", x: "societe", serie: "mois", y: ["montant"] }, lignes);
    if ("erreur" in hm) throw new Error(hm.erreur);
    expect(hm.donnees.colonnes).toEqual(["2026-01", "2026-02", "2026-03"]);
    expect(hm.donnees.valeurs?.[0]).toEqual([120_000, 40_000, 150_000]);

    const g = construireViz({ type: "gantt", label: "dossier", debut: "depot", fin: "echeance" }, [{ dossier: "A", depot: "2026-01-05", echeance: "2026-03-01" }, { dossier: "B", depot: "2026-02-01", echeance: "2026-01-01" }]);
    if ("erreur" in g) throw new Error(g.erreur);
    expect(g.donnees.taches).toHaveLength(1);

    const r = construireViz({ type: "graphe", de: "de", a: "vers", poids: "n" }, [{ de: "A", vers: "B", n: 3 }, { de: "A", vers: "B", n: 2 }, { de: "B", vers: "C", n: 1 }, { de: "C", vers: "C", n: 9 }]);
    if ("erreur" in r) throw new Error(r.erreur);
    expect(r.donnees.arcs).toEqual([{ de: "A", a: "B", poids: 5 }, { de: "B", a: "C", poids: 1 }]);
    expect(r.donnees.noeuds?.map((x) => x.id)).toEqual(["B", "A", "C"]);
    const espaces = construireViz({ type: "graphe", de: "de", a: "vers" }, [{ de: "D. Benkaci", vers: "M. Ould" }]);
    if ("erreur" in espaces) throw new Error(espaces.erreur);
    expect(espaces.donnees.arcs).toEqual([{ de: "D. Benkaci", a: "M. Ould", poids: 1 }]);

    const a = construireViz({ type: "arbre", parent: "parent", label: "poste", y: ["montant"] }, [{ poste: "Budget", parent: null, montant: 100 }, { poste: "Marketing", parent: "Budget", montant: 42 }, { poste: "Digital", parent: "Marketing", montant: 8 }]);
    if ("erreur" in a) throw new Error(a.erreur);
    expect(a.donnees.racine).toMatchObject({ label: "Budget", valeur: 100, enfants: [{ label: "Marketing", enfants: [{ label: "Digital", valeur: 8 }] }] });

    const c = construireViz({ type: "carte" }, [{ nom: "Alger", latitude: 36.7, longitude: 3.05, colis: 40 }, { nom: "Nulle part", latitude: 200, longitude: 0 }]);
    if ("erreur" in c) throw new Error(c.erreur);
    expect(c.donnees.lieux).toEqual([{ label: "Alger", lat: 36.7, lon: 3.05, valeur: 40 }]);

    const k = construireViz({ type: "cartes", label: "indicateur", y: ["valeur"], detail: "detail" }, [{ indicateur: "Décisions", valeur: 7, detail: "2 urgentes" }]);
    if ("erreur" in k) throw new Error(k.erreur);
    expect(k.donnees.cartes).toEqual([{ titre: "Décisions", valeur: "7", detail: "2 urgentes" }]);
  });

  it("le profil des colonnes : nombre, date, texte, cardinalité", () => {
    expect(profiler(lignes)).toEqual([
      { nom: "societe", type: "texte", distincts: 2 }, { nom: "categorie", type: "texte", distincts: 2 },
      { nom: "mois", type: "date", distincts: 3 }, { nom: "montant", type: "nombre", distincts: 5 },
    ]);
  });
});
