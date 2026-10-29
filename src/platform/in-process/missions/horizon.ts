/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE PILOTE D'HORIZON — ce qui fait qu'une mission de trois semaines existe.
 *
 * ── LE CHANGEMENT, EN UNE PHRASE ────────────────────────────────────────────────────────
 *
 * Une mission n'est plus UN plan compilé d'avance. C'est un OBJECTIF DURABLE découpé en jalons,
 * dont on ne compile que ceux que la frontière atteint — au moment où ce qui les précède a
 * réellement produit ses résultats.
 *
 * ── POURQUOI C'EST UNE PROPRIÉTÉ D'ARCHITECTURE, PAS UNE OPTIMISATION ───────────────────
 *
 * Un plan monolithique de mission longue n'est pas seulement trop gros : il est FAUX. Le
 * planificateur y écrit l'étape 200 sans savoir ce que l'étape 40 aura trouvé, donc il invente
 * ses références — un destinataire qu'on n'a pas encore identifié, un chiffre qu'on n'a pas
 * encore reçu, un fichier qui n'existe pas. La compilation paresseuse ne réduit pas un coût :
 * elle rend le plan du jalon 7 INFORMÉ par le jalon 6.
 *
 * Trois conséquences, et aucune n'est un effet de bord :
 *
 *   • la taille d'une mission cesse d'être bornée par la fenêtre du modèle (§118.40) ;
 *   • la replanification devient LOCALE : un jalon se reprend sans toucher aux autres, qui
 *     gardent leurs étapes, leurs reçus et leurs effets déjà produits ;
 *   • le budget anti-boucle devient LOCAL (§118.42) : le plafond global qui tuait une mission
 *     de vingt jalons pour la difficulté d'un seul n'existe plus.
 *
 * ── CE QUE CE FICHIER NE FAIT PAS ───────────────────────────────────────────────────────
 *
 * Il n'exécute AUCUNE étape. C'est `runtime/engine.ts` qui exécute, inchangé — mêmes reçus,
 * même idempotence, même ordonnanceur, mêmes attentes, même reprise après panne. Ce pilote
 * décide seulement QUAND compiler QUOI, et il ne conclut jamais à la place du contrôle et du
 * juge. Un moteur qui conclurait parce qu'il n'a pas pu vérifier serait pire qu'un moteur qui
 * ne conclut pas (§118.10).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/session";
import type { Reasoner } from "@/lib/missions/ports";
import { lireInterrupteurMissions } from "@/lib/interrupteurs/missions";
import { compile } from "@/lib/missions/compiler/compile";
import { planifier, PLANNER_PROMPT_VERSION, type ContextePlanification } from "@/lib/missions/planner/plan";
import { decouperEnJalons } from "@/lib/missions/planner/jalons";
import {
  avancement, frontiere, type Jalon,
} from "@/lib/missions/horizon/jalon";
import { peutReplanifier, signatureRefus } from "@/lib/missions/horizon/budget";
import {
  aDesJalons, compterReplan, ecrireJalons, lireEntrees, lireJalons, marquerJalon,
  type JalonPersiste,
} from "@/lib/missions/horizon/store";
import { aRegarder } from "@/lib/missions/horizon/fraicheur";
import { chargerEtat, journaliser, materialiser, transitionner } from "@/lib/missions/runtime/store";
import { peutEncoreAvancer } from "@/lib/missions/runtime/impasse";
import { prendreBail } from "@/lib/missions/runtime/bail";
import { evaluerObjectif, type EtapeObservee } from "@/lib/missions/goal/evaluate";
import { lireRecu } from "@/lib/missions/runtime/receipt";
import { agentPour } from "@/lib/missions/agent/principal";
import { acteurDe, catalogueDe } from "@/platform/in-process/missions/catalog";
import { raisonneur } from "@/platform/in-process/missions/reasoner";
import { enqueter, resumerSituation } from "@/platform/in-process/missions/situation";
import { exigencesFermes, formatsLivrablesDemandes } from "@/lib/missions/planner/primitives";
import { CONCURRENCE_PAR_ECHELLE } from "@/lib/missions/model/roles";
import { perimetre } from "@/lib/missions/approval/scope";
import { demanderApprobation, reouvrirSiChange } from "@/lib/missions/approval/gate";
import { porteAttentionPour } from "@/platform/in-process/missions/attention";
import { withTurn, setTurnContext } from "@/lib/models/telemetry";
import { assembler, avancerMission, titreDe, type LancementOptions } from "@/platform/in-process/missions/runtime";
import { sansBloquer } from "@/lib/journal";

/**
 * À PARTIR DE COMBIEN DE JALONS L'HORIZON A UN SENS.
 *
 * Un ou deux jalons, c'est une mission courte : le chemin classique la planifie d'un coup, plus
 * vite et pour moins cher, et l'horizon ne lui apporterait qu'un appel de modèle de plus. On
 * n'ajoute pas une structure là où elle ne résout rien — c'est ce qui rend le mécanisme
 * défendable, et c'est mesurable : sous ce seuil, RIEN ne change pour le corpus existant.
 */
export const JALONS_MIN_POUR_HORIZON = 3;

