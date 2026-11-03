import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { journaliser, compter } from "@/lib/missions/runtime/store";
import { annuler, reprendre } from "@/lib/missions/runtime/control";
import { systemClock, type Clock } from "@/lib/missions/ports";
import { refusChantier, lireReglagesConsole } from "@/lib/missions/chantiers/conduite";
import { annulerChantier, donnerConsigneChantier } from "@/lib/missions/chantiers/service";
import { MOTIF_BUDGET_CHANTIER, MOTIF_CONSIGNES_CHANTIER } from "@/lib/missions/chantiers/regles";
import { lireDossier } from "@/lib/missions/chantiers/dossier";
import { cerveauReel, type CerveauChantier } from "@/lib/missions/chantiers/cerveau";
import type { PortsDev } from "@/lib/missions/chantiers/etapes";
import { liberer } from "@/lib/missions/chantiers/reservations";
import { KIND_PROGRAMME, lirePlanProgramme, type LecturePlan } from "@/lib/missions/equipe/programme";
import { planifier } from "@/lib/missions/equipe/planificateur";
import { validerIntegration } from "@/lib/missions/equipe/integration";
import { coutsDuProgramme, type CoutsProgramme, dossierProgrammeInitial, ecrireDossierProgramme, lireDossierProgramme, type DossierProgramme } from "@/lib/missions/equipe/dossier";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES PROGRAMMES DU SUPER ADMIN (lot O2, décision 0059) — lancer (MiMo planifie, le code valide), consigner, annuler,
 * « où en est ». Cloisonné comme les chantiers : `principalId` dans chaque `where`, rôle Super Admin RELU à chaque geste.
 * La demande de la Direction VAUT approbation du plan (comme un chantier) ; fusion sur main et production restent
 * sous carte, au moment d'agir.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const PERSONA_PROGRAMME = "ADAM";
export type ResultatProgramme = { ok: true; programmeId: string; message: string } | { ok: false; erreur: string; fautes?: string[] };

const ou = (id: string, principalId: string): Prisma.MissionWhereInput => ({ id, kind: KIND_PROGRAMME, principalId, ownerId: principalId });

export async function signalerReveilProgramme(programmeId: string, maintenant = new Date()): Promise<void> {
  await prisma.mission.updateMany({ where: { id: programmeId, kind: KIND_PROGRAMME }, data: { reveilDemandeLe: maintenant } });
}

export interface DemandeProgramme {
  /** La demande de la Direction, en clair — MiMo la décompose. */
  demande?: string;
  /** Ou le plan déjà écrit (par Terra) — il passe le MÊME validateur. */
  plan?: unknown;
  depot?: { proprietaire: string; nom: string };
  cible?: string;
}

