/**
 * Smoke fournisseur — LE JEU : mener une mission jusqu'à un état stable (avancer, replanifier),
 * jouer un scénario de bout en bout et arrêter les missions de diagnostic après la mesure.
 */
import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/session";
import { EFFECT_RANK, type Effect } from "@/lib/missions/registry/capability-meta";
import { annuler } from "@/lib/missions/runtime/control";
import { catalogueDe } from "@/platform/in-process/missions/catalog";
import { avancerMission, lancerMission, replanifierMission } from "@/platform/in-process/missions/runtime";
import { RaisonneurInstrumente, cascade } from "@/platform/in-process/missions/provider-waterfall";
import { sansBloquer } from "@/lib/journal";
import { type Chaine, effetDeLEtape, effetExecute, ETATS_REPLANIFIABLES, ETATS_STABLES, PLAFOND, recenserArtefacts, type ResultatMission, verdictLectureSeule } from "./verdict";
import type { Scenario } from "./scenarios";

/**
 * MÈNE LA MISSION À UN ÉTAT RÉELLEMENT STABLE, avec le mécanisme canonique et lui seul.
 *
 * ── CE QUE CETTE FONCTION NE FAIT PAS ────────────────────────────────────────────────────
 *
 * Elle ne réimplémente rien. Elle appelle `avancerMission` — qui est `avancer()` assemblé — et
 * `replanifierMission`, les deux points d'entrée que l'écran et l'ordonnanceur utilisent. Elle
 * n'écrit aucune étape, ne force aucun statut, ne juge aucun objectif.
 *
 * ── LE POINT FIXE, ET POURQUOI IL FALLAIT LE NOMMER ──────────────────────────────────────
 *
 * `RUNNING` avec toutes les étapes terminées est un état particulier de ce runtime : il signifie
 * « plus rien à exécuter, et l'objectif n'a pas été jugé atteint ». `avancer()` n'y changera
 * rien, et `replanifierMission` le refuse — RUNNING n'est pas dans ses états replanifiables.
 * C'est donc un POINT FIXE : ni terminal, ni réparable par les voies existantes.
 *
 * On le détecte en comparant la signature de la mission d'un tour à l'autre. Le diagnostic
 * s'arrête alors et le NOMME, au lieu de tourner en rond ou de conclure à sa place. C'est un
 * constat sur le runtime, pas une correction déguisée.
 */
async function menerAEtatStable(
  user: CurrentUser,
  missionId: string,
  instrument: RaisonneurInstrumente,
  toursMax: number,
): Promise<{ statut: string | null; stable: boolean; motif: string; tours: number; replans: number; version: number | null }> {
  let tours = 0;
  let replans = 0;
  let signaturePrecedente = "";

  for (let i = 0; i < toursMax; i++) {
    await avancerMission(user, missionId, { lectureSeule: true, reasoner: instrument, maxTours: 6 }).catch(sansBloquer("provider-smoke.menerAEtatStable.avancerMission", null));
    tours += 1;

    const m = await prisma.mission.findUnique({
      where: { id: missionId },
      select: { status: true, planVersion: true },
    });
    if (!m) return { statut: null, stable: false, motif: "mission disparue en cours de route", tours, replans, version: null };

    const etapes = await prisma.missionStep.groupBy({
      by: ["status"], where: { missionId }, _count: { _all: true },
    }).catch(sansBloquer("provider-smoke.menerAEtatStable.missionStep", []));
    const signature = `${m.status}|${m.planVersion}|${etapes.map((e) => `${e.status}:${e._count._all}`).sort().join(",")}`;

    if (ETATS_STABLES.has(m.status)) {
      return { statut: m.status, stable: true, motif: `état stable atteint : ${m.status}`, tours, replans, version: m.planVersion };
    }

    if (ETATS_REPLANIFIABLES.has(m.status)) {
      // LE MÉCANISME CANONIQUE. Il porte lui-même son plafond (`PLANS_MAX`) et sa règle de
      // réouverture d'accord ; on ne le double pas.
      const r = await replanifierMission(user, missionId, { lectureSeule: true, reasoner: instrument }).catch(sansBloquer("provider-smoke.menerAEtatStable.replanifierMission", null));
      if (r?.replanifie) { replans += 1; signaturePrecedente = ""; continue; }
      return {
        statut: m.status, stable: true,
        motif: `${m.status} — replanification refusée : ${r?.raison ?? "indisponible"}`,
        tours, replans, version: m.planVersion,
      };
    }

    if (signature === signaturePrecedente) {
      return {
        statut: m.status, stable: false,
        motif: `POINT FIXE : la mission s'immobilise en ${m.status} — plus aucune étape à exécuter, `
          + `objectif non jugé atteint, et ${m.status} n'ouvre ni recours ni replanification`,
        tours, replans, version: m.planVersion,
      };
    }
    signaturePrecedente = signature;
  }

  const fin = await prisma.mission.findUnique({ where: { id: missionId }, select: { status: true, planVersion: true } });
  return {
    statut: fin?.status ?? null, stable: false,
    motif: `budget de tours épuisé (${toursMax}) sans état stable`,
    tours, replans, version: fin?.planVersion ?? null,
  };
}