export interface ResultatHorizon {
  ok: boolean;
  missionId?: string;
  titre?: string;
  jalons?: number;
  /** `HORIZON` quand le découpage a été retenu, `PLAT` quand la mission est trop courte. */
  voie?: "HORIZON" | "PLAT";
  error?: string;
  raisonnement?: string;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * DÉCOUPE UN OBJECTIF DURABLE, ET NE LE FAIT QUE SI ÇA SERT.
 *
 * On enquête d'abord (le découpage s'appuie sur des faits, pas sur un nom), on demande le
 * découpage, et on décide : trois jalons ou plus → l'horizon ; moins → on rend `PLAT` et
 * l'appelant reprend le chemin classique. Le découpage coûte quelques centaines de jetons ;
 * c'est l'appel le moins cher du runtime, et c'est lui qui décide si la mission est exécutable.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export async function ouvrirHorizon(
  user: CurrentUser,
  objectif: string,
  opts: { missionId?: string; titre?: string; reasoner?: Reasoner; sansEnquete?: boolean } = {},
): Promise<ResultatHorizon> {
  const cerveau = opts.reasoner ?? raisonneur;
  const situation = opts.sansEnquete ? null : await enqueter(user, objectif).catch(sansBloquer("horizon.ouvrirHorizon.enqueter", null));
  const politiques = await import("@/platform/ia/teach/store")
    .then((m) => m.politiquesPourMission(user.id))
    .catch(sansBloquer("horizon.ouvrirHorizon", [] as string[]));

  const decoupage = await decouperEnJalons(objectif, cerveau, {
    contexte: {
      aujourdhui: new Date().toLocaleDateString("fr-FR"),
      ...(situation ? { situation } : {}),
      ...(politiques.length > 0 ? { politiques } : {}),
    },
  });
  if (!decoupage.ok) return { ok: false, error: decoupage.error };
  if (decoupage.jalons.length < JALONS_MIN_POUR_HORIZON) {
    return { ok: true, voie: "PLAT", jalons: decoupage.jalons.length, raisonnement: decoupage.raisonnement };
  }

  const titre = opts.titre ?? titreDe(objectif);
  const missionId = opts.missionId ?? await creerCoquille(user, objectif, titre);
  if (!missionId) return { ok: false, error: "la mission n'a pas pu être enregistrée" };

  await ecrireJalons(missionId, decoupage.jalons);
  await journaliser(missionId, "MILESTONES_PLANNED",
    `Objectif découpé en ${decoupage.jalons.length} jalons. Un seul sous-plan est compilé à la fois : `
    + `le plan du jalon N est écrit quand le jalon N-1 a produit ses résultats, pas avant.`,
    {
      raisonnement: decoupage.raisonnement,
      jalons: decoupage.jalons.map((j) => ({ ordre: j.ordre, titre: j.titre, resultat: j.resultat, dependsOn: j.dependsOn })),
      usage: decoupage.usage,
      latencyMs: decoupage.latencyMs,
    });
  if (situation) {
    await journaliser(missionId, "INVESTIGATED", resumerSituation(situation), {
      faits: situation.faits.length, ms: situation.couverture.ms,
    });
  }
  return { ok: true, missionId, titre, jalons: decoupage.jalons.length, voie: "HORIZON", raisonnement: decoupage.raisonnement };
}

/** LA COQUILLE : la mission existe en base, PLANNING sans étape ni plan. */
async function creerCoquille(user: CurrentUser, objectif: string, titre: string): Promise<string | null> {
  try {
    const m = await prisma.mission.create({
      data: {
        kind: "RUNTIME", status: "PLANNING", title: titre,
        objective: objectif, goalRaw: objectif, ownerId: user.id,
        // 0 : la première matérialisation d'un sous-plan incrémente à 1.
        planVersion: 0,
      },
      select: { id: true },
    });
    return m.id;
  } catch {
    return null;
  }
}

