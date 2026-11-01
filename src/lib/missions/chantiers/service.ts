import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { journaliser, materialiser, transitionner } from "@/lib/missions/runtime/store";
import { rendreBail } from "@/lib/missions/runtime/bail";
import { annuler, mettreEnPause, reprendre } from "@/lib/missions/runtime/control";
import { enParallele } from "@/lib/missions/runtime/engine/ordonnancement";
import { systemClock, type Clock } from "@/lib/missions/ports";
import type { LecteurInterrupteur } from "@/lib/interrupteurs/missions";
import { compilerChantier, gestesCritiques, lirePlanChantier, type PlanChantier } from "@/lib/missions/chantiers/plan";
import { dossierInitial, lireDossier, vueDossier, type DossierChantier, type ValidationDirection, type VueDossier } from "@/lib/missions/chantiers/dossier";
import { MOTIF_BUDGET_CHANTIER, motifBudgetChantier } from "@/lib/missions/chantiers/regles";
import { clore, conduireChantier, ecrireDossier, KIND_CHANTIER, lireReglagesConsole, PERSONA_CHANTIER, refusChantier, type BilanChantier, type DepsChantier } from "@/lib/missions/chantiers/conduite";
import { liberer, reservationsDe } from "@/lib/missions/chantiers/reservations";
import { configMimo } from "@/lib/models/mimo";

/** LA PORTE pour les écrans et la conversation : les réglages de la console, leur normalisation, MiMo tel que configuré. */
export { lireReglagesConsole };
export { lireReglagesChantiers } from "@/lib/missions/chantiers/regles";
export const etatMimo = () => { const c = configMimo(); return { configure: c.cle !== null, modele: c.modele, base: c.base }; };

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES CHANTIERS DU SUPER ADMIN (lot C1, décision 0042) — proposer, approuver, valider un geste critique, suspendre,
 * reprendre, annuler, « où en est… ». Cloisonné comme les travaux : le `principalId` est dans chaque `where`, et le
 * rôle Super Admin est RELU à chaque geste.
 *
 * L'APPROBATION est donnée UNE fois au plan (étapes, périmètre, budget, gestes critiques annoncés) ; les gestes de
 * PRODUCTION, la fusion sur main, le rollback de production restent chacun sous carte de validation (écrite ou
 * orale), au moment d'agir — c'est l'autonomie contrôlée de CHANTIERS-DEV.md § 7.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type ResultatChantier = { ok: true; chantierId: string; message: string } | { ok: false; erreur: string };

const ou = (chantierId: string, principalId: string): Prisma.MissionWhereInput => ({ id: chantierId, kind: KIND_CHANTIER, principalId, ownerId: principalId });

/** Un réveil rapide : la boucle courte (10 s) conduit le chantier au lieu d'attendre le battement d'une minute. */
export async function signalerReveilChantier(chantierId: string, maintenant = new Date()): Promise<void> {
  await prisma.mission.updateMany({ where: { id: chantierId, kind: KIND_CHANTIER }, data: { reveilDemandeLe: maintenant } });
}

export async function proposerChantier(principalId: string, brut: unknown, opts: { origine?: string | null } = {}): Promise<
  { ok: true; chantierId: string; plan: PlanChantier; gestesCritiques: string[]; plafondUsd: number } | { ok: false; fautes: string[] }
> {
  const refus = await refusChantier(principalId);
  if (refus) return { ok: false, fautes: [refus] };
  const lu = lirePlanChantier(brut);
  if (!lu.ok) return lu;
  const reglages = await lireReglagesConsole();
  const plafondUsd = lu.plan.budget.usd ?? reglages.plafondUsd;
  const critiques = gestesCritiques(lu.plan);
  const m = await prisma.mission.create({
    data: {
      kind: KIND_CHANTIER, ownerId: principalId, principalId, persona: PERSONA_CHANTIER,
      title: lu.plan.titre, objective: lu.plan.objectif, goalRaw: lu.plan.objectif,
      status: "AWAITING_APPROVAL", planVersion: 0, maxConcurrency: 1, plafondUsd,
      carnet: { chantier: dossierInitial(lu.plan) } as unknown as Prisma.InputJsonValue,
      gestesAutorises: critiques.map((c) => ({ nom: c, libelle: c, famille: "CHANTIER", libelleFamille: "Validation au moment d'agir" })) as unknown as Prisma.InputJsonValue,
      context: opts.origine ?? null,
    },
    select: { id: true },
  });
  await journaliser(m.id, "TRAVAIL_PROPOSE", `Chantier proposé : ${lu.plan.etapes.length} étapes sur ${lu.plan.depot.proprietaire}/${lu.plan.depot.nom}@${lu.plan.branche} ; ${critiques.length} geste(s) sous validation.`,
    { etapes: lu.plan.etapes.length, perimetre: lu.plan.perimetre, plafondUsd }, principalId);
  return { ok: true, chantierId: m.id, plan: lu.plan, gestesCritiques: critiques, plafondUsd };
}

