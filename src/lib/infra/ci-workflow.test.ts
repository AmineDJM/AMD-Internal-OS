import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * La CI existe et garde les portes de CLAUDE.md (audit 27/10, INFRA-01). Retirer une étape doit
 * être un diff VISIBLE de ce test, pas un oubli dans un YAML que personne ne relit.
 */
const FICHIER = join(__dirname, "..", "..", "..", ".github", "workflows", "ci.yml");

describe(".github/workflows/ci.yml — la porte avant le déploiement", () => {
  it("le workflow existe", () => {
    expect(existsSync(FICHIER)).toBe(true);
  });

  // Lecture TEXTE, job par job (pas de dépendance YAML directe dans le dépôt) : un job commence à
  // une clé indentée de deux espaces sous `jobs:` et court jusqu'à la suivante.
  const texte = existsSync(FICHIER) ? readFileSync(FICHIER, "utf8") : "";
  const jobs = texte.slice(texte.indexOf("\njobs:\n") + 1);
  const runs = (nom: string) => {
    const m = new RegExp(`^  ${nom}:\\n([\\s\\S]*?)(?=^  [\\w-]+:\\n|$(?![\\s\\S]))`, "m").exec(jobs);
    return m ? m[1] : "";
  };

  it("vérifier : migrations sur base vide, contrat, deux typechecks, lint", () => {
    const r = runs("verifier");
    expect(r).toContain("npx prisma migrate deploy");
    expect(r).toContain("npm run actions:contrat");
    expect(r).toContain("npm run typecheck");
    expect(r).toContain("tsconfig.build.json");
    expect(r).toContain("npx next lint");
    expect(r).toMatch(/image: postgres:16/);
  });

  it("tests : la suite complète contre un Postgres de service, base prouvée joignable avant", () => {
    const r = runs("tests");
    expect(r).toContain("npm test");
    expect(r).toContain("SELECT 1");
    expect(r.indexOf("SELECT 1")).toBeLessThan(r.indexOf("npm test"));
    expect(r).toMatch(/image: postgres:16/);
  });

  it("build : la commande exacte du déploiement, sans cache .next restauré", () => {
    const r = runs("build");
    expect(r).toContain("npm run build:render");
    expect(r).not.toMatch(/actions\/cache/);
  });

  it("Node de la CI = Node de Render (render.yaml NODE_VERSION)", () => {
    const nvmrc = readFileSync(join(__dirname, "..", "..", "..", ".nvmrc"), "utf8").trim();
    const render = readFileSync(join(__dirname, "..", "..", "..", "render.yaml"), "utf8");
    expect(render).toMatch(new RegExp(`key: NODE_VERSION\\s+value: "${nvmrc}"`));
  });
});
