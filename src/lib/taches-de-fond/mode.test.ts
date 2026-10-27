import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { battementWebArme, executeurAutorise, lireModeTachesDeFond, modeInconnu } from "./mode";

/**
 * L'INTERRUPTEUR `TACHES_DE_FOND` (refonte V2-F). Le défaut doit être EXACTEMENT la production
 * d'avant le lot (le web bat), et aucune valeur — même fausse — ne doit laisser la production
 * sans battement.
 */

describe("l'interrupteur TACHES_DE_FOND", () => {
  it("défaut : web — rien ne change tant que personne ne le pose", () => {
    expect(lireModeTachesDeFond(undefined)).toBe("web");
    expect(lireModeTachesDeFond("")).toBe("web");
  });

  it("lit les trois modes, tolère la casse et les espaces", () => {
    expect(lireModeTachesDeFond("worker")).toBe("worker");
    expect(lireModeTachesDeFond(" Les-Deux ")).toBe("les-deux");
    expect(lireModeTachesDeFond("WEB")).toBe("web");
  });

  it("une coquille retombe sur web (jamais sur le silence) et se signale", () => {
    expect(lireModeTachesDeFond("workers")).toBe("web");
    expect(modeInconnu("workers")).toBe(true);
    expect(modeInconnu(undefined)).toBe(false);
    expect(modeInconnu("worker")).toBe(false);
  });

  it("qui bat sous quel mode", () => {
    expect(executeurAutorise("web", "web")).toBe(true);
    expect(executeurAutorise("web", "worker")).toBe(false);
    expect(executeurAutorise("worker", "web")).toBe(false);
    expect(executeurAutorise("worker", "worker")).toBe(true);
    expect(executeurAutorise("les-deux", "web")).toBe(true);
    expect(executeurAutorise("les-deux", "worker")).toBe(true);
  });
});

describe("le battement web s'arme-t-il ?", () => {
  const prod = { NODE_ENV: "production" } as NodeJS.ProcessEnv;

  it("en production sans variable : oui (comportement d'avant V2-F)", () => {
    expect(battementWebArme(prod, "web")).toBe(true);
  });

  it("TACHES_DE_FOND=worker : le web se tait", () => {
    expect(battementWebArme({ ...prod, TACHES_DE_FOND: "worker" }, "web")).toBe(false);
  });

  it("TACHES_DE_FOND=les-deux : le web bat aussi (le bail départage)", () => {
    expect(battementWebArme({ ...prod, TACHES_DE_FOND: "les-deux" }, "web")).toBe(true);
  });

  it("jamais dans le processus worker, quel que soit le mode — il a sa propre boucle", () => {
    for (const m of ["web", "worker", "les-deux"]) expect(battementWebArme({ ...prod, TACHES_DE_FOND: m }, "worker")).toBe(false);
  });

  it("les soupapes historiques tiennent toujours : SCHEDULER_DISABLED, tests, compilation", () => {
    expect(battementWebArme({ ...prod, SCHEDULER_DISABLED: "1" }, "web")).toBe(false);
    expect(battementWebArme({ ...prod, VITEST: "true" }, "web")).toBe(false);
    expect(battementWebArme({ NODE_ENV: "test" } as NodeJS.ProcessEnv, "web")).toBe(false);
    expect(battementWebArme({ ...prod, NEXT_PHASE: "phase-production-build" }, "web")).toBe(false);
  });

  it("le réveil web (`runScheduledJobs`) obéit au même interrupteur que le battement", () => {
    // Lu dans le source : importer `scheduled.ts` tirerait toute la chaîne des tâches pour une garde.
    const src = readFileSync("src/lib/scheduled.ts", "utf8");
    const corps = src.slice(src.indexOf("export async function runScheduledJobs"), src.indexOf("export function executerTachesPlanifiees"));
    expect(corps).toMatch(/if \(executeurDuProcessus\(\) !== "web"\) return;/);
    expect(corps).toMatch(/if \(!executeurAutorise\(lireModeTachesDeFond\(\), "web"\)\) return;/);
    expect(src).toMatch(/function armHeartbeat\(\): void \{\s*if \(!battementWebArme\(\)\) return;/);
  });
});

describe("le point d'entrée du worker", () => {
  it("se déclare worker AVANT de charger la chaîne des tâches (sinon il armerait le battement web)", () => {
    const src = readFileSync("scripts/worker.ts", "utf8");
    const declaration = src.indexOf("declarerProcessusWorker();");
    const chargement = src.indexOf('await import("../src/lib/scheduled")');
    expect(declaration).toBeGreaterThan(-1);
    expect(chargement).toBeGreaterThan(declaration);
    // Et aucun import STATIQUE de la chaîne : il serait hissé avant la déclaration.
    expect(src).not.toMatch(/^import .*lib\/scheduled/m);
  });

  it("est branché : `npm run worker` et le service Render", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts.worker).toBe("tsx scripts/worker.ts");
    const render = readFileSync("render.yaml", "utf8");
    expect(render).toMatch(/startCommand: npm run worker/);
  });
});
