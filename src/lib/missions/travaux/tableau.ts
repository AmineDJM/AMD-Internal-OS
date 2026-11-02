import { prisma } from "@/lib/prisma";
import { lireCarnet } from "@/lib/missions/travaux/carnet";
import { etatTravail, MOTIF_ARRET, phraseAttente, type EtatTravail } from "@/lib/missions/travaux/regles";
import { prioriteDe, type PrioriteTravail } from "@/lib/missions/travaux/plan";
import { lireDossier, vueDossier, type VueDossier } from "@/lib/missions/chantiers/dossier";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE TABLEAU DE BORD DES MISSIONS (K3, décision 0033) — ce que l'écran « Missions » montre EN TEMPS RÉEL :
 * chaque travail (sous-mission) de la personne, ses étapes une à une (en file, en cours, faite, en attente, échec),
 * l'avancement des lots d'un éventail, le coût, la durée, les derniers mots du journal et les livrables.
 *
 * Le cloisonnement est dans la signature, comme partout dans les travaux : `principalId` dans chaque `where`.
 * `signatureTableau` est la question BON MARCHÉ que le flux pose chaque seconde (une agrégation, aucune ligne
 * rapatriée) : le tableau complet n'est relu que lorsqu'elle change.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** L'état d'une étape tel que l'écran le dit — cinq familles, quelle que soit la richesse du moteur. */
export type EtatEtapeTableau = "FILE" | "EN_COURS" | "FAITE" | "ATTENTE" | "ECHEC" | "ECARTEE";

export function etatEtape(status: string): EtatEtapeTableau {
  if (status === "RUNNING" || status === "RETRYING") return "EN_COURS";
  if (status === "DONE") return "FAITE";
  if (status === "WAITING") return "ATTENTE";
  if (status === "FAILED") return "ECHEC";
  if (status === "SKIPPED" || status === "CANCELLED") return "ECARTEE";
  return "FILE";
}

export interface EtapeTableau {
  cle: string;
  titre: string;
  type: string;
  etat: EtatEtapeTableau;
  debut: string | null;
  fin: string | null;
  erreur: string | null;
  /** Un éventail (ANALYSE pour chaque lot) : ses lots faits sur le total déployé. */
  lots: { faits: number; total: number } | null;
  /** C1 : une étape de chantier — ses essais métier (tentatives, tours de correction) et ce qu'elle attend. */
  essais?: number;
}

/** C1 (décision 0042) : ce qu'un CHANTIER montre de plus au tableau — dépôt, réservations, liens, preuves, budget. */
export interface ChantierTableau extends VueDossier {
  lancements: number;
  deploiementsFaits: number;
  validationsAttendues: number;
  blocage: string | null;
}

export interface MissionTableau {
  id: string;
  parentId: string | null;
  titre: string;
  objectif: string;
  etat: EtatTravail;
  priorite: PrioriteTravail;
  attente: string | null;
  /** P1 : le motif d'une pause (plafond, arrêt, fusion) — le diagnostic le dit. */
  motifPause: string | null;
  coutUsd: number;
  plafondUsd: number | null;
  creeLe: string;
  demarreLe: string | null;
  finiLe: string | null;
  majLe: string;
  /** Démarré sans clic (plan sans geste, réglage « démarrer d'office »). */
  dOffice: boolean;
  avancement: { faites: number; total: number; enCours: number; enEchec: number };
  etapes: EtapeTableau[];
  journal: { at: string; texte: string }[];
  livrables: { titre: string; nodeId: string | null; nom: string | null }[];
  /** C1 : présent pour un chantier de développement (`kind = "CHANTIER"`, Super Admin). */
  chantier?: ChantierTableau;
}

const TYPE: Record<string, string> = { CAPABILITY: "Lecture", WORKER: "Analyse", WAIT_EVENT: "Attente", WAIT_INPUT: "Demande", ARTIFACT: "Livrable", JOIN: "Jonction" };
const FINIS = ["COMPLETED", "CANCELLED", "FAILED"];
/** Les missions finies restent au tableau ce temps-là, puis n'y sont plus (elles restent au panneau « Travaux »). */
export const RETENUE_FINIES_MS = 3 * 24 * 3600_000;
const JOURNAL = ["TRAVAIL_PROPOSE", "TRAVAIL_APPROUVE", "TRAVAIL_RENOMME", "TRAVAIL_FUSION", "TRAVAIL_DOFFICE", "TRAVAIL_REPRIS", "PAUSED", "RESUMED", "CLOSED", "LIVRABLE_DEPOSE", "GESTE_REFUSE", "STEP_RECLAIMED", "DEMANDE_DEPOSEE", "DEMANDE_REPONDUE",
  "CHANTIER_LANCEMENT", "CHANTIER_PR", "CHANTIER_VERT", "CHANTIER_ROUGE", "CHANTIER_BLOQUE", "CHANTIER_FUSION", "CHANTIER_DEPLOIEMENT", "CHANTIER_SAIN", "CHANTIER_MALSAIN",
  "CHANTIER_ROLLBACK", "CHANTIER_RAPPORT", "CHANTIER_AUTOFIX", "CHANTIER_VALIDATION_DEMANDEE", "CHANTIER_VALIDATION_ACCORDEE", "CHANTIER_VALIDATION_REFUSEE", "CHANTIER_ATTEND_RESERVATION",
  "CHANTIER_REVERT", "CHANTIER_REVERT_DEMANDE", "CHANTIER_REVERT_ECHEC"];
