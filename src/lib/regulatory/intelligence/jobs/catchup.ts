import { prisma } from "@/lib/prisma";
import { aiConfigured } from "@/lib/ai";
import { regAudit } from "../audit";
import { sansBloquer } from "@/lib/journal";

/**
 * RATTRAPAGE DES DOSSIERS DÉJÀ EN PLACE — pour que les améliorations profitent aussi à ce qui
 * existe, sans reprendre chaque dossier à la main.
 *
 * Deux situations réelles, héritées du passé :
 *
 *   1. **La revue de fond n'a jamais été livrée.** Tant que le différé (Batch, moitié prix) était
 *      le défaut, un dossier pouvait passer « En revue » avec ses seuls contrôles déterministes,
 *      la partie exigeante restant chez le fournisseur — et si le lot n'est jamais revenu (clé
 *      changée, lot expiré, erreur fournisseur), il n'y avait AUCUN mécanisme pour s'en rendre
 *      compte. Le dossier avait simplement l'air propre.
 *
 *   2. **Le pipeline déterministe s'est arrêté en chemin.** Un job en échec définitif laisse un
 *      dossier bloqué en « Analyse en cours » sans plus rien dans la file — il ne repartira
 *      jamais tout seul.
 *
 * Principes tenus ici, parce qu'un rattrapage automatique touche à l'argent et à la confiance :
 *   • **une seule fois par version.** Le marqueur vit dans le journal d'audit (`AI_CATCHUP`) —
 *     pas de nouvelle table, et surtout aucune boucle qui relancerait indéfiniment une analyse
 *     payante sur un dossier légitimement sans constat ;
 *   • **on ne double jamais un travail en cours** : un job en file, ou un lot différé déposé il y
 *     a moins de 26 h (les lots aboutissent sous 24 h), interdit le rattrapage ;
 *   • **débit volontairement lent** — quelques versions par passage : on rattrape un historique
 *     sur quelques minutes, on ne déclenche pas une facture d'un coup ;
 *   • **mode immédiat forcé** : rattraper en différé reproduirait exactement le problème ;
 *   • le plafond budgétaire du dossier continue de refuser l'appel AVANT la dépense ;
 *   • désactivable d'un geste (`REG_AI_CATCHUP=0`), et ne lève jamais.
 */

/** Un lot différé de plus de 26 h ne reviendra plus : les lots aboutissent sous 24 h. */
export const BATCH_FRESH_MS = 26 * 60 * 60_000;
const BATCH_IN_FLIGHT = ["submitted", "validating", "in_progress", "finalizing"] as const;

/** Versions rattrapées par passage — lent volontairement (coût étalé, effet observable). */
const AI_CATCHUP_PER_TICK = 2;
const STALL_CATCHUP_PER_TICK = 3;
/** Reprises maximales d'un pipeline arrêté : au-delà, la panne est durable — on cesse d'insister. */
const MAX_PIPELINE_RESUMES = 3;

export const catchupEnabled = () => (process.env.REG_AI_CATCHUP ?? "1").trim() !== "0";

export interface AiCatchupState {
  /** Les contrôles déterministes ont abouti (un bilan existe) — sinon le pipeline travaille encore. */
  deterministicDone: boolean;
  /** Constats de fond déjà livrés par l'IA sur cette version. */
  aiFindings: number;
  /** Un job AI_REVIEW est en file ou en cours. */
  aiJobActive: boolean;
  /** Un lot différé déposé il y a moins de 26 h est encore en vol : il va livrer. */
  freshBatchInFlight: boolean;
  /** Nombre de rattrapages DÉJÀ déclenchés sur cette version. */
  catchupCount: number;
  /**
   * La dernière revue de fond s'est soldée par un ÉCHEC TECHNIQUE (job FAILED) — panne du
   * fournisseur, paramètre refusé, contenu illisible. Ce n'est pas la même chose qu'un dossier
   * légitimement sans constat : l'analyse n'a jamais eu lieu, et une fois la panne corrigée le
   * dossier doit se soigner tout seul plutôt que d'attendre un clic.
   */
  lastReviewFailed: boolean;
}

/** Rattrapages maximaux quand la revue échoue techniquement : une seconde chance, pas une boucle. */
export const MAX_AI_CATCHUPS_AFTER_FAILURE = 2;

/**
 * Faut-il rattraper la revue de fond de cette version ? Fonction PURE — testée.
 * L'ordre des refus est la règle métier : on ne double jamais un travail en cours, et on ne
 * rattrape jamais deux fois (une analyse payante qui boucle serait pire que le problème initial).
 */
