import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { getAccess, type EffectiveAccess } from "@/lib/rbac";
import type { CurrentUser } from "@/lib/session";
import type { ReasonRequest } from "@/lib/missions/ports";
import { lancerMission, avancerMission } from "@/platform/in-process/missions/runtime";
import { RaisonneurScripte, pour, planScripte } from "@/platform/in-process/missions/fake-reasoner";
import { decider } from "@/lib/missions/approval/gate";
import { chargerEtat } from "@/lib/missions/runtime/store";
import { emettreMessageRecu } from "@/lib/events/messaging-events";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * ÉVÉNEMENTS DANS LE DÉSORDRE — la réponse arrive AVANT que l'attente n'existe.
 *
 * Deux missions. Dans la première, l'attente ne dépend que d'une lecture : la réponse de
 * Yasmine, arrivée entre le lancement et le premier tour, est RATTRAPÉE — l'attente se règle
 * sans dormir, le journal le dit (`EVENT_CATCHUP`). Dans la seconde, l'attente suit un ENVOI :
 * un message de Yasmine antérieur à l'envoi n'est PAS une réponse (l'attente reste ouverte) ;
 * le suivant, postérieur, la règle par le réveil normal.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__ord${Date.now()}`;
const SUFFIXE = TAG.slice(-5);
const YASMINE = `Yasmine Toumi ${SUFFIXE}`;
let pdg: CurrentUser;
let companyId = "";
let yasmineId = "";
const criteres = ["[REGLE:AUCUNE_ECRITURE] mission de suivi."];
const criteresEnvoi = ["Le message est parti et la réponse est arrivée."];
const jugePour = (crit: string[]) => pour("mission.judge", (req: ReasonRequest) => {
  const cles = [...req.prompt.matchAll(/^- ([a-z0-9:_#-]+) : /gim)].map((m) => m[1]);
  return { ok: true, data: { satisfied: true, confidence: 0.9, criteria: crit.map((c) => ({ criterion: c, status: "SATISFAIT", evidenceRefs: cles.slice(0, 3) })), missing: [], contradictions: [], suggestedRecovery: null } };
});
const dansDeuxJours = () => new Date(Date.now() + 2 * 86_400_000).toISOString();
const liste = { key: "liste", title: "Lister", nodeType: "CAPABILITY", capability: "directory_list", inputs: [{ key: "department", kind: "TEXT", value: TAG }, { key: "limit", kind: "NUMBER", value: "10" }], dependsOn: [], completionCondition: "la liste est rendue" };
const attente = (dependsOn: string[]) => ({ key: "attente", title: "Attendre la réponse de Yasmine", nodeType: "WAIT_EVENT", waitEvent: "MESSAGE_RECEIVED", waitFrom: YASMINE, waitUntil: dansDeuxJours(), dependsOn, completionCondition: "réponse reçue" });
const controle = { key: "controle", title: "Contrôle", nodeType: "QA", dependsOn: ["attente"], completionCondition: "fini" };

const planLecture = () => planScripte({ goal: "Attendre la réponse de Yasmine.", reasoningComplexity: "B", executionScale: "S", acceptanceCriteria: criteres, workstreams: [], steps: [liste, attente(["liste"]), controle], expectedArtifacts: [], approvalStrategy: "BUNDLE", completionCriteria: criteres[0], gaps: [], rationale: "banc" });
const planEnvoi = () => planScripte({
  goal: "Écrire à Yasmine, attendre sa réponse.", reasoningComplexity: "B", executionScale: "S", acceptanceCriteria: criteresEnvoi, workstreams: [],
  steps: [
    liste,
    { key: "accord", title: "Votre accord", nodeType: "APPROVAL", dependsOn: ["liste"], approvalRequirement: "NORMAL", completionCondition: "accord" },
    { key: "envoi", title: "Écrire à Yasmine", nodeType: "CAPABILITY", capability: "send_message", inputs: [{ key: "recipientName", kind: "TEXT", value: YASMINE }, { key: "body", kind: "TEXT", value: "Peux-tu confirmer le CPP ?" }], dependsOn: ["accord"], approvalRequirement: "NORMAL", completionCondition: "envoyé" },
    attente(["envoi"]), controle,
  ],
  expectedArtifacts: [], approvalStrategy: "BUNDLE", completionCriteria: criteresEnvoi[0], gaps: [], rationale: "banc",
});

const reponse = (texte: string) => emettreMessageRecu({ conversationId: `${TAG}-conv`, senderId: yasmineId, senderName: YASMINE, body: texte, recipientIds: [pdg.id] });
const etatDe = async (id: string) => { const e = await chargerEtat(id); return { mission: e!.status, etapes: Object.fromEntries(e!.steps.map((s) => [s.key, s.status])), attente: e!.steps.find((s) => s.key === "attente") }; };

suite("ÉVÉNEMENTS DANS LE DÉSORDRE — une réponse déjà arrivée règle l'attente, une réponse antérieure à la demande non", () => {
  beforeAll(async () => {
    const c = await prisma.company.create({ data: { name: `${TAG} Pharma`, shortName: TAG.slice(0, 12) }, select: { id: true } });
    companyId = c.id;
    const u = await prisma.user.create({ data: { name: `${TAG} PDG`, email: `${TAG}pdg@amd.dz`, passwordHash: "x", role: "SUPER_ADMIN" }, select: { id: true, name: true, email: true, role: true } });
    pdg = { id: u.id, name: u.name, email: u.email, role: u.role, access: (await getAccess(u.id, u.role)) as EffectiveAccess, mustChangePassword: false };
    const y = await prisma.user.create({ data: { name: YASMINE, email: `${TAG}y@amd.dz`, passwordHash: "x", role: "REGULATORY_ASSISTANT" }, select: { id: true } });
    yasmineId = y.id;
    await prisma.employee.create({ data: { fullName: YASMINE, email: `${TAG}y@amd.dz`, position: "Assistante", department: TAG, isActive: true, companyId, userId: yasmineId } });
  }, 120_000);

  afterAll(async () => {
    await prisma.mission.deleteMany({ where: { ownerId: pdg.id } }).catch(() => {});
    await prisma.assistantActionIntent.deleteMany({ where: { userId: pdg.id } }).catch(() => {});
    await prisma.businessEvent.deleteMany({ where: { actorId: { in: [yasmineId, pdg.id] } } }).catch(() => {});
    await prisma.message.deleteMany({ where: { senderId: pdg.id } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { user: { email: { startsWith: TAG } } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
    await prisma.company.deleteMany({ where: { id: companyId } }).catch(() => {});
  }, 120_000);

  it("la réponse arrivée entre le lancement et le premier tour est RATTRAPÉE : l'attente se règle sans dormir", async () => {
    const cerveau = new RaisonneurScripte([pour("mission.plan", () => ({ ok: true, data: planLecture() })), jugePour(criteres)]);
    const r = await lancerMission(pdg, "Attends la réponse de Yasmine.", { reasoner: cerveau, lectureSeule: true, demarrer: false });
    if (!r.ok) throw new Error(r.error);
    // La réponse arrive AVANT que l'attente n'existe.
    await reponse("Voici ma réponse, avant même que tu attendes.");
    await avancerMission(pdg, r.missionId, { reasoner: cerveau });
    await avancerMission(pdg, r.missionId, { reasoner: cerveau });
    const e = await etatDe(r.missionId);
    expect(e.etapes.attente, JSON.stringify(e.etapes)).toBe("DONE");
    expect((e.attente!.result as { rattrape?: boolean; reveillePar?: string }).rattrape).toBe(true);
    expect((e.attente!.result as { reveillePar?: string }).reveillePar).toBe("MESSAGE_RECEIVED");
    expect(e.mission).toBe("COMPLETED");
    expect(await prisma.missionEvent.count({ where: { missionId: r.missionId, kind: "EVENT_CATCHUP" } })).toBe(1);
  }, 120_000);

  it("un message ANTÉRIEUR à la demande n'est pas une réponse ; le suivant règle l'attente par le réveil normal", async () => {
    const cerveau = new RaisonneurScripte([pour("mission.plan", () => ({ ok: true, data: planEnvoi() })), jugePour(criteresEnvoi)]);
    const r = await lancerMission(pdg, "Écris à Yasmine et attends sa réponse.", { reasoner: cerveau, demarrer: false });
    if (!r.ok) throw new Error(r.error);
    // Un message de Yasmine AVANT que la demande parte : ce n'est pas une réponse.
    await reponse("Un message qui n'a rien à voir, avant la demande.");
    await new Promise((res) => setTimeout(res, 20));
    if (r.approbation) expect(await decider(r.approbation.id, "GRANTED", pdg.id)).toBe(true);
    for (let i = 0; i < 4; i++) await avancerMission(pdg, r.missionId, { reasoner: cerveau });
    let e = await etatDe(r.missionId);
    expect(e.etapes.envoi, JSON.stringify(e.etapes)).toBe("DONE");
    expect(e.etapes.attente, "le message antérieur à l'envoi ne doit PAS régler l'attente").toBe("WAITING");
    expect(e.mission).toBe("WAITING_EVENT");
    // La vraie réponse, après la demande : le réveil normal.
    await reponse("Confirmé pour le CPP.");
    await avancerMission(pdg, r.missionId, { reasoner: cerveau });
    e = await etatDe(r.missionId);
    expect(e.etapes.attente).toBe("DONE");
    expect((e.attente!.result as { rattrape?: boolean }).rattrape).toBeUndefined();
    expect(e.mission).toBe("COMPLETED");
  }, 120_000);
});
