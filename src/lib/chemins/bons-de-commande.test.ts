import { describe, it, expect, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { CHEMIN_BONS_DE_COMMANDE, MENU_BONS_DE_COMMANDE } from "./bons-de-commande";
import { NAVIGATION } from "@/lib/labels";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE MODULE « BONS DE COMMANDE », À PART — son adresse, son ancienne adresse, et tous ceux qui la
 * citent (§118.176). Les trois propriétés de `chemins/stock-promo` (§118.173), pour la même raison :
 *   1. L'ancienne adresse ne meurt pas : la page d'escale redirige vers le module.
 *   2. AUCUN fichier de production ne réécrit l'ancienne adresse ni l'ancien chemin de menu
 *      (« Finances › Bons de commande ») : une copie oubliée rafraîchirait un écran mort, ou
 *      nommerait un chemin que le menu n'a plus (§118.128).
 *   3. Le chemin de menu que les phrases citent est celui que le MENU dessine : pôle, puis entrée.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

class Redirection extends Error {
  constructor(readonly vers: string) { super(`redirect ${vers}`); }
}
vi.mock("next/navigation", () => ({ redirect: (vers: string) => { throw new Redirection(vers); } }));

const ANCIENNE_ADRESSE = "/finances/bons-de-commande";
const ANCIEN_MENU = "Finances › Bons de commande";

describe("l'ancienne adresse mène au module", () => {
  it("la page d'escale redirige vers le module à part", async () => {
    const { default: Escale } = await import("@/app/(app)/finances/bons-de-commande/page");
    let vers: string | null = null;
    try { Escale(); } catch (e) { if (e instanceof Redirection) vers = e.vers; else throw e; }
    expect(vers).toBe(CHEMIN_BONS_DE_COMMANDE);
  });
});

/** La source SANS ses commentaires : l'histoire racontée en prose a le droit de citer l'ancien chemin (§118.79d). */
function code(f: string): string {
  return readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
}

function fichiers(dir: string): string[] {
  const out: string[] = [];
  for (const nom of readdirSync(dir)) {
    const p = join(dir, nom);
    if (statSync(p).isDirectory()) { out.push(...fichiers(p)); continue; }
    if (!/\.(ts|tsx)$/.test(nom) || /\.(test|spec)\.tsx?$/.test(nom)) continue;
    out.push(p.replace(/\\/g, "/"));
  }
  return out;
}

describe("aucune copie de l'ancienne adresse ni de l'ancien chemin de menu", () => {
  // L'escale est le SEUL fichier qui a le droit d'exister à l'ancienne adresse — et elle ne la
  // cite pas : elle est rangée dessous. Ce fichier-ci (le banc) les cite pour les chercher.
  const SOURCES = fichiers("src").filter((f) => !f.endsWith("chemins/bons-de-commande.ts"));

  it("PLANCHER : le parcours lit le dépôt — un parcours cassé rendrait le cliquet vert sur rien", () => {
    expect(SOURCES.length).toBeGreaterThan(1000);
  });

  it("personne n'écrit plus « /finances/bons-de-commande » — le refus nomme le fichier", () => {
    const fautifs = SOURCES.filter((f) => code(f).includes(`"${ANCIENNE_ADRESSE}"`)).map((f) => relative(".", f));
    expect(fautifs).toEqual([]);
  });

  it("personne ne nomme plus « Finances › Bons de commande » à une personne", () => {
    const fautifs = SOURCES.filter((f) => code(f).includes(ANCIEN_MENU)).map((f) => relative(".", f));
    expect(fautifs).toEqual([]);
  });
});

describe("le menu porte le module à part, au chemin que les phrases citent", () => {
  it("l'entrée « Bons de commande » vit dans le pôle que la phrase nomme, à l'adresse du module", () => {
    const entree = NAVIGATION.find((n) => n.href === CHEMIN_BONS_DE_COMMANDE);
    expect(entree?.module).toBe("PURCHASE_ORDERS");
    const [pole, libelle] = MENU_BONS_DE_COMMANDE.split(" › ");
    expect(libelle).toBe(entree?.label);
    expect(entree?.pole).toBe("ADMINISTRATION");
    expect(pole).toBe("Administration");
  });
});
