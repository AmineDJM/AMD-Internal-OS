import { prisma } from "@/lib/prisma";
import {
  type JobKind,
  JOB_PRIORITY,
  JOB_KINDS_MODELE,
  MAX_ATTEMPTS,
  backoffMs,
} from "./contract";
import { REPORTS_MAX, delaiReportMs } from "./panne";
import { sansBloquer } from "@/lib/journal";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA FILE DE TRAVAUX DE FOND — l'enrichissement ne fait jamais attendre personne.
 *
 * ── LA PROMESSE ──────────────────────────────────────────────────────────────────────────
 *
 * Un dépôt de fichier rend la main tout de suite. Ce qui est lourd — vision, vecteurs,
 * relations, résumé — part ici et avance tranquillement. Si un enrichissement finit, tant mieux ;
 * s'il échoue, l'ingestion normale continue et l'utilisateur n'en sait rien : le document reste
 * retrouvable par son texte, qui est le service qu'il attendait.
 *
 * ── CE QUI REND CETTE FILE FIABLE ────────────────────────────────────────────────────────
 *
 *   • RÉCLAMATION ATOMIQUE — `QUEUED → RUNNING` par une mise à jour conditionnelle. Deux
 *     processus qui tirent en même temps : un seul gagne. C'est le même geste que le garde
 *     d'idempotence des actions, et pour la même raison — sans lui, deux workers font deux fois
 *     le même travail, et paient deux fois le même modèle.
 *   • CLÉ DE DÉDOUBLONNAGE — deux jobs identiques ne coexistent pas. Rejouer un balayage ne
 *     remplit pas la file de copies.
 *   • ATTENTE CROISSANTE — un service momentanément indisponible n'est pas martelé.
 *   • BOÎTE MORTE — au bout de N essais, on arrête d'y revenir et on le SIGNALE. Un job qui
 *     échoue pour une mauvaise raison tournerait sinon indéfiniment, en coûtant à chaque tour.
 *
 * ── CE QUE CETTE FILE N'EST PAS ──────────────────────────────────────────────────────────
 *
 * Un ordonnanceur distribué. C'est une table PostgreSQL lue par le planificateur déjà en place
 * (`lib/scheduled.ts`). Introduire un courtier de messages pour ce volume ajouterait une pièce
 * à exploiter sans rien résoudre — et la première panne serait la sienne.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface EnqueueInput {
  kind: JobKind;
  itemId?: string | null;
  payload?: Record<string, unknown> | null;
  /** Surcharge la priorité du type — à réserver aux cas où l'urgence est réelle. */
  priority?: number;
  /** Retarde le premier essai (par exemple : attendre qu'une transaction soit visible). */
  delayMs?: number;
  /**
   * Ce qui rend deux jobs « le même ». Par défaut `kind:itemId`, ce qui est presque toujours la
   * bonne réponse : on ne veut pas deux vectorisations du même élément.
   */
  dedupeKey?: string | null;
}

/**
 * MET UN TRAVAIL EN FILE. Ne lève jamais : une file qui casse l'appelant transformerait un
 * enrichissement optionnel en panne de dépôt de fichier.
 *
 * Rend l'identifiant du job, ou `null` s'il existait déjà (ce n'est pas une erreur — c'est
 * exactement le comportement voulu d'un balayage rejoué).
 */
export async function enqueue(input: EnqueueInput): Promise<string | null> {
  const dedupeKey = input.dedupeKey === null
    ? null
    : (input.dedupeKey ?? (input.itemId ? `${input.kind}:${input.itemId}` : null));

  const data = {
    kind: input.kind,
    itemId: input.itemId ?? null,
    payload: (input.payload ?? undefined) as object | undefined,
    priority: input.priority ?? JOB_PRIORITY[input.kind],
    maxAttempts: MAX_ATTEMPTS,
    runAfter: new Date(Date.now() + (input.delayMs ?? 0)),
    dedupeKey,
  };

  try {
    // SANS CLÉ DE DÉDUPLICATION, chaque appel est un travail distinct : on crée, simplement.
    if (dedupeKey === null) {
      return (await prisma.knowledgeJob.create({ data, select: { id: true } })).id;
    }

    // AVEC UNE CLÉ, LE DOUBLON EST LE CAS ORDINAIRE — pas l'exception.
    //
    // Un balayage rejoué, une page rechargée, un fichier retouché deux fois : la plupart des
    // appels tombent sur un travail déjà prévu. Le code le savait et rattrapait l'exception ;
    // mais Prisma journalise chaque violation d'unicité en `prisma:error` AVANT qu'on l'attrape,
    // et un audit de cinq minutes en a compté trente-neuf. Un journal qui crie « erreur » à
    // chaque page vue ne dit plus rien le jour où une vraie erreur arrive.
    //
    // `createMany … skipDuplicates` s'écrit `ON CONFLICT DO NOTHING` : le doublon ne lève rien,
    // ne journalise rien, et la ligne existante est relue pour rendre son identifiant.
    const { count } = await prisma.knowledgeJob.createMany({ data, skipDuplicates: true });
    if (count === 0) return null; // déjà prévu — c'est le comportement voulu d'un rejeu
    const job = await prisma.knowledgeJob.findUnique({ where: { dedupeKey }, select: { id: true } });
    return job?.id ?? null;
  } catch {
    // Une panne de base, ou une course perdue entre deux processus : la file ne casse jamais
    // son appelant — un enrichissement optionnel ne doit pas faire échouer un dépôt.
    return null;
  }
}

