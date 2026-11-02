import { prisma } from "@/lib/prisma";
import { getActiveGoogleConnection } from "../connection";
import { getProfile, listMessageIds } from "./messages";
import { listHistory, addedMessageIds, startWatch, WATCH_RENEW_BEFORE_MS } from "./watch";
import { ingestMessages } from "./ingest";
import { resolveGoogleConfig } from "../config";
import { getCommunicationPolicy } from "@/lib/comms/policy";
import { sansBloquer } from "@/lib/journal";

/**
 * ADAM NE DEVIENT JAMAIS SOURD — reprise, réconciliation, renouvellement de la veille.
 *
 * Le push est rapide mais fragile : un redémarrage au mauvais moment, une coupure réseau, une
 * veille expirée, un Pub/Sub perdu — et un message n'entre jamais dans la conscience d'Adam.
 * Personne ne s'en aperçoit : c'est un silence, pas une erreur.
 *
 * On ne parie donc jamais sur le push seul. Trois filets, du plus précis au plus large :
 *   1. `syncFromHistory` — rejoue l'histoire depuis le dernier point connu (le chemin normal) ;
 *   2. le repli sur une LISTE récente quand Google a purgé l'historique (`historyExpired`) ;
 *   3. `reconcileInbox` — passage périodique qui reprend les derniers messages, quoi qu'il arrive.
 *
 * Le point d'histoire n'avance qu'APRÈS traitement réussi : un plantage en cours de route fait
 * simplement rejouer les mêmes messages, et l'ingestion est idempotente.
 */

export interface SyncOutcome {
  ingested: number;
  duplicates: number;
  failed: number;
  /** Comment on a repris : histoire incrémentale, ou liste récente après purge. */
  via: "history" | "recent-list" | "bootstrap" | "skipped";
  reason?: string;
}

/** La connexion Google du PDG (une seule identité aujourd'hui — le modèle en accepte plusieurs). */
export async function adamConnection() {
  return prisma.googleConnection.findFirst({
    where: { status: "connected", paused: false },
    include: { gmail: true },
    orderBy: { createdAt: "asc" },
  });
}

/**
 * Reprend le fil depuis le dernier `historyId` connu.
 *
 * Sans point de départ (première connexion), on ne rejoue PAS toute la boîte : on prend les
 * messages récents et on pose le point. Ingérer dix ans d'archives au premier démarrage
 * coûterait cher et noierait la mémoire exécutive sous du courrier mort.
 */
export async function syncFromHistory(connectionId: string, opts: { bootstrapCount?: number } = {}): Promise<SyncOutcome> {
  const conn = await prisma.googleConnection.findUnique({
    where: { id: connectionId },
    include: { gmail: true },
  });
  if (!conn || conn.paused) return { ingested: 0, duplicates: 0, failed: 0, via: "skipped", reason: "connexion absente ou suspendue" };

  const active = await getActiveGoogleConnection(conn.userId);
  if (!active) return { ingested: 0, duplicates: 0, failed: 0, via: "skipped", reason: "compte non connecté" };

  const state = conn.gmail;
  const startHistoryId = state?.lastHistoryId ?? null;

  if (!startHistoryId) {
    const profile = await getProfile(active.accessToken);
    const { ids } = await listMessageIds(active.accessToken, { labelIds: ["INBOX"], maxResults: opts.bootstrapCount ?? 15 });
    const res = await ingestMessages(connectionId, ids.map((m) => m.id));
    await upsertState(connectionId, { lastHistoryId: profile.historyId, lastReconciledAt: new Date() });
    return { ...res, via: "bootstrap" };
  }

  const history = await listHistory(active.accessToken, startHistoryId);
  if (history.expired) {
    // L'historique a été purgé : on repart d'une liste récente plutôt que de perdre le fil.
    const profile = await getProfile(active.accessToken);
    const { ids } = await listMessageIds(active.accessToken, { labelIds: ["INBOX"], maxResults: 25 });
    const res = await ingestMessages(connectionId, ids.map((m) => m.id));
    await upsertState(connectionId, { lastHistoryId: profile.historyId, lastReconciledAt: new Date() });
    return { ...res, via: "recent-list", reason: "historique Gmail purgé" };
  }

  const ids = addedMessageIds(history);
  const res = ids.length ? await ingestMessages(connectionId, ids) : { ingested: 0, duplicates: 0, failed: 0 };
  // Le point n'avance qu'ici : un échec plus haut fait rejouer les mêmes messages, sans doublon.
  if (history.historyId) await upsertState(connectionId, { lastHistoryId: history.historyId });
  return { ...res, via: "history" };
}

/** Les champs d'état réellement modifiables — nommés, pour qu'une faute de frappe se voie. */
interface IngestionStatePatch {
  lastHistoryId?: string | null;
  watchExpiration?: Date | null;
  watchTopic?: string | null;
  lastNotifiedAt?: Date | null;
  lastReconciledAt?: Date | null;
  lastWatchError?: string | null;
}

async function upsertState(connectionId: string, data: IngestionStatePatch): Promise<void> {
  await prisma.gmailIngestionState.upsert({
    where: { connectionId },
    create: { connectionId, ...data },
    update: data,
  });
}

/**
 * LE FILET PÉRIODIQUE — reprend les messages récents, quoi qu'il soit arrivé au push.
 *
 * Volontairement simple et borné : on relit les derniers messages de la boîte de réception et on
 * laisse l'idempotence faire le tri. C'est ce qui garantit qu'un serveur redémarré, une veille
 * expirée ou un Pub/Sub perdu ne créent jamais de trou.
 */
