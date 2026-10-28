import { prisma } from "@/lib/prisma";
import { PLANNER_PROMPT_VERSION } from "@/lib/missions/planner/plan";
import { prechargerCapacitesDynamiques } from "@/platform/in-process/skills";
import { assurerFormes } from "@/platform/in-process/missions/formes";
import { REFUS_JUGE, estReplanifiable, peutReplanifierMission, signatureDuRefus } from "@/lib/missions/runtime/replan";
import { lireInterrupteurMissions, phraseSuspension, type LecteurInterrupteur } from "@/lib/interrupteurs/missions";
import { peutPiloterMissionsAdam, REFUS_MISSIONS_ADAM } from "@/lib/rbac";
import { suspendreMissionHorsDroit } from "@/platform/in-process/missions/habilitation";
import { exigencesFermes, formatsLivrablesDemandes } from "@/lib/missions/planner/primitives";
import { trier } from "@/lib/missions/planner/triage";
import type { CurrentUser } from "@/lib/session";
import { compile } from "@/lib/missions/compiler/compile";
import { planifier, type ContextePlanification, type MetriquesPlanification } from "@/lib/missions/planner/plan";
import { materialiser, chargerEtat, journaliser, transitionner } from "@/lib/missions/runtime/store";
import { avancer, type EngineDeps, type StepContext, type StepOutcome } from "@/lib/missions/runtime/engine";
import { executerWorker } from "@/lib/missions/runtime/worker";
import { executerArtefact } from "@/lib/missions/artifacts/build";
import { controleComplet } from "@/lib/missions/goal/qa";
import { ancetres } from "@/lib/missions/compiler/graph";
import { JugeReel } from "@/lib/missions/goal/judge";
import { perimetre } from "@/lib/missions/approval/scope";
import { demanderApprobation, porteApprobation, reouvrirSiChange } from "@/lib/missions/approval/gate";
import { agentPour } from "@/lib/missions/agent/principal";
import { assurerCompteAgent } from "@/lib/missions/agent/account";
import { CONCURRENCE_PAR_ECHELLE } from "@/lib/missions/model/roles";
import type { CompileIssue } from "@/lib/missions/planner/contract";
import type { Reasoner } from "@/lib/missions/ports";
import type { ArtifactSink } from "@/lib/missions/artifacts/build";
import { acteurDe, catalogueDe } from "@/platform/in-process/missions/catalog";
import { raisonneur } from "@/platform/in-process/missions/reasoner";
import { withTurn, setTurnContext } from "@/lib/models/telemetry";
import { ExecutantReel } from "@/platform/in-process/missions/runner";
import { depotDrive } from "@/platform/in-process/missions/sink";
import { registreRecoursDe } from "@/platform/in-process/missions/recovery-registry";
import { enqueter, resumerSituation } from "@/platform/in-process/missions/situation";
import { porteAttentionPour } from "@/platform/in-process/missions/attention";
import { sansBloquer } from "@/lib/journal";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE COMPOSEUR — l'endroit, et le seul, où Adam et le Mission Runtime se rencontrent.
 *
 * ── POURQUOI UN COMPOSEUR PLUTÔT QUE DES BRANCHEMENTS ÉPARPILLÉS ────────────────────────
 *
 * Le runtime ne connaît ni les outils, ni les modèles, ni le Drive : il déclare des ports. Ces
 * ports doivent bien être remplis quelque part. S'ils l'étaient à trois endroits — la route
 * HTTP, l'ordonnanceur, le webhook — on aurait trois assemblages, dont deux finiraient par
 * différer : un gestionnaire oublié ici, un juge absent là. Et un juge absent, c'est une
 * mission qui ne conclut jamais ; un gestionnaire d'artefact absent, c'est un fichier qui
 * n'existe pas alors que l'écran dit qu'il est prêt.
 *
 * Il y a donc UNE fonction qui assemble, et tous les appelants passent par elle.
 *
 * ── CE QUI EST BRANCHÉ, ET CE QUE CHACUN APPORTE ────────────────────────────────────────
 *
 *   catalogue   ce que cette personne a le droit de faire — la même liste qu'en conversation ;
 *   exécutant   le chemin canonique d'écriture, avec RBAC, intent, reçu et idempotence ;
 *   raisonneur  la passerelle modèle, en sorties structurées strictes ;
 *   WORKER      un exécutant éphémère par étape de réflexion ;
 *   QA          le contrôle arithmétique — cardinalité, destinataires, reçus, doublons ;
 *   ARTIFACT    la fabrique de fichiers, contrôlés avant d'être rangés ;
 *   APPROVAL    la porte d'accord, fermée par défaut ;
 *   juge        celui sans qui la mission ne conclut PAS.
 *
 * Les gestionnaires d'attente (`WAIT_EVENT`, `WAIT_INPUT`) ne sont volontairement PAS branchés :
 * le comportement natif du moteur — attendre — est exactement le bon, et le routeur
 * d'événements réveille la mission de l'extérieur. Y mettre un gestionnaire qui « vérifie si
 * l'événement est arrivé » recréerait une scrutation là où il y a déjà une notification.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface AssemblageMission {
  deps: EngineDeps;
  juge: JugeReel;
}

export interface OptionsAssemblage {
  complexite?: "A" | "B" | "C";
  /** Le raisonneur. Par défaut le VRAI, qui appelle la passerelle modèle. */
  reasoner?: Reasoner;
  /** Où déposer les livrables. Par défaut le Drive. */
  sink?: ArtifactSink;
  /**
   * LECTURE SEULE — le catalogue est plafonné à `ANALYZE` (§ `OptionsCatalogue.effetMax`).
   *
   * Aucune capacité qui écrit, communique, engage ou détruit n'entre dans la liste que le
   * planner voit et que le compilateur consulte. Ce n'est donc pas une consigne donnée au
   * modèle — qu'un document lu en cours de route pourrait contredire — mais l'ABSENCE de
   * l'outil. Le diagnostic fournisseur s'en sert pour prouver la chaîne sans rien toucher.
   *
   * PORTÉE : les TROIS chemins qui construisent un catalogue — `lancerMission` (planification),
   * `assembler` (exécution) et `replanifierMission` (nouveau plan).
   *
   * Le troisième a d'abord été laissé de côté, au motif que le diagnostic ne replanifiait pas.
   * Le premier run réel l'a démenti : une mission qui n'atteint pas son objectif passe par la
   * replanification canonique, et sans plafond ce nouveau plan repartirait du catalogue COMPLET.
   * Le trou n'était pas théorique — il s'ouvrait exactement là où la mission a le plus de
   * latitude. Une garantie qui s'arrête au premier plan n'est pas une garantie.
   */
  lectureSeule?: boolean;
  /**
   * LE LECTEUR DE L'INTERRUPTEUR GLOBAL DES MISSIONS (§118.132) — défaut : le VRAI, la ligne
   * `AppSetting.global`. Un banc l'injecte pour éprouver la suspension sans poser l'interrupteur
   * réel, partagé par tous les tests qui tournent en parallèle. La production ne le pose
   * JAMAIS ; un test de point d'appel le vérifie.
   */
  interrupteur?: LecteurInterrupteur;
}

/**
 * ASSEMBLE LE MOTEUR POUR UNE PERSONNE.
 *
 * L'acteur est l'AGENT (`isAgent: true`) et non la personne : c'est ce qui active l'interdit
 * structurel d'auto-escalade (`policy/guard.ts`). La personne reste l'initiatrice, et ses
 * droits restent la borne — l'agent ne peut jamais faire PLUS qu'elle, seulement moins.
 */
export function assembler(user: CurrentUser, opts: OptionsAssemblage = {}): AssemblageMission {
  const catalogue = catalogueDe(user, opts.lectureSeule ? { effetMax: "ANALYZE" } : {});
  const runner = new ExecutantReel(user);
  // LE RAISONNEUR EST INJECTABLE, et le défaut est le VRAI. Ce n'est pas une couture pour les
  // tests : c'est la seule dépendance du composeur qui traverse le réseau, donc la seule qu'un
  // banc d'essai puisse vouloir remplacer sans rien changer d'autre. Tout le reste — catalogue,
  // exécutant, dépôt, moteur, contrôle, juge — reste celui de la production, y compris sous test.
  const cerveau = opts.reasoner ?? raisonneur;
  const juge = new JugeReel(cerveau, opts.complexite ?? "B");

  const deps: EngineDeps = {
    runner,
    catalog: catalogue,
    juge,
    // L'INTERRUPTEUR GLOBAL — le moteur le relit à chaque tour ; absent, il lit le vrai.
    ...(opts.interrupteur ? { interrupteur: opts.interrupteur } : {}),
    // CE QUI REND « ESSAIE AILLEURS » EXÉCUTABLE. Sans lui, le barreau `AUTRE_SOURCE` n'a
    // aucune capacité de remplacement à proposer et se saute — l'échelle descend alors vers ce
    // qui agit réellement, au lieu de rejouer le même appel sous un autre nom.
    registre: registreRecoursDe(user, opts.lectureSeule ? { effetMax: "ANALYZE" } : {}),
    // LA PORTE D'ATTENTION : c'est par elle que la conclusion, le blocage ou l'échec d'une
    // mission parviennent au dirigeant — niveau, cadence et canaux décidés par la politique.
    attention: porteAttentionPour(),
    handlers: {
      WORKER: (ctx) => executerWorker(ctx, { reasoner: cerveau }),
      QA: (ctx) => controleQualite(ctx),
      ARTIFACT: (ctx) => executerArtefact(ctx, { reasoner: cerveau, sink: opts.sink ?? depotDrive }),
      APPROVAL: porteApprobation(null, ""),
    },
  };
  return { deps, juge };
}