/** Plusieurs d'un coup, sans qu'un échec unitaire n'emporte les autres. */
export async function enqueueAll(inputs: EnqueueInput[]): Promise<number> {
  const ids = await Promise.all(inputs.map((i) => enqueue(i)));
  return ids.filter((id): id is string => id !== null).length;
}

export interface ClaimedJob {
  id: string;
  kind: JobKind;
  itemId: string | null;
  payload: Record<string, unknown> | null;
  attempts: number;
}

/**
 * RÉCLAME UN TRAVAIL — la seule façon d'en obtenir un.
 *
 * L'ordre de service est celui de l'index (`status, runAfter, priority`) : ce qui est dû,
 * puis ce qui est le plus urgent. La réclamation est CONDITIONNELLE (`status: "QUEUED"`) :
 * si un autre processus a été plus rapide, la mise à jour ne touche aucune ligne et on passe
 * au candidat suivant plutôt que de faire le travail deux fois.
 */
export async function claimNext(kinds?: JobKind[]): Promise<ClaimedJob | null> {
  const now = new Date();
  const candidates = await prisma.knowledgeJob.findMany({
    where: {
      status: "QUEUED",
      runAfter: { lte: now },
      ...(kinds?.length ? { kind: { in: kinds } } : {}),
    },
    orderBy: [{ priority: "asc" }, { runAfter: "asc" }],
    take: 5, // quelques candidats : si l'un est pris, on tente le suivant sans nouvelle requête
    select: { id: true, kind: true, itemId: true, payload: true, attempts: true },
  });

  for (const c of candidates) {
    const claimed = await prisma.knowledgeJob.updateMany({
      where: { id: c.id, status: "QUEUED" },
      data: { status: "RUNNING", claimedAt: now, attempts: { increment: 1 } },
    });
    if (claimed.count === 1) {
      return {
        id: c.id,
        kind: c.kind as JobKind,
        itemId: c.itemId,
        payload: (c.payload ?? null) as Record<string, unknown> | null,
        attempts: c.attempts + 1,
      };
    }
  }
  return null;
}

export async function completeJob(id: string): Promise<void> {
  await prisma.knowledgeJob
    .update({ where: { id }, data: { status: "DONE", finishedAt: new Date(), lastError: null } })
    .catch(sansBloquer("queue.completeJob.knowledgeJob"));
}

/**
 * ÉCHEC. Deux issues, et la distinction compte :
 *
 *   • il reste des essais → retour en file, avec une attente croissante ;
 *   • le budget est épuisé → BOÎTE MORTE (`DEAD`). Le job cesse d'être repris, et son dernier
 *     motif est conservé. Un job mort qu'on relancerait indéfiniment coûterait à chaque tour
 *     sans jamais aboutir — et masquerait le vrai problème derrière du bruit.
 */
export async function failJob(id: string, error: string): Promise<"retry" | "dead"> {
  const job = await prisma.knowledgeJob
    .findUnique({ where: { id }, select: { attempts: true, maxAttempts: true } })
    .catch(sansBloquer("queue.failJob.knowledgeJob", null));
  if (!job) return "dead";

  const exhausted = job.attempts >= job.maxAttempts;
  await prisma.knowledgeJob
    .update({
      where: { id },
      data: exhausted
        ? { status: "DEAD", finishedAt: new Date(), lastError: error.slice(0, 500) }
        : { status: "QUEUED", runAfter: new Date(Date.now() + backoffMs(job.attempts)), lastError: error.slice(0, 500) },
    })
    .catch(sansBloquer("queue.failJob.knowledgeJob"));
  return exhausted ? "dead" : "retry";
}

