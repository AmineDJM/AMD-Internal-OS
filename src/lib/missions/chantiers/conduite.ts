import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { avancer, type EngineDeps, type StepContext, type StepOutcome } from "@/lib/missions/runtime/engine";
import { compter, journaliser } from "@/lib/missions/runtime/store";
import { rendreBail } from "@/lib/missions/runtime/bail";
import { mettreEnPause, reprendre } from "@/lib/missions/runtime/control";
import { systemClock, type CapabilityRunner, type Clock, type MissionActor, type PorteAttention } from "@/lib/missions/ports";
import type { LecteurInterrupteur } from "@/lib/interrupteurs/missions";
import type { JugeObjectif } from "@/lib/missions/goal/evaluate";
import { signalerUneFois } from "@/lib/missions/travaux/signaux";
import { TYPES_ETAPE_CHANTIER, type TypeEtapeChantier } from "@/lib/missions/chantiers/plan";
import { jugerPreuves, lireDossier, type DossierChantier } from "@/lib/missions/chantiers/dossier";
import { MOTIF_BUDGET_CHANTIER, lireReglagesChantiers, motifBudgetChantier, type ConsommationChantier, type ReglagesChantiers } from "@/lib/missions/chantiers/regles";
import { executerEtape, rapporter, type ContexteEtape, type PortsDev } from "@/lib/missions/chantiers/etapes";
import { cerveauReel, type CerveauChantier } from "@/lib/missions/chantiers/cerveau";
import { portsDevBranches } from "@/lib/missions/chantiers/ports-dev";
import { liberer, prolonger } from "@/lib/missions/chantiers/reservations";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * CONDUIRE UN CHANTIER (lot C1, décision 0041) — le Mission Runtime, sans second moteur.
 *
 * Un passage : (1) le Super Admin a-t-il ENCORE ce rôle ? (2) les attentes DATÉES dues repartent en file ;
 * (3) les réservations sont prolongées ; (4) quelques VAGUES de `avancer`, un plafond relu AVANT chacune ; (5) à la
 * fin, si le chantier est fini sans rapport (blocage, annulation), le rapport est écrit quand même — personne
 * n'apprend un échec par le silence. Le bail, l'idempotence, la reprise d'une étape « en cours » d'un processus
 * tué, les reçus : tout cela est le moteur, déjà écrit et déjà éprouvé.
 *
 * LE JUGE est celui des PREUVES (`jugerPreuves`) : déterministe, il lit ce que GitHub et Render ont rendu. Pas de
 * preuve, pas de « terminé » — le chantier finit BLOQUÉ avec la liste de ce qui manque.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const KIND_CHANTIER = "CHANTIER";
export const PERSONA_CHANTIER = "ADAM";
export const MOTIF_DROITS_CHANTIER = "DROITS";

export interface DepsChantier {
  /** Les connecteurs. Absent : ceux qu'a branchés C2 (`brancherPortsDev`) ; aucun → le chantier attend et le dit. */
  ports?: PortsDev | null;
  cerveau?: CerveauChantier;
  clock?: Clock;
  reglages?: ReglagesChantiers;
  vagues?: number;
  dureeMaxMs?: number;
  interrupteur?: LecteurInterrupteur;
  /** RÉSERVÉ AUX TESTS : un point d'arrêt avant chaque étape (SIGKILL simulé). */
  sondes?: { avantEtape?: (cle: string, type: TypeEtapeChantier) => Promise<void> };
}

export interface BilanChantier {
  chantierId: string;
  statut: string | null;
  vagues: number;
  executees: number;
  arret?: "DROITS" | "BUDGET" | "BAIL" | "INTERRUPTEUR" | "DUREE" | "NON_APPROUVE" | "EN_PAUSE" | "PORTS";
}

const TERMINAUX = new Set(["COMPLETED", "CANCELLED"]);
const FINIS = new Set(["COMPLETED", "CANCELLED", "FAILED", "BLOCKED", "PARTIAL"]);
const OCCUPE = new Set(["RUNNING", "READY", "RETRYING"]);

/** Le Super Admin seul conduit un chantier — relu à chaque passage (un rôle retiré à 14 h s'applique à 14 h 01). */
export async function refusChantier(userId: string): Promise<string | null> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { role: true, isActive: true } });
  if (!u || !u.isActive) return "compte inactif";
  return u.role === "SUPER_ADMIN" ? null : "les chantiers de développement sont réservés au Super Admin";
}