export async function reconcileInbox(connectionId: string, maxResults = 20): Promise<SyncOutcome> {
  const conn = await prisma.googleConnection.findUnique({ where: { id: connectionId }, select: { userId: true, paused: true } });
  if (!conn || conn.paused) return { ingested: 0, duplicates: 0, failed: 0, via: "skipped" };
  const active = await getActiveGoogleConnection(conn.userId);
  if (!active) return { ingested: 0, duplicates: 0, failed: 0, via: "skipped", reason: "compte non connecté" };

  const { ids } = await listMessageIds(active.accessToken, { labelIds: ["INBOX"], maxResults });
  const res = await ingestMessages(connectionId, ids.map((m) => m.id));
  const profile = await getProfile(active.accessToken).catch(sansBloquer("gmail-reconcile.reconcileInbox.getProfile", null));
  await upsertState(connectionId, {
    lastReconciledAt: new Date(),
    ...(profile?.historyId ? { lastHistoryId: profile.historyId } : {}),
  });
  return { ...res, via: "recent-list" };
}

export interface WatchOutcome {
  renewed: boolean;
  expiresAt: Date | null;
  reason?: string;
}

/**
 * Renouvelle la veille AVANT qu'elle n'expire.
 *
 * Google la borne à sept jours ; on ré-arme à un jour et demi de l'échéance. Attendre l'expiration
 * réelle laisserait une fenêtre de silence, et une fenêtre de silence sur une boîte de direction
 * finit toujours par tomber le mauvais jour.
 */
export async function ensureWatch(connectionId: string, opts: { force?: boolean; now?: Date } = {}): Promise<WatchOutcome> {
  const cfg = resolveGoogleConfig(process.env as Record<string, string | undefined>);
  if (!cfg?.pubsubTopic) return { renewed: false, expiresAt: null, reason: "GOOGLE_PUBSUB_TOPIC non configuré" };

  const conn = await prisma.googleConnection.findUnique({ where: { id: connectionId }, include: { gmail: true } });
  if (!conn || conn.paused) return { renewed: false, expiresAt: null, reason: "connexion absente ou suspendue" };

  const now = opts.now ?? new Date();
  const expiration = conn.gmail?.watchExpiration ?? null;
  const dueSoon = !expiration || expiration.getTime() - now.getTime() < WATCH_RENEW_BEFORE_MS;
  if (!dueSoon && !opts.force) return { renewed: false, expiresAt: expiration };

  const active = await getActiveGoogleConnection(conn.userId);
  if (!active) return { renewed: false, expiresAt: expiration, reason: "compte non connecté" };

  try {
    const res = await startWatch(active.accessToken, cfg.pubsubTopic);
    await upsertState(connectionId, {
      watchExpiration: res.expiration,
      watchTopic: cfg.pubsubTopic,
      lastWatchError: null,
      // Un premier armement fournit le point d'histoire de départ.
      ...(conn.gmail?.lastHistoryId ? {} : { lastHistoryId: res.historyId }),
    });
    return { renewed: true, expiresAt: res.expiration };
  } catch (err) {
    const reason = err instanceof Error ? err.message.slice(0, 200) : "échec inconnu";
    await upsertState(connectionId, { lastWatchError: reason });
    return { renewed: false, expiresAt: expiration, reason };
  }
}

/**
 * LE BATTEMENT D'ADAM — appelé par le planificateur, sans navigateur ouvert.
 *
 * Trois gestes dans l'ordre : garder l'oreille (veille), rattraper ce qui est arrivé (histoire),
 * et se rattraper soi-même de temps en temps (réconciliation). Ne lève jamais : un incident
 * Google ne doit pas faire tomber le reste des tâches planifiées.
 */
export async function runAdamInboxSweep(opts: { reconcileEveryMs?: number; now?: Date } = {}): Promise<SyncOutcome & { watch?: WatchOutcome }> {
  // ARRÊT D'URGENCE ENTRANT — vérifié AVANT le moindre appel à Google. `ingestMessage` le
  // revérifie de son côté (c'est lui la vraie barrière, y compris pour le push), mais s'arrêter
  // seulement là consommerait quand même le quota Gmail à chaque battement. « Suspendre le
  // traitement de la boîte » doit vraiment tout arrêter, trafic réseau compris.
  const policy = await getCommunicationPolicy().catch(sansBloquer("gmail-reconcile.runAdamInboxSweep.getCommunicationPolicy", null));
  if (policy?.inboundPaused) {
    return { ingested: 0, duplicates: 0, failed: 0, via: "skipped", reason: "traitement de la boîte suspendu" };
  }

  const conn = await adamConnection();
  if (!conn) return { ingested: 0, duplicates: 0, failed: 0, via: "skipped", reason: "aucune connexion Google" };

  const watch = await ensureWatch(conn.id, { now: opts.now }).catch(sansBloquer("gmail-reconcile.runAdamInboxSweep.ensureWatch", { renewed: false, expiresAt: null, reason: "veille indisponible" }));

  const now = opts.now ?? new Date();
  const lastReconciled = conn.gmail?.lastReconciledAt ?? null;
  const needsFullReconcile =
    !lastReconciled || now.getTime() - lastReconciled.getTime() > (opts.reconcileEveryMs ?? 30 * 60_000);

  try {
    const res = needsFullReconcile ? await reconcileInbox(conn.id) : await syncFromHistory(conn.id);
    return { ...res, watch };
  } catch (err) {
    return {
      ingested: 0, duplicates: 0, failed: 0, via: "skipped",
      reason: err instanceof Error ? err.message.slice(0, 200) : "échec de synchronisation",
      watch,
    };
  }
}
