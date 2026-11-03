import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { getAccess, type EffectiveAccess } from "@/lib/rbac";
import type { CurrentUser } from "@/lib/session";
import type { ReasonRequest } from "@/lib/missions/ports";
import { lancerMission } from "@/platform/in-process/missions/runtime";
import { conduireMission } from "@/platform/in-process/missions/sweep";
import { RaisonneurScripte, pour, planScripte } from "@/platform/in-process/missions/fake-reasoner";
import { decider } from "@/lib/missions/approval/gate";
import { chargerEtat } from "@/lib/missions/runtime/store";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES DONNÉES CHANGENT PENDANT LA MISSION — la cible d'une écriture disparaît entre l'accord et
 * l'exécution. Ce que « rien d'inventé, rien de perdu » exige : aucun message ne part vers un
 * compte désactivé, l'étape échoue en le DISANT, la mission ne se déclare pas terminée, et le
 * dirigeant est prévenu par la porte d'attention — jamais un succès de façade.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__chg${Date.now()}`;
const SUFFIXE = TAG.slice(-5);
const KENZA = `Kenza Brahimi ${SUFFIXE}`;
let pdg: CurrentUser;
let companyId = "";
let kenzaId = "";
const criteres = ["Kenza a reçu le message."];
const juge = pour("mission.judge", (req: ReasonRequest) => {
  const cles = [...req.prompt.matchAll(/^- ([a-z0-9:_#-]+) : /gim)].map((m) => m[1]);
  return { ok: true, data: { satisfied: true, confidence: 0.9, criteria: criteres.map((c) => ({ criterion: c, status: "SATISFAIT", evidenceRefs: cles.slice(0, 3) })), missing: [], contradictions: [], suggestedRecovery: null } };
});
const plan = () => planScripte({
  goal: "Écrire à Kenza.", reasoningComplexity: "A", executionScale: "S", acceptanceCriteria: criteres, workstreams: [],
  steps: [
    { key: "liste", title: "Lister", nodeType: "CAPABILITY", capability: "directory_list", inputs: [{ key: "department", kind: "TEXT", value: TAG }, { key: "limit", kind: "NUMBER", value: "10" }], dependsOn: [], completionCondition: "la liste est rendue" },
    { key: "accord", title: "Votre accord", nodeType: "APPROVAL", dependsOn: ["liste"], approvalRequirement: "NORMAL", completionCondition: "accord" },
    { key: "message", title: "Écrire à Kenza", nodeType: "CAPABILITY", capability: "send_message", inputs: [{ key: "recipientName", kind: "TEXT", value: KENZA }, { key: "body", kind: "TEXT", value: "Bonjour Kenza — peux-tu confirmer ?" }], dependsOn: ["accord"], approvalRequirement: "NORMAL", completionCondition: "envoyé" },
    { key: "controle", title: "Contrôle", nodeType: "QA", dependsOn: ["message"], completionCondition: "le message est parti" },
  ],
  expectedArtifacts: [], approvalStrategy: "BUNDLE", completionCriteria: criteres[0], gaps: [], rationale: "banc",
});

suite("DONNÉES MODIFIÉES EN COURS DE MISSION — la cible disparaît entre l'accord et l'envoi", () => {
  beforeAll(async () => {
    const c = await prisma.company.create({ data: { name: `${TAG} Pharma`, shortName: TAG.slice(0, 12) }, select: { id: true } });
    companyId = c.id;
    const u = await prisma.user.create({ data: { name: `${TAG} PDG`, email: `${TAG}pdg@amd.dz`, passwordHash: "x", role: "SUPER_ADMIN" }, select: { id: true, name: true, email: true, role: true } });
    pdg = { id: u.id, name: u.name, email: u.email, role: u.role, access: (await getAccess(u.id, u.role)) as EffectiveAccess, mustChangePassword: false };
    const k = await prisma.user.create({ data: { name: KENZA, email: `${TAG}k@amd.dz`, passwordHash: "x", role: "SALES_USER" }, select: { id: true } });
    kenzaId = k.id;
    await prisma.employee.create({ data: { fullName: KENZA, email: `${TAG}k@amd.dz`, position: "Déléguée", department: TAG, isActive: true, companyId, userId: kenzaId } });
  }, 120_000);

  afterAll(async () => {
    await prisma.mission.deleteMany({ where: { ownerId: pdg.id } }).catch(() => {});
    await prisma.assistantActionIntent.deleteMany({ where: { userId: pdg.id } }).catch(() => {});
    await prisma.message.deleteMany({ where: { senderId: pdg.id } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { user: { email: { startsWith: TAG } } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
    await prisma.company.deleteMany({ where: { id: companyId } }).catch(() => {});
  }, 120_000);

  it("aucun message ne part, l'étape dit pourquoi, la mission ne se déclare pas terminée, le dirigeant est prévenu", async () => {
    // Le plan initial, puis PLUS RIEN : la replanification n'a pas de nouveau plan à proposer —
    // c'est le cas où le battement doit prévenir.
    const cerveau = new RaisonneurScripte([pour("mission.plan", (_req, n) => (n === 1 ? { ok: true, data: plan() } : { ok: false, error: "aucun nouveau plan (banc)" })), juge]);
    const r = await lancerMission(pdg, "Écris à Kenza pour qu'elle confirme.", { reasoner: cerveau, demarrer: false });
    if (!r.ok) throw new Error(r.error);
    expect(r.approbation).not.toBeNull();
    expect(await decider(r.approbation!.id, "GRANTED", pdg.id)).toBe(true);

    // LE MONDE CHANGE : Kenza est désactivée entre l'accord et l'envoi.
    await prisma.user.update({ where: { id: kenzaId }, data: { isActive: false } });
    await prisma.employee.updateMany({ where: { userId: kenzaId }, data: { isActive: false } });

    // LA CONDUITE DU BATTEMENT : avancer, replanifier si ça coince, prévenir si ça coince encore.
    let signale = 0;
    for (let i = 0; i < 8; i++) {
      const c = await conduireMission(pdg, r.missionId, { reasoner: cerveau });
      if (c.signale) signale += 1;
      if (["COMPLETED", "FAILED", "BLOCKED", "PARTIAL", "CANCELLED"].includes(c.statut ?? "")) break;
    }
    // Un second passage sur la même mission bloquée ne re-signale pas.
    expect((await conduireMission(pdg, r.missionId, { reasoner: cerveau })).signale).toBe(false);
    expect(signale).toBe(1);
    const etat = await chargerEtat(r.missionId);
    const message = etat!.steps.find((s) => s.key === "message")!;

    // RIEN N'EST PARTI, et l'étape le DIT.
    expect(await prisma.message.count({ where: { senderId: pdg.id } })).toBe(0);
    expect(message.status).toBe("FAILED");
    expect(message.error ?? "").toMatch(/destinataire|introuvable|invalide/i);
    // La mission n'est PAS un succès : partielle, bloquée ou en échec — jamais COMPLETED.
    expect(["PARTIAL", "BLOCKED", "FAILED"]).toContain(etat!.status);
    // Le dirigeant est prévenu par la porte d'attention, une fois.
    const notifs = await prisma.notification.findMany({ where: { userId: pdg.id }, select: { title: true } });
    expect(notifs.some((n) => /Mission (partiellement faite|bloqu|Échec)|Bloqué|Échec/.test(n.title)), JSON.stringify(notifs)).toBe(true);
    // Et l'histoire est au journal : l'échec de l'étape, avec sa cause.
    const journal = await prisma.missionEvent.findMany({ where: { missionId: r.missionId, kind: "STEP_FAILED" }, select: { summary: true } });
    expect(journal.length).toBeGreaterThanOrEqual(1);
  }, 120_000);
});
