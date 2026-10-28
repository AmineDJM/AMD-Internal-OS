import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { prendreBail } from "@/lib/missions/runtime/bail";
import type { CompiledMission, StepSpec } from "@/lib/missions/compiler/compile";
import { MissionState, StepState, assertTransition } from "@/lib/missions/runtime/state";
import { lireRecu, type ExecutionReceipt } from "@/lib/missions/runtime/receipt";
import { criteresQuiSurvivent } from "@/lib/missions/goal/rules";
import { sansBloquer } from "@/lib/journal";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA PERSISTANCE — une mission survit à tout ce qui peut l'interrompre (§3).
 *
 * ── CE QU'ELLE DOIT SURVIVRE, LITTÉRALEMENT ──────────────────────────────────────────────
 *
 * L'application fermée, la connexion coupée, le serveur redémarré, le fournisseur en erreur,
 * cinq jours d'attente. Aucune de ces situations n'est exceptionnelle sur une mission de
 * plusieurs jours : ce sont les conditions NORMALES d'existence d'une mission longue.
 *
 * ── POURQUOI IL N'Y A PAS DE TABLE DE POINTS DE REPRISE ──────────────────────────────────
 *
 * Parce qu'une étape TERMINÉE, avec son reçu, EST le point de reprise. Une seconde table
 * dirait la même chose une deuxième fois, et divergerait le jour où un chemin d'erreur
 * n'écrirait que l'une des deux. Au redémarrage, le moteur relit les étapes : celles qui
 * portent un reçu ne sont pas rejouées. C'est tout le mécanisme, et il tient en une phrase.
 *
 * ── LA RÉ-ENTRANCE ───────────────────────────────────────────────────────────────────────
 *
 * `materialiser` peut être rappelée sur la même mission sans rien dupliquer : la clé d'étape
 * est unique par mission, en BASE. Ce n'est pas une politesse — un replan la rappelle, et une
 * duplication produirait un second envoi.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface MaterialiserOptions {
  ownerId: string;
  title: string;
  goalRaw: string;
  parentMissionId?: string | null;
  maxConcurrency?: number;
  /** Des CLÉS supplémentaires de la carte du plan (version du prompt, politiques servies) — fusionnées, jamais substituées. */
  planMetaExtra?: Record<string, unknown>;
  /** Quand elle est fournie, on MET À JOUR cette mission au lieu d'en créer une (replan). */
  missionId?: string;
  /**
   * LE JALON DONT CE PLAN EST LE SOUS-PLAN — la clé de la compilation paresseuse.
   *
   * Quand elle est présente, TOUT ce que cette fonction fait de destructeur est borné à ce
   * jalon : seules ses étapes peuvent être contournées, seules ses étapes sont réarmées. Sans
   * cette borne, compiler le jalon 2 marquerait « contournées » toutes les étapes du jalon 1 —
   * elles ne figurent pas dans `compiled.steps` — et la mission perdrait son propre acquis à
   * chaque jalon franchi. C'est le défaut le plus destructeur que la compilation par jalons
   * pouvait introduire, et il est fermé ici, à sa source.
   */
  milestoneId?: string | null;
}

/** Ce que le moteur relit au démarrage : l'état exact, sans rien reconstruire de mémoire. */
export interface EtatMission {
  id: string;
  status: MissionState;
  /** La naissance de la mission — pour juger si elle s'est terminée « dans la foulée » de la demande. */
  createdAt?: Date;
  ownerId: string;
  planVersion: number;
  maxConcurrency: number;
  acceptance: string[];
  goalRaw: string;
  objective: string;
  /**
   * LA CARTE DU PLAN telle que le planificateur l'a rendue : axes, livrables attendus,
   * stratégie d'accord, critère arithmétique de fin. Lue par le contrôle qualité (qui vérifie
   * que les livrables annoncés existent) et par le juge (qui lit le critère de fin).
   */
  planMeta: Record<string, unknown>;
  /**
   * L'HORIZON EST-IL ENCORE OUVERT — reste-t-il un jalon qui n'a pas abouti ?
   *
   * C'est ce qui empêche `conclure` de juger une mission longue à la fin de son PREMIER jalon.
   * Sans ce booléen, une mission de sept jalons conclurait au bout du premier : toutes ses
   * étapes seraient terminales, le juge lirait l'objectif entier et le déclarerait non atteint,
   * et la mission mourrait BLOCKED avec six jalons jamais compilés. Le faux échec symétrique
   * du faux succès.
   *
   * `false` pour une mission courte, qui n'a pas de jalons du tout : rien ne change pour elle.
   */
  horizonOuvert: boolean;
  steps: EtatEtape[];
}

