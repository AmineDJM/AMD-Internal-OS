import { prisma } from "@/lib/prisma";
import { MissionStatus, OutboundMailStatus } from "@prisma/client";
import { resolveGoogleConfig, missingGoogleVars, GOOGLE_SCOPES } from "./config";
import { computeMissingScopes } from "./scopes";
import { getCommunicationPolicy } from "@/lib/comms/policy";
import { lireInterrupteurMissions } from "@/lib/interrupteurs/missions";
import { WATCH_RENEW_BEFORE_MS } from "./gmail/watch";
import { sansBloquer } from "@/lib/journal";

/**
 * L'ÉTAT DE SANTÉ D'ADAM — ce qu'il faut voir pour savoir s'il est vraiment vivant.
 *
 * Un chef de cabinet qui n'écoute plus ne produit pas d'erreur : il produit du SILENCE. Rien
 * ne remonte, rien n'échoue, et on ne s'en aperçoit que le jour où l'on découvre un message
 * important jamais lu. Cette fonction transforme ce silence en état observable.
 *
 * Elle sert deux écrans qui ne disent pas la même chose : les réglages du PDG (« est-ce que ça
 * marche ? ») et l'observabilité d'administration (« pourquoi ça ne marche pas ? »). Un seul
 * calcul pour les deux : deux sources donneraient tôt ou tard deux vérités.
 *
 * AUCUN JETON N'EST LU ICI, et rien de ce qui sort ne doit pouvoir en révéler un.
 */

export type HealthLevel = "OPERATIONAL" | "DEGRADED" | "DISCONNECTED" | "MISCONFIGURED";

