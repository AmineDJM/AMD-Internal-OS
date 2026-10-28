import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { getAccess, type EffectiveAccess } from "@/lib/rbac";
import type { CurrentUser } from "@/lib/session";
import { lancerMission, avancerMission } from "@/platform/in-process/missions/runtime";
import { RaisonneurScripte, pour, planScripte } from "@/platform/in-process/missions/fake-reasoner";
import { chargerEtat } from "@/lib/missions/runtime/store";
import { BAIL_MS } from "@/lib/missions/runtime/engine";
import { capabilityMeta } from "@/lib/missions/registry/capability-meta";

/**
 * L'ÉCRITURE AUTONOME NE SE REJOUE PAS — un rappel posé par une mission reste UN rappel.
 *
 * `plan_reminder` passe par le chemin des lectures (pas d'intent, pas de reçu). Avant ce lot,
 * il était classé EXTERNAL_COMMUNICATION par défaut, envoyé sur le chemin des intents et refusé
 * (« Action non prise en charge »). Ici : il est une écriture INTERNE réversible (accord NORMAL),
 * il s'exécute par le bon chemin, et une reprise après panne entre l'effet et l'état rend la
 * sortie déjà produite — le nombre de rappels ne bouge pas.
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `auto${Date.now().toString(36)}`;
let pdg: CurrentUser;

suite("écritures autonomes — classement, chemin et non-rejeu", () => {
  beforeAll(async () => {
    const u = await prisma.user.create({ data: { name: `${TAG} PDG`, email: `${TAG}@amd.dz`, passwordHash: "x", role: "SUPER_ADMIN" }, select: { id: true, name: true, email: true, role: true } });
    pdg = { id: u.id, name: u.name, email: u.email, role: u.role, access: (await getAccess(u.id, u.role)) as EffectiveAccess, mustChangePassword: false };
  }, 60_000);
  afterAll(async () => {
    await prisma.assistantReminder.deleteMany({ where: { userId: pdg.id } }).catch(() => {});
    await prisma.mission.deleteMany({ where: { ownerId: pdg.id } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: pdg.id } }).catch(() => {});
  }, 60_000);

  it("le registre : une lecture non listée est une LECTURE, une écriture autonome une écriture interne, l'inconnu sans liste reste prudent", () => {
    const est = (n: string) => n === "send_message";
    expect(capabilityMeta("resolve_person", est).effect).toBe("READ");
    expect(capabilityMeta("find_documents", est).effect).toBe("READ");
    expect(capabilityMeta("what_changed", est).effect).toBe("READ");
    expect(capabilityMeta("gmail_prepare_mail", est).effect).toBe("PREPARE");
    expect(capabilityMeta("plan_reminder", est).effect).toBe("INTERNAL_REVERSIBLE_WRITE");
    expect(capabilityMeta("plan_reminder", est).idempotent).toBe(false);
    expect(capabilityMeta("send_message", est).effect).toBe("INTERNAL_REVERSIBLE_WRITE");
    expect(capabilityMeta("list_accounts", est).effect).toBe("SECURITY_ADMIN");
    // Sans liste d'écritures, on ne sait pas : défaut prudent conservé.
    expect(capabilityMeta("resolve_person").effect).toBe("EXTERNAL_COMMUNICATION");
  });

  it("une mission pose un rappel, un crash entre l'effet et l'état ne le repose pas", async () => {
    const plan = planScripte({
      goal: "Poser un rappel pour valider le budget demain matin.",
      reasoningComplexity: "A", executionScale: "S",
      acceptanceCriteria: ["Un rappel existe pour demain."],
      workstreams: [{ id: "rappel", title: "Rappel", outcome: "Le rappel est posé." }],
      steps: [{
        key: "rappel:budget", title: "Poser le rappel", workstream: "rappel", nodeType: "CAPABILITY", capability: "plan_reminder",
        inputs: [{ key: "title", kind: "TEXT", value: `Valider le budget ${TAG}` }, { key: "quand", kind: "TEXT", value: "demain à 8h" }],
        dependsOn: [], forEachFrom: null, forEachPath: null, forEachAs: null,
        waitEvent: null, waitFrom: null, waitEntity: null, waitAsk: null, waitWithinDays: null,
        outputFields: [], completionCondition: "Le rappel est posé.", reasoningRequirement: "NONE", approvalRequirement: "NORMAL", maxAttempts: null,
      }],
      expectedArtifacts: [], approvalStrategy: "BUNDLE", completionCriteria: "Le rappel existe.", gaps: [], rationale: "un rappel",
    });
    const cerveau = new RaisonneurScripte([pour("mission.plan", () => ({ ok: true, data: plan }))]);
    const r = await lancerMission(pdg, `Rappelle-moi demain à 8h de valider le budget ${TAG}.`, { reasoner: cerveau, sansEnquete: true });
    if (!r.ok) throw new Error(`mission non lancée : ${r.error}`);
    // UNE ÉCRITURE AUTONOME NE DEMANDE PAS D'ACCORD — la même politique que la conversation,
    // qui pose un rappel sans carte de confirmation (§7 : une mission n'est ni une porte
    // dérobée, ni un guichet plus tatillon que l'écran). Le planificateur avait proposé NORMAL ;
    // la politique de la maison tranche, et elle tranche « aucun ».
    expect(r.approbation).toBeNull();
    await avancerMission(pdg, r.missionId, { reasoner: cerveau });

    let etat = await chargerEtat(r.missionId);
    const etape = etat!.steps.find((s) => s.key === "rappel:budget")!;
    expect(etape.status).toBe("DONE");
    expect(etape.idempotencyKey).toBeTruthy();
    const rappels = () => prisma.assistantReminder.count({ where: { userId: pdg.id, title: { contains: TAG } } });
    expect(await rappels()).toBe(1);
    const marque = await prisma.missionEvent.count({ where: { missionId: r.missionId, kind: "AUTONOMOUS_EFFECT" } });
    expect(marque).toBe(1);

    // LE CRASH : l'effet est fait, l'état de l'étape est perdu.
    await prisma.missionStep.update({
      where: { id: etape.id },
      data: { status: "RUNNING", receipt: null, result: undefined, completedAt: null, startedAt: new Date(Date.now() - BAIL_MS - 5_000) },
    });
    await prisma.mission.update({ where: { id: r.missionId }, data: { status: "RUNNING" } });
    const tick = await avancerMission(pdg, r.missionId, { reasoner: cerveau });
    expect(tick?.dedupliquees ?? 0).toBeGreaterThanOrEqual(1);
    etat = await chargerEtat(r.missionId);
    expect(etat!.steps.find((s) => s.key === "rappel:budget")!.status).toBe("DONE");
    // LA PREUVE QUI COMPTE : toujours un seul rappel.
    expect(await rappels()).toBe(1);
  }, 120_000);
});
