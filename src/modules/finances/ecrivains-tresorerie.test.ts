import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * TOUTE ÉCRITURE DE TRÉSORERIE FIGE SON COMPTE (§118.176).
 *
 * Le solde d'un compte = son ancrage + les écritures qui lui reviennent. Une écriture qui ne fige
 * pas son compte en s'écrivant est rattachée À LA LECTURE par le compte principal du moment —
 * et changer ensuite de compte principal la ferait changer de compte, rétroactivement, avec tous
 * les soldes passés. Neuf écrivains ont été raccordés à la main (règlement d'un ordre, d'une
 * facture, saisie, import, encaissement, paie, transfert de paie, remise et rallonge de caisse) :
 * réparer neuf écrivains ne protège pas le dixième (§118.58). Le cliquet lit la SOURCE et exige
 * `treasuryAccountId` dans CHAQUE appel de création, délimité par ses parenthèses ; la source est
 * lue SANS ses commentaires, sans quoi un commentaire qui cite la clé passerait pour une écriture.
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

function sansCommentaires(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

/** Le texte d'un appel, de sa parenthèse ouvrante à celle qui l'équilibre — chaînes sautées. */
function appel(src: string, ouvrante: number): string {
  let prof = 0;
  for (let i = ouvrante; i < src.length; i += 1) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      const fin = src.indexOf(c, i + 1);
      if (fin < 0) break;
      i = fin;
      continue;
    }
    if (c === "(") prof += 1;
    else if (c === ")") {
      prof -= 1;
      if (prof === 0) return src.slice(ouvrante, i + 1);
    }
  }
  return src.slice(ouvrante);
}

function creations(): { fichier: string; texte: string }[] {
  const out: { fichier: string; texte: string }[] = [];
  for (const f of fichiersDeProduction()) {
    const code = sansCommentaires(readFileSync(f, "utf8"));
    for (const m of code.matchAll(/financeTransaction\s*\.create\(/g)) {
      const ouvrante = (m.index ?? 0) + m[0].length - 1;
      out.push({ fichier: f, texte: appel(code, ouvrante) });
    }
  }
  return out;
}

describe("Cliquet — toute écriture de trésorerie fige son compte", () => {
  it("PLANCHER : le parcours trouve les écrivains — un parcours cassé rendrait le cliquet vert sur rien", () => {
    // 9 → 6 (§118.176), et c'est voulu : la remise de caisse n'écrit plus à la remise (elle passe
    // par le centre, l'écriture se pose au règlement de son ordre) ; le « transfert de la paie au
    // budget », qui écrivait une écriture par salarié hors du centre, n'existe plus ; et « régler la
    // paie » d'un bulletin côté Finances non plus — il sortait l'argent du livre sans le centre.
    // Trois écrivains de moins, et trois décaissements de plus que le centre voit passer.
    // 6 → 5 (§118.202) : la rallonge de caisse n'écrit plus à l'accord — elle devient une remise,
    // et son écriture se pose au règlement de son ordre, par le centre.
    expect(creations().length).toBeGreaterThanOrEqual(5);
  });

  it("chaque création d'écriture écrit `treasuryAccountId` — le refus nomme le fichier", () => {
    const fautifs = creations().filter((c) => !/\btreasuryAccountId\s*:/.test(c.texte)).map((c) => c.fichier);
    expect(fautifs, "écrit une écriture de trésorerie sans figer son compte : son solde changerait avec le compte principal").toEqual([]);
  });

  it("un commentaire qui cite la clé ne compte pas pour une écriture (§118.79d)", () => {
    const leurre = sansCommentaires("prisma.financeTransaction.create({ data: { /* treasuryAccountId: x */ amount: 1 } })");
    expect(/\btreasuryAccountId\s*:/.test(leurre)).toBe(false);
  });
});