/** LANCER UN PROGRAMME — planifié (MiMo, Sol en recours) ou donné tel quel, toujours VALIDÉ par le code, puis démarré. */
export async function lancerProgramme(principalId: string, e: DemandeProgramme, deps: { cerveau?: CerveauChantier; clock?: Clock; origine?: string } = {}): Promise<ResultatProgramme> {
  const refus = await refusChantier(principalId);
  if (refus) return { ok: false, erreur: refus };
  const clock = deps.clock ?? systemClock;
  const reglages = await lireReglagesConsole();
  const bornes = { plafondUsd: reglages.plafondUsd * 6, lancementsMax: reglages.lancementsMax * 6 };
  const m = await prisma.mission.create({
    data: {
      kind: KIND_PROGRAMME, ownerId: principalId, principalId, persona: PERSONA_PROGRAMME, title: "Programme en planification",
      objective: (e.demande ?? "plan fourni").slice(0, 4000), goalRaw: (e.demande ?? "").slice(0, 4000), status: "AWAITING_APPROVAL", planVersion: 0, maxConcurrency: 1,
      context: deps.origine ?? null,
    },
    select: { id: true },
  });
  let lecture: LecturePlan;
  let par: DossierProgramme["planifiePar"] = "TERRA";
  if (e.plan !== undefined) {
    lecture = lirePlanProgramme(e.plan, bornes);
  } else if (e.demande && e.depot) {
    const p = await planifier({ texte: e.demande, depot: e.depot, cible: e.cible ?? "main" }, { cerveau: deps.cerveau ?? cerveauReel, missionId: m.id, userId: principalId, ...bornes });
    if (p.coutUsd) await compter(m.id, { modelCalls: p.essais, costUsd: p.coutUsd });
    lecture = p.lecture;
    par = p.par;
  } else {
    lecture = { ok: false, fautes: ["Donnez la demande (et le dépôt) ou le plan du programme."] };
  }
  if (!lecture.ok) {
    await prisma.mission.update({ where: { id: m.id }, data: { status: "CANCELLED", closedAt: clock.now(), title: "Programme refusé par le validateur" } });
    await journaliser(m.id, "PROGRAMME_REFUSE", `Plan refusé : ${lecture.fautes.slice(0, 5).join(" ")}`.slice(0, 900), { fautes: lecture.fautes }, principalId);
    return { ok: false, erreur: "Le plan ne passe pas le validateur.", fautes: lecture.fautes };
  }
  const plan = lecture.plan;
  const maintenant = clock.now();
  const dossier = dossierProgrammeInitial(m.id, { plan, conflits: lecture.conflits, regroupees: lecture.regroupees, planifiePar: par }, maintenant.toISOString());
  await prisma.mission.update({
    where: { id: m.id },
    data: {
      title: plan.titre, objective: plan.objectif, status: "RUNNING", startedAt: maintenant, planApprouveLe: maintenant, planApprouvePar: principalId,
      plafondUsd: plan.budget.usd ?? bornes.plafondUsd, reveilDemandeLe: maintenant,
      carnet: { programme: dossier } as unknown as Prisma.InputJsonValue,
    },
  });
  await journaliser(m.id, "PROGRAMME_LANCE",
    `Programme lancé (${par === "TERRA" ? "plan de Terra" : `planifié par ${par}`}, validé par le code) : ${plan.taches.length} tâche(s), ${plan.concurrence} en parallèle au plus, cible ${plan.cible}${lecture.conflits.length ? ` ; ${lecture.conflits.length} recouvrement(s) sérialisé(s)` : ""}.`,
    { taches: plan.taches.map((t) => t.cle), conflits: lecture.conflits, regroupees: lecture.regroupees }, principalId);
  return { ok: true, programmeId: m.id, message: `Programme démarré : ${plan.taches.length} tâche(s).` };
}

/**
 * LA CONSIGNE DE LA DIRECTION à un programme — sur une TÂCHE (sa session Claude Code, par la consigne des chantiers),
 * ou au programme entier (gardée ; un programme qui attendait ses consignes reprend).
 */
export async function donnerConsigneProgramme(
  programmeId: string, principalId: string, c: { texte: string; tache?: string; canal?: "ecrit" | "oral"; plafondUsd?: number },
  deps: { ports?: PortsDev | null; clock?: Clock } = {},
): Promise<ResultatProgramme> {
  const refus = await refusChantier(principalId);
  if (refus) return { ok: false, erreur: refus };
  const m = await prisma.mission.findFirst({ where: ou(programmeId, principalId), select: { status: true, pausedReason: true, carnet: true } });
  const d = lireDossierProgramme(m?.carnet);
  if (!m || !d) return { ok: false, erreur: "Programme introuvable — ou il ne vous appartient pas." };
  const texte = c.texte.trim().slice(0, 4_000);
  if (texte.length < 3) return { ok: false, erreur: "Consigne vide." };
  const clock = deps.clock ?? systemClock;
  const t = c.tache ? d.taches[c.tache] : undefined;
  if (c.tache && !t) return { ok: false, erreur: `Aucune tâche « ${c.tache} » dans ce programme.` };
  let message = "Consigne enregistrée pour le programme.";
  if (t?.chantierId) {
    const r = await donnerConsigneChantier(t.chantierId, principalId, { texte, canal: c.canal ?? "ecrit" }, deps);
    message = r.ok ? r.message : `Consigne gardée ; la session n'a pas pu la recevoir : ${r.erreur}`;
  }
  await ecrireDossierProgramme(programmeId, (x) => {
    x.consignes.push({ texte, par: principalId, le: clock.now().toISOString(), tache: c.tache ?? null });
    x.attenteConsignes = null;
  });
  await journaliser(programmeId, "PROGRAMME_CONSIGNE", `Consigne de la Direction${c.tache ? ` (tâche ${c.tache})` : ""} : ${texte}`.slice(0, 900), { tache: c.tache ?? null }, principalId);
  // UN PLAFOND RELEVÉ par la Direction (jamais au-delà de celui de la console × 6) fait repartir un programme au plafond.
  if (c.plafondUsd !== undefined && Number.isFinite(c.plafondUsd) && c.plafondUsd > 0) {
    const max = (await lireReglagesConsole()).plafondUsd * 6;
    await prisma.mission.update({ where: { id: programmeId }, data: { plafondUsd: Math.min(c.plafondUsd, max) } });
    message += ` Plafond porté à ${Math.min(c.plafondUsd, max).toFixed(2)} $.`;
  }
  if (m.status === "PAUSED" && (m.pausedReason?.startsWith(MOTIF_CONSIGNES_CHANTIER) || (c.plafondUsd !== undefined && m.pausedReason?.startsWith(MOTIF_BUDGET_CHANTIER)))) await reprendre(programmeId, principalId, "PROGRAMME");
  await signalerReveilProgramme(programmeId, clock.now());
  return { ok: true, programmeId, message };
}

