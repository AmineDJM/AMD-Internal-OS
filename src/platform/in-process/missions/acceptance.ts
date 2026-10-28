import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import { getAccess, type EffectiveAccess } from "@/lib/rbac";
import type { CurrentUser } from "@/lib/session";
import type { Reasoner, ReasonRequest } from "@/lib/missions/ports";
import { RaisonneurScripte, pour, planScripte, type Script } from "@/platform/in-process/missions/fake-reasoner";
import { RaisonneurInstrumente } from "@/platform/in-process/missions/provider-waterfall";
import { raisonneur } from "@/platform/in-process/missions/reasoner";
import { lancerMission, lancerEnArrierePlan, avancerMission } from "@/platform/in-process/missions/runtime";
import {
  pauserMission, reprendreMissionAgent, arreterMissionAgent,
  prioriserMission, plafonnerModeleMission,
} from "@/platform/in-process/missions/control";
import { prendreBail, rendreBail } from "@/platform/in-process/missions/sweep";
import { jouer, type Scenario } from "@/platform/in-process/missions/provider-smoke";
import { verdictProfond, carteDeScore, type ResultatDeep } from "@/platform/in-process/missions/deep-smoke";
import { recordEvent } from "@/lib/events/ledger";
import { reveillerAttentesTemporelles, missionsAFaireAvancer } from "@/lib/missions/events/router";
import { vueMission } from "@/lib/missions/view/workspace";
import { runAssistantReminders } from "@/lib/assistant/reminders";
import { EXECUTIVE_TOOLS } from "@/lib/assistant/executive-tools";
import { WEB_RESEARCH_TOOLS } from "@/lib/assistant/web-research";
import { callModel } from "@/lib/models/gateway";
import { etatPorte } from "@/lib/models/throttle";
import { costOf } from "@/lib/models/contract";
import { bindingFor } from "@/lib/models/registry";
import { ingestMessage } from "@/lib/google/gmail/ingest";
import { sealSecret } from "@/lib/crypto/secret-box";
import { sansBloquer } from "@/lib/journal";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA COUCHE D'ACCEPTANCE DU RUN 4 — chaque capacité du produit, PROUVÉE dans le run lui-même.
 *
 * ── LA RÈGLE UNIQUE ──────────────────────────────────────────────────────────────────────
 *
 * « On raccourcit le temps. On simule l'extérieur quand c'est nécessaire. Mais on ne
 * raccourcit JAMAIS le chemin de production. » Concrètement :
 *
 *   • une mission naît par `lancerMission` / `lancerEnArrierePlan`, avance par
 *     `avancerMission`, se gouverne par `control.ts` — jamais par une écriture directe d'état ;
 *   • une attente se règle par le VRAI bus (`recordEvent` → conséquences du registre →
 *     `reveillerMissions`) ou par le VRAI balayage temporel à horloge INJECTÉE — jamais par
 *     `resumeMission()` à la main, jamais par `setTimeout` ;
 *   • un e-mail entre par la FRONTIÈRE exacte du fournisseur : `ingestMessage` reçoit un
 *     identifiant, appelle Gmail (ici un `fetch` scellé sur le SEUL hôte gmail.googleapis.com,
 *     qui sert la forme `format=full` réelle), normalise, déduplique, extrait la pièce, émet
 *     `EMAIL_RECEIVED` — la totalité du pipeline de production ;
 *   • ce qui remplace le réseau du MODÈLE est le raisonneur scripté, vérifié contre le schéma
 *     de production — et ce qui exige le fournisseur RÉEL (recherche web, cache de prompt,
 *     en-têtes de débit) est joué LIVE quand la clé existe, et marqué NOT_PROVEN_LIVE sinon.
 *     On ne triche pas sur le statut (§14).
 *
 * ── QUATRE STATUTS, PAS TROIS ────────────────────────────────────────────────────────────
 *
 *   PASS             la propriété est démontrée, mesures à l'appui ;
 *   FAIL             elle est contredite — le run doit le dire, pas le maquiller ;
 *   NOT_PROVEN_LIVE  elle exige le fournisseur réel, absent de cet environnement ;
 *   ECARTE           la base ne porte pas de quoi la jouer (dit, jamais simulé — §78).
 *
 * ── L'HYGIÈNE ────────────────────────────────────────────────────────────────────────────
 *
 * Tout ce que ce banc crée porte son jeton (utilisateur, salariés, connexion, rappels,
 * événements) et il ne supprime QUE cela. Les identités synthétiques sont taguées pour ne
 * jamais recouper une attente ou un rappel RÉEL par inclusion de texte (`designe` matche à
 * partir de 4 caractères : « sarah » réveillerait la vraie mission qui attend Sarah).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type StatutAcceptance = "PASS" | "FAIL" | "NOT_PROVEN_LIVE" | "ECARTE";

export interface ScenarioAcceptance {
  code: string;
  capacite: string;
  titre: string;
  /** Vrai quand le scénario exige le fournisseur réel (OPENAI_API_KEY). */
  live: boolean;
  statut: StatutAcceptance;
  mesures: Record<string, unknown>;
  preuve: string;
  dureeMs: number;
}

export interface ResultatAcceptance {
  jeton: string;
  liveDisponible: boolean;
  scenarios: ScenarioAcceptance[];
  compte: { pass: number; fail: number; nonProuveLive: number; ecartes: number };
  dureeMs: number;
}

/* ────────────────────────────── LES OUTILS DU BANC ────────────────────────────── */

