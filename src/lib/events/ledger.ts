import { prisma } from "@/lib/prisma";
import type { Prisma, EntityType } from "@prisma/client";
import { EXPECTED_EVENTS, matchEvent, type BusinessEventLike, type TaskLike } from "@/lib/tasks/evidence";
import { reveillerMissions } from "@/lib/missions/events/router";
import { satisfaireEngagements } from "@/lib/missions/commitments/satisfy";
import { invaliderEtatsChauds } from "@/lib/fabric";
import { sansBloquer } from "@/lib/journal";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE REGISTRE D'ÉVÉNEMENTS — écrire un fait, et laisser l'ERP en tirer les conséquences.
 *
 * ── LA SEULE PORTE ───────────────────────────────────────────────────────────────────────
 *
 * `recordEvent` est le seul endroit qui écrit dans `BusinessEvent`. Ce n'est pas de la
 * discipline : c'est ce qui permet aux RÉACTIONS (réconciliation des tâches aujourd'hui,
 * notifications et frises demain) d'exister en un seul point plutôt qu'en trente.
 *
 * ── UN ÉVÉNEMENT NE FAIT JAMAIS ÉCHOUER SON ÉMETTEUR ─────────────────────────────────────
 *
 * Le dépôt d'un contrat doit réussir même si l'inscription du fait échoue. Un registre qui
 * fait tomber l'écriture métier qu'il observe est une régression, pas une observabilité. Les
 * erreurs sont donc journalisées et avalées — et c'est le SEUL endroit du produit où avaler
 * une erreur est le bon choix.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface RecordEventInput {
  type: string;
  sourceDomain: string;
  actorId?: string | null;
  entityType?: EntityType | null;
  entityId?: string | null;
  /** Les autres entités concernées, en « TYPE:id ». */
  relatedRefs?: string[];
  payload?: Prisma.InputJsonValue;
  correlationId?: string | null;
  missionId?: string | null;
  /** Quand le fait s'est produit, s'il est ANTÉRIEUR à son inscription (import, rattrapage). */
  occurredAt?: Date;
}

/**
 * INSCRIT UN FAIT, puis réconcilie ce qui l'attendait.
 *
 * Rend l'identifiant du fait, ou `null` si l'inscription a échoué — auquel cas l'appelant
 * continue son travail : c'est le point de l'en-tête.
 */