/** Les familles du tableau : les travaux de la personne et (C1) ses chantiers de développement — le même moteur, le même écran. */
const FAMILLES = ["TRAVAIL", "CHANTIER"];
const TYPE_CHANTIER: Record<string, string> = {
  DEV_LANCER: "Lancement", DEV_ATTENDRE: "Attente des commits", DEV_VERIFIER: "Vérification", DEV_CORRIGER: "Correction", DEV_FUSIONNER: "Fusion",
  RENDER_DEPLOYER: "Déploiement", RENDER_VERIFIER: "Santé", RENDER_ROLLBACK: "Rollback", RAPPORT: "Rapport",
};

const ouVisible = (principalId: string, maintenant: Date) => ({
  kind: { in: FAMILLES }, principalId, ownerId: principalId,
  OR: [{ status: { notIn: FINIS as never[] } }, { updatedAt: { gte: new Date(maintenant.getTime() - RETENUE_FINIES_MS) } }],
  // P1 (décision 0047) : un travail ARRÊTÉ (pause marquée) se range avec les finis — et quitte le tableau après la même retenue.
  NOT: { status: "PAUSED" as never, pausedReason: { startsWith: MOTIF_ARRET }, updatedAt: { lt: new Date(maintenant.getTime() - RETENUE_FINIES_MS) } },
});

/**
 * LA SIGNATURE du tableau d'une personne : nombre de missions visibles, dernière écriture d'une mission ou d'une
 * étape. Elle change dès qu'une étape change d'état — c'est elle que le flux surveille.
 */
export async function signatureTableau(principalId: string, maintenant = new Date()): Promise<string> {
  const depuis = new Date(maintenant.getTime() - RETENUE_FINIES_MS);
  const [r] = await prisma.$queryRaw<{ n: bigint; m: Date | null; s: Date | null; e: bigint }[]>`
    SELECT COUNT(DISTINCT m."id") AS n, MAX(m."updatedAt") AS m, MAX(st."updatedAt") AS s, COUNT(st."id") AS e
    FROM "Mission" m LEFT JOIN "MissionStep" st ON st."missionId" = m."id"
    WHERE m."kind" IN ('TRAVAIL', 'CHANTIER') AND m."principalId" = ${principalId} AND m."ownerId" = ${principalId}
      AND (m."status" NOT IN ('COMPLETED', 'CANCELLED', 'FAILED') OR m."updatedAt" >= ${depuis})`;
  return `${r?.n ?? 0}|${r?.m?.getTime() ?? 0}|${r?.s?.getTime() ?? 0}|${r?.e ?? 0}`;
}

