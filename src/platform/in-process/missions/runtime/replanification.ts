/**
 * Composeur — LA REPLANIFICATION : reprendre une mission refusée par le juge ou bloquée, avec la
 * raison du refus, sans perdre ce qui a déjà été exécuté.
 */
import { prisma } from "@/lib/prisma";
import { PLANNER_PROMPT_VERSION } from "@/lib/missions/planner/plan";
import { prechargerCapacitesDynamiques } from "@/platform/in-process/skills";
import { assurerFormes } from "@/platform/in-process/missions/formes";
import { REFUS_JUGE, estReplanifiable, peutReplanifierMission, signatureDuRefus } from "@/lib/missions/runtime/replan";
import { exigencesFermes, formatsLivrablesDemandes } from "@/lib/missions/planner/primitives";
import type { CurrentUser } from "@/lib/session";
import { compile } from "@/lib/missions/compiler/compile";
import { planifier } from "@/lib/missions/planner/plan";
import { materialiser, chargerEtat, journaliser, transitionner } from "@/lib/missions/runtime/store";
import { reouvrirSiChange } from "@/lib/missions/approval/gate";
import { agentPour } from "@/lib/missions/agent/principal";
import { CONCURRENCE_PAR_ECHELLE } from "@/lib/missions/model/roles";
import { acteurDe, catalogueDe } from "@/platform/in-process/missions/catalog";
import { raisonneur } from "@/platform/in-process/missions/reasoner";
import { withTurn, setTurnContext } from "@/lib/models/telemetry";
import { porteAttentionPour } from "@/platform/in-process/missions/attention";
import { sansBloquer } from "@/lib/journal";
import type { OptionsAssemblage } from "./assemblage";
import { demandeurDe, roleForcePlanification } from "./lancement";

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
    politiques: await import("@/platform/ia/teach/store").then((m) => m.politiquesPourMission(user.id)).catch(sansBloquer("missions-runtime.replanifierMissionInterne", [] as string[])),
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
