/**
 * Composeur — LE LANCEMENT : de l'énoncé à la mission persistée — triage, horizon, planification,
 * compilation, talon de mission ; pannes transitoires et rôle forcé du planificateur.
 */
import { prisma } from "@/lib/prisma";
import { PLANNER_PROMPT_VERSION } from "@/lib/missions/planner/plan";
import { prechargerCapacitesDynamiques } from "@/platform/in-process/skills";
import { assurerFormes } from "@/platform/in-process/missions/formes";
import { lireInterrupteurMissions, phraseSuspension } from "@/lib/interrupteurs/missions";
import { peutPiloterMissionsAdam, REFUS_MISSIONS_ADAM } from "@/lib/rbac";
import { exigencesFermes, formatsLivrablesDemandes } from "@/lib/missions/planner/primitives";
import { trier } from "@/lib/missions/planner/triage";
import type { CurrentUser } from "@/lib/session";
import { compile } from "@/lib/missions/compiler/compile";
import { planifier, type ContextePlanification, type MetriquesPlanification } from "@/lib/missions/planner/plan";
import { materialiser, journaliser } from "@/lib/missions/runtime/store";
import { perimetre } from "@/lib/missions/approval/scope";
import { demanderApprobation } from "@/lib/missions/approval/gate";
import { agentPour } from "@/lib/missions/agent/principal";
import { assurerCompteAgent } from "@/lib/missions/agent/account";
import { CONCURRENCE_PAR_ECHELLE } from "@/lib/missions/model/roles";
import type { CompileIssue } from "@/lib/missions/planner/contract";
import { acteurDe, catalogueDe } from "@/platform/in-process/missions/catalog";
import { raisonneur } from "@/platform/in-process/missions/reasoner";
import { withTurn, setTurnContext } from "@/lib/models/telemetry";
import { enqueter, resumerSituation } from "@/platform/in-process/missions/situation";
import { porteAttentionPour } from "@/platform/in-process/missions/attention";
import { sansBloquer } from "@/lib/journal";
import type { OptionsAssemblage } from "./assemblage";
import { avancerMission } from "./avancement";
import { replanifierMission } from "./replanification";

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
export function roleForcePlanification(): { role?: string } {
  const role = (process.env.ADAM_PLANNER_ROLE ?? "").trim();
  return role ? { role } : {};
}

/** La personne qui demande, telle que le planificateur doit la nommer pour lui écrire. */
export const demandeurDe = (u: Pick<CurrentUser, "name" | "email">): string => (u.email ? `${u.name} <${u.email}>` : u.name);

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
  const politiquesEnseignees = await import("@/platform/ia/teach/store")
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
export async function creerTalon(user: CurrentUser, objectif: string, titre: string): Promise<string | null> {
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
