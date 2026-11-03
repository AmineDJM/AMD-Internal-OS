import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { contrat, depotDeBanc, type ForgeGitLocale } from "@/lib/missions/chantiers/integration-test-outils";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * O2-5 (décision 0059) — LA FILE D'INTÉGRATION SUR DE VRAIS PROCESSUS (`scripts/bench/equipe-processus.ts`), un VRAI
 * dépôt git partagé, la base locale :
 *   • DEUX COMPLÉTIONS SIMULTANÉES : deux processus déposent chacun une tâche verte à la même milliseconde et font
 *     avancer la file — une intégration à la fois (la seconde commence après l'avance de la première), deux avances au
 *     total, aucune double fusion, la cible linéaire et verte ;
 *   • SIGKILL EN PLEINE INTÉGRATION (après la fusion dans la branche d'intégration, avant d'écrire l'état) : le processus
 *     suivant, bail échu, REPREND — il retrouve la fusion faite (aucune seconde fusion), vérifie, avance UNE fois.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk && fs.existsSync("node_modules/.bin/tsx") ? describe : describe.skip;

const TAG = `__o2x__${Date.now()}`;
let admin = "";
let programmeId = "";

function processus(env: Record<string, string>) {
  const enfant: ChildProcess = spawn("node_modules/.bin/tsx", ["scripts/bench/equipe-processus.ts"], {
    env: { ...process.env, OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", mimo: "", ADAM_SORTIE_INTERDITE: "1", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const sortie: string[] = [];
  const erreurs: string[] = [];
  enfant.stdout!.on("data", (b: Buffer) => sortie.push(...b.toString().split("\n").filter(Boolean)));
  enfant.stderr!.on("data", (b: Buffer) => erreurs.push(b.toString()));
  const fin = new Promise<number | null>((r) => enfant.on("exit", (code) => r(code)));
  return {
    attendre: async (re: RegExp, ms = 90_000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        const l = sortie.find((x) => re.test(x));
        if (l) return l;
        if (enfant.exitCode !== null) throw new Error(`sorti (${enfant.exitCode}) sans « ${re} » — ${sortie.join(" | ")} ${erreurs.join("").slice(-1500)}`);
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error(`« ${re} » jamais vu — ${sortie.join(" | ")} ${erreurs.join("").slice(-1500)}`);
    },
    tuer: async () => { enfant.kill("SIGKILL"); await fin; },
    fin,
  };
}

/** Un dépôt de banc à deux modules indépendants (a.mjs, b.mjs) : deux tâches qui ne se gênent pas. */
function depotADeuxModules(): ForgeGitLocale {
  const { forge } = depotDeBanc();
  forge.commit("main", { "src/m/a.mjs": "export const a = 1;\n", "src/m/b.mjs": "export const b = 1;\n", "src/lib/actions/contrat.genere.json": contrat(["a.mjs", "b.mjs", "lib.mjs"]) }, "deux modules");
  forge.git("update-ref", "refs/heads/claude/cible", forge.git("rev-parse", "main"));
  return forge;
}

suite("file d'intégration — vrais processus, vrai git (O2-5)", () => {
  beforeAll(async () => {
    admin = (await prisma.user.create({ data: { name: `${TAG}Direction`, email: `${TAG}d@t.dz`, passwordHash: "x", role: "SUPER_ADMIN" } })).id;
    programmeId = (await prisma.mission.create({ data: { kind: "PROGRAMME", ownerId: admin, principalId: admin, title: `${TAG} programme`, objective: "banc", status: "RUNNING" }, select: { id: true } })).id;
  });
  afterAll(async () => {
    await prisma.mission.deleteMany({ where: { owner: { email: { startsWith: TAG } } } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => undefined);
  });

  it("DEUX complétions simultanées, deux processus : une intégration à la fois, deux avances, aucune double fusion", { timeout: 150_000 }, async () => {
    const forge = depotADeuxModules();
    const sa = forge.commit("claude/ta", { "src/m/a.mjs": "export const a = 2;\n" }, "A", "claude/cible");
    const sb = forge.commit("claude/tb", { "src/m/b.mjs": "export const b = 2;\n" }, "B", "claude/cible");
    const depot = `banc/${TAG}-duo`;
    const depart = String(Date.now() + 3_000);
    const commun = { RACINE: forge.racine, DEPOT: depot, CIBLE: "claude/cible", DEPART_MS: depart, PROGRAMME_ID: programmeId };
    const p1 = processus({ ...commun, DEPOSE: JSON.stringify({ chantierId: `${TAG}-a`, tacheCle: "a", branche: "claude/ta", sha: sa }) });
    const p2 = processus({ ...commun, DEPOSE: JSON.stringify({ chantierId: `${TAG}-b`, tacheCle: "b", branche: "claude/tb", sha: sb }) });
    await Promise.all([p1.attendre(/^FIN /), p2.attendre(/^FIN /)]);
    expect([await p1.fin, await p2.fin]).toEqual([0, 0]);
    const entrees = await prisma.integrationFile.findMany({ where: { depot: depot.toLowerCase() }, orderBy: { createdAt: "asc" } });
    expect(entrees.map((e) => e.statut)).toEqual(["FUSIONNEE", "FUSIONNEE"]);
    const journal = forge.journal();
    const avances = journal.filter((j) => j.geste === "avancer");
    expect(avances).toHaveLength(2);
    expect(new Set(avances.map((a) => a.sha)).size).toBe(2);
    // UNE À LA FOIS : la seconde intégration (branche créée, fusion) ne commence qu'APRÈS l'avance de la première.
    const premiereAvance = journal.findIndex((j) => j.geste === "avancer");
    const secondeIntegration = journal.findIndex((j) => j.geste === "creer" || j.geste === "fusionner");
    expect(secondeIntegration).toBeGreaterThan(premiereAvance);
    expect(journal.filter((j) => j.geste === "fusionner")).toHaveLength(1);
    // La cible porte les DEUX tâches, linéairement, et sa CI est verte.
    const tete = forge.git("rev-parse", "claude/cible");
    expect(forge.git("show", `${tete}:src/m/a.mjs`)).toBe("export const a = 2;");
    expect(forge.git("show", `${tete}:src/m/b.mjs`)).toBe("export const b = 2;");
    expect(await forge.checks({ proprietaire: "", nom: "" }, tete)).toMatchObject({ ok: true, valeur: { statut: "vert" } });
  });

  it("SIGKILL après la fusion dans la branche d'intégration : reprise par le processus suivant, aucune seconde fusion, une seule avance", { timeout: 150_000 }, async () => {
    const forge = depotADeuxModules();
    const sy = forge.commit("claude/ty", { "src/m/a.mjs": "export const a = 3;\n" }, "Y", "claude/cible");
    // La cible a bougé depuis le départ de la tâche : il FAUT une fusion (pas d'avance directe).
    forge.commit("claude/cible", { "src/m/b.mjs": "export const b = 9;\n" }, "pendant ce temps");
    const depot = `banc/${TAG}-kill`;
    const commun = { RACINE: forge.racine, DEPOT: depot, CIBLE: "claude/cible", PROGRAMME_ID: programmeId };
    const premier = processus({ ...commun, DEPOSE: JSON.stringify({ chantierId: `${TAG}-y`, tacheCle: "y", branche: "claude/ty", sha: sy }), SONDE: "apres-fusion" });
    await premier.attendre(/^BLOQUE apres-fusion/);
    await premier.tuer();
    const coupee = await prisma.integrationFile.findFirstOrThrow({ where: { depot: depot.toLowerCase() } });
    expect(coupee.statut).toBe("EN_COURS");
    expect(coupee.shaIntegration).toBeNull(); // l'état n'a pas été écrit : seule GitHub (git) sait que la fusion est faite
    expect(forge.journal().filter((j) => j.geste === "fusionner")).toHaveLength(1);
    // Le suivant arrive le bail échu (3 min plus tard sur son horloge).
    const second = processus({ ...commun, DECALAGE_MS: String(3 * 60_000) });
    await second.attendre(/^FIN /);
    expect(await second.fin).toBe(0);
    const fin = await prisma.integrationFile.findFirstOrThrow({ where: { depot: depot.toLowerCase() } });
    expect(fin.statut).toBe("FUSIONNEE");
    const journal = forge.journal();
    expect(journal.filter((j) => j.geste === "fusionner")).toHaveLength(1);
    expect(journal.filter((j) => j.geste === "avancer")).toHaveLength(1);
    expect(new Set(journal.map((j) => j.pid)).size).toBe(2);
    const tete = forge.git("rev-parse", "claude/cible");
    expect(tete).toBe(fin.shaIntegration);
    expect(forge.git("show", `${tete}:src/m/a.mjs`)).toBe("export const a = 3;");
    expect(forge.git("show", `${tete}:src/m/b.mjs`)).toBe("export const b = 9;");
  });
});
