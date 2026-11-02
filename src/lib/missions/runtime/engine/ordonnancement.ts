/**
 * Moteur de mission — L'ORDONNANCEMENT : quelles étapes sont prêtes, ce qu'une dépendance exige,
 * la réservation d'une étape, la reprise des orphelines, la relance des réparables, et le parallélisme borné.
 */
import { prisma } from "@/lib/prisma";
import type { Clock } from "@/lib/missions/ports";
import { EtatEtape, EtatMission, journaliser } from "@/lib/missions/runtime/store";
import { BAIL_MS, estTerminal } from "@/lib/missions/runtime/engine/contrat";

/**
 * LES ÉTAPES QUI PEUVENT PARTIR.
 *
 * ── DEUX PORTES D'ENTRÉE, ET ELLES NE DISENT PAS LA MÊME CHOSE ──────────────────────────
 *
 * `PENDING` = « attend ses dépendances » ; le graphe décide.
 * `READY`   = « quelqu'un l'a remise en file » ; une décision extérieure a eu lieu.
 *
 * La seconde existe pour l'approbation : une porte en attente que le PDG vient d'accorder doit
 * être RÉÉVALUÉE, et une étape en attente ne l'est jamais. Sans ce chemin, une mission
 * approuvée restait bloquée sur sa propre porte — l'accord était donné et rien ne repartait.
 *
 * `SKIPPED` compte comme terminée pour les dépendances : une branche écartée ne retient pas sa
 * descendance en otage (le pendant d'exécution de §37).
 */
export function etapesPretes(etat: EtatMission): EtatEtape[] {
  const parCle = new Map(etat.steps.map((s) => [s.key, s]));
  return etat.steps.filter((s) => {
    // UNE ÉTAPE QUE LE PLAN COURANT NE PORTE PLUS NE S'EXÉCUTE PAS. Elle reste au dossier ;
    // la relancer ferait travailler la mission pour un plan qu'elle a abandonné.
    if (s.contournee) return false;
    if (s.status === "READY") return true;
    if (s.status !== "PENDING") return false;
    const amonts = s.dependsOn.map((d) => parCle.get(d)).filter((d): d is EtatEtape => d !== undefined);
    // DU MATÉRIAU VIVANT : au moins un amont a ABOUTI. C'est ce qui distingue « synthétiser ce
    // qu'on a, en disant ce qui manque » de « conclure à partir de rien ».
    const materiel = amonts.some((d) => d.status === "DONE");
    return amonts.every((dep) => {
      /**
       * UNE DÉPENDANCE CONTOURNÉE NE RETIENT PERSONNE. Le journal du replan le promet —
       * « elles ne bloquent plus » — et un run Render (2026-08-29) a montré ce que coûte de
       * ne pas le tenir : une étape FAILED du plan v1, contournée par v2 (FAILED n'est pas
       * ACQUIS), n'est ni terminale ni exécutable — sa descendante attendait pour TOUJOURS,
       * la mission s'immobilisait en WAITING_DEPENDENCY sans recours ni replanification.
       * Même principe que SKIPPED (§37) : l'étape partira avec ce que ses amonts vivants ont
       * produit, et le worker DIT ce qui lui manque.
       */
      return dependanceSatisfaite(dep, s, materiel);
    });
  });
}

/** Les nœuds qui SYNTHÉTISENT : ils lisent ce que leurs amonts ont produit, et disent ce qui manque. */
export const SYNTHESE: ReadonlySet<string> = new Set(["WORKER", "QA", "JOIN", "ARTIFACT"]);

/** Une étape MORTE : en échec, toutes ses tentatives consommées — plus rien ne la fera aboutir seule. */
const estMorte = (dep: Pick<EtatEtape, "status" | "attempt" | "maxAttempts">): boolean =>
  dep.status === "FAILED" && dep.attempt >= dep.maxAttempts;

