import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { approuverChantier, proposerChantier } from "@/lib/missions/chantiers/service";
import { lireDossier } from "@/lib/missions/chantiers/dossier";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES CHANTIERS SUR DE VRAIS PROCESSUS (lot C1, décision 0042) — `scripts/bench/chantier-processus.ts`.
 *
 *   • RÉSERVATIONS CONCURRENTES : deux processus partent à la même milliseconde sur la même branche (puis sur deux
 *     périmètres qui se recouvrent) — un seul gagne, l'autre rend le conflit ; jamais les deux.
 *   • SIGKILL EN DEV_ATTENDRE : un processus lance Claude Code puis meurt pendant l'attente des commits (étape « en
 *     cours », bail tenu). Le suivant, horloge avancée au-delà du bail, reprend l'orpheline, voit le commit poussé
 *     pendant la coupure, vérifie, conclut — et ne relance JAMAIS une seconde session (le reçu du lancement le garde).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk && fs.existsSync("node_modules/.bin/tsx") ? describe : describe.skip;

const TAG = `__chp__${Date.now()}`;
const dossierTmp = fs.mkdtempSync(path.join(os.tmpdir(), "chantiers-processus-"));

function processus(env: Record<string, string>) {
  const enfant: ChildProcess = spawn("node_modules/.bin/tsx", ["scripts/bench/chantier-processus.ts"], {
    env: { ...process.env, OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", MISTRAL_API_KEY: "", MIMO_API_KEY: "", mimo: "", ...env },
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

let admin = "";
const missions: string[] = [];

suite("chantiers — vrais processus : réservations concurrentes, reprise après SIGKILL (C1)", () => {
  beforeAll(async () => {
    admin = (await prisma.user.create({ data: { name: `${TAG}Direction`, email: `${TAG}d@t.dz`, passwordHash: "x", role: "SUPER_ADMIN" } })).id;
    for (let i = 0; i < 4; i++) {
      missions.push((await prisma.mission.create({ data: { kind: "CHANTIER", ownerId: admin, principalId: admin, title: `${TAG} m${i}`, objective: "banc", status: "AWAITING_APPROVAL" }, select: { id: true } })).id);
    }
  });

  afterAll(async () => {
    await prisma.mission.deleteMany({ where: { owner: { email: { startsWith: TAG } } } }).catch(() => undefined);
    await prisma.notification.deleteMany({ where: { user: { email: { startsWith: TAG } } } }).catch(() => undefined);
    await prisma.memoireTechnique.deleteMany({ where: { cle: { contains: TAG } } }).catch(() => undefined);
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => undefined);
    fs.rmSync(dossierTmp, { recursive: true, force: true });
  });

  it("deux processus, la même branche puis deux périmètres recouvrants : un seul gagne à chaque fois", { timeout: 120_000 }, async () => {
    const course = async (a: string, b: string, ra: unknown[], rb: unknown[]) => {
      const depart = String(Date.now() + 2_500);
      const [p1, p2] = [processus({ MODE: "reserver", MISSION_ID: a, DEPART_MS: depart, RESSOURCES: JSON.stringify(ra) }), processus({ MODE: "reserver", MISSION_ID: b, DEPART_MS: depart, RESSOURCES: JSON.stringify(rb) })];
      const lire = async (p: ReturnType<typeof processus>) => JSON.parse((await p.attendre(/^RESULTAT /)).slice(9)) as { ok: boolean };
      return Promise.all([lire(p1), lire(p2)]);
    };
    const depot = `aminedjm/${TAG}`.toLowerCase();
    const branche = [{ ressource: "BRANCHE", depot, valeur: "claude/meme" }];
    const r1 = await course(missions[0]!, missions[1]!, branche, branche);
    expect(r1.filter((r) => r.ok)).toHaveLength(1);
    expect(r1.filter((r) => !r.ok)).toHaveLength(1);
    expect(await prisma.chantierReservation.count({ where: { cle: `BRANCHE:${depot}:claude/meme` } })).toBe(1);
    const r2 = await course(missions[2]!, missions[3]!, [{ ressource: "PERIMETRE", depot, valeur: "src/lib/**" }], [{ ressource: "PERIMETRE", depot, valeur: "src/lib/missions/x.ts" }]);
    expect(r2.filter((r) => r.ok)).toHaveLength(1);
    expect(await prisma.chantierReservation.count({ where: { missionId: { in: [missions[2]!, missions[3]!] } } })).toBe(1);
  });

  it("SIGKILL pendant DEV_ATTENDRE : reprise par le processus suivant, aucune seconde session Claude Code, chantier terminé", { timeout: 180_000 }, async () => {
    const branche = `claude/${TAG}-reprise`;
    const p = await proposerChantier(admin, {
      titre: `${TAG} reprise`, objectif: "Survivre à un redéploiement.", depot: { proprietaire: "aminedjm", nom: `${TAG}-depot` }, branche,
      perimetre: ["src/lib/missions/chantiers/**"], criteres: ["vert"], commandesVerif: ["npm test"], fusion: false,
    });
    if (!p.ok) throw new Error(p.fautes.join(" "));
    expect((await approuverChantier(p.chantierId, admin)).ok).toBe(true);
    const journal = path.join(dossierTmp, "reprise.jsonl");
    const t0 = Date.now();
    const premier = processus({ MODE: "conduire", MISSION_ID: p.chantierId, HORLOGE_MS: String(t0), SONDE: "attendre", JOURNAL: journal, BRANCHE: branche });
    await premier.attendre(/^BLOQUE attendre/);
    await premier.tuer();
    const avant = await prisma.missionStep.findFirst({ where: { missionId: p.chantierId, key: "attendre" }, select: { status: true } });
    expect(avant?.status).toBe("RUNNING");
    // Pendant la coupure, la session a poussé son commit. Le processus suivant arrive 11 min plus tard (bail des étapes : 10).
    const second = processus({ MODE: "conduire", MISSION_ID: p.chantierId, HORLOGE_MS: String(t0 + 11 * 60_000), JOURNAL: journal, BRANCHE: branche, POUSSE: "9e9e000000000001" });
    await second.attendre(/^FIN /);
    expect(await second.fin).toBe(0);
    const lignes = fs.readFileSync(journal, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { quoi: string; cle?: string; pid: number });
    expect(lignes.filter((l) => l.quoi === "session")).toHaveLength(1);
    const pids = [...new Set(lignes.map((l) => l.pid))];
    expect(lignes.filter((l) => l.quoi === "session" && l.pid === pids[1])).toEqual([]);
    expect(lignes.filter((l) => l.quoi === "etape" && l.cle === "lancer")).toHaveLength(1);
    const m = await prisma.mission.findUnique({ where: { id: p.chantierId }, select: { status: true, carnet: true } });
    expect(m?.status).toBe("COMPLETED");
    expect(lireDossier(m?.carnet)?.vert?.sha).toBe("9e9e000000000001");
    expect(await prisma.missionEvent.count({ where: { missionId: p.chantierId, kind: "STEP_RECLAIMED" } })).toBeGreaterThan(0);
    expect(await prisma.chantierReservation.count({ where: { missionId: p.chantierId } })).toBe(0);
  });
});