export interface EtatEtape {
  id: string;
  key: string;
  title: string;
  workstream: string;
  nodeType: string;
  capability: string | null;
  input: Record<string, unknown>;
  status: StepState;
  attempt: number;
  maxAttempts: number;
  idempotencyKey: string | null;
  result: unknown;
  receipt: string | null;
  /**
   * LE REÇU STRUCTURÉ — ce que le code a constaté de l'appel (§ `runtime/receipt.ts`).
   *
   * `null` quand l'étape n'appelle aucune capacité, ou quand elle a été écrite par une version
   * antérieure du moteur. Jamais un reçu vide : une absence de mesure se dit, elle ne s'invente
   * pas — c'est la même règle que `resultCount: null` ≠ `0`.
   */
  recu: ExecutionReceipt | null;
  error: string | null;
  errorKind: string | null;
  waitFor: Record<string, unknown> | null;
  /** { from, path, as } — non nul quand l'étape est un MODÈLE à démultiplier (§10). */
  forEach: { from: string; path: string; as: string } | null;
  /** Ce que le MOTEUR doit savoir pour exécuter l'étape — schéma de sortie, condition de fin. */
  spec: StepSpec | null;
  /** Ce qui a déjà été tenté pour récupérer cette étape — relu tel quel, jamais cru sur parole. */
  recovery: unknown;
  needsIdempotencyKey: boolean;
  planVersion: number;
  /**
   * LE PLAN COURANT NE PORTE PLUS CETTE ÉTAPE.
   *
   * Elle reste au dossier — statut, erreur et motif intacts — mais elle n'est plus une
   * obligation : ni `deduireEtat`, ni le contrôle qualité, ni le répartiteur ne la regardent.
   * Sans cette distinction, une étape en échec d'un plan abandonné bloque tous les suivants.
   */
  contournee: boolean;
  dependsOn: string[];
}

const asObj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const asStrings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/**
 * L'éventail relu depuis la base — RETYPÉ, jamais cru sur parole.
 *
 * Un JSON en base peut avoir été écrit par une version antérieure du code. Un `from` manquant
 * ferait chercher la collection dans une étape nommée « undefined » ; mieux vaut n'y voir aucun
 * éventail et laisser l'étape s'exécuter normalement.
 */
function lireEventail(v: unknown): { from: string; path: string; as: string } | null {
  const o = asObj(v);
  const from = typeof o.from === "string" ? o.from : "";
  const path = typeof o.path === "string" ? o.path : "";
  const as = typeof o.as === "string" ? o.as : "";
  return from && path && as ? { from, path, as } : null;
}

/**
 * ÉCRIT LE PLAN COMPILÉ EN BASE, et rend l'identifiant de la mission.
 *
 * ── POURQUOI LES ARÊTES SONT ÉCRITES APRÈS LES NŒUDS, EN DEUX TEMPS ─────────────────────
 *
 * Une arête référence deux étapes par leur identifiant de base ; elles doivent donc toutes
 * exister d'abord. On aurait pu stocker les dépendances en JSON sur l'étape et s'épargner la
 * table — au prix de ne plus pouvoir demander « quelles étapes attendent celle-ci ? » sans
 * relire toute la mission. Le moteur pose cette question à chaque étape terminée.
 */
