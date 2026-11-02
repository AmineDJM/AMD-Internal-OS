import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decouper, lireConfig, RACINES_PAR_TRANCHE, TAS_MO } from "../../../scripts/typecheck-production.mjs";

/**
 * LE TYPECHECK DE PRODUCTION RESTE PAR TRANCHES — lot M2, marge mémoire du build (02/11/2026).
 *
 * `tsc -p tsconfig.build.json` d'un seul tenant demande ≈ 5,5 Go de tas vivant (programme + liaison :
 * 3,0 Go, dont Prisma 1,25 Go) et mourait au hasard sur Render. Le découpage en tranches à tas borné
 * (scripts/typecheck-production.mjs) tient sous 3,5 Go. Ce test garde les trois choses qui, perdues
 * en silence, ramèneraient l'OOM : chaque fichier vérifié UNE fois, les déclarations globales dans
 * CHAQUE tranche, et la chaîne de déploiement qui passe bien par le script.
 */
const RACINE = join(__dirname, "..", "..", "..");
type Decoupage = { declarations: string[]; tranches: string[][] };
const decoupe = decouper as (f: string[], lire: (f: string) => string, n?: number) => Decoupage;

describe("scripts/typecheck-production.mjs — le découpage", () => {
  const lire = (f: string) => ({ "/a/glob.tsx": "export {};\ndeclare global { interface Window { x: 1 } }" } as Record<string, string>)[f] ?? "export const a = 1;";

  it("chaque fichier hors .d.ts est vérifié dans exactement une tranche, tranches contiguës et triées", () => {
    const fichiers = Array.from({ length: 23 }, (_, i) => `/a/f${String(i).padStart(2, "0")}.ts`).reverse();
    const { tranches } = decoupe([...fichiers, "/a/types.d.ts"], lire, 5);
    const tous = tranches.flat();
    expect(tous).toEqual([...fichiers].sort());
    expect(tranches.length).toBe(5);
    expect(Math.max(...tranches.map((t) => t.length))).toBeLessThanOrEqual(5);
  });

  it("les .d.ts et les fichiers à `declare global` / `declare module` vont dans TOUTES les tranches", () => {
    const { declarations, tranches } = decoupe(["/a/b.ts", "/a/glob.tsx", "/a/types.d.ts", "/a/c.ts"], lire, 1);
    expect(declarations.sort()).toEqual(["/a/glob.tsx", "/a/types.d.ts"]);
    // un fichier à augmentation reste AUSSI vérifié dans sa propre tranche ; un .d.ts ne l'est pas (skipLibCheck)
    expect(tranches.flat()).toEqual(["/a/b.ts", "/a/c.ts", "/a/glob.tsx"]);
  });

  it("sur le vrai tsconfig.build.json : couverture totale, tranches sous le plafond", () => {
    const cfg = lireConfig(join(RACINE, "tsconfig.build.json")) as { fileNames: string[] };
    const { declarations, tranches } = decoupe(cfg.fileNames, (f) => readFileSync(f, "utf8"));
    const hors = cfg.fileNames.filter((f) => !f.endsWith(".d.ts"));
    expect(new Set(tranches.flat()).size).toBe(hors.length);
    expect(tranches.flat().length).toBe(hors.length);
    for (const t of tranches) expect(t.length).toBeLessThanOrEqual(RACINES_PAR_TRANCHE);
    expect(declarations.some((f) => f.endsWith("next-auth.d.ts"))).toBe(true);
  }, 30_000);

  it("le tas d'une tranche reste sous la ligne de la cible (4,5 Go)", () => {
    expect(TAS_MO).toBeLessThanOrEqual(4500);
  });
});

describe("la chaîne de déploiement passe par le typecheck par tranches", () => {
  const pkg = JSON.parse(readFileSync(join(RACINE, "package.json"), "utf8")) as { scripts: Record<string, string> };

  it("build:render : lint, typecheck par tranches, puis next build sans typecheck intégré", () => {
    const b = pkg.scripts["build:render"];
    expect(b).toContain("node scripts/typecheck-production.mjs");
    expect(b).not.toMatch(/tsc --noEmit -p tsconfig\.build\.json/);
    expect(b.indexOf("typecheck-production")).toBeLessThan(b.indexOf("next build"));
    expect(b).toMatch(/TYPECHECK_SEPARE=1 .*next build/);
  });

  it("next.config.mjs (un `next build` NU sur Render, §208) lance le même script, pas un tsc d'un seul tenant", () => {
    const cfg = readFileSync(join(RACINE, "next.config.mjs"), "utf8");
    expect(cfg).toContain("scripts/typecheck-production.mjs");
    expect(cfg).not.toMatch(/"--noEmit", "-p", "tsconfig\.build\.json"/);
  });
});
