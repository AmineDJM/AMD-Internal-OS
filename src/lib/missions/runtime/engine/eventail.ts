/**
 * Moteur de mission — L'ÉVENTAIL : déployer une étape `forEach` en unités, et résoudre les éventails
 * dont les unités ont abouti.
 */
import { prisma } from "@/lib/prisma";
import type { CapabilityCatalog } from "@/lib/missions/ports";
import { systemClock } from "@/lib/missions/ports";
import { STEP_TERMINAL } from "@/lib/missions/runtime/state";
import { EtatEtape, EtatMission, journaliser } from "@/lib/missions/runtime/store";
import { entreeIteration, identiteIteration } from "@/lib/missions/runtime/interpolate";
import { expliquer, resoudreCollection } from "@/lib/missions/runtime/collection";
import { EFFECT_RANK } from "@/lib/missions/registry/capability-meta";
import { metaDe, type StepOutcome } from "./contrat";
import { tenterRecours } from "./recours";
import { ecrireSortie } from "./sortie";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE DÉPLOIEMENT EN ÉVENTAIL (§10) — trente-trois étapes réelles, nées d'une seule.
 *
 * C'est ici que « le même code pour 3 et pour 3 000 » cesse d'être une intention. Le plan porte
 * UNE étape ; la collection n'existe qu'à l'exécution ; le graphe grandit avec les données.
 *
 * L'étape modèle ne disparaît pas : elle passe en ATTENTE de ses filles, ce qui fait que tout
 * ce qui dépendait d'elle attend naturellement les trente-trois. Aucune arête n'est réécrite —
 * et une réécriture d'arêtes en cours d'exécution serait exactement le genre d'opération qu'un
 * crash au mauvais moment laisserait à moitié faite.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export async function deployerEventail(
  etat: EtatMission,
  step: EtatEtape,
  eventail: { from: string; path: string; as: string },
): Promise<number> {
  const { from, path, as } = eventail;
  const source = etat.steps.find((s) => s.key === from);

  if (!source) {
    // L'ÉTAPE AMONT N'EXISTE PAS. Ce n'est pas un problème de forme, c'est un DAG faux — et
    // seul un nouveau plan le corrige. Le message le dit, plutôt que de laisser croire à une
    // liste manquante.
    const sortie: StepOutcome = {
      status: "FAILED",
      error: `l'éventail dépend de « ${from} », qui n'existe dans aucune version du plan.`,
      errorKind: "INCOMPATIBLE_RESULT",
      retryable: false,
    };
    if (await tenterRecours(etat, step, sortie, systemClock)) return 0;
    await ecrireSortie(etat, step, sortie, systemClock);
    return 0;
  }

  /**
   * ── CE QU'ON A TROUVÉ À LA PLACE DE LA LISTE, DIT PRÉCISÉMENT ──────────────────────
   *
   * Ce test était `if (!Array.isArray(lire(...)))`, et le message qui en sortait disait « il a
   * trouvé undefined ». Un run réel a montré ce que coûte cette phrase : elle est recopiée
   * telle quelle dans `refusPrecedent`, le planificateur n'en tire rien, et il récrit la même
   * recherche. Deux fois, pour cent neuf secondes de modèle.
   *
   * La cause réelle était invisible dans « undefined » : la recherche Drive n'avait rien trouvé
   * et l'avait dit EN FRANÇAIS, si bien que le résultat de l'étape amont ne portait plus de
   * structure du tout. Le plan était juste ; le chemin était juste.
   */
  const diagnostic = resoudreCollection(source.result, path);
  if (diagnostic.kind === "CORRIGEE") {
    // UNE SEULE LISTE = UNE CERTITUDE, et on l'inscrit au journal plutôt que de la taire. Le
    // cas ambigu, lui, tombe plus bas : on ne choisit jamais parmi plusieurs candidates.
    await journaliser(etat.id, "FANOUT_PATH_CORRIGE", expliquer(diagnostic, from, path), {
      stepKey: step.key, demande: path, retenu: diagnostic.chemin, elements: diagnostic.valeur.length,
    });
  }
  if (diagnostic.kind !== "LISTE" && diagnostic.kind !== "CORRIGEE") {
    // ── LE RECOURS D'ABORD, L'ÉCHEC ENSUITE ────────────────────────────────────────────
    //
    // Cet échec était écrit DIRECTEMENT en base, sans passer par `tenterRecours` : un
    // `INCOMPATIBLE_RESULT` n'ouvrait aucun recours et la mission mourait BLOCKED. Le
    // déploiement de l'éventail est un chemin d'échec comme un autre ; il emprunte la même porte.
    const sortie: StepOutcome = {
      status: "FAILED",
      error: expliquer(diagnostic, from, path),
      errorKind: "INCOMPATIBLE_RESULT",
      retryable: false,
    };
    if (await tenterRecours(etat, step, sortie, systemClock)) return 0;
    await ecrireSortie(etat, step, sortie, systemClock);
    return 0;
  }
  const collection = diagnostic.valeur;

  if (collection.length === 0) {
    // UNE COLLECTION VIDE N'EST PAS UNE ERREUR, et ce n'est pas non plus une étape « ignorée » :
    // l'étape a bel et bien tourné, elle a lu la liste, la liste était vide. « Écris à tous les
    // salariés en congé » quand il n'y en a aucun est une mission ACCOMPLIE. Le résultat porte
    // le zéro, pour que le contrôle qualité compte zéro attendu et non zéro manquant.
    await ecrireSortie(etat, step,
      { status: "DONE", result: { expanded: 0, keys: [], source: `${from}.${path}` } }, systemClock);
    return 0;
  }

  /**
   * DEUX ÉLÉMENTS, UNE IDENTITÉ → UNE SEULE ITÉRATION, ET C'EST DIT.
   *
   * L'upsert ci-dessous dédoublonne DÉJÀ en base (même clé = même ligne). Mais la première
   * écriture de ce fichier annonçait `expanded: cles.length` AVEC les doublons — le parent
   * disait « 3 itérations » quand la base en portait 2, et le contrôle qualité comptait une
   * incohérence éternelle sur une mission parfaitement saine. L'annonce dit désormais la
   * vérité de la base ; les identités fusionnées sont nommées au journal, jamais tues.
   */
  const clesVues = new Set<string>();
  const doublons: string[] = [];
  const cles: string[] = [];

  /**
   * ── CE QUE LES FILLES D'UN PLAN PRÉCÉDENT DEVIENNENT ────────────────────────────────────
   *
   * `update: {}` plus bas est juste pour une REPRISE : un second déploiement après panne doit
   * retrouver ses filles, jamais les remettre à zéro. Il est faux pour un REPLAN.
   *
   * Quand un nouveau plan reprend la mère, `materialiser` la réarme (§118.33). Elle redéploie —
   * et retrouve ses filles EN ÉCHEC, figées au plan précédent. Elles ne se termineront jamais,
   * la mère les attend, le regroupement recompte 0/1, et la mission remeurt exactement comme
   * avant : le trou d'un cran plus bas. Une fille appartient à la version de plan de sa mère ;
   * quand la mère change de version, ses filles en ÉCHEC repartent avec elle — les ABOUTIES
   * restent acquises (pas de second envoi), et leur clé d'idempotence n'est jamais touchée.
   */
  /**
   * ── UNE FILLE APPARTIENT AU JALON DE SA MÈRE (§118.68) ─────────────────────────────────
   *
   * MESURÉ LIVE, mission `cmttsao1f…`. Le jalon 1 s'appelle « les pièces réglementaires sont
   * officiellement SOLLICITÉES ». Le plan déploie l'envoi en éventail ; les deux filles
   * partent, aboutissent, et leur résultat dit « Message envoyé à Amel Haddad ». Le juge du
   * jalon, lui, ne charge que les étapes qui portent son `milestoneId` — donc la MÈRE, jamais
   * les filles. `attestationEffets` a lu leurs zéro reçu et a conclu, honnêtement :
   *
   *   « toutes les capacités appelées sont des lectures : AUCUNE écriture et AUCUN envoi.
   *     Aucune demande traçable n'est donc démontrée comme ayant été produite. »
   *
   * Le jalon a été refusé DEUX FOIS pour avoir fait exactement ce qu'on lui demandait : le
   * faux ÉCHEC symétrique du faux succès (§118.44), et il coûte aussi cher — une reprise de
   * jalon, un sous-plan neuf, une porte d'accord rouverte et un appel de juge à chaque tour.
   *
   * Tout le travail réel d'une mission massive vit dans les filles : les en priver de leur
   * jalon rend ce travail invisible à ce qui le juge, le compte et le contourne.
   */
  const mere = await prisma.missionStep.findUnique({
    where: { id: step.id }, select: { milestoneId: true },
  });
  const filles = await prisma.missionStep.findMany({
    where: { missionId: etat.id, key: { startsWith: `${step.key}#` } },
    select: { key: true, status: true, planVersion: true },
  });
  const aReprendre = new Map(filles
    .filter((f) => f.status === "FAILED" && f.planVersion < step.planVersion)
    .map((f) => [f.key, f] as const));

  for (const [i, element] of collection.entries()) {
    const cle = `${step.key}#${identiteIteration(element, i)}`;
    if (clesVues.has(cle)) {
      doublons.push(cle);
      continue;
    }
    clesVues.add(cle);
    cles.push(cle);
    /**
     * L'ENTRÉE DE CETTE FILLE, ET CE QUE L'ÉLÉMENT N'A PAS PU DONNER (§118.71).
     *
     * `manquantes` n'est jamais vide par hasard : c'est un chemin que le plan a écrit et que
     * l'élément ne porte pas. La fille échouera donc à coup sûr — autant le dire AVANT de
     * payer l'appel de capacité, et le dire avec les champs réellement disponibles plutôt que
     * de laisser l'outil accuser l'annuaire (règle 20 du planificateur).
     */
    const iteration = entreeIteration(step.input, as, element);
    await prisma.missionStep.upsert({
      where: { missionId_key: { missionId: etat.id, key: cle } },
      create: {
        missionId: etat.id,
        key: cle,
        title: `${step.title} — ${identiteIteration(element, i)}`,
        workstream: step.workstream,
        nodeType: step.nodeType,
        capability: step.capability,
        input: iteration.entree as never,
        maxAttempts: step.maxAttempts,
        // LES FILLES HÉRITENT DE L'EXIGENCE DE CLÉ. Ce sont ELLES qui envoient réellement les
        // trente-trois messages ; l'oublier ici viderait §15 de son sens exactement là où il
        // compte — la première écriture de ce fichier le faisait, et les trente-trois clés
        // arrivaient nulles.
        needsIdempotencyKey: step.needsIdempotencyKey,
        // ET DE LA SPÉCIFICATION, pour la même raison : c'est la fille qui appelle le modèle,
        // donc c'est elle qui doit porter le schéma de sortie exigé et sa condition de fin.
        spec: (step.spec ?? undefined) as never,
        planVersion: step.planVersion,
        // LE JALON DE LA MÈRE — sans quoi le travail réel est invisible au juge du jalon.
        milestoneId: mere?.milestoneId ?? null,
        status: "PENDING",
      },
      // UNE ITÉRATION DÉJÀ CRÉÉE N'EST PAS RÉÉCRITE : un second déploiement (reprise après
      // panne) doit retrouver les filles, jamais les remettre à zéro.
      update: {},
    });

    if (aReprendre.has(cle)) {
      await prisma.missionStep.update({
        where: { missionId_key: { missionId: etat.id, key: cle } },
        data: {
          status: "PENDING", attempt: 0, error: null, errorKind: null,
          startedAt: null, completedAt: null, supersededAt: null,
          planVersion: step.planVersion,
          title: `${step.title} — ${identiteIteration(element, i)}`,
          input: iteration.entree as never,
          spec: (step.spec ?? undefined) as never,
          // UNE FILLE RÉARMÉE SUIT SA MÈRE, jalon compris : un replan peut avoir déplacé la
          // mère d'un jalon à l'autre, et une fille restée sur l'ancien serait jugée deux fois.
          milestoneId: mere?.milestoneId ?? null,
        },
      });
    }

    /**
     * ── UN CHEMIN QUE L'ÉLÉMENT NE PORTE PAS SE DIT ICI, PAS À L'ARRIVÉE (§118.71) ────────
     *
     * Sans cela, `JSON.stringify` efface la clé non résolue, la capacité reçoit une entrée
     * AMPUTÉE, et son refus accuse la mauvaise cause — mesuré : « Destinataire « (rien) »
     * introuvable » sur une itération nommée `#Amel Haddad`. Le planificateur suivant est
     * parti chercher une personne au lieu de corriger un chemin.
     *
     * L'échec est DÉFINITIF (tentatives épuisées) : réessayer ne fera pas apparaître un champ
     * que l'élément n'a pas. Et il ne touche qu'une fille encore devant nous — une itération
     * déjà ABOUTIE garde son acquis, comme partout ailleurs (§118.33).
     */
    if (iteration.manquantes.length > 0) {
      const dit = iteration.manquantes
        .map((m) => `{{${m.reference}}}${m.disponibles.length > 0 ? ` (l'élément porte : ${m.disponibles.join(", ")})` : " (l'élément ne porte aucun champ)"}`)
        .join(" ; ");
      const majAbsente = await prisma.missionStep.updateMany({
        where: { missionId: etat.id, key: cle, status: { in: ["PENDING", "READY"] } },
        data: {
          // `INVALID_STEP` est LE motif de la référence morte `{{etape.champ}}` — c'est
          // exactement ce dont il s'agit, un cran plus bas. Inventer un motif de plus le
          // rendrait invisible à `tenterRecours`, qui rejette d'entrée ce qu'il ne connaît
          // pas : un manque non classé est un manque invisible (§118.31).
          status: "FAILED", attempt: step.maxAttempts, errorKind: "INVALID_STEP",
          error: `l'élément de l'itération ne porte pas ce que le plan lui demande : ${dit}. `
            + `Corrige le chemin — ou référence l'élément entier avec {{${as}}} s'il EST la valeur.`,
          completedAt: new Date(),
        },
      });
      if (majAbsente.count > 0) {
        await journaliser(etat.id, "STEP_FAILED",
          `Étape « ${step.title} — ${identiteIteration(element, i)} » en échec avant exécution : ${dit}`,
          { stepKey: cle, errorKind: "INVALID_STEP", retryable: false, manquantes: iteration.manquantes });
      }
    }

    // Les filles héritent des dépendances du modèle, pas du modèle lui-même : dépendre de lui
    // fermerait un cycle, puisque lui attend ses filles.
    for (const d of step.dependsOn) {
      const parent = etat.steps.find((s) => s.key === d);
      const fille = await prisma.missionStep.findUnique({
        where: { missionId_key: { missionId: etat.id, key: cle } }, select: { id: true },
      });
      if (parent && fille) {
        await prisma.missionStepDep.upsert({
          where: { stepId_dependsOnId: { stepId: fille.id, dependsOnId: parent.id } },
          create: { stepId: fille.id, dependsOnId: parent.id },
          update: {},
        });
      }
    }
  }

  await prisma.missionStep.update({
    where: { id: step.id },
    data: { status: "WAITING", result: { expanded: cles.length, keys: cles } as never },
  });
  const reprises = cles.filter((c) => aReprendre.has(c));
  await journaliser(etat.id, "FANOUT",
    `« ${step.title} » déployée en ${cles.length} étapes individuelles.`
    + (reprises.length > 0
      ? ` ${reprises.length} itération(s) en échec sous le plan précédent sont REPRISES par celui-ci : ${reprises.slice(0, 5).join(", ")}.`
      : "")
    + (doublons.length > 0
      ? ` ${doublons.length} élément(s) partageaient une identité déjà déployée — fusionnés, pas dupliqués : ${[...new Set(doublons)].slice(0, 5).join(", ")}.`
      : ""),
    { stepKey: step.key, count: cles.length, ...(doublons.length > 0 ? { fusionnes: doublons.length } : {}), ...(reprises.length > 0 ? { reprises: reprises.length } : {}) });

  return cles.length;
}

/**
 * FERME LES ÉVENTAILS DONT TOUTES LES FILLES SONT TERMINÉES.
 *
 * Le modèle attend ; quand plus rien ne bouge, on regarde s'il peut conclure. Il conclut en
 * ÉCHEC si une fille a échoué définitivement — sinon un envoi manquant sur trente-trois
 * passerait pour un succès, ce qui est précisément ce que le §22 interdit.
 */
export async function resoudreEventails(etat: EtatMission, catalog?: CapabilityCatalog): Promise<number> {
  let resolus = 0;
  for (const step of etat.steps) {
    if (step.status !== "WAITING") continue;
    const r = step.result as { keys?: unknown } | null;
    // Dédoublonné DÉFENSIVEMENT : un résultat écrit avant le correctif d'annonce (voir le
    // déploiement) peut porter deux fois la même clé — la refermer au compte des doublons
    // referait exactement l'incohérence qu'on vient d'éteindre.
    const cles = Array.isArray(r?.keys)
      ? [...new Set((r!.keys as unknown[]).filter((k): k is string => typeof k === "string"))]
      : [];
    if (cles.length === 0) continue;

    const filles = etat.steps.filter((s) => cles.includes(s.key));
    // « RÉGLÉE » N'EST PAS « TERMINÉE ». Une fille en échec définitif ne reviendra jamais : si on
    // exigeait qu'elle finisse bien, le modèle attendrait pour toujours et la mission se
    // figerait sur un envoi raté. On ferme donc sur l'épuisement des tentatives — et on ferme en
    // ÉCHEC, ce qui est précisément la différence entre « fini » et « réussi » (§22).
    const reglee = (f: typeof filles[number]) => STEP_TERMINAL.has(f.status)
      || (f.status === "FAILED" && f.attempt >= f.maxAttempts);
    if (filles.length === 0 || !filles.every(reglee)) continue;

    const echecs = filles.filter((f) => f.status === "FAILED");
    const faites = filles.filter((f) => f.status === "DONE").length;

    /**
     * UNE LECTURE MANQUÉE EST UNE INFORMATION ; UNE ÉCRITURE MANQUÉE EST UNE DETTE (§28).
     *
     * Un éventail d'ÉCRITURE partiellement échoué DOIT échouer : trois vœux non partis sur
     * trente-trois ne se maquillent pas en succès (§22). Un éventail de LECTURE, lui, pose des
     * questions — et « ce document n'a pas pu être lu (paiement du stockage requis) » est une
     * RÉPONSE, pas une panne : la fermer en échec envoyait la mission au recours puis au
     * replan, qui relisait le même mur (mesuré au Run 3 : spirale de replans vides sur des
     * fiches dont UNE cible sur trois était illisible). L'éventail de lecture conclut donc,
     * avec ses manques NOMMÉS dans son résultat — l'étape aval les DIT, le juge les lit, et
     * rien n'est perdu : chaque échec garde son reçu et son erreur sur sa fille.
     */
    const effet = step.capability ? metaDe(step.capability, catalog).effect : "ANALYZE";
    const lectureSeule = EFFECT_RANK[effet] <= EFFECT_RANK.ANALYZE;
    const statut = echecs.length > 0 && !lectureSeule ? "FAILED" : "DONE";

    await prisma.missionStep.update({
      where: { id: step.id },
      data: {
        status: statut,
        attempt: step.maxAttempts,
        completedAt: new Date(),
        result: {
          expanded: cles.length, done: faites, failed: echecs.length, keys: cles,
          ...(echecs.length > 0
            ? { echecs: echecs.map((f) => ({ key: f.key, error: f.error ?? "échec sans message" })) }
            : {}),
        } as never,
        ...(statut === "FAILED"
          ? { error: `${echecs.length} itération(s) sur ${cles.length} en échec.`, errorKind: "PARTIAL_FANOUT" }
          : {}),
      },
    });
    await journaliser(etat.id, echecs.length > 0 ? "FANOUT_PARTIAL" : "FANOUT_DONE",
      `« ${step.title} » : ${faites}/${cles.length} itérations réussies.`,
      { stepKey: step.key, done: faites, failed: echecs.length });
    resolus += 1;
  }
  return resolus;
}