export async function recordEvent(input: RecordEventInput): Promise<string | null> {
  try {
    const evt = await prisma.businessEvent.create({
      data: {
        type: input.type,
        sourceDomain: input.sourceDomain,
        occurredAt: input.occurredAt ?? new Date(),
        actorId: input.actorId ?? null,
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
        relatedRefs: input.relatedRefs ?? [],
        ...(input.payload !== undefined ? { payload: input.payload } : {}),
        correlationId: input.correlationId ?? null,
        missionId: input.missionId ?? null,
      },
      select: { id: true, type: true, occurredAt: true, sourceDomain: true, entityType: true, entityId: true, actorId: true },
    });

    // ── LES CONSÉQUENCES D'UN FAIT, EN PARALLÈLE ────────────────────────────────────────────
    //
    // Elles étaient enchaînées : réconcilier les tâches, PUIS réveiller les missions, PUIS
    // satisfaire les engagements, PUIS charger le module des rappels, PUIS marquer les états
    // chauds. Cinq allers-retours à la base, en file, DANS la requête de la personne — et l'on
    // voyait tourner « Enregistrer » sur un formulaire de courrier qui ne pèse rien.
    //
    // Elles sont INDÉPENDANTES : aucune ne lit ce qu'une autre écrit. Les enchaîner ne servait
    // qu'à les écrire les unes sous les autres. Chacune garde son `catch` nommé — une
    // conséquence qui tombe ne doit jamais emporter les autres, ni l'écriture métier.
    const consequences: Promise<unknown>[] = [
      reconcileTasks(evt).catch((err) => {
        console.error("[events] réconciliation impossible", evt.type, err);
      }),

      // LE RÉVEIL DES MISSIONS (§18) : une mission qui attend « la réponse de Redouane » se règle
      // quand le fait arrive, sans que personne ait à dire « il a répondu ». Le routeur ne fait
      // PAS tourner la mission — il règle l'attente et rend la main ; sans quoi le dépôt d'un
      // contrat attendrait la fin d'une mission de trente-trois envois.
      reveillerMissions({
        type: evt.type,
        actorId: evt.actorId,
        entityType: evt.entityType,
        entityId: evt.entityId,
        relatedRefs: input.relatedRefs ?? [],
        payload: input.payload,
        missionId: input.missionId ?? null,
      }).catch((err) => {
        console.error("[events] réveil de mission impossible", evt.type, err);
      }),

      // LES PROMESSES TENUES (§86) : Redouane dépose son contrat, l'engagement se ferme tout
      // seul — sans quoi Adam le relancerait trois jours plus tard pour une chose déjà faite,
      // ce qui est la façon la plus rapide de perdre sa crédibilité.
      satisfaireEngagements({
        type: evt.type,
        actorId: evt.actorId,
        entityType: evt.entityType,
        entityId: evt.entityId,
        relatedRefs: input.relatedRefs ?? [],
        payload: input.payload,
        missionId: input.missionId ?? null,
      }).catch((err) => {
        console.error("[events] satisfaction d'engagement impossible", evt.type, err);
      }),

      // LES RAPPELS CONDITIONNELS S'ÉTEIGNENT (§10) : « rappelle-moi dans 7 jours si Sarah n'a
      // pas envoyé le contrat » — le contrat arrive, le rappel se tait, relances comprises.
      // Import différé : ce module tire la messagerie, qu'on ne veut pas charger pour chaque fait.
      import("@/lib/assistant/reminders")
        .then((m) => m.eteindreRappelsSurEvenement({
          type: evt.type,
          actorId: evt.actorId,
          entityType: evt.entityType,
          entityId: evt.entityId,
          relatedRefs: input.relatedRefs ?? [],
          payload: input.payload,
        }))
        .catch((err) => {
          console.error("[events] extinction de rappel impossible", evt.type, err);
        }),

      // LES RÉPONSES TARDIVES : la personne qu'Adam a relancée répond après que l'attente s'est
      // réglée par le temps — plus rien ne l'attend, mais rien ne se perd : la réponse rejoint le
      // journal de la mission et le dirigeant en est informé. Import différé : le pont tire la
      // porte d'attention.
      ...(evt.type === "MESSAGE_RECEIVED" || evt.type === "EMAIL_RECEIVED" ? [
        import("@/platform/in-process/missions/relance")
          .then((m) => m.observerReponseTardive({
            type: evt.type, actorId: evt.actorId, entityType: evt.entityType, entityId: evt.entityId,
            relatedRefs: input.relatedRefs ?? [], payload: input.payload, missionId: input.missionId ?? null,
          }))
          .catch((err) => {
            console.error("[events] réponse tardive : observation impossible", evt.type, err);
          }),
      ] : []),

      // LES SURVEILLANCES RÉVEILLÉES : un fait qui touche une cible surveillée avance son prochain
      // contrôle à maintenant — « changement ERP → réveil ». Rien n'est évalué ici (la façade
      // n'a pas l'ERP) : le battement relit la cible dans la minute.
      import("@/lib/missions/watch/router")
        .then((m) => m.reveillerSurveillances({
          type: evt.type, entityType: evt.entityType, entityId: evt.entityId, actorId: evt.actorId, relatedRefs: input.relatedRefs ?? [],
        }))
        .catch((err) => {
          console.error("[events] réveil de surveillance impossible", evt.type, err);
        }),

      // LES ÉTATS CHAUDS DÉMENTIS (fabric F5) : les signaux exécutifs précalculés AVANT ce fait
      // ne peuvent plus être servis tels quels. On MARQUE — le prochain lecteur ou le battement
      // paie le recalcul —, et l'invalidation ne touche que les lignes pas encore marquées :
      // idempotente, une requête indexée, jamais bloquante.
      invaliderEtatsChauds("alertes-executives").catch(sansBloquer("events-ledger.recordEvent.invaliderEtatsChauds")),
    ];
    await Promise.allSettled(consequences);

    return evt.id;
  } catch (err) {
    console.error("[events] inscription impossible", input.type, err);
    return null;
  }
}

