import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { cibleInterne, specificateurs } from "@/platform/imports";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UNE RÉFÉRENCE NUMÉROTÉE NAÎT D'UN COMPTEUR, PLUS DU MAXIMUM (§118.175, puis audit 27/10/2026, DONNEES-12).
 *
 * `buildRef` lisait les références existantes et rendait la suivante : deux créations à la même seconde lisaient
 * le MÊME maximum et la seconde heurtait la contrainte d'unicité — d'où le filet (`createWithRetry`, `enSerie`)
 * que ce cliquet imposait, avec une DETTE de neuf fichiers qui n'en portaient pas. Le maximum avait deux autres
 * défauts : un coût O(n) à chaque création, et une référence REPRISE après une suppression réversible (la
 * restauration échouait, ADPRO-08).
 *
 * Depuis DONNEES-12, chaque série passe par `referenceDeSerie` (`refs.ts`) : un compteur avancé atomiquement en
 * base, qui ne rend jamais un numéro. Le cliquet devient plus strict, pas plus lâche :
 *   1. PLUS AUCUN fichier de production ne numérote par le maximum (`buildRef(`) — la dette est soldée, à zéro ;
 *   2. un écrivain qui prendrait encore le maximum à la main reprendrait un numéro que le compteur va donner :
 *      la règle 1 l'interdit ;
 *   3. l'écrivain de tout décaissement garde son filet, création par création (cas ci-dessous, §118.182).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

function fichiersDeProduction(dir = "src"): string[] {
  const out: string[] = [];
  for (const nom of readdirSync(dir)) {
    const p = join(dir, nom);
    if (statSync(p).isDirectory()) { out.push(...fichiersDeProduction(p)); continue; }
    if (!/\.(ts|tsx)$/.test(nom) || /\.(test|spec)\.tsx?$/.test(nom)) continue;
    out.push(p);
  }
  return out;
}

/** La source SANS commentaires : un commentaire qui cite `createWithRetry(` ne pose aucun filet (§118.79d). */
function sansCommentaires(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

const AU_MAXIMUM = /(?<!function\s)\bbuildRef\(/;
const AU_COMPTEUR = /(?<!function\s)\breferenceDeSerie\(/;

function etat() {
  const auMaximum: string[] = [];
  const auCompteur: string[] = [];
  for (const f of fichiersDeProduction()) {
    const rel = relative(process.cwd(), f).replace(/\\/g, "/");
    // `refs.ts` DÉFINIT les deux fonctions : il ne numérote rien lui-même.
    if (rel === "src/lib/refs.ts") continue;
    const code = sansCommentaires(readFileSync(f, "utf8"));
    if (AU_MAXIMUM.test(code)) auMaximum.push(rel);
    if (AU_COMPTEUR.test(code)) auCompteur.push(rel);
  }
  return { auMaximum, auCompteur };
}

describe("Cliquet — une référence numérotée naît du compteur de sa série", () => {
  it("PLANCHER : le parcours trouve les fichiers qui numérotent — un parcours cassé rendrait le cliquet vert sur rien", () => {
    expect(etat().auCompteur.length).toBeGreaterThanOrEqual(20);
  });

  it("plus aucun fichier ne numérote par le maximum (dette soldée : 9 → 0)", () => {
    expect(etat().auMaximum, "numérote par buildRef : reprendrait un numéro que le compteur de la série va donner — passer par referenceDeSerie").toEqual([]);
  });

  it("les créations réparées au §118.175 numérotent au compteur, et gardent leur filet", () => {
    const { auCompteur } = etat();
    for (const f of ["src/lib/actions/sponsoring-actions.ts", "src/lib/dossiers-core.ts", "src/lib/actions/ad-pro-item-actions.ts"]) {
      expect(auCompteur, `${f} ne numérote plus au compteur`).toContain(f);
      expect(/\b(createWithRetry|enSerie)\(/.test(sansCommentaires(readFileSync(f, "utf8"))), `${f} a perdu son filet`).toBe(true);
    }
  });

  it("L'ÉCRIVAIN DE TOUT DÉCAISSEMENT porte un filet sur CHACUNE de ses créations numérotées (§118.182)", () => {
    // Le cliquet ci-dessus juge par FICHIER, et c'est ce qui l'a rendu aveugle : `expense-orders.ts`
    // portait un filet — sur le dossier compagnon — pendant que la création de l'ORDRE, le seul passage
    // de tout l'argent qui sort, n'en avait aucun. Ce fichier-là se juge création par création.
    const avantLaCreation = (fichier: string, modele: string) => {
      const code = sansCommentaires(readFileSync(fichier, "utf8"));
      const i = code.search(new RegExp(`prisma\\.${modele}\\.create\\(`));
      expect(i, `${fichier} : ${modele}.create introuvable`).toBeGreaterThan(0);
      return code.slice(Math.max(0, i - 160), i);
    };
    for (const [modele, serie] of [["expenseOrder", "SERIE_ORDRES"], ["paymentRequest", "SERIE_DEMANDES_PAIEMENT"]] as const) {
      const avant = avantLaCreation("src/modules/finances/infra/expense-orders.ts", modele);
      expect(avant, `${modele} : la création doit être DANS l'essai — la référence se recalcule à chaque tentative`).toMatch(/createWithRetry\(\s*async\s*\(\)\s*=>\s*$/);
      expect(avant, `${modele} : et dans la file de SA série`).toMatch(new RegExp(`enSerie\\(\\s*${serie}\\s*,\\s*\\(\\)\\s*=>\\s*createWithRetry\\(`));
    }
    // LA SÉRIE PAY A DEUX CRÉATEURS : une file chacun n'en protégerait que la moitié.
    expect(avantLaCreation("src/modules/finances/actions-demandes.ts", "paymentRequest"), "la demande de paiement partage la file PAY")
      .toMatch(/enSerie\(\s*SERIE_DEMANDES_PAIEMENT\s*,\s*\(\)\s*=>\s*createWithRetry\(/);
  });
});