export async function lireReglagesConsole(): Promise<ReglagesChantiers> {
  const s = await prisma.appSetting.findUnique({ where: { id: "global" }, select: { chantiersReglages: true } }).catch(() => null);
  return lireReglagesChantiers(s?.chantiersReglages ?? null);
}

/** Minuit à Alger (UTC+1, sans heure d'été) — le jour des plafonds globaux. */
export function debutDuJour(maintenant: Date): Date {
  const alger = new Date(maintenant.getTime() + 3600_000);
  return new Date(Date.UTC(alger.getUTCFullYear(), alger.getUTCMonth(), alger.getUTCDate()) - 3600_000);
}

async function consommation(chantierId: string, d: DossierChantier, maintenant: Date): Promise<ConsommationChantier> {
  const depuis = debutDuJour(maintenant);
  const [m, jour, lancements, deploiements] = await Promise.all([
    prisma.mission.findUnique({ where: { id: chantierId }, select: { costUsd: true } }),
    prisma.modelCallLog.aggregate({ where: { feature: "chantier", at: { gte: depuis } }, _sum: { costUsd: true } }),
    prisma.missionEvent.count({ where: { kind: "CHANTIER_LANCEMENT", at: { gte: depuis }, mission: { kind: KIND_CHANTIER } } }),
    prisma.missionEvent.count({ where: { kind: "CHANTIER_DEPLOIEMENT", at: { gte: depuis }, mission: { kind: KIND_CHANTIER } } }),
  ]);
  return {
    coutUsd: m?.costUsd ?? 0, lancements: d.compteurs.lancements, deploiements: d.compteurs.deploiements,
    jourUsd: Number(jour._sum.costUsd ?? 0), jourLancements: lancements, jourDeploiements: deploiements,
  };
}

async function lireLeDossier(chantierId: string): Promise<DossierChantier> {
  const m = await prisma.mission.findUnique({ where: { id: chantierId }, select: { carnet: true } });
  const d = lireDossier(m?.carnet);
  if (!d) throw new Error(`dossier de chantier illisible : ${chantierId}`);
  return d;
}

/** Une écriture du dossier — relu, modifié, réécrit. Un seul écrivain : la conduite tient le bail, une étape à la fois. */
export async function ecrireDossier(chantierId: string, maj: (d: DossierChantier) => void): Promise<DossierChantier> {
  const d = await lireLeDossier(chantierId);
  maj(d);
  await prisma.mission.update({ where: { id: chantierId }, data: { carnet: { chantier: d } as unknown as Prisma.InputJsonValue } });
  return d;
}

/**
 * LE RÉVEIL DES ATTENTES DATÉES — une étape `WAITING` dont `reessayerA` est passé repart en file (READY). Son compteur
 * de tentatives du MOTEUR est remis à zéro : un sondage n'est pas un échec ; les essais métier vivent dans sa sortie.
 */
export async function remettreEnFile(chantierId: string, maintenant: Date): Promise<number> {
  const dues = await prisma.$queryRaw<{ id: string }[]>`
    SELECT s."id" FROM "MissionStep" s
    WHERE s."missionId" = ${chantierId} AND s."status" = 'WAITING' AND s."nodeType" = 'WORKER' AND s."supersededAt" IS NULL
      AND (s."result"->>'reessayerA') IS NOT NULL AND (s."result"->>'reessayerA') <= ${maintenant.toISOString()}`;
  if (!dues.length) return 0;
  const r = await prisma.missionStep.updateMany({ where: { id: { in: dues.map((x) => x.id) }, status: "WAITING" }, data: { status: "READY", attempt: 0 } });
  return r.count;
}