export interface TourHorizon {
  missionId: string;
  /** Combien de sous-plans ont été compilés pendant ce tour. */
  compiles: number;
  /** Combien de jalons ont été jugés atteints. */
  aboutis: number;
  /** Combien ont été déclarés bloqués. */
  bloques: number;
  /** L'état de la mission à la sortie. */
  statut: string;
  /** Où en est l'horizon. */
  avancement: ReturnType<typeof avancement>;
  /** Ce qui a empêché d'aller plus loin, quand quelque chose l'a empêché. */
  arret?: string;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * CONDUIRE UNE MISSION À HORIZON — la boucle, et ses trois seules décisions.
 *
 *   1. quels jalons sont à la FRONTIÈRE et n'ont pas encore de sous-plan → les compiler ;
 *   2. laisser le MOTEUR exécuter (il ne sait rien des jalons, et c'est très bien) ;
 *   3. quels jalons compilés ont fini leurs étapes → VÉRIFIER leur résultat, puis les fermer.
 *
 * Elle rend la main dès qu'un tour ne produit rien : c'est le cas normal d'une mission qui
 * ATTEND (une réponse humaine, une échéance, un accord). Le battement la reprendra, ou un
 * événement la réveillera. Une boucle qui insisterait ici brûlerait du modèle pour découvrir
 * qu'une personne n'a pas encore répondu.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export function conduireHorizon(
  user: CurrentUser,
  missionId: string,
  opts: LancementOptions = {},
): Promise<TourHorizon> {
  return withTurn("background", async () => {
    setTurnContext({ userId: user.id, missionId, feature: "mission" });
    return conduireHorizonInterne(user, missionId, opts);
  });
}

/** Combien de tours de frontière au plus dans UN appel. Borne opérationnelle (§118.2). */
const TOURS_MAX = 24;

async function conduireHorizonInterne(
  user: CurrentUser,
  missionId: string,
  opts: LancementOptions = {},
): Promise<TourHorizon> {
  const res: TourHorizon = {
    missionId, compiles: 0, aboutis: 0, bloques: 0, statut: "?",
    avancement: { total: 0, aboutis: 0, ecartes: 0, bloques: 0, annules: 0, restants: 0, part: 0 },
  };

  for (let tour = 0; tour < TOURS_MAX; tour++) {
    const mission = await prisma.mission.findUnique({
      where: { id: missionId },
      select: { id: true, status: true, goalRaw: true, objective: true, title: true, ownerId: true },
    });
    if (!mission) { res.arret = "mission introuvable"; return res; }
    res.statut = mission.status;

    /**
     * ── LE BAIL PROTÈGE AUSSI LA COMPILATION, PAS SEULEMENT L'EXÉCUTION ──────────────────
     *
     * MESURÉ : le lancement laisse un premier tour d'horizon en arrière-plan (`setImmediate`),
     * et le battement peut reprendre la même mission dans la seconde. `avancer` prend le bail à
     * chaque vague — les ÉTAPES ne partaient donc jamais deux fois — mais `compilerJalon`, lui,
     * ne le prenait pas. Deux pilotes compilaient le MÊME jalon : deux appels de planificateur
     * payés pour un seul sous-plan, une `planVersion` qui saute, et un état si mouvant qu'un
     * banc lisant l'instantané voyait un jalon DONE avec `planVersion: 0`.
     *
     * `materialiser` est ré-entrante, donc rien n'était CASSÉ — mais compiler deux fois est du
     * gaspillage pur, et un état qui se contredit à une seconde d'intervalle est illisible pour
     * un écran comme pour un contrôle.
     */
    if (!(await prendreBail(missionId))) {
      res.arret = "une autre instance conduit déjà cette mission";
      res.avancement = avancement(await lireJalons(missionId));
      return res;
    }

    // LA PAUSE ET L'ANNULATION SONT HONORÉES ICI AUSSI. Le moteur les honore de son côté ; si
    // seul lui le faisait, ce pilote continuerait à PAYER des sous-plans pour une mission
    // suspendue — la pause serait une promesse d'écran, pas une propriété du système.
    if (["PAUSED", "CANCELLED", "COMPLETED"].includes(mission.status)) {
      res.arret = `mission ${mission.status}`;
      res.avancement = avancement(await lireJalons(missionId));
      return res;
    }

    /**
     * ── L'INTERRUPTEUR GLOBAL, AVANT DE COMPILER (§118.132) ────────────────────────────
     *
     * Le moteur le lit à chaque tour ; ce pilote, lui, COMPILE un sous-plan — donc PAIE un
     * planificateur — AVANT d'appeler le moteur. Sans cette ligne, une mission longue
     * suspendue continuerait d'écrire des sous-plans que personne n'exécuterait : la pause
     * serait honorée par l'exécution et contournée par la planification (§118.45 : il en
     * fallait deux, ici aussi).
     */
    if ((await (opts.interrupteur ?? lireInterrupteurMissions)()).suspendues) {
      res.arret = "missions suspendues par la direction (interrupteur global)";
      res.avancement = avancement(await lireJalons(missionId));
      return res;
    }

    const jalons = await lireJalons(missionId);
    if (jalons.length === 0) { res.arret = "aucun jalon : cette mission n'a pas d'horizon"; return res; }
    res.avancement = avancement(jalons);

    const f = frontiere(jalons);
    if (f.termine) {
      res.statut = await conclureHorizon(user, missionId, opts);
      res.avancement = avancement(await lireJalons(missionId));
      return res;
    }

    // ── 1. COMPILER CE QUI EST À LA FRONTIÈRE ────────────────────────────────────────────
    let compilesCeTour = 0;
    for (const j of f.aCompiler) {
      const issue = await compilerJalon(user, mission, jalons, j as JalonPersiste, opts);
      if (issue.compile) { compilesCeTour += 1; res.compiles += 1; }
      else if (issue.bloque) { res.bloques += 1; }
    }

    // ── 2. LAISSER LE MOTEUR TRAVAILLER ──────────────────────────────────────────────────
    const tourMoteur = await avancerMission(user, missionId, opts);
    res.statut = tourMoteur?.status ?? res.statut;

    // ── 3. FERMER LES JALONS DONT LE TRAVAIL EST FINI ────────────────────────────────────
    const fermes = await fermerJalonsAboutis(user, missionId, opts);
    res.aboutis += fermes.aboutis;
    res.bloques += fermes.bloques;

    // ── 4. REPRENDRE CE QUI A BLOQUÉ — localement, tant que son budget l'autorise ─────────
    const reprises = await reprendreJalonsBloques(missionId);

    /**
     * RIEN N'A BOUGÉ : ON REND LA MAIN, ET CE N'EST PAS UN ÉCHEC.
     *
     * C'est l'état normal d'une mission longue : elle attend une réponse, une échéance, un
     * accord. Insister ici paierait des tours de moteur pour découvrir qu'une personne n'a
     * pas encore répondu. Le battement reprendra, ou un événement réveillera la branche.
     */
    if (compilesCeTour === 0 && fermes.aboutis === 0 && fermes.bloques === 0
      && reprises === 0 && (tourMoteur?.executees ?? 0) === 0) {
      res.avancement = avancement(await lireJalons(missionId));
      res.arret = "rien de neuf : la mission attend";
      return res;
    }
  }

  res.arret = `${TOURS_MAX} tours de frontière dans un seul appel — la suite au prochain battement`;
  res.avancement = avancement(await lireJalons(missionId));
  return res;
}


/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * REPRENDRE UN JALON QUI A BLOQUÉ — la replanification LOCALE, et c'est le cœur du Lot A.
 *
 * ── LE DÉFAUT, MESURÉ SUR UN RUN LIVE ───────────────────────────────────────────────────
 *
 * Le jalon 1 d'une mission de sept passe BLOCKED : quelques étapes ont épuisé leurs tentatives.
 * `frontiere()` écarte les jalons BLOCKED de ses « courants » — à juste titre, ils ne peuvent
 * pas travailler en l'état. Mais RIEN ne les reprenait : ils restaient bloqués pour toujours,
 * leur descendance n'était jamais libérée, et la mission mourait sur une difficulté LOCALE
 * qu'un sous-plan différent aurait très bien pu contourner. C'est exactement le « on ne s'arrête
 * jamais à la première difficulté » de §118.9, appliqué au mauvais niveau : le moteur réessayait
 * les ÉTAPES, personne ne réessayait le JALON.
 *
 * ── LA REPRISE EST UN REPLAN, PAS UN RE-RUN ─────────────────────────────────────────────
 *
 * On ne relance pas les mêmes étapes : elles ont épuisé leurs tentatives, les relancer
 * produirait le même échec. On remet le jalon à PENDING avec `planVersion: 0` — la marque
 * « pas encore compilé » — et la frontière lui écrira un sous-plan NEUF, informé de ce qui a
 * échoué. Les étapes mortes restent au dossier ; `materialiser` les contournera si le nouveau
 * plan ne les reprend pas, et les RÉARMERA s'il les reprend (§118.33).
 *
 * ── ET LE BUDGET RESTE LOCAL, JUGÉ AU PROGRÈS (§118.47) ────────────────────────────────
 *
 * La signature d'un blocage, ici, est l'ensemble des CAUSES d'échec (`errorKind`) — pas les
 * clés d'étapes, qui changent à chaque plan. Tant que les causes CHANGENT, un sous-plan de plus
 * vaut son prix ; dès qu'elles reviennent identiques, ce jalon bute sur un vrai mur et le dire
 * vaut mieux que payer un tour de plus.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
async function reprendreJalonsBloques(missionId: string): Promise<number> {
  const jalons = await lireJalons(missionId);
  const bloques = jalons.filter((j) => j.statut === "BLOCKED");
  if (bloques.length === 0) return 0;

  let reprises = 0;
  for (const j of bloques) {
    const mortes = await prisma.missionStep.findMany({
      where: { missionId, milestoneId: j.id, status: "FAILED", supersededAt: null },
      select: { key: true, errorKind: true, error: true },
    });
    /**
     * LA SIGNATURE D'UN BLOCAGE : ses CAUSES, triées et dédoublonnées. Un jalon bloqué SANS
     * étape morte l'a été par le juge (« le résultat n'est pas constatable ») — sa signature
     * est alors ce refus-là, et non un vide qui se confondrait avec « aucune cause connue ».
     */
    const signature = mortes.length > 0
      ? [...new Set(mortes.map((m) => m.errorKind ?? "ECHEC"))].sort().join("|")
      : "OBJECTIF_NON_CONSTATE";
    const verdict = peutReplanifier({ replans: j.replans, dernierRefus: j.dernierRefus, refusVus: j.refusVus }, signature);
    if (!verdict.autorise) {
      // ON NE RÉPÈTE PAS LE MESSAGE À CHAQUE TOUR : le jalon reste BLOCKED, son motif est déjà
      // au journal, et le redire à chaque battement rendrait le fil illisible.
      continue;
    }
    await compterReplan(j.id, signature);
    await marquerJalon(j.id, "PENDING", { planVersion: 0, dernierRefus: signature });
    reprises += 1;
    await journaliser(missionId, "MILESTONE_RETRY",
      `Jalon ${j.ordre} (« ${j.titre} ») est repris : ${verdict.phrase} `
      + (mortes.length > 0
        ? `${mortes.length} étape(s) avaient épuisé leurs tentatives (${signature}) — un sous-plan `
          + `NEUF va être écrit, informé de cet échec.`
        : `Son résultat n'était pas constatable — un sous-plan neuf va viser autrement.`),
      { ordre: j.ordre, signature, replans: j.replans + 1, etapesMortes: mortes.map((m) => m.key) });
  }
  return reprises;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * COMPILER LE SOUS-PLAN D'UN JALON.
 *
 * Le planificateur reçoit : l'objectif durable (pour le cadre), le RÉSULTAT ATTENDU de CE jalon
 * (pour le travail), et ce que les jalons précédents ont réellement produit — clés d'étapes et
 * aperçus. Il ne reçoit PAS les intentions des jalons suivants : elles ne le concernent pas, et
 * les lui montrer l'inciterait à empiéter dessus.
 *
 * ── LE BUDGET EST LOCAL, ET IL SE JUGE AU PROGRÈS ───────────────────────────────────────
 *
 * Tant que le refus du compilateur CHANGE, le planificateur répare et mérite un tour. Dès qu'il
 * REVIENT identique, ce jalon est bloqué — et LUI SEUL. Les autres continuent : c'est
 * exactement ce que le plafond global ne savait pas faire.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
async function compilerJalon(
  user: CurrentUser,
  mission: { id: string; title: string; goalRaw: string | null; objective: string; ownerId: string },
  tous: readonly JalonPersiste[],
  jalon: JalonPersiste,
  opts: LancementOptions,
): Promise<{ compile: boolean; bloque: boolean; raison: string }> {
  const objectif = mission.goalRaw || mission.objective;
  const budget = peutReplanifier({ replans: jalon.replans, dernierRefus: jalon.dernierRefus, refusVus: jalon.refusVus }, null);
  if (!budget.autorise) {
    await marquerJalon(jalon.id, "BLOCKED");
    await journaliser(mission.id, "MILESTONE_BLOCKED",
      `Jalon ${jalon.ordre} (« ${jalon.titre} ») : ${budget.phrase}`,
      { ordre: jalon.ordre, motif: budget.motif });
    return { compile: false, bloque: true, raison: budget.phrase };
  }

  const catalogue = catalogueDe(user, opts.lectureSeule ? { effetMax: "ANALYZE" } : {});
  const acteur = acteurDe(user);
  const cerveau = opts.reasoner ?? raisonneur;
  const agent = agentPour({ initiatedBy: user.id, executedBy: user.id, label: user.name });

  const acquis = await acquisDeLaMission(mission.id);
  const echecs = await echecsDuJalon(mission.id, jalon.id);
  const perimees = await entreesAVerifier(mission.id);
  const politiques = await import("@/platform/ia/teach/store")
    .then((m) => m.politiquesPourMission(user.id))
    .catch(sansBloquer("horizon.compilerJalon", [] as string[]));

  const contexte: ContextePlanification = {
    aujourdhui: new Date().toLocaleDateString("fr-FR"),
    demandeur: `${user.name ?? "le demandeur"}${user.email ? ` <${user.email}>` : ""}`,
    ...(politiques.length > 0 ? { politiques } : {}),
    /**
     * CE QUI EST DÉJÀ ACQUIS — clés d'étapes ET aperçu de ce qu'elles ont rendu.
     *
     * Les clés seules ne suffisent pas : un planificateur qui lit « collecte-khaled : Demander
     * le prix » sans voir que la réponse est arrivée redemande. C'est le défaut §118.23, vu en
     * live : la mission relançait une recherche pour retrouver une réponse déjà en main.
     */
    dejaFait: acquis.lignes,
    /**
     * CE QUI A ÉCHOUÉ LA FOIS PRÉCÉDENTE SUR CE JALON — et pourquoi ça ne peut pas manquer.
     *
     * Un jalon repris (`reprendreJalonsBloques`) est repris PARCE QUE quelque chose a cassé. Si
     * le planificateur ne le sait pas, il réécrit le même sous-plan : on paie un appel pour
     * redécouvrir le même mur. C'est la version locale du défaut §118.18 — le refus doit voyager
     * jusqu'à celui qui peut le réparer.
     */
    ...(echecs.length > 0 ? { refusPrecedent: echecs } : {}),
    /**
     * ── CE QUI A VIEILLI DEPUIS QU'ON L'A LU (§118.41) ────────────────────────────────
     *
     * C'est ICI que la fraîcheur devient une propriété du produit et cesse d'être une table.
     * Le module `fraicheur.ts` DIT ce qui est vieux ; il ne décide pas de relire — relire coûte
     * des appels et peut avoir des effets. Le bon endroit pour décider, c'est le PLAN : on
     * énonce la contrainte, le planificateur écrit l'étape de relecture si elle sert, et cette
     * étape passe par les mêmes droits, les mêmes reçus, la même politique que les autres.
     *
     * L'alternative — relire d'autorité depuis le pilote — ferait des lectures hors plan, sans
     * étape pour les porter ni reçu pour les prouver. La contrainte, elle, se lit dans le plan.
     */
    ...(perimees.length > 0 ? { contraintes: perimees } : {}),
  };

  const consigne = consigneDuJalon(objectif, jalon, tous);
  let plan = await planifier(consigne, catalogue, acteur, cerveau, {
    contexte,
    // UN SOUS-PLAN DE JALON NE PREND JAMAIS LE CHEMIN DIRECT. Le chemin direct répond à une
    // DEMANDE, pas à un fragment d'objectif : il lirait la consigne du jalon comme une question
    // et rendrait une lecture unique là où on attend un morceau de mission.
    sansCheminDirect: true,
  });
  if (!plan.ok) {
    /**
     * ── UN PLANIFICATEUR QUI NE REND RIEN EST UN REFUS, PAS UN NON-ÉVÉNEMENT (§118.70) ───
     *
     * MESURÉ LIVE, mission `cmtttwj1r…` : « le planificateur n'a rien rendu (Le plan rendu ne
     * contient aucune étape exploitable) » écrit TROIS FOIS, à 08:22, 08:26 et 08:27. Le jalon
     * restait PENDING avec `planVersion: 0`, la frontière le reprenait au tour suivant, le
     * planificateur échouait à l'identique — et rien ne comptait. Ce chemin-ci ne consommait
     * PAS le budget local : celui-ci ne s'incrémente que lorsque le COMPILATEUR refuse. Une
     * boucle sans fin au prix d'un appel de planification par tour, et le battement rendait
     * « rien de neuf : la mission attend » sur une mission dont le planificateur venait
     * d'échouer trois fois.
     *
     * C'est §118.18 sur la seule porte qui l'ignorait. Un plan vide porte donc sa signature —
     * elle entre dans l'histoire du jalon, la répétition l'arrête, et l'arrêt se DIT.
     */
    const signature = "PLAN_VIDE";
    const verdict = peutReplanifier(
      { replans: jalon.replans, dernierRefus: jalon.dernierRefus, refusVus: jalon.refusVus }, signature);
    await compterReplan(jalon.id, signature);
    if (!verdict.autorise) {
      await marquerJalon(jalon.id, "BLOCKED", { dernierRefus: signature });
      await journaliser(mission.id, "MILESTONE_BLOCKED",
        `Jalon ${jalon.ordre} (« ${jalon.titre} ») : ${verdict.phrase} `
        + `Le planificateur ne rend plus rien d'exploitable pour ce jalon (${plan.error}).`,
        { ordre: jalon.ordre, motif: verdict.motif, signature });
      return { compile: false, bloque: true, raison: verdict.phrase };
    }
    await journaliser(mission.id, "MILESTONE_PLAN_FAILED",
      `Jalon ${jalon.ordre} : le planificateur n'a rien rendu (${plan.error}). ${verdict.phrase}`,
      { ordre: jalon.ordre, signature, replans: jalon.replans + 1 });
    return { compile: false, bloque: false, raison: plan.error };
  }

  const plafond = {
    ...(opts.lectureSeule ? { effetMax: "ANALYZE" as const } : {}),
    acquises: new Set(acquis.cles),
    /**
     * LES EXIGENCES SE LISENT SUR LE RÉSULTAT DU JALON, PAS SUR L'OBJECTIF ENTIER.
     *
     * `exigencesFermes(objectif)` sur une mission longue exigerait un DOCUMENT de CHAQUE jalon,
     * y compris de la collecte qui n'en produit aucun — et la mission mourrait au premier.
     * Ce que ce jalon-ci doit livrer est écrit dans SON résultat attendu, et nulle part ailleurs.
     */
    primitivesRequises: exigencesFermes(jalon.resultat),
    formatsLivrables: formatsLivrablesDemandes(jalon.resultat),
  };
  let c = compile(plan.plan, catalogue, agent, plafond);

  // ── LA BOUCLE DE CORRECTION, BORNÉE PAR LE PROGRÈS ──────────────────────────────────────
  let dernier = jalon.dernierRefus;
  let replans = jalon.replans;
  // L'HISTOIRE DES MURS, tenue en mémoire pendant la boucle ET persistée par `compterReplan` :
  // une oscillation entre deux refus change à chaque tour et ne progresse jamais (§118.67).
  const vus = [...jalon.refusVus];
  while (!c.ok) {
    const signature = signatureRefus(c.issues);
    const verdict = peutReplanifier({ replans, dernierRefus: dernier, refusVus: vus }, signature);
    await compterReplan(jalon.id, signature);
    replans += 1;
    dernier = signature;
    vus.push(signature);
    if (!verdict.autorise) {
      await marquerJalon(jalon.id, "BLOCKED", { dernierRefus: signature });
      await journaliser(mission.id, "MILESTONE_BLOCKED",
        `Jalon ${jalon.ordre} (« ${jalon.titre} ») : ${verdict.phrase} `
        + `Refus : ${c.issues.map((i) => i.message).slice(0, 3).join(" ; ")}`,
        { ordre: jalon.ordre, motif: verdict.motif, signature, issues: c.issues.map((i) => i.code) });
      return { compile: false, bloque: true, raison: verdict.phrase };
    }
    const essai = await planifier(consigne, catalogue, acteur, cerveau, {
      contexte: {
        ...contexte,
        refusPrecedent: c.issues.map((i) => `[${i.code}] ${i.stepKey ?? "plan"} : ${i.message}`),
      },
      sansCheminDirect: true,
    });
    if (!essai.ok) {
      return { compile: false, bloque: false, raison: essai.error };
    }
    plan = essai;
    c = compile(plan.plan, catalogue, agent, plafond);
  }

  // ── LE SOUS-PLAN EST ÉCRIT, BORNÉ À CE JALON ────────────────────────────────────────────
  await materialiser(c.mission, {
    ownerId: mission.ownerId,
    title: mission.title,
    goalRaw: objectif,
    missionId: mission.id,
    milestoneId: jalon.id,
    maxConcurrency: CONCURRENCE_PAR_ECHELLE[c.mission.scale],
    planMetaExtra: { promptVersion: PLANNER_PROMPT_VERSION, jalon: jalon.ordre, jalonTitre: jalon.titre },
  });
  const apres = await prisma.mission.findUnique({ where: { id: mission.id }, select: { planVersion: true } });
  await marquerJalon(jalon.id, "ACTIVE", { planVersion: apres?.planVersion ?? 1, compiledAt: new Date() });
  await journaliser(mission.id, "MILESTONE_COMPILED",
    `Jalon ${jalon.ordre} (« ${jalon.titre} ») compilé : ${c.mission.steps.length} étapes. `
    + `Résultat attendu : ${jalon.resultat}`,
    {
      ordre: jalon.ordre, etapes: c.mission.steps.length, planVersion: apres?.planVersion,
      usage: plan.metriques.usage, latencyMs: plan.metriques.latencyMs,
      acquisMontres: acquis.cles.length,
    });

  /**
   * ── L'ACCORD PORTE SUR LE SOUS-PLAN QU'ON VIENT D'ÉCRIRE (§118.8) ────────────────────
   *
   * Un jalon compilé porte des étapes que personne n'a autorisées. `reouvrirSiChange` compare
   * le périmètre au dernier accord donné et ROUVRE la partie non couverte — elle seule. C'est
   * ce qui empêche qu'une mission longue devienne une porte dérobée : il suffirait sinon
   * d'atteindre le jalon 5 pour qu'un envoi parte sur un accord qui portait sur le jalon 1.
   */
  const p = perimetre(c.mission);
  if (p) {
    const rouvert = await reouvrirSiChange(mission.id, c.mission, mission.ownerId, mission.title);
    if (rouvert) {
      await porteAttentionPour().signaler({
        kind: "PLAN_CHANGED", missionId: mission.id, ownerId: mission.ownerId, titre: mission.title,
        raison: `Jalon ${jalon.ordre} : ${rouvert.stepKeys.length} étape(s) ne sont pas couvertes par votre accord précédent.`,
        stepKey: rouvert.stepKeys.join("+").slice(0, 120),
      }).catch(sansBloquer("horizon.compilerJalon.signaler"));
    } else {
      const id = await demanderApprobation(mission.id, p, mission.ownerId, mission.title);
      await porteAttentionPour().signaler({
        kind: "APPROVAL_REQUIRED", missionId: mission.id, ownerId: mission.ownerId, titre: mission.title,
        raison: p.resume, niveauApprobation: p.niveau, stepKey: `jalon-${jalon.ordre}`,
        planVersion: apres?.planVersion ?? 1,
      }).catch(sansBloquer("horizon.compilerJalon.signaler"));
      void id;
    }
  }

  return { compile: true, bloque: false, raison: "sous-plan écrit" };
}



/**
 * CE QUE LA MISSION A LU IL Y A TROP LONGTEMPS POUR SA NATURE — dit au planificateur.
 *
 * Une mission de trois semaines lit son forecast le jour 1 et le réutilise le jour 19. Le
 * chiffre a très bien pu bouger, et rien dans la mission ne le sait. Ces phrases-là entrent dans
 * les CONTRAINTES du sous-plan suivant : c'est lui qui décidera s'il faut relire, et l'étape de
 * relecture aura ses droits, son reçu et sa trace comme n'importe quelle autre.
 *
 * Bornée à cinq : au-delà, ce n'est plus une contrainte, c'est un catalogue que le modèle
 * survole. On garde les plus vieilles — `aRegarder` les rend déjà triées.
 */
async function entreesAVerifier(missionId: string): Promise<string[]> {
  const entrees = await lireEntrees(missionId).catch(sansBloquer("horizon.entreesAVerifier.lireEntrees", []));
  if (entrees.length === 0) return [];
  return aRegarder(entrees, new Date())
    .slice(0, 5)
    .map((v) => `DONNÉE À REVÉRIFIER AVANT DE T'EN SERVIR — ${v.phrase}`);
}

/** Ce qui a échoué sur CE jalon, en français, prêt pour le planificateur. */
async function echecsDuJalon(missionId: string, milestoneId: string): Promise<string[]> {
  const mortes = await prisma.missionStep.findMany({
    where: { missionId, milestoneId, status: "FAILED" },
    select: { key: true, title: true, error: true, errorKind: true },
    take: 12,
  });
  return mortes.map((m) =>
    `[${m.errorKind ?? "ÉCHEC"}] « ${m.title} » (${m.key}) : ${m.error ?? "sans motif"}`);
}

/**
 * LA CONSIGNE D'UN JALON — ce que le planificateur lit à la place de l'objectif entier.
 *
 * L'objectif durable y figure comme CADRE (pour que le plan reste cohérent avec la demande),
 * mais ce qui est demandé est le résultat de CE jalon. Les jalons suivants sont nommés en une
 * ligne, et seulement pour dire ce qu'il ne faut PAS faire ici : sans cette ligne, le
 * planificateur, voyant l'objectif complet, empiète — il écrit l'envoi final dans le jalon de
 * collecte, et la mission expédie un document qu'elle n'a pas encore produit.
 */
function consigneDuJalon(objectif: string, jalon: JalonPersiste, tous: readonly JalonPersiste[]): string {
  const suivants = tous
    .filter((j) => j.ordre > jalon.ordre && j.statut !== "CANCELLED")
    .map((j) => `${j.ordre}. ${j.titre}`);
  const bouts = [
    `OBJECTIF DURABLE DE LA MISSION (cadre, pas la demande d'aujourd'hui) :\n${objectif}`,
    `CE QUI EST DEMANDÉ MAINTENANT — jalon ${jalon.ordre} : ${jalon.titre}`,
    `RÉSULTAT À OBTENIR (c'est là-dessus que ce jalon sera jugé) :\n${jalon.resultat}`,
    /**
     * ── CE QUE LE JUGE EXIGE, LA CONSIGNE DOIT DIRE COMMENT LE SATISFAIRE (§118.19) ─────
     *
     * MESURÉ LIVE, trois runs de suite. Le jalon 1 s'appelle « les dossiers sont COMPLÉTÉS » —
     * un résultat qui dépend d'une réponse humaine. Le sous-plan a envoyé les demandes, puis
     * s'est ARRÊTÉ : aucune attente. Toutes ses étapes étant terminales, le jalon a été jugé
     * immédiatement, sur un résultat que personne n'avait encore eu le temps de produire, et
     * refusé — honnêtement. Puis repris, replanifié, rejugé, refusé encore : la mission n'a
     * jamais dépassé son PREMIER jalon, à chaque fois pour la même raison.
     *
     * Le juge ne se déclenche que lorsque plus AUCUNE étape ne peut avancer. Une attente
     * ouverte le retient donc — c'est elle, et elle seule, qui donne au monde le temps de
     * rendre le résultat attendu. Un sous-plan qui sollicite sans attendre demande à être
     * jugé sur ce qu'il vient tout juste de demander.
     */
    `COMMENT CE JALON SERA JUGÉ, ET CE QUE ÇA T'IMPOSE : le résultat ci-dessus est relu quand `
    + `plus aucune de tes étapes ne peut avancer. Si ce résultat dépend d'une réponse, d'une `
    + `pièce ou d'un fait qui n'a pas encore eu lieu, ton sous-plan DOIT porter l'attente `
    + `(WAIT_INPUT / WAIT_EVENT) qui la reçoit — sinon il sera jugé une seconde après avoir `
    + `envoyé sa demande, sur un résultat que personne n'a eu le temps de produire, et refusé. `
    + `Solliciter sans attendre n'est pas un jalon, c'est une moitié de jalon.`,
  ];
  if (suivants.length > 0) {
    bouts.push(
      `CE QUI VIENDRA APRÈS, ET QUE TU NE DOIS PAS FAIRE ICI — d'autres jalons s'en chargeront, `
      + `avec les résultats de celui-ci sous les yeux :\n${suivants.join("\n")}`,
    );
  }
  return bouts.join("\n\n");
}

/**
 * CE QUE LA MISSION A DÉJÀ OBTENU — clés d'étapes abouties et aperçu de leur résultat.
 *
 * Les clés servent au COMPILATEUR (`acquises`) : une étape d'un jalon suivant a le droit de
 * dépendre d'une étape acquise d'un jalon précédent, et de la référencer.
 * Les lignes servent au PLANIFICATEUR : sans l'aperçu, il redemande ce qu'il tient déjà.
 */
async function acquisDeLaMission(missionId: string): Promise<{ cles: string[]; lignes: string[] }> {
  const etapes = await prisma.missionStep.findMany({
    where: { missionId, status: { in: ["DONE", "SKIPPED"] }, supersededAt: null },
    select: { key: true, title: true, result: true, nodeType: true },
    orderBy: { completedAt: "asc" },
    take: 120,
  });
  return {
    cles: etapes.map((e) => e.key),
    lignes: etapes.map((e) => {
      const apercu = apercuResultat(e.result);
      return `${e.key} : ${e.title}${apercu ? ` → ${apercu}` : ""}`;
    }),
  };
}

/** Un aperçu BORNÉ du résultat — assez pour ne pas redemander, jamais le résultat entier. */
function apercuResultat(v: unknown): string {
  if (v === null || v === undefined) return "";
  let t: string;
  try { t = typeof v === "string" ? v : JSON.stringify(v); } catch { return ""; }
  t = t.replace(/\s+/g, " ").trim();
  return t.length > 240 ? `${t.slice(0, 240)}…` : t;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * FERMER LES JALONS DONT LE TRAVAIL EST FINI — et le faire sur le RÉSULTAT, pas sur les étapes.
 *
 * « Toutes les étapes ont tourné » n'est pas « le résultat est là » (§118.10). Un jalon dont
 * toutes les étapes sont vertes et dont le résultat attendu n'est pas constatable est un faux
 * succès — celui qui fait qu'une mission de trois semaines expédie un document vide.
 *
 * On compare donc le RÉSULTAT ATTENDU du jalon à ce que ses étapes ont réellement rendu, avec
 * le même juge que celui de la mission. Le juge dit non → le jalon est BLOQUÉ, pas atteint : il
 * pourra être repris (son budget local n'est pas épuisé) et il ne libère pas sa descendance.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
async function fermerJalonsAboutis(
  user: CurrentUser,
  missionId: string,
  opts: LancementOptions,
): Promise<{ aboutis: number; bloques: number }> {
  const jalons = await lireJalons(missionId);
  const actifs = jalons.filter((j) => j.statut === "ACTIVE");
  if (actifs.length === 0) return { aboutis: 0, bloques: 0 };

  const etapes = await prisma.missionStep.findMany({
    where: { missionId, milestoneId: { in: actifs.map((j) => j.id) }, supersededAt: null },
    select: {
      milestoneId: true, key: true, title: true, status: true, nodeType: true,
      result: true, receipt: true, receiptData: true, attempt: true, maxAttempts: true, input: true,
    },
  });

  /**
   * ── UNE ÉTAPE DERRIÈRE UN MUR N'EST PAS DU TRAVAIL À VENIR (§118.67) ───────────────────
   *
   * MESURÉ, mission `cmtta95k1…` : deux envois en échec DÉFINITIF (« Équipe Regulatory »
   * n'est pas une personne) et ONZE étapes PENDING qui en descendaient. La mission le voyait
   * — `deduireEtat` a rendu BLOCKED et l'a dit — mais ici, ces onze étapes comptaient comme
   * du travail en cours : le jalon restait ACTIVE, `reprendreJalonsBloques` ne le voyait
   * jamais, et la reprise de jalon (§118.47) n'a JAMAIS pu se déclencher. Cinq passages du
   * battement, zéro replan, dix-sept étapes mortes sur un nom de destinataire.
   *
   * La question est le GRAPHE, pas le comptage : `etapesEnImpasse` remonte des échecs
   * définitifs vers ce qui en descend. On charge donc TOUTES les étapes de la mission — une
   * étape de ce jalon peut dépendre d'un acquis, ou d'un mort, d'un jalon précédent.
   */
  const toutes = await prisma.missionStep.findMany({
    where: { missionId, supersededAt: null },
    select: {
      key: true, status: true, attempt: true, maxAttempts: true,
      deps: { select: { dependsOn: { select: { key: true } } } },
    },
  });
  const graphe = toutes.map((e) => ({
    key: e.key, status: e.status, attempt: e.attempt, maxAttempts: e.maxAttempts,
    dependsOn: e.deps.map((d) => d.dependsOn.key),
  }));

  let aboutis = 0;
  let bloques = 0;

  for (const j of actifs) {
    const siennes = etapes.filter((e) => e.milestoneId === j.id);
    // AUCUNE ÉTAPE = le sous-plan n'a rien produit en base : on ne conclut pas, on laisse le
    // moteur (ou le tour suivant) faire son travail. Fermer ici serait conclure sur du vide.
    if (siennes.length === 0) continue;
    const cles = new Set(siennes.map((e) => e.key));
    if (peutEncoreAvancer(graphe.filter((e) => cles.has(e.key)), graphe)) continue;

    const verdict = await jugerJalon(user, missionId, j, siennes, opts);
    if (verdict.atteint) {
      await marquerJalon(j.id, "DONE");
      aboutis += 1;
      await journaliser(missionId, "MILESTONE_DONE",
        `Jalon ${j.ordre} (« ${j.titre} ») atteint : ${verdict.raison}`,
        { ordre: j.ordre, etapes: siennes.length });
    } else {
      await marquerJalon(j.id, "BLOCKED");
      bloques += 1;
      await journaliser(missionId, "MILESTONE_UNSATISFIED",
        `Jalon ${j.ordre} (« ${j.titre} ») : toutes ses étapes sont terminées et le résultat attendu `
        + `n'est PAS constatable. ${verdict.raison}`,
        { ordre: j.ordre, resultatAttendu: j.resultat, etapes: siennes.length });
    }
  }
  return { aboutis, bloques };
}

interface EtapeJugee {
  key: string; title: string; status: string; nodeType: string;
  result: unknown; receipt: string | null; receiptData: unknown;
  attempt: number; maxAttempts: number; input: unknown;
}

/**
 * LE JUGE D'UN JALON — le mécanisme CANONIQUE, sur un périmètre plus petit.
 *
 * `evaluerObjectif` est exactement ce que `conclure()` appelle pour une mission : contrôle
 * arithmétique d'abord (il a le dernier mot dans le sens négatif), juge ensuite, et refus de
 * conclure quand le juge n'a pas pu se prononcer. On ne réécrit pas un second évaluateur : il
 * divergerait du premier, et deux verdicts qui divergent sur « est-ce atteint ? » sont pires
 * qu'un seul (§118.5).
 *
 * Ce qui change, c'est ce qu'on lui donne : le RÉSULTAT ATTENDU du jalon comme objectif ET
 * comme critère d'acceptation — c'est littéralement ce qu'on doit pouvoir constater —, et les
 * étapes de CE jalon comme preuves.
 */
async function jugerJalon(
  user: CurrentUser,
  missionId: string,
  jalon: JalonPersiste,
  etapes: readonly EtapeJugee[],
  opts: LancementOptions,
): Promise<{ atteint: boolean; raison: string }> {
  /**
   * UN ÉCHEC DÉFINITIF SE VOIT SANS PAYER UN JUGE.
   *
   * Une étape qui a épuisé ses tentatives est un FAIT, pas une appréciation. Demander à un
   * modèle si un jalon dont une étape est morte est « atteint » coûterait un appel pour une
   * réponse que le code connaît déjà.
   */
  const mortes = etapes.filter((e) => e.status === "FAILED" && e.attempt >= e.maxAttempts);
  if (mortes.length > 0) {
    return {
      atteint: false,
      raison: `${mortes.length} étape(s) ont épuisé leurs tentatives : ${mortes.map((e) => e.key).join(", ")}.`,
    };
  }

  const observees: EtapeObservee[] = etapes.map((e) => ({
    key: e.key, title: e.title, status: e.status as EtapeObservee["status"], nodeType: e.nodeType,
    receipt: e.receipt, recu: lireRecu(e.receiptData), attempt: e.attempt, maxAttempts: e.maxAttempts,
    result: e.result, input: (e.input ?? {}) as Record<string, unknown>,
  }));

  const { juge } = assembler(user, { reasoner: opts.reasoner, complexite: opts.complexite ?? "B" });
  try {
    const verdict = await evaluerObjectif({
      objectif: jalon.resultat,
      // LE RÉSULTAT ATTENDU EST LE CRITÈRE. Il est écrit pour ça : « les trois prix sont connus,
      // avec leur auteur et leur date » est un critère d'acceptation, mot pour mot.
      criteres: [jalon.resultat],
      steps: observees,
      juge,
    });
    return { atteint: verdict.satisfait, raison: verdict.raison };
  } catch (err) {
    /**
     * SANS JUGE, ON NE CONCLUT PAS (§118.10).
     *
     * Fermer le jalon parce que le juge est en panne fabriquerait exactement le faux succès
     * qu'on combat. Le jalon reste ACTIF : le tour suivant réessaiera, et le journal dit
     * pourquoi rien n'a bougé.
     */
    await journaliser(missionId, "MILESTONE_JUDGE_UNAVAILABLE",
      `Jalon ${jalon.ordre} : le juge n'a pas pu se prononcer (${err instanceof Error ? err.message : String(err)}). `
      + `Le jalon reste ouvert — on ne conclut pas faute d'avoir pu vérifier.`,
      { ordre: jalon.ordre });
    return { atteint: false, raison: "juge indisponible" };
  }
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * CONCLURE UNE MISSION À HORIZON — le contrôle et le juge, sur l'objectif ENTIER.
 *
 * Tous les jalons sont terminaux. C'est seulement MAINTENANT que la question « l'objectif est-il
 * atteint ? » a un sens, et c'est le mécanisme canonique qui y répond : `conclure()` du moteur,
 * inchangé. On ferme l'horizon (plus aucun jalon vivant) pour que sa porte le laisse passer,
 * puis on appelle le moteur — qui fait son contrôle arithmétique, interroge le juge, signale au
 * dirigeant et transitionne. Rien n'est réécrit ici : un second chemin de conclusion
 * divergerait du premier.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
async function conclureHorizon(
  user: CurrentUser,
  missionId: string,
  opts: LancementOptions,
): Promise<string> {
  const etat = await chargerEtat(missionId);
  if (!etat) return "?";
  // `horizonOuvert` est déjà faux ici (tous les jalons sont terminaux) : la porte de `conclure`
  // laisse donc passer, et c'est le moteur — pas ce fichier — qui décide de l'issue.
  if (etat.status === "PLANNING" || etat.status === "READY") {
    await transitionner(missionId, "READY", "horizon terminé");
    await transitionner(missionId, "RUNNING", "bilan de l'horizon");
  }
  const { deps } = assembler(user, { reasoner: opts.reasoner, complexite: opts.complexite ?? "B", sink: opts.sink });
  const { conclure } = await import("@/lib/missions/runtime/engine");
  const frais = await chargerEtat(missionId);
  if (!frais) return "?";
  return conclure(missionId, frais, deps, acteurDe(user));
}

/** Une mission a-t-elle un horizon ? Réexporté ici pour que l'appelant n'ait qu'une porte. */
export { aDesJalons };

/** L'avancement de l'horizon, pour l'écran et le compte rendu. */
export async function avancementHorizon(missionId: string): Promise<{
  jalons: Jalon[]; avancement: ReturnType<typeof avancement>;
}> {
  const jalons = await lireJalons(missionId);
  return { jalons, avancement: avancement(jalons) };
}