/**
 * LE RAPPROCHEMENT — ce qui rend « la tâche est en retard » enfin exact.
 *
 * La décision (« ce fait satisfait-il cette tâche ? ») est PURE et vit dans
 * `src/lib/tasks/evidence.ts` : elle se teste au jeton près, sans base. Ici, on ne fait que
 * chercher les candidates et écrire le résultat.
 *
 * LA FENÊTRE DE RECHERCHE est bornée à 400 tâches ouvertes récentes. Sans borne, un dépôt de
 * document ferait relire toutes les tâches de l'histoire à chaque fois — le genre de coût
 * invisible qui n'apparaît qu'en production, deux ans plus tard.
 */
async function reconcileTasks(
  // `entityType` est resserré au type Prisma : le contrat PUR de `evidence.ts` le déclare
  // `string` (il ne connaît pas la base, et c'est ce qui le rend testable sans elle), mais
  // l'écriture, elle, a besoin de l'enum réel.
  evt: Omit<BusinessEventLike, "entityType"> & { id: string; entityType: EntityType | null },
): Promise<void> {
  // ─────────────────────────────────────────────────────────────────────────────────────
  // LE PRÉ-FILTRE QUI ÉVITE 400 LIGNES LUES POUR RIEN.
  //
  // Depuis que l'audit alimente le registre, un fait est inscrit à chaque changement de statut
  // de l'ERP. Or une tâche ne peut attendre qu'un des sept faits d'`EXPECTED_EVENTS` : pour
  // tous les autres, la recherche ne pourrait RIEN trouver — elle lirait 400 tâches pour
  // conclure à l'évidence. C'est exactement le coût invisible que l'en-tête ci-dessus décrit,
  // et il fallait le fermer AVANT de brancher les cinq cents points d'émission, pas après.
  //
  // La liste vient d'`evidence.ts` : la garde ne peut donc pas se désynchroniser de la règle
  // qu'elle protège.
  // ─────────────────────────────────────────────────────────────────────────────────────
  if (!(EXPECTED_EVENTS as readonly string[]).includes(evt.type)) return;

  const ouvertes = await prisma.task.findMany({
    where: { status: { notIn: ["DONE", "CANCELLED"] } },
    select: {
      id: true, title: true, description: true, status: true, assignedToId: true,
      createdAt: true, expectedEvent: true, relatedEntityType: true, relatedEntityId: true,
      evidenceAt: true,
    },
    orderBy: { createdAt: "desc" },
    take: 400,
  });

  const candidates: TaskLike[] = ouvertes.map((t) => ({
    id: t.id, title: t.title, description: t.description, status: t.status,
    assignedToId: t.assignedToId, createdAt: t.createdAt,
    expectedEvent: t.expectedEvent, relatedEntityType: t.relatedEntityType, relatedEntityId: t.relatedEntityId,
  }));

  const dejaPreuve = new Map(ouvertes.map((t) => [t.id, t.evidenceAt]));

  for (const m of matchEvent(evt, candidates)) {
    // LA PREMIÈRE PREUVE FAIT FOI. Un second dépôt ne doit pas réécrire la date du premier :
    // « déposé le 22/08 » est un fait, et il ne se met pas à jour.
    if (dejaPreuve.get(m.taskId)) continue;

    await prisma.task.update({
      where: { id: m.taskId },
      data: {
        evidenceEntityType: evt.entityType ?? null,
        evidenceEntityId: evt.entityId ?? null,
        evidenceAt: evt.occurredAt,
        evidenceActorId: evt.actorId ?? null,
        evidenceNote: m.reason,
        // CLÔTURE AUTOMATIQUE : seulement sur une attente DÉCLARÉE à la création. Une
        // déduction de texte inscrit la preuve et s'arrête là — voir `evidence.ts`.
        ...(m.autoComplete ? { status: "DONE" as const, completedAt: evt.occurredAt } : {}),
      },
    }).catch((err) => console.error("[events] preuve non inscrite sur", m.taskId, err));

    console.info("[events] preuve", {
      task: m.taskId, event: evt.type, confidence: m.confidence, autoComplete: m.autoComplete,
    });
  }
}

/**
 * LA FRISE d'une entité — tous les faits qui la concernent, du plus récent au plus ancien.
 *
 * Cherche dans les DEUX sens : l'entité principale du fait, et les entités secondaires
 * (`relatedRefs`). Un dépôt de contrat inscrit sous « le contrat » doit remonter aussi quand
 * on interroge « le consultant ».
 */