export function shouldCatchUpAi(s: AiCatchupState): boolean {
  if (!s.deterministicDone) return false;
  if (s.aiJobActive) return false;
  if (s.freshBatchInFlight) return false;
  if (s.aiFindings > 0) return false;
  // Jamais deux analyses payantes sur un dossier légitimement sans constat…
  if (s.catchupCount === 0) return true;
  // …mais une SECONDE chance quand la précédente a échoué techniquement : sans elle, corriger la
  // panne ne réparerait aucun des dossiers qu'elle a laissés non analysés. Bornée, donc jamais
  // une boucle sur une panne durable.
  return s.lastReviewFailed && s.catchupCount < MAX_AI_CATCHUPS_AFTER_FAILURE;
}

/** Un lot déposé à `submittedAt` peut-il encore livrer ? PURE — testée. */
export function batchStillFresh(submittedAt: Date, now: number): boolean {
  return now - submittedAt.getTime() < BATCH_FRESH_MS;
}

/** Au-delà, un lot est déclaré perdu : marge confortable après les 26 h de fraîcheur. */
export const BATCH_EXPIRE_MS = 36 * 60 * 60_000;

/**
 * Ferme les lots différés FANTÔMES — déposés il y a plus de 36 h et jamais revenus (clé changée,
 * lot perdu côté fournisseur). Tant qu'ils restent « en vol », ils font écrire « résultats sous
 * 24 h » à l'écran indéfiniment et empêchent le rattrapage de faire son travail.
 * Ne lève jamais.
 */
export async function expireStaleBatches(): Promise<number> {
  try {
    const cutoff = new Date(Date.now() - BATCH_EXPIRE_MS);
    const r = await prisma.regulatoryAiBatch.updateMany({
      where: { status: { in: [...BATCH_IN_FLIGHT] }, submittedAt: { lt: cutoff } },
      data: { status: "expired", error: "Lot jamais revenu du fournisseur (au-delà de 36 h) — clos automatiquement." },
    });
    if (r.count > 0) {
      await regAudit({
        actorId: "system", action: "AI_BATCH_EXPIRED",
        detail: `${r.count} lot(s) d'analyse différée clos automatiquement : jamais revenus du fournisseur. Les versions concernées seront rattrapées en analyse immédiate.`,
      }).catch(sansBloquer("catchup.expireStaleBatches.regAudit"));
    }
    return r.count;
  } catch (e) {
    console.error("[reg-catchup] clôture des lots fantômes impossible", e);
    return 0;
  }
}

/**
 * Rattrape les versions dont la revue de fond n'a jamais rien livré. Rend le nombre de versions
 * remises en file. Ne lève jamais.
 */
export async function catchUpMissingAiReviews(limit = AI_CATCHUP_PER_TICK): Promise<number> {
  if (!catchupEnabled() || !aiConfigured()) return 0;
  try {
    const now = Date.now();

    // Versions à EXCLURE : lot récent encore en vol (il va livrer), ou déjà rattrapées une fois.
    const [batches, caughtUp] = await Promise.all([
      prisma.regulatoryAiBatch.findMany({
        where: { status: { in: [...BATCH_IN_FLIGHT] }, dossierVersionId: { not: null } },
        select: { dossierVersionId: true, submittedAt: true },
        take: 500,
      }),
      prisma.regulatoryAuditLog.groupBy({
        by: ["dossierVersionId"],
        where: { action: "AI_CATCHUP", dossierVersionId: { not: null } },
        _count: { _all: true },
      }),
    ]);
    const excluded = new Set<string>();
    for (const b of batches) if (b.dossierVersionId && batchStillFresh(b.submittedAt, now)) excluded.add(b.dossierVersionId);

    // Versions déjà rattrapées : exclues SAUF si la dernière revue a échoué techniquement et
    // qu'il reste une chance — c'est ce qui fait se réparer tout seuls les dossiers laissés
    // non analysés par une panne, une fois celle-ci corrigée.
    const counts = new Map<string, number>();
    for (const a of caughtUp) if (a.dossierVersionId) counts.set(a.dossierVersionId, a._count._all);
    if (counts.size > 0) {
      const failedAgain = await prisma.regulatoryJob.findMany({
        where: { dossierVersionId: { in: [...counts.keys()] }, type: "AI_REVIEW", status: "FAILED" },
        select: { dossierVersionId: true },
        distinct: ["dossierVersionId"],
      }).catch(sansBloquer("catchup.catchUpMissingAiReviews.regulatoryJob", [] as { dossierVersionId: string | null }[]));
      const failed = new Set(failedAgain.map((j) => j.dossierVersionId).filter((x): x is string => !!x));
      for (const [versionId, count] of counts) {
        const deserves = failed.has(versionId) && count < MAX_AI_CATCHUPS_AFTER_FAILURE;
        if (!deserves) excluded.add(versionId);
      }
    }

    // Candidates : bilan déterministe présent, AUCUN constat IA, aucun job de revue en file.
    const versions = await prisma.regulatoryDossierVersion.findMany({
      where: {
        assessment: { isNot: null },
        findings: { none: { source: "AI" } },
        jobs: { none: { type: "AI_REVIEW", status: { in: ["QUEUED", "RUNNING"] } } },
        id: { notIn: [...excluded].slice(0, 5000) },
      },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: { id: true, dossierId: true, dossier: { select: { companyId: true, reference: true, title: true } } },
    });
    if (versions.length === 0) return 0;

    let queued = 0;
    for (const v of versions) {
      // Marqueur écrit AVANT la mise en file : deux ticks concurrents ne doivent pas déposer
      // deux analyses payantes sur la même version.
      await regAudit({
        companyId: v.dossier.companyId, actorId: "system", dossierId: v.dossierId, dossierVersionId: v.id,
        action: "AI_CATCHUP",
        detail: `Rattrapage automatique : la revue de fond de « ${v.dossier.reference} — ${v.dossier.title} » n'avait jamais été livrée. Relancée en analyse IMMÉDIATE.`,
      });
      await prisma.regulatoryJob.create({
        data: {
          companyId: v.dossier.companyId, dossierId: v.dossierId, dossierVersionId: v.id,
          type: "AI_REVIEW", status: "QUEUED",
          payload: { mode: "immediate" }, // rattraper en différé reproduirait le problème
        },
      });
      queued++;
    }
    return queued;
  } catch (e) {
    console.error("[reg-catchup] rattrapage de la revue de fond impossible", e);
    return 0;
  }
}

