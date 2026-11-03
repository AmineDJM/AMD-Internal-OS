import type { Prisma } from "@prisma/client";
import { lireDossier } from "@/lib/missions/chantiers/dossier";
import { prisma } from "@/lib/prisma";
import type { ConflitDeclare, PlanProgramme } from "@/lib/missions/equipe/programme";
import { ETATS_TACHE, sessionsHeureMax, type EtatTache } from "@/lib/missions/equipe/ordonnanceur";

/**
 * LE DOSSIER D'UN PROGRAMME (lot O2, décision 0059) — dans `Mission.carnet.programme`, écrit par UN seul écrivain : la
 * conduite qui tient le bail du programme. L'état de chaque tâche, son chantier, ses retours chez le travailleur, les
 * consignes de la Direction, et qui a planifié (MiMo, Sol, ou Terra qui a donné le plan tel quel).
 */

export interface EtatDeTache {
  etat: EtatTache;
  chantierId: string | null;
  branche: string;
  /** Le n° de la session de cette tâche (1, puis 2 après une replanification) — la clé d'idempotence du lancement. */
  essai: number;
  renvois: number;
  raison: string | null;
  integreeSha: string | null;
  majLe: string;
}

export interface DossierProgramme {
  plan: PlanProgramme;
  taches: Record<string, EtatDeTache>;
  conflits: ConflitDeclare[];
  regroupees: string[][];
  planifiePar: "MIMO" | "SOL" | "TERRA";
  replanifications: number;
  consignes: { texte: string; par: string; le: string; tache: string | null }[];
  attenteConsignes: string | null;
}

export const brancheDeTache = (programmeId: string, cle: string) => `claude/prog-${programmeId.slice(-8)}-${cle}`.slice(0, 120);

export function dossierProgrammeInitial(programmeId: string, d: Pick<DossierProgramme, "plan" | "conflits" | "regroupees" | "planifiePar">, le: string): DossierProgramme {
  return {
    ...d, replanifications: 0, consignes: [], attenteConsignes: null,
    taches: Object.fromEntries(d.plan.taches.map((t) => [t.cle, { etat: "ATTENTE" as const, chantierId: null, branche: brancheDeTache(programmeId, t.cle), essai: 0, renvois: 0, raison: null, integreeSha: null, majLe: le }])),
  };
}

export function lireDossierProgramme(carnet: unknown): DossierProgramme | null {
  const c = carnet && typeof carnet === "object" && !Array.isArray(carnet) ? (carnet as Record<string, unknown>).programme : null;
  if (!c || typeof c !== "object") return null;
  const d = c as DossierProgramme;
  if (!d.plan || !Array.isArray(d.plan.taches) || !d.taches) return null;
  for (const t of Object.values(d.taches)) if (!(ETATS_TACHE as readonly string[]).includes(t.etat)) return null;
  return d;
}

export async function lireLeDossierProgramme(programmeId: string): Promise<DossierProgramme> {
  const m = await prisma.mission.findUnique({ where: { id: programmeId }, select: { carnet: true } });
  const d = lireDossierProgramme(m?.carnet);
  if (!d) throw new Error(`dossier de programme illisible : ${programmeId}`);
  return d;
}

/** Relu, modifié, réécrit — les autres clés du carnet sont gardées. */
export async function ecrireDossierProgramme(programmeId: string, maj: (d: DossierProgramme) => void): Promise<DossierProgramme> {
  const m = await prisma.mission.findUnique({ where: { id: programmeId }, select: { carnet: true } });
  const d = lireDossierProgramme(m?.carnet);
  if (!d) throw new Error(`dossier de programme illisible : ${programmeId}`);
  maj(d);
  const carnet = m?.carnet && typeof m.carnet === "object" && !Array.isArray(m.carnet) ? (m.carnet as Record<string, unknown>) : {};
  await prisma.mission.update({ where: { id: programmeId }, data: { carnet: { ...carnet, programme: d } as unknown as Prisma.InputJsonValue } });
  return d;
}

export const etatsDesTaches = (d: DossierProgramme): Record<string, EtatTache> => Object.fromEntries(Object.entries(d.taches).map(([k, v]) => [k, v.etat]));

/**
 * LES COÛTS D'UN PROGRAMME, PAR NATURE (décision de la Direction, 02/11 : les sessions cloud sont sur l'abonnement) —
 * jamais additionnés : les DOLLARS des modèles (MiMo/Sol/Terra : la planification sur le programme, les résumés et
 * arbitrages sur ses chantiers — journal K8 `ModelCallLog`), et ce que l'abonnement compte : les SESSIONS lancées (dont
 * l'heure glissante, face au quota des Routines), leur DURÉE, les TENTATIVES (relances et renvois).
 */
export interface CoutsProgramme {
  modelesUsd: { superviseur: number; chantiers: number };
  sessions: { lancees: number; derniereHeure: number; plafondHeure: number };
  dureeMinutes: number;
  tentatives: number;
  infra: string;
}

export function coutsDuProgramme(
  superviseurUsd: number, enfants: readonly { costUsd: number; startedAt: Date | null; closedAt: Date | null; carnet: unknown }[], d: DossierProgramme, maintenant: Date,
): CoutsProgramme {
  const arrondi = (x: number) => Math.round(x * 10_000) / 10_000;
  const sessions = enfants.flatMap((e) => lireDossier(e.carnet)?.sessions ?? []);
  const duree = enfants.reduce((s, e) => s + (e.startedAt ? ((e.closedAt ?? maintenant).getTime() - e.startedAt.getTime()) : 0), 0);
  const renvois = Object.values(d.taches).reduce((s, t) => s + t.renvois, 0);
  return {
    modelesUsd: { superviseur: arrondi(superviseurUsd), chantiers: arrondi(enfants.reduce((s, e) => s + e.costUsd, 0)) },
    sessions: { lancees: sessions.length, derniereHeure: sessions.filter((x) => new Date(x.le).getTime() > maintenant.getTime() - 3600_000).length, plafondHeure: sessionsHeureMax() },
    dureeMinutes: Math.round(duree / 60_000),
    tentatives: Math.max(0, sessions.length - enfants.length) + renvois,
    infra: "aucun déploiement (un programme ne déploie pas) ; minutes de CI GitHub non mesurées",
  };
}