export async function timelineOf(
  entityType: EntityType,
  entityId: string,
  limit = 50,
): Promise<{ type: string; occurredAt: Date; sourceDomain: string; actorId: string | null; payload: unknown }[]> {
  const ref = `${entityType}:${entityId}`;
  const rows = await prisma.businessEvent.findMany({
    where: { OR: [{ entityType, entityId }, { relatedRefs: { has: ref } }] },
    orderBy: { occurredAt: "desc" },
    take: Math.min(limit, 200),
    select: { type: true, occurredAt: true, sourceDomain: true, actorId: true, payload: true },
  });
  return rows;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * « QUOI DE NEUF ? » SANS RÉFÉRENCE — les faits RÉCENTS du registre canonique.
 *
 * ── LE DÉFAUT MESURÉ ────────────────────────────────────────────────────────────────────
 *
 * `what_changed` sans référence n'avait qu'UNE source : la projection en MÉMOIRE du processus
 * (`change-feed.ts`), honnête sur elle-même — « je vois ce qui s'est passé depuis le démarrage
 * de CE serveur ». Elle éteinte, l'outil répondait « je ne peux pas dire ce qui a bougé à
 * l'instant » ; elle vide, « aucun changement depuis le démarrage de ce serveur ». Or Render
 * redémarre le processus à CHAQUE déploiement, et pendant ce temps `BusinessEvent` — le registre
 * canonique (§17) — porte toute la journée. Un « je ne peux pas » écrit dans le CODE, sur l'une
 * des questions les plus naturelles d'un dirigeant, avec la réponse à un fichier de distance
 * (§118.63, §118.93).
 *
 * ── POURQUOI CE LECTEUR VIT ICI ─────────────────────────────────────────────────────────
 *
 * `timelineOf` lit déjà ce registre, mais exige une ENTITÉ. La question « quoi de neuf ? » n'en
 * a pas. C'est la même table, le même vocabulaire, la même règle de charge utile : un second
 * module aurait divergé au premier champ ajouté (§118.5).
 *
 * ── CE QUE CE LECTEUR NE FAIT PAS ───────────────────────────────────────────────────────
 *
 * Il ne filtre AUCUNE permission : ce n'est pas son rôle et il ne connaît pas l'acteur. Le
 * cloisonnement se fait par ENREGISTREMENT chez l'appelant (`canAccessEntity`), parce qu'un fait
 * porte l'entité qu'il concerne et que c'est la seule granularité juste — un filtre par domaine
 * montrerait le dossier confidentiel d'un service ouvert. Il ne rend pas non plus `payload` :
 * la charge utile se lit largement mais elle n'est pas nécessaire pour dire QUE quelque chose a
 * bougé, et un libellé suffit à décider s'il faut relire la source.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export interface FaitRecent {
  type: string;
  occurredAt: Date;
  sourceDomain: string;
  actorId: string | null;
  entityType: EntityType | null;
  entityId: string | null;
}

/**
 * LE TOTAL VOYAGE AVEC L'ÉCHANTILLON, et ce n'est pas un ornement.
 *
 * MESURÉ sur la base de travail : 26 332 faits sur sept jours, 4 356 sur vingt-quatre heures.
 * Rendre « les soixante plus récents » sans dire combien il y en a fait lire un échantillon des
 * dernières minutes comme le bilan de la semaine — la coupe silencieuse se lit comme une
 * exhaustivité (§118.60). Le compte est une seconde requête, agrégée, sur la même fenêtre.
 */
export interface FaitsRecents {
  faits: FaitRecent[];
  /** Combien de faits la fenêtre contient RÉELLEMENT — pas combien on en rend. */
  total: number;
}

export async function faitsRecents(opts: { since?: Date; limit?: number } = {}): Promise<FaitsRecents> {
  // BORNÉ DES DEUX CÔTÉS. Sans borne de temps, la première question du matin lirait l'année ;
  // sans borne de nombre, un import rétroactif remplirait la réponse d'un seul domaine.
  const since = opts.since ?? new Date(Date.now() - 7 * 86_400_000);
  const where = { occurredAt: { gte: since } };
  const [faits, total] = await Promise.all([
    prisma.businessEvent.findMany({
      where,
      orderBy: { occurredAt: "desc" },
      take: Math.min(Math.max(opts.limit ?? 60, 1), 200),
      select: { type: true, occurredAt: true, sourceDomain: true, actorId: true, entityType: true, entityId: true },
    }),
    prisma.businessEvent.count({ where }),
  ]);
  return { faits, total };
}
