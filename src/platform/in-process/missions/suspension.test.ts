import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "@/lib/prisma";
import { getAccess, type EffectiveAccess } from "@/lib/rbac";
import type { CurrentUser } from "@/lib/session";
import type { ReasonRequest } from "@/lib/missions/ports";
import { avancerMission, lancerMission } from "@/platform/in-process/missions/runtime";
import { conduireHorizon } from "@/platform/in-process/missions/horizon";
import { balayerMissions } from "@/platform/in-process/missions/sweep";
import { RaisonneurScripte, planScripte, pour } from "@/platform/in-process/missions/fake-reasoner";
import {
  ECRAN_REGLAGES_ADAM, lireInterrupteurMissions, type EtatInterrupteurMissions,
} from "@/lib/interrupteurs/missions";
import { chargerEtat } from "@/lib/missions/runtime/store";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * « BLOQUE TOUTES LES MISSIONS D'ADAM » — les quatre lecteurs de l'interrupteur (§118.132).
 *
 * Le moteur, le battement, le lancement et le pilote d'horizon lisent le MÊME fait. Ce banc
 * éprouve chacun par son VRAI point d'entrée (`avancerMission`, `balayerMissions`,
 * `lancerMission`, `conduireHorizon`), avec un lecteur INJECTÉ qui répond « suspendu » — parce
 * que l'interrupteur réel est partagé par toute la suite (§118.115) — puis vérifie que le
 * défaut du lecteur est bien le vrai et qu'aucun appelant de production ne le remplace.
 *
 * La moitié qui rend l'assertion armée (§118.17) : la MÊME mission, avec le vrai lecteur
 * (interrupteur levé), AVANCE jusqu'au bout. Sans cette moitié, un moteur qui n'exécuterait
 * plus rien du tout passerait le banc au vert.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__susp${Date.now()}`;
const SUSPENDU: () => Promise<EtatInterrupteurMissions> = async () => ({
  suspendues: true, depuis: new Date("2026-09-12T08:00:00Z"), parId: "direction",
});

const criteres = ["[REGLE:AUCUNE_ECRITURE] la liste est rendue."];
const jugeSatisfait = pour("mission.judge", (req: ReasonRequest) => {
  const cles = [...req.prompt.matchAll(/^- ([a-z0-9:_#-]+) : /gim)].map((m) => m[1]);
  return { ok: true, data: { satisfied: true, confidence: 0.9, criteria: criteres.map((c) => ({ criterion: c, status: "SATISFAIT", evidenceRefs: cles.slice(0, 3) })), missing: [], contradictions: [], suggestedRecovery: null } };
});
const plan = () => planScripte({
  goal: "Lister le service.", reasoningComplexity: "B", executionScale: "S", acceptanceCriteria: criteres, workstreams: [],
  steps: [
    { key: "liste", title: "Lister", nodeType: "CAPABILITY", capability: "directory_list", inputs: [{ key: "department", kind: "TEXT", value: TAG }, { key: "limit", kind: "NUMBER", value: "10" }], dependsOn: [], completionCondition: "la liste est rendue" },
    { key: "controle", title: "Contrôle", nodeType: "QA", dependsOn: ["liste"], completionCondition: "fini" },
  ],
  expectedArtifacts: [], approvalStrategy: "BUNDLE", completionCriteria: criteres[0], gaps: [], rationale: "banc",
});
const cerveau = () => new RaisonneurScripte([pour("mission.plan", () => ({ ok: true, data: plan() })), jugeSatisfait]);

let pdg: CurrentUser;

suite("l'interrupteur global : quatre lecteurs, un fait", () => {
  beforeAll(async () => {
    const u = await prisma.user.create({
      data: { name: `${TAG} PDG`, email: `${TAG}@amd.dz`, passwordHash: "x", role: "SUPER_ADMIN" },
      select: { id: true, name: true, email: true, role: true },
    });
    pdg = { id: u.id, name: u.name, email: u.email, role: u.role, access: (await getAccess(u.id, u.role)) as EffectiveAccess, mustChangePassword: false };
    // LA PRÉMISSE SE VÉRIFIE : la base de test doit porter l'interrupteur LEVÉ, sinon la moitié
    // « avec le vrai lecteur, la mission avance » ne mesure pas ce qu'elle annonce.
    const reel = await lireInterrupteurMissions();
    if (reel.suspendues) throw new Error("la base de test porte l'interrupteur global POSÉ — lever d'abord (Réglages d'Adam)");
  }, 60_000);

  afterAll(async () => {
    await prisma.mission.deleteMany({ where: { ownerId: pdg.id } }).catch(() => {});
    await prisma.assistantActionIntent.deleteMany({ where: { userId: pdg.id } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: pdg.id } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  }, 60_000);

  it("LE MOTEUR : sous suspension, aucune étape ne tourne et l'état ne bouge pas ; levé, la MÊME mission va au bout", async () => {
    const c = cerveau();
    const r = await lancerMission(pdg, "Liste le service.", { reasoner: c, lectureSeule: true, demarrer: false });
    if (!r.ok) throw new Error(r.error);

    const avant = await chargerEtat(r.missionId);
    const tick = await avancerMission(pdg, r.missionId, { reasoner: c, interrupteur: SUSPENDU });
    expect(tick?.suspenduGlobalement, "le moteur doit DIRE qu'il s'est arrêté sur l'interrupteur").toBe(true);
    expect(tick?.executees).toBe(0);
    const pendant = await chargerEtat(r.missionId);
    expect(pendant!.status).toBe(avant!.status);
    expect(pendant!.steps.map((s) => s.status)).toEqual(avant!.steps.map((s) => s.status));
    // Rien n'a été jugé, donc rien n'a été signalé : ZÉRO notification sous suspension.
    expect(await prisma.missionEvent.count({ where: { missionId: r.missionId, kind: "NOTIFIED" } })).toBe(0);

    // LA MOITIÉ QUI ARME L'ASSERTION : même mission, vrai lecteur, interrupteur levé → elle avance.
    const suite = await avancerMission(pdg, r.missionId, { reasoner: c });
    expect(suite?.suspenduGlobalement ?? false).toBe(false);
    const apres = await chargerEtat(r.missionId);
    expect(apres!.steps.filter((s) => s.status === "DONE").length).toBeGreaterThan(0);
    expect(apres!.status).toBe("COMPLETED");
  }, 120_000);

  it("LE BATTEMENT : sous suspension, il n'examine RIEN — pas une candidate, pas une relance", async () => {
    const c = cerveau();
    const r = await lancerMission(pdg, "Liste le service, encore.", { reasoner: c, lectureSeule: true, demarrer: false });
    if (!r.ok) throw new Error(r.error);
    const passage = await balayerMissions({ interrupteur: SUSPENDU });
    expect(passage.suspendu).toBe(true);
    expect(passage.examinees).toBe(0);
    expect(passage.relances).toBe(0);
    const e = await chargerEtat(r.missionId);
    expect(e!.steps.every((s) => s.status !== "DONE" && s.status !== "RUNNING")).toBe(true);
  }, 60_000);

  it("LE LANCEMENT : refusé AVANT tout appel de modèle, en nommant l'écran qui lève la suspension", async () => {
    const c = cerveau();
    const nAvant = await prisma.mission.count({ where: { ownerId: pdg.id } });
    const r = await lancerMission(pdg, "Liste le service une troisième fois.", {
      reasoner: c, lectureSeule: true, demarrer: false, interrupteur: SUSPENDU,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/suspendues/);
    expect(r.error).toContain(ECRAN_REGLAGES_ADAM);
    expect(c.appelsPour("mission.plan"), "aucune planification payée pour une mission qu'on ne fera pas avancer").toBe(0);
    expect(await prisma.mission.count({ where: { ownerId: pdg.id } })).toBe(nAvant);
  }, 60_000);

  it("LE PILOTE D'HORIZON : sous suspension, aucun sous-plan n'est compilé — le jalon reste une intention", async () => {
    const m = await prisma.mission.create({
      data: { ownerId: pdg.id, title: `${TAG} horizon`, objective: "sept jalons", kind: "RUNTIME", status: "RUNNING" },
      select: { id: true },
    });
    await prisma.missionMilestone.create({
      data: { missionId: m.id, ordre: 1, titre: "Premier jalon", resultat: "un résultat constatable", statut: "PENDING" },
    });
    const c = cerveau();
    const tour = await conduireHorizon(pdg, m.id, { reasoner: c, interrupteur: SUSPENDU });
    expect(tour.arret ?? "").toMatch(/suspendues/);
    expect(tour.compiles).toBe(0);
    expect(c.appelsPour("mission.plan")).toBe(0);
    const jalon = await prisma.missionMilestone.findFirst({ where: { missionId: m.id }, select: { statut: true, planVersion: true } });
    expect(jalon).toEqual({ statut: "PENDING", planVersion: 0 });
    expect(await prisma.missionStep.count({ where: { missionId: m.id } })).toBe(0);
  }, 60_000);

  /**
   * LE POINT D'APPEL, PAS LE CORPS (§118.49). Le lecteur s'injecte pour les bancs ; ce test tient
   * la seule chose qu'un banc ne peut pas prouver en s'injectant : qu'en PRODUCTION, c'est le
   * vrai lecteur qui parle, aux quatre endroits, et qu'aucun appelant ne le remplace.
   */
  it("POINT D'APPEL : les quatre lecteurs lisent le vrai interrupteur, et aucun code de production ne l'injecte", () => {
    const lire = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
    const engine = lire("src/lib/missions/runtime/engine.ts");
    const sweep = lire("src/platform/in-process/missions/sweep.ts");
    const horizon = lire("src/platform/in-process/missions/horizon.ts");
    const runtime = lire("src/platform/in-process/missions/runtime/lancement.ts");

    // Le moteur : le contrôle est DANS la boucle de tours, avant que quoi que ce soit ne démarre.
    expect(engine).toMatch(/deps\.interrupteur \?\? lireInterrupteurMissions/);
    const controle = engine.indexOf("(await lireInterrupteur()).suspendues");
    const demarrage = engine.indexOf("await demarrer(etat);");
    expect(controle).toBeGreaterThan(0);
    expect(controle, "le contrôle doit précéder le démarrage du tour").toBeLessThan(demarrage);

    // Le battement : avant de réveiller, rattraper ou sélectionner quoi que ce soit.
    const lectureSweep = sweep.indexOf("deps.interrupteur ?? lireInterrupteurMissions");
    expect(lectureSweep).toBeGreaterThan(0);
    expect(lectureSweep).toBeLessThan(sweep.indexOf("reveillerAttentesTemporelles(new Date())"));

    // L'horizon : avant la frontière, donc avant toute compilation.
    const lectureHorizon = horizon.indexOf("opts.interrupteur ?? lireInterrupteurMissions");
    expect(lectureHorizon).toBeGreaterThan(0);
    expect(lectureHorizon).toBeLessThan(horizon.indexOf("frontiere(jalons)"));

    // Le lancement : avant l'horizon et la planification.
    const lectureLancement = runtime.indexOf("opts.interrupteur ?? lireInterrupteurMissions");
    expect(lectureLancement).toBeGreaterThan(0);
    expect(lectureLancement).toBeLessThan(runtime.indexOf("tenterHorizon(user, objectif, opts)"));

    // AUCUN appelant de production ne pose `interrupteur:` — seul le passe-plat de l'assembleur
    // (qui transmet ce qu'il a reçu) écrit cette clé. Un lecteur remplacé en production serait un
    // interrupteur désarmé en ayant l'air armé. Le balayage se fait en Node : `grep -E` ne
    // connaît pas le lookahead, et un juge qui plante n'est pas un juge.
    const fautifs: string[] = [];
    const visiter = (dir: string): void => {
      for (const e of readdirSync(dir)) {
        const p = join(dir, e);
        if (statSync(p).isDirectory()) { visiter(p); continue; }
        if (!/\.tsx?$/.test(p) || p.endsWith(".test.ts")) continue;
        // Le lookahead vient AVANT les blancs : placé après `\s*`, le moteur reculait d'un espace
        // et le passe-plat lui-même passait pour une injection (§118.92 — le juge d'abord).
        if (/\binterrupteur:(?!\s*opts\.interrupteur\b)/.test(readFileSync(p, "utf8"))) fautifs.push(p);
      }
    };
    visiter(join(process.cwd(), "src"));
    expect(fautifs, "des fichiers de production injectent un lecteur d'interrupteur").toEqual([]);
  });
});