export async function approuverChantier(chantierId: string, principalId: string, clock: Clock = systemClock): Promise<ResultatChantier> {
  const m = await prisma.mission.findFirst({ where: ou(chantierId, principalId), select: { status: true, carnet: true } });
  if (!m) return { ok: false, erreur: "Chantier introuvable — ou il ne vous appartient pas." };
  if (m.status !== "AWAITING_APPROVAL") return m.status === "CANCELLED" ? { ok: false, erreur: "Ce chantier a été annulé." } : { ok: true, chantierId, message: "Ce chantier est déjà lancé." };
  const refus = await refusChantier(principalId);
  if (refus) return { ok: false, erreur: refus };
  const d = lireDossier(m.carnet);
  const relu = d ? lirePlanChantier(d.plan) : null;
  if (!relu?.ok) return { ok: false, erreur: `Le plan ne passe plus : ${relu && !relu.ok ? relu.fautes.join(" ") : "illisible"}` };
  const maintenant = clock.now();
  await materialiser(compilerChantier(relu.plan), {
    kind: KIND_CHANTIER, missionId: chantierId, ownerId: principalId, title: relu.plan.titre, goalRaw: relu.plan.objectif, maxConcurrency: 1,
  });
  await rendreBail(chantierId);
  await prisma.mission.update({ where: { id: chantierId }, data: { planApprouveLe: maintenant, planApprouvePar: principalId, startedAt: maintenant } });
  await transitionner(chantierId, "READY", "chantier approuvé par la Direction");
  await journaliser(chantierId, "TRAVAIL_APPROUVE", `Chantier approuvé — ${relu.plan.etapes.length} étapes.`, {}, principalId);
  await signalerReveilChantier(chantierId, maintenant);
  return { ok: true, chantierId, message: "Chantier approuvé : réservations, puis lancement de Claude Code en arrière-plan. Les gestes de production vous seront soumis." };
}

/**
 * LA CARTE DE VALIDATION — « valide » / « refuse » (écrit ou oral) sur le geste critique qu'une étape attend. Seule
 * une étape qui ATTEND une validation peut en recevoir une : on ne pré-autorise pas un geste qui n'est pas demandé.
 */
export async function validerGesteChantier(chantierId: string, principalId: string, d: { etape?: string; decision: "ACCORDEE" | "REFUSEE"; canal?: "ecrit" | "oral"; note?: string }, clock: Clock = systemClock): Promise<ResultatChantier> {
  const refus = await refusChantier(principalId);
  if (refus) return { ok: false, erreur: refus };
  if (!(await prisma.mission.count({ where: ou(chantierId, principalId) }))) return { ok: false, erreur: "Chantier introuvable — ou il ne vous appartient pas." };
  const demandes = await prisma.missionEvent.findMany({ where: { missionId: chantierId, kind: "CHANTIER_VALIDATION_DEMANDEE" }, select: { detail: true, summary: true }, orderBy: { at: "desc" } });
  const dossier = lireDossier((await prisma.mission.findUnique({ where: { id: chantierId }, select: { carnet: true } }))?.carnet);
  const ouvertes = demandes.map((e) => ({ cle: String((e.detail as { stepKey?: string } | null)?.stepKey ?? ""), texte: e.summary })).filter((e) => e.cle && !dossier?.validations[e.cle]);
  const visee = d.etape ? ouvertes.find((o) => o.cle === d.etape) : ouvertes[0];
  if (!visee) return { ok: false, erreur: "Aucune validation n'est attendue sur ce chantier en ce moment." };
  const v: ValidationDirection = { decision: d.decision, par: principalId, le: clock.now().toISOString(), canal: d.canal ?? "ecrit", ...(d.note ? { note: d.note.slice(0, 300) } : {}) };
  await ecrireDossier(chantierId, (x) => { x.validations[visee.cle] = v; });
  await prisma.missionStep.updateMany({ where: { missionId: chantierId, key: visee.cle, status: "WAITING" }, data: { status: "READY", attempt: 0 } });
  await journaliser(chantierId, d.decision === "ACCORDEE" ? "CHANTIER_VALIDATION_ACCORDEE" : "CHANTIER_VALIDATION_REFUSEE",
    `${d.decision === "ACCORDEE" ? "Validé" : "Refusé"} par la Direction (${v.canal}) : ${visee.texte}`, { stepKey: visee.cle, canal: v.canal }, principalId);
  await signalerReveilChantier(chantierId, clock.now());
  return { ok: true, chantierId, message: d.decision === "ACCORDEE" ? "Validé : le geste part maintenant." : "Refusé : le geste est écarté, le chantier continue sans lui." };
}

