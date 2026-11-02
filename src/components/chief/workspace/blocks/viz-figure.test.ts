import { describe, expect, it } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { VIZ_TYPES, type WorkspaceBlock } from "@/platform/ia/workspace/protocol";
import { consignerMesure } from "@/lib/evals/registre";
import { PLANCHE_VIZ } from "../planche-viz";
import { VizFigure } from "@/platform/ia/ecrans/blocks/viz-figure";

/**
 * LE DESSIN (§35) — la figure générique rend les dix-sept formes de la planche sans un composant
 * par graphique : pas de NaN, un titre accessible, un élément par donnée. Ce que l'œil voit dans
 * Playwright, ce test le compte.
 */
type Viz = Extract<WorkspaceBlock, { kind: "viz" }>;
const blocs: Viz[] = PLANCHE_VIZ
  .flatMap((p) => p.composition.blocks)
  .flatMap((b) => (b.kind === "dashboard" ? b.tuiles : [b]))
  .filter((b): b is Viz => b.kind === "viz");
const rendre = (b: Viz) => renderToStaticMarkup(React.createElement(VizFigure, { b }));
const HTML = new Set(["matrice", "arbre", "cartes"]);

describe("la figure générique — dix-sept formes, un rendu", () => {
  it("la planche couvre toutes les formes", () => {
    expect(new Set(blocs.map((b) => b.type)).size).toBe(VIZ_TYPES.length);
  });

  for (const b of blocs) {
    it(`${b.type} — « ${b.title} » se rend sans NaN, avec un titre accessible`, () => {
      const html = rendre(b);
      expect(html).toContain(`data-viz="${b.type}"`);
      expect(html).not.toMatch(/NaN|undefined|Infinity/);
      if (!HTML.has(b.type)) {
        expect(html).toContain("<svg");
        expect(html).toContain('role="img"');
      }
    });
  }

  it("des barres : un rectangle par valeur, la valeur exacte dans le <title> ; la liste téléphone et les données en clair sont là", () => {
    const b = blocs.find((x) => x.type === "barres" && x.title === "Tâches par statut")!;
    const html = rendre(b);
    expect((html.match(/<rect /g) ?? []).length).toBe(5);
    expect(html).toContain("Terminées · Tâches : 61");
    expect(html).toContain("chief-viz-mini");
    expect(html).toContain("Données (5 × 1)");
  });

  it("secteurs : une part par catégorie, le total au centre et les pourcentages en légende", () => {
    const b = blocs.find((x) => x.type === "secteurs" && x.title === "Budget 2026 par enveloppe")!;
    const html = rendre(b);
    expect((html.match(/<path /g) ?? []).length).toBe(5);
    expect(html).toContain(">100<");
    expect(html).toContain("42 %");
  });

  it("gantt : une barre par tâche ; « aujourd'hui » n'apparaît que si la date est dans la plage", () => {
    const b = blocs.find((x) => x.type === "gantt")!;
    const html = rendre(b);
    expect((html.match(/<rect /g) ?? []).length).toBeGreaterThanOrEqual(5);
    const dansLaPlage = new Date().toISOString().slice(0, 10) <= "2026-08-31";
    expect(html.includes("aujourd")).toBe(dansLaPlage);
  });

  it("une courbe dont l'axe ne part pas de zéro le DIT sous l'axe ; une barre part toujours de zéro", () => {
    const courbe: Viz = { kind: "viz", title: "Cours", type: "courbe", donnees: { categories: ["a", "b", "c"], series: [{ label: "v", valeurs: [900, 950, 1000] }] } };
    expect(rendre(courbe)).toMatch(/ne part pas de zéro/);
    const barres: Viz = { ...courbe, type: "barres", axeYdepartZero: false };
    const html = rendre(barres);
    expect(html).not.toMatch(/ne part pas de zéro/);
    // Trois barres dont la plus haute prend toute la hauteur : la plus basse fait 90 % de la plus haute.
    const hauteurs = [...html.matchAll(/<rect [^>]*height="([\d.]+)"/g)].map((m) => Number(m[1]));
    expect(Math.min(...hauteurs) / Math.max(...hauteurs)).toBeCloseTo(0.9, 1);
  });

  it("flux : un ruban par arc, un nœud par identifiant ; réseau : un cercle par nœud", () => {
    const flux = blocs.find((x) => x.type === "flux")!;
    const html = rendre(flux);
    expect((html.match(/<path /g) ?? []).length).toBe(flux.donnees.arcs?.length);
    expect((html.match(/<rect /g) ?? []).length).toBe(flux.donnees.noeuds?.length);
    const graphe = blocs.find((x) => x.type === "graphe")!;
    expect((rendre(graphe).match(/<circle /g) ?? []).length).toBe(graphe.donnees.noeuds?.length);
  });

  it("l'arbre replie au-delà de deux niveaux ; les indicateurs portent leur ton", () => {
    const arbre = blocs.find((x) => x.type === "arbre")!;
    const html = rendre(arbre);
    expect(html).toContain("<details open");
    expect(html).toContain("Congrès");
    const cartes = blocs.find((x) => x.type === "cartes")!;
    expect(rendre(cartes)).toContain("chief-viz-carte-alerte");
  });

  it("LA MESURE §35 : chaque forme de la planche se rend — consignée pour le rapport des cibles", () => {
    let ok = 0;
    for (const b of blocs) {
      try { const html = rendre(b); if (html.includes(`data-viz="${b.type}"`) && !/NaN/.test(html)) ok += 1; } catch { /* compté comme échec */ }
    }
    consignerMesure("representations_rendues", { n: blocs.length, ok }, "components/chief/workspace/blocks/viz-figure.test.ts", `${new Set(blocs.map((b) => b.type)).size} formes`);
    expect(ok).toBe(blocs.length);
  });
});