/**
 * ANNULER (réversibilité, décision 0059 § 7) — les chantiers vivants sont annulés, les entrées en file d'intégration
 * retirées, les réservations libérées. Une session cloud déjà lancée ne s'arrête pas (aucune API sur l'abonnement) :
 * elle peut finir son tour, rien de ce qu'elle pousse ne sera intégré. Une intégration DÉJÀ faite se compense par une
 * PR de revert (chantier à part).
 */
export async function annulerProgramme(programmeId: string, principalId: string): Promise<ResultatProgramme> {
  const m = await prisma.mission.findFirst({ where: ou(programmeId, principalId), select: { carnet: true } });
  const d = lireDossierProgramme(m?.carnet);
  if (!m || !d) return { ok: false, erreur: "Programme introuvable — ou il ne vous appartient pas." };
  const r = await annuler(programmeId, principalId, "à la demande de la Direction", "PROGRAMME");
  if (!r.ok) return { ok: false, erreur: r.message };
  const enfants = await prisma.mission.findMany({ where: { parentMissionId: programmeId, kind: "CHANTIER", status: { notIn: ["COMPLETED", "CANCELLED", "FAILED"] } }, select: { id: true, carnet: true } });
  const sessions = enfants.reduce((n, e) => n + (lireDossier(e.carnet)?.sessions.length ?? 0), 0);
  for (const e of enfants) await annulerChantier(e.id, principalId);
  await prisma.integrationFile.updateMany({ where: { programmeId, statut: "EN_FILE" }, data: { statut: "ANNULEE" } });
  await liberer(programmeId);
  await ecrireDossierProgramme(programmeId, (x) => {
    for (const t of Object.values(x.taches)) if (t.etat !== "INTEGREE") t.etat = "ANNULEE";
  });
  const integrees = Object.values(d.taches).filter((t) => t.etat === "INTEGREE").length;
  await journaliser(programmeId, "PROGRAMME_ANNULE", `Programme annulé : ${enfants.length} chantier(s) arrêté(s)${integrees ? ` ; ${integrees} tâche(s) déjà intégrée(s) — compensables par une PR de revert` : ""}.`, {}, principalId);
  return { ok: true, programmeId, message: `Programme annulé, réservations libérées.${sessions ? " Les sessions Claude Code déjà lancées peuvent finir leur tour : rien de ce qu'elles poussent ne sera intégré." : ""}${integrees ? ` ${integrees} tâche(s) déjà intégrée(s) restent dans ${d.plan.cible} : demandez une PR de revert si besoin.` : ""}` };
}

/**
 * LA CARTE DE L'INTÉGRATION (cible protégée, main) — « valide » / « refuse » de la Direction, écrit ou oral. Seule une
 * intégration qui ATTEND (CI verte sur le résultat intégré) peut la recevoir : on ne pré-autorise rien.
 */
