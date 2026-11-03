import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { getAccess, type EffectiveAccess } from "@/lib/rbac";
import type { CurrentUser } from "@/lib/session";
import { lancerMission, avancerMission } from "@/platform/in-process/missions/runtime";
import { RaisonneurScripte, pour, planScripte } from "@/platform/in-process/missions/fake-reasoner";
import { decider } from "@/lib/missions/approval/gate";
import { chargerEtat } from "@/lib/missions/runtime/store";
import { BAIL_MS } from "@/lib/missions/runtime/engine";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CRASH ENTRE L'EFFET ET LE REÇU — « zéro effet dupliqué après reprise », prouvé par l'entrée
 * réelle, pas par un test unitaire de la clé.
 *
 * ── LE SCÉNARIO QUE PERSONNE NE COUVRAIT ─────────────────────────────────────────────────
 *
 * Une étape d'écriture (un message à un salarié) a PRODUIT son effet : l'intent est EXÉCUTÉ, le
 * message est en base. Le processus meurt AVANT que l'étape soit marquée DONE. Au réveil, le
 * moteur voit une étape RUNNING orpheline (bail expiré) et la REJOUE — c'est son devoir, une
 * étape figée serait une mission figée. Rejouer une écriture, c'est le risque exact : un
 * salarié qui reçoit deux fois le même message, un paiement passé deux fois.
 *
 * Ce que le système garantit — et ce que ce banc vérifie sur la vraie table de messagerie :
 * la clé d'idempotence, PERSISTÉE sur l'étape avant l'effet, fait retrouver l'intent EXÉCUTÉ ;
 * l'exécutant rend son reçu (`deduplicated`) SANS rien relancer ; le moteur compte la
 * déduplication ; le nombre de messages ne bouge pas d'une unité.
 *
 * Un sabotage l'a montré nécessaire : rendre `cleIdempotence` aléatoire ne faisait tomber
 * AUCUN test — la persistance de la clé sur l'étape neutralise cette faute-là, et rien ne
 * prouvait le cas « effet fait, reçu perdu ». Ce fichier le prouve.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__crash${Date.now()}`;
const SALARIES = ["Nadia Belhadj", "Karim Ould Ali"];
let pdg: CurrentUser;
let companyId = "";

suite("CRASH ENTRE L'EFFET ET LE REÇU — la reprise ne rejoue jamais une écriture faite", () => {
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
      await prisma.employee.create({ data: { fullName: nom, email: `${TAG}${i}@amd.dz`, position: "Délégué", department: `${TAG}-Ventes`, isActive: true, companyId, userId: compte.id } });
    }
  }, 120_000);

  afterAll(async () => {
    await prisma.mission.deleteMany({ where: { owner: { email: { startsWith: TAG } } } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
    await prisma.assistantActionIntent.deleteMany({ where: { user: { email: { startsWith: TAG } } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
    await prisma.company.deleteMany({ where: { id: companyId } }).catch(() => {});
  }, 120_000);

  const messagesEnvoyes = () => prisma.message.count({ where: { sender: { email: { startsWith: TAG } } } });

  const plan = planScripte({
    goal: "Écrire individuellement à chaque salarié de l'équipe, puis attendre les contrats.",
    reasoningComplexity: "B",
    executionScale: "S",
    acceptanceCriteria: ["Chaque salarié a reçu SON message, une seule fois."],
    workstreams: [{ id: "voeux", title: "Messages individuels", outcome: "Chaque salarié a reçu son message." }],
    steps: [
      {
        key: "liste:salaries", title: "Lister les salariés", workstream: "voeux",
        nodeType: "CAPABILITY", capability: "directory_list",
        inputs: [{ key: "department", kind: "TEXT", value: TAG }, { key: "limit", kind: "NUMBER", value: "50" }],
        dependsOn: [], forEachFrom: null, forEachPath: null, forEachAs: null,
        waitEvent: null, waitFrom: null, waitEntity: null, waitAsk: null, waitWithinDays: null,
        outputFields: [], completionCondition: "La liste est chargée.",
        reasoningRequirement: "NONE", approvalRequirement: "NONE", maxAttempts: null,
      },
      {
        key: "accord:envois", title: "Votre accord", workstream: "voeux",
        nodeType: "APPROVAL", capability: null, inputs: [],
        dependsOn: ["liste:salaries"], forEachFrom: null, forEachPath: null, forEachAs: null,
        waitEvent: null, waitFrom: null, waitEntity: null, waitAsk: null, waitWithinDays: null,
        outputFields: [], completionCondition: "L'accord est donné.",
        reasoningRequirement: "NONE", approvalRequirement: "NORMAL", maxAttempts: null,
      },
      {
        key: "message", title: "Message individuel", workstream: "voeux",
        nodeType: "CAPABILITY", capability: "send_message",
        inputs: [
          { key: "recipientName", kind: "TEXT", value: "{{salarie.nom}}" },
          { key: "body", kind: "TEXT", value: "Bonjour {{salarie.nom}} — un message, une fois." },
        ],
        dependsOn: ["accord:envois"], forEachFrom: "liste:salaries", forEachPath: "salaries", forEachAs: "salarie",
        waitEvent: null, waitFrom: null, waitEntity: null, waitAsk: null, waitWithinDays: null,
        outputFields: [], completionCondition: "Chaque salarié a son message.",
        reasoningRequirement: "NONE", approvalRequirement: "NORMAL", maxAttempts: null,
      },
      {
        key: "attente:contrats", title: "Attendre les contrats", workstream: "voeux",
        nodeType: "WAIT_EVENT", capability: null, inputs: [],
        dependsOn: ["message"], forEachFrom: null, forEachPath: null, forEachAs: null,
        waitEvent: "DOCUMENT_RECEIVED", waitFrom: SALARIES[0], waitEntity: null, waitAsk: null, waitWithinDays: 5,
        outputFields: [], completionCondition: "Les contrats sont arrivés.",
        reasoningRequirement: "NONE", approvalRequirement: "NONE", maxAttempts: null,
      },
      {
        key: "controle", title: "Contrôle final", workstream: "voeux",
        nodeType: "QA", capability: null, inputs: [],
        dependsOn: ["attente:contrats"], forEachFrom: null, forEachPath: null, forEachAs: null,
        waitEvent: null, waitFrom: null, waitEntity: null, waitAsk: null, waitWithinDays: null,
        outputFields: [], completionCondition: "Autant de messages que de salariés.",
        reasoningRequirement: "NONE", approvalRequirement: "NONE", maxAttempts: null,
      },
    ],
    expectedArtifacts: [],
    approvalStrategy: "BUNDLE",
    completionCriteria: "Un message abouti par salarié.",
    gaps: [],
    rationale: "Lire la liste, un accord, un message par personne.",
  });

  it("l'étape rejouée après un crash post-effet rend le reçu existant : même nombre de messages, déduplication comptée", async () => {
    const cerveau = new RaisonneurScripte([pour("mission.plan", () => ({ ok: true, data: plan }))]);
    const r = await lancerMission(pdg, "Écris individuellement à chaque salarié de l'équipe, puis attends les contrats.", { reasoner: cerveau });
    if (!r.ok) throw new Error(`mission non lancée : ${r.error}`);
    expect(r.approbation).not.toBeNull();
    expect(await decider(r.approbation!.id, "GRANTED", pdg.id)).toBe(true);
    await avancerMission(pdg, r.missionId, { reasoner: cerveau });

    let etat = await chargerEtat(r.missionId);
    const filles = etat!.steps.filter((s) => s.key.startsWith("message#"));
    expect(filles).toHaveLength(SALARIES.length);
    // Le reçu d'une écriture vit à DEUX endroits, et aucun des deux n'est la colonne `receipt`
    // (réservée au marqueur DEDUPLIQUE et aux runs de raisonnement) : l'identifiant de l'intent
    // exécuté dans `result.receipt`, et le reçu structuré dans `receiptData` (`recu`).
    const intentDe = (s: { result: unknown }) => (s.result as { receipt?: unknown } | null)?.receipt;
    for (const f of filles) {
      expect(f.status, f.key).toBe("DONE");
      expect(f.idempotencyKey, `${f.key} : clé persistée`).toBeTruthy();
      expect(typeof intentDe(f), `${f.key} : intent exécuté`).toBe("string");
      expect(f.recu?.capability, `${f.key} : reçu structuré`).toBe("send_message");
      expect(f.recu?.issue, `${f.key} : reçu structuré`).not.toBe("ECHEC");
      expect(f.recu?.deduplicated, `${f.key} : premier passage, rien à dédupliquer`).toBeUndefined();
    }
    expect(await messagesEnvoyes()).toBe(SALARIES.length);
    expect(etat!.status).toBe("WAITING_EVENT");

    // ── LE CRASH : l'effet est fait (intent EXÉCUTÉ, message en base), le reçu n'a pas été écrit.
    const victime = filles[0];
    const recuAvant = intentDe(victime) as string;
    await prisma.missionStep.update({
      where: { id: victime.id },
      data: {
        status: "RUNNING", receipt: null, receiptData: undefined, result: undefined, completedAt: null,
        startedAt: new Date(Date.now() - BAIL_MS - 5_000),
      },
    });
    await prisma.mission.update({ where: { id: r.missionId }, data: { status: "RUNNING" } });

    // ── LA REPRISE, par l'entrée de production ─────────────────────────────────────────
    const tick = await avancerMission(pdg, r.missionId, { reasoner: cerveau });
    expect(tick).not.toBeNull();
    expect(tick!.dedupliquees, "la reprise doit RECONNAÎTRE l'effet déjà produit").toBeGreaterThanOrEqual(1);

    etat = await chargerEtat(r.missionId);
    const rejouee = etat!.steps.find((s) => s.id === victime.id)!;
    expect(rejouee.status).toBe("DONE");
    // L'étape porte le marqueur de déduplication, et le reçu est CELUI de l'intent déjà
    // exécuté — pas un second intent.
    expect(rejouee.receipt).toBe("DEDUPLIQUE");
    expect(intentDe(rejouee)).toBe(recuAvant);
    expect((rejouee.result as { rejoue?: unknown }).rejoue).toBe(true);
    expect(rejouee.recu?.deduplicated).toBe(true);
    const intents = await prisma.assistantActionIntent.findMany({ where: { missionId: r.missionId }, select: { status: true } });
    expect(intents).toHaveLength(SALARIES.length);
    expect(intents.every((i) => i.status === "EXECUTED")).toBe(true);
    // LA PREUVE QUI COMPTE : pas un message de plus.
    expect(await messagesEnvoyes()).toBe(SALARIES.length);
    expect(etat!.status).toBe("WAITING_EVENT");
  }, 120_000);
});