export async function materialiser(
  compiled: CompiledMission,
  opts: MaterialiserOptions,
): Promise<string> {
  const donneesMission = {
    kind: "RUNTIME",
    title: opts.title,
    objective: compiled.objective,
    goalRaw: opts.goalRaw,
    acceptance: compiled.acceptance,
    complexity: compiled.complexity,
    scale: compiled.scale,
    maxConcurrency: opts.maxConcurrency ?? 6,
    parentMissionId: opts.parentMissionId ?? null,
    planMeta: { ...compiled.planMeta, ...(opts.planMetaExtra ?? {}) } as never,
  };

  /**
   * ── UN REPLAN N'ABAISSE JAMAIS LA BARRE (§10) ──────────────────────────────────────────
   *
   * Le plan v2 peut AJOUTER une exigence — c'est souvent ce que le juge a demandé. Il ne peut
   * pas en RETIRER une : sans quoi la partie recalée réécrirait elle-même la barre, et
   * conclurait COMPLETED dessus. L'union est transitive, donc l'exigence d'origine survit à
   * toutes les réécritures.
   *
   * `criteresQuiSurvivent` écarte les règles liées à des étapes que le nouveau plan n'a plus :
   * les reporter condamnerait la mission avant qu'elle commence. La barre voyage, la tuyauterie
   * qui la vérifiait non — elle est reconstruite par le compilateur pour le plan courant.
   */
  const ligne = opts.missionId
    ? await prisma.mission.findUnique({ where: { id: opts.missionId }, select: { acceptance: true } }).catch(sansBloquer("runtime-store.materialiser.mission", null))
    : null;
  const anciens: string[] = Array.isArray(ligne?.acceptance)
    ? (ligne.acceptance as unknown[]).filter((x): x is string => typeof x === "string")
    : [];
  const clesReportables = new Set(compiled.steps.map((e) => e.key));
  const acceptanceCumulee = [...new Set([...criteresQuiSurvivent(anciens, clesReportables), ...compiled.acceptance])];

  const mission = opts.missionId
    ? await prisma.mission.update({
        where: { id: opts.missionId },
        // LE REPLAN INCRÉMENTE LA VERSION plutôt que d'effacer l'ancienne (§21). Les étapes déjà
        // faites gardent leur version : c'est ce qui permet de dire « ceci a été fait sous le
        // plan 1 » au lieu de laisser croire que le plan actuel a tout produit.
        data: { ...donneesMission, acceptance: acceptanceCumulee, planVersion: { increment: 1 } },
      })
    : await prisma.mission.create({
        data: { ...donneesMission, ownerId: opts.ownerId, status: "PLANNING" },
      });

  const version = mission.planVersion;

  // LE BAIL DÈS LA NAISSANCE. L'instance qui écrit le plan est celle qui va le conduire : sans
  // bail, un battement voisin (autre processus, autre déploiement) pouvait prendre la mission
  // entre l'écriture des étapes et le premier tour — mesuré sur le banc : une mission qui devait
  // dormir jusqu'à demain 10 h se retrouvait BLOQUÉE par un exécutant qui n'était pas le sien.
  await prendreBail(mission.id);

  // ── 1. LES NŒUDS ────────────────────────────────────────────────────────────────────
  for (const s of compiled.steps) {
    await prisma.missionStep.upsert({
      where: { missionId_key: { missionId: mission.id, key: s.key } },
      create: {
        missionId: mission.id,
        key: s.key,
        title: s.title,
        workstream: s.workstream ?? "default",
        nodeType: s.nodeType,
        capability: s.capability,
        input: s.input as never,
        maxAttempts: s.maxAttempts,
        waitFor: (s.waitFor ?? undefined) as never,
        forEach: (s.forEach ?? undefined) as never,
        spec: (s.spec ?? undefined) as never,
        needsIdempotencyKey: s.needsIdempotencyKey,
        planVersion: version,
        milestoneId: opts.milestoneId ?? null,
        status: "PENDING",
      },
      // UNE ÉTAPE DÉJÀ TERMINÉE N'EST PAS RÉÉCRITE — c'est l'invariant qui protège du double
      // envoi lors d'un replan. On ne met à jour que ce qui est encore devant nous.
      update: {},
    });
  }

  /**
   * ── 1 ter. UNE ÉTAPE QUE LE NOUVEAU PLAN REPREND EST RÉARMÉE ────────────────────────────
   *
   * L'invariant ci-dessus — « une étape terminée n'est pas réécrite » — est juste pour un
   * ACQUIS : un envoi parti ne repart pas. Appliqué à un ÉCHEC, il tue la mission, et c'est
   * mesuré.
   *
   * Chaîne regulatory, mission cmtsdqc17… : deux envois échouent (destinataire illisible), le
   * plan v2 les REPREND et accroche ses six attentes dessus. L'upsert laisse les deux lignes en
   * FAILED. Une étape FAILED ne se termine jamais ; ses dépendantes ne deviennent jamais
   * READY ; et comme TOUT le plan v2 en descend, il n'a pas UNE seule racine exécutable.
   * 18 étapes compilées, profondeur 12, zéro exécutable. Le moteur a repris la main, n'a rien
   * trouvé à faire, et `deduireEtat` a rendu BLOCKED — honnêtement, sur un plan mort-né. Aucun
   * réveil, aucune attente levée, aucun livrable, et pas un seul événement disant pourquoi.
   *
   * Reprendre une étape dans un plan, c'est demander qu'elle soit RE-tentée. On la réarme donc :
   * statut, compteur de tentatives et motif d'échec repartent à zéro.
   *
   * ── UNE ÉTAPE IGNORÉE N'EST PAS UN ACQUIS : IL NE S'EST RIEN PASSÉ (§118.67) ───────────
   *
   * SKIPPED figurait ici parmi les acquis, avec la même justification que DONE — « pas de
   * second envoi ». Elle est FAUSSE : une étape ignorée n'a jamais envoyé. Le moteur écarte
   * AVANT d'exécuter, dans les quatre cas qui produisent ce statut (condition non remplie,
   * éventail sur une liste vide, éventail dont la source n'a pas abouti, contrôleur qualité
   * absent). Aucun effet, aucun reçu, rien à protéger.
   *
   * MESURÉ, mission `cmttakgtd…` : les deux étapes ARTIFACT sont ignorées parce que la
   * complétude des données amont vaut `false`. Gelées en SKIPPED, elles ne peuvent plus
   * revenir : un plan v10 qui les REPREND les retrouve terminales, et le livrable est mort
   * pour toujours — sans qu'aucune étape soit en échec, donc sans que rien ne le dise. C'est
   * §118.33 à l'identique, sur l'autre statut terminal-mais-vide.
   *
   * Réarmer ne relance pas la branche à tort : la condition est RÉÉVALUÉE sur l'état amont
   * COURANT. Une relance ignorée parce que la personne avait répondu sera ignorée de nouveau,
   * pour un test pur, sans appel de modèle. Ce qui change, c'est le cas où l'amont a bougé
   * entre-temps — précisément celui qu'un replan existe pour rattraper.
   *
   * DEUX BORNES :
   *   — DONE reste acquis (pas de second envoi), RUNNING appartient à l'exécutant en cours,
   *     CANCELLED est une décision humaine ;
   *   — `idempotencyKey` est CONSERVÉE. Une étape peut échouer APRÈS avoir produit son effet ;
   *     c'est le reçu (`AssistantActionIntent`, §118.5) qui empêche le doublon, pas le statut.
   */
  const REARMABLES = ["FAILED", "SKIPPED"];
  const areArmer = await prisma.missionStep.findMany({
    where: { missionId: mission.id, key: { in: compiled.steps.map((s) => s.key) }, status: { in: REARMABLES } },
    select: { id: true, key: true, attempt: true, status: true },
  });
  if (areArmer.length > 0) {
    await prisma.missionStep.updateMany({
      where: { id: { in: areArmer.map((s) => s.id) } },
      data: {
        status: "PENDING", attempt: 0, error: null, errorKind: null,
        startedAt: null, completedAt: null, planVersion: version,
        ...(opts.milestoneId ? { milestoneId: opts.milestoneId } : {}),
      },
    });
    await journaliser(mission.id, "PLAN_COMPILED",
      `Plan v${version} : ${areArmer.length} étape(s) en échec ou ignorées sont REPRISES par le nouveau `
      + `plan et réarmées — sans quoi tout ce qui en dépend resterait à jamais inexécutable : `
      + `${areArmer.map((s) => `${s.key} (${s.status})`).join(", ")}.`,
      { planVersion: version, rearmees: areArmer.map((s) => ({ key: s.key, statutPrecedent: s.status, tentativesPrecedentes: s.attempt })) });
  }

  /**
   * LA PORTÉE DU CONTOURNEMENT SUIT LE JALON. (§118.43)
   *
   * `enBase` sert à deux choses : retrouver les identifiants pour écrire les arêtes (il faut
   * alors TOUTES les étapes, y compris celles des autres jalons, parce qu'un sous-plan peut
   * légitimement dépendre d'un acquis d'un jalon précédent), et décider ce que le nouveau plan
   * a contourné (il faut alors les étapes DE CE JALON seulement). Deux questions, deux listes.
   */
  const enBase = await prisma.missionStep.findMany({
    where: { missionId: mission.id },
    select: { id: true, key: true, status: true, milestoneId: true },
  });
  const parCle = new Map(enBase.map((s) => [s.key, s]));
  const duPerimetre = opts.milestoneId
    ? enBase.filter((s) => s.milestoneId === opts.milestoneId)
    : enBase;

  /**
   * ── UN REPLAN DOIT POUVOIR RETIRER, PAS SEULEMENT AJOUTER (§118.67) ───────────────────
   *
   * Le rafraîchissement des étapes NON commencées : titre, entrée, dépendances peuvent avoir
   * changé au replan. Celles qui tournent ou sont finies gardent ce sous quoi elles ont tourné.
   *
   * `?? undefined` sur une colonne JSON était un piège SILENCIEUX : pour Prisma, `undefined`
   * signifie « ne touche pas à ce champ », pas « mets-le à vide ». Une étape dont le nouveau
   * plan RETIRE la condition, l'attente ou l'éventail gardait donc l'ancienne — et le plan v2
   * écrit exactement pour lever une condition ne la levait pas. Mesuré au banc : l'étape
   * réarmée reprenait le `when` du plan v1 et se faisait ignorer une seconde fois, sur une
   * condition qu'aucun plan ne portait plus. `Prisma.DbNull` dit VIDE.
   */
  for (const s of compiled.steps) {
    const ligne = parCle.get(s.key);
    if (!ligne || ligne.status !== "PENDING") continue;
    await prisma.missionStep.update({
      where: { id: ligne.id },
      data: {
        title: s.title,
        workstream: s.workstream ?? "default",
        nodeType: s.nodeType,
        capability: s.capability,
        input: s.input as never,
        maxAttempts: s.maxAttempts,
        waitFor: (s.waitFor ?? Prisma.DbNull) as never,
        forEach: (s.forEach ?? Prisma.DbNull) as never,
        spec: (s.spec ?? Prisma.DbNull) as never,
        needsIdempotencyKey: s.needsIdempotencyKey,
        planVersion: version,
      },
    });
  }

  /**
   * ── 1 bis. CE QUE LE NOUVEAU PLAN A CONTOURNÉ ────────────────────────────────────────
   *
   * LE DÉFAUT QUE CE BLOC FERME, mesuré sur un run Render. Le scénario RECOURS voit son étape
   * « lecture-drive-contracts » échouer sous le plan v1, tentatives épuisées. Le plan v2 ne la
   * reprend pas : il passe par Legal, les courriers et le contenu des documents, et ses neuf
   * étapes aboutissent. La mission revient pourtant BLOCKED, replanifie deux fois de plus, et le
   * juge d'objectif n'est JAMAIS atteint — parce que `deduireEtat` compte encore comme un échec
   * courant une étape qu'aucun plan ne porte plus.
   *
   * UNE OBLIGATION APPARTIENT AU PLAN COURANT. Une étape que le nouveau plan ne reprend pas est
   * de l'HISTOIRE : elle garde son statut, son erreur et son motif — le juge et l'écran doivent
   * pouvoir dire « ceci a été tenté sous le plan 1 et n'a pas abouti » — mais elle ne décide plus
   * de l'état de la mission.
   *
   * DEUX BORNES, ET ELLES COMPTENT AUTANT L'UNE QUE L'AUTRE :
   *
   *   — on ne marque JAMAIS une étape ABOUTIE. Un acquis reste un acquis, et le nouveau plan a le
   *     droit d'en dépendre (`acquises` dans `compile`). L'effacer ferait refaire un envoi ;
   *   — on DÉMARQUE ce que le nouveau plan reprend. Un plan v3 qui réessaie ce que v2 avait
   *     abandonné doit le voir redevenir une obligation, sinon la mission conclurait sur une
   *     étape qu'elle a cessé de regarder.
   */
  const clesDuPlan = new Set(compiled.steps.map((s) => s.key));
  const ACQUIS: readonly string[] = ["DONE", "SKIPPED"];
  /**
   * LES FILLES D'UN ÉVENTAIL NE SONT PAS « CONTOURNÉES » : ELLES APPARTIENNENT À LEUR MÈRE.
   *
   * Un plan ne LISTE jamais une fille — elle naît à l'exécution, de la liste que l'amont a
   * rendue. Sans cette ligne, la fille d'une mère parfaitement reprise serait marquée
   * contournée à chaque replan, disparaîtrait du comptage de sa mère, et l'éventail
   * recompterait « 0/2 » sur deux envois réellement partis. C'est le trou qu'ouvre le fait de
   * leur donner enfin un `milestoneId` (§118.68) : sans lui, elles étaient hors périmètre par
   * accident, et l'accident tenait lieu de règle.
   *
   * Le contournement d'une mère, lui, reste : c'est le geste juste quand le plan l'abandonne.
   */
  const contournees = duPerimetre.filter((s) =>
    !clesDuPlan.has(s.key) && !ACQUIS.includes(s.status) && !s.key.includes("#"));
  if (contournees.length > 0) {
    await prisma.missionStep.updateMany({
      where: { id: { in: contournees.map((s) => s.id) }, supersededAt: null },
      data: { supersededAt: new Date() },
    });
    await journaliser(mission.id, "PLAN_COMPILED",
      `Plan v${version} : ${contournees.length} étape(s) contournée(s) — elles restent au dossier, `
      + `elles ne bloquent plus : ${contournees.map((s) => s.key).join(", ")}.`,
      { planVersion: version, contournees: contournees.map((s) => ({ key: s.key, statut: s.status })) });
  }
  await prisma.missionStep.updateMany({
    where: { missionId: mission.id, key: { in: [...clesDuPlan] }, supersededAt: { not: null } },
    data: { supersededAt: null },
  });

  // ── 2. LES ARÊTES ───────────────────────────────────────────────────────────────────
  for (const s of compiled.steps) {
    const cible = parCle.get(s.key);
    if (!cible) continue;
    for (const d of s.dependsOn) {
      const source = parCle.get(d);
      if (!source) continue;
      await prisma.missionStepDep.upsert({
        where: { stepId_dependsOnId: { stepId: cible.id, dependsOnId: source.id } },
        create: { stepId: cible.id, dependsOnId: source.id },
        update: {},
      });
    }
  }

  await journaliser(mission.id, "PLAN_COMPILED",
    `Plan v${version} : ${compiled.steps.length} étapes, profondeur ${compiled.depth}, `
    + `effet maximal ${compiled.maxEffect}.`,
    { planVersion: version, steps: compiled.steps.length, maxEffect: compiled.maxEffect, capabilities: compiled.capabilities });

  return mission.id;
}

