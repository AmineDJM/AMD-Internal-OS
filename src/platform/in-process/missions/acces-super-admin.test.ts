import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "@/lib/prisma";
import { getAccess, REFUS_MISSIONS_ADAM, type EffectiveAccess } from "@/lib/rbac";
import type { CurrentUser } from "@/lib/session";
import type { ReasonRequest } from "@/lib/missions/ports";
import { lancerEnArrierePlan, lancerMission } from "@/platform/in-process/missions/runtime";
import { balayerMissions } from "@/platform/in-process/missions/sweep";
import { balayerSurveillances, creerSurveillance } from "@/platform/in-process/missions/watch";
import { MOTIF_HORS_DROIT } from "@/platform/in-process/missions/habilitation";
import { lireInterrupteurMissions } from "@/lib/interrupteurs/missions";
import { RaisonneurScripte, planScripte, pour } from "@/platform/in-process/missions/fake-reasoner";

/**
 * ═══════════════════════════════════════════════════════════
 * LES MISSIONS D'ADAM SONT RÉSERVÉES AU SUPER ADMIN (§118.136) — par les VRAIS points d'entrée.
 *
 * Décision de la Direction : « Missions d'Adam etc. doit être dispo que pour le super admin ».
 * Ce banc joue les deux moitiés de la règle, et il faut les deux :
 *
 *   1. LA PORTE — un compte DIRECTION (vue globale, siège au centre de paiement, tout sauf
 *      Super Admin) ne peut ni lancer une mission, ni en détacher une, ni poser une surveillance.
 *      Le refus vient AVANT toute écriture : on compte les lignes, pas seulement le `ok: false`.
 *   2. L'AUTORITÉ RELUE — une mission ou une surveillance DÉJÀ EN BASE dont le propriétaire perd
 *      le droit (mutation, rétrogradation) passe en PAUSE au battement suivant, motif au journal,
 *      jamais supprimée (§118.119b). Sans cette moitié, une planification serait une permission
 *      qui survit à la règle : le moteur exécuterait au nom de quelqu'un qu'elle a exclu.
 *
 * Et un troisième groupe, qui ne s'exécute pas : les POINTS D'APPEL (§118.49). Une garde écrite
 * dans un module et absente de l'endroit qui décide est du code mort qui a l'air armé ; on lit
 * donc chaque porte à sa place exacte — le menu, les deux pages, les quinze actions, les six
 * outils, le moteur, le battement, l'interrupteur.
 * ═══════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__sa${Date.now()}`;
const RACINE = join(process.cwd(), "src");
const lire = (p: string) => readFileSync(join(RACINE, p), "utf8");

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

async function acteur(role: "SUPER_ADMIN" | "DIRECTION", nom: string): Promise<CurrentUser> {
  const u = await prisma.user.create({
    data: { name: `${TAG} ${nom}`, email: `${TAG}${nom.toLowerCase()}@amd.dz`, passwordHash: "x", role },
    select: { id: true, name: true, email: true, role: true },
  });
  return { id: u.id, name: u.name, email: u.email, role: u.role, access: (await getAccess(u.id, u.role)) as EffectiveAccess, mustChangePassword: false };
}

let pdg: CurrentUser;
let direction: CurrentUser;
let taskId = "";

suite("§118.136 — la porte : la Direction ne lance rien, ne détache rien, ne surveille rien", () => {
  beforeAll(async () => {
    pdg = await acteur("SUPER_ADMIN", "PDG");
    direction = await acteur("DIRECTION", "Direction");
    const t = await prisma.task.create({
      data: { title: `${TAG} Relire le contrat Sofradis`, status: "TODO", dueDate: new Date(Date.now() + 3 * 86_400_000), assignedToId: pdg.id, createdById: pdg.id },
      select: { id: true },
    });
    taskId = t.id;
    const reel = await lireInterrupteurMissions();
    if (reel.suspendues) throw new Error("la base de test porte l'interrupteur global POSÉ — lever d'abord (Réglages d'Adam)");
  }, 60_000);

  afterAll(async () => {
    for (const u of [pdg, direction]) {
      await prisma.adamWatch.deleteMany({ where: { ownerId: u.id } }).catch(() => {});
      await prisma.mission.deleteMany({ where: { ownerId: u.id } }).catch(() => {});
      await prisma.assistantActionIntent.deleteMany({ where: { userId: u.id } }).catch(() => {});
      await prisma.notification.deleteMany({ where: { userId: u.id } }).catch(() => {});
    }
    await prisma.businessEvent.deleteMany({ where: { entityType: "TASK", entityId: taskId } }).catch(() => {});
    await prisma.task.deleteMany({ where: { id: taskId } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  }, 60_000);

  it("lancerMission REFUSE la Direction avant toute écriture, et le refus nomme la règle", async () => {
    const avant = await prisma.mission.count({ where: { ownerId: direction.id } });
    const r = await lancerMission(direction, "Liste le service et écris-moi.", { reasoner: cerveau(), lectureSeule: true, demarrer: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe(REFUS_MISSIONS_ADAM);
    expect(await prisma.mission.count({ where: { ownerId: direction.id } })).toBe(avant);
    // LA MOITIÉ QUI ARME L'ASSERTION : le même appel, par le Super Admin, écrit une mission.
    const ok = await lancerMission(pdg, "Liste le service.", { reasoner: cerveau(), lectureSeule: true, demarrer: false });
    expect(ok.ok, ok.ok ? "" : ok.error).toBe(true);
  }, 120_000);

  it("lancerEnArrierePlan REFUSE pareil : aucun talon n'est écrit pour quelqu'un qui n'y a pas droit", async () => {
    const avant = await prisma.mission.count({ where: { ownerId: direction.id } });
    const r = await lancerEnArrierePlan(direction, "Lister l'annuaire", { reasoner: cerveau() });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe(REFUS_MISSIONS_ADAM);
    expect(await prisma.mission.count({ where: { ownerId: direction.id } })).toBe(avant);
  }, 60_000);

  it("creerSurveillance REFUSE la Direction sans résoudre de cible, et n'écrit aucune surveillance", async () => {
    const avant = await prisma.adamWatch.count({ where: { ownerId: direction.id } });
    const r = await creerSurveillance(direction, { reference: `${TAG} Relire le contrat Sofradis` });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.raison).toBe(REFUS_MISSIONS_ADAM);
      expect(r.candidats).toEqual([]);
    }
    expect(await prisma.adamWatch.count({ where: { ownerId: direction.id } })).toBe(avant);
  }, 60_000);
});

suite("§118.136 — l'autorité relue : ce qui tournait pour quelqu'un qui perd le droit s'arrête, en le disant", () => {
  let pdg2: CurrentUser;
  let missionId = "";
  let watchMissionId = "";
  let watchId = "";

  beforeAll(async () => {
    pdg2 = await acteur("SUPER_ADMIN", "Rétrogradé");
    const reel = await lireInterrupteurMissions();
    if (reel.suspendues) throw new Error("la base de test porte l'interrupteur global POSÉ — lever d'abord (Réglages d'Adam)");

    // UNE MISSION VIVANTE, prête à avancer (étapes PENDING), lancée quand le compte était Super Admin.
    const r = await lancerMission(pdg2, "Liste le service, encore.", { reasoner: cerveau(), lectureSeule: true, demarrer: false });
    if (!r.ok) throw new Error(r.error);
    missionId = r.missionId;

    // UNE SURVEILLANCE VIVANTE, sur une tâche du compte, échue depuis longtemps.
    const t = await prisma.task.create({
      data: { title: `${TAG} Dossier ANPP à relire`, status: "TODO", dueDate: new Date(Date.now() + 5 * 86_400_000), assignedToId: pdg2.id, createdById: pdg2.id },
      select: { id: true },
    });
    const w = await creerSurveillance(pdg2, { reference: `${TAG} Dossier ANPP à relire` });
    if (!w.ok) throw new Error(`surveillance non créée : ${w.raison}`);
    watchId = w.id; watchMissionId = w.missionId;
    await prisma.adamWatch.update({ where: { id: watchId }, data: { nextCheckAt: new Date("2000-01-01T00:00:00Z") } });
    void t;

    // LA RÉTROGRADATION : le compte n'est plus Super Admin. Rien d'autre ne change.
    await prisma.user.update({ where: { id: pdg2.id }, data: { role: "DIRECTION" } });
  }, 120_000);

  afterAll(async () => {
    await prisma.adamWatch.deleteMany({ where: { ownerId: pdg2.id } }).catch(() => {});
    await prisma.mission.deleteMany({ where: { ownerId: pdg2.id } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: pdg2.id } }).catch(() => {});
    await prisma.task.deleteMany({ where: { title: { startsWith: TAG } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: pdg2.id } }).catch(() => {});
  }, 60_000);

  it("LE BATTEMENT met la mission en PAUSE, motif au journal — il ne conduit rien en son nom", async () => {
    /**
     * CE QUI FERAIT TOMBER CE TEST : retirer `proprietaireHabilite` du battement. La mission
     * avancerait (étapes DONE, COMPLETED) au nom d'un compte que la règle exclut — le faux
     * succès exact que cette moitié de la règle existe pour fermer.
     */
    // La borne `seulement` est celle du BANC (§118.136) : sans elle, ce passage conduirait les
    // missions des autres bancs de la base partagée avec le vrai raisonneur — et c'est arrivé.
    const bilan = await balayerMissions({ seulement: [missionId] });
    expect(bilan.suspenduesHorsDroit, "le bilan du battement doit compter ce qu'il a fermé").toBeGreaterThanOrEqual(1);
    const m = await prisma.mission.findUnique({ where: { id: missionId }, select: { status: true, pausedReason: true, pausedFrom: true, steps: { select: { status: true } } } });
    expect(m!.status).toBe("PAUSED");
    expect(m!.pausedReason).toBe(MOTIF_HORS_DROIT);
    expect(m!.pausedFrom).not.toBeNull();
    expect(m!.steps.filter((s) => s.status === "DONE"), "aucune étape ne doit avoir tourné").toHaveLength(0);
    const journal = await prisma.missionEvent.findFirst({ where: { missionId, kind: "PAUSED" }, select: { summary: true, detail: true, actorId: true } });
    expect(journal?.summary).toContain(MOTIF_HORS_DROIT);
    expect((journal?.detail as { horsDroit?: boolean } | null)?.horsDroit).toBe(true);
    // C'est le MOTEUR qui suspend, au nom d'une règle : la pause n'est pas attribuée au propriétaire.
    expect(journal?.actorId).toBeNull();
  }, 180_000);

  it("LE BALAYAGE DES SURVEILLANCES suspend la surveillance (mission-support en pause), sans la CLORE", async () => {
    /**
     * CE QUI FERAIT TOMBER CE TEST : traiter le propriétaire sans droit comme un propriétaire
     * inactif — la surveillance serait CLOSE, et la personne ne saurait jamais pourquoi ; ou
     * l'ignorer, et une surveillance relirait sa cible et notifierait au nom d'un compte exclu.
     */
    await balayerSurveillances(new Date(), { seulement: [watchId] });
    const w = await prisma.adamWatch.findUnique({ where: { id: watchId }, select: { status: true, closeReason: true } });
    expect(w!.status).toBe("ACTIVE");
    expect(w!.closeReason).toBeNull();
    const m = await prisma.mission.findUnique({ where: { id: watchMissionId }, select: { status: true, pausedReason: true, kind: true } });
    expect(m!.kind).toBe("WATCH");
    expect(m!.status).toBe("PAUSED");
    expect(m!.pausedReason).toBe(MOTIF_HORS_DROIT);
  }, 120_000);
});