/**
 * LE NŒUD `QA` — arithmétique, bloquant, et qui NOMME ce qui cloche.
 *
 * Il rend `DONE` quand tout passe et `FAILED` sinon. Le `FAILED` est NON REJOUABLE à dessein :
 * relancer le contrôle sans avoir rien réparé donnerait le même résultat, et la mission
 * tournerait en rond en consommant ses tentatives. C'est la RÉPARATION des étapes manquantes
 * qui débloque, pas l'insistance sur le contrôle.
 */
async function controleQualite(ctx: StepContext): Promise<StepOutcome> {
  const etat = await chargerEtat(ctx.mission.id);
  if (!etat) return { status: "FAILED", error: "mission introuvable", errorKind: "INVALID_STEP", retryable: false };

  /**
   * LE NŒUD QA JUGE SES ANCÊTRES, PAS TOUTE LA MISSION.
   *
   * Il tourne AU MILIEU du graphe : ce qui vient après lui est PENDING par construction — y
   * compris les étapes qui dépendent de lui. Sans portée, il se reprochait son propre aval et
   * bloquait une mission dont tous les livrables étaient produits (mesuré : « 15/16 étapes
   * effectives abouties, 1 manquante » = « Informer Yacine », en aval du contrôle).
   *
   * Le contrôle de FIN de mission, lui, passe par `conclure` et regarde tout : c'est là que
   * « la mission est-elle finie ? » a un sens.
   */
  const portee = new Set([
    ...ancetres(etat.steps.map((s) => ({ key: s.key, dependsOn: s.dependsOn })), ctx.step.key),
    ctx.step.key,
  ]);
  const rapport = await controleComplet(etat, { portee });
  await journaliser(ctx.mission.id, "QA", rapport.resume, {
    stepKey: ctx.step.key,
    ok: rapport.ok,
    constats: rapport.constats.map((c) => ({ controle: c.controle, ok: c.ok, message: c.message })),
  });

  if (rapport.ok) return { status: "DONE", result: rapport };
  return {
    status: "FAILED",
    error: rapport.resume,
    errorKind: "QA_FAILED",
    retryable: false,
  };
}

export interface LancementOptions extends OptionsAssemblage {
  /** Le contexte que l'appelant connaît : contraintes, working set, mémoire, politiques. */
  contexte?: ContextePlanification;
  /** Un titre pour l'écran. Déduit de l'objectif s'il est absent. */
  titre?: string;
  /** Faire tourner la mission immédiatement après l'avoir créée. */
  demarrer?: boolean;
  /** Matérialiser DANS cette mission existante (le talon d'un lancement en arrière-plan). */
  missionId?: string;
  /** Sauter l'enquête (bancs qui mesurent le planificateur seul). Jamais en production. */
  sansEnquete?: boolean;
  /**
   * INTERDIT L'HORIZON — la mission sera compilée d'un seul plan, comme avant.
   *
   * Deux usages, et aucun n'est du confort : un banc qui mesure le planificateur monolithique,
   * et le PILOTE D'HORIZON lui-même, qui appelle `lancerMission` quand le découpage rend moins
   * de trois jalons. Sans ce drapeau, il se rappellerait indéfiniment.
   */
  sansHorizon?: boolean;
}

/**
 * UNE PANNE TRANSITOIRE DU FOURNISSEUR N'EST PAS UN REFUS. « HTTP 502 upstream request failed »,
 * un délai dépassé, une coupure réseau, une limite de débit : la demande était bonne, c'est le
 * réseau qui a lâché. La perdre — « la mission n'a PAS été lancée » — serait faire payer au
 * dirigeant une panne qu'il ne voit pas. On la classe pour la RETENIR au lieu de la refuser.
 */
export function estPanneTransitoire(message: string | null | undefined): boolean {
  if (!message) return false;
  return /\bHTTP (5\d\d|408|425|429)\b|upstream|timeout|timed out|d[ée]lai d[ée]pass[ée]|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|fetch failed|rate.?limit|overloaded|temporarily|indisponible|unavailable/i.test(message);
}

export type ResultatLancement =
  | {
      ok: true;
      missionId: string;
      titre: string;
      /** Le nombre d'étapes compilées — celles écrites, pas celles qui naîtront de l'éventail. */
      etapes: number;
      complexite: string;
      echelle: string;
      /** L'accord demandé, quand la mission produit des effets qui en exigent un. */
      approbation: { id: string; niveau: string; resume: string } | null;
      metriques: MetriquesPlanification;
      gaps: string[];
      /**
       * VRAI quand le fournisseur a lâché pendant la planification : la mission est ENREGISTRÉE
       * (talon PLANNING, le battement reprendra), pas encore planifiée. `etapes` vaut 0.
       */
      differe?: boolean;
    }
  | { ok: false; error: string; refus?: CompileIssue[]; metriques?: MetriquesPlanification };

export const titreDe = (objectif: string): string => {
  const t = objectif.replace(/\s+/g, " ").trim();
  return t.length <= 90 ? t : `${t.slice(0, 87)}…`;
};

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LANCER UNE MISSION DEPUIS UNE PHRASE — le chemin complet, sans plan écrit à la main.
 *
 *   texte → résolution des capacités → PLANNER (modèle) → COMPILATEUR → base → accord → moteur
 *
 * Le compilateur peut refuser. Dans ce cas on RENVOIE ses refus au planner, une fois : ils
 * nomment l'étape et la règle violée, ce qui est exactement ce dont un correcteur a besoin.
 * Une seule reprise — au-delà, le modèle ne corrige plus, il reformule, et l'on paie deux fois
 * pour découvrir la même chose.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
/**
 * CHAQUE ENTRÉE DU RUNTIME OUVRE UN TOUR MESURÉ (« background ») et le signe : personne, mission,
 * usage. C'est ce qui donne un coût PAR MISSION dans `ModelCallLog` — le planificateur, les
 * workers, le juge et l'artefact y rattachent leurs appels sans rien savoir de la base. Un tour
 * déjà ouvert (une mission lancée depuis la conversation) est REJOINT, et le contexte s'y ajoute.
 */
/**
 * LE RÔLE DE PLANIFICATION PEUT ÊTRE FORCÉ PAR L'EXPLOITATION (`ADAM_PLANNER_ROLE`) — pour
 * mesurer un modèle plus rapide sur le banc, jamais par confort. Absent : la politique des rôles.
 *
 * Il s'applique à TOUTES les planifications d'une mission — la première, la reprise après refus
 * du compilateur, la replanification. Mesuré : forcé sur la première seule, la reprise repartait
 * au rôle par défaut, dont l'appel dépassait la coupure du mandataire ; deux missions sur neuf
 * mouraient « non lancées » pour une raison qui n'avait rien à voir avec leur plan.
 */
function roleForcePlanification(): { role?: string } {
  const role = (process.env.ADAM_PLANNER_ROLE ?? "").trim();
  return role ? { role } : {};
}

/** La personne qui demande, telle que le planificateur doit la nommer pour lui écrire. */
const demandeurDe = (u: Pick<CurrentUser, "name" | "email">): string => (u.email ? `${u.name} <${u.email}>` : u.name);