/** RELIT TOUT L'ÉTAT. Le moteur ne garde rien en mémoire d'un tour à l'autre — c'est ce qui le rend reprenable. */
export async function chargerEtat(missionId: string): Promise<EtatMission | null> {
  const m = await prisma.mission.findUnique({
    where: { id: missionId },
    include: {
      steps: {
        include: { deps: { include: { dependsOn: { select: { key: true } } } } },
        // L'ORDRE EST STABLE, ET C'EST NÉCESSAIRE : sans lui, Postgres rend les étapes dans
        // l'ordre où il les trouve, qui change avec les mises à jour. L'écran de mission
        // réordonnerait ses lignes à chaque rafraîchissement, et un test comparant une liste
        // d'étapes échouerait un jour sur deux sans qu'aucun code ait bougé.
        orderBy: [{ createdAt: "asc" }, { key: "asc" }],
      },
    },
  });
  if (!m) return null;

  // UNE SEULE QUESTION, INDEXÉE : reste-t-il un jalon vivant ? On ne charge pas les jalons ici —
  // le pilote d'horizon les lit quand il en a besoin, et le moteur n'a besoin que du booléen.
  const jalonsVivants = await prisma.missionMilestone.count({
    where: { missionId, statut: { notIn: ["DONE", "SKIPPED", "CANCELLED"] } },
  });

  return {
    id: m.id,
    status: m.status as MissionState,
    createdAt: m.createdAt,
    ownerId: m.ownerId,
    planVersion: m.planVersion,
    maxConcurrency: m.maxConcurrency,
    acceptance: asStrings(m.acceptance),
    goalRaw: m.goalRaw ?? m.objective,
    objective: m.objective,
    planMeta: asObj(m.planMeta),
    horizonOuvert: jalonsVivants > 0,
    steps: m.steps.map((s) => ({
      id: s.id,
      key: s.key,
      title: s.title,
      workstream: s.workstream,
      nodeType: s.nodeType,
      capability: s.capability,
      input: asObj(s.input),
      status: s.status as StepState,
      attempt: s.attempt,
      maxAttempts: s.maxAttempts,
      idempotencyKey: s.idempotencyKey,
      result: s.result,
      receipt: s.receipt,
      recu: lireRecu(s.receiptData),
      error: s.error,
      errorKind: s.errorKind,
      waitFor: s.waitFor ? asObj(s.waitFor) : null,
      forEach: lireEventail(s.forEach),
      spec: s.spec ? (asObj(s.spec) as StepSpec) : null,
      recovery: s.recovery ?? null,
      needsIdempotencyKey: s.needsIdempotencyKey,
      planVersion: s.planVersion,
      contournee: s.supersededAt !== null,
      dependsOn: s.deps.map((d) => d.dependsOn.key),
    })),
  };
}

