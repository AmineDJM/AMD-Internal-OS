import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { consignerMesure } from "@/lib/evals/registre";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { Prisma } from "@prisma/client";
import { getAccess, type EffectiveAccess } from "@/lib/rbac";
import type { CurrentUser } from "@/lib/session";
import type { ReasonRequest } from "@/lib/missions/ports";
import { lancerMission, avancerMission } from "@/platform/in-process/missions/runtime";
import { RaisonneurScripte, pour, planScripte } from "@/platform/in-process/missions/fake-reasoner";
import { decider } from "@/lib/missions/approval/gate";
import { chargerEtat } from "@/lib/missions/runtime/store";
import { BAIL_MS } from "@/lib/missions/runtime/engine";
import { reveillerAttentesTemporelles } from "@/lib/missions/events/router";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CRASH À CHAQUE FRONTIÈRE D'ÉTAPE — « 100 % de reprise, 0 effet dupliqué », mesuré.
 *
 * `crash-between.test.ts` prouve UN crash (effet fait, reçu perdu, sur un envoi). Ce banc
 * généralise : la MÊME mission (lecture → accord → un message par salarié → attente réglée par
 * le temps → contrôle) est rejouée autant de fois qu'elle a d'étapes réelles, et à chaque
 * rejeu le processus « meurt » juste après une étape différente — l'étape est remise à RUNNING,
 * bail expiré, reçu et résultat effacés, comme la laisserait un processus tué. La reprise passe
 * par l'entrée de production, et l'on mesure : la mission conclut, chaque étape est faite UNE
 * fois, le nombre de messages est exactement le nombre de salariés, chaque intent est EXÉCUTÉ.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__cm${Date.now()}`;
const SUFFIXE = TAG.slice(-5);
const SALARIES = [`Nour Haddad ${SUFFIXE}`, `Sofiane Merabet ${SUFFIXE}`];
let pdg: CurrentUser;
let companyId = "";
const criteres = ["Chaque salarié a reçu SON message, une seule fois."];

const juge = pour("mission.judge", (req: ReasonRequest) => {
  const cles = [...req.prompt.matchAll(/^- ([a-z0-9:_#-]+) : /gim)].map((m) => m[1]);
  return { ok: true, data: { satisfied: true, confidence: 0.9, criteria: criteres.map((c) => ({ criterion: c, status: "SATISFAIT", evidenceRefs: cles.slice(0, 3) })), missing: [], contradictions: [], suggestedRecovery: null } };
});

const plan = () => planScripte({
  goal: "Écrire individuellement à chaque salarié, attendre l'échéance, contrôler.",
  reasoningComplexity: "B", executionScale: "S", acceptanceCriteria: criteres, workstreams: [],
  steps: [
    { key: "liste:salaries", title: "Lister les salariés", nodeType: "CAPABILITY", capability: "directory_list",
      inputs: [{ key: "department", kind: "TEXT", value: TAG }, { key: "limit", kind: "NUMBER", value: "50" }], dependsOn: [], completionCondition: "la liste est chargée" },
    { key: "accord:envois", title: "Votre accord", nodeType: "APPROVAL", dependsOn: ["liste:salaries"], approvalRequirement: "NORMAL", completionCondition: "l'accord est donné" },
    { key: "message", title: "Message individuel", nodeType: "CAPABILITY", capability: "send_message",
      inputs: [{ key: "recipientName", kind: "TEXT", value: "{{salarie.nom}}" }, { key: "body", kind: "TEXT", value: "Bonjour {{salarie.nom}} — un message, une fois." }],
      dependsOn: ["accord:envois"], forEach: { from: "liste:salaries", path: "salaries", as: "salarie" }, approvalRequirement: "NORMAL", completionCondition: "chaque salarié a son message" },
    { key: "attente:echeance", title: "Attendre l'échéance", nodeType: "WAIT_EVENT", waitEvent: "TEMPS", waitUntil: new Date(Date.now() - 60_000).toISOString(),
      dependsOn: ["message"], completionCondition: "l'échéance est passée" },
    { key: "controle", title: "Contrôle final", nodeType: "QA", dependsOn: ["attente:echeance"], completionCondition: "autant de messages que de salariés" },
  ],
  expectedArtifacts: [], approvalStrategy: "BUNDLE", completionCriteria: criteres[0], gaps: [], rationale: "banc du crash à chaque frontière",
});

/** CONDUIT la mission jusqu'à un état terminal, par l'entrée de production, en réglant le temps et les accords comme le battement et l'écran le feraient. */
async function conduire(missionId: string, cerveau: RaisonneurScripte, arret?: (etapes: Record<string, string>) => boolean): Promise<Record<string, string>> {
  for (let tour = 0; tour < 30; tour++) {
    await reveillerAttentesTemporelles(new Date());
    const accord = await prisma.missionApproval.findFirst({ where: { missionId, status: "PENDING" }, select: { id: true } });
    if (accord) await decider(accord.id, "GRANTED", pdg.id);
    await avancerMission(pdg, missionId, { reasoner: cerveau });
    const etat = await chargerEtat(missionId);
    const etapes = Object.fromEntries(etat!.steps.map((s) => [s.key, s.status]));
    if (arret?.(etapes)) return etapes;
    if (["COMPLETED", "FAILED", "CANCELLED", "BLOCKED", "PARTIAL"].includes(etat!.status)) return etapes;
  }
  const etat = await chargerEtat(missionId);
  return Object.fromEntries(etat!.steps.map((s) => [s.key, s.status]));
}

const messagesDepuis = (t: Date) => prisma.message.count({ where: { senderId: pdg.id, createdAt: { gte: t } } });

suite("CRASH À CHAQUE FRONTIÈRE — la reprise conclut, sans doublon, quelle que soit l'étape tuée", () => {
  beforeAll(async () => {
    const c = await prisma.company.create({ data: { name: `${TAG} Pharma`, shortName: TAG.slice(0, 12) }, select: { id: true } });
    companyId = c.id;
    const u = await prisma.user.create({ data: { name: `${TAG} PDG`, email: `${TAG}pdg@amd.dz`, passwordHash: "x", role: "SUPER_ADMIN" }, select: { id: true, name: true, email: true, role: true } });
    pdg = { id: u.id, name: u.name, email: u.email, role: u.role, access: (await getAccess(u.id, u.role)) as EffectiveAccess, mustChangePassword: false };
    for (const [i, nom] of SALARIES.entries()) {
      const compte = await prisma.user.create({ data: { name: nom, email: `${TAG}${i}@amd.dz`, passwordHash: "x", role: "SALES_USER" }, select: { id: true } });
      await prisma.employee.create({ data: { fullName: nom, email: `${TAG}${i}@amd.dz`, position: "Délégué", department: TAG, isActive: true, companyId, userId: compte.id } });
    }
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

  it("la référence : la mission conclut, un message par salarié, et les frontières à tester sont connues", async () => {
    const cerveau = new RaisonneurScripte([pour("mission.plan", () => ({ ok: true, data: plan() })), juge]);
    const t0 = new Date();
    const r = await lancerMission(pdg, "Écris individuellement à chaque salarié, attends l'échéance, contrôle.", { reasoner: cerveau });
    if (!r.ok) throw new Error(r.error);
    const etapes = await conduire(r.missionId, cerveau);
    const etat = await chargerEtat(r.missionId);
    expect(etat!.status, JSON.stringify(etapes)).toBe("COMPLETED");
    expect(await messagesDepuis(t0)).toBe(SALARIES.length);
    expect(Object.keys(etapes).filter((k) => k.startsWith("message#"))).toHaveLength(SALARIES.length);
  }, 120_000);

  it("chaque étape tuée juste après son effet est reprise sans doublon, et la mission conclut — 100 % des frontières", async () => {
    // Les filles d'un éventail portent un identifiant (« message#<cuid> ») : la frontière se
    // CHOISIT sur la mission réelle, au moment où elle existe.
    const filles = (e: Record<string, string>) => Object.keys(e).filter((k) => k.startsWith("message#")).sort();
    const frontieres: { nom: string; choisir: (e: Record<string, string>) => string | undefined }[] = [
      { nom: "liste:salaries", choisir: () => "liste:salaries" },
      { nom: "message (1re fille)", choisir: (e) => filles(e)[0] },
      { nom: "message (2e fille)", choisir: (e) => filles(e)[1] },
      { nom: "attente:echeance", choisir: () => "attente:echeance" },
      { nom: "controle", choisir: () => "controle" },
    ];
    const bilan: { frontiere: string; statut: string; messages: number; intents: number; dedupliquees: number }[] = [];
    for (const { nom, choisir } of frontieres) {
      const cerveau = new RaisonneurScripte([pour("mission.plan", () => ({ ok: true, data: plan() })), juge]);
      const t0 = new Date();
      const r = await lancerMission(pdg, `Écris à chaque salarié (crash après ${nom}).`, { reasoner: cerveau });
      if (!r.ok) throw new Error(r.error);

      // 1. Conduire jusqu'à ce que la frontière soit franchie.
      const avant = await conduire(r.missionId, cerveau, (e) => { const k = choisir(e); return Boolean(k) && e[k!] === "DONE"; });
      const frontiere = choisir(avant);
      expect(frontiere && avant[frontiere], `${nom} devait être DONE avant le crash (${JSON.stringify(avant)})`).toBe("DONE");

      // 2. LE CRASH : l'effet est fait, le reçu est perdu, le bail a expiré.
      const victime = (await chargerEtat(r.missionId))!.steps.find((s) => s.key === frontiere)!;
      await prisma.missionStep.update({
        where: { id: victime.id },
        // `undefined` dirait à Prisma « ne touche pas » : le reçu et le résultat sont EFFACÉS, comme
        // les laisserait un processus tué avant de les écrire.
        data: { status: "RUNNING", receipt: null, receiptData: Prisma.DbNull, result: Prisma.DbNull, completedAt: null, startedAt: new Date(Date.now() - BAIL_MS - 5_000) },
      });
      await prisma.mission.update({ where: { id: r.missionId }, data: { status: "RUNNING" } });

      // 3. LA REPRISE, par l'entrée de production, jusqu'au bout.
      const apres = await conduire(r.missionId, cerveau);
      const etat = await chargerEtat(r.missionId);
      const intents = await prisma.assistantActionIntent.findMany({ where: { missionId: r.missionId }, select: { status: true } });
      const dedup = await prisma.missionStep.count({ where: { missionId: r.missionId, receipt: "DEDUPLIQUE" } });
      bilan.push({ frontiere: nom, statut: etat!.status, messages: await messagesDepuis(t0), intents: intents.length, dedupliquees: dedup });

      expect(etat!.status, `${nom} : ${JSON.stringify(apres)}`).toBe("COMPLETED");
      expect(apres[frontiere!]).toBe("DONE");
      expect(await messagesDepuis(t0), `${nom} : messages dupliqués`).toBe(SALARIES.length);
      expect(intents).toHaveLength(SALARIES.length);
      expect(intents.every((i) => i.status === "EXECUTED")).toBe(true);
      if (frontiere!.startsWith("message#")) expect(dedup, `${nom} : la reprise doit reconnaître l'effet déjà produit`).toBeGreaterThanOrEqual(1);
    }
    // Le tableau est la mesure : 5 frontières, 5 reprises, 0 doublon.
    expect(bilan.filter((b) => b.statut === "COMPLETED")).toHaveLength(frontieres.length);
    // LES MESURES §33 : la reprise déterministe, et « 0 action sans preuve » — une étape de capacité
    // terminée porte son reçu structuré (ou la marque DEDUPLIQUE, qui EST la preuve qu'un reçu existe
    // ailleurs). Le MODÈLE d'un éventail (`forEach` posé) n'agit pas lui-même : ses preuves sont les reçus
    // de ses filles `clé#n`, qui sont comptées ; il est donc exclu du dénominateur, pas exempté.
    consignerMesure("workflows_deterministes", { n: bilan.length, ok: bilan.filter((b) => b.statut === "COMPLETED").length }, "platform/in-process/missions/crash-matrix.test.ts");
    const feuilles = { mission: { ownerId: pdg.id }, status: "DONE" as const, nodeType: "CAPABILITY", forEach: { equals: Prisma.AnyNull } };
    const faites = await prisma.missionStep.count({ where: feuilles });
    const sansPreuve = await prisma.missionStep.count({ where: { ...feuilles, receipt: null, receiptData: { equals: Prisma.AnyNull } } });
    expect(sansPreuve, "une étape DONE sans reçu ni marque de dédoublonnage").toBe(0);
    consignerMesure("action_sans_preuve", { n: faites, ok: faites - sansPreuve }, "platform/in-process/missions/crash-matrix.test.ts");
  }, 300_000);
});