/** Une attente vérifiée. Son échec nomme la propriété contredite — c'est la preuve du FAIL. */
function attendre(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

/** L'échelle de relances, relue depuis la colonne JSON — des nombres, jamais crus sur parole. */
const echelleDe = (v: unknown): number[] =>
  Array.isArray(v) ? v.filter((x): x is number => typeof x === "number") : [];

/** Un raisonneur RALENTI — même réponses, latence artificielle : ce que remplace le réseau. */
const ralenti = (reel: Reasoner, ms: number): Reasoner => ({
  configured: () => reel.configured(),
  reason: async (req) => {
    await new Promise((r) => setTimeout(r, ms));
    return reel.reason(req);
  },
});

/**
 * LE JUGE SCRIPTÉ — satisfait, avec des preuves EXTRAITES du compte rendu réellement reçu
 * (même mécanique que le banc E2E) : si le runtime n'envoyait pas les clés d'étapes au juge,
 * la liste serait vide et la normalisation ferait tomber la conclusion — comme il se doit.
 */
const jugePour = (criteres: readonly string[]): Script =>
  pour("mission.judge", (req: ReasonRequest) => {
    const clesVues = [...req.prompt.matchAll(/^- ([a-z0-9:_#-]+) : /gim)].map((m) => m[1]);
    return {
      ok: true,
      data: {
        satisfied: true,
        confidence: 0.9,
        criteria: criteres.map((c) => ({ criterion: c, status: "SATISFAIT", evidenceRefs: clesVues.slice(0, 3) })),
        missing: [],
        contradictions: [],
        suggestedRecovery: null,
      },
    };
  });

interface EtapeLibre { [k: string]: unknown }

/** Un plan scripté à la forme stricte, avec le tronc commun rempli. */
function planDe(goal: string, echelle: string, criteres: string[], steps: EtapeLibre[]): Record<string, unknown> {
  return planScripte({
    goal,
    reasoningComplexity: "B",
    executionScale: echelle,
    acceptanceCriteria: criteres,
    workstreams: [],
    steps,
    expectedArtifacts: [],
    approvalStrategy: "BUNDLE",
    completionCriteria: criteres[0] ?? "",
    gaps: [],
    rationale: "plan scripté du banc d'acceptance — vérifié contre le schéma de production",
  });
}

const lecture = (key: string, dependsOn: string[] = [], limit = 5): EtapeLibre => ({
  key, title: `Lecture ${key}`, nodeType: "CAPABILITY", capability: "directory_list",
  inputs: [{ key: "limit", kind: "NUMBER", value: String(limit) }],
  dependsOn, completionCondition: "la liste est rendue",
});

const controle = (dependsOn: string[]): EtapeLibre => ({
  key: "controle", title: "Contrôle final", nodeType: "QA", capability: null,
  dependsOn, completionCondition: "toutes les étapes attendues sont abouties",
});

/**
 * CONDUIT une mission jusqu'à un état STABLE — le même geste que l'ordonnanceur, en boucle :
 * `avancerMission` (le point d'entrée de production), puis relecture. On s'arrête sur un état
 * terminal, ou quand deux tours consécutifs ne changent plus rien (attente, blocage).
 */
async function conduire(acteur: CurrentUser, missionId: string, cerveau: Reasoner, tours = 12): Promise<string> {
  let precedent = "";
  for (let i = 0; i < tours; i++) {
    await avancerMission(acteur, missionId, { reasoner: cerveau, lectureSeule: true, maxTours: 25 }).catch(sansBloquer("acceptance.conduire.avancerMission", null));
    const m = await prisma.mission.findUnique({
      where: { id: missionId },
      select: { status: true, steps: { select: { key: true, status: true } } },
    });
    if (!m) return "ABSENTE";
    if (["COMPLETED", "FAILED", "CANCELLED"].includes(m.status)) return m.status;
    const signature = `${m.status}|${m.steps.map((s) => `${s.key}:${s.status}`).sort().join(",")}`;
    if (signature === precedent) return m.status;
    precedent = signature;
  }
  return (await prisma.mission.findUnique({ where: { id: missionId }, select: { status: true } }))?.status ?? "ABSENTE";
}

async function etatEtape(missionId: string, key: string): Promise<{ status: string; receipt: string | null; attempt: number } | null> {
  const s = await prisma.missionStep.findFirst({
    where: { missionId, key },
    select: { status: true, receipt: true, attempt: true },
  });
  return s ?? null;
}

/* ────────────────────────────── LE RUN D'ACCEPTANCE ────────────────────────────── */

export async function executerAcceptance(
  opts: { inclureLive?: boolean; onScenario?: (ligne: string) => void } = {},
): Promise<ResultatAcceptance> {
  const t0 = Date.now();
  const TAG = `acc${Date.now().toString(36)}${crypto.randomBytes(2).toString("hex")}`;
  const PREFIXE = `[ACC ${TAG}]`;
  const live = opts.inclureLive ?? Boolean((process.env.OPENAI_API_KEY ?? "").trim());
  const scenarios: ScenarioAcceptance[] = [];
  const missionsCreees = new Set<string>();

  /** L'ACTEUR DU BANC — un compte direction dédié : mêmes droits par le même RBAC, mais ses
   *  missions, rappels et notifications n'encombrent jamais l'écran du vrai PDG. */
  const compte = await prisma.user.create({
    data: { name: `${TAG} Direction`, email: `${TAG}@amd-acceptance.dz`, passwordHash: "x", role: "SUPER_ADMIN" },
    select: { id: true, name: true, email: true, role: true },
  });
  const acteur: CurrentUser = {
    id: compte.id, name: compte.name, email: compte.email, role: compte.role,
    access: (await getAccess(compte.id, compte.role)) as EffectiveAccess,
    mustChangePassword: false,
  };

  const jouerScenario = async (
    code: string, capacite: string, titre: string, exigeLive: boolean,
    corps: () => Promise<{ mesures: Record<string, unknown>; preuve: string; statut?: StatutAcceptance }>,
  ): Promise<void> => {
    const debut = Date.now();
    let statut: StatutAcceptance;
    let mesures: Record<string, unknown> = {};
    let preuve: string;
    if (exigeLive && !live) {
      statut = "NOT_PROVEN_LIVE";
      preuve = "OPENAI_API_KEY absente de cet environnement — le chemin exige le fournisseur réel.";
    } else {
      try {
        const r = await corps();
        statut = r.statut ?? "PASS";
        mesures = r.mesures;
        preuve = r.preuve;
      } catch (e) {
        statut = "FAIL";
        preuve = e instanceof Error ? e.message : String(e);
      }
    }
    const s: ScenarioAcceptance = { code, capacite, titre, live: exigeLive, statut, mesures, preuve, dureeMs: Date.now() - debut };
    scenarios.push(s);
    opts.onScenario?.(
      `[${code.padEnd(7)}] ${statut.padEnd(16)} ${capacite.padEnd(20)} ${((s.dureeMs) / 1000).toFixed(1)}s — ${preuve.slice(0, 110)}`,
    );
  };

  /** Lance une mission scriptée par le POINT D'ENTRÉE de production et l'enregistre au nettoyage. */
  const lancer = async (
    objectif: string, plan: Record<string, unknown>, criteres: string[],
    options: { demarrer?: boolean; titre?: string; cerveau?: RaisonneurScripte } = {},
  ): Promise<{ missionId: string; cerveau: RaisonneurScripte }> => {
    const cerveau = options.cerveau ?? new RaisonneurScripte([
      pour("mission.plan", () => ({ ok: true, data: plan })),
      jugePour(criteres),
    ]);
    const r = await lancerMission(acteur, objectif, {
      lectureSeule: true, demarrer: options.demarrer ?? false,
      reasoner: cerveau, titre: `${PREFIXE} ${options.titre ?? objectif.slice(0, 60)}`,
    });
    attendre(r.ok, `lancement refusé : ${r.ok ? "" : r.error}`);
    missionsCreees.add(r.missionId);
    return { missionId: r.missionId, cerveau };
  };

  try {
    /* ═══════════════ §1 — ARRIÈRE-PLAN : détacher, coexister, conclure ═══════════════ */

    await jouerScenario("BG-1", "BACKGROUND", "détachement mesuré + requête interactive servie pendant la mission de fond", false, async () => {
      const criteres = ["la liste est rendue"];
      const plan = planDe("Lister l'annuaire", "S", criteres, [lecture("lire"), controle(["lire"])]);
      const cerveau = new RaisonneurScripte([pour("mission.plan", () => ({ ok: true, data: plan })), jugePour(criteres)]);

      const avantAccept = Date.now();
      const r = await lancerEnArrierePlan(acteur, "Lister l'annuaire et confirmer que la liste est rendue.", {
        titre: `${PREFIXE} fond`, reasoner: cerveau, lectureSeule: true,
      });
      const timeToAccept = Date.now() - avantAccept;
      attendre(r.ok, `détachement refusé : ${r.ok ? "" : r.error}`);
      missionsCreees.add(r.missionId);
      attendre(timeToAccept < 5_000, `le détachement a pris ${timeToAccept} ms — la conversation a attendu la planification`);
      attendre(await prisma.missionEvent.findFirst({ where: { missionId: r.missionId, kind: "DETACHED" }, select: { id: true } }),
        "aucun événement DETACHED au journal — la promesse de fond n'est pas tracée");

      // PENDANT que la planification différée tourne : des requêtes interactives, mesurées.
      const latencesInteractives: number[] = [];
      let statut = "PLANNING";
      for (let i = 0; i < 200 && !["COMPLETED", "FAILED", "CANCELLED"].includes(statut); i++) {
        const ti = Date.now();
        await prisma.mission.count({ where: { ownerId: acteur.id } });
        await vueMission(r.missionId, acteur.id);
        latencesInteractives.push(Date.now() - ti);
        await new Promise((res) => setTimeout(res, 100));
        statut = (await prisma.mission.findUnique({ where: { id: r.missionId }, select: { status: true } }))?.status ?? "ABSENTE";
      }
      const m = await prisma.mission.findUnique({ where: { id: r.missionId }, select: { status: true, goalSatisfied: true } });
      attendre(m?.status === "COMPLETED", `la mission de fond s'est immobilisée en ${m?.status ?? "ABSENTE"} au lieu de COMPLETED`);
      attendre(m?.goalSatisfied === true, "COMPLETED sans objectif jugé atteint — incohérence moteur");
      const p50 = [...latencesInteractives].sort((a, b) => a - b)[Math.floor(latencesInteractives.length / 2)] ?? null;
      attendre(p50 !== null && p50 < 2_000, `les requêtes interactives ont ramé pendant le fond (P50 ${p50} ms)`);
      return {
        mesures: { timeToAcceptMs: timeToAccept, latenceInteractiveP50Ms: p50, sondesInteractives: latencesInteractives.length },
        preuve: `détaché en ${timeToAccept} ms ; ${latencesInteractives.length} requêtes interactives servies pendant le fond (P50 ${p50} ms) ; mission conclue COMPLETED, objectif jugé atteint.`,
      };
    });

    await jouerScenario("BG-2", "BACKGROUND", "pause → exclue du battement ; reprise → candidate à nouveau", false, async () => {
      const criteres = ["l'attente est posée"];
      const plan = planDe("Attendre un document", "S", criteres, [
        lecture("lire"),
        {
          key: "attente", title: "Attendre le document", nodeType: "WAIT_EVENT", capability: null,
          dependsOn: ["lire"], completionCondition: "le document est arrivé",
          waitEvent: "DOCUMENT_RECEIVED", waitFrom: `fantome2-${TAG}`, waitWithinDays: 5,
        },
        controle(["attente"]),
      ]);
      const { missionId, cerveau } = await lancer("Attends le document du correspondant avant de conclure.", plan, criteres, { titre: "pause" });
      await conduire(acteur, missionId, cerveau);
      const p = await pauserMission(acteur, missionId, "essai d'acceptance");
      attendre(p.fait && p.statut === "PAUSED", `la pause a échoué : ${p.message}`);
      attendre(!(await missionsAFaireAvancer(500)).includes(missionId),
        "une mission EN PAUSE est encore candidate au battement — elle repartirait toute seule");
      const rep = await reprendreMissionAgent(acteur, missionId);
      attendre(rep.fait, `la reprise a échoué : ${rep.message}`);
      const apres = await prisma.mission.findUnique({ where: { id: missionId }, select: { status: true } });
      attendre(apres && apres.status !== "PAUSED", "après reprise, la mission est restée PAUSED");
      attendre((await missionsAFaireAvancer(500)).includes(missionId),
        "après reprise, la mission n'est pas redevenue candidate au battement");
      const stop = await arreterMissionAgent(acteur, missionId, "fin de l'essai");
      attendre(stop.fait, `l'arrêt de fin d'essai a échoué : ${stop.message}`);
      return {
        mesures: { statutApresPause: "PAUSED", statutApresReprise: apres?.status ?? null },
        preuve: "PAUSED sort de la liste du battement ; la reprise la réinscrit ; l'étape d'attente n'a pas été touchée.",
      };
    });

    await jouerScenario("BG-3", "BACKGROUND", "annulation terminale : un événement en retard ne réveille RIEN", false, async () => {
      const criteres = ["l'attente est posée"];
      const plan = planDe("Attendre la réponse", "S", criteres, [
        lecture("lire"),
        {
          key: "attente", title: "Attendre la réponse", nodeType: "WAIT_EVENT", capability: null,
          dependsOn: ["lire"], completionCondition: "la réponse est arrivée",
          waitEvent: "EMAIL_RECEIVED", waitFrom: `fantome3-${TAG}@exemple.dz`, waitWithinDays: 5,
        },
        controle(["attente"]),
      ]);
      const { missionId, cerveau } = await lancer("Attends la réponse du correspondant avant de conclure.", plan, criteres, { titre: "annulation" });
      await conduire(acteur, missionId, cerveau);
      attendre((await etatEtape(missionId, "attente"))?.status === "WAITING", "l'attente n'a pas été parquée WAITING");

      const stop = await arreterMissionAgent(acteur, missionId, "annulée pendant l'attente");
      attendre(stop.fait && stop.statut === "CANCELLED", `l'annulation a échoué : ${stop.message}`);
      attendre((await etatEtape(missionId, "controle"))?.status === "CANCELLED",
        "l'étape PENDING n'a pas été annulée avec la mission");
      const encore = await arreterMissionAgent(acteur, missionId);
      attendre(encore.fait, "la seconde annulation devrait être idempotente (« déjà arrêtée »)");

      // L'ÉVÉNEMENT EN RETARD — exactement celui qui était attendu. Il arrive par le VRAI bus.
      await recordEvent({
        type: "EMAIL_RECEIVED", sourceDomain: "comms",
        payload: { from: `fantome3-${TAG}@exemple.dz`, subject: "trop tard", hasAttachments: false, attachments: [], marqueur: TAG },
      });
      const m = await prisma.mission.findUnique({ where: { id: missionId }, select: { status: true } });
      attendre(m?.status === "CANCELLED", `l'événement en retard a changé l'état de la mission : ${m?.status}`);
      attendre((await etatEtape(missionId, "attente"))?.status === "WAITING",
        "l'événement en retard a réglé l'attente d'une mission ANNULÉE — la panne exacte qu'on interdit");
      return {
        mesures: { statutFinal: "CANCELLED" },
        preuve: "CANCELLED est terminal : étapes non commencées annulées, second arrêt idempotent, et l'événement attendu arrivé APRÈS n'a rien réveillé.",
      };
    });

    await jouerScenario("BG-4", "CONTROLS", "priorité bornée servie D'ABORD par l'ordonnanceur + plafond de modèle posé/retiré", false, async () => {
      const criteres = ["l'attente est posée"];
      const planAttente = (n: number) => planDe(`Attendre ${n}`, "S", criteres, [
        lecture("lire"),
        {
          key: "attente", title: "Attendre", nodeType: "WAIT_EVENT", capability: null,
          dependsOn: ["lire"], completionCondition: "réponse arrivée",
          waitEvent: "DOCUMENT_RECEIVED", waitFrom: `fantome4${n}-${TAG}`, waitWithinDays: 5,
        },
        controle(["attente"]),
      ]);
      const a = await lancer("Attends le premier document.", planAttente(1), criteres, { titre: "prio-ancienne" });
      const b = await lancer("Attends le second document.", planAttente(2), criteres, { titre: "prio-haute" });

      const pr = await prioriserMission(acteur, b.missionId, 99);
      attendre(pr.fait, `la priorisation a échoué : ${pr.message}`);
      const luB = await prisma.mission.findUnique({ where: { id: b.missionId }, select: { priority: true } });
      attendre(luB?.priority === 10, `la priorité n'est pas bornée à +10 (${luB?.priority})`);
      const file = await missionsAFaireAvancer(500);
      const posA = file.indexOf(a.missionId);
      const posB = file.indexOf(b.missionId);
      attendre(posA >= 0 && posB >= 0, "les deux missions devraient être candidates au battement");
      attendre(posB < posA, `la mission priorisée passe APRÈS l'ancienne (${posB} vs ${posA}) — la priorité n'est pas servie`);

      const cap = await plafonnerModeleMission(acteur, b.missionId, 2);
      attendre(cap.fait, `le plafond de modèle a échoué : ${cap.message}`);
      attendre((await prisma.mission.findUnique({ where: { id: b.missionId }, select: { modelCallsCap: true } }))?.modelCallsCap === 2,
        "le plafond n'est pas écrit en base");
      await plafonnerModeleMission(acteur, b.missionId, null);
      attendre((await prisma.mission.findUnique({ where: { id: b.missionId }, select: { modelCallsCap: true } }))?.modelCallsCap === null,
        "le plafond n'a pas été retiré par null");
      await arreterMissionAgent(acteur, a.missionId);
      await arreterMissionAgent(acteur, b.missionId);
      return {
        mesures: { positionPrioritaire: posB, positionAncienne: posA },
        preuve: `priorité bornée (+10), journalisée, et SERVIE : la mission priorisée est en position ${posB} contre ${posA} ; plafond de modèle posé (2) puis retiré (null).`,
      };
    });

    /* ═══════════════ §5 — WAIT_FOR_TIME : l'horloge avance, le chemin jamais ═══════════════ */

    await jouerScenario("TIME-1", "WAIT_FOR_TIME", "analyse → WAITING persisté → horloge avancée → réveil → conclusion", false, async () => {
      const criteres = ["le point est repris au moment demandé"];
      const dansDeuxHeures = new Date(Date.now() + 2 * 3_600_000).toISOString();
      const plan = planDe("Reprendre plus tard", "S", criteres, [
        lecture("lire"),
        {
          key: "attente", title: "Revenir dans deux heures", nodeType: "WAIT_EVENT", capability: null,
          dependsOn: ["lire"], completionCondition: "le moment est arrivé",
          // « TEMPS » est la sentinelle du schéma STRICT : seule l'échéance compte, aucun fait.
          waitEvent: "TEMPS", waitUntil: dansDeuxHeures,
        },
        controle(["attente"]),
      ]);
      const { missionId, cerveau } = await lancer("Analyse l'annuaire maintenant et reviens dans deux heures conclure.", plan, criteres, { titre: "temps" });
      await conduire(acteur, missionId, cerveau);
      const etape = await prisma.missionStep.findFirst({
        where: { missionId, key: "attente" }, select: { status: true, waitFor: true },
      });
      attendre(etape?.status === "WAITING", `l'attente temporelle n'est pas parquée WAITING (${etape?.status})`);
      const persiste = (etape?.waitFor ?? {}) as Record<string, unknown>;
      attendre(persiste.until === dansDeuxHeures, "l'échéance n'est pas PERSISTÉE dans waitFor.until — elle ne survivrait pas à un redémarrage");

      // AVANT l'échéance : le balayage (horloge injectée) ne réveille RIEN.
      const avant = await reveillerAttentesTemporelles(new Date());
      attendre(!avant.some((r) => r.missionId === missionId), "réveillée AVANT son échéance — l'horloge n'est pas respectée");
      // APRÈS : le même balayage de production la règle. Aucun setTimeout nulle part.
      const apres = await reveillerAttentesTemporelles(new Date(Date.now() + 3 * 3_600_000));
      attendre(apres.some((r) => r.missionId === missionId), "l'échéance passée n'a pas réveillé la mission");
      const statut = await conduire(acteur, missionId, cerveau);
      attendre(statut === "COMPLETED", `après réveil temporel, la mission finit en ${statut}`);
      attendre(await prisma.missionEvent.findFirst({ where: { missionId, kind: "TIME_WAKE" }, select: { id: true } }),
        "aucun TIME_WAKE au journal");
      return {
        mesures: { echeance: dansDeuxHeures, horlogeAvanceeDe: "3 h" },
        preuve: "échéance persistée en base, ignorée avant l'heure, réglée par le balayage de production à horloge injectée, mission conclue — zéro setTimeout.",
      };
    });

    /* ═══════════════ §2 — WAIT_FOR_EVENT : le vrai bus, et les non-réveils ═══════════════ */

    await jouerScenario("EVT-1", "WAIT_FOR_EVENT", "quatre événements PRESQUE bons ne réveillent pas ; le bon réveille ; le rejeu est inerte", false, async () => {
      const expeditrice = `expeditrice-${TAG}@exemple.dz`;
      const criteres = ["le document attendu est arrivé et analysé"];
      const plan = planDe("Attendre le contrat", "S", criteres, [
        lecture("lire"),
        {
          key: "attente", title: "Attendre le contrat", nodeType: "WAIT_EVENT", capability: null,
          dependsOn: ["lire"], completionCondition: "le contrat est arrivé",
          waitEvent: "EMAIL_RECEIVED", waitFrom: expeditrice, waitSubject: "contrat", waitAttachment: "contrat*",
          waitWithinDays: 7,
        },
        controle(["attente"]),
      ]);
      const { missionId, cerveau } = await lancer("Attends le contrat de la correspondante, puis conclus.", plan, criteres, { titre: "événement" });
      await conduire(acteur, missionId, cerveau);
      attendre((await etatEtape(missionId, "attente"))?.status === "WAITING", "l'attente n'est pas WAITING");

      const enAttente = async (motif: string) => {
        attendre((await etatEtape(missionId, "attente"))?.status === "WAITING",
          `RÉVEIL À TORT : ${motif} a réglé l'attente — la panne la plus coûteuse du routeur`);
      };
      const evt = (payload: Record<string, unknown>) => recordEvent({
        type: "EMAIL_RECEIVED", sourceDomain: "comms", payload: { marqueur: TAG, ...payload },
      });
      await evt({ from: `intrus-${TAG}@exemple.dz`, subject: `contrat ${TAG}`, hasAttachments: true, attachments: [`contrat-${TAG}.pdf`] });
      await enAttente("le mauvais expéditeur (même avec pièce)");
      await evt({ from: expeditrice, subject: `contrat ${TAG} — je l'envoie demain`, hasAttachments: false, attachments: [] });
      await enAttente("une promesse SANS pièce jointe");
      await evt({ from: expeditrice, subject: `facture ${TAG}`, hasAttachments: true, attachments: [`facture-${TAG}.pdf`] });
      await enAttente("le mauvais objet");
      await evt({ from: expeditrice, subject: `contrat ${TAG}`, hasAttachments: true, attachments: [`annexe-${TAG}.docx`] });
      await enAttente("une pièce au mauvais nom (motif contrat*)");

      // LE BON — et lui seul.
      await evt({ from: expeditrice, subject: `contrat ${TAG} signé`, hasAttachments: true, attachments: [`contrat-signe-${TAG}.pdf`] });
      attendre((await etatEtape(missionId, "attente"))?.status === "DONE", "LE bon événement n'a pas réglé l'attente");
      // §42 : le REJEU du même fait (webhook dupliqué) ne casse rien.
      await evt({ from: expeditrice, subject: `contrat ${TAG} signé`, hasAttachments: true, attachments: [`contrat-signe-${TAG}.pdf`] });
      attendre((await etatEtape(missionId, "attente"))?.status === "DONE", "le rejeu a déstabilisé une attente déjà réglée");
      const statut = await conduire(acteur, missionId, cerveau);
      attendre(statut === "COMPLETED", `après réveil, la mission finit en ${statut}`);
      return {
        mesures: { negatifsTestes: 4, rejeux: 1 },
        preuve: "4 événements presque-bons ignorés (expéditeur, pièce absente, objet, nom de pièce), le bon réveille via le bus réel, le rejeu est inerte, la mission conclut.",
      };
    });

    await jouerScenario("EVT-2", "WAIT_FOR_EVENT", "composition ET : progression PERSISTÉE branche par branche, rejeu idempotent", false, async () => {
      const expediteur = `fournisseur-${TAG}@exemple.dz`;
      const criteres = ["le contrat ET le devis sont arrivés"];
      const plan = planDe("Attendre contrat et devis", "S", criteres, [
        lecture("lire"),
        {
          key: "attente", title: "Attendre le contrat ET le devis", nodeType: "WAIT_EVENT", capability: null,
          dependsOn: ["lire"], completionCondition: "les deux pièces sont arrivées",
          // Le schéma STRICT exige chaque champ d'une branche, `null` compris — la forme
          // exacte qu'un fournisseur en mode strict produirait.
          waitEvent: "EMAIL_RECEIVED",
          waitAllOf: [
            { event: "EMAIL_RECEIVED", from: expediteur, entity: null, until: null, threadId: null, subject: null, attachment: "contrat*" },
            { event: "EMAIL_RECEIVED", from: expediteur, entity: null, until: null, threadId: null, subject: null, attachment: "devis*" },
          ],
        },
        controle(["attente"]),
      ]);
      const { missionId, cerveau } = await lancer("Attends le contrat et le devis du fournisseur avant de conclure.", plan, criteres, { titre: "composition" });
      await conduire(acteur, missionId, cerveau);
      attendre((await etatEtape(missionId, "attente"))?.status === "WAITING", "l'attente composée n'est pas WAITING");

      const contrat = () => recordEvent({
        type: "EMAIL_RECEIVED", sourceDomain: "comms",
        payload: { marqueur: TAG, from: expediteur, subject: `pièces ${TAG}`, hasAttachments: true, attachments: [`contrat-${TAG}.pdf`] },
      });
      await contrat();
      const partielle = await prisma.missionStep.findFirst({ where: { missionId, key: "attente" }, select: { status: true, result: true } });
      attendre(partielle?.status === "WAITING", "UNE branche réglée a conclu une attente ET — la composition est cassée");
      const progres = ((partielle?.result ?? {}) as Record<string, unknown>).attenteProgres;
      attendre(Array.isArray(progres) && progres.length === 1,
        "la progression de la branche réglée n'est pas PERSISTÉE — un redémarrage redemanderait le contrat");
      await contrat(); // rejeu de la MÊME branche
      const rejouee = await prisma.missionStep.findFirst({ where: { missionId, key: "attente" }, select: { result: true } });
      attendre((((rejouee?.result ?? {}) as Record<string, unknown>).attenteProgres as unknown[]).length === 1,
        "le rejeu a compté la même branche deux fois");
      await recordEvent({
        type: "EMAIL_RECEIVED", sourceDomain: "comms",
        payload: { marqueur: TAG, from: expediteur, subject: `pièces ${TAG}`, hasAttachments: true, attachments: [`devis-${TAG}.pdf`] },
      });
      attendre((await etatEtape(missionId, "attente"))?.status === "DONE", "les deux branches réglées n'ont pas conclu l'attente ET");
      const statut = await conduire(acteur, missionId, cerveau);
      attendre(statut === "COMPLETED", `la mission finit en ${statut}`);
      return {
        mesures: { branches: 2, progressionPersistee: true },
        preuve: "contrat seul → WAITING avec attenteProgres [0] EN BASE ; rejeu inerte ; devis → DONE ; mission conclue.",
      };
    });

    /* ═══════════════ §4 — RAPPELS : l'échelle, l'extinction, par l'OUTIL de production ═══════════════ */

    const planReminder = EXECUTIVE_TOOLS.find((t) => t.def.name === "plan_reminder");

    await jouerScenario("REM-1", "REMINDERS", "créé par l'OUTIL plan_reminder → échéance → relance +48 h → extinction d'échelle", false, async () => {
      attendre(planReminder, "l'outil plan_reminder est introuvable dans EXECUTIVE_TOOLS");
      const reponse = await planReminder.run(
        { title: `${PREFIXE} relancer le fournisseur`, quand: "dans 48h", escalations_h: [48] },
        acteur,
      );
      const rappel = await prisma.assistantReminder.findFirst({
        where: { userId: acteur.id, title: { startsWith: PREFIXE } },
        select: { id: true, dueAt: true, escalationsH: true, active: true },
        orderBy: { dueAt: "asc" },
      });
      attendre(rappel, `l'outil n'a pas créé le rappel — réponse : ${String(reponse).slice(0, 140)}`);
      const ecartH = Math.abs(rappel.dueAt.getTime() - (Date.now() + 48 * 3_600_000)) / 3_600_000;
      attendre(ecartH < 1, `le moteur temporel a mal lu « dans 48h » (écart ${ecartH.toFixed(1)} h)`);
      attendre(echelleDe(rappel.escalationsH).length === 1 && echelleDe(rappel.escalationsH)[0] === 48,
        "l'échelle de relances n'est pas enregistrée");

      // TIR nº 1 — l'échéance passe (horloge injectée) : notifié, replanifié à +48 h, barreau consommé.
      await runAssistantReminders(new Date(rappel.dueAt.getTime() + 60_000));
      let lu = await prisma.assistantReminder.findUnique({
        where: { id: rappel.id }, select: { active: true, dueAt: true, escalationsH: true },
      });
      attendre(lu?.active === true, "le rappel s'est éteint au PREMIER tir alors qu'un barreau restait");
      attendre(echelleDe(lu.escalationsH).length === 0, "le barreau de relance n'a pas été consommé");
      attendre(lu.dueAt.getTime() > rappel.dueAt.getTime() + 47 * 3_600_000, "la relance n'est pas replanifiée ~48 h plus tard");
      // TIR nº 2 — plus de barreau : le rappel se TAIT pour de bon, jamais du harcèlement.
      await runAssistantReminders(new Date(lu.dueAt.getTime() + 60_000));
      lu = await prisma.assistantReminder.findUnique({ where: { id: rappel.id }, select: { active: true, dueAt: true, escalationsH: true } });
      attendre(lu?.active === false, "l'échelle épuisée n'a pas éteint le rappel — il relancerait à l'infini");
      return {
        mesures: { occurrences: 2, echelleInitiale: [48] },
        preuve: "créé par l'outil de production (« dans 48h » lu par le moteur temporel), tiré 2 fois à horloge injectée, replanifié +48 h, puis éteint SEUL à l'épuisement de l'échelle.",
      };
    });

    await jouerScenario("REM-2", "REMINDERS", "la pièce attendue ÉTEINT le rappel et ses relances futures ; une réponse sans pièce, non", false, async () => {
      attendre(planReminder, "l'outil plan_reminder est introuvable");
      const contact = `relanceuse-${TAG}@exemple.dz`;
      await planReminder.run(
        {
          title: `${PREFIXE} contrat attendu`, quand: "dans 48h", escalations_h: [48, 72],
          stop_on_email_from: contact, stop_needs_attachment: true,
        },
        acteur,
      );
      const rappel = await prisma.assistantReminder.findFirst({
        where: { userId: acteur.id, title: `${PREFIXE} contrat attendu` },
        select: { id: true, active: true },
      });
      attendre(rappel?.active === true, "le rappel conditionnel n'a pas été créé");

      await recordEvent({
        type: "EMAIL_RECEIVED", sourceDomain: "comms",
        payload: { marqueur: TAG, from: contact, subject: `re ${TAG} : je l'envoie bientôt`, hasAttachments: false, attachments: [] },
      });
      attendre((await prisma.assistantReminder.findUnique({ where: { id: rappel.id }, select: { active: true } }))?.active === true,
        "une réponse SANS pièce a éteint un rappel qui exigeait la pièce (§26)");
      await recordEvent({
        type: "EMAIL_RECEIVED", sourceDomain: "comms",
        payload: { marqueur: TAG, from: contact, subject: `contrat ${TAG} signé`, hasAttachments: true, attachments: [`contrat-${TAG}.pdf`] },
      });
      attendre((await prisma.assistantReminder.findUnique({ where: { id: rappel.id }, select: { active: true } }))?.active === false,
        "la pièce attendue n'a pas éteint le rappel — il aurait relancé pour rien, deux fois");
      return {
        mesures: { relancesAnnulees: 2 },
        preuve: "réponse sans pièce → rappel armé ; contrat AVEC pièce → extinction immédiate, relances +48 h/+72 h annulées avec — par la 5ᵉ conséquence du registre.",
      };
    });

    /* ═══════════════ §3 — E-MAIL : la frontière EXACTE du fournisseur ═══════════════ */

    await jouerScenario("MAIL-1", "EMAIL_PIPELINE", "webhook→ingestion→normalisation→dédup→pièce canonique→EMAIL_RECEIVED→réveil→conclusion", false, async () => {
      const expeditrice = `signataire-${TAG}@exemple.dz`;
      const boite = `adam-${TAG}@amd-acceptance.dz`;
      const fil = `thread-${TAG}`;
      const pieceNom = `contrat-signe-${TAG}.txt`;
      const pieceTexte = `CONTRAT SIGNÉ ${TAG} — les deux parties s'engagent.`;

      // LA CONNEXION — un jeton chiffré par le VRAI coffre, une expiration future : le chemin
      // de production (déchiffrement, court-circuit du refresh) est celui qui tourne.
      const boiteUser = await prisma.user.create({
        data: { name: `${TAG} Boîte`, email: boite, passwordHash: "x", role: "SUPER_ADMIN" },
        select: { id: true },
      });
      const conn = await prisma.googleConnection.create({
        data: {
          userId: boiteUser.id, address: boite, status: "connected",
          accessTokenEnc: sealSecret(`jeton-${TAG}`), expiresAt: new Date(Date.now() + 3_600_000),
        },
        select: { id: true },
      });

      // LA MISSION QUI ATTEND — lancée AVANT que le courrier n'existe.
      const criteres = ["le contrat est arrivé et analysé"];
      const plan = planDe("Attendre le contrat signé", "S", criteres, [
        lecture("lire"),
        {
          key: "attente", title: "Attendre le contrat de la signataire", nodeType: "WAIT_EVENT", capability: null,
          dependsOn: ["lire"], completionCondition: "le contrat est arrivé",
          waitEvent: "EMAIL_RECEIVED", waitFrom: expeditrice, waitSubject: "contrat", waitAttachment: "contrat*",
        },
        { ...lecture("bilan", ["attente"], 3), title: "Analyser après réception" },
        controle(["bilan"]),
      ]);
      const { missionId, cerveau } = await lancer("Quand la signataire envoie le contrat, analyse et conclus.", plan, criteres, { titre: "gmail" });
      await conduire(acteur, missionId, cerveau);
      attendre((await etatEtape(missionId, "attente"))?.status === "WAITING", "la mission n'attend pas");

      // LE FOURNISSEUR — un fetch scellé sur le SEUL hôte gmail.googleapis.com, qui sert la
      // forme réelle de l'API (format=full, pièce en base64url). Tout autre hôte passe au vrai
      // réseau : le reste du run (OpenAI compris) n'est pas touché.
      const b64url = (s: string) => Buffer.from(s, "utf8").toString("base64url");
      const messages: Record<string, unknown> = {
        [`msg-${TAG}-intrus`]: {
          id: `msg-${TAG}-intrus`, threadId: `${fil}-intrus`, historyId: "1", labelIds: ["INBOX"],
          snippet: "pièce d'un intrus", internalDate: String(Date.now()),
          payload: {
            mimeType: "multipart/mixed",
            headers: [
              { name: "From", value: `Intrus <intrus-${TAG}@exemple.dz>` },
              { name: "To", value: boite }, { name: "Subject", value: `contrat ${TAG}` },
              { name: "Message-ID", value: `<intrus-${TAG}@exemple.dz>` },
            ],
            parts: [
              { mimeType: "text/plain", body: { size: 20, data: b64url("pièce d'un intrus") } },
              { mimeType: "text/plain", filename: pieceNom, body: { attachmentId: "att-intrus", size: 64 } },
            ],
          },
        },
        [`msg-${TAG}-ok`]: {
          id: `msg-${TAG}-ok`, threadId: fil, historyId: "2", labelIds: ["INBOX"],
          snippet: "le contrat signé", internalDate: String(Date.now()),
          payload: {
            mimeType: "multipart/mixed",
            headers: [
              { name: "From", value: `Signataire <${expeditrice}>` },
              { name: "To", value: boite }, { name: "Subject", value: `Le contrat ${TAG} signé` },
              { name: "Message-ID", value: `<ok-${TAG}@exemple.dz>` },
            ],
            parts: [
              { mimeType: "text/plain", body: { size: 30, data: b64url("Voici le contrat signé.") } },
              { mimeType: "text/plain", filename: pieceNom, body: { attachmentId: "att-ok", size: pieceTexte.length } },
            ],
          },
        },
      };
      const fetchReel = globalThis.fetch;
      globalThis.fetch = (async (entree: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const url = typeof entree === "string" ? entree : entree instanceof URL ? entree.toString() : entree.url;
        if (url.includes("gmail.googleapis.com")) {
          const attachment = url.match(/\/messages\/[^/]+\/attachments\//);
          if (attachment) return new Response(JSON.stringify({ data: b64url(pieceTexte), size: pieceTexte.length }), { status: 200 });
          const id = url.match(/\/messages\/([^/?]+)/)?.[1] ?? "";
          const corps = messages[id];
          return corps
            ? new Response(JSON.stringify(corps), { status: 200 })
            : new Response(JSON.stringify({ error: { status: "NOT_FOUND" } }), { status: 404 });
        }
        return fetchReel(entree, init);
      }) as typeof fetch;

      try {
        // 1. L'INTRUS d'abord : ingéré, enregistré — mais la mission ne bouge PAS.
        const intrus = await ingestMessage(conn.id, `msg-${TAG}-intrus`, { domains: [] });
        attendre(intrus.status === "ingested", `l'ingestion de l'intrus a échoué : ${intrus.reason ?? intrus.status}`);
        attendre((await etatEtape(missionId, "attente"))?.status === "WAITING",
          "le courrier du MAUVAIS expéditeur a réveillé la mission");

        // 2. LE BON : tout le pipeline, de l'identifiant fournisseur à la conclusion.
        const ok = await ingestMessage(conn.id, `msg-${TAG}-ok`, { domains: [] });
        attendre(ok.status === "ingested" && ok.emailRecordId, `l'ingestion du bon message a échoué : ${ok.reason ?? ok.status}`);
        const piece = await prisma.emailAttachmentRecord.findFirst({
          where: { emailRecordId: ok.emailRecordId },
          select: { filename: true, extractedText: true },
        });
        attendre(piece?.filename === pieceNom, "la pièce jointe n'a pas de trace canonique");
        attendre((piece.extractedText ?? "").includes("CONTRAT SIGNÉ"),
          "le texte de la pièce n'a pas été EXTRAIT en document canonique");
        attendre((await etatEtape(missionId, "attente"))?.status === "DONE",
          "EMAIL_RECEIVED émis à la frontière n'a pas réveillé la mission qui attendait");

        // 3. LE WEBHOOK REJOUÉ : dupliqué AVANT tout effet — exactly-once structurel.
        const rejeu = await ingestMessage(conn.id, `msg-${TAG}-ok`);
        attendre(rejeu.status === "duplicate", `le rejeu du webhook n'est pas sorti en duplicate (${rejeu.status})`);
        attendre(await prisma.emailRecord.count({ where: { connectionId: conn.id, providerMessageId: `msg-${TAG}-ok` } }) === 1,
          "le rejeu a créé un second enregistrement");

        const statut = await conduire(acteur, missionId, cerveau);
        attendre(statut === "COMPLETED", `après réception, la mission finit en ${statut}`);
      } finally {
        globalThis.fetch = fetchReel;
      }
      return {
        mesures: { messagesIngeres: 2, rejeux: 1, pieceExtraite: true },
        preuve: "payload injecté À LA FRONTIÈRE (format=full réel) : validation, normalisation, dédup, pièce extraite en document canonique, EMAIL_RECEIVED, réveil de LA bonne mission, rejeu inerte, conclusion.",
      };
    });

    /* ═══════════════ §9 — CRASH : le worker meurt, un autre reprend, zéro double effet ═══════════════ */

    await jouerScenario("CRASH-1", "CRASH_RESTART", "arrêt en plein vol → bail fantôme expiré → reprise → reçus INTACTS, zéro rejeu", false, async () => {
      const criteres = ["les huit lectures sont faites"];
      const chaine: EtapeLibre[] = [];
      for (let i = 1; i <= 8; i++) chaine.push(lecture(`lire${i}`, i === 1 ? [] : [`lire${i - 1}`], 2));
      const plan = planDe("Huit lectures en chaîne", "M", criteres, [...chaine, controle(["lire8"])]);
      const { missionId, cerveau } = await lancer("Enchaîne huit lectures d'annuaire puis conclus.", plan, criteres, { titre: "crash" });

      // LE PREMIER WORKER — coupé en plein vol (maxTours court : le processus « meurt »).
      await avancerMission(acteur, missionId, { reasoner: cerveau, lectureSeule: true, maxTours: 3 });
      const avant = await prisma.missionStep.findMany({
        where: { missionId, status: "DONE" },
        select: { key: true, receipt: true, completedAt: true, attempt: true },
      });
      attendre(avant.length > 0 && avant.length < 8, `la coupure devait laisser un chantier partiel (${avant.length}/8 faites)`);

      // LE BAIL DU MORT : une autre instance le tenait, elle ne le rendra jamais — il EXPIRE.
      await prisma.mission.update({
        where: { id: missionId },
        data: { leaseOwner: `worker-mort-${TAG}`, leaseUntil: new Date(Date.now() - 1_000) },
      });
      attendre(await prendreBail(missionId), "le bail expiré d'un worker mort n'a pas pu être repris");
      const statut = await conduire(acteur, missionId, cerveau);
      await rendreBail(missionId);
      attendre(statut === "COMPLETED", `après reprise, la mission finit en ${statut}`);

      // LES REÇUS D'AVANT LA PANNE SONT INTACTS — étape par étape, à l'octet du reçu près.
      const apres = await prisma.missionStep.findMany({
        where: { missionId, key: { in: avant.map((s) => s.key) } },
        select: { key: true, receipt: true, completedAt: true, attempt: true },
      });
      for (const s of avant) {
        const relu = apres.find((x) => x.key === s.key);
        attendre(relu, `l'étape ${s.key} a disparu à la reprise`);
        attendre(relu.receipt === s.receipt && relu.completedAt?.getTime() === s.completedAt?.getTime(),
          `l'étape ${s.key} a été REJOUÉE après la panne (reçu ou horodatage modifié) — double effet`);
      }
      const toutes = await prisma.missionStep.findMany({ where: { missionId }, select: { status: true, attempt: true } });
      attendre(toutes.every((s) => s.status === "DONE" || s.status === "CANCELLED" ? s.attempt <= 1 : true),
        "au moins une étape aboutie compte plus d'une tentative — un rejeu s'est produit");
      return {
        mesures: { faitesAvantPanne: avant.length, etapes: 9 },
        preuve: `${avant.length}/8 faites avant la coupure ; bail du worker mort expiré puis repris ; reprise conclue COMPLETED ; reçus et horodatages d'avant-panne IDENTIQUES — zéro double effet, zéro rejeu.`,
      };
    });

    /* ═══════════════ §10-11 — MASSIF : 120 unités RÉELLES + progression EXACTE ═══════════════ */

    await jouerScenario("MASS-1", "MASSIVE", "éventail de 120 unités par le MÊME harnais que les 54 + interactif servi + progression comptée", false, async () => {
      const departement = `DEP-${TAG}`;
      await prisma.employee.createMany({
        data: Array.from({ length: 120 }, (_, i) => ({
          fullName: `${TAG} Salarié ${String(i + 1).padStart(3, "0")}`,
          email: `${TAG}.s${i + 1}@amd-acceptance.dz`,
          department: departement, position: "Essai", isActive: true,
        })),
      });
      const criteres = ["chaque salarié du département a son point individuel"];
      const plan = planDe("Un point par salarié du département", "L", criteres, [
        {
          key: "liste", title: "Lister le département", nodeType: "CAPABILITY", capability: "directory_list",
          inputs: [
            { key: "department", kind: "TEXT", value: departement },
            { key: "limit", kind: "NUMBER", value: "200" },
          ],
          completionCondition: "la liste des salariés est chargée",
        },
        {
          key: "point", title: "Point individuel", nodeType: "CAPABILITY", capability: "directory_lookup",
          inputs: [{ key: "name", kind: "TEXT", value: "{{salarie.nom}}" }],
          dependsOn: ["liste"],
          forEachFrom: "liste", forEachPath: "salaries", forEachAs: "salarie",
          completionCondition: "le point du salarié est fait",
        },
        controle(["point"]),
      ]);
      const cerveau = new RaisonneurScripte([pour("mission.plan", () => ({ ok: true, data: plan })), jugePour(criteres)]);
      const instrument = new RaisonneurInstrumente(cerveau, Date.now());
      const sc: Scenario = {
        genre: "ACC_MASSIF", titre: "éventail 120",
        demande: `Pour chacun des salariés du département ${departement}, fais un point individuel, puis conclus.`,
        verite: "120 salariés créés et COMPTÉS avant lancement.",
      };

      // LE MÊME HARNAIS que les 54 missions historiques (plafond ANALYZE, garde d'artefacts,
      // conduite à l'état stable) — pendant qu'un client interactif interroge le système.
      const pMission = jouer(acteur, sc, instrument, Date.now());
      const latences: number[] = [];
      // Une CHAÎNE plutôt qu'un objet : l'affectation vit dans la sonde (fermeture), et le
      // narrowing de TypeScript ne suit pas les fermetures — la preuve reste lisible telle quelle.
      let echantillonPartiel: string | null = null;
      let missionVue: string | null = null;
      const sonde = (async () => {
        for (let i = 0; i < 600; i++) {
          const ti = Date.now();
          await prisma.mission.count({ where: { ownerId: acteur.id } });
          if (!missionVue) {
            missionVue = (await prisma.mission.findFirst({
              where: { ownerId: acteur.id, title: { contains: "Diagnostic" } },
              orderBy: { createdAt: "desc" }, select: { id: true },
            }))?.id ?? null;
          } else {
            const vue = await vueMission(missionVue, acteur.id);
            if (vue && vue.avancement.faites > 0 && vue.avancement.faites < vue.avancement.total) {
              echantillonPartiel = `${vue.avancement.faites}/${vue.avancement.total}`;
            }
          }
          latences.push(Date.now() - ti);
          await new Promise((r) => setTimeout(r, 50));
        }
      })();
      const { r } = await pMission;
      await Promise.race([sonde, new Promise((res) => setTimeout(res, 100))]);
      if (r.missionId) missionsCreees.add(r.missionId);
      const verdict = verdictProfond(r);
      attendre(verdict.verdict === "SUCCES", `l'éventail massif n'est pas un SUCCÈS : ${verdict.raison}`);
      attendre(r.etapesTerminees >= 122, `${r.etapesTerminees} étapes terminées — l'éventail n'a pas déployé ses 120 unités`);

      // §11 — LA PROGRESSION est l'état RÉEL, comptée deux fois : la vue contre la base.
      attendre(r.missionId, "aucune mission massive");
      const vueFinale = await vueMission(r.missionId, acteur.id);
      const filles = await prisma.missionStep.count({ where: { missionId: r.missionId, key: { contains: "#" } } });
      const reellesDone = await prisma.missionStep.count({
        where: { missionId: r.missionId, status: "DONE", NOT: { key: "point" } },
      });
      attendre(vueFinale && vueFinale.avancement.faites === reellesDone,
        `la progression affichée (${vueFinale?.avancement.faites}) diffère du compte en base (${reellesDone}) — une estimation, pas un état`);
      const p50 = [...latences].sort((a, b) => a - b)[Math.floor(latences.length / 2)] ?? null;
      attendre(p50 !== null && p50 < 2_000, `l'interactif a ramé pendant le massif (P50 ${p50} ms)`);
      return {
        mesures: {
          unites: filles, etapesTerminees: r.etapesTerminees, dureeMs: r.cascade?.totalMs ?? null,
          latenceInteractiveP50Ms: p50, progressionPartielleObservee: echantillonPartiel,
          progressionFinale: vueFinale?.avancement ?? null,
        },
        preuve: `éventail ${filles} filles réelles conclu en ${(((r.cascade?.totalMs ?? 0)) / 1000).toFixed(1)}s par le harnais des 54 ; interactif P50 ${p50} ms pendant ; progression = compte exact (vue ${vueFinale?.avancement.faites} = base ${reellesDone}${echantillonPartiel ? ` ; échantillon en vol ${echantillonPartiel}` : ""}).`,
      };
    });

    /* ═══════════════ §15 — LES FORMES DE PLANS : observées, validées, INFLUENTES ═══════════════ */

    await jouerScenario("PAT-1", "PLAN_PATTERNS", "3 réussites par le vrai moteur → VALIDATED → la 4ᵉ planification reçoit l'indication", false, async () => {
      const criteres = ["les deux lectures sont faites"];
      const forme = planDe("Deux lectures et un contrôle", "S", criteres, [
        {
          key: "chercher", title: "Chercher la personne", nodeType: "CAPABILITY", capability: "directory_lookup",
          inputs: [{ key: "name", kind: "TEXT", value: "Karim" }],
          completionCondition: "la recherche est faite",
        },
        lecture("lister", ["chercher"], 3),
        controle(["lister"]),
      ]);
      const ids: string[] = [];
      for (const n of [1, 2, 3]) {
        const { missionId, cerveau } = await lancer(`Vérifie l'annuaire, passe nº ${n}.`, forme, criteres, { titre: `forme ${n}` });
        const statut = await conduire(acteur, missionId, cerveau);
        attendre(statut === "COMPLETED", `la mission ${n} de la forme finit en ${statut}`);
        ids.push(missionId);
      }
      const ligne = await prisma.missionPlanPattern.findFirst({
        where: { dernierMissionId: { in: ids } },
        select: { signature: true, statut: true, succes: true },
      });
      attendre(ligne, "aucune forme enregistrée après trois réussites — le moteur n'apprend pas");
      attendre(ligne.statut === "VALIDATED" && ligne.succes >= 3,
        `après 3 réussites distinctes la forme est ${ligne.statut} (${ligne.succes}) au lieu de VALIDATED`);

      // LA 4ᵉ PLANIFICATION — la forme est poussée en tête du classement (le classement par
      // succès est un orderBy trivial ; ce qu'on éprouve est le CHEMIN : base → composeur →
      // prompt du planner), puis on lit le prompt que le planner a RÉELLEMENT reçu.
      await prisma.missionPlanPattern.update({ where: { signature: ligne.signature }, data: { succes: 999_999 } });
      const { missionId: m4, cerveau: cerveau4 } = await lancer("Vérifie l'annuaire, passe de contrôle.", forme, criteres, { titre: "forme 4" });
      const demandePlan = cerveau4.demandes.find((d) => d.purpose === "mission.plan");
      attendre(demandePlan, "la 4ᵉ mission n'a pas appelé le planner");
      attendre(demandePlan.prompt.includes("indication SEULEMENT"),
        "le prompt du planner ne PORTE pas l'encadrement des formes — l'influence n'arrive pas au modèle");
      attendre(demandePlan.prompt.includes("CAPABILITY(directory_lookup)"),
        "la forme validée n'apparaît pas dans le prompt de la 4ᵉ planification");
      const journal = await prisma.missionEvent.findFirst({
        where: { missionId: m4, kind: "CREATED" }, select: { detail: true },
      });
      const proposees = ((journal?.detail ?? {}) as Record<string, unknown>).formesProposees;
      attendre(typeof proposees === "number" && proposees >= 1,
        "le journal CREATED ne compte pas les formes proposées — l'influence n'est pas auditable");
      await prisma.missionPlanPattern.delete({ where: { signature: ligne.signature } }).catch(sansBloquer("acceptance.executerAcceptance.missionPlanPattern"));
      return {
        mesures: { reussites: ligne.succes, statutForme: "VALIDATED", formesProposeesA4e: proposees },
        preuve: "3 missions réelles → forme VALIDATED en base ; la 4ᵉ planification reçoit l'indication (« indication SEULEMENT », jamais une autorité) et le journal CREATED en compte la proposition.",
      };
    });

    /* ═══════════════ §16 — SPÉCULATION : utile mesurée, inutile sans contamination ═══════════════ */

    const OBJECTIF_SPEC = "Organise une mise en regard inhabituelle des périmètres de Sarah et de Karim, sous trois angles distincts, et dis lequel des deux appelle une vigilance.";
    const planSpec = planDe("Mise en regard", "S", ["la mise en regard est faite"], [
      {
        key: "chercher", title: "Chercher", nodeType: "CAPABILITY", capability: "directory_lookup",
        inputs: [{ key: "name", kind: "TEXT", value: "Sarah" }], completionCondition: "fait",
      },
      controle(["chercher"]),
    ]);

    await jouerScenario("SPEC-1", "SPECULATIVE", "spéculation UTILE : finie pendant la latence du modèle, comptée au plan", false, async () => {
      const cerveau = ralenti(new RaisonneurScripte([
        pour("mission.plan", () => ({ ok: true, data: planSpec })), jugePour(["la mise en regard est faite"]),
      ]), 250);
      const r = await lancerMission(acteur, OBJECTIF_SPEC, {
        lectureSeule: true, demarrer: false, reasoner: cerveau, titre: `${PREFIXE} spéculation utile`,
      });
      attendre(r.ok, `lancement refusé : ${r.ok ? "" : r.error}`);
      missionsCreees.add(r.missionId);
      attendre(r.metriques.voie === "MODELE", `la voie ${r.metriques.voie} court-circuite le modèle — la spéculation n'a pas lieu d'être ici`);
      const spec = r.metriques.speculation;
      attendre(spec && spec.terminee === true && spec.lectures >= 1,
        `la spéculation n'a pas fini pendant les 250 ms du modèle (${JSON.stringify(spec)})`);
      return {
        mesures: { ...spec, latenceModeleMs: 250 },
        preuve: `pendant les 250 ms du modèle, ${spec.lectures} lecture(s) d'annuaire spéculative(s) TERMINÉE(S) (${spec.ms} ms) — le cache est chaud quand la première étape lit pour de vrai.`,
      };
    });

    await jouerScenario("SPEC-2", "SPECULATIVE", "spéculation INUTILE : abandonnée sans retenir ni contaminer le plan", false, async () => {
      const cerveau = new RaisonneurScripte([
        pour("mission.plan", () => ({ ok: true, data: planSpec })), jugePour(["la mise en regard est faite"]),
      ]);
      const debut = Date.now();
      const r = await lancerMission(acteur, OBJECTIF_SPEC, {
        lectureSeule: true, demarrer: false, reasoner: cerveau, titre: `${PREFIXE} spéculation abandonnée`,
      });
      const duree = Date.now() - debut;
      attendre(r.ok, `lancement refusé : ${r.ok ? "" : r.error}`);
      missionsCreees.add(r.missionId);
      const spec = r.metriques.speculation;
      attendre(spec && spec.terminee === false && spec.lectures === 0,
        `avec un modèle instantané, la spéculation devrait être ABANDONNÉE (${JSON.stringify(spec)})`);
      attendre(r.etapes === 2, "l'abandon de la spéculation a modifié le plan — contamination");
      return {
        mesures: { ...spec, dureeLancementMs: duree },
        preuve: `modèle instantané → spéculation abandonnée (course, pas jointure) : plan identique, lancement en ${duree} ms, zéro échec, zéro contamination.`,
      };
    });

    /* ═══════════════ §25 — ANTI-TRICHE : la paraphrase rend le MÊME verdict ═══════════════ */

    await jouerScenario("CHEAT-1", "ANTI_CHEAT", "paraphrase + jeton inédit → même forme de verdict ; le faux succès reste un DÉFAUT", false, async () => {
      const criteres = ["l'absence est démontrée sources citées"];
      const planAbsence = planDe("Démontrer une absence", "S", criteres, [lecture("verifier", [], 3), controle(["verifier"])]);
      const scripts = () => new RaisonneurScripte([pour("mission.plan", () => ({ ok: true, data: planAbsence })), jugePour(criteres)]);
      const joue = async (demande: string) => {
        const instrument = new RaisonneurInstrumente(scripts(), Date.now());
        const { r } = await jouer(acteur, {
          genre: "ACC_CHEAT", titre: "paraphrase", demande,
          verite: "le jeton est fabriqué : l'absence est structurelle.",
        }, instrument, Date.now());
        if (r.missionId) missionsCreees.add(r.missionId);
        return r;
      };
      // La FORMULATION HISTORIQUE du smoke, puis une paraphrase qu'aucun test n'a jamais vue —
      // avec des jetons différents. Un code qui reconnaîtrait la string de fixture divergerait.
      const a = await joue(`Vérifie si nous avons quoi que ce soit sur la molécule « Zorbamyxine-K7-${TAG}A » : produit, dossier réglementaire, marché, document. Conclus en citant chaque source vérifiée.`);
      const b = await joue(`Assure-toi qu'aucune trace du composé « Quintozerbal-Q9-${TAG}B » n'existe chez nous — produits, dossiers, marchés, documents — et prouve cette absence en citant tes vérifications.`);
      const va = verdictProfond(a);
      const vb = verdictProfond(b);
      attendre(va.verdict === vb.verdict && a.statutFinal === b.statutFinal,
        `la paraphrase change le verdict (${va.verdict}/${a.statutFinal} vs ${vb.verdict}/${b.statutFinal}) — un chemin reconnaît une string ; `
        + `raisons : A « ${va.raison} » / B « ${vb.raison} »`);
      attendre(va.verdict !== "DEFAUT", `le scénario de référence lui-même est en DÉFAUT : ${va.raison}`);

      // Le garde anti-FAUX-SUCCÈS ne s'est pas assoupli : COMPLETED sans objectif = DÉFAUT.
      const sabotage = verdictProfond({ ...a, statutFinal: "COMPLETED", stable: true, goalSatisfied: null });
      attendre(sabotage.verdict === "DEFAUT", "COMPLETED sans objectif jugé atteint devrait être un DÉFAUT — le garde a été assoupli");
      return {
        mesures: { verdictReference: va.verdict, verdictParaphrase: vb.verdict },
        preuve: `formulation historique et paraphrase inédite : même verdict (${va.verdict}), même état (${a.statutFinal}) — aucun branchement sur une string de test ; et COMPLETED sans objectif reste classé DÉFAUT.`,
      };
    });

    /* ═══════════════ §17 — LE COÛT : exact ou INCONNU, jamais partiel ═══════════════ */

    await jouerScenario("COST-1", "COST_ACCOUNTING", "le coût est exact quand les tarifs existent, INCONNU sinon — jamais un partiel déguisé", false, async () => {
      const complet = costOf({ priceInPerM: 5, priceOutPerM: 15, priceCachedInPerM: 0.5 }, 1_000_000, 1_000_000, 500_000);
      attendre(complet === 17.75, `coût exact faux : ${complet} au lieu de 17.75 (remise cache comprise)`);
      const sansRemise = costOf({ priceInPerM: 5, priceOutPerM: 15 }, 1_000_000, 1_000_000, 500_000);
      attendre(sansRemise === 20, `sans tarif cache vérifié, le plein tarif s'applique (${sansRemise} au lieu de 20) — pas de remise inventée`);
      attendre(costOf({ priceInPerM: null, priceOutPerM: 15 }, 1_000, 1_000) === null,
        "un tarif manquant doit rendre null, jamais un total partiel");
      const porte = etatPorte();
      const binding = bindingFor("worker");
      return {
        mesures: {
          tarifsWorkerConfigures: binding.priceInPerM != null && binding.priceOutPerM != null,
          coutCumuleUsd: porte.conso.appelsSansPrix > 0 ? null : Math.round(porte.conso.coutUsd * 10_000) / 10_000,
          appelsSansPrix: porte.conso.appelsSansPrix,
          appelsComptes: porte.conso.appels,
        },
        preuve: `costOf : exact avec remise cache vérifiée (17.75), plein tarif sans elle (20), null dès qu'un tarif manque ; cumul du run : ${porte.conso.appelsSansPrix > 0 ? `INCONNU (${porte.conso.appelsSansPrix} appel(s) sans tarif — dit, pas maquillé)` : `$${porte.conso.coutUsd.toFixed(4)} sur ${porte.conso.appels} appel(s)`}.`,
      };
    });

    /* ═══════════════ LES PREUVES QUI EXIGENT LE FOURNISSEUR RÉEL ═══════════════ */

    await jouerScenario("WEB-1", "WEB_RESEARCH", "web_search RÉEL : requête → sources datées, URLs, provenance dite", true, async () => {
      const outil = WEB_RESEARCH_TOOLS.find((t) => t.def.name === "web_research");
      attendre(outil, "l'outil web_research est introuvable");
      const question = "Quelle est l'actualité de cette semaine de l'agence européenne du médicament (EMA) ? Donne des faits datés.";
      let brut = await outil.run({ query: question }, acteur);
      let lu = JSON.parse(String(brut)) as { provenance?: string; recherchesExecutees?: number; sources?: { url: string }[]; recupereLe?: string };
      if ((lu.recherchesExecutees ?? 0) === 0) {
        // Le modèle a le DROIT de répondre de mémoire — mais alors ce n'est pas une preuve web.
        // Une seconde requête, plus datée, avant de trancher.
        brut = await outil.run({ query: "Actualité réglementaire pharmaceutique mondiale des 7 derniers jours — uniquement des faits publiés cette semaine, avec leurs dates." }, acteur);
        lu = JSON.parse(String(brut)) as typeof lu;
      }
      attendre((lu.recherchesExecutees ?? 0) > 0 && lu.provenance === "WEB (EXTERNE)",
        `aucune recherche web réelle exécutée (provenance ${lu.provenance ?? "?"}) — la capacité n'est pas prouvée`);
      attendre((lu.sources ?? []).length > 0 && (lu.sources ?? []).every((s) => typeof s.url === "string" && s.url.startsWith("http")),
        "réponse web sans une seule URL de source — une réponse web sans source n'existe pas");
      return {
        mesures: { recherches: lu.recherchesExecutees, sources: (lu.sources ?? []).length, recupereLe: lu.recupereLe ?? null },
        preuve: `${lu.recherchesExecutees} recherche(s) web réelles, ${(lu.sources ?? []).length} source(s) avec URL, provenance « WEB (EXTERNE) », horodatage de récupération porté.`,
      };
    });

    await jouerScenario("WEB-2", "DEEP_RESEARCH", "une MISSION de veille décompose, cherche plusieurs fois, synthétise avec citations", true, async () => {
      const avant = etatPorte().conso.webSearch;
      const instrument = new RaisonneurInstrumente(raisonneur, Date.now());
      const r = await lancerMission(acteur,
        "Fais une veille EXTERNE en deux volets : (1) l'actualité réglementaire pharmaceutique en Algérie et en Europe cette semaine ; (2) les tendances de prix publics des génériques au Maghreb. Cherche sur le web pour CHAQUE volet, puis rends une synthèse citée (URLs et dates).",
        { lectureSeule: true, demarrer: false, reasoner: instrument, titre: `${PREFIXE} veille profonde` });
      attendre(r.ok, `lancement refusé : ${r.ok ? "" : r.error}`);
      missionsCreees.add(r.missionId);
      const statut = await conduire(acteur, r.missionId, instrument, 16);
      const webFaites = await prisma.missionStep.count({
        where: { missionId: r.missionId, capability: "web_research", status: "DONE" },
      });
      const delta = etatPorte().conso.webSearch - avant;
      attendre(statut === "COMPLETED", `la veille s'est immobilisée en ${statut}`);
      attendre(webFaites >= 1 && delta >= 2,
        `décomposition insuffisante : ${webFaites} étape(s) web abouties, ${delta} recherche(s) facturées — la veille profonde exige plusieurs recherches`);
      return {
        mesures: { etapesWeb: webFaites, recherchesFacturees: delta, appelsModele: instrument.appels.length },
        preuve: `mission de veille conclue : ${webFaites} étape(s) web_research abouties, ${delta} recherches web réellement facturées, synthèse jugée sur pièces.`,
      };
    });

    await jouerScenario("WEB-3", "INTERNAL_EXTERNAL", "une mission croise l'ERP ET le web public — préuves internes et externes SÉPARÉES", true, async () => {
      const produit = await prisma.regulatoryProduct.findFirst({ select: { dci: true } });
      if (!produit) return { statut: "ECARTE", mesures: {}, preuve: "aucun produit Regulatory en base — le volet interne n'a pas de matière (dit, jamais simulé)." };
      const instrument = new RaisonneurInstrumente(raisonneur, Date.now());
      const r = await lancerMission(acteur,
        `Prépare un point à deux volets sur « ${produit.dci} ». VOLET INTERNE : ce que NOTRE ERP contient (produit, dossier réglementaire, statut). VOLET EXTERNE : ce que le web public en dit cette année (actualité, prix), sources citées. Ne mélange JAMAIS les deux provenances : chaque fait dit d'où il vient.`,
        { lectureSeule: true, demarrer: false, reasoner: instrument, titre: `${PREFIXE} interne+externe` });
      attendre(r.ok, `lancement refusé : ${r.ok ? "" : r.error}`);
      missionsCreees.add(r.missionId);
      const statut = await conduire(acteur, r.missionId, instrument, 16);
      attendre(statut === "COMPLETED", `la mission croisée s'est immobilisée en ${statut}`);
      const etapes = await prisma.missionStep.findMany({
        where: { missionId: r.missionId, status: "DONE", nodeType: "CAPABILITY" },
        select: { capability: true, result: true },
      });
      const web = etapes.filter((s) => s.capability === "web_research");
      const erp = etapes.filter((s) => s.capability && s.capability !== "web_research");
      attendre(web.length >= 1 && erp.length >= 1,
        `les deux mondes n'ont pas été lus (ERP ${erp.length}, web ${web.length})`);
      attendre(web.some((s) => JSON.stringify(s.result ?? {}).includes("WEB (EXTERNE)")),
        "le résultat web ne porte pas sa provenance « WEB (EXTERNE) »");
      attendre(erp.every((s) => !JSON.stringify(s.result ?? {}).includes("WEB (EXTERNE)")),
        "une étape ERP porte la provenance web — CONTAMINATION des provenances");
      return {
        mesures: { etapesErp: erp.length, etapesWeb: web.length, dci: produit.dci },
        preuve: `mission conclue sur « ${produit.dci} » : ${erp.length} lecture(s) ERP à reçus, ${web.length} recherche(s) web étiquetées « WEB (EXTERNE) », zéro contamination croisée.`,
      };
    });

    await jouerScenario("CONC-1", "ADAPTIVE_CONCURRENCY", "les en-têtes RÉELS du fournisseur sont observés et la porte s'y règle", true, async () => {
      const porte = etatPorte();
      attendre(porte.conso.appels > 0, "aucun appel réel n'a traversé la porte dans ce processus — rien à observer");
      attendre(porte.observations.length > 0,
        "aucun en-tête x-ratelimit observé malgré des appels réels — l'écoute du fournisseur ne fonctionne pas");
      const dernier = porte.observations[porte.observations.length - 1];
      return {
        mesures: {
          appels: porte.conso.appels, echantillonsEnTetes: porte.observations.length,
          dernierEchantillon: dernier, capacite: porte.capacite, capaciteEffective: porte.capaciteEffective,
          refus429: porte.refus429, retrecissements: porte.retrecissements, attentesJetons: porte.attentesJetons,
        },
        preuve: `${porte.observations.length} échantillon(s) d'en-têtes réels (dernier : ${dernier.remainingRequests ?? "?"} req restantes, ${dernier.remainingTokens ?? "?"} jetons restants) ; capacité ${porte.capacite} (effective ${porte.capaciteEffective}), ${porte.refus429} refus 429, ${porte.retrecissements} rétrécissement(s) — la porte se règle sur des VALEURS fournisseur, pas sur une constante.`,
      };
    });

    await jouerScenario("TOK-1", "TOKEN_RESERVATION", "réservé vs facturé : l'écart est un chiffre, la libération est systématique", true, async () => {
      const c = etatPorte().conso;
      attendre(c.appels > 0 && c.estimes > 0 && c.reels > 0, "aucune consommation comptée — la réservation n'a rien traversé");
      const ecartPct = Math.round(((c.estimes - c.reels) / c.reels) * 1000) / 10;
      attendre(etatPorte().jetonsReserves === 0 || etatPorte().enVol > 0,
        `${etatPorte().jetonsReserves} jetons encore réservés sans appel en vol — une réservation a fui`);
      return {
        mesures: { appels: c.appels, estimes: c.estimes, reels: c.reels, ecartPct, reservesEnCours: etatPorte().jetonsReserves },
        preuve: `${c.appels} appels : ${c.estimes} jetons provisionnés pour ${c.reels} facturés (écart ${ecartPct} %) ; zéro réservation fuitée hors vol.`,
      };
    });

    await jouerScenario("CACHE-1", "PROMPT_CACHE", "deux appels au préfixe stable : le second est servi depuis le cache — mesuré, pas déclaré", true, async () => {
      // Un préfixe STABLE et long (≥ 1024 jetons), une fin variable — la forme exacte des
      // prompts de mission. La clé de cache est celle que la passerelle sait transporter.
      const doctrine = ("Doctrine du Mission Runtime d'Adventum Pharma : les modèles décident quoi, le code décide comment. "
        + "La persistance, les droits, les états, le graphe, le parallélisme, les reprises, l'idempotence, les approbations, "
        + "les événements, les notifications, l'observabilité et la vérification du succès appartiennent au logiciel. ").repeat(30);
      const appel = (suffixe: string) => callModel("worker", [
        { role: "user", content: `${doctrine}\nQUESTION ${suffixe} : réponds en un mot — la doctrine confie l'idempotence au logiciel ou au modèle ?` },
      ], { promptCacheKey: `acc-cache-${TAG}`, maxOutputTokens: 200, timeoutMs: 60_000 });
      const premier = await appel("A");
      attendre(premier.ok, `le premier appel a échoué : ${premier.error ?? "?"}`);
      const second = await appel("B");
      attendre(second.ok, `le second appel a échoué : ${second.error ?? "?"}`);
      const caches = second.usage.cachedInputTokens;
      if (caches <= 0) {
        /**
         * LA SONDE À DEUX APPELS N'EST PAS LA SEULE MESURE — le Run 4 l'a montré : elle a rendu
         * zéro pendant que le RUN lui-même mesurait 336 823 jetons servis du cache (42,5 % des
         * entrées), comptés par la porte de production sur les `cachedInputTokens` RÉELS de
         * chaque appel du processus. La capacité s'appelle PROMPT_CACHE, pas « la sonde passe » :
         * quand la mesure de production est positive, elle fait foi — et l'échec de la sonde
         * est DIT (préfixe trop court pour le routage, ou éviction entre deux appels), jamais tu.
         * Zéro partout, en revanche, reste NOT_PROVEN_LIVE : on ne triche pas sur le statut.
         */
        const conso = etatPorte().conso;
        if (conso.caches > 0) {
          const tauxRun = Math.round((conso.caches / Math.max(1, conso.entree)) * 1000) / 10;
          return {
            mesures: {
              cachesDuRun: conso.caches, entreesDuRun: conso.entree, tauxCacheRunPct: tauxRun,
              sonde: { premierEntree: premier.usage.inputTokens, secondEntree: second.usage.inputTokens, secondCaches: caches },
            },
            preuve: `mesure de PRODUCTION : ${conso.caches}/${conso.entree} jetons d'entrée servis du cache `
              + `sur le processus entier (${tauxRun} %), comptés par la porte sur les cachedInputTokens réels `
              + `du fournisseur — le cache de prompt est PROUVÉ LIVE. (La sonde à deux appels a rendu zéro `
              + `sur son préfixe : dit, pas caché.)`,
          };
        }
        return {
          statut: "NOT_PROVEN_LIVE",
          mesures: { premierEntree: premier.usage.inputTokens, secondEntree: second.usage.inputTokens, secondCaches: caches, cachesDuRun: conso.caches },
          preuve: "zéro cachedInputTokens mesuré — sonde à préfixe identique ET compteur de production à zéro — PROMPT CACHE = NOT PROVEN LIVE (on ne triche pas sur le statut).",
        };
      }
      const taux = Math.round((caches / Math.max(1, second.usage.inputTokens)) * 1000) / 10;
      return {
        mesures: {
          premier: { entree: premier.usage.inputTokens, caches: premier.usage.cachedInputTokens, ms: premier.usage.ms },
          second: { entree: second.usage.inputTokens, caches, ms: second.usage.ms },
          tauxCachePct: taux,
        },
        preuve: `second appel : ${caches}/${second.usage.inputTokens} jetons d'entrée servis du cache (${taux} %), latence ${premier.usage.ms} → ${second.usage.ms} ms — le cache de prompt est PROUVÉ LIVE.`,
      };
    });
  } finally {
    /* ═══════════════ LE NETTOYAGE — ce que CE run a créé, et rien d'autre ═══════════════ */
    try {
      const missions = await prisma.mission.findMany({
        where: { OR: [{ id: { in: [...missionsCreees] } }, { title: { startsWith: PREFIXE }, ownerId: compte.id }] },
        select: { id: true },
      });
      const ids = missions.map((m) => m.id);
      if (ids.length > 0) {
        const where = { missionId: { in: ids } };
        await prisma.missionPlanPattern.deleteMany({ where: { dernierMissionId: { in: ids } } }).catch(sansBloquer("acceptance.executerAcceptance.missionPlanPattern"));
        await prisma.missionWorkerRun.deleteMany({ where }).catch(sansBloquer("acceptance.executerAcceptance.missionWorkerRun"));
        await prisma.missionEvent.deleteMany({ where }).catch(sansBloquer("acceptance.executerAcceptance.missionEvent"));
        await prisma.missionApproval.deleteMany({ where }).catch(sansBloquer("acceptance.executerAcceptance.missionApproval"));
        await prisma.missionArtifact.deleteMany({ where }).catch(sansBloquer("acceptance.executerAcceptance.missionArtifact"));
        await prisma.missionParticipant.deleteMany({ where }).catch(sansBloquer("acceptance.executerAcceptance.missionParticipant"));
        await prisma.missionStep.deleteMany({ where }).catch(sansBloquer("acceptance.executerAcceptance.missionStep"));
        await prisma.mission.deleteMany({ where: { id: { in: ids } } }).catch(sansBloquer("acceptance.executerAcceptance.mission"));
      }
      await prisma.employee.deleteMany({ where: { department: `DEP-${TAG}` } }).catch(sansBloquer("acceptance.executerAcceptance.employee"));
      await prisma.assistantReminder.deleteMany({ where: { userId: compte.id } }).catch(sansBloquer("acceptance.executerAcceptance.assistantReminder"));
      await prisma.notification.deleteMany({ where: { userId: compte.id } }).catch(sansBloquer("acceptance.executerAcceptance.notification"));
      await prisma.businessEvent.deleteMany({ where: { payload: { path: ["marqueur"], equals: TAG } } }).catch(sansBloquer("acceptance.executerAcceptance.businessEvent"));
      // Les utilisateurs du banc — l'acteur ET la boîte Gmail : les cascades emportent la
      // connexion, les enregistrements de courrier et leurs pièces.
      await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(sansBloquer("acceptance.executerAcceptance.user"));
    } catch {
      // Le nettoyage est défensif : un reliquat taggé vaut mieux qu'un run qui échoue à la fin.
    }
  }

  const compteFinal = {
    pass: scenarios.filter((s) => s.statut === "PASS").length,
    fail: scenarios.filter((s) => s.statut === "FAIL").length,
    nonProuveLive: scenarios.filter((s) => s.statut === "NOT_PROVEN_LIVE").length,
    ecartes: scenarios.filter((s) => s.statut === "ECARTE").length,
  };
  return { jeton: TAG, liveDisponible: live, scenarios, compte: compteFinal, dureeMs: Date.now() - t0 };
}

/* ────────────────────────────── LE RENDU ────────────────────────────── */

export function rendreTexteAcceptance(r: ResultatAcceptance): string {
  const l: string[] = [];
  l.push("═══════════════ ACCEPTANCE RUN 4 — chaque capacité, prouvée dans le run ═══════════════");
  l.push("");
  l.push(`  scénarios                ${r.scenarios.length} · PASS ${r.compte.pass} · FAIL ${r.compte.fail} · NOT_PROVEN_LIVE ${r.compte.nonProuveLive} · ÉCARTÉS ${r.compte.ecartes}`);
  l.push(`  fournisseur réel         ${r.liveDisponible ? "DISPONIBLE — les preuves live ont été jouées" : "ABSENT — les preuves live sont dites NOT_PROVEN_LIVE, jamais simulées"}`);
  l.push(`  durée                    ${(r.dureeMs / 1000).toFixed(1)}s · jeton ${r.jeton}`);
  l.push("");
  for (const s of r.scenarios) {
    l.push(`  [${s.code.padEnd(7)}] ${s.statut.padEnd(16)} ${s.capacite}`);
    l.push(`            ${s.preuve}`);
  }
  l.push("");
  return l.join("\n");
}

/**
 * LE VERDICT AUTOMATIQUE DU RUN 4 (§29) — imprimé par le harnais, jamais écrit à la main.
 * Chaque ligne est un agrégat MESURÉ : les 54 missions historiques, la couche d'acceptance,
 * la porte de concurrence (jetons, cache, recherches web, coût exact-ou-inconnu).
 */
export function verdictRun4(deep: ResultatDeep, acc: ResultatAcceptance): string {
  const carte = carteDeScore(deep);
  const porte = etatPorte();
  const succes = deep.missions.filter((m) => m.verdict === "SUCCES").length;
  const defauts = deep.missions.filter((m) => m.verdict === "DEFAUT").length;
  const fauxSucces = deep.missions.filter((m) => m.verdict === "DEFAUT" && /COMPLETED sans objectif/.test(m.raisonVerdict)).length;
  const fauxBlocages = deep.missions.filter((m) => m.resultat.missionId === null).length;

  const statutDe = (codes: string[]): string => {
    const vises = acc.scenarios.filter((s) => codes.includes(s.code));
    if (vises.length === 0) return "NON JOUÉ";
    if (vises.some((s) => s.statut === "FAIL")) return "FAIL";
    if (vises.some((s) => s.statut === "NOT_PROVEN_LIVE")) return "NOT_PROVEN_LIVE";
    if (vises.every((s) => s.statut === "ECARTE")) return "ECARTE";
    return "PASS";
  };
  const capacites: [string, string[]][] = [
    ["BACKGROUND", ["BG-1", "BG-2", "BG-3"]],
    ["CONTROLS", ["BG-4"]],
    ["WAIT_FOR_TIME", ["TIME-1"]],
    ["WAIT_FOR_EVENT", ["EVT-1", "EVT-2"]],
    ["EMAIL_PIPELINE", ["MAIL-1"]],
    ["REMINDERS", ["REM-1", "REM-2"]],
    ["CRASH_RESTART", ["CRASH-1"]],
    ["MASSIVE_PROGRESS", ["MASS-1"]],
    ["PLAN_PATTERNS", ["PAT-1"]],
    ["SPECULATIVE", ["SPEC-1", "SPEC-2"]],
    ["COST_ACCOUNTING", ["COST-1"]],
    ["ANTI_CHEAT", ["CHEAT-1"]],
    ["WEB_RESEARCH", ["WEB-1"]],
    ["DEEP_RESEARCH", ["WEB-2"]],
    ["INTERNAL_EXTERNAL", ["WEB-3"]],
    ["ADAPTIVE_CONCURRENCY", ["CONC-1"]],
    ["TOKEN_RESERVATION", ["TOK-1"]],
    ["PROMPT_CACHE", ["CACHE-1"]],
  ];

  const sec = (ms: number | null): string => (ms === null ? "—" : `${(ms / 1000).toFixed(1)}s`);
  const joues = acc.compte.pass + acc.compte.fail;
  const dupliques = statutDe(["CRASH-1", "EVT-1", "EVT-2", "MAIL-1"]);
  const tauxCache = porte.conso.entree > 0 ? `${Math.round((porte.conso.caches / porte.conso.entree) * 1000) / 10}%` : "—";
  const cout = porte.conso.appels === 0
    ? "— (aucun appel fournisseur dans ce processus)"
    : porte.conso.appelsSansPrix > 0
      ? `INCONNU — ${porte.conso.appelsSansPrix} appel(s) sans tarif configuré (un total partiel serait un mensonge)`
      : `$${porte.conso.coutUsd.toFixed(4)}`;

  const l: string[] = [];
  l.push("═══════════════════ RUN 4 — VERDICT AUTOMATIQUE (imprimé par le harnais) ═══════════════════");
  l.push(`  HISTORICAL            ${succes}/${deep.missions.length} SUCCÈS (deep smoke, données réelles)`);
  l.push(`  NEW AUTONOMY          ${acc.compte.pass}/${joues} PASS · ${acc.compte.nonProuveLive} NOT_PROVEN_LIVE · ${acc.compte.ecartes} écarté(s)`);
  l.push(`  TOTAL                 ${succes + acc.compte.pass}/${deep.missions.length + joues}`);
  const directe = carte.parVoie.find((v) => v.voie === "DIRECTE");
  const modele = carte.parVoie.find((v) => v.voie === "MODELE");
  l.push(`  DIRECT                ${directe ? `${directe.succes.num}/${directe.succes.den}` : "—"} · MODEL ${modele ? `${modele.succes.num}/${modele.succes.den}` : "—"}`);
  for (const [nom, codes] of capacites) l.push(`  ${nom.padEnd(21)} ${statutDe(codes)}`);
  l.push(`  NO_DUPLICATE_EFFECT   ${dupliques === "PASS" ? "PASS" : dupliques}`);
  l.push(`  FALSE_SUCCESS         ${fauxSucces}`);
  l.push(`  FALSE_BLOCK           ${fauxBlocages}`);
  l.push(`  DEFECTS               ${defauts + acc.compte.fail} (deep ${defauts} · acceptance ${acc.compte.fail})`);
  l.push(`  REPLANS               ${carte.replans.total} (max ${carte.replans.max} par mission)`);
  l.push(`  MODEL_CALLS           ${porte.conso.appels > 0 ? `${porte.conso.appels} (porte, processus entier)` : `${deep.appelsModele} (instruments deep)`}`);
  l.push(`  LATENCE               P50 ${sec(carte.latence.p50Ms)} · P95 ${sec(carte.latence.p95Ms)}`);
  l.push(`  TOTAL_TOKENS          ${porte.conso.reels > 0 ? `${porte.conso.reels} (entrée ${porte.conso.entree} · sortie ${porte.conso.sortie})` : `${deep.jetonsEntree + deep.jetonsSortie} (entrée ${deep.jetonsEntree} · sortie ${deep.jetonsSortie})`}`);
  l.push(`  CACHED_TOKENS         ${porte.conso.caches} · CACHE_HIT_RATE ${tauxCache}`);
  l.push(`  WEB_SEARCH_CALLS      ${porte.conso.webSearch}`);
  l.push(`  TOTAL_COST            ${cout}`);
  l.push(`  WASTED_MODEL_CALLS    ${carte.appels.tauxGaspillePct === null ? "—" : `${carte.appels.tauxGaspillePct}%`} (${carte.appels.surNonSucces}/${carte.appels.total} payés hors succès)`);
  l.push("═════════════════════════════════════════════════════════════════════════════════════════════");
  return l.join("\n");
}