export async function conduireChantier(chantierId: string, deps: DepsChantier = {}): Promise<BilanChantier> {
  // `opts` : le passe-plat de l'interrupteur s'écrit ainsi (cliquet `suspension.test.ts` — la production ne l'injecte jamais).
  const opts = deps;
  const clock = deps.clock ?? systemClock;
  const bilan: BilanChantier = { chantierId, statut: null, vagues: 0, executees: 0 };
  const m = await prisma.mission.findFirst({
    where: { id: chantierId, kind: KIND_CHANTIER },
    select: { id: true, title: true, status: true, principalId: true, planApprouveLe: true, pausedReason: true, plafondUsd: true },
  });
  if (!m) return bilan;
  bilan.statut = m.status;
  if (!m.planApprouveLe || !m.principalId) return { ...bilan, arret: "NON_APPROUVE" };
  if (TERMINAUX.has(m.status)) return bilan;
  const principalId = m.principalId;
  const reglages = deps.reglages ?? (await lireReglagesConsole());
  let d = await lireLeDossier(chantierId);

  const motifBudget = async (prochain?: "lancement" | "deploiement") =>
    motifBudgetChantier(await consommation(chantierId, d, clock.now()), reglages, m.plafondUsd, prochain);

  if (m.status === "PAUSED") {
    if (!m.pausedReason?.startsWith(MOTIF_BUDGET_CHANTIER) || (await motifBudget()) !== null) return { ...bilan, arret: "EN_PAUSE" };
    await reprendre(chantierId, principalId, "CHANTIER");
    await journaliser(chantierId, "TRAVAIL_REPRIS", "Repris : le plafond le permet de nouveau.", {}, principalId);
  }
  const refus = await refusChantier(principalId);
  if (refus) {
    await mettreEnPause(chantierId, principalId, `${MOTIF_DROITS_CHANTIER} — ${refus}`, "CHANTIER");
    return { ...bilan, statut: "PAUSED", arret: "DROITS" };
  }
  const ports = deps.ports === undefined ? portsDevBranches() : deps.ports;
  if (!ports) {
    await signalerUneFois(chantierId, principalId, "ports:absents", `Chantier en attente : « ${m.title} »`, "Les connecteurs GitHub, Render et Claude Code ne sont pas branchés sur ce serveur : rien n'est lancé.");
    return { ...bilan, arret: "PORTS" };
  }
  const cerveau = deps.cerveau ?? cerveauReel;
  await remettreEnFile(chantierId, clock.now());
  await prolonger(chantierId, clock.now());

  let plafond: string | null = null;
  const contexte = (ctx: StepContext): ContexteEtape => ({
    chantierId, principalId, mission: ctx.mission, step: ctx.step, clock, ports, cerveau, reglages, plafondUsd: m.plafondUsd,
    dossier: async () => (d = await lireLeDossier(chantierId)),
    ecrire: async (maj) => (d = await ecrireDossier(chantierId, maj)),
    conso: () => consommation(chantierId, d, clock.now()),
    journal: (kind, texte, detail) => journaliser(chantierId, kind, texte, { ...(detail ?? {}), stepKey: ctx.step.key }, principalId),
    plafond: (motif) => { plafond = motif; },
    compterModele: async (niveau, coutUsd) => {
      await compter(chantierId, { modelCalls: 1, costUsd: coutUsd ?? 0 });
      await ecrireDossier(chantierId, (x) => { x.compteurs.appelsModeles[niveau] = (x.compteurs.appelsModeles[niveau] ?? 0) + 1; });
    },
    demanderValidation: async (geste, texte) => {
      await journaliser(chantierId, "CHANTIER_VALIDATION_DEMANDEE", `Validation demandée : ${texte}.`, { stepKey: ctx.step.key, geste }, principalId);
      await signalerUneFois(chantierId, principalId, `validation:${ctx.step.key}`, `Validation demandée — « ${m.title} »`, `${texte}. Répondez dans la conversation (« valide » / « refuse »), à l'écrit ou à l'oral.`);
    },
  });

  const etape = async (ctx: StepContext): Promise<StepOutcome> => {
    const type = String(ctx.step.input.chantier ?? "") as TypeEtapeChantier;
    if (!(TYPES_ETAPE_CHANTIER as readonly string[]).includes(type)) return { status: "FAILED", error: `étape hors catalogue : ${type}`, errorKind: "INVALID_STEP", retryable: false };
    await deps.sondes?.avantEtape?.(ctx.step.key, type);
    const cout = async () => (await prisma.mission.findUnique({ where: { id: chantierId }, select: { costUsd: true } }))?.costUsd ?? 0;
    return executerEtape(type, contexte(ctx), cout);
  };

  const juge: JugeObjectif = {
    juger: async () => {
      const f = await prisma.mission.findUnique({ where: { id: chantierId }, select: { costUsd: true } });
      const v = jugerPreuves(await lireLeDossier(chantierId), f ? f.costUsd : null);
      return { satisfait: v.satisfait, raison: v.raison, sansPreuve: v.manquantes, recoursSuggere: null };
    },
  };
  const attention: PorteAttention = {
    signaler: async (s) => {
      const fin = s.kind === "MISSION_COMPLETED" ? "livré" : s.kind === "MISSION_PARTIAL" ? "terminé en partie" : s.kind === "MISSION_BLOCKED" ? "bloqué" : null;
      if (!fin) return { niveau: "JOURNAL", canaux: [], supprime: true };
      const r = (await lireLeDossier(chantierId)).rapport;
      await signalerUneFois(chantierId, principalId, `fin:${s.kind}`, `Chantier ${fin} : « ${m.title} »`, (r?.texte ?? s.raison ?? "").slice(0, 280));
      return { niveau: "INFO", canaux: ["notification"], supprime: false };
    },
  };
  const runner: CapabilityRunner = { run: async () => ({ ok: false, output: null, error: { kind: "UNKNOWN_CAPABILITY", message: "un chantier n'appelle aucune capacité", retryable: false } }) };
  const moteur: EngineDeps = {
    runner, clock, juge, attention, maxTours: 1, handlers: { WORKER: etape },
    ...(opts.interrupteur ? { interrupteur: opts.interrupteur } : {}),
  };
  const actor: MissionActor = { userId: principalId, label: "Adam (chantier de développement)", isAgent: true };

  const debut = Date.now();
  let vides = 0;
  try {
    while (bilan.vagues < (deps.vagues ?? 12)) {
      if (Date.now() - debut > (deps.dureeMaxMs ?? 45_000)) { bilan.arret = "DUREE"; break; }
      const motif = plafond ?? (await motifBudget());
      if (motif) {
        await mettreEnPause(chantierId, principalId, `${MOTIF_BUDGET_CHANTIER} — ${motif}`, "CHANTIER");
        await signalerUneFois(chantierId, principalId, `budget:${clock.now().toISOString().slice(0, 13)}`, `Chantier en pause : « ${m.title} »`, `Plafond atteint : ${motif}. Relevez-le dans Administration › IA › Chantiers, puis reprenez — rien n'est perdu.`);
        bilan.arret = "BUDGET";
        break;
      }
      const r = await avancer(chantierId, actor, moteur);
      bilan.vagues += 1;
      bilan.executees += r.executees;
      bilan.statut = r.status;
      if (r.bailRefuse) { bilan.arret = "BAIL"; break; }
      if (r.suspenduGlobalement) { bilan.arret = "INTERRUPTEUR"; break; }
      if (TERMINAUX.has(r.status) || r.status === "PAUSED") break;
      if (r.executees + r.echouees + r.deployees > 0 && !plafond) { vides = 0; continue; }
      if (plafond) continue;
      if (!OCCUPE.has(r.status) || ++vides >= 2) break;
    }
  } finally {
    await rendreBail(chantierId);
  }
  const apres = await prisma.mission.findUnique({ where: { id: chantierId }, select: { status: true, costUsd: true } });
  bilan.statut = apres?.status ?? bilan.statut;
  if (apres && FINIS.has(apres.status)) await clore(chantierId, principalId, m.title, apres.status, apres.costUsd, clock);
  return bilan;
}

/** LA CLÔTURE — le rapport s'il manque (blocage, échec, annulation), les réservations libérées, la Direction prévenue. */
export async function clore(chantierId: string, principalId: string, titre: string, statut: string, coutUsd: number, clock: Clock = systemClock): Promise<void> {
  const d = await lireLeDossier(chantierId).catch(() => null);
  if (!d) return;
  if (!d.rapport) {
    await rapporter({
      chantierId, clock,
      dossier: () => lireLeDossier(chantierId),
      ecrire: (maj) => ecrireDossier(chantierId, maj),
      journal: (kind, texte, detail) => journaliser(chantierId, kind, texte, detail, principalId),
    }, coutUsd, statut === "CANCELLED" ? "ANNULE" : undefined);
  }
  await liberer(chantierId);
  if (statut !== "COMPLETED") {
    const r = (await lireLeDossier(chantierId)).rapport;
    await signalerUneFois(chantierId, principalId, `fin:${statut}`, `Chantier ${statut === "CANCELLED" ? "annulé" : "arrêté"} : « ${titre} »`, (r?.texte ?? "").slice(0, 280));
  }
}
