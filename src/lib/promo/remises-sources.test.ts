import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE MATÉRIEL REMIS AUX MÉDECINS A DEUX PORTES, ET DEUX SEULEMENT (§118.173).
 *
 * Décision de la Direction (01/10) : « les MP remis aux médecins doivent être mentionnés soit
 * depuis les postes des événements, des sponsorings, des prises en charge…, soit lors des
 * tournées des KAM, donc dans les rapports terrain ». Le stock devenant un sous-module À PART,
 * la tentation serait d'y ajouter un bouton « Remettre à un médecin » : ce serait une troisième
 * porte, sans visite ni opération derrière — une remise que personne ne pourrait rattacher à ce
 * qui l'a justifiée, et que le rapport de visite comme le poste Ad & Pro ignoreraient.
 *
 * Ce banc tient la chaîne entière, sur la SOURCE (§118.17), sans ses commentaires (§118.79d) :
 *   • TOURNÉES — le seul mouvement « remis à un médecin » (`DISTRIBUTION`) s'écrit dans
 *     `remettreAuMedecin`, qui n'est appelé que par le module des remises de visite, lui-même
 *     appelé par les QUATRE portes d'une visite faite : le rapport d'une visite planifiée, la visite
 *     imprévue, la saisie rapide de « Ma journée », et le compte rendu de visite du module Rapports
 *     terrain (§118.204 — un rapport terrain est un compte rendu de visite, pas une cinquième voie) ;
 *   • OPÉRATIONS AD & PRO — la réservation pour un événement (`RESERVATION_OUT`) et son retour
 *     (`RESERVATION_BACK`) ne s'écrivent que dans leurs deux fonctions, appelées par les seules
 *     actions des postes Ad & Pro.
 * Une porte ajoutée demain — dans le stock, dans une op, n'importe où — fait tomber ce banc en
 * nommant le fichier.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const SRC = join(process.cwd(), "src");

function fichiers(dir: string, acc: string[] = []): string[] {
  for (const nom of readdirSync(dir)) {
    const chemin = join(dir, nom);
    if (statSync(chemin).isDirectory()) fichiers(chemin, acc);
    else if (/\.tsx?$/.test(nom) && !/\.test\.tsx?$/.test(nom)) acc.push(chemin);
  }
  return acc;
}

const sansCommentaires = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");

const PRODUCTION = fichiers(SRC).map((f) => ({ rel: relative(process.cwd(), f).replace(/\\/g, "/"), code: sansCommentaires(readFileSync(f, "utf8")) }));

/** Les fichiers qui APPELLENT `nom(` — une définition (`function nom(`) n'est pas un appel. */
function appelants(nom: string): string[] {
  const appel = new RegExp(`(?<!function\\s)\\b${nom}\\(`);
  return PRODUCTION.filter((f) => appel.test(f.code.replace(new RegExp(`function\\s+${nom}\\(`, "g"), ""))).map((f) => f.rel).sort();
}

/** Les fonctions exportées d'un fichier qui contiennent `motif` dans leur corps. */
function fonctionsContenant(rel: string, motif: RegExp): string[] {
  const f = PRODUCTION.find((x) => x.rel === rel);
  if (!f) return [`(fichier introuvable : ${rel})`];
  const debuts = [...f.code.matchAll(/export\s+async\s+function\s+(\w+)/g)].map((m) => ({ nom: m[1], i: m.index! }));
  const out = new Set<string>();
  for (const m of f.code.matchAll(new RegExp(motif.source, "g"))) {
    const englobante = debuts.filter((d) => d.i < m.index!).at(-1);
    out.add(englobante?.nom ?? "(hors fonction)");
  }
  return [...out].sort();
}

const ECRIVAIN = "src/lib/promo/stock-ecriture.ts";

describe("Remis aux médecins : les tournées", () => {
  it("PRÉMISSE : le parcours lit bien la source (plancher de fichiers)", () => {
    // Un parcours cassé ne trouverait aucun appelant, et le banc passerait au vert sur rien.
    expect(PRODUCTION.length).toBeGreaterThan(500);
    expect(PRODUCTION.some((f) => f.rel === ECRIVAIN)).toBe(true);
  });

  it("le mouvement « remis à un médecin » ne s'écrit que dans `remettreAuMedecin`", () => {
    expect(fonctionsContenant(ECRIVAIN, /kind:\s*"DISTRIBUTION",\s*delta/)).toEqual(["remettreAuMedecin"]);
  });

  it("`remettreAuMedecin` n'est appelé que par le module des remises de visite", () => {
    expect(appelants("remettreAuMedecin")).toEqual(["src/lib/promo/remises-visite.ts"]);
  });

  it("et ce module n'est appelé que par les QUATRE portes d'une visite faite", () => {
    expect(appelants("ecrireRemises")).toEqual([
      "src/lib/actions/field-report-actions.ts", "src/lib/actions/medical-actions.ts", "src/lib/actions/tour-visit-actions.ts",
    ]);
    expect(fonctionsContenant("src/lib/actions/field-report-actions.ts", /\becrireRemises\(/)).toEqual(["submitFieldReport"]);
    expect(fonctionsContenant("src/lib/actions/tour-visit-actions.ts", /\becrireRemises\(/)).toEqual(["ajouterVisiteImprevue", "rapporterVisite"]);
    expect(fonctionsContenant("src/lib/actions/medical-actions.ts", /\becrireRemises\(/)).toEqual(["logVisit"]);
  });
});

describe("Remis aux médecins : les opérations Ad & Pro", () => {
  it("la réservation pour un événement et son retour ne s'écrivent que dans leurs deux fonctions", () => {
    expect(fonctionsContenant(ECRIVAIN, /kind:\s*"RESERVATION_OUT",\s*delta/)).toEqual(["reserverPourEvenement"]);
    expect(fonctionsContenant(ECRIVAIN, /kind:\s*"RESERVATION_BACK",\s*delta/)).toEqual(["rendreAuMagasin"]);
  });

  it("et ces deux fonctions ne sont appelées que par les actions des postes Ad & Pro", () => {
    expect(appelants("reserverPourEvenement")).toEqual(["src/lib/actions/ad-pro-item-actions.ts"]);
    expect(appelants("rendreAuMagasin")).toEqual(["src/lib/actions/ad-pro-item-actions.ts"]);
  });
});