/** Joue un scénario de bout en bout et rend TOUT ce qui a été mesuré. Exporté : le Deep
 *  Smoke (`deep-smoke.ts`) joue ses 60-80 missions par EXACTEMENT ce chemin — mêmes portes,
 *  même plafond, même garde d'artefacts. Un second harnais divergerait un jour du premier. */
export async function jouer(
  user: CurrentUser,
  sc: Scenario,
  instrument: RaisonneurInstrumente,
  t0: number,
): Promise<{ r: ResultatMission; chaine: Partial<Chaine>; metriques: { modele: string | null; entree: number; sortie: number; ouvertes: number | null } }> {
  const r: ResultatMission = {
    genre: sc.genre, demande: sc.demande, verite: sc.verite,
    missionId: null, statutFinal: null, stable: false, motifArret: "non lancé",
    toursMoteur: 0, replanifications: 0, versionPlan: null, recoursObserves: 0,
    etapesCompilees: null, etapesTerminees: 0, etapesEnEchec: 0,
    effetMaxAutorise: PLAFOND, effetMaxPlanifie: null, effetMaxExecute: null,
    capacitesHorsPlafond: [],
    artefactsAvant: null, artefactsApres: null, artefactsCrees: [],
    appelsParUsage: {},
    precondition: null, setupEchoue: false,
    qaPassed: null, goalSatisfied: null, goalVerdict: null, cascade: null,
  };
  const chaine: Partial<Chaine> = {};
  const metriques = { modele: null as string | null, entree: 0, sortie: 0, ouvertes: null as number | null };

  /**
   * ── LA VÉRITÉ TERRAIN SE VÉRIFIE AVANT DE LANCER, PAS APRÈS ────────────────────────
   *
   * Un scénario dont l'énoncé affirme une absence et dont la base contient la chose ne mesure
   * pas le produit : il mesure son propre présupposé. C'est alors le BANC qui est invalide, et
   * l'annoncer comme un échec de mission accuserait le moteur d'un défaut qui n'est pas le sien.
   */
  if (sc.verifier) {
    r.precondition = await sc.verifier();
    if (r.precondition.satisfaite !== true) {
      r.setupEchoue = true;
      r.motifArret = `INVALID / SETUP_FAILED — ${r.precondition.details}`;
      return { r, chaine, metriques };
    }
  }

  // LE RECENSEMENT D'AVANT. Il doit précéder le lancement, sans quoi « rien n'est apparu » ne
  // voudrait rien dire.
  const avant = await recenserArtefacts(user.id);
  r.artefactsAvant = avant?.compte ?? null;

  // LA TRANCHE DU SCÉNARIO. Sans elle, la cascade du premier affichait les appels des trois.
  instrument.ouvrir(sc.genre);
  const debutScenario = Date.now();

  const lancement = await lancerMission(user, sc.demande, {
    lectureSeule: true, demarrer: false, reasoner: instrument,
    titre: `Diagnostic — ${sc.titre}`,
  }).catch((e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e), metriques: undefined }));

  const m = lancement.metriques;
  if (m) {
    metriques.ouvertes = m.capacitesAutorisees;
    if (m.usage) {
      metriques.modele = m.usage.model;
      metriques.entree += m.usage.inputTokens;
      metriques.sortie += m.usage.outputTokens;
      if (m.usage.inputTokens > 0 || m.usage.outputTokens > 0) chaine.PROVIDER_CALL = "PASS";
    }
  }

  if (!lancement.ok) {
    const err = lancement.error ?? "";
    if (chaine.PROVIDER_CALL === "PASS" && !/n'a rien rendu|aucun fournisseur/i.test(err)) {
      chaine.PLANNER_REAL_MODEL = "PASS";
      if (!/non conforme au schéma/i.test(err)) chaine.MISSION_PLAN_SCHEMA = "PASS";
    }
    r.motifArret = err.slice(0, 300) || "lancement refusé";
    return { r, chaine, metriques };
  }

  chaine.PLANNER_REAL_MODEL = "PASS";
  chaine.MISSION_PLAN_SCHEMA = "PASS";
  chaine.COMPILER = "PASS";
  r.missionId = lancement.missionId;
  r.etapesCompilees = lancement.etapes;

  const etapes = await prisma.missionStep.findMany({
    where: { missionId: r.missionId }, select: { capability: true, nodeType: true },
  });
  if (etapes.length > 0) chaine.MISSION_PERSISTED = "PASS";

  // ── LE PLAFOND, VÉRIFIÉ SUR CE QUI EST ÉCRIT ───────────────────────────────────────────
  const plafond = EFFECT_RANK[PLAFOND];
  let max: Effect = "READ";
  /**
   * ── LE FAUX VERT QUE CE BLOC CORRIGE ───────────────────────────────────────────────────
   *
   * `if (!e.capability) continue;` sautait TOUTES les étapes sans capacité. Or un nœud ARTIFACT
   * n'en porte pas — et il fabrique un fichier. Résultat, sur un run réel : le rapport affichait
   * `READ_ONLY_EXECUTION PASS` pendant que deux missions écrivaient de vrais XLSX dans le Drive
   * de production, retrouvés ensuite par le run SUIVANT, qui en concluait que la molécule
   * « inexistante » existait. Un banc qui ne voit pas l'effet qu'il prétend interdire ne mesure
   * pas une garantie : il en fabrique l'apparence (§78).
   *
   * L'effet est donc relevé pour CHAQUE étape, capacité ou non — un ARTIFACT vaut `PREPARE`,
   * exactement comme le compilateur le calcule.
   */
  for (const e of etapes) {
    const eff = effetDeLEtape(e);
    if (EFFECT_RANK[eff] > EFFECT_RANK[max]) max = eff;
    if (EFFECT_RANK[eff] > plafond) {
      r.capacitesHorsPlafond.push(`${e.capability ?? e.nodeType} (${eff})`);
    }
  }
  r.effetMaxPlanifie = etapes.length > 0 ? max : null;
  if (r.capacitesHorsPlafond.length > 0) {
    r.motifArret = `défaut de garde : ${r.capacitesHorsPlafond.join(", ")} dépasse ${PLAFOND} — exécution refusée`;
    return { r, chaine, metriques };
  }

  // ── L'EXÉCUTION, MENÉE JUSQU'À UN ÉTAT STABLE ──────────────────────────────────────────
  const fin = await menerAEtatStable(user, r.missionId, instrument, 8);
  r.statutFinal = fin.statut;
  r.stable = fin.stable;
  r.motifArret = fin.motif;
  r.toursMoteur = fin.tours;
  r.replanifications = fin.replans;
  r.versionPlan = fin.version;

  const parStatut = await prisma.missionStep.groupBy({
    by: ["status"], where: { missionId: r.missionId }, _count: { _all: true },
  }).catch(sansBloquer("provider-smoke.jouer.missionStep", []));
  const compte = (s: string) => parStatut.find((x) => x.status === s)?._count._all ?? 0;
  r.etapesTerminees = compte("DONE");
  r.etapesEnEchec = compte("FAILED");
  if (fin.stable) chaine.TERMINAL_STATE = "PASS";

  /**
   * ═══════════════════════════════════════════════════════════════════════════════════
   * READ_ONLY_EXECUTION — CE QUI S'EST PASSÉ, ET NON CE QUI ÉTAIT PERMIS.
   *
   * ── LE FAUX VERT QUE CE BLOC REMPLACE ─────────────────────────────────────────────
   *
   * La condition était : « au moins une étape n'est plus PENDING ni READY ». Elle ne dit
   * strictement rien de l'EFFET exécuté — elle dit que le moteur a démarré. Sur un run réel,
   * elle a affiché PASS pendant que deux missions déposaient des classeurs XLSX dans le Drive
   * de production. Un banc qui dérive son vert du catalogue filtré mesure une intention.
   *
   * Trois conditions, toutes des observations :
   *
   *   1. quelque chose a TOURNÉ           — sans quoi il n'y a rien à attester ;
   *   2. l'effet EXÉCUTÉ tient sous le plafond, lu sur les reçus des étapes qui ont bougé ;
   *   3. AUCUN artefact n'est apparu      — la trace matérielle, indépendante des reçus.
   *
   * La 3 n'est pas redondante avec la 2 : elle observe le MONDE, pas le journal du moteur. Si
   * les deux divergent, c'est le monde qui a raison, et c'est exactement le cas qu'on veut
   * attraper — un fichier écrit par un chemin que l'instrumentation ne voit pas.
   * ═══════════════════════════════════════════════════════════════════════════════════
   */
  const etapesExecutees = await prisma.missionStep.findMany({
    where: { missionId: r.missionId },
    select: { capability: true, nodeType: true, status: true, receiptData: true },
  }).catch(sansBloquer("provider-smoke.jouer.missionStep", []));
  r.effetMaxExecute = effetExecute(etapesExecutees);

  const apres = await recenserArtefacts(user.id);
  r.artefactsApres = apres?.compte ?? null;
  if (avant && apres) {
    const connus = new Set(avant.titres);
    r.artefactsCrees = apres.titres.filter((t) => !connus.has(t));
  }

  const verdict = verdictLectureSeule({
    aTourne: parStatut.some((x) => x.status !== "PENDING" && x.status !== "READY"),
    effetExecute: r.effetMaxExecute,
    artefactsCrees: r.artefactsCrees,
  });
  if (verdict.etat === "PASS") chaine.READ_ONLY_EXECUTION = "PASS";
  // ON NOMME CE QUI A CASSÉ. « FAIL » sans raison oblige à relire le code pour comprendre.
  else if (verdict.raison) r.motifArret = `${r.motifArret} | ${verdict.raison}`;

  // ── LE RECOURS, LU DANS LE JOURNAL — jamais supposé ────────────────────────────────────
  r.recoursObserves = await prisma.missionEvent.count({
    where: { missionId: r.missionId, kind: "STEP_RECOVERY" },
  }).catch(sansBloquer("provider-smoke.jouer.missionEvent", 0));

  const etat = await prisma.mission.findUnique({
    where: { id: r.missionId },
    select: { qaPassed: true, goalSatisfied: true, goalVerdict: true },
  });
  r.qaPassed = etat?.qaPassed ?? null;
  r.goalSatisfied = etat?.goalSatisfied ?? null;
  r.goalVerdict = etat?.goalVerdict ?? null;
  if (etat?.qaPassed === true && etat?.goalSatisfied === true) chaine.QA_GOAL_SATISFACTION = "PASS";

  // LA VENTILATION DES APPELS DE CE SCÉNARIO — comptée sur l'instrument, pas estimée.
  for (const a of instrument.pour(sc.genre)) {
    r.appelsParUsage[a.purpose] = (r.appelsParUsage[a.purpose] ?? 0) + 1;
  }

  const catalogue = catalogueDe(user, { effetMax: PLAFOND });
  const utilisees = new Set(etapes.map((e) => e.capability).filter(Boolean) as string[]).size;
  // LA DURÉE EST CELLE DE CE SCÉNARIO, pas le temps écoulé depuis le début du diagnostic :
  // le troisième affichait 232 s alors qu'il n'en avait consommé que 35.
  r.cascade = await cascade(r.missionId, instrument, sc.genre, debutScenario, Date.now() - debutScenario, {
    ouvertes: catalogue.taille,
    montreesAuPlanner: m?.plannerCapabilitiesExposed ?? null,
    // CE QUI A ÉTÉ ENVOYÉ, pas ce qui aurait pu l'être. On mesurait ici le catalogue OUVERT :
    // 9 095 caractères affichés sur les trois scénarios, y compris celui qui n'en montrait que
    // quinze — l'instrument masquait exactement ce qu'il devait mesurer.
    resumeChars: m?.plannerCatalogueChars ?? null,
    utilisees,
    exposeesInutiles: m?.plannerCapabilitiesExposed != null ? Math.max(0, m.plannerCapabilitiesExposed - utilisees) : null,
  },
  // LA VOIE DU PLAN (§18, chantier latence) : DIRECTE = zéro appel de planificateur — le
  // taux de contournement se calcule dans le résumé, jamais affirmé.
  (m as { voie?: string } | undefined)?.voie ?? null);

  return { r, chaine, metriques };
}

/**
 * ARRÊTE les missions qu'un diagnostic a lancées, une fois la mesure faite (§118.132).
 *
 * Par `annuler`, la porte canonique : même journal (`CLOSED`), même traitement des jalons, même
 * refus sur une mission terminée. Ce qui a déjà été fait reste fait. Compte les missions qui ont
 * CHANGÉ d'état — une mission déjà arrêtée ou terminée ne compte pas.
 */
export async function arreterMissionsDeDiagnostic(
  ownerId: string,
  ids: readonly (string | null)[],
): Promise<number> {
  let n = 0;
  for (const id of ids) {
    if (!id) continue;
    const r = await annuler(id, ownerId,
      "diagnostic terminé — mission de banc arrêtée pour ne pas être reprise par le battement").catch(sansBloquer("provider-smoke.arreterMissionsDeDiagnostic.annuler", null));
    if (r?.ok && r.vers === "CANCELLED" && r.depuis !== "CANCELLED") n += 1;
  }
  return n;
}
