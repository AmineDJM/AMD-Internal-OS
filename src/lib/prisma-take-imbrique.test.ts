import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UN `take` SUR UNE RELATION SOUS UN `findMany` N'EST PAS UN `LIMIT` (audit performance PERF-01, PERF-08).
 *
 * Prisma 5 (sans la préversion `relationJoins`) charge une relation 1-N d'une LISTE de parents par une
 * seconde requête `WHERE parentId IN (…)` — SANS `LIMIT` : le `take` par parent est appliqué EN MÉMOIRE.
 * `messages: { take: 1 }` sous 40 conversations rapatriait donc leurs 20 000 messages, corps compris, à
 * chaque sondage de la coque (PERF-01, mesuré). Pour « les N derniers X de chaque Y » : une requête
 * `LATERAL … LIMIT N` (exemple : `derniersMessagesParConversation`, `queries/messaging.ts`).
 *
 * Le cliquet recense, par l'AST, chaque `take` posé dans une relation imbriquée de l'argument d'un
 * `.findMany(…)`. Beaucoup de ces relations sont petites par nature (les membres d'un groupe, les étapes
 * d'un circuit) : le plafond ne juge pas, il empêche la dette de grandir. Il ne peut que BAISSER — le
 * remplacer par le compte mesuré quand un site est corrigé.
 *
 * Ce qu'il ne voit pas : un argument construit ailleurs puis passé par variable. Assumé (§118.17) —
 * il attrape la forme qui est tombée.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** PLAFOND MESURÉ le 2026-10-28 (après correction d'Adam « Conversations consultées »). */
const PLAFOND = 33;

const RACINE = join(process.cwd(), "src");

function fichiers(dir: string, acc: string[] = []): string[] {
  for (const nom of readdirSync(dir)) {
    const chemin = join(dir, nom);
    if (statSync(chemin).isDirectory()) fichiers(chemin, acc);
    else if (/\.tsx?$/.test(nom) && !/\.test\.tsx?$/.test(nom)) acc.push(chemin);
  }
  return acc;
}

/** Les `take` d'un objet de requête, à partir de la profondeur 1 (le `take` de premier niveau est un vrai LIMIT). */
function takesImbriques(objet: ts.ObjectLiteralExpression, profondeur: number, out: ts.Node[]): void {
  for (const p of objet.properties) {
    if (!ts.isPropertyAssignment(p)) continue;
    const nom = p.name.getText();
    if (nom === "take" && profondeur > 0) out.push(p);
    if (ts.isObjectLiteralExpression(p.initializer)) {
      // `include` / `select` ne changent pas de niveau ; une relation nommée, si.
      const descend = nom === "include" || nom === "select" ? 0 : 1;
      // `where` décrit un filtre, pas un chargement : un `take` n'y vit pas.
      if (nom !== "where" && nom !== "orderBy") takesImbriques(p.initializer, profondeur + descend, out);
    }
  }
}

function recenser(): string[] {
  const sites: string[] = [];
  for (const f of fichiers(RACINE)) {
    const texte = readFileSync(f, "utf8");
    if (!texte.includes("findMany(")) continue;
    const source = ts.createSourceFile(f, texte, ts.ScriptTarget.Latest, true, f.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const visiter = (n: ts.Node): void => {
      if (
        ts.isCallExpression(n)
        && ts.isPropertyAccessExpression(n.expression)
        && n.expression.name.text === "findMany"
        && n.arguments[0]
        && ts.isObjectLiteralExpression(n.arguments[0])
      ) {
        const trouves: ts.Node[] = [];
        takesImbriques(n.arguments[0], 0, trouves);
        for (const t of trouves) sites.push(`${relative(process.cwd(), f)}:${source.getLineAndCharacterOfPosition(t.getStart()).line + 1}`);
      }
      ts.forEachChild(n, visiter);
    };
    visiter(source);
  }
  return sites;
}

describe("Prisma — `take` imbriqué sous un findMany (LIMIT en mémoire)", () => {
  const sites = recenser();

  it("PRÉMISSE : le recenseur voit la forme (plancher)", () => {
    expect(sites.length).toBeGreaterThanOrEqual(10);
  });

  it(`au plus ${PLAFOND} sites — et le plafond ne fait que baisser`, () => {
    expect(sites.length, sites.join("\n")).toBeLessThanOrEqual(PLAFOND);
  });

  it("les sondages de la messagerie et Adam « Conversations consultées » ne bornent plus les messages en mémoire", () => {
    expect(sites.filter((s) => s.startsWith("src/lib/queries/messaging.ts"))).toEqual([]);
    // Les membres (6) et l'étape en attente (1) d'une demande restent : des relations petites par nature.
    const lectures = readFileSync(join(RACINE, "modules/assistant-ia/infra/lectures.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(lectures).not.toMatch(/messages:\s*\{[^}]*\btake:/);
  });
});