export async function pauserChantier(chantierId: string, principalId: string): Promise<ResultatChantier> {
  const r = await mettreEnPause(chantierId, principalId, "à la demande de la Direction", "CHANTIER");
  return r.ok ? { ok: true, chantierId, message: "Chantier en pause : rien ne part tant que vous ne le reprenez pas." } : { ok: false, erreur: r.message };
}

export async function reprendreChantier(chantierId: string, principalId: string): Promise<ResultatChantier> {
  const m = await prisma.mission.findFirst({ where: ou(chantierId, principalId), select: { status: true, costUsd: true, plafondUsd: true, carnet: true } });
  if (!m) return { ok: false, erreur: "Chantier introuvable — ou il ne vous appartient pas." };
  const refus = await refusChantier(principalId);
  if (refus) return { ok: false, erreur: refus };
  if (m.status === "BLOCKED" || m.status === "FAILED" || m.status === "PARTIAL") {
    return { ok: false, erreur: "Un chantier bloqué ne se relance pas tel quel (l'anti-boucle l'a arrêté) : lancez un nouveau chantier avec la correction, ou dites ce qui a changé." };
  }
  if (m.status !== "PAUSED") return { ok: false, erreur: "Ce chantier n'est pas en pause." };
  const d = lireDossier(m.carnet);
  if (d) {
    const reglages = await lireReglagesConsole();
    const motif = motifBudgetChantier({ coutUsd: m.costUsd, lancements: d.compteurs.lancements, deploiements: d.compteurs.deploiements, jourUsd: 0, jourLancements: 0, jourDeploiements: 0 }, reglages, m.plafondUsd);
    if (motif) return { ok: false, erreur: `Le chantier ne peut pas reprendre : ${motif}. Relevez le plafond (Administration › IA › Chantiers).` };
  }
  const r = await reprendre(chantierId, principalId, "CHANTIER");
  if (!r.ok) return { ok: false, erreur: r.message };
  // Les étapes qui dormaient sur un plafond repartent tout de suite : elles n'avaient rien fait.
  await prisma.missionStep.updateMany({ where: { missionId: chantierId, status: "WAITING", nodeType: "WORKER" }, data: { status: "READY", attempt: 0 } });
  await journaliser(chantierId, "TRAVAIL_REPRIS", "Repris à la demande de la Direction.", {}, principalId);
  await signalerReveilChantier(chantierId);
  return { ok: true, chantierId, message: "Chantier repris là où il s'était arrêté." };
}

/** ANNULER — libère les réservations, écrit le rapport (annulé). Une session Claude Code déjà lancée n'est pas tuée (aucune API ne le permet) : c'est dit. */
export async function annulerChantier(chantierId: string, principalId: string): Promise<ResultatChantier> {
  const m = await prisma.mission.findFirst({ where: ou(chantierId, principalId), select: { title: true, costUsd: true, carnet: true } });
  if (!m) return { ok: false, erreur: "Chantier introuvable — ou il ne vous appartient pas." };
  const r = await annuler(chantierId, principalId, "à la demande de la Direction", "CHANTIER");
  if (!r.ok) return { ok: false, erreur: r.message };
  await liberer(chantierId);
  await clore(chantierId, principalId, m.title, "CANCELLED", m.costUsd);
  const sessions = lireDossier(m.carnet)?.sessions.length ?? 0;
  return { ok: true, chantierId, message: `Chantier annulé, réservations libérées.${sessions ? " Une session Claude Code déjà lancée peut finir son tour : rien ne sera déployé." : ""}` };
}

export interface VueChantier extends VueDossier {
  id: string;
  titre: string;
  statut: string;
  pause: string | null;
  coutUsd: number;
  plafondUsd: number | null;
  etapes: { cle: string; titre: string; statut: string; attente: string | null; erreur: string | null; essais: number }[];
  validationsAttendues: string[];
  compteurs: DossierChantier["compteurs"];
  rapport: string | null;
}

