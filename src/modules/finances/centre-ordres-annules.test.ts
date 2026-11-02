import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";
import { describe, expect, it } from "vitest";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UN ORDRE ANNULÉ N'EST PLUS « EN ATTENTE DU CENTRE » — le cliquet des LECTURES (Direction, 19/10/2026).
 *
 * Retirer une demande de paiement annule son ordre (`status = CANCELLED`) ; son autorisation, jamais rendue, reste
 * « en attente » (`centralStatus = AWAITING`). Toute lecture qui ne regardait que l'autorisation comptait donc la
 * demande retirée : le centre la listait, les compteurs du Chief of Staff et d'Adam l'annonçaient « à autoriser ».
 *
 * Le cliquet lit la source SANS ses commentaires : chaque filtre `centralStatus: "AWAITING"` d'une requête porte sur la
 * même ligne l'exclusion des ordres annulés (`ORDRE_NON_ANNULE`, ou `status: { not: "CANCELLED" }`). Un compteur ajouté
 * demain sans elle fait tomber la suite — il ne recomptera pas les demandes retirées en silence.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const RACINE = join(process.cwd(), "src");

function sansCommentaires(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:\\])\/\/[^\n]*/g, "$1");
}

function fichiers(d: string, out: string[] = []): string[] {
  for (const e of readdirSync(d)) {
    const p = join(d, e);
    if (statSync(p).isDirectory()) fichiers(p, out);
    else if (/\.tsx?$/.test(e) && !/\.test\.tsx?$/.test(e)) out.push(p);
  }
  return out;
}

describe("une lecture « en attente du centre » écarte les ordres annulés", () => {
  const sites: { ou: string; ligne: string }[] = [];
  for (const f of fichiers(RACINE)) {
    const lignes = sansCommentaires(readFileSync(f, "utf8")).split("\n");
    lignes.forEach((l, i) => {
      if (/centralStatus\s*:\s*["']AWAITING["']/.test(l) && /\b(where|AND|count|findMany)\b/.test(l)) {
        sites.push({ ou: `${relative(process.cwd(), f)}:${i + 1}`, ligne: l });
      }
    });
  }

  it("les lectures sont trouvées (un plancher, sans quoi la règle serait verte pour rien)", () => {
    expect(sites.length).toBeGreaterThanOrEqual(5);
  });

  it("chacune porte l'exclusion des ordres annulés", () => {
    const nues = sites.filter((s) => !/ORDRE_NON_ANNULE|status\s*:\s*\{\s*not\s*:\s*["']CANCELLED["']/.test(s.ligne)).map((s) => s.ou);
    expect(nues, "une demande retirée resterait comptée « à autoriser » au centre").toEqual([]);
  });

  it("la file du centre elle-même (`chargerCentre`) exclut les ordres annulés", () => {
    const src = sansCommentaires(readFileSync(join(RACINE, "modules/finances/infra/requetes/centre-paiement.ts"), "utf8"));
    const i = src.indexOf("export async function chargerCentre");
    expect(src.slice(i, i + 900)).toMatch(/ORDRE_NON_ANNULE/);
  });
});
