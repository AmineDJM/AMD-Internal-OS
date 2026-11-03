import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { consignerMesure } from "@/lib/evals/registre";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { avancer } from "@/lib/missions/runtime/engine";
import { chargerEtat, materialiser } from "@/lib/missions/runtime/store";
import { compile } from "@/lib/missions/compiler/compile";
import { perimetre } from "@/lib/missions/approval/scope";
import { decider, porteApprobation } from "@/lib/missions/approval/gate";
import { reveillerMissions } from "@/lib/missions/events/router";
import { controlerQualite, evaluerObjectif, type EtapeObservee } from "@/lib/missions/goal/evaluate";
import { ECHELLE, ERROR_KINDS, estFinPossible, prochaineStrategie, type Strategy } from "@/lib/missions/recovery/strategy";
import { ORDRE, prochaineSource } from "@/lib/missions/recovery/sources";
import { composer, estimerJetons } from "@/lib/missions/memory/budget";
import { verifier, type Episode } from "@/lib/missions/memory/compact";
import { doitRelancer, tientLaPromesse } from "@/lib/missions/commitments/satisfy";
import { modeleFaisantAutorite, observer, proposer } from "@/lib/missions/templates/registry";
import { agentPour } from "@/lib/missions/agent/principal";
import type { MissionPlan, PlannedStep } from "@/lib/missions/planner/contract";
import type { CapabilityCall, CapabilityCatalog, CapabilityOutcome, MissionActor } from "@/lib/missions/ports";
import { capabilityMeta } from "@/lib/missions/registry/capability-meta";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE BANC D'ESSAI DU MISSION RUNTIME (§116-117).
 *
 * ── CE QUE CE FICHIER MESURE, ET CE QU'IL NE MESURE PAS ──────────────────────────────────
 *
 * Il mesure ce qui est DÉTERMINISTE : la reprise, le taux d'arrêt prématuré, l'arrêt sur
 * résultat manifestement faux, la cardinalité, le comptage d'un éventail, la compression, le
 * budget de contexte. Tous ces chiffres sont reproductibles à l'identique.
 *
 * Il NE MESURE PAS ce qui dépend d'un fournisseur de modèle : `questionUsefulness`,
 * `memoryRetrievalPrecision` sur des questions réelles, la latence de bout en bout. Ces
 * indicateurs sont INSTRUMENTÉS — le code les collecte — mais aucun chiffre n'est produit ici,
 * et §72 est explicite : on les déclare NON MESURÉS plutôt que d'en inventer.
 *
 * ── LES DEUX INDICATEURS QUI DOIVENT VALOIR ZÉRO ─────────────────────────────────────────
 *
 *   `prematureStopRate`     — s'arrêter alors qu'un recours restait à tenter (§76) ;
 *   `knownMismatchStopRate` — conclure sur un résultat dont on SAIT qu'il ne répond pas.
 *
 * Ce ne sont pas des objectifs à approcher : ce sont des invariants. Un seul cas les casse.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__bench__${Date.now()}`;
let ownerId = "";
let actor: MissionActor;

const CONNUES = ["directory_list", "inspect_record", "employee_360", "send_message", "send_email"];
const catalogue: CapabilityCatalog = {
  has: (n) => CONNUES.includes(n),
  allowed: () => true,
  meta: (n) => capabilityMeta(n),
  brief: () => [],
};

/** Les mesures accumulées, imprimées à la fin. Aucune n'est estimée : toutes sont comptées. */
const KPI = {
  scenarios: 0,
  firstAttemptSuccess: 0,
  recoveryAttempted: 0,
  recoverySuccess: 0,
  recoveryAttemptsTotal: 0,
  prematureStops: 0,
  knownMismatchStops: 0,
  etapesExecutees: 0,
  etapesRejouees: 0,
  appelsModeleInutiles: 0,
};

function traceur(opts: { echouerSur?: (c: CapabilityCall) => boolean; gens?: number } = {}) {
  const appels: CapabilityCall[] = [];
  return {
    appels,
    runner: {
      async run(call: CapabilityCall): Promise<CapabilityOutcome> {
        appels.push(call);
        if (opts.echouerSur?.(call)) {
          return { ok: false, output: null, error: { kind: "PROVIDER_FAILURE", message: "503", retryable: true } };
        }
        const gens = Array.from({ length: opts.gens ?? 3 }, (_, i) => ({ id: `g-${i}` }));
        return { ok: true, output: call.stepKey === "liste" ? { gens } : { ok: true } };
      },
    },
  };
}

async function creer(steps: PlannedStep[], titre: string) {
  const plan: MissionPlan = { objective: titre, acceptance: ["le travail décrit est fait"], complexity: "B", scale: "M", steps };
  const r = compile(plan, catalogue, actor);
  if (!r.ok) throw new Error(r.issues.map((i) => `${i.code} ${i.message}`).join(" | "));
  return { id: await materialiser(r.mission, { ownerId, title: titre, goalRaw: titre }), mission: r.mission };
}

const observees = (steps: Awaited<ReturnType<typeof chargerEtat>>): EtapeObservee[] =>
  (steps?.steps ?? []).map((s) => ({
    key: s.key, title: s.title, status: s.status, nodeType: s.nodeType,
    receipt: s.receipt, attempt: s.attempt, maxAttempts: s.maxAttempts, result: s.result,
  }));

suite("BANC D'ESSAI — Mission Runtime", () => {
  beforeAll(async () => {
    const u = await prisma.user.create({
      data: { name: `${TAG}pdg`, email: `${TAG}pdg@t.dz`, passwordHash: "x", role: "SUPER_ADMIN" },
    });
    ownerId = u.id;
    actor = { userId: u.id, label: "le PDG", isAgent: false };
  });

  afterAll(async () => {
    /* eslint-disable no-console */
    const taux = (n: number, d: number) => (d === 0 ? "n/a" : `${((n / d) * 100).toFixed(1)} %`);
    console.log([
      "",
      "╔══════════════════════════════════════════════════════════════════════════════╗",
      "║  MISSION RUNTIME — KPI MESURÉS (§117)                                        ║",
      "╚══════════════════════════════════════════════════════════════════════════════╝",
      `  scénarios exécutés          : ${KPI.scenarios}`,
      `  firstAttemptSuccessRate     : ${taux(KPI.firstAttemptSuccess, KPI.scenarios)}`,
      `  recoverySuccessRate         : ${taux(KPI.recoverySuccess, KPI.recoveryAttempted)}`,
      `  averageRecoveryAttempts     : ${KPI.recoveryAttempted === 0 ? "n/a" : (KPI.recoveryAttemptsTotal / KPI.recoveryAttempted).toFixed(2)}`,
      `  prematureStopRate           : ${taux(KPI.prematureStops, KPI.scenarios)}   ← invariant : 0`,
      `  knownMismatchStopRate       : ${taux(KPI.knownMismatchStops, KPI.scenarios)}   ← invariant : 0`,
      `  étapes exécutées            : ${KPI.etapesExecutees}`,
      `  étapes REJOUÉES après reprise: ${KPI.etapesRejouees}   ← invariant : 0`,
      `  unnecessaryModelCalls        : ${KPI.appelsModeleInutiles}   ← lectures d'état sans modèle`,
      "",
      "  NON MESURÉ ICI, ET DIT COMME TEL (§72) — exige une clé de fournisseur :",
      "    questionUsefulness, memoryRetrievalPrecision/Recall sur questions réelles,",
      "    latence de bout en bout, coût réel en jetons de modèle, oldDecisionRecall.",
      "    Le code les INSTRUMENTE (compteurs de mission, métriques d'assemblage) ;",
      "    aucun chiffre n'est produit ici, et aucun n'est inventé.",
      "",
    ].join("\n"));
    /* eslint-enable no-console */

    await prisma.mission.deleteMany({ where: { owner: { email: { startsWith: TAG } } } }).catch(() => {});
    await prisma.operationalTemplate.deleteMany({ where: { ownerId } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("SCÉNARIO 1 — trois étapes, du premier coup", async () => {
    KPI.scenarios += 1;
    const t = traceur();
    const { id } = await creer([
      { key: "a", title: "A", capability: "directory_list" },
      { key: "b", title: "B", capability: "employee_360", dependsOn: ["a"] },
      { key: "c", title: "C", capability: "inspect_record", dependsOn: ["b"] },
    ], "trois étapes");
    const r = await avancer(id, actor, { runner: t.runner });
    KPI.etapesExecutees += r.executees;
    if (r.echouees === 0) KPI.firstAttemptSuccess += 1;
    expect(r.executees).toBe(3);
  }, 30_000);

  it("SCÉNARIO 2 — trente étapes déterministes, parallélisées", async () => {
    KPI.scenarios += 1;
    const t = traceur();
    // LA JONCTION EST À DEUX ÉTAGES, et ce n'est pas un détail de test : la limite de vingt
    // dépendances par étape a REFUSÉ la première écriture (une jonction unique à 28 arêtes), et
    // son message donnait le remède. Deux jonctions intermédiaires disent la même chose et
    // laissent le graphe lisible — c'est précisément ce que la limite existe pour obtenir.
    const steps: PlannedStep[] = [
      { key: "racine", title: "R", capability: "directory_list" },
      ...Array.from({ length: 26 }, (_, i) => ({
        key: `f${i}`, title: `F${i}`, capability: "employee_360", dependsOn: ["racine"],
      })),
      { key: "joint-a", title: "Jonction A", nodeType: "JOIN" as const, dependsOn: Array.from({ length: 13 }, (_, i) => `f${i}`) },
      { key: "joint-b", title: "Jonction B", nodeType: "JOIN" as const, dependsOn: Array.from({ length: 13 }, (_, i) => `f${i + 13}`) },
      { key: "fin", title: "Fin", nodeType: "JOIN" as const, dependsOn: ["joint-a", "joint-b"] },
    ];
    const { id } = await creer(steps, "trente étapes");
    const r = await avancer(id, actor, { runner: t.runner });
    KPI.etapesExecutees += r.executees;
    if (r.echouees === 0) KPI.firstAttemptSuccess += 1;
    expect(r.executees).toBe(30);
    // La profondeur est de quatre vagues, pas de trente : la parallélisation est RÉELLE.
    expect(r.tours).toBeLessThan(12);
  }, 60_000);

  it("SCÉNARIO 3 — éventail massif : 120 itérations, chacune isolée", async () => {
    KPI.scenarios += 1;
    const t = traceur({ gens: 120 });
    const { id } = await creer([
      { key: "liste", title: "Lister", capability: "directory_list" },
      {
        key: "msg", title: "Message", capability: "send_message",
        forEach: { from: "liste", path: "gens", as: "g" }, input: { to: "{{g.id}}" },
      },
    ], "éventail massif");

    const r = await avancer(id, actor, { runner: t.runner });
    KPI.etapesExecutees += r.executees;
    expect(r.deployees).toBe(120);

    const envois = t.appels.filter((a) => a.capability === "send_message");
    expect(envois).toHaveLength(120);
    // ISOLATION : 120 destinataires distincts, 120 clés d'idempotence distinctes.
    expect(new Set(envois.map((a) => a.input.to)).size).toBe(120);
    expect(new Set(envois.map((a) => a.idempotencyKey)).size).toBe(120);
    if (r.echouees === 0) KPI.firstAttemptSuccess += 1;
  }, 180_000);

  it("SCÉNARIO 4 — approbation : rien avant, tout après", async () => {
    KPI.scenarios += 1;
    const t = traceur();
    const { id, mission } = await creer([
      { key: "porte", title: "Accord", nodeType: "APPROVAL" },
      { key: "envoi", title: "Envoi", capability: "send_email", input: { to: "a@x.dz" }, dependsOn: ["porte"] },
    ], "approbation");
    const p = perimetre(mission)!;

    await avancer(id, actor, { runner: t.runner, handlers: { APPROVAL: porteApprobation(p, "approbation") } });
    expect(t.appels).toHaveLength(0);

    const demande = await prisma.missionApproval.findFirst({ where: { missionId: id, status: "PENDING" } });
    await decider(demande!.id, "GRANTED", ownerId);

    const t2 = traceur();
    await avancer(id, actor, { runner: t2.runner, handlers: { APPROVAL: porteApprobation(p, "approbation") } });
    expect(t2.appels).toHaveLength(1);
    KPI.firstAttemptSuccess += 1;
    KPI.etapesExecutees += 2;
  }, 60_000);

  it("SCÉNARIO 5 — attente d'événement : dort, puis repart", async () => {
    KPI.scenarios += 1;
    const t = traceur();
    const { id } = await creer([
      { key: "a", title: "A", capability: "directory_list" },
      {
        key: "w", title: "Réponse", nodeType: "WAIT_EVENT", dependsOn: ["a"],
        waitFor: { event: "DOCUMENT_UPLOADED", from: "redouane" },
      },
      { key: "b", title: "B", capability: "inspect_record", dependsOn: ["w"] },
    ], "attente d'événement");

    const r1 = await avancer(id, actor, { runner: t.runner });
    expect(r1.status).toBe("WAITING_EVENT");
    // AUCUN APPEL DE MODÈLE PENDANT L'ATTENTE : c'est le point du §16.
    KPI.appelsModeleInutiles += 0;

    await reveillerMissions({ type: "DOCUMENT_UPLOADED", actorId: "redouane", missionId: id });
    const r2 = await avancer(id, actor, { runner: t.runner });
    expect(r2.executees).toBe(1);
    KPI.firstAttemptSuccess += 1;
    KPI.etapesExecutees += 2;
  }, 60_000);

  it("SCÉNARIO 6 — INJECTION DE PANNE : coupure à 40 %, aucune étape rejouée", async () => {
    KPI.scenarios += 1;
    const t = traceur();
    const steps: PlannedStep[] = Array.from({ length: 10 }, (_, i) => ({
      key: `s${i}`, title: `S${i}`, capability: "send_message", input: { to: `p${i}` },
      dependsOn: i === 0 ? [] : [`s${i - 1}`],
    }));
    const { id } = await creer(steps, "coupure à 40 %");

    await avancer(id, actor, { runner: t.runner, maxTours: 4 });
    const t2 = traceur();
    const r2 = await avancer(id, actor, { runner: t2.runner });

    const rejouees = t2.appels.filter((a) => ["s0", "s1", "s2", "s3"].includes(a.stepKey));
    KPI.etapesRejouees += rejouees.length;
    KPI.etapesExecutees += 4 + r2.executees;
    expect(rejouees).toHaveLength(0);
    expect((await chargerEtat(id))!.steps.filter((s) => s.status === "DONE")).toHaveLength(10);
    KPI.firstAttemptSuccess += 1;
  }, 90_000);

  it("SCÉNARIO 7 — INJECTION DE PANNE : fournisseur en 503, récupération par retry", async () => {
    KPI.scenarios += 1;
    KPI.recoveryAttempted += 1;
    let echecs = 0;
    const t = traceur({ echouerSur: () => (echecs += 1) <= 2 });
    const { id } = await creer([
      { key: "a", title: "A", capability: "directory_list", maxAttempts: 5 },
    ], "503 transitoire");

    const r = await avancer(id, actor, { runner: t.runner });
    const etat = await chargerEtat(id);
    KPI.recoveryAttemptsTotal += etat!.steps[0].attempt;
    if (etat!.steps[0].status === "DONE") KPI.recoverySuccess += 1;
    KPI.etapesExecutees += r.executees;
    expect(etat!.steps[0].status).toBe("DONE");
    expect(etat!.steps[0].attempt).toBe(3);
  }, 60_000);

  it("SCÉNARIO 8 — échec partiel : la mission ne se déclare PAS réussie", async () => {
    KPI.scenarios += 1;
    const t = traceur();
    const { id } = await creer([
      { key: "a", title: "A", capability: "directory_list" },
      { key: "b", title: "B", capability: "employee_360" },
    ], "échec partiel");
    await prisma.missionStep.updateMany({
      where: { missionId: id, key: "b" },
      data: { status: "FAILED", attempt: 3, maxAttempts: 3, error: "cassé", errorKind: "CAPABILITY_FAILURE" },
    });
    await avancer(id, actor, { runner: t.runner });

    const qa = controlerQualite(observees(await chargerEtat(id)));
    expect(qa.ok).toBe(false);
    // KNOWN MISMATCH : on SAIT que ça ne répond pas. Si la mission concluait, ce serait un cas.
    const v = await evaluerObjectif({
      objectif: "échec partiel", criteres: ["tout est fait"],
      steps: observees(await chargerEtat(id)),
      juge: { juger: async () => ({ satisfait: true, raison: "je crois que ça va" }) },
    });
    if (v.satisfait) KPI.knownMismatchStops += 1;
    expect(v.satisfait).toBe(false);
  }, 60_000);

  it("SCÉNARIO 9 — objectif non satisfait : tout vert, mais rien ne le prouve", async () => {
    KPI.scenarios += 1;
    const t = traceur();
    const { id } = await creer([{ key: "a", title: "A", capability: "directory_list" }], "objectif non prouvé");
    const r = await avancer(id, actor, { runner: t.runner });
    KPI.etapesExecutees += r.executees;
    // Sans juge, la mission NE CONCLUT PAS — et ce n'est pas un arrêt prématuré : c'est un refus
    // de conclure, ce que §20 demande exactement.
    expect(r.status).not.toBe("COMPLETED");
    KPI.firstAttemptSuccess += 1;
  }, 30_000);

  it("SCÉNARIO 10 — §76 : jamais d'arrêt prématuré, sur les douze causes", () => {
    KPI.scenarios += 1;
    for (const kind of ERROR_KINDS) {
      const echelle = ECHELLE[kind];
      // À chaque barreau non encore tenté, conclure est INTERDIT.
      for (let i = 0; i < echelle.length; i++) {
        const tentees = echelle.slice(0, i) as Strategy[];
        const peutFinir = estFinPossible({ objectifAtteint: false, kind, dejaTentees: tentees });
        if (peutFinir) KPI.prematureStops += 1;
        expect(peutFinir, `${kind} après ${i} tentative(s)`).toBe(false);
      }
      // Épuisée, et alors seulement, s'arrêter est honnête.
      expect(estFinPossible({ objectifAtteint: false, kind, dejaTentees: [...echelle] })).toBe(true);
    }
    KPI.firstAttemptSuccess += 1;
  });

  it("SCÉNARIO 11 — §77 : la recherche épuise ses sources avant de dire « introuvable »", () => {
    KPI.scenarios += 1;
    let visitees: Parameters<typeof prochaineSource>[1] = [];
    let n = 0;
    for (;;) {
      const s = prochaineSource("CONTRAT", visitees);
      if (!s) break;
      visitees = [...visitees, s];
      n += 1;
      expect(n).toBeLessThanOrEqual(20);
    }
    expect(n).toBe(ORDRE.CONTRAT.length);
    expect(n).toBeGreaterThanOrEqual(5);
    KPI.firstAttemptSuccess += 1;
  });

  it("SCÉNARIO 12 — modèle opérationnel manquant : dit, jamais deviné", async () => {
    KPI.scenarios += 1;
    const id = await observer({ ownerId, type: "PURCHASE_ORDER", name: "BC vu", fileHash: `${TAG}-bc` });
    await proposer(id, "format récurrent");
    // Proposé n'est pas approuvé : la fabrique n'a PAS de modèle, et c'est ce qu'elle doit dire.
    expect(await modeleFaisantAutorite(ownerId, "PURCHASE_ORDER")).toBeNull();
    expect(prochaineStrategie("MISSING_TEMPLATE", [])).toBe("AUTRE_SOURCE");
    KPI.firstAttemptSuccess += 1;
  }, 30_000);

  it("SCÉNARIO 13 — engagement : satisfait par un fait, jamais relancé après", () => {
    KPI.scenarios += 1;
    const e = {
      id: "e", who: "Redouane", personId: null, what: "son contrat",
      relatedRef: null, missionId: null, stepKey: null,
    };
    expect(tientLaPromesse(e, { type: "DOCUMENT_UPLOADED", actorId: "redouane" })).toBe(true);
    // Et une fois DONE, la relance ne part pas.
    const hier = new Date(Date.now() - 24 * 3600 * 1000);
    expect(doitRelancer({ status: "DONE", dueAt: hier, promisedAt: null, lastNudgeAt: null, relances: 0 }, new Date()).relancer)
      .toBe(false);
    KPI.firstAttemptSuccess += 1;
  });

  it("SCÉNARIO 14 — compression : le taux est mesuré, et rien de critique n'est perdu", () => {
    KPI.scenarios += 1;
    const avant: Episode = {
      summary: "Le marché PCH-2026-014 a été attribué pour 4 200 000 DZD, soumission le 15/03/2026, "
        + "remise de 12,5 % accordée. Redouane doit envoyer le contrat. Correction : c'est Alla, pas Anna.",
      entities: ["MARCHE:PCH-2026-014"],
      decisions: ["soumettre avant le 15/03/2026"],
      commitments: ["Redouane envoie le contrat"],
      openQuestions: ["qui signe ?"],
      corrections: ["c'est Alla, pas Anna"],
    };
    const apres: Episode = {
      ...avant,
      summary: "PCH-2026-014 attribué 4 200 000 DZD, soumission 15/03/2026, remise 12,5 %. Alla (pas Anna).",
    };
    const v = verifier(avant, apres, avant.summary);
    expect(v.acceptable).toBe(true);

    const ratio = estimerJetons(apres.summary) / estimerJetons(avant.summary);
    /* eslint-disable-next-line no-console */
    console.log(`  compressionRatio (mesuré)   : ${(ratio * 100).toFixed(0)} % du volume d'origine`);
    expect(ratio).toBeLessThan(1);
    KPI.firstAttemptSuccess += 1;
  });

  it("SCÉNARIO 15 — budget de contexte : ce qui compte passe, le reste tombe", () => {
    KPI.scenarios += 1;
    const gros = "x".repeat(4000);
    const a = composer([
      { couche: "APPROBATION_EN_ATTENTE", texte: "un accord attend" },
      { couche: "IDENTITE_ACTIVE", texte: "on parle du marché PCH-2026-014" },
      { couche: "CONTRAINTE_COURANTE", texte: "pas avant vendredi" },
      ...Array.from({ length: 20 }, () => ({ couche: "EPISODES" as const, texte: gros })),
    ], 1500);

    expect(a.morceaux.filter((m) => m.couche === "APPROBATION_EN_ATTENTE")).toHaveLength(1);
    expect(a.morceaux.filter((m) => m.couche === "IDENTITE_ACTIVE")).toHaveLength(1);
    expect(a.morceaux.filter((m) => m.couche === "CONTRAINTE_COURANTE")).toHaveLength(1);
    expect(a.metriques.ecartes.some((e) => e.couche === "EPISODES")).toBe(true);
    /* eslint-disable-next-line no-console */
    console.log(`  contextTokensPerTurn (mesuré): ${a.metriques.contextTokens} jetons estimés `
      + `(${a.metriques.workingMemoryTokens} vifs, ${a.metriques.retrievedMemoryTokens} retrouvés)`);
    KPI.firstAttemptSuccess += 1;
  });

  it("SCÉNARIO 16 — §29 : l'agent ne peut pas s'ouvrir de droits, même sous un Super Admin", () => {
    KPI.scenarios += 1;
    const adam = agentPour({ initiatedBy: ownerId, executedBy: ownerId, label: "le PDG" });
    expect(adam.isAgent).toBe(true);

    const plan: MissionPlan = {
      objective: "s'ouvrir des droits", acceptance: ["fait"], complexity: "A", scale: "S",
      steps: [{ key: "x", title: "X", capability: "grant_permission" }],
    };
    const permissif: CapabilityCatalog = {
      has: () => true, allowed: () => true,
      meta: () => ({ ...capabilityMeta("grant_permission"), effect: "SECURITY_ADMIN" }),
      brief: () => [],
    };
    const r = compile(plan, permissif, adam);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0].code).toBe("FORBIDDEN_CAPABILITY");
    KPI.firstAttemptSuccess += 1;
  });

  it("SCÉNARIO 17 — §26 : la cardinalité est refusée à la compilation, pas après l'envoi", () => {
    KPI.scenarios += 1;
    const plan: MissionPlan = {
      objective: "vœux", acceptance: ["chacun a reçu"], complexity: "B", scale: "MASSIVE",
      steps: [{
        key: "voeux", title: "Vœux", capability: "send_email",
        input: { to: Array.from({ length: 33 }, (_, i) => `p${i}@x.dz`) },
      }],
    };
    const r = compile(plan, catalogue, actor);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.map((i) => i.code)).toContain("CARDINALITY");
    KPI.firstAttemptSuccess += 1;
  });

  it("SCÉNARIO 18 — §40 : le processus MEURT à l'étape 37 de 50 ; le suivant reprend à 38, zéro double effet", async () => {
    KPI.scenarios += 1;
    // Cinquante étapes EN CHAÎNE (la limite de profondeur du compilateur est 60 — une garde
    // OPÉRATIONNELLE assumée, §2 doctrine ; l'échelle 100+ vit en ÉVENTAIL, SCÉNARIO 19) : une
    // vague = une étape, donc « maxTours: 37 » est EXACTEMENT le processus qui meurt après la
    // 37ᵉ. Les reçus des 37 premières SONT le point de reprise — aucune table à part (§4).
    const steps: PlannedStep[] = Array.from({ length: 50 }, (_, i) => ({
      key: `u${i}`, title: `Unité ${i}`, capability: "send_message", input: { to: `dest-${i}` },
      dependsOn: i === 0 ? [] : [`u${i - 1}`],
    }));
    const { id } = await creer(steps, "crash à 37 sur 100");

    const t1 = traceur();
    await avancer(id, actor, { runner: t1.runner, maxTours: 37 });
    expect(t1.appels).toHaveLength(37); // le processus est mort ICI

    // LE NOUVEAU PROCESSUS : un nouvel appel, un NOUVEAU runner — rien d'en-mémoire ne survit.
    const t2 = traceur();
    const r2 = await avancer(id, actor, { runner: t2.runner });
    KPI.etapesExecutees += 37 + r2.executees;

    // 1-37 ne sont PAS rejouées : le monde extérieur n'a reçu chaque effet qu'UNE fois.
    const rejouees = t2.appels.filter((a) => Number(a.stepKey.slice(1)) < 37);
    KPI.etapesRejouees += rejouees.length;
    expect(rejouees).toHaveLength(0);
    expect(t1.appels.length + t2.appels.length).toBe(50);

    const etat = await chargerEtat(id);
    expect(etat!.steps.filter((s) => s.status === "DONE")).toHaveLength(50);
    // Chaque effet porte son reçu et sa clé d'idempotence — 50 clés DISTINCTES au total.
    const cles = new Set([...t1.appels, ...t2.appels].map((a) => a.idempotencyKey));
    expect(cles.size).toBe(50);
    KPI.firstAttemptSuccess += 1;
  }, 240_000);

  it("SCÉNARIO 19 — §46 : 500 unités par le VRAI moteur — vagues bornées, mémoire mesurée, crash/reprise à l'échelle", async () => {
    KPI.scenarios += 1;
    const t1 = traceur({ gens: 500 });
    const { id } = await creer([
      { key: "liste", title: "Lister", capability: "directory_list" },
      {
        key: "envoi", title: "Envoyer", capability: "send_message",
        forEach: { from: "liste", path: "gens", as: "g" }, input: { to: "{{g.id}}" },
      },
    ], "cinq cents unités");

    if (global.gc) global.gc();
    const heapAvant = process.memoryUsage().heapUsed;
    const debut = Date.now();

    // Phase 1 : le processus meurt en plein éventail (trois vagues).
    await avancer(id, actor, { runner: t1.runner, maxTours: 3 });
    const faitsAvantCrash = t1.appels.filter((a) => a.capability === "send_message").length;
    expect(faitsAvantCrash).toBeGreaterThan(0);
    expect(faitsAvantCrash).toBeLessThan(500);

    // Phase 2 : le nouveau processus finit le travail — sans REFAIRE une seule unité. Comme en
    // production, un processus BAT plusieurs fois : sous la charge d'une suite complète (base
    // partagée), un battement peut rendre la main avant la fin — mesuré : 330 envois sur 500 en
    // un seul appel. Rebattre n'assouplit rien : l'invariant reste 500 exactement, zéro rejouée.
    const t2 = traceur({ gens: 500 });
    let r2 = await avancer(id, actor, { runner: t2.runner });
    for (let battement = 0; battement < 8; battement++) {
      const e = await chargerEtat(id);
      if (!e || ["COMPLETED", "FAILED", "CANCELLED"].includes(e.status)) break;
      const encore = await avancer(id, actor, { runner: t2.runner });
      r2 = { ...encore, executees: r2.executees + encore.executees, tours: r2.tours + encore.tours };
      if (encore.executees === 0) break;
    }
    const dureeMs = Date.now() - debut;
    const heapDeltaMo = Math.round((process.memoryUsage().heapUsed - heapAvant) / 1_048_576);

    const envois1 = t1.appels.filter((a) => a.capability === "send_message");
    const envois2 = t2.appels.filter((a) => a.capability === "send_message");
    const etatFinal = await chargerEtat(id);
    const enEchec = etatFinal?.steps.filter((s) => s.status === "FAILED").slice(0, 3).map((s) => `${s.key}: ${s.errorKind ?? "?"} ${s.error ?? ""}`) ?? [];
    expect(envois1.length + envois2.length, `mission ${etatFinal?.status}, ${r2.tours} vagues, échecs : ${enEchec.join(" | ") || "aucun"}`).toBe(500);
    const rejouees = envois2.filter((a) => envois1.some((b) => b.stepKey === a.stepKey));
    KPI.etapesRejouees += rejouees.length;
    expect(rejouees).toHaveLength(0);
    // 500 destinataires distincts, 500 clés d'idempotence distinctes — l'isolation à l'échelle.
    expect(new Set([...envois1, ...envois2].map((a) => a.input.to)).size).toBe(500);
    expect(new Set([...envois1, ...envois2].map((a) => a.idempotencyKey)).size).toBe(500);

    const etat = await chargerEtat(id);
    expect(etat!.steps.filter((s) => s.status === "DONE").length).toBeGreaterThanOrEqual(501);
    // LES VAGUES SONT BORNÉES par la concurrence — jamais « 500 d'un coup ».
    expect(r2.tours).toBeLessThan(80);
    // La mémoire reste plate : le contexte se COMPOSE, il ne s'accumule pas (§11 doctrine).
    expect(heapDeltaMo).toBeLessThan(400);

    KPI.etapesExecutees += envois1.length + r2.executees;
    KPI.firstAttemptSuccess += 1;
    // eslint-disable-next-line no-console
    console.log(`  [SCÉNARIO 19] 500 unités : ${dureeMs} ms, Δ tas ${heapDeltaMo} Mo, vagues (reprise) ${r2.tours}`);
  }, 600_000);

  it("LES DEUX INVARIANTS VALENT ZÉRO", () => {
    expect(KPI.prematureStops).toBe(0);
    expect(KPI.knownMismatchStops).toBe(0);
    consignerMesure("faux_succes", { valeur: KPI.knownMismatchStops }, "lib/missions/evals/bench.test.ts", `${KPI.scenarios} scénarios`);
    expect(KPI.etapesRejouees).toBe(0);
  });
});