export async function validerIntegrationProgramme(programmeId: string, principalId: string, decision: "ACCORDEE" | "REFUSEE", canal: "ecrit" | "oral" = "ecrit", clock: Clock = systemClock): Promise<ResultatProgramme> {
  const refus = await refusChantier(principalId);
  if (refus) return { ok: false, erreur: refus };
  if (!(await prisma.mission.count({ where: ou(programmeId, principalId) }))) return { ok: false, erreur: "Programme introuvable — ou il ne vous appartient pas." };
  const r = await validerIntegration(programmeId, decision, principalId, clock);
  if (!r.ok) return { ok: false, erreur: r.erreur };
  await journaliser(programmeId, decision === "ACCORDEE" ? "PROGRAMME_INTEGRATION_ACCORDEE" : "PROGRAMME_INTEGRATION_REFUSEE", `${decision === "ACCORDEE" ? "Validé" : "Refusé"} par la Direction (${canal}) : intégration de la tâche « ${r.tache} ».`, { tache: r.tache, canal }, principalId);
  await signalerReveilProgramme(programmeId, clock.now());
  return { ok: true, programmeId, message: decision === "ACCORDEE" ? `Validé : l'intégration de « ${r.tache} » part maintenant (si la cible n'a pas bougé ; sinon elle est revérifiée d'abord).` : `Refusé : « ${r.tache} » retourne à son travailleur.` };
}

export interface VueProgramme {
  id: string;
  titre: string;
  statut: string;
  pause: string | null;
  cible: string;
  depot: string;
  planifiePar: DossierProgramme["planifiePar"];
  concurrence: number;
  /** Le coût par RÔLE : MiMo/Sol/Terra (planification, sur le programme), travailleurs (chantiers enfants), infra. */
  couts: CoutsProgramme & { plafondUsd: number | null };
  taches: { cle: string; titre: string; etat: string; chantierId: string | null; branche: string; dependances: string[]; raison: string | null; renvois: number; integreeSha: string | null; travailleur: { sessions: number; moyen: string | null; url: string | null } }[];
  conflits: DossierProgramme["conflits"];
  file: { tache: string; statut: string; tour: number; shaIntegration: string | null; detail: string | null }[];
  attenteConsignes: string | null;
}

/** « OÙ EN EST LE PROGRAMME » — tâches, travailleurs, dépendances, conflits, coûts par rôle, file d'intégration. */
export async function ouEnEstProgramme(principalId: string, programmeId?: string): Promise<VueProgramme[]> {
  const ms = await prisma.mission.findMany({
    where: { kind: KIND_PROGRAMME, principalId, ownerId: principalId, ...(programmeId ? { id: programmeId } : {}), NOT: { title: "Programme refusé par le validateur" } },
    select: { id: true, title: true, status: true, pausedReason: true, costUsd: true, plafondUsd: true, carnet: true, subMissions: { select: { id: true, costUsd: true, carnet: true, startedAt: true, closedAt: true } }, integrations: { orderBy: { createdAt: "asc" }, select: { tacheCle: true, statut: true, tour: true, shaIntegration: true, detail: true } } },
    orderBy: { createdAt: "desc" }, take: programmeId ? 1 : 6,
  });
  return ms.flatMap((m): VueProgramme[] => {
    const d = lireDossierProgramme(m.carnet);
    if (!d) return [];
    return [{
      id: m.id, titre: m.title, statut: m.status, pause: m.pausedReason, cible: d.plan.cible, depot: `${d.plan.depot.proprietaire}/${d.plan.depot.nom}`,
      planifiePar: d.planifiePar, concurrence: d.plan.concurrence,
      couts: { ...coutsDuProgramme(m.costUsd, m.subMissions, d, new Date()), plafondUsd: m.plafondUsd },
      taches: d.plan.taches.map((t) => {
        const e = d.taches[t.cle];
        const sessions = lireDossier(m.subMissions.find((x) => x.id === e?.chantierId)?.carnet)?.sessions ?? [];
        return {
          cle: t.cle, titre: t.titre, etat: e?.etat ?? "ATTENTE", chantierId: e?.chantierId ?? null, branche: e?.branche ?? "", dependances: t.dependances,
          raison: e?.raison ?? null, renvois: e?.renvois ?? 0, integreeSha: e?.integreeSha ?? null,
          travailleur: { sessions: sessions.length, moyen: sessions.at(-1)?.moyen ?? null, url: sessions.at(-1)?.url ?? null },
        };
      }),
      conflits: d.conflits,
      file: m.integrations.map((i) => ({ tache: i.tacheCle, statut: i.statut, tour: i.tour, shaIntegration: i.shaIntegration, detail: (i.detail as { raison?: string } | null)?.raison ?? null })),
      attenteConsignes: d.attenteConsignes,
    }];
  });
}