/**
 * « CETTE DÉPENDANCE LAISSE-T-ELLE PASSER ? » — pure, exportée pour être testée au cas près.
 *
 * Terminale (DONE, SKIPPED, CANCELLED) ou contournée : oui, pour tout le monde. MORTE : oui pour
 * un nœud de SYNTHÈSE seulement, et seulement s'il a DU MATÉRIAU — au moins un autre amont
 * abouti. Le banc l'a montré sur l'enquête d'une facture : une lecture de pièces en échec
 * définitif tenait en otage l'analyse, l'accord et le contrôle — la mission finissait BLOQUÉE
 * sans avoir rien conclu, alors que l'analyste avait sept lectures réussies sous la main. Un
 * worker part avec ce que ses amonts vivants ont produit et DIT ce qui lui manque ; le juge
 * tranche ensuite.
 *
 * Deux bornes, chacune pour une raison :
 *   • une CAPABILITY reste retenue : écrire à partir d'une lecture qui a échoué, c'est écrire
 *     sur du vide ;
 *   • une synthèse dont TOUS les amonts sont morts reste retenue : « conclure malgré tout »
 *     sans matériau, c'est inventer — le faux succès que §10 interdit. La mission passe alors
 *     BLOCKED (`deduireEtat`, règle 4) et c'est la REPLANIFICATION qui décide, pas le moteur.
 */
export function dependanceSatisfaite(
  dep: Pick<EtatEtape, "status" | "attempt" | "maxAttempts" | "contournee">,
  dependant: Pick<EtatEtape, "nodeType">,
  /** Le dépendant a-t-il au moins un amont ABOUTI (DONE) ? Sans matériau, rien ne part. */
  materiel: boolean,
): boolean {
  if (dep.contournee || estTerminal(dep.status)) return true;
  return estMorte(dep) && SYNTHESE.has(dependant.nodeType) && materiel;
}

/**
 * RÉSERVE UNE ÉTAPE. C'est la base qui arbitre, pas la politesse des appelants.
 *
 * `updateMany` avec la condition sur l'état ancien rend zéro ligne si un autre processus est
 * passé avant. Sans cette condition, deux instances du moteur — la web et la tâche de fond —
 * exécuteraient la même étape, et l'idempotence ne rattraperait que les écritures.
 */
export async function reserver(step: EtatEtape, clock: Clock): Promise<boolean> {
  const r = await prisma.missionStep.updateMany({
    where: { id: step.id, status: { in: ["PENDING", "READY"] } },
    data: { status: "RUNNING", attempt: { increment: 1 }, startedAt: clock.now() },
  });
  return r.count === 1;
}

/**
 * REPREND LES ÉTAPES LAISSÉES « EN COURS » PAR UN PROCESSUS MORT.
 *
 * Sans cela, un redémarrage de Render au mauvais moment fige la mission pour toujours. Avec
 * cela — et grâce à la clé d'idempotence — la reprise est sûre : l'effet déjà produit n'est pas
 * reproduit, seul le reçu est retrouvé.
 */
export async function reprendreOrphelines(missionId: string, clock: Clock): Promise<void> {
  const limite = new Date(clock.now().getTime() - BAIL_MS);
  const orphelines = await prisma.missionStep.findMany({
    where: { missionId, status: "RUNNING", startedAt: { lt: limite } },
    select: { id: true, key: true },
  });
  for (const o of orphelines) {
    await prisma.missionStep.updateMany({
      where: { id: o.id, status: "RUNNING" },
      data: { status: "PENDING", error: "reprise après interruption du processus" },
    });
    await journaliser(missionId, "STEP_RECLAIMED",
      `Étape « ${o.key} » reprise : le processus qui l'exécutait ne répond plus.`, { stepKey: o.key });
  }
}

/** Remet en file les étapes échouées à qui il reste des tentatives (§13). */
export async function relancerReparables(missionId: string): Promise<number> {
  const r = await prisma.missionStep.updateMany({
    where: { missionId, status: "FAILED", attempt: { lt: prisma.missionStep.fields.maxAttempts } },
    data: { status: "PENDING" },
  });
  if (r.count > 0) {
    await journaliser(missionId, "STEP_RETRY", `${r.count} étape(s) remise(s) en file pour une nouvelle tentative.`);
  }
  return r.count;
}

/**
 * UNE CARTE PARALLÈLE BORNÉE.
 *
 * `Promise.all` sur trente-trois envois saturerait le fournisseur et ferait échouer par
 * limitation de débit ce qui aurait réussi en trois vagues. La borne est OPÉRATIONNELLE : elle
 * ne dit rien de la taille des missions, seulement de la vitesse à laquelle on les mène (§4).
 */
export async function enParallele<T, R>(
  items: readonly T[],
  concurrence: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let curseur = 0;
  const largeur = Math.max(1, Math.min(concurrence, items.length));
  await Promise.all(Array.from({ length: largeur }, async () => {
    for (;;) {
      const i = curseur++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}