/**
 * PANNE TEMPORAIRE — le travail ATTEND, il n'échoue pas (voir `panne.ts`).
 *
 * L'essai consommé par la réclamation est RENDU (le document n'est pas en cause), le travail
 * repart en file après une attente croissante, et le nombre de reports voyage dans sa charge
 * utile. Au-delà de `REPORTS_MAX`, la panne n'est plus passagère : boîte morte, avec un motif qui
 * dit « persistante » — sans cette borne, un fournisseur qui refuse pour de bon ferait tourner
 * le travail pour toujours.
 *
 * L'écriture est CONDITIONNELLE à `RUNNING` : un travail qu'un autre geste a déjà repris (un
 * `requeueStale`, une relance) n'est pas réécrit par-dessus.
 */
export async function reporterJob(id: string, motif: string): Promise<"reporte" | "dead"> {
  const job = await prisma.knowledgeJob
    .findUnique({ where: { id }, select: { attempts: true, payload: true } })
    .catch(sansBloquer("queue.reporterJob.knowledgeJob", null));
  if (!job) return "dead";
  const payload = (job.payload && typeof job.payload === "object" && !Array.isArray(job.payload)
    ? (job.payload as Record<string, unknown>)
    : {}) as Record<string, unknown>;
  const reports = typeof payload._reports === "number" ? payload._reports : 0;

  if (reports >= REPORTS_MAX) {
    await prisma.knowledgeJob
      .updateMany({
        where: { id, status: "RUNNING" },
        data: {
          status: "DEAD",
          finishedAt: new Date(),
          lastError: `Panne persistante après ${reports} reports : ${motif}`.slice(0, 500),
        },
      })
      .catch(sansBloquer("queue.reporterJob.knowledgeJob"));
    return "dead";
  }

  await prisma.knowledgeJob
    .updateMany({
      where: { id, status: "RUNNING" },
      data: {
        status: "QUEUED",
        attempts: Math.max(0, job.attempts - 1),
        runAfter: new Date(Date.now() + delaiReportMs(reports)),
        lastError: `En attente — panne temporaire : ${motif}`.slice(0, 500),
        payload: { ...payload, _reports: reports + 1 } as object,
      },
    })
    .catch(sansBloquer("queue.reporterJob.knowledgeJob"));
  return "reporte";
}

/**
 * LES TRAVAUX ABANDONNÉS. Un processus tué en plein travail laisse un job en `RUNNING` que plus
 * personne ne réclamera — c'est la panne silencieuse classique d'une file. On les récupère au
 * bout d'un délai généreux : mieux vaut refaire un travail que d'en perdre un pour toujours.
 */
export const STALE_RUNNING_MS = 20 * 60_000;

export async function requeueStale(): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_RUNNING_MS);
  const r = await prisma.knowledgeJob
    .updateMany({
      where: { status: "RUNNING", claimedAt: { lt: cutoff } },
      data: { status: "QUEUED", runAfter: new Date(), lastError: "Reprise après interruption du worker." },
    })
    .catch(sansBloquer("queue.requeueStale.knowledgeJob", { count: 0 }));
  return r.count;
}

export interface QueueHealth {
  queued: number;
  running: number;
  dead: number;
  /** Le plus vieux travail en attente, en minutes — le signe le plus lisible d'un engorgement. */
  oldestQueuedMin: number | null;
  /** Parmi les travaux en file, ceux qui attendent un MODÈLE (vecteurs, vision, résumé). */
  queuedModele: number;
}

/** L'état de la file, pour l'écran d'observabilité (§26). */
export async function queueHealth(): Promise<QueueHealth> {
  const [queued, running, dead, oldest, queuedModele] = await Promise.all([
    prisma.knowledgeJob.count({ where: { status: "QUEUED" } }),
    prisma.knowledgeJob.count({ where: { status: "RUNNING" } }),
    prisma.knowledgeJob.count({ where: { status: "DEAD" } }),
    prisma.knowledgeJob.findFirst({
      where: { status: "QUEUED" },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    }),
    prisma.knowledgeJob.count({ where: { status: "QUEUED", kind: { in: [...JOB_KINDS_MODELE] } } }),
  ]);
  return {
    queued,
    running,
    dead,
    queuedModele,
    oldestQueuedMin: oldest ? Math.round((Date.now() - oldest.createdAt.getTime()) / 60_000) : null,
  };
}
