import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { etape, oublierEchecsEtapes } from "./etape";

beforeEach(() => oublierEchecsEtapes());

describe("etape — une étape planifiée qui échoue est dite et n'arrête pas les suivantes", () => {
  it("ne lève jamais et rend false en cas d'échec", async () => {
    const journal = vi.fn();
    await expect(etape("x", () => { throw new Error("boum"); }, journal)).resolves.toBe(false);
    await expect(etape("y", async () => { throw new Error("boum"); }, journal)).resolves.toBe(false);
    await expect(etape("z", async () => 0, journal)).resolves.toBe(true);
    expect(journal).toHaveBeenCalledTimes(2);
    expect(journal.mock.calls[0][0]).toContain("[scheduled] x");
  });

  it("une série continue après une étape en échec", async () => {
    const vues: string[] = [];
    const journal = vi.fn();
    await etape("a", () => { vues.push("a"); throw new Error("a"); }, journal);
    await etape("b", () => { vues.push("b"); }, journal);
    expect(vues).toEqual(["a", "b"]);
  });

  it("une même erreur répétée n'est réécrite qu'une fois l'heure ; un autre message l'est toujours", async () => {
    const journal = vi.fn();
    let t = 0;
    const horloge = () => t;
    const echec = (m: string) => () => { throw new Error(m); };
    await etape("s", echec("P2022"), journal, horloge);
    t += 60_000;
    await etape("s", echec("P2022"), journal, horloge);
    expect(journal).toHaveBeenCalledTimes(1);
    await etape("s", echec("autre"), journal, horloge);
    expect(journal).toHaveBeenCalledTimes(2);
    t += 61 * 60_000;
    await etape("s", echec("autre"), journal, horloge);
    expect(journal).toHaveBeenCalledTimes(3);
  });
});

describe("runScheduledJobs — chaque étape passe par etape()", () => {
  // Garde de SOURCE : importer scheduled.ts tirerait ~45 modules métier. On lit le corps de la
  // fonction et on exige que chaque `await` soit une étape nommée — ni `await x()` nu (un échec
  // couperait toute la suite du passage), ni `.catch(() => 0)` muet (un échec sans trace).
  const source = readFileSync(join(__dirname, "..", "scheduled.ts"), "utf8");
  const debut = source.indexOf("export async function runScheduledJobs");
  const fin = source.indexOf("\n}\n", debut);
  const corps = source.slice(debut, fin);
  const awaits = corps.split("\n").filter((l) => /^\s*await\s/.test(l));

  it("le corps a bien été trouvé (plancher)", () => {
    expect(debut).toBeGreaterThan(0);
    expect(awaits.length).toBeGreaterThanOrEqual(40);
  });

  it("aucun await hors etape(), aucun catch muet", () => {
    const fautifs = awaits.filter((l) => !/^\s*await etape\("[^"]+", /.test(l));
    expect(fautifs).toEqual([]);
    expect(corps).not.toMatch(/\.catch\(\(\)\s*=>/);
  });
});