export function lancerMission(
  user: CurrentUser,
  objectif: string,
  opts: LancementOptions = {},
): Promise<ResultatLancement> {
  /**
   * ── RÉSERVÉ AU SUPER ADMIN (§118.136) — la porte du MOTEUR, pas seulement de l'outil ────────
   *
   * `run_mission` n'est plus exposé aux autres, mais un outil filtré est une porte fermée à côté
   * d'une porte ouverte (§118.71) : ce qui garde le moteur pour tout appelant présent ou futur,
   * c'est cette ligne. Le refus vient AVANT toute télémétrie, tout modèle et toute écriture, et
   * il nomme la règle — le même prédicat que l'écran, le menu et les actions.
   */
  if (!peutPiloterMissionsAdam(user)) return Promise.resolve({ ok: false, error: REFUS_MISSIONS_ADAM });
  return withTurn("background", async () => {
    setTurnContext({ userId: user.id, feature: "mission" });
    /**
     * ── SOUS SUSPENSION GLOBALE, ON NE LANCE PAS (§118.132) ──────────────────────────────
     *
     * Enregistrer une mission que le moteur ne fera pas avancer, c'est payer une planification
     * pour une promesse qu'on ne tiendra pas — et laisser un talon PLANNING que le filet des
     * lancements perdus prendrait pour une panne. Le refus vient AVANT tout appel de modèle et
     * NOMME le geste qui le lève (§118.30). Le pilote d'horizon, qui rappelle `lancerMission`
     * pour un découpage trop court, s'arrête lui-même avant d'arriver ici.
     */
    const interrupteur = await (opts.interrupteur ?? lireInterrupteurMissions)();
    if (interrupteur.suspendues) return { ok: false, error: phraseSuspension(interrupteur) };
    await prechargerCapacitesDynamiques(user).catch(sansBloquer("missions-runtime.lancerMission.prechargerCapacitesDynamiques", 0));
    await assurerFormes();
    const parJalons = await tenterHorizon(user, objectif, opts);
    if (parJalons) return parJalons;
    return lancerMissionInterne(user, objectif, opts);
  });
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'HORIZON D'ABORD, QUAND LA DEMANDE EN A LA FORME (§118.40).
 *
 * ── LA PORTE, ET POURQUOI ELLE EST PURE ─────────────────────────────────────────────────
 *
 * `trier()` lit la demande sans modèle, sans base, sans réseau, et rend `COMPLEXE` sur
 * exactement les formes qui font les missions longues : plusieurs sources, un arbitrage ET un
 * enchaînement, une écriture répétée sur un éventail, ou quatre propositions et plus. C'est le
 * même triage qui ouvre déjà les budgets du planificateur — on ne fabrique pas un second
 * classement qui divergerait du premier.
 *
 * Cette porte ne décide PAS que la mission aura des jalons. Elle décide seulement qu'on paie le
 * découpage, qui coûte quelques centaines de jetons. C'est le DÉCOUPAGE qui tranche : moins de
 * trois jalons et l'on revient au chemin classique, sans qu'aucune structure inutile n'ait été
 * écrite en base.
 *
 * ── CE QUI SE PASSE QUAND ON DÉCOUPE ────────────────────────────────────────────────────
 *
 * On rend la main DÈS QUE la mission existe avec ses jalons, et le premier tour de frontière
 * tourne derrière. Une mission de trois semaines ne doit pas faire attendre la conversation :
 * ce qu'on lui promet, c'est qu'elle est enregistrée et qu'elle avance — pas qu'elle est finie.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
async function tenterHorizon(
  user: CurrentUser,
  objectif: string,
  opts: LancementOptions,
): Promise<ResultatLancement | null> {
  if (opts.sansHorizon) return null;
  if (trier(objectif).profil !== "COMPLEXE") return null;

  try {
    const { ouvrirHorizon, conduireHorizon } = await import("@/platform/in-process/missions/horizon");
    const h = await ouvrirHorizon(user, objectif, {
      missionId: opts.missionId, titre: opts.titre,
      reasoner: opts.reasoner, sansEnquete: opts.sansEnquete,
    });
    if (!h.ok || h.voie !== "HORIZON" || !h.missionId) return null;

    const missionId = h.missionId;
    setTurnContext({ missionId });
    if (opts.demarrer !== false) {
      // LE PREMIER TOUR DE FRONTIÈRE TOURNE DERRIÈRE : la conversation est rendue tout de suite.
      // Une erreur ici ne perd rien — la mission et ses jalons sont en base, et le battement
      // reprendra exactement où le tour s'est arrêté.
      setImmediate(() => {
        void conduireHorizon(user, missionId, opts).catch((e) => {
          console.error(`[missions] premier tour d'horizon de ${missionId} échoué`, e);
        });
      });
    }
    return {
      ok: true, missionId, titre: h.titre ?? titreDe(objectif),
      etapes: 0, complexite: "C", echelle: "XL", approbation: null,
      metriques: METRIQUES_HORIZON, gaps: [], differe: true,
    };
  } catch (e) {
    /**
     * L'HORIZON NE FAIT JAMAIS ÉCHOUER UN LANCEMENT.
     *
     * S'il ne peut pas découper — modèle indisponible, découpage incohérent deux fois —, on
     * revient au chemin classique, qui marchait avant lui. Une porte d'optimisation qui casse
     * le chemin nominal est une régression, pas une amélioration.
     */
    console.warn(`[missions] horizon indisponible, chemin classique : ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/** Le lancement par jalons ne PLANIFIE pas d'étapes : ses chiffres de plan sont donc nuls. */
const METRIQUES_HORIZON: MetriquesPlanification = {
  plannerCapabilitiesExposed: 0, plannerSchemaTokens: 0, plannerContextTokens: 0,
  plannerCatalogueChars: 0, capacitesAutorisees: 0, jetonsEvites: 0,
  domaines: [], role: "COMPLEX_PLANNER", latencyMs: 0,
  // `usage: null` = NON MESURÉ ICI, jamais zéro : les jetons du découpage sont écrits au journal
  // de la mission (`MILESTONES_PLANNED`), et ceux des sous-plans à chaque `MILESTONE_COMPILED`.
  usage: null, voie: "MODELE", profil: "COMPLEXE", refusDirect: null,
};

async function lancerMissionInterne(
  user: CurrentUser,
  objectif: string,
  opts: LancementOptions = {},
): Promise<ResultatLancement> {
  // L'ESPACE D'ADAM EXISTE AVANT SA PREMIÈRE MISSION, et se répare s'il a dérivé. Appelé ici
  // plutôt qu'au démarrage : c'est le seul point par lequel une mission commence, et une
  // réparation qui ne tourne qu'au démarrage ne corrige rien entre deux déploiements.
  const espace = await assurerCompteAgent();
  if (espace && espace.corrections.length > 0) {
    console.warn(`[agent] espace d'Adam réaligné : ${espace.corrections.join(" ; ")}`);
  }

  const catalogue = catalogueDe(user, opts.lectureSeule ? { effetMax: "ANALYZE" } : {});
  const acteur = acteurDe(user);
  const cerveau = opts.reasoner ?? raisonneur;
  // LES FORMES ÉPROUVÉES (§64) — une indication murmurée au planner, chargée ICI parce que
  // c'est le côté qui possède la base. Une liste vide est la réponse normale d'un système jeune.
  const formesValidees = opts.contexte?.formesValidees
    ?? await import("@/lib/missions/planner/patterns").then((m) => m.indicesDeFormes()).catch(sansBloquer("missions-runtime.lancerMissionInterne", []));
  // ── L'ENQUÊTE AVANT LE PLAN ─────────────────────────────────────────────────────────────
  //
  // Le code établit la situation (entités reconnues, fiches, changements, documents, engagements)
  // avec les droits de la personne, et le planificateur planifie à partir de faits. Sous délai :
  // une enquête qui traîne rend ce qu'elle a, et une enquête qui échoue rend `null` — le plan
  // part alors comme avant, et le journal le dit.
  const situation = opts.sansEnquete || opts.contexte?.situation
    ? opts.contexte?.situation ?? null
    : await enqueter(user, objectif).catch(sansBloquer("missions-runtime.lancerMissionInterne.enqueter", null));
  // ── LES RÈGLES ENSEIGNÉES (Teach Adam, §119) ────────────────────────────────────────
  //
  // Ce que la personne et sa société ont appris à Adam entre DANS le contexte du planificateur
  // (`politiques`), avec ce que l'appelant savait déjà. Composé par le code, sous budget, jamais
  // accumulé : la même règle ne s'y répète pas d'un plan à l'autre.
  const politiquesEnseignees = await import("@/platform/in-process/teach/store")
    .then((m) => m.politiquesPourMission(user.id))
    .catch(sansBloquer("missions-runtime.lancerMissionInterne", [] as string[]));
  const contexte: ContextePlanification = {
    aujourdhui: new Date().toLocaleDateString("fr-FR"),
    ...opts.contexte,
    ...(situation ? { situation } : {}),
    ...(formesValidees.length > 0 ? { formesValidees } : {}),
    ...(politiquesEnseignees.length > 0 || opts.contexte?.politiques?.length
      ? { politiques: [...(opts.contexte?.politiques ?? []), ...politiquesEnseignees.filter((p) => !(opts.contexte?.politiques ?? []).includes(p))] }
      : {}),
    demandeur: demandeurDe(user),
  };

  let plan = await planifier(objectif, catalogue, acteur, cerveau, {
    ...roleForcePlanification(),
    contexte,
    // LE RETRIEVAL SPÉCULATIF (§65) : pendant que le modèle planifie (des secondes), on
    // préchauffe l'annuaire sur les noms propres de l'objectif — des LECTURES, dont le résultat
    // est jeté : le gain est le cache de Postgres et le pool déjà chauds quand la première
    // étape de la mission lit pour de vrai. Ne retient jamais le plan (course, pas jointure).
    speculation: async (but) => {
      const debut = Date.now();
      const noms = [...new Set(
        (but.match(/\b[A-ZÀ-Ý][a-zà-ÿ]{2,}\b/g) ?? [])
          .filter((n) => !["Les", "Une", "Des", "Adam", "Envoie", "Fais", "Puis", "Pour", "Avec", "Dans", "Chaque"].includes(n))
          .slice(0, 4),
      )];
      if (noms.length === 0) return [];
      const lectures = await Promise.all(noms.map(async (nom) => {
        const t0 = Date.now();
        await prisma.user.findMany({
          where: { isActive: true, name: { contains: nom, mode: "insensitive" } },
          select: { id: true },
          take: 3,
        }).catch(sansBloquer("missions-runtime.speculation.user", []));
        return { libelle: `annuaire:${nom}`, ms: Date.now() - t0 };
      }));
      return [{ libelle: `total:${noms.length} noms`, ms: Date.now() - debut }, ...lectures];
    },
  });
  if (!plan.ok) {
    // ── LE REPLI : UNE PANNE TRANSITOIRE RETIENT LA DEMANDE AU LIEU DE LA PERDRE ────────
    //
    // Sans talon déjà écrit (lancement direct), on en écrit un : la mission existe en base dès
    // maintenant, PLANNING sans étape, et le battement la reprendra comme un lancement détaché
    // (`rattraperLancementsPerdus`). Avec un talon (finalisation différée), l'appelant décide.
    if (!opts.missionId && estPanneTransitoire(plan.error)) {
      const titre = opts.titre ?? titreDe(objectif);
      const talon = await creerTalon(user, objectif, titre);
      if (talon) {
        await journaliser(talon, "PLANNING_DEFERRED",
          `Le fournisseur de modèle a lâché pendant la planification (${plan.error.slice(0, 120)}) : la demande est retenue, la planification reprendra au prochain battement.`,
          { transitoire: true });
        return {
          ok: true, missionId: talon, titre, etapes: 0,
          complexite: "?", echelle: "?", approbation: null, metriques: plan.metriques, gaps: [], differe: true,
        };
      }
    }
    return { ok: false, error: plan.error, metriques: plan.metriques };
  }

  // L'ACTEUR DE COMPILATION EST L'AGENT : c'est lui qui exécutera, donc c'est SA politique qui
  // doit refuser une étape d'auto-escalade. Compiler sous l'identité humaine laisserait passer
  // une étape que l'agent n'a pas le droit d'exécuter, et l'échec arriverait à l'exécution.
  const agent = agentPour({ initiatedBy: user.id, executedBy: user.id, label: user.name });
  /**
   * LE PLAFOND SUIT LA MISSION JUSQU'AU COMPILATEUR.
   *
   * `lectureSeule` plafonnait le CATALOGUE, donc les capacités — et rien d'autre. Un nœud
   * ARTIFACT, qui n'a pas de capacité, passait au travers et écrivait un fichier dans le Drive
   * pendant que le rapport annonçait « lecture seule ». Le plafond porte maintenant sur l'effet
   * de l'étape, quelle que soit sa nature.
   */
  const plafond = {
    ...(opts.lectureSeule ? { effetMax: "ANALYZE" as const } : {}),
    // CE QUE LA DEMANDE EXIGE (§56) — lu dans la phrase par le code, jamais déclaré par le
    // modèle : la déclaration serait faite par la partie qu'elle doit contraindre.
    primitivesRequises: exigencesFermes(objectif),
    // COMBIEN de pièces, pas seulement « une pièce » : « un Excel ET un PowerPoint » = deux.
    formatsLivrables: formatsLivrablesDemandes(objectif),
  };
  let compile1 = compile(plan.plan, catalogue, agent, plafond);

  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   * ON NE S'ARRÊTE PAS À LA PREMIÈRE DIFFICULTÉ — MAIS ON NE TOURNE PAS EN ROND (§118.9).
   *
   * Il y avait exactement DEUX essais : plan, refus, correction, refus, mort. MESURÉ sur la
   * chaîne humaine live : le premier plan est refusé sur la forme de ses attentes, le
   * planificateur corrige CORRECTEMENT, et le second refus porte sur autre chose. Le modèle
   * progressait à chaque tour ; c'est le compteur qui a rendu l'arrêt. Une mission légitime
   * — collecter auprès de trois personnes puis produire un classeur et un deck — est morte
   * avant d'exister.
   *
   * LE CRITÈRE N'EST DONC PAS UN NOMBRE D'ESSAIS, C'EST LE PROGRÈS. Tant que le refus CHANGE,
   * le planificateur répare quelque chose et mérite un tour de plus. Dès qu'il REVIENT
   * identique, il est bloqué : un tour supplémentaire ne produira que la même réponse, plus
   * chère. Le plafond, lui, reste opérationnel (§118.2) : il borne le coût, il ne définit pas
   * la persévérance.
   *
   * ET LA PERSÉVÉRANCE N'AUTORISE RIEN. Chaque tour repasse par le MÊME compilateur, sous la
   * même politique et le même acteur. On ne relâche aucune règle pour finir par accepter.
   * ═══════════════════════════════════════════════════════════════════════════════════════
   */
  const CORRECTIONS_MAX = 3;
  /**
   * LA SIGNATURE D'UN REFUS PORTE SES CODES, PAS SES CLÉS D'ÉTAPE.
   *
   * Un planificateur qui reprend son plan renomme presque toujours ses clés. Signer
   * `code@étape` aurait donc rendu chaque refus « nouveau » et le détecteur de répétition ne
   * se serait jamais déclenché : on aurait payé les trois corrections à chaque fois, y compris
   * face à un mur. Ce qui dit « c'est le même mur », c'est l'ensemble des CODES.
   */
  const signature = (issues: readonly { code: string }[]): string =>
    [...new Set(issues.map((i) => i.code))].sort().join("|");
  const refusVus = new Set<string>();
  let corrections = 0;
  let repetition = false;

  while (!compile1.ok && corrections < CORRECTIONS_MAX) {
    const sig = signature(compile1.issues);
    if (refusVus.has(sig)) { repetition = true; break; }
    refusVus.add(sig);
    corrections += 1;

    const essai = await planifier(objectif, catalogue, acteur, cerveau, {
      ...roleForcePlanification(),
      contexte: { ...contexte, refusPrecedent: compile1.issues.map((i) => `[${i.code}] ${i.stepKey ?? "plan"} : ${i.message}`) },
    });
    if (!essai.ok) {
      return { ok: false, error: essai.error, refus: compile1.issues, metriques: essai.metriques };
    }
    plan = essai;
    compile1 = compile(plan.plan, catalogue, agent, plafond);
  }

  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   * UNE EXIGENCE DÉDUITE D'UN MOT NE DOIT PAS TUER UNE MISSION (§63 du mandat).
   *
   * ── LE CAS, REPRODUIT EN DIRECT ─────────────────────────────────────────────────────
   *
   *   « Sors-moi, pour chaque contrat en cours, la date d'échéance, la clause de
   *     renouvellement et la pénalité de retard. UN TABLEAU, et dis-moi combien de contrats
   *     n'ont pas ces informations. »
   *
   * `exigencesFermes` y lit une pièce (« tableau » + verbe de production) et exige DOCUMENT.
   * Le planificateur, lui, comprend un TABLEAU À L'ÉCRAN — ce qui est une lecture au moins
   * aussi juste — et n'écrit pas d'étape ARTIFACT. Le compilateur refuse, le planificateur
   * refait le même plan, et la mission meurt sans avoir rien livré. Zéro valeur rendue sur une
   * demande parfaitement réalisable : le « je ne peux pas » artificiel, dans sa forme la plus
   * coûteuse.
   *
   * ── CE QUI EST FAIT, ET CE QUI N'EST PAS FAIT ───────────────────────────────────────
   *
   * On ne devine PAS le livrable à la place du modèle (§104.5) : ajouter une étape ARTIFACT
   * d'un format inventé serait pire. On ne baisse pas non plus l'exigence en silence, ce qui
   * ramènerait le défaut que §56 existe pour corriger.
   *
   * On distingue la nature des reproches. Une faute STRUCTURELLE — cycle, capacité inventée,
   * référence morte, cardinalité fausse — reste mortelle : le plan est faux, l'exécuter ne
   * produirait rien de bon. Une exigence de COUVERTURE déduite d'un mot de la phrase est d'une
   * autre espèce : le plan est exécutable, il livre peut-être moins que ce que le mot laissait
   * entendre. Dans ce seul cas, la mission part — et la lacune est DÉCLARÉE, journalisée, et
   * remise au dirigeant avec le résultat. Il lit « voici le tableau à l'écran, je n'ai pas
   * produit de fichier », au lieu de ne rien lire du tout.
   * ═══════════════════════════════════════════════════════════════════════════════════════
   */
  const COUVERTURE = new Set(["MISSING_PRIMITIVE"]);
  let lacunesDeCouverture: string[] = [];
  if (!compile1.ok && compile1.issues.every((i) => COUVERTURE.has(i.code))) {
    const sansExigence = compile(plan.plan, catalogue, agent, { ...plafond, primitivesRequises: [], formatsLivrables: [] });
    if (sansExigence.ok) {
      lacunesDeCouverture = compile1.issues.map((i) => i.message);
      compile1 = sansExigence;
    }
  }

  if (!compile1.ok) {
    const pourquoi = repetition
      ? `le planificateur bute deux fois sur le même refus après ${corrections} correction(s)`
      : `le plan reste refusé après ${corrections} correction(s)`;
    return {
      ok: false,
      error: `${pourquoi} : ${compile1.issues.map((i) => i.message).join(" ; ")}`,
      refus: compile1.issues,
      metriques: plan.metriques,
    };
  }

  const mission = compile1.mission;
  // AVANT LA MATÉRIALISATION : la lacune voyage avec le plan, elle n'est pas un commentaire.
  for (const l of lacunesDeCouverture) mission.gaps.push(l);
  const titre = opts.titre ?? titreDe(mission.objective || objectif);
  const missionId = await materialiser(mission, {
    ownerId: user.id,
    title: titre,
    goalRaw: objectif,
    // L'OBSERVABILITÉ (§33) : quelle version de consigne a planifié, quelles règles enseignées elle a lues.
    planMetaExtra: { promptVersion: PLANNER_PROMPT_VERSION, politiques: contexte.politiques ?? [] },
    maxConcurrency: CONCURRENCE_PAR_ECHELLE[mission.scale],
    ...(opts.missionId ? { missionId: opts.missionId } : {}),
  });
  setTurnContext({ missionId });
  // LA LACUNE EST DITE AU JOURNAL — elle est déjà dans `mission.gaps`, donc persistée avec le
  // plan et remontée à l'appelant : le dirigeant la lit avec le résultat, pas à la place.
  for (const l of lacunesDeCouverture) {
    await journaliser(missionId, "GAP_DECLARED",
      `Le plan part sans satisfaire une exigence lue dans la demande : ${l} `
      + `La mission s'exécute et livre ce qu'elle peut ; ce point-là reste ouvert.`,
      { lacune: "COUVERTURE" });
  }
  if (situation) {
    await journaliser(missionId, "INVESTIGATED", resumerSituation(situation), {
      entites: situation.entites.slice(0, 8).map((e) => `${e.type}:${e.label}`),
      faits: situation.faits.length,
      domaines: situation.domaines,
      sources: situation.couverture.sources,
      enEchec: situation.couverture.enEchec,
      ms: situation.couverture.ms,
    });
  }
  await journaliser(missionId, "CREATED",
    `Mission planifiée : ${mission.steps.length} étapes, complexité ${mission.complexity}, échelle ${mission.scale}.`,
    {
      // LE COÛT DE LA PLANIFICATION SUIT LA MISSION : l'appel est parti avant que la mission ait
      // un identifiant, il ne porte donc pas le sien dans le journal des appels. Ses jetons sont
      // écrits ici, là où le banc et l'écran les relisent.
      usage: plan.metriques.usage,
      voie: plan.metriques.voie,
      enquete: situation ? { faits: situation.faits.length, ms: situation.couverture.ms } : null,
      capacitesMontrees: plan.metriques.plannerCapabilitiesExposed,
      capacitesOuvertes: plan.metriques.capacitesAutorisees,
      domaines: plan.metriques.domaines,
      role: plan.metriques.role,
      latencyMs: plan.metriques.latencyMs,
      gaps: mission.gaps,
      // §64 : combien de FORMES ÉPROUVÉES ont été murmurées au planner pour CE plan — le
      // chiffre qui rend « les patterns influencent » vérifiable au journal, mission par mission.
      formesProposees: formesValidees.length,
    });

  // ── L'ACCORD (§32-33) — un pour un lot cohérent, jamais quatre-vingt-dix-neuf ─────────
  const p = perimetre(mission);
  let approbation: { id: string; niveau: string; resume: string } | null = null;
  if (p) {
    const id = await demanderApprobation(missionId, p, user.id, titre);
    approbation = { id, niveau: p.niveau, resume: p.resume };
    await porteAttentionPour().signaler({
      kind: "APPROVAL_REQUIRED", missionId, ownerId: user.id, titre, raison: p.resume,
      niveauApprobation: p.niveau, stepKey: "accord", planVersion: 1,
    }).catch(sansBloquer("missions-runtime.lancerMissionInterne.signaler"));
  }

  let etapes = mission.steps.length;
  if (opts.demarrer !== false) {
    const tour = await avancerMission(user, missionId, { ...opts, complexite: mission.complexity });
    const etat = tour?.status ?? null;

    /**
     * ── L'ESCALADE DU CHEMIN DIRECT — ce qui rend son erreur inoffensive ──────────────
     *
     * Le chemin direct PROPOSE une lecture sans payer de planificateur. Il se trompe rarement,
     * mais il se trompe : la capacité dominante peut ne pas être celle qui répond. La garde
     * n'est pas un réglage de seuil, c'est le JUGE — le même que pour tout autre plan.
     *
     * S'il refuse de conclure, on replanifie SUR-LE-CHAMP avec le modèle, sans attendre un
     * battement d'ordonnanceur ni un clic. La personne qui a posé la question ne doit pas payer
     * la tentative en délai : le pari du chemin court se solde dans la même requête.
     *
     * Coût d'une erreur : une lecture de trop. Coût d'une réussite : la planification entière
     * économisée — 79 % du temps mesuré. C'est cette asymétrie qui autorise le pari.
     */
    if (plan.metriques.voie === "DIRECTE" && (etat === "BLOCKED" || etat === "PARTIAL" || etat === "FAILED")) {
      await journaliser(missionId, "REPLANNED",
        "Le chemin direct n'a pas satisfait l'objectif : reprise par le planificateur complet.",
        { voie: "DIRECTE", etatAtteint: etat });
      const reprise = await replanifierMission(user, missionId, opts);
      if (reprise.replanifie) {
        etapes = reprise.etapes ?? etapes;
        await avancerMission(user, missionId, { ...opts, complexite: mission.complexity });
      }
    }
  }

  return {
    ok: true,
    missionId,
    titre,
    etapes,
    complexite: mission.complexity,
    echelle: mission.scale,
    approbation,
    metriques: plan.metriques,
    gaps: mission.gaps,
  };
}

/**
 * LANCE UNE MISSION EN ARRIÈRE-PLAN — la conversation est LIBÉRÉE en dessous de la seconde.
 *
 * ── LE CONTRAT (§12-13) ──────────────────────────────────────────────────────────────────
 *
 * « Fais ça de côté, parlons d'autre chose. » La personne ne doit pas payer la planification
 * en délai de conversation. Le TALON de mission est écrit EN BASE d'abord (statut PLANNING,
 * l'objectif mot pour mot), la main est rendue avec l'identifiant, puis la planification et le
 * premier tour tournent hors requête.
 *
 * ── POURQUOI LE TALON D'ABORD, ET PAS UN simple `setImmediate` ──────────────────────────
 *
 * Parce qu'un `setImmediate` sans trace meurt avec le processus : un déploiement entre la
 * promesse (« je m'en occupe ») et la planification perdrait la demande — la pire des pannes,
 * celle dont personne ne s'aperçoit. Avec le talon, le battement retrouve toute mission
 * PLANNING sans étapes et RELANCE la planification (`rattraperLancementsPerdus`) : la
 * durabilité est dans la base, jamais dans la mémoire du processus.
 */
/** LE TALON : la mission existe en base, PLANNING sans étape — la demande est retenue. */
async function creerTalon(user: CurrentUser, objectif: string, titre: string): Promise<string | null> {
  try {
    const stub = await prisma.mission.create({
      data: {
        kind: "RUNTIME",
        status: "PLANNING",
        title: titre,
        objective: objectif,
        goalRaw: objectif,
        ownerId: user.id,
        // 0 : la matérialisation qui suit incrémente à 1 — le premier plan reste « plan 1 ».
        planVersion: 0,
      },
      select: { id: true },
    });
    return stub.id;
  } catch {
    return null;
  }
}

export async function lancerEnArrierePlan(
  user: CurrentUser,
  objectif: string,
  opts: LancementOptions = {},
): Promise<{ ok: true; missionId: string; titre: string } | { ok: false; error: string }> {
  // La même porte que `lancerMission` (§118.136) : un talon n'est pas écrit pour quelqu'un qui n'y a pas droit.
  if (!peutPiloterMissionsAdam(user)) return { ok: false, error: REFUS_MISSIONS_ADAM };
  try {
    const titre = opts.titre ?? titreDe(objectif);
    const id = await creerTalon(user, objectif, titre);
    if (!id) return { ok: false, error: "la mission n'a pas pu être enregistrée" };
    const stub = { id };
    await journaliser(stub.id, "DETACHED",
      "Mission enregistrée : la planification et l'exécution continuent en arrière-plan.",
      { objectif: objectif.slice(0, 300) });

    setImmediate(() => {
      void finaliserLancementDifere(stub.id, user, objectif, opts).catch((e) => {
        console.error(`[missions] finalisation différée de ${stub.id} échouée`, e);
      });
    });

    return { ok: true, missionId: stub.id, titre };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * PLANIFIE ET DÉMARRE une mission-talon — le second temps du lancement détaché, et le chemin
 * de RATTRAPAGE après un crash. Idempotent par construction : si le talon porte déjà des
 * étapes (une autre instance a fini le travail), il n'y a rien à faire.
 */
export async function finaliserLancementDifere(
  missionId: string,
  user: CurrentUser,
  objectif: string,
  opts: LancementOptions = {},
): Promise<{ finalise: boolean; raison?: string }> {
  const etapes = await prisma.missionStep.count({ where: { missionId } });
  if (etapes > 0) return { finalise: false, raison: "déjà matérialisée" };
  const mission = await prisma.mission.findUnique({
    where: { id: missionId }, select: { status: true },
  });
  if (!mission || mission.status === "CANCELLED" || mission.status === "FAILED") {
    return { finalise: false, raison: "mission close" };
  }

  const r = await lancerMission(user, objectif, { ...opts, missionId });
  if (!r.ok) {
    // UNE PANNE TRANSITOIRE NE CLÔT PAS LA MISSION : le talon reste PLANNING, le journal dit
    // pourquoi, et `rattraperLancementsPerdus` reprendra (trois tentatives au plus, espacées
    // par le battement). Seul un refus DURABLE — plan irrecevable, aucun fournisseur — passe
    // FAILED : la personne voit « la planification a échoué », pas une carte qui tourne pour
    // toujours.
    if (estPanneTransitoire(r.error)) {
      await journaliser(missionId, "PLANNING_DEFERRED",
        `Le fournisseur de modèle a lâché pendant la planification (${r.error.slice(0, 120)}) : nouvelle tentative au prochain battement.`,
        { transitoire: true });
      return { finalise: false, raison: r.error };
    }
    // LA PANNE EST DITE, JAMAIS SILENCIEUSE : la mission passe FAILED avec le motif — la
    // personne voit « la planification a échoué », pas une carte qui tourne pour toujours.
    await prisma.mission.update({
      where: { id: missionId },
      data: { status: "FAILED" },
    }).catch(sansBloquer("missions-runtime.finaliserLancementDifere.mission"));
    await journaliser(missionId, "PLANNING_FAILED",
      `La planification en arrière-plan a échoué : ${r.error}`, {});
    return { finalise: false, raison: r.error };
  }
  return { finalise: true };
}

/**
 * RATTRAPE LES LANCEMENTS PERDUS — le filet du talon (§5 durabilité).
 *
 * Une mission PLANNING sans étape ET sans activité récente est un lancement dont le processus
 * est mort entre la promesse et la planification. Le battement la retrouve et RELANCE — au
 * plus deux reprises (comptées au journal), sinon FAILED avec le motif : relancer sans fin une
 * planification qui meurt à chaque fois serait une boucle, pas de la persévérance.
 *
 * ── « ZÉRO ÉTAPE » EST L'ÉTAT NORMAL D'UNE MISSION LONGUE (§118.46, SECOND LECTEUR) ─────
 *
 * Mesuré sur la chaîne humaine, deux runs de suite : la mission est découpée en cinq jalons
 * (`MILESTONES_PLANNED`), l'enquête tourne — et le filet la déclare PERDUE, parce qu'un jalon
 * qui n'a pas encore été atteint par la frontière n'a PAS d'étapes. C'est exactement ce que
 * §118.40 exige : « le plan du jalon N est écrit quand le jalon N-1 a produit ses résultats,
 * pas avant ». Le filet relançait donc TOUTE la planification — jalons + enquête, payés à
 * chaque fois — trois fois, puis fermait en `PLANNING_FAILED` une mission parfaitement saine.
 * Verdict du banc : « FOURNISSEUR INDISPONIBLE : la mission n'a jamais reçu de plan », sur un
 * fournisseur qui répondait (`PRÊT`, 1,8 s, mesuré une minute plus tard).
 *
 * §118.46 avait appris cette leçon à la requête du BATTEMENT ; ce second lecteur gardait
 * l'ancienne hypothèse. Le fait à lire est le même et il est dans la base : **une mission qui
 * a des JALONS a été planifiée.** Ses étapes viennent plus tard, du pilote d'horizon
 * (`conduireHorizon` compile la frontière, §118.40) — et ce pilote la reprend précisément
 * parce qu'elle est en PLANNING. Le filet reste ARMÉ sur le vrai cas : un talon sans jalons ET
 * sans étapes est bien un lancement mort.
 */
export async function rattraperLancementsPerdus(
  chargerProprietaire: (userId: string) => Promise<CurrentUser | null>,
  opts: { plusVieuxQueMs?: number; limite?: number } = {},
): Promise<number> {
  const seuil = new Date(Date.now() - (opts.plusVieuxQueMs ?? 2 * 60_000));
  const talons = await prisma.mission.findMany({
    where: {
      kind: "RUNTIME", status: "PLANNING", updatedAt: { lt: seuil },
      steps: { none: {} },
      // Un jalon PROUVE que la planification a abouti : les étapes viennent de la frontière.
      milestones2: { none: {} },
    },
    select: { id: true, ownerId: true, goalRaw: true },
    take: opts.limite ?? 5,
    orderBy: { updatedAt: "asc" },
  });

  let repris = 0;
  for (const talon of talons) {
    if (!talon.goalRaw) continue;
    const reprises = await prisma.missionEvent.count({
      where: { missionId: talon.id, kind: "PLANNING_RETRY" },
    });
    if (reprises >= 2) {
      await prisma.mission.update({ where: { id: talon.id }, data: { status: "FAILED" } }).catch(sansBloquer("missions-runtime.rattraperLancementsPerdus.mission"));
      await journaliser(talon.id, "PLANNING_FAILED",
        "Trois lancements ont été tentés sans qu'aucun n'aboutisse — la mission est close, le motif est au journal.", {});
      continue;
    }
    const user = await chargerProprietaire(talon.ownerId);
    if (!user) continue;
    // Un talon dont le propriétaire n'a pas (ou plus) le droit aux missions n'est pas replanifié :
    // il est SUSPENDU, motif au journal (§118.136) — la même relecture d'autorité que le battement.
    if (!peutPiloterMissionsAdam(user)) { await suspendreMissionHorsDroit(talon.id, talon.ownerId); continue; }
    await journaliser(talon.id, "PLANNING_RETRY",
      "Lancement retrouvé sans plan : la planification reprend (le processus qui la portait s'est arrêté).", {});
    const f = await finaliserLancementDifere(talon.id, user, talon.goalRaw, {});
    if (f.finalise) repris += 1;
  }
  return repris;
}

/**
 * FAIT AVANCER UNE MISSION — le point d'entrée de l'ordonnanceur, du routeur d'événements,
 * de l'écran et de la conversation.
 *
 * Réentrant : deux appels concurrents se disputent les étapes par réservation en base. C'est ce
 * qui permet à l'ordonnanceur et à l'utilisateur de cliquer en même temps sans dommage.
 */
export function avancerMission(
  user: CurrentUser,
  missionId: string,
  opts: OptionsAssemblage & { maxTours?: number } = {},
) {
  return withTurn("background", async () => {
    setTurnContext({ userId: user.id, missionId, feature: "mission" });
    await prechargerCapacitesDynamiques(user).catch(sansBloquer("missions-runtime.avancerMission.prechargerCapacitesDynamiques", 0));
    await assurerFormes();
    return avancerMissionInterne(user, missionId, opts);
  });
}

async function avancerMissionInterne(
  user: CurrentUser,
  missionId: string,
  opts: OptionsAssemblage & { maxTours?: number } = {},
) {
  const proprietaire = await prisma.mission.findFirst({
    where: { id: missionId, ownerId: user.id },
    select: { id: true, complexity: true },
  });
  // LE CLOISONNEMENT EST ICI, PAS PLUS LOIN : une mission qui n'appartient pas à la personne
  // n'avance pas, quels que soient ses droits par ailleurs. La mission porte les droits de son
  // propriétaire ; la faire avancer sous quelqu'un d'autre les emprunterait.
  if (!proprietaire) return null;

  const { deps } = assembler(user, {
    ...opts,
    complexite: opts.complexite ?? (proprietaire.complexity as "A" | "B" | "C" | null) ?? "B",
  });
  const agent = agentPour({ initiatedBy: user.id, executedBy: user.id, label: user.name });
  const res = await avancer(missionId, agent, { ...deps, maxTours: opts.maxTours });
  // ── UNE QUESTION AU DIRIGEANT SE POSE, ELLE NE S'ATTEND PAS EN SILENCE ─────────────────
  //
  // Une étape WAIT_INPUT met la mission en WAITING_INPUT ; avant ce crochet, personne n'était
  // prévenu — la mission dormait jusqu'à ce que quelqu'un ouvre l'écran. La porte d'attention
  // classe la question en ARBITRAGE et ne la redemande pas d'elle-même (cadence infinie).
  if (res.status === "WAITING_INPUT") {
    const q = await prisma.missionStep.findFirst({
      where: { missionId, status: "WAITING", nodeType: "WAIT_INPUT" },
      select: { key: true, title: true, waitFor: true },
      orderBy: { updatedAt: "desc" },
    }).catch(sansBloquer("missions-runtime.avancerMissionInterne.missionStep", null));
    if (q) {
      const ask = (q.waitFor as { ask?: unknown } | null)?.ask;
      const m = await prisma.mission.findUnique({ where: { id: missionId }, select: { title: true, planVersion: true } }).catch(sansBloquer("missions-runtime.avancerMissionInterne.mission", null));
      await porteAttentionPour().signaler({
        kind: "QUESTION", missionId, ownerId: user.id, titre: m?.title ?? "",
        raison: typeof ask === "string" && ask.trim() ? ask : `« ${q.title} » attend un élément de votre part.`,
        decision: "répondre depuis l'écran de la mission", stepKey: q.key, planVersion: m?.planVersion ?? null,
      }).catch(sansBloquer("missions-runtime.avancerMissionInterne.signaler"));
    }
  }
  return res;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA REPLANIFICATION (§39-40) — un échec n'est pas une fin, et un nouveau plan n'est pas un
 * chèque en blanc.
 *
 * ── QUAND ELLE SE DÉCLENCHE ─────────────────────────────────────────────────────────────
 *
 * Quand la mission est BLOQUÉE ou EN ÉCHEC et qu'il reste au moins une étape non aboutie dont
 * les tentatives sont épuisées. Autrement dit : le moteur a fait tout ce qu'il savait faire —
 * réessayer, réparer — et il n'y arrive pas. Replanifier AVANT cela reviendrait à jeter un plan
 * qui marchait pour un incident passager.
 *
 * ── CE QUI EST DONNÉ AU PLANIFICATEUR, ET CE QUI NE L'EST PAS ──────────────────────────
 *
 * On lui donne l'objectif d'origine MOT POUR MOT, ce qui a DÉJÀ abouti (pour qu'il ne le
 * redemande pas) et ce qui a échoué AVEC son motif. On ne lui donne pas l'ancien plan : le lui
 * remettre sous les yeux le pousserait à le reproduire, alors que c'est précisément ce plan-là
 * qui n'a pas marché.
 *
 * ── LA GARANTIE QUI COMPTE LE PLUS ─────────────────────────────────────────────────────
 *
 * Un nouveau plan porte des étapes que personne n'a autorisées. `reouvrirSiChange` compare le
 * périmètre au dernier accord donné et ROUVRE la partie non couverte — elle seule (§8). Sans
 * cette ligne, un replan serait une porte dérobée : il suffirait qu'une étape échoue pour que
 * la mission se réécrive et parte sur un accord qui portait sur autre chose.
 *
 * ── CE QU'ELLE NE FAIT PAS ─────────────────────────────────────────────────────────────
 *
 * Elle ne touche à AUCUNE étape terminée. `materialiser` est ré-entrante et n'écrase pas une
 * étape `DONE` ; une clé qui disparaît du nouveau plan garde son historique. C'est ce qui
 * permet de dire « ceci a été fait sous le plan 1 » au lieu de laisser croire que le plan
 * actuel a tout produit.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export interface ResultatReplanification {
  replanifie: boolean;
  raison: string;
  planVersion?: number;
  etapes?: number;
  /** Ce que le changement de plan a rouvert à l'accord — vide quand rien n'a bougé. */
  rouvertes?: string[];
}

// Les deux constantes vivent dans `lib/missions/runtime/replan.ts` : le BATTEMENT en a besoin
// pour sa requête de sélection, et il ne peut pas importer ce fichier-ci.

export function replanifierMission(
  user: CurrentUser,
  missionId: string,
  opts: OptionsAssemblage = {},
): Promise<ResultatReplanification> {
  return withTurn("background", async () => {
    setTurnContext({ userId: user.id, missionId, feature: "mission" });
    await prechargerCapacitesDynamiques(user).catch(sansBloquer("missions-runtime.replanifierMission.prechargerCapacitesDynamiques", 0));
    await assurerFormes();
    return replanifierMissionInterne(user, missionId, opts);
  });
}

/**
 * CE QUE LE JUGE A REPROCHÉ AU PLAN PRÉCÉDENT — en français, prêt pour le planificateur.
 *
 * Trois sources, toutes déjà écrites, aucune jusqu'ici transmise : le verdict (`goalVerdict`),
 * le recours que le juge a suggéré (`recoursSuggere`, journalisé), et les manques arithmétiques
 * du contrôle qualité (`aReparer`, journalisé aussi). Sans elles, une replanification déclenchée
 * par un refus de juge est un appel de modèle payé pour redécouvrir le même plan.
 */
async function pourquoiLeJugeARefuse(missionId: string): Promise<string[]> {
  const [mission, refus] = await Promise.all([
    prisma.mission.findUnique({ where: { id: missionId }, select: { goalVerdict: true, goalSatisfied: true } }).catch(sansBloquer("missions-runtime.pourquoiLeJugeARefuse.mission", null)),
    prisma.missionEvent.findFirst({
      where: { missionId, kind: "GOAL_UNSATISFIED" }, orderBy: { at: "desc" }, select: { detail: true },
    }).catch(sansBloquer("missions-runtime.pourquoiLeJugeARefuse.missionEvent", null)),
  ]);
  const lignes: string[] = [];
  if (mission && mission.goalSatisfied === false && mission.goalVerdict) {
    lignes.push(`[OBJECTIF NON ATTEINT] le juge a refusé le plan précédent : ${mission.goalVerdict}`);
  }
  const detail = (refus?.detail ?? null) as Record<string, unknown> | null;
  const recours = detail?.recoursSuggere;
  if (typeof recours === "string" && recours.trim()) {
    lignes.push(`[RECOURS SUGGÉRÉ PAR LE JUGE] ${recours.trim()}`);
  }
  const aReparer = detail?.aReparer;
  if (Array.isArray(aReparer)) {
    for (const x of aReparer.slice(0, 8)) {
      if (typeof x === "string" && x.trim()) lignes.push(`[CONTRÔLE QUALITÉ] ${x.trim()}`);
    }
  }
  return lignes;
}

async function replanifierMissionInterne(
  user: CurrentUser,
  missionId: string,
  opts: OptionsAssemblage = {},
): Promise<ResultatReplanification> {
  const m = await prisma.mission.findFirst({
    where: { id: missionId, ownerId: user.id, kind: "RUNTIME" },
    select: {
      id: true, title: true, status: true, goalRaw: true, objective: true, planVersion: true,
      replanRefus: true, replanBloque: true,
    },
  });
  if (!m) return { replanifie: false, raison: "Mission introuvable — ou elle ne vous appartient pas." };
  if (!estReplanifiable(m.status)) {
    return { replanifie: false, raison: `Une mission ${m.status} n'a rien à replanifier.` };
  }
  /**
   * ── LA PORTE D'ENTRÉE : LE PROGRÈS, PLUS UN COMPTEUR (§118.42, §118.132) ──────────────
   *
   * Deux verdicts ne dépendent PAS de ce qui déclenche cette replanification et se rendent
   * avant de charger quoi que ce soit : la mission est-elle déjà déclarée bloquée (le même
   * refus est déjà revenu), et le plafond OPÉRATIONNEL est-il atteint. Le second S'ÉCRIT
   * (`replanBloque`) : sans cette écriture, une mission au plafond restait candidate du
   * battement — un `REPLAN_SKIPPED` par minute, pour toujours, sur une mission que personne
   * ne reprendrait. La comparaison de SIGNATURE, elle, vient plus bas, quand on sait ce qui a
   * déclenché le tour (un juge, un échec d'étape) ou ce que le compilateur a répondu.
   */
  const porteEtat = peutReplanifierMission(m, null);
  if (!porteEtat.autorise) {
    if (porteEtat.motif === "PLAFOND") {
      await prisma.mission.update({ where: { id: missionId }, data: { replanBloque: true } }).catch(sansBloquer("missions-runtime.replanifierMissionInterne.mission"));
      await journaliser(missionId, "REPLAN_BLOCKED",
        `${porteEtat.phrase} La mission ne sera plus reprise tant qu'une information neuve n'arrivera pas `
        + `— une réponse, un événement, une consigne, ou une modification demandée depuis l'écran.`,
        { motif: porteEtat.motif, signature: m.replanRefus, planVersion: m.planVersion });
    }
    return { replanifie: false, raison: porteEtat.phrase };
  }

  const etat = await chargerEtat(missionId);
  if (!etat) return { replanifie: false, raison: "État de mission illisible." };

  const abouties = etat.steps.filter((s) => s.status === "DONE");
  const bloquees = etat.steps.filter(
    (s) => s.status === "FAILED" && s.attempt >= s.maxAttempts,
  );
  /**
   * DEUX RAISONS DE REPLANIFIER, ET LA SECONDE MANQUAIT.
   *
   * La première est celle d'origine : des étapes ont épuisé leurs tentatives, le moteur ne sait
   * plus réparer seul. La seconde est apparue dans un run réel — toutes les étapes abouties, le
   * contrôle qualité vert, et le juge qui refuse : le PLAN était insuffisant, sans qu'aucune
   * étape n'ait échoué. Exiger un échec d'étape fermait la porte exactement là où le nouveau
   * plan était la seule issue, et la mission mourait BLOCKED.
   */
  const objectifManque = m.status === "BLOCKED" && etat.steps.length > 0
    && etat.steps.every((s) => ["DONE", "SKIPPED", "CANCELLED"].includes(s.status));
  if (bloquees.length === 0 && !objectifManque) {
    return {
      replanifie: false,
      raison: "Aucune étape n'a épuisé ses tentatives : le moteur peut encore réparer tout seul.",
    };
  }

  /**
   * ── LA SIGNATURE DE CE QUI DÉCLENCHE CE TOUR (§118.132) ──────────────────────────────
   *
   * Ce qui déclenche cette replanification a une SIGNATURE, et elle se compare à celle du tour
   * précédent AVANT de payer un plan :
   *
   *   • un refus du JUGE (toutes les étapes abouties, objectif non constaté) → `REFUS_JUGE`.
   *     Le juge qui refuse le plan v2 comme il avait refusé le plan v1 est le MÊME mur : le
   *     planificateur a eu son tour de correction. Passer `null` ici — « un motif neuf » —
   *     est ce qui a fait tourner une mission de banc douze plans durant, avec une
   *     notification « Bloqué » par plan, jusqu'à ce que le dirigeant demande à bloquer tout
   *     Adam ;
   *   • un ÉCHEC D'ÉTAPE → `null` : il n'y a rien à comparer, c'est bien un motif neuf.
   *
   * Le refus du COMPILATEUR, lui, n'existe qu'après l'appel du planificateur : sa comparaison
   * se fait plus bas, quand il a parlé. Une RÉPÉTITION s'écrit, comme le plafond : c'est ce que
   * la requête du battement lit.
   */
  const refus = objectifManque ? REFUS_JUGE : null;
  if (refus) {
    const porteRefus = peutReplanifierMission(m, refus);
    if (!porteRefus.autorise) {
      if (porteRefus.motif === "REPETITION") {
        await prisma.mission.update({
          where: { id: missionId }, data: { replanBloque: true, replanRefus: refus },
        }).catch(sansBloquer("missions-runtime.replanifierMissionInterne.mission"));
        await journaliser(missionId, "REPLAN_BLOCKED",
          `${porteRefus.phrase} La mission ne sera plus reprise tant qu'une information neuve n'arrivera pas `
          + `— une réponse, un événement, une consigne, ou une modification demandée depuis l'écran.`,
          { motif: porteRefus.motif, signature: refus, planVersion: m.planVersion });
      }
      return { replanifie: false, raison: porteRefus.phrase };
    }
  }

  /**
   * ── LA PORTE DÉTERMINISTE AVANT LE REPLAN (§13, chantier latence) ────────────────────
   *
   * Un run réel a payé 7,9 s et 5 718 jetons de replanification pour que le planificateur
   * réponde « aucune étape exploitable » : toutes les étapes étaient DONE, et le refus du
   * juge ne désignait rien qu'un plan NOUVEAU puisse changer. Ce signal existait déjà — le
   * juge remplit `suggestedRecovery` — mais personne ne le relisait avant de payer.
   *
   * La porte ne ferme QUE le cas mesuré : toutes les étapes abouties (aucune à réparer) ET
   * le dernier refus journalisé porte explicitement « aucun recours » (`recoursSuggere:
   * null, présent`). Un refus SANS ce champ (juge arithmétique, mission antérieure, juge
   * en panne) laisse la porte ouverte — l'absence de mesure n'est pas une mesure (§78).
   */
  if (objectifManque && bloquees.length === 0) {
    const dernierRefus = await prisma.missionEvent.findFirst({
      where: { missionId, kind: "GOAL_UNSATISFIED" },
      orderBy: { at: "desc" },
      select: { detail: true },
    }).catch(sansBloquer("missions-runtime.replanifierMissionInterne.missionEvent", null));
    const detail = dernierRefus?.detail as Record<string, unknown> | null | undefined;
    if (detail && "recoursSuggere" in detail && detail.recoursSuggere === null) {
      // ET LA PORTE S'ÉCRIT : sans `replanBloque`, la mission restait candidate du battement et
      // cette même ligne se réécrivait à chaque passage, pour toujours (§118.132).
      await prisma.mission.update({
        where: { id: missionId }, data: { replanBloque: true, replanRefus: REFUS_JUGE },
      }).catch(sansBloquer("missions-runtime.replanifierMissionInterne.mission"));
      await journaliser(missionId, "REPLAN_SKIPPED",
        "Replanification refusée SANS appel de modèle : toutes les étapes sont abouties et le "
        + "juge n'a suggéré aucun recours — un plan nouveau redécouvrirait la même impasse. La "
        + "mission ne sera plus reprise tant qu'une information neuve n'arrivera pas.",
        { porte: "RECOURS_ABSENT" });
      return {
        replanifie: false,
        raison: "Toutes les étapes sont abouties et le juge n'a suggéré aucun recours : un nouveau "
          + "plan n'aurait rien de neuf à proposer. Le verdict du juge est la réponse.",
      };
    }
  }

  const catalogue = catalogueDe(user, opts.lectureSeule ? { effetMax: "ANALYZE" } : {});
  const acteur = acteurDe(user);
  const cerveau = opts.reasoner ?? raisonneur;
  const objectif = m.goalRaw || m.objective;

  const refusDuJuge = await pourquoiLeJugeARefuse(missionId);

  const contexteReplan = {
    aujourdhui: new Date().toLocaleDateString("fr-FR"),
    demandeur: demandeurDe(user),
    politiques: await import("@/platform/in-process/teach/store").then((m) => m.politiquesPourMission(user.id)).catch(sansBloquer("missions-runtime.replanifierMissionInterne", [] as string[])),
    // CE QUI EST DÉJÀ FAIT : le planificateur doit repartir de là, pas de zéro. Lui cacher
    // l'acquis le ferait renvoyer trente-et-un messages déjà partis — l'idempotence les
    // arrêterait, mais au prix d'un plan illisible et d'un travail inutile.
    dejaFait: abouties.map((s) => `${s.key} : ${s.title}`).slice(0, 60),
    /**
     * ── POURQUOI LE PLAN PRÉCÉDENT N'A PAS SUFFI ──────────────────────────────────────
     *
     * Les étapes bloquées disent « ce qui a cassé ». Elles ne disent RIEN quand rien n'a
     * cassé — et c'est exactement le cas `objectifManque` : toutes les étapes abouties, le
     * juge qui refuse. `refusPrecedent` partait alors VIDE, et le planificateur était rappelé
     * sur le même objectif sans la moindre indication de ce qui manquait. Il réécrivait le
     * même plan, forcément : rien ne lui avait dit ce qui n'allait pas.
     *
     * Le verdict du juge et son recours suggéré existaient pourtant en base depuis toujours —
     * relus jusqu'ici seulement pour REFUSER de replanifier, jamais pour aider à le faire.
     */
    refusPrecedent: [
      ...bloquees.map((s) => `[${s.errorKind ?? "ÉCHEC"}] ${s.key} : ${s.error ?? "sans motif"}`),
      ...refusDuJuge,
    ],
  };
  const optionsPlan = {
    contexte: contexteReplan,
    /**
     * UNE REPLANIFICATION NE REPREND JAMAIS LE CHEMIN DIRECT.
     *
     * Le chemin direct est déterministe : sur la même demande il rend le même plan. Le
     * reprendre ici reproduirait à l'identique celui que le juge vient de refuser — une boucle
     * qui consomme une version de plan et n'apprend rien. C'est le seul endroit du dépôt qui
     * l'interdit, et c'est ce qui garantit que se tromper de chemin coûte une lecture, pas une
     * réponse fausse.
     */
    sansCheminDirect: true as const,
    ...roleForcePlanification(),
  };
  const optionsCompile = {
    // LES ACQUIS SONT DES DÉPENDANCES LÉGITIMES. On vient de dire au planificateur ce qui était
    // déjà fait ; lui refuser ensuite d'en dépendre serait lui reprocher d'avoir écouté.
    acquises: new Set(etat.steps.filter((s) => s.status === "DONE" || s.status === "SKIPPED").map((s) => s.key)),
    // LE PLAFOND SURVIT AU REPLAN. Sans cette ligne, une mission plafonnée en lecture
    // retrouverait le droit d'écrire à la deuxième version de son plan — une porte dérobée qui
    // ne s'ouvrirait qu'après un échec, donc au pire moment.
    ...(opts.lectureSeule ? { effetMax: "ANALYZE" as const } : {}),
    // LES EXIGENCES SURVIVENT AU REPLAN. Un plan v2 qui oublierait à nouveau le calcul serait
    // refusé comme le v1 : la barre ne se relâche pas parce qu'on a déjà échoué une fois.
    primitivesRequises: exigencesFermes(objectif),
    // La replanification est soumise à la MÊME cardinalité de pièces que le lancement :
    // un plan v2 qui perd le classeur serait accepté là où le v1 l'aurait été refusé.
    formatsLivrables: formatsLivrablesDemandes(objectif),
  };

  const plan = await planifier(objectif, catalogue, acteur, cerveau, optionsPlan);
  if (!plan.ok) return { replanifie: false, raison: `Le planificateur n'a rien rendu : ${plan.error}` };

  const agent = agentPour({ initiatedBy: user.id, executedBy: user.id, label: user.name });
  let c = compile(plan.plan, catalogue, agent, optionsCompile);
  if (!c.ok) {
    /**
     * ── LE REFUS EST RENVOYÉ AU PLANIFICATEUR — UNE FOIS, comme au lancement ─────────────
     *
     * `lancerMission` fait ce second essai depuis toujours ; la replanification, non. Sur un
     * run réel : le plan v2 propose un nœud ARTIFACT sous plafond de lecture, le compilateur
     * refuse (FORBIDDEN_EFFECT, correctement), et la mission meurt BLOCKED sans jamais
     * atteindre le juge — alors qu'un plan corrigé était à un message près. Le refus du
     * compilateur est exactement l'information dont le planner a besoin, et elle était jetée.
     */
    const secondEssai = await planifier(objectif, catalogue, acteur, cerveau, {
      ...optionsPlan,
      contexte: {
        ...contexteReplan,
        refusPrecedent: [
          ...contexteReplan.refusPrecedent,
          ...c.issues.map((i) => `[${i.code}] ${i.stepKey ?? "plan"} : ${i.message}`),
        ],
      },
    });
    if (!secondEssai.ok) {
      return { replanifie: false, raison: `Le planificateur n'a rien rendu : ${secondEssai.error}` };
    }
    const c2 = compile(secondEssai.plan, catalogue, agent, optionsCompile);
    if (!c2.ok) {
      /**
       * ── LE REFUS QUI REVIENT IDENTIQUE FERME LA PORTE, ET LE DIT ────────────────────
       *
       * Deux plans, deux refus. Si les CODES sont les mêmes, le planificateur n'a rien réparé
       * et un troisième tour rendrait la même réponse : on inscrit `replanBloque`, et le
       * battement cesse de reprendre cette mission à chaque tour pour lui refuser un plan.
       *
       * Si les codes ont CHANGÉ, on n'inscrit rien : la mission reste candidate, parce que le
       * planificateur progressait. C'est exactement ce que le plafond global ne savait pas
       * distinguer, et ce qu'il faisait payer à toutes les missions longues.
       *
       * `replanRefus` garde la dernière signature dans les deux cas : c'est la référence de la
       * comparaison suivante.
       */
      const signature = signatureDuRefus(c2.issues);
      const repetition = signatureDuRefus(c.issues) === signature;
      await prisma.mission.update({
        where: { id: missionId },
        data: { replanRefus: signature, replanBloque: repetition },
      }).catch(sansBloquer("missions-runtime.replanifierMissionInterne.mission"));
      await journaliser(missionId, repetition ? "REPLAN_BLOCKED" : "REPLAN_SKIPPED",
        repetition
          ? `Le compilateur oppose deux fois le même refus (${signature}) : le planificateur n'a rien `
            + `réparé, un plan de plus rendrait la même réponse. La mission ne sera plus reprise tant `
            + `qu'une information neuve n'arrivera pas.`
          : `Le plan corrigé reste refusé, mais sur d'autres motifs (${signatureDuRefus(c.issues)} → `
            + `${signature}) : le planificateur progresse, la mission reste candidate.`,
        { signature, repetition });
      return {
        replanifie: false,
        raison: `Le nouveau plan reste refusé après correction : `
          + `${c2.issues.map((i) => i.message).slice(0, 2).join(" ; ")}`,
      };
    }
    c = c2;
  }

  await transitionner(missionId, "PLANNING", "Replanification après échec sans recours");
  /**
   * UN PLAN QUI PASSE EFFACE LE BLOCAGE — mais GARDE la cause qui a motivé ce plan.
   *
   * `replanBloque` retombe : la mission a retrouvé un chemin. `replanRefus`, lui, porte la
   * signature de ce qui vient d'être replanifié (`REFUS_JUGE`, ou rien sur un échec d'étape) :
   * c'est la référence de la comparaison suivante. L'effacer — comme avant — faisait lire le
   * second refus du juge comme un premier, et la boucle ne pouvait pas s'arrêter (§118.132).
   */
  await prisma.mission.update({
    where: { id: missionId }, data: { replanRefus: refus, replanBloque: false },
  }).catch(sansBloquer("missions-runtime.replanifierMissionInterne.mission"));
  await materialiser(c.mission, {
    ownerId: user.id,
    title: m.title,
    goalRaw: objectif,
    missionId,
    maxConcurrency: CONCURRENCE_PAR_ECHELLE[c.mission.scale],
    planMetaExtra: { promptVersion: PLANNER_PROMPT_VERSION, politiques: contexteReplan.politiques ?? [] },
  });

  // ── §8 : CE QUI N'EST PLUS COUVERT REPASSE À L'ACCORD, ET RIEN D'AUTRE ─────────────
  const rouvert = await reouvrirSiChange(missionId, c.mission, user.id, m.title);
  if (rouvert) {
    await porteAttentionPour().signaler({
      kind: "PLAN_CHANGED", missionId, ownerId: user.id, titre: m.title,
      raison: `${rouvert.stepKeys.length} étape(s) ne sont pas couvertes par votre accord précédent.`,
      stepKey: rouvert.stepKeys.join("+").slice(0, 120),
    }).catch(sansBloquer("missions-runtime.replanifierMissionInterne.signaler"));
  }

  const apres = await prisma.mission.findUnique({
    where: { id: missionId }, select: { planVersion: true },
  });

  return {
    replanifie: true,
    raison: `Nouveau plan (v${apres?.planVersion ?? "?"}) : ${c.mission.steps.length} étapes, `
      + `${abouties.length} déjà aboutie(s) conservée(s).`,
    planVersion: apres?.planVersion,
    etapes: c.mission.steps.length,
    rouvertes: rouvert?.stepKeys ?? [],
  };
}