/** « OÙ EN EST… » — l'état d'un chantier (ou des derniers), lisible par la conversation et par l'écran. */
export async function ouEnEstChantier(principalId: string, chantierId?: string): Promise<VueChantier[]> {
  const ms = await prisma.mission.findMany({
    where: { kind: KIND_CHANTIER, principalId, ownerId: principalId, ...(chantierId ? { id: chantierId } : {}) },
    select: {
      id: true, title: true, status: true, pausedReason: true, costUsd: true, plafondUsd: true, carnet: true,
      steps: { where: { supersededAt: null }, select: { key: true, title: true, status: true, result: true, error: true }, orderBy: [{ createdAt: "asc" }, { key: "asc" }] },
      events: { where: { kind: "CHANTIER_VALIDATION_DEMANDEE" }, select: { detail: true, summary: true } },
    },
    orderBy: { createdAt: "desc" }, take: chantierId ? 1 : 8,
  });
  const res = await reservationsDe(ms.map((m) => m.id));
  return ms.flatMap((m): VueChantier[] => {
    const d = lireDossier(m.carnet);
    if (!d) return [];
    return [{
      ...vueDossier(d, (res.get(m.id) ?? []).map((r) => r.cle)),
      id: m.id, titre: m.title, statut: m.status, pause: m.pausedReason,
      coutUsd: Math.round(m.costUsd * 10_000) / 10_000, plafondUsd: m.plafondUsd,
      etapes: m.steps.map((s) => {
        const r = (s.result ?? {}) as { attente?: string; essais?: number; tour?: number; tours?: number };
        return { cle: s.key, titre: s.title, statut: s.status, attente: s.status === "WAITING" ? (r.attente ?? null) : null, erreur: s.status === "FAILED" ? s.error : null, essais: Math.max(r.essais ?? 0, r.tour ?? 0, r.tours ?? 0) };
      }),
      validationsAttendues: m.events.map((e) => ({ cle: String((e.detail as { stepKey?: string } | null)?.stepKey ?? ""), texte: e.summary })).filter((e) => e.cle && !d.validations[e.cle]).map((e) => e.texte),
      compteurs: d.compteurs,
      rapport: d.rapport?.texte ?? null,
    }];
  });
}

/** Les chantiers à conduire maintenant : signalés, en file, en cours, une attente datée échue, ou en sommeil de plafond. */
export async function chantiersAFaireAvancer(maintenant: Date, limite = 6, seulementSignales = false): Promise<string[]> {
  if (seulementSignales) {
    const s = await prisma.mission.findMany({ where: { kind: KIND_CHANTIER, reveilDemandeLe: { not: null }, planApprouveLe: { not: null } }, select: { id: true }, take: limite });
    return s.map((x) => x.id);
  }
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT m."id" FROM "Mission" m
    WHERE m."kind" = 'CHANTIER' AND m."planApprouveLe" IS NOT NULL AND (
      m."reveilDemandeLe" IS NOT NULL
      OR (m."status" = 'PAUSED' AND m."pausedReason" LIKE ${`${MOTIF_BUDGET_CHANTIER}%`})
      OR (m."status" NOT IN ('COMPLETED', 'CANCELLED', 'FAILED', 'BLOCKED', 'PARTIAL', 'PAUSED', 'AWAITING_APPROVAL') AND EXISTS (
        SELECT 1 FROM "MissionStep" s WHERE s."missionId" = m."id" AND s."supersededAt" IS NULL AND (
          s."status" IN ('PENDING', 'READY', 'RUNNING')
          OR (s."status" = 'WAITING' AND (s."result"->>'reessayerA') <= ${maintenant.toISOString()})))))
    ORDER BY m."priority" DESC, m."updatedAt" ASC LIMIT ${limite}`;
  return rows.map((r) => r.id);
}

/** LE BATTEMENT DES CHANTIERS (tâche `chantiers.balayage` et boucle courte des réveils) — conduits en parallèle, chacun sous son bail. */
export async function balayerChantiers(o: {
  clock?: Clock; interrupteur?: LecteurInterrupteur; deps?: Omit<DepsChantier, "clock" | "interrupteur">; seulement?: readonly string[];
  /** La boucle courte des réveils (10 s) : seulement les chantiers SIGNALÉS (approuvés, validés, repris). */
  seulementSignales?: boolean;
} = {}): Promise<BilanChantier[]> {
  const opts = o; // le passe-plat de l'interrupteur (cliquet `suspension.test.ts`)
  const clock = o.clock ?? systemClock;
  const reglages = o.deps?.reglages ?? (await lireReglagesConsole());
  const ids = (await chantiersAFaireAvancer(clock.now(), 6, o.seulementSignales)).filter((id) => !o.seulement || o.seulement.includes(id));
  const out: BilanChantier[] = [];
  await enParallele(ids, reglages.enParallele, async (id) => {
    await prisma.mission.updateMany({ where: { id }, data: { reveilDemandeLe: null } });
    try {
      out.push(await conduireChantier(id, { ...(o.deps ?? {}), reglages, clock, ...(opts.interrupteur ? { interrupteur: opts.interrupteur } : {}) }));
    } catch (e) {
      console.error("[chantiers] conduite", id, e);
    }
  });
  return out;
}