/** LE TABLEAU d'une personne — les vivantes d'abord, puis les finies récentes ; 40 au plus. */
export async function tableauDesTravaux(principalId: string, maintenant = new Date()): Promise<MissionTableau[]> {
  const ms = await prisma.mission.findMany({
    where: ouVisible(principalId, maintenant),
    select: {
      id: true, parentMissionId: true, title: true, objective: true, status: true, pausedReason: true, priority: true, costUsd: true, plafondUsd: true,
      createdAt: true, startedAt: true, closedAt: true, updatedAt: true, carnet: true, kind: true,
      reservationsChantier: { select: { cle: true }, orderBy: { cle: "asc" } },
      steps: {
        where: { supersededAt: null },
        select: { key: true, title: true, nodeType: true, capability: true, status: true, startedAt: true, completedAt: true, updatedAt: true, error: true, forEach: true, input: true, result: true },
        orderBy: [{ createdAt: "asc" }, { key: "asc" }],
      },
      events: { where: { kind: { in: JOURNAL } }, select: { at: true, summary: true, kind: true }, orderBy: { at: "desc" }, take: 8 },
    },
    orderBy: { createdAt: "desc" },
    take: 40,
  });
  const vues = ms.map((m): MissionTableau => {
    const haut = m.steps.filter((s) => !s.key.includes("#"));
    const etapes = haut.map((s): EtapeTableau => {
      const enfants = s.forEach ? m.steps.filter((x) => x.key.startsWith(`${s.key}#`)) : [];
      const typeChantier = m.kind === "CHANTIER" ? TYPE_CHANTIER[String((s.input as { chantier?: string } | null)?.chantier ?? "")] : undefined;
      const r = (s.result ?? {}) as { essais?: number; tour?: number; tours?: number; attente?: string };
      return {
        cle: s.key, titre: s.title,
        ...(typeChantier ? { essais: Math.max(r.essais ?? 0, r.tour ?? 0, r.tours ?? 0) } : {}),
        type: typeChantier ?? (s.capability?.startsWith("geste:") ? "Geste" : s.forEach ? "Analyse par lot" : (TYPE[s.nodeType] ?? s.nodeType)),
        etat: etatEtape(s.status),
        debut: s.startedAt?.toISOString() ?? null,
        fin: s.completedAt?.toISOString() ?? (["DONE", "FAILED", "SKIPPED", "CANCELLED"].includes(s.status) ? s.updatedAt.toISOString() : null),
        // P1 : une étape qui RÉESSAIE (RETRYING, ou en file après un échec) dit sa dernière erreur — sinon « En cours » sans fin.
        erreur: s.status === "FAILED" ? (s.error ?? "échec") : (s.error && ["RETRYING", "READY", "PENDING", "RUNNING"].includes(s.status) ? s.error : null),
        lots: s.forEach ? { faits: enfants.filter((x) => x.status === "DONE" || x.status === "SKIPPED").length, total: enfants.length } : null,
      };
    });
    const attente = haut.find((s) => s.status === "WAITING" && (s.nodeType === "WAIT_EVENT" || s.nodeType === "WAIT_INPUT"));
    const dossier = m.kind === "CHANTIER" ? lireDossier(m.carnet) : null;
    const attenteChantier = dossier ? haut.find((s) => s.status === "WAITING") : undefined;
    const carnet = lireCarnet(m.carnet);
    return {
      id: m.id, parentId: m.parentMissionId, titre: m.title, objectif: m.objective,
      etat: etatTravail(m.status, m.pausedReason), priorite: prioriteDe(m.priority), motifPause: m.status === "PAUSED" ? m.pausedReason : null,
      attente: attenteChantier ? String((attenteChantier.result as { attente?: string } | null)?.attente ?? phraseAttente(attenteChantier.title, attenteChantier.updatedAt, maintenant))
        : attente ? phraseAttente(attente.title, attente.updatedAt, maintenant) : null,
      coutUsd: Math.round(m.costUsd * 10_000) / 10_000, plafondUsd: m.plafondUsd,
      creeLe: m.createdAt.toISOString(), demarreLe: m.startedAt?.toISOString() ?? null,
      finiLe: m.closedAt?.toISOString() ?? (FINIS.includes(m.status) ? m.updatedAt.toISOString() : null),
      majLe: m.updatedAt.toISOString(),
      dOffice: m.events.some((e) => e.kind === "TRAVAIL_DOFFICE"),
      avancement: {
        faites: etapes.filter((e) => e.etat === "FAITE" || e.etat === "ECARTEE").length, total: etapes.length,
        enCours: etapes.filter((e) => e.etat === "EN_COURS").length, enEchec: etapes.filter((e) => e.etat === "ECHEC").length,
      },
      etapes,
      journal: m.events.slice(0, 6).map((e) => ({ at: e.at.toISOString(), texte: e.summary })),
      livrables: carnet.livrables.map((l) => ({ titre: l.titre, nodeId: l.document?.nodeId ?? null, nom: l.document?.nom ?? null })),
      ...(dossier ? {
        chantier: {
          ...vueDossier(dossier, m.reservationsChantier.map((r) => r.cle)),
          lancements: dossier.compteurs.lancements, deploiementsFaits: dossier.compteurs.deploiements,
          validationsAttendues: haut.filter((s) => s.status === "WAITING" && (s.result as { validationDemandee?: boolean } | null)?.validationDemandee && !dossier.validations[s.key]).length,
          blocage: dossier.blocage,
        },
      } : {}),
    };
  });
  const vivante = (v: MissionTableau) => !["TERMINE", "ANNULE", "ECHEC"].includes(v.etat);
  return vues.sort((a, b) => Number(vivante(b)) - Number(vivante(a)));
}
