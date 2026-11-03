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
import { reveillerAttentesTemporelles } from "@/lib/missions/events/router";
import { emettreMessageRecu } from "@/lib/events/messaging-events";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * « SI ELLE N'A PAS RÉPONDU AVANT T, RELANCE ; SI ELLE A RÉPONDU, REMERCIE » — prouvé par
 * l'entrée réelle (`lancerMission` → `avancerMission`), le vrai réveil temporel à horloge
 * injectée, et le vrai registre d'événements pour la réponse.
 *
 * Deux missions au même plan : dans la première, le temps règle l'attente → la branche TIMEOUT
 * part, la branche EVENT est IGNORÉE (journal `STEP_SKIPPED` qui dit pourquoi) ; dans la
 * seconde, un message de la personne arrive → l'inverse. Dans les deux, un test de SORTIE garde
 * une étape (« alerte si la liste est vide » ne part pas quand la liste a deux noms) et la
 * mission CONCLUT : une étape ignorée n'est ni un succès ni un manque.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__cond${Date.now()}`;
// Des noms UNIQUES à ce banc : un autre banc (crash-between) crée « Nadia Belhadj », et les deux
// tournent en parallèle — un nom partagé rendrait la résolution de destinataire ambiguë chez lui.
const SUFFIXE = TAG.slice(-5);
const SALARIES = [`Yasmine Kaci ${SUFFIXE}`, `Rachid Mansouri ${SUFFIXE}`];
let pdg: CurrentUser;
let companyId = "";
let yasmineUserId = "";