/**
 * Redémarre les pipelines déterministes ARRÊTÉS : dossier encore en analyse, plus aucun job en
 * file, et aucun bilan produit. Sans cela, un job en échec définitif fige le dossier pour
 * toujours. Gratuit (aucun appel IA) — donc sans marqueur d'unicité : dès qu'un bilan existe,
 * la version cesse d'être candidate.
 */
export async function catchUpStalledPipelines(limit = STALL_CATCHUP_PER_TICK): Promise<number> {
  if (!catchupEnabled()) return 0;
  try {
    // ARRÊT AU BOUT DE TROIS REPRISES. Un pipeline qui échoue de façon reproductible (document
    // corrompu, panne durable) ne produira jamais de bilan : sans cette borne, on le relancerait
    // à chaque passage, pour toujours. Le compteur se lit dans le journal d'audit.
    const resumed = await prisma.regulatoryAuditLog.groupBy({
      by: ["dossierVersionId"],
      where: { action: "PIPELINE_RESUMED", dossierVersionId: { not: null } },
      _count: { _all: true },
    }).catch(sansBloquer("catchup.catchUpStalledPipelines.regulatoryAuditLog", [] as { dossierVersionId: string | null; _count: { _all: number } }[]));
    const exhausted = resumed.filter((r) => r._count._all >= MAX_PIPELINE_RESUMES).map((r) => r.dossierVersionId!).filter(Boolean);

    const versions = await prisma.regulatoryDossierVersion.findMany({
      where: {
        assessment: { is: null },
        dossier: { status: { in: ["ANALYSING", "INGESTED"] } },
        jobs: { none: { status: { in: ["QUEUED", "RUNNING"] } } },
        documents: { some: {} }, // un dossier sans document n'a rien à analyser
        id: { notIn: exhausted.slice(0, 5000) },
      },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: { id: true, dossierId: true, dossier: { select: { companyId: true, reference: true } } },
    });
    if (versions.length === 0) return 0;

    for (const v of versions) {
      // FACTS enchaîne RULES : on repart de l'étape qui produit le jumeau puis le bilan.
      await prisma.regulatoryJob.create({
        data: { companyId: v.dossier.companyId, dossierId: v.dossierId, dossierVersionId: v.id, type: "FACTS", status: "QUEUED", payload: {} },
      });
      await regAudit({
        companyId: v.dossier.companyId, actorId: "system", dossierId: v.dossierId, dossierVersionId: v.id,
        action: "PIPELINE_RESUMED",
        detail: `Reprise automatique : l'analyse de « ${v.dossier.reference} » était arrêtée sans bilan ni tâche en file.`,
      });
    }
    return versions.length;
  } catch (e) {
    console.error("[reg-catchup] reprise des pipelines arrêtés impossible", e);
    return 0;
  }
}