/**
 * CHANGE L'ÉTAT DE LA MISSION — en passant par la machine à états, jamais autour.
 *
 * L'assertion lève : une transition impossible est un bug du moteur, et le découvrir trois
 * jours plus tard sur une mission incohérente coûte infiniment plus cher qu'un plantage net.
 */
export async function transitionner(
  missionId: string,
  vers: MissionState,
  raison?: string,
): Promise<void> {
  const m = await prisma.mission.findUnique({ where: { id: missionId }, select: { status: true } });
  if (!m) throw new Error(`mission introuvable : ${missionId}`);
  const depuis = m.status as MissionState;
  if (depuis === vers) return;
  assertTransition(depuis, vers);

  await prisma.mission.update({
    where: { id: missionId },
    data: {
      status: vers,
      ...(vers === "RUNNING" ? { startedAt: new Date() } : {}),
      ...(vers === "COMPLETED" || vers === "CANCELLED" ? { closedAt: new Date() } : {}),
    },
  });
  await journaliser(missionId, "STATE_CHANGED", raison ?? `${depuis} → ${vers}`, { from: depuis, to: vers });
}

/**
 * LE JOURNAL — on RÉUTILISE `MissionEvent` (§17 : pas de deuxième registre d'événements).
 *
 * `MissionEvent` est déjà le récit d'une mission, avec son acteur et son horodatage. Créer un
 * « MissionRuntimeLog » à côté aurait donné deux histoires de la même mission, et la question
 * « que s'est-il passé ? » aurait eu deux réponses.
 */