describe("§118.136 — les POINTS D'APPEL : la garde est là où l'on décide, pas seulement où on l'a écrite", () => {
  it("le menu : l'entrée du Centre porte la garde `adamMissions`, résolue sur le prédicat", () => {
    const labels = lire("lib/labels/navigation.ts");
    const ligne = labels.split("\n").find((l) => l.includes('href: "/centre-de-missions"') && l.includes("module:"));
    expect(ligne, "l'entrée de navigation du Centre de missions").toBeDefined();
    expect(ligne).toContain('gate: "adamMissions"');
    expect(labels).toMatch(/gate\?: [^;]*"adamMissions"/);
    expect(lire("lib/nav-access.ts")).toContain("adamMissions: peutPiloterMissionsAdam(user)");
  });

  it("les deux pages refusent AVANT de charger quoi que ce soit", () => {
    for (const [page, chargement] of [
      ["app/(app)/centre-de-missions/page.tsx", "centreDeMissions(user.id)"],
      ["app/(app)/missions/[id]/page.tsx", "vueMission(params.id, user.id)"],
    ] as const) {
      const src = lire(page);
      const garde = src.indexOf("if (!peutPiloterMissionsAdam(user)) notFound();");
      expect(garde, `${page} : la garde manque`).toBeGreaterThan(0);
      expect(garde, `${page} : la garde doit précéder le chargement`).toBeLessThan(src.indexOf(chargement));
    }
  });

  it("CHAQUE action serveur du runtime commence par le prédicat — plus aucune ne s'ouvre sur le module WORKSPACE", () => {
    const src = lire("lib/actions/mission-runtime-actions.ts");
    expect(src).not.toContain('userCan(user, "WORKSPACE"');
    const blocs = src.split(/\nexport async function /).slice(1);
    expect(blocs.length).toBeGreaterThanOrEqual(15);
    for (const b of blocs) {
      const nom = b.slice(0, b.indexOf("("));
      expect(b, `${nom} ne lit pas peutPiloterMissionsAdam`).toContain("peutPiloterMissionsAdam(user)");
    }
  });

  it("les six outils de conversation sont gardés par le prédicat, et leur refus nomme la règle", () => {
    const bc = lire("lib/assistant/business-capabilities.ts");
    for (const outil of ["mission_status", "run_mission", "mission_control"]) {
      const debut = bc.indexOf(`name: "${outil}"`);
      const fin = bc.indexOf('name: "', debut + 10);
      const bloc = bc.slice(debut, fin < 0 ? undefined : fin);
      expect(bloc, outil).toContain("allowed: peutPiloterMissionsAdam,");
      expect(bloc, outil).toContain("refus: REFUS_MISSIONS_MODELE,");
    }
    const wt = lire("lib/assistant/watch-tools.ts");
    expect(wt).toContain("const EXEC = (u: Utilisateur): boolean => peutPiloterMissionsAdam(u);");
    expect(wt.match(/refus: REFUS_SURVEILLANCE,/g)?.length).toBe(3);
  });

  it("le moteur : les deux lanceurs et le filet des lancements perdus", () => {
    const rt = lire("platform/in-process/missions/runtime.ts");
    const lancer = rt.slice(rt.indexOf("export function lancerMission("), rt.indexOf("export function lancerMission(") + 2500);
    expect(lancer.indexOf("peutPiloterMissionsAdam(user)")).toBeGreaterThan(0);
    expect(lancer.indexOf("peutPiloterMissionsAdam(user)")).toBeLessThan(lancer.indexOf('withTurn("background"'));
    const detache = rt.slice(rt.indexOf("export async function lancerEnArrierePlan("));
    expect(detache.indexOf("peutPiloterMissionsAdam(user)")).toBeGreaterThan(0);
    expect(detache.indexOf("peutPiloterMissionsAdam(user)")).toBeLessThan(detache.indexOf("creerTalon("));
    const filet = rt.slice(rt.indexOf("export async function rattraperLancementsPerdus("));
    expect(filet).toContain("suspendreMissionHorsDroit(talon.id, talon.ownerId)");
  });

  it("le battement et le balayage des surveillances relisent l'autorité juste après avoir rebâti le propriétaire", () => {
    const sweep = lire("platform/in-process/missions/sweep.ts");
    const rebati = sweep.indexOf("cache.set(m.ownerId, await proprietaire(m.ownerId))");
    const relu = sweep.indexOf("if (!proprietaireHabilite(user))");
    expect(rebati).toBeGreaterThan(0);
    expect(relu).toBeGreaterThan(rebati);
    expect(relu, "la relecture doit précéder la conduite").toBeLessThan(sweep.indexOf("conduireMission(user, m.id"));
    expect(sweep).toContain("suspendreMissionHorsDroit(m.id, m.ownerId)");
    const watch = lire("platform/in-process/missions/watch.ts");
    const rebatiW = watch.indexOf("proprietaires.set(w.ownerId, await proprietaire(w.ownerId))");
    const reluW = watch.indexOf("if (!proprietaireHabilite(owner))");
    expect(reluW).toBeGreaterThan(rebatiW);
    expect(reluW, "la relecture doit précéder la lecture de la cible").toBeLessThan(watch.indexOf("lireEtatCible(owner, type, w.targetId"));
  });

  it("l'interrupteur global — poser depuis la conversation, poser et lever depuis l'écran — est au Super Admin", () => {
    const pont = lire("platform/in-process/missions/control.ts");
    const bloc = pont.slice(pont.indexOf("export async function suspendreToutesLesMissions("));
    expect(bloc.slice(0, 600)).toContain("peutPiloterMissionsAdam(user)");
    expect(pont).not.toContain("hasGlobalView");
    const actions = lire("lib/actions/adam-settings-actions.ts");
    const action = actions.slice(actions.indexOf("export async function setAdamMissionsPaused("));
    expect(action.slice(0, 700)).toContain("peutPiloterMissionsAdam(user)");
    const form = lire("app/(app)/chief-of-staff/reglages/reglages-form.tsx");
    expect(form.indexOf("{missionsPilotables ? (")).toBeGreaterThan(0);
    expect(form.indexOf("{missionsPilotables ? (")).toBeLessThan(form.indexOf('data-testid="reglages-missions"'));
  });

  it("le prompt DIT la règle à qui n'a pas les outils — sinon il irait les chercher (§118.122)", () => {
    const a = lire("lib/assistant.ts");
    expect(a).toContain('${peutPiloterMissionsAdam(user) ? "" : `');
    expect(a).toContain("MISSIONS ET SURVEILLANCES D'ADAM — RÉSERVÉES AU SUPER ADMIN");
  });
});
