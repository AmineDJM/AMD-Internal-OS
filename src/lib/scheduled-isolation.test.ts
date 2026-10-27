import { describe, expect, it, vi } from "vitest";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UNE TÂCHE PLANIFIÉE QUI ÉCHOUE N'AFFAME PAS LES SUIVANTES (audit performance, PERF-03).
 *
 * `runScheduledJobs` enchaîne une cinquantaine de balayages, en série. Sept d'entre eux — dont
 * les TROIS PREMIERS (rappels de réunion, rappels personnels, paie) — n'avaient pas de `.catch` :
 * une seule exception (délai du pool de connexions, colonne manquante après un déploiement
 * partiel, réponse inattendue d'un fournisseur) remontait au `try` global, et TOUT ce qui suit —
 * missions durables, file du site public, alertes de stock, Gmail d'Adam — était sauté. À chaque
 * battement, tant que la cause durait, sans autre trace qu'une ligne « run failed ».
 *
 * Le banc remplace la base par un client qui ÉCHOUE à chaque appel en notant le modèle visé :
 * le premier balayage lève, et les suivants doivent quand même être tentés.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const modelesTentes: string[] = [];
const panne = (): never => { throw new Error("base indisponible (banc)"); };
const clientEnPanne: unknown = new Proxy({}, {
  get(_t, modele: string | symbol) {
    if (typeof modele !== "string") return undefined;
    if (modele.startsWith("$")) return panne;
    return new Proxy({}, {
      get() {
        return () => { modelesTentes.push(modele); return Promise.reject(new Error("base indisponible (banc)")); };
      },
    });
  },
});
vi.mock("@/lib/prisma", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/prisma")>()),
  prisma: clientEnPanne,
}));

describe("runScheduledJobs — chaque balayage est isolé", () => {
  it("le premier balayage lève : les suivants sont tentés quand même", async () => {
    const erreurs = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { runScheduledJobs } = await import("@/lib/scheduled");
    await runScheduledJobs();
    erreurs.mockRestore();
    // Le tout premier balayage (rappels de réunion) a bien été tenté — et a échoué…
    expect(modelesTentes[0]).toBe("meeting");
    // … puis les rappels personnels, la paie, et l'acquisition des congés (étapes 2 à 4).
    expect(modelesTentes).toContain("reminder");
    expect(modelesTentes).toContain("payrollEntry");
    expect(modelesTentes).toContain("employee");
  }, 60_000);
});

describe("runScheduledJobs — le cliquet de forme", () => {
  it("chaque balayage attendu du battement porte son propre .catch", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/lib/scheduled.ts", "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const debut = src.indexOf("export async function runScheduledJobs");
    const corps = src.slice(src.indexOf("try {", debut) + 5, src.indexOf("} catch (err)", debut));
    const nus = corps.split(";").map((x) => x.trim()).filter((x) => /^await\b/.test(x) && !/\.catch\(/.test(x));
    expect(nus, "un balayage sans .catch saute tous les suivants s'il lève").toEqual([]);
  });
});