const criteres = ["[REGLE:AUCUNE_ECRITURE] mission de suivi sans écriture."];
const juge = pour("mission.judge", (req: ReasonRequest) => {
  const cles = [...req.prompt.matchAll(/^- ([a-z0-9:_#-]+) : /gim)].map((m) => m[1]);
  return { ok: true, data: { satisfied: true, confidence: 0.9, criteria: criteres.map((c) => ({ criterion: c, status: "SATISFAIT", evidenceRefs: cles.slice(0, 3) })), missing: [], contradictions: [], suggestedRecovery: null } };
});

const lecture = (key: string, limit: number, dependsOn: string[], when: Record<string, unknown> | null) => ({
  key, title: `Lecture ${key}`, nodeType: "CAPABILITY", capability: "directory_list",
  inputs: [{ key: "department", kind: "TEXT", value: TAG }, { key: "limit", kind: "NUMBER", value: String(limit) }],
  dependsOn, when, completionCondition: "la liste est rendue",
});

function planAvec(until: string) {
  return planScripte({
    goal: "Attendre la réponse de Yasmine ; la relancer si elle tarde, la remercier sinon.",
    reasoningComplexity: "B", executionScale: "S", acceptanceCriteria: criteres,
    workstreams: [],
    steps: [
      lecture("liste:salaries", 50, [], null),
      {
        key: "attente:reponse", title: "Attendre la réponse de Yasmine", nodeType: "WAIT_EVENT",
        waitEvent: "MESSAGE_RECEIVED", waitFrom: SALARIES[0], waitUntil: until, dependsOn: ["liste:salaries"],
        completionCondition: "réponse reçue ou échéance passée",
      },
      // La branche « sinon » et la branche « si » — même amont, issues opposées.
      lecture("relancer", 3, ["attente:reponse"], { step: "attente:reponse", outcome: "TIMEOUT", path: null, op: null, value: null }),
      lecture("remercier", 2, ["attente:reponse"], { step: "attente:reponse", outcome: "EVENT", path: null, op: null, value: null }),
      // Les gardes de SORTIE : la liste a deux noms → « alerte:vide » ne part pas, « traiter » part.
      lecture("alerte:vide", 1, ["liste:salaries"], { step: "liste:salaries", path: "salaries", op: "empty", outcome: null, value: null }),
      lecture("traiter", 1, ["liste:salaries"], { step: "liste:salaries", path: "salaries", op: "exists", outcome: null, value: null }),
      {
        key: "controle", title: "Contrôle final", nodeType: "QA", capability: null,
        dependsOn: ["relancer", "remercier", "alerte:vide", "traiter"], completionCondition: "les étapes attendues sont abouties ou ignorées",
      },
    ],
    expectedArtifacts: [], approvalStrategy: "BUNDLE", completionCriteria: criteres[0], gaps: [], rationale: "banc de la branche conditionnelle",
  });
}

async function lancer(until: string) {
  const cerveau = new RaisonneurScripte([pour("mission.plan", () => ({ ok: true, data: planAvec(until) })), juge]);
  const r = await lancerMission(pdg, "Attends la réponse de Yasmine ; relance-la si elle tarde, remercie-la sinon.", { reasoner: cerveau, lectureSeule: true });
  if (!r.ok) throw new Error(`mission non lancée : ${r.error}`);
  if (r.approbation) expect(await decider(r.approbation.id, "GRANTED", pdg.id)).toBe(true);
  await avancerMission(pdg, r.missionId, { reasoner: cerveau });
  return { missionId: r.missionId, cerveau };
}

const statuts = async (missionId: string) => {
  const etat = await chargerEtat(missionId);
  return { mission: etat!.status, etapes: Object.fromEntries(etat!.steps.map((s) => [s.key, s.status])) };
};

suite("LA BRANCHE CONDITIONNELLE — « sinon » sur délai, « si » sur réponse, garde sur la sortie", () => {
  beforeAll(async () => {
    const c = await prisma.company.create({ data: { name: `${TAG} Pharma`, shortName: TAG.slice(0, 12) }, select: { id: true } });
    companyId = c.id;
    const u = await prisma.user.create({
      data: { name: `${TAG} PDG`, email: `${TAG}pdg@amd.dz`, passwordHash: "x", role: "SUPER_ADMIN" },
      select: { id: true, name: true, email: true, role: true },
    });
    pdg = { id: u.id, name: u.name, email: u.email, role: u.role, access: (await getAccess(u.id, u.role)) as EffectiveAccess, mustChangePassword: false };
    for (const [i, nom] of SALARIES.entries()) {
      const compte = await prisma.user.create({ data: { name: nom, email: `${TAG}${i}@amd.dz`, passwordHash: "x", role: "SALES_USER" }, select: { id: true } });
      if (i === 0) yasmineUserId = compte.id;
      await prisma.employee.create({ data: { fullName: nom, email: `${TAG}${i}@amd.dz`, position: "Déléguée", department: TAG, isActive: true, companyId, userId: compte.id } });
    }
  }, 120_000);

  afterAll(async () => {
    await prisma.mission.deleteMany({ where: { owner: { email: { startsWith: TAG } } } }).catch(() => {});
    await prisma.businessEvent.deleteMany({ where: { actorId: yasmineUserId } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { user: { email: { startsWith: TAG } } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
    await prisma.company.deleteMany({ where: { id: companyId } }).catch(() => {});
  }, 120_000);

  it("le TEMPS règle l'attente → « relancer » part, « remercier » est ignorée et le journal dit pourquoi ; la mission conclut", async () => {
    // L'ÉCHÉANCE EST DANS UN FUTUR LOINTAIN, et c'est l'horloge INJECTÉE qui la dépasse (vague « restes »).
    // Elle était déjà passée au lancement : le balayage temporel GLOBAL d'un autre fichier de la suite
    // (`crash-matrix`, le battement d'un banc voisin, `router.test.ts` qui pousse son horloge à deux jours)
    // réglait l'attente entre deux lignes d'ici — mesuré : « attente:reponse » DONE au lieu de WAITING, une
    // série sur plusieurs. `router.test.ts` avait appris la même leçon (« l'échéance est dans le futur réel »).
    const echeance = new Date(Date.now() + 30 * 86_400_000);
    const { missionId, cerveau } = await lancer(echeance.toISOString());
    // TÉMOIN : un balayage à l'horloge RÉELLE, comme celui d'un fichier voisin, ne règle pas l'attente.
    await reveillerAttentesTemporelles(new Date());
    let s = await statuts(missionId);
    expect(s.etapes["liste:salaries"]).toBe("DONE");
    // Les gardes de sortie se sont décidées dès la liste lue.
    expect(s.etapes["alerte:vide"]).toBe("SKIPPED");
    expect(s.etapes["traiter"]).toBe("DONE");
    expect(s.etapes["attente:reponse"]).toBe("WAITING");
    expect(s.mission).toBe("WAITING_EVENT");

    // LE VRAI BALAYAGE TEMPOREL, horloge injectée : l'échéance est passée.
    const reveils = await reveillerAttentesTemporelles(new Date(echeance.getTime() + 1_000));
    expect(reveils.some((r) => r.missionId === missionId)).toBe(true);
    await avancerMission(pdg, missionId, { reasoner: cerveau });

    s = await statuts(missionId);
    expect(s.etapes["relancer"]).toBe("DONE");
    expect(s.etapes["remercier"]).toBe("SKIPPED");
    expect(s.etapes["controle"]).toBe("DONE");
    expect(s.mission).toBe("COMPLETED");

    const journal = await prisma.missionEvent.findMany({ where: { missionId, kind: "STEP_SKIPPED" }, select: { summary: true, detail: true } });
    const remercier = journal.find((e) => (e.detail as { stepKey?: string })?.stepKey === "remercier");
    expect(remercier?.summary).toMatch(/condition non remplie/);
    expect(remercier?.summary).toMatch(/TIMEOUT/);
    const alerte = journal.find((e) => (e.detail as { stepKey?: string })?.stepKey === "alerte:vide");
    expect(alerte?.summary).toMatch(/non vide/);
  }, 120_000);

  it("la RÉPONSE arrive par le registre d'événements → « remercier » part, « relancer » est ignorée", async () => {
    // Trente jours et non deux : `router.test.ts` balaie à « deux jours + 5 min » sur la même base.
    const { missionId, cerveau } = await lancer(new Date(Date.now() + 30 * 86_400_000).toISOString());
    let s = await statuts(missionId);
    expect(s.mission).toBe("WAITING_EVENT");

    // Yasmine répond : le fait MESSAGE_RECEIVED passe par le VRAI chemin (registre → réveil).
    await emettreMessageRecu({ conversationId: `${TAG}-conv`, senderId: yasmineUserId, senderName: SALARIES[0], body: "Voici ma réponse.", recipientIds: [pdg.id] });
    await avancerMission(pdg, missionId, { reasoner: cerveau });

    s = await statuts(missionId);
    expect(s.etapes["attente:reponse"]).toBe("DONE");
    expect(s.etapes["remercier"]).toBe("DONE");
    expect(s.etapes["relancer"]).toBe("SKIPPED");
    expect(s.mission).toBe("COMPLETED");
  }, 120_000);
});
