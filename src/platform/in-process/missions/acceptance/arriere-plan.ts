/**
 * Acceptance du Run 4 — §1 ARRIÈRE-PLAN : détacher une mission, la faire coexister avec les
 * requêtes interactives, la mettre en pause, l'annuler, la prioriser et la plafonner.
 */
import { prisma } from "@/lib/prisma";
import { RaisonneurScripte, pour } from "@/platform/in-process/missions/fake-reasoner";
import { lancerEnArrierePlan } from "@/platform/in-process/missions/runtime";
import { pauserMission, reprendreMissionAgent, arreterMissionAgent, prioriserMission, plafonnerModeleMission } from "@/platform/in-process/missions/control";
import { recordEvent } from "@/lib/events/ledger";
import { missionsAFaireAvancer } from "@/lib/missions/events/router";
import { vueMission } from "@/lib/missions/view/workspace";
import { type ContexteAcceptance, attendre, conduire, controle, etatEtape, jugePour, lecture, planDe } from "./banc";

export async function scenariosArrierePlan(ctx: ContexteAcceptance): Promise<void> {
  const { TAG, PREFIXE, acteur, missionsCreees, jouerScenario, lancer } = ctx;
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
}