export async function journaliser(
  missionId: string,
  kind: string,
  summary: string,
  detail?: Record<string, unknown>,
  actorId?: string,
  /**
   * L'INSTANT DE L'ÉVÉNEMENT, quand l'appelant tient une horloge (la porte d'attention, dont la
   * cadence et le plafond quotidien se relisent DANS ce journal). Sans lui, l'heure de la base :
   * en production c'est la même ; sous une horloge simulée, un journal à l'heure réelle rendait
   * le plafond invérifiable — la journée simulée ne « voyait » aucun signal du jour.
   */
  at?: Date,
): Promise<void> {
  await prisma.missionEvent.create({
    data: { missionId, kind, summary, detail: (detail ?? undefined) as never, actorId: actorId ?? null, ...(at ? { at } : {}) },
  });
}

/** Incrémente les compteurs d'observabilité (§54). Additif, pour rester juste en concurrence. */
export async function compter(
  missionId: string,
  d: { modelCalls?: number; toolCalls?: number; tokensIn?: number; tokensOut?: number; costUsd?: number },
): Promise<void> {
  await prisma.mission.update({
    where: { id: missionId },
    data: {
      modelCalls: { increment: d.modelCalls ?? 0 },
      toolCalls: { increment: d.toolCalls ?? 0 },
      tokensIn: { increment: d.tokensIn ?? 0 },
      tokensOut: { increment: d.tokensOut ?? 0 },
      costUsd: { increment: d.costUsd ?? 0 },
    },
  });
}

/**
 * LA CLÉ D'IDEMPOTENCE D'UNE ÉTAPE (§15).
 *
 * Elle est DÉTERMINISTE : les mêmes entrées produisent la même clé, quel que soit le nombre de
 * redémarrages. C'est exactement ce qui fait qu'un crash à l'étape 73 ne renvoie pas les
 * soixante-douze e-mails précédents — la base refuse la seconde insertion.
 *
 * La cible est incluse parce que l'unicité utile n'est pas « cette étape » mais « cette action
 * vers cette personne » : deux itérations d'un même éventail portent la même clé d'étape et ne
 * doivent surtout pas se dédupliquer l'une l'autre.
 */
export function cleIdempotence(
  missionId: string,
  stepKey: string,
  capability: string,
  cible: string | null,
): string {
  return [missionId, stepKey, capability, cible ?? "-"].join("|");
}