export interface AdamHealth {
  level: HealthLevel;
  /** Ce qui empêche de passer au vert, en français, dans l'ordre d'importance. */
  issues: string[];
  config: {
    configured: boolean;
    missingVars: string[];
    pubsubTopic: string | null;
    expectedAccount: string | null;
  };
  connection: {
    connected: boolean;
    address: string | null;
    paused: boolean;
    status: string;
    hasRefreshToken: boolean;
    missingScopes: string[];
    lastError: string | null;
  };
  watch: {
    armed: boolean;
    expiresAt: Date | null;
    /** Vraie si la veille est expirée ou sur le point de l'être : c'est là qu'on devient sourd. */
    dueSoon: boolean;
    topic: string | null;
    lastError: string | null;
  };
  ingestion: {
    lastNotifiedAt: Date | null;
    lastReconciledAt: Date | null;
    hasHistoryMarker: boolean;
    ingestedTotal: number;
    last24h: number;
  };
  outbound: {
    policy: string;
    outboundPaused: boolean;
    inboundPaused: boolean;
    awaitingApproval: number;
    approvedNotSent: number;
    failed24h: number;
    sent24h: number;
  };
  missions: {
    active: number;
    waiting: number;
    needsCeo: number;
    readyToSend: number;
    /**
     * L'INTERRUPTEUR GLOBAL DES MISSIONS (§118.132) — lu ICI, côté ERP, et servi à l'écran des
     * réglages d'Adam avec le reste de l'état : l'écran est du périmètre d'Adam, et lui faire
     * lire la base ou `lib/missions` directement ajoutait deux franchissements de la frontière
     * que le cliquet a refusés (430 pour 428). L'état d'Adam se lit par sa santé, pas par ses
     * tables — c'est déjà la règle de ce module pour la connexion Google.
     */
    suspension: { active: boolean; depuis: Date | null; par: string | null };
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

export async function adamHealth(now: Date = new Date()): Promise<AdamHealth> {
  const env = process.env as Record<string, string | undefined>;
  const cfg = resolveGoogleConfig(env);
  const missingVars = missingGoogleVars(env);
  const since = new Date(now.getTime() - DAY_MS);

  const conn = await prisma.googleConnection.findFirst({
    where: { status: "connected" },
    include: { gmail: true },
    orderBy: { createdAt: "asc" },
  });

  const policy = await getCommunicationPolicy().catch(sansBloquer("health.adamHealth.getCommunicationPolicy", null));

  // Une seule salve : ces compteurs s'affichent ensemble, ils doivent décrire le même instant.
  const [awaitingApproval, approvedNotSent, failed24h, sent24h, last24h, missionRows] = await Promise.all([
    prisma.outboundMailIntent.count({ where: { status: OutboundMailStatus.AWAITING_APPROVAL } }),
    prisma.outboundMailIntent.count({ where: { status: OutboundMailStatus.APPROVED } }),
    prisma.outboundMailIntent.count({ where: { status: OutboundMailStatus.FAILED, updatedAt: { gte: since } } }),
    prisma.outboundMailIntent.count({ where: { status: OutboundMailStatus.SENT, sentAt: { gte: since } } }),
    conn ? prisma.emailRecord.count({ where: { connectionId: conn.id, createdAt: { gte: since } } }) : Promise.resolve(0),
    prisma.mission.groupBy({ by: ["status"], _count: { _all: true } }),
  ]);

  const missionCount = (s: MissionStatus) => missionRows.find((r) => r.status === s)?._count._all ?? 0;

  // Les droits se comparent SOUS LEUR FORME CANONIQUE : Google répond « …/userinfo.email » là
  // où l'on demande « email ». Voir `scopes.ts` — c'est ce qui affichait deux droits manquants
  // à vie, sur un compte où ils étaient accordés.
  const missingScopes = conn ? computeMissingScopes(GOOGLE_SCOPES, conn.grantedScopes) : [...GOOGLE_SCOPES];

  const watchExpiration = conn?.gmail?.watchExpiration ?? null;
  const watchDueSoon = !watchExpiration || watchExpiration.getTime() - now.getTime() < WATCH_RENEW_BEFORE_MS;

  const issues: string[] = [];
  let level: HealthLevel = "OPERATIONAL";

  if (!cfg) {
    level = "MISCONFIGURED";
    issues.push(`Configuration Google incomplète : ${missingVars.join(", ")} manquant(s).`);
  } else if (!conn) {
    level = "DISCONNECTED";
    issues.push("Aucun compte Google connecté — Adam n'a ni boîte, ni agenda, ni Drive.");
  } else {
    // Connecté : on cherche ce qui rend Adam PARTIELLEMENT sourd ou muet.
    if (conn.paused) {
      level = "DEGRADED";
      issues.push("La connexion Google est en pause : plus rien n'entre ni ne sort.");
    }
    if (!conn.refreshTokenEnc) {
      level = "DEGRADED";
      issues.push("Aucun jeton de rafraîchissement : l'accès expirera sans possibilité de reprise. Reconnectez le compte.");
    }
    if (missingScopes.length) {
      level = "DEGRADED";
      issues.push(`Consentement partiel — ${missingScopes.length} droit(s) manquant(s). Reconnectez pour compléter.`);
    }
    if (!cfg.pubsubTopic) {
      level = "DEGRADED";
      issues.push("GOOGLE_PUBSUB_TOPIC absent : pas de push Gmail. La réconciliation périodique prend le relais, avec du retard.");
    } else if (watchDueSoon) {
      level = "DEGRADED";
      issues.push(
        watchExpiration
          ? "La veille Gmail expire bientôt (ou a expiré) — elle se réarme au prochain battement."
          : "La veille Gmail n'est pas armée : aucun push. Armez-la depuis les réglages.",
      );
    }
    if (conn.gmail?.lastWatchError) {
      level = "DEGRADED";
      issues.push(`Dernière tentative de veille en échec : ${conn.gmail.lastWatchError}`);
    }
    if (conn.lastError) {
      level = "DEGRADED";
      issues.push(`Dernière erreur Google : ${conn.lastError}`);
    }
  }

  // Les coupe-circuits ne sont PAS des pannes : ce sont des décisions. On les montre comme un
  // état volontaire, sans les compter comme des incidents à réparer.
  if (policy?.inboundPaused) issues.push("Coupe-circuit : traitement de la boîte suspendu (volontaire).");
  if (policy?.outboundPaused) issues.push("Coupe-circuit : envoi de courriel suspendu (volontaire).");
  // L'INTERRUPTEUR GLOBAL DES MISSIONS (§118.132) — même famille : une décision, pas une panne.
  const missionsSuspendues = await lireInterrupteurMissions().catch(sansBloquer("health.adamHealth.lireInterrupteurMissions", null));
  if (missionsSuspendues?.suspendues) issues.push("Coupe-circuit : toutes les missions d'Adam sont suspendues (volontaire).");
  const poseur = missionsSuspendues?.parId
    ? await prisma.user.findUnique({ where: { id: missionsSuspendues.parId }, select: { name: true } }).catch(sansBloquer("health.adamHealth.user", null))
    : null;

  return {
    level,
    issues,
    config: {
      configured: Boolean(cfg),
      missingVars,
      pubsubTopic: cfg?.pubsubTopic ?? null,
      expectedAccount: cfg?.adamEmail ?? null,
    },
    connection: {
      connected: Boolean(conn) && !conn?.paused,
      address: conn?.address ?? null,
      paused: conn?.paused ?? false,
      status: conn ? (conn.paused ? "paused" : conn.status) : "none",
      hasRefreshToken: Boolean(conn?.refreshTokenEnc),
      missingScopes,
      lastError: conn?.lastError ?? null,
    },
    watch: {
      armed: Boolean(watchExpiration && watchExpiration.getTime() > now.getTime()),
      expiresAt: watchExpiration,
      dueSoon: watchDueSoon,
      topic: conn?.gmail?.watchTopic ?? null,
      lastError: conn?.gmail?.lastWatchError ?? null,
    },
    ingestion: {
      lastNotifiedAt: conn?.gmail?.lastNotifiedAt ?? null,
      lastReconciledAt: conn?.gmail?.lastReconciledAt ?? null,
      hasHistoryMarker: Boolean(conn?.gmail?.lastHistoryId),
      ingestedTotal: conn?.gmail?.ingestedCount ?? 0,
      last24h,
    },
    outbound: {
      policy: policy?.mailSendPolicy ?? "REQUIRE_APPROVAL",
      outboundPaused: policy?.outboundPaused ?? false,
      inboundPaused: policy?.inboundPaused ?? false,
      awaitingApproval,
      approvedNotSent,
      failed24h,
      sent24h,
    },
    missions: {
      active: missionCount(MissionStatus.ACTIVE),
      waiting: missionCount(MissionStatus.WAITING),
      needsCeo: missionCount(MissionStatus.NEEDS_CEO),
      readyToSend: missionCount(MissionStatus.READY_TO_SEND),
      suspension: {
        active: missionsSuspendues?.suspendues === true,
        depuis: missionsSuspendues?.depuis ?? null,
        par: poseur?.name ?? null,
      },
    },
  };
}
