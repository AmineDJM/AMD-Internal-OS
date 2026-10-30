import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { materialiser, journaliser, transitionner } from "@/lib/missions/runtime/store";
import { rendreBail } from "@/lib/missions/runtime/bail";
import { annuler, mettreEnPause } from "@/lib/missions/runtime/control";
import { systemClock, type Clock } from "@/lib/missions/ports";
import { compilerTravail, lirePlan, PLAFOND_TRAVAIL_DEFAUT_USD, type GesteAutorise, type PlanTravail } from "@/lib/missions/travaux/plan";
import type { PersonaTravaux } from "@/lib/missions/travaux/persona";
import { carnetInitial, lireCarnet, type Carnet } from "@/lib/missions/travaux/carnet";
import { lireGestesAutorises, reprendreTravail } from "@/lib/missions/travaux/conduite";
import { etatTravail, motifPlafond, phraseAttente, type EtatTravail } from "@/lib/missions/travaux/regles";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES TRAVAUX D'UNE PERSONNE (J2) — proposer, approuver, voir, suspendre, reprendre, arrêter.
 *
 * LE CLOISONNEMENT EST DANS LA SIGNATURE, comme pour les missions (`runtime/control.ts`) : chaque
 * fonction exige le `principalId` et le met dans le `where`. Un identifiant de travail deviné ne
 * donne rien — ni à lire, ni à annuler. Un collaborateur ne voit et ne touche que SES travaux.
 *
 * LE PLAN EST APPROUVÉ UNE FOIS (décision 5 de la Direction) : la carte montre les étapes, les
 * gestes autorisés (bornés aux familles ouvertes dans la console), et le plafond de dépense. Rien ne
 * tourne avant ce geste ; les étapes ne sont écrites qu'à ce moment — une minuterie part du « oui ».
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type ResultatTravail = { ok: true; travailId: string; message: string } | { ok: false; erreur: string };

const ou = (travailId: string, principalId: string): Prisma.MissionWhereInput => ({ id: travailId, kind: "TRAVAIL", principalId, ownerId: principalId });

/**
 * PROPOSER UN TRAVAIL — le plan est relu contre le catalogue de la persona POUR CETTE PERSONNE ; un plan
 * faux rend ses fautes (le modèle corrige). Rien ne s'exécute : le travail attend son approbation.
 */
export async function proposerTravail(
  principalId: string, persona: PersonaTravaux, brut: unknown, opts: { origine?: string | null } = {},
): Promise<{ ok: true; travailId: string; plan: PlanTravail; gestes: GesteAutorise[]; plafondUsd: number } | { ok: false; fautes: string[] }> {
  const refus = await persona.refusTravail(principalId);
  if (refus) return { ok: false, fautes: [refus] };
  const lu = lirePlan(brut, await persona.catalogue(principalId));
  if (!lu.ok) return lu;
  const plafondUsd = (await persona.plafonds(principalId)).travailUsd || PLAFOND_TRAVAIL_DEFAUT_USD;
  const m = await prisma.mission.create({
    data: {
      kind: "TRAVAIL", ownerId: principalId, principalId, persona: persona.persona,
      title: lu.plan.titre, objective: lu.plan.objectif, goalRaw: lu.plan.objectif,
      status: "AWAITING_APPROVAL", planVersion: 0, maxConcurrency: 3, plafondUsd,
      carnet: carnetInitial(lu.plan) as unknown as Prisma.InputJsonValue,
      gestesAutorises: lu.gestes as unknown as Prisma.InputJsonValue,
      context: opts.origine ?? null,
    },
    select: { id: true },
  });
  await journaliser(m.id, "TRAVAIL_PROPOSE", `Plan proposé par ${persona.nom} : ${lu.plan.etapes.length} étapes, ${lu.gestes.length} geste(s) à autoriser.`,
    { etapes: lu.plan.etapes.length, gestes: lu.gestes.map((g) => g.nom), plafondUsd }, principalId);
  return { ok: true, travailId: m.id, plan: lu.plan, gestes: lu.gestes, plafondUsd };
}

/**
 * APPROUVER LE PLAN — relu au moment du clic : les gestes encore ouverts à la personne (un geste fermé
 * entre-temps fait refuser l'approbation, il ne s'efface pas en silence), puis le plan est écrit en
 * étapes du moteur, échéances posées à partir de MAINTENANT.
 */
export async function approuverTravail(travailId: string, principalId: string, persona: PersonaTravaux, clock: Clock = systemClock): Promise<ResultatTravail> {
  const m = await prisma.mission.findFirst({ where: ou(travailId, principalId), select: { id: true, status: true, title: true, carnet: true, gestesAutorises: true, persona: true } });
  if (!m) return { ok: false, erreur: "Travail introuvable — ou il ne vous appartient pas." };
  if (m.status !== "AWAITING_APPROVAL") return { ok: false, erreur: "Ce plan a déjà été approuvé ou arrêté." };
  if (m.persona !== persona.persona) return { ok: false, erreur: "Ce travail n'appartient pas à cet assistant." };
  const refus = await persona.refusTravail(principalId);
  if (refus) return { ok: false, erreur: refus };
  const carnet = lireCarnet(m.carnet);
  if (!carnet.plan) return { ok: false, erreur: "Le plan de ce travail est illisible : demandez-en un nouveau." };
  const relu = lirePlan(carnet.plan, await persona.catalogue(principalId));
  if (!relu.ok) return { ok: false, erreur: `Le plan ne passe plus : ${relu.fautes.join(" ")}` };
  for (const g of lireGestesAutorises(m.gestesAutorises)) {
    const r = await persona.refusGeste(principalId, g.nom);
    if (r) return { ok: false, erreur: `« ${g.libelle} » ne vous est plus ouvert (${r}) : demandez un plan sans ce geste.` };
  }
  const maintenant = clock.now();
  await materialiser(compilerTravail(relu.plan, maintenant), {
    kind: "TRAVAIL", missionId: travailId, ownerId: principalId, title: relu.plan.titre, goalRaw: relu.plan.objectif, maxConcurrency: 3,
  });
  await rendreBail(travailId);
  await prisma.mission.update({ where: { id: travailId }, data: { planApprouveLe: maintenant, planApprouvePar: principalId, startedAt: maintenant } });
  await transitionner(travailId, "READY", "plan approuvé par la personne");
  await journaliser(travailId, "TRAVAIL_APPROUVE", `Plan approuvé — ${relu.plan.etapes.length} étapes, gestes autorisés : ${lireGestesAutorises(m.gestesAutorises).map((g) => g.libelle).join(", ") || "aucun"}.`,
    { gestes: lireGestesAutorises(m.gestesAutorises).map((g) => g.nom) }, principalId);
  return { ok: true, travailId, message: "Plan approuvé : le travail démarre en arrière-plan. Vous serez notifié à la fin." };
}

/** La main de la personne sur SON travail — la machine à états du moteur décide du reste (`runtime/control.ts`). */
async function parLaMain(travailId: string, principalId: string, geste: () => Promise<{ ok: boolean; message: string }>): Promise<ResultatTravail> {
  if (!(await prisma.mission.count({ where: ou(travailId, principalId) }))) return { ok: false, erreur: "Travail introuvable — ou il ne vous appartient pas." };
  const r = await geste();
  return r.ok ? { ok: true, travailId, message: r.message.replace("Mission", "Travail") } : { ok: false, erreur: r.message };
}

export const pauserTravail = (travailId: string, principalId: string) =>
  parLaMain(travailId, principalId, () => mettreEnPause(travailId, principalId, "à la demande de la personne", "TRAVAIL"));

/** REPRENDRE — refusé, avec le motif, tant qu'un plafond est atteint : reprendre pour se rendormir n'apprendrait rien. */
export async function reprendreMonTravail(travailId: string, principalId: string, persona: PersonaTravaux): Promise<ResultatTravail> {
  const m = await prisma.mission.findFirst({ where: ou(travailId, principalId), select: { status: true, costUsd: true, plafondUsd: true } });
  if (!m) return { ok: false, erreur: "Travail introuvable — ou il ne vous appartient pas." };
  if (m.status === "BLOCKED" || m.status === "FAILED" || m.status === "PARTIAL") {
    // UN TRAVAIL BLOQUÉ repart : ses étapes en échec sont remises en file (un geste FAIT ne se refait jamais — son reçu le garde).
    await prisma.missionStep.updateMany({ where: { missionId: travailId, status: "FAILED" }, data: { status: "PENDING", attempt: 0, error: null, errorKind: null } });
    await transitionner(travailId, "RUNNING", "reprise demandée par la personne");
    await journaliser(travailId, "TRAVAIL_REPRIS", "Repris à la demande : les étapes en échec repartent.", {}, principalId);
    return { ok: true, travailId, message: "Travail repris : les étapes en échec sont retentées." };
  }
  if (m.status !== "PAUSED") return { ok: false, erreur: "Ce travail n'est pas en pause." };
  const p = await persona.plafonds(principalId);
  const motif = motifPlafond({ coutTravailUsd: m.costUsd, plafondTravailUsd: m.plafondUsd ?? p.travailUsd, depenseMoisUsd: p.depenseMoisUsd, plafondMensuelUsd: p.mensuelUsd, jourAtteint: p.jourAtteint });
  if (motif) return { ok: false, erreur: `Le travail ne peut pas reprendre : ${motif}.` };
  const refus = await persona.refusTravail(principalId);
  if (refus) return { ok: false, erreur: refus };
  const r = await reprendreTravail(travailId, principalId, "à la demande de la personne");
  return r.ok ? { ok: true, travailId, message: "Travail repris là où il s'était arrêté." } : { ok: false, erreur: r.message };
}

export const annulerTravail = (travailId: string, principalId: string) =>
  parLaMain(travailId, principalId, () => annuler(travailId, principalId, "à la demande de la personne", "TRAVAIL"));

/** Relever le plafond d'UN travail (la personne, dans la limite de son plafond mensuel ; la console fixe le défaut). */
export async function reglerPlafondTravail(travailId: string, principalId: string, plafondUsd: number): Promise<ResultatTravail> {
  if (!Number.isFinite(plafondUsd) || plafondUsd <= 0 || plafondUsd > 1_000) return { ok: false, erreur: "Plafond invalide (entre 0 et 1 000 $)." };
  const r = await prisma.mission.updateMany({ where: ou(travailId, principalId), data: { plafondUsd } });
  if (!r.count) return { ok: false, erreur: "Travail introuvable — ou il ne vous appartient pas." };
  await journaliser(travailId, "TRAVAIL_PLAFOND", `Plafond du travail porté à ${plafondUsd} $.`, { plafondUsd }, principalId);
  return { ok: true, travailId, message: `Plafond du travail : ${plafondUsd} $.` };
}

// ─────────────────────────────── Ce que le panneau montre ───────────────────────────────

export interface EtapeVue { cle: string; titre: string; type: string; statut: string; erreur: string | null; depuis: string | null }

export interface TravailVue {
  id: string;
  titre: string;
  objectif: string;
  etat: EtatTravail;
  statut: string;
  persona: string | null;
  motifPause: string | null;
  /** « attend « la signature du BC » depuis 2 jours » — l'attente en cours, dite. */
  attente: string | null;
  etapes: { faites: number; total: number; enEchec: number };
  coutUsd: number;
  plafondUsd: number | null;
  creeLe: string;
  majLe: string;
  gestes: GesteAutorise[];
}

export interface TravailDetail extends TravailVue {
  liste: EtapeVue[];
  carnet: Carnet;
  journal: { at: string; texte: string }[];
}

const TYPE_DE_NOEUD: Record<string, string> = { CAPABILITY: "Lecture", WORKER: "Analyse", WAIT_EVENT: "Attente", ARTIFACT: "Livrable", JOIN: "Jonction" };

function vue(m: {
  id: string; title: string; objective: string; status: string; persona: string | null; pausedReason: string | null; costUsd: number; plafondUsd: number | null;
  createdAt: Date; updatedAt: Date; gestesAutorises: unknown;
  steps: { key: string; title: string; nodeType: string; capability: string | null; status: string; updatedAt: Date; supersededAt: Date | null; forEach: unknown }[];
}, maintenant: Date): TravailVue {
  const steps = m.steps.filter((s) => !s.supersededAt && !s.forEach);
  const attenteEtape = steps.filter((s) => s.status === "WAITING" && s.nodeType === "WAIT_EVENT").sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime())[0];
  return {
    id: m.id, titre: m.title, objectif: m.objective, statut: m.status, persona: m.persona,
    etat: etatTravail(m.status, m.pausedReason),
    motifPause: m.status === "PAUSED" ? m.pausedReason : null,
    attente: attenteEtape ? phraseAttente(attenteEtape.title, attenteEtape.updatedAt, maintenant) : null,
    etapes: {
      faites: steps.filter((s) => s.status === "DONE" || s.status === "SKIPPED").length,
      total: steps.length,
      enEchec: steps.filter((s) => s.status === "FAILED").length,
    },
    coutUsd: Math.round(m.costUsd * 10_000) / 10_000,
    plafondUsd: m.plafondUsd,
    creeLe: m.createdAt.toISOString(), majLe: m.updatedAt.toISOString(),
    gestes: lireGestesAutorises(m.gestesAutorises),
  };
}

const SELECTION = {
  id: true, title: true, objective: true, status: true, persona: true, pausedReason: true, costUsd: true, plafondUsd: true,
  createdAt: true, updatedAt: true, gestesAutorises: true,
  steps: { select: { key: true, title: true, nodeType: true, capability: true, status: true, updatedAt: true, supersededAt: true, forEach: true, error: true, createdAt: true }, orderBy: [{ createdAt: "asc" as const }, { key: "asc" as const }] },
} satisfies Prisma.MissionSelect;

/** LES TRAVAUX DE CETTE PERSONNE — les vivants d'abord, puis les plus récents. */
export async function listerTravaux(principalId: string, limite = 30, maintenant = new Date()): Promise<TravailVue[]> {
  const ms = await prisma.mission.findMany({
    where: { kind: "TRAVAIL", principalId, ownerId: principalId },
    select: SELECTION,
    orderBy: { updatedAt: "desc" },
    take: Math.min(Math.max(1, limite), 100),
  });
  const vues = ms.map((m) => vue(m, maintenant));
  const rang = (e: EtatTravail) => (e === "A_APPROUVER" ? 0 : ["TERMINE", "ANNULE", "ECHEC"].includes(e) ? 2 : 1);
  return vues.sort((a, b) => rang(a.etat) - rang(b.etat));
}

export async function lireTravail(travailId: string, principalId: string, maintenant = new Date()): Promise<TravailDetail | null> {
  const m = await prisma.mission.findFirst({ where: ou(travailId, principalId), select: { ...SELECTION, carnet: true } });
  if (!m) return null;
  const evenements = await prisma.missionEvent.findMany({
    where: { missionId: travailId, kind: { in: ["TRAVAIL_PROPOSE", "TRAVAIL_APPROUVE", "TRAVAIL_REPRIS", "TRAVAIL_SIGNAL", "ACTION_TRACED", "GESTE_REFUSE", "PAUSED", "RESUMED", "CLOSED", "EVENT_WAKE", "TIME_WAKE", "STEP_RECLAIMED", "GOAL_SATISFIED"] } },
    select: { at: true, summary: true }, orderBy: { at: "desc" }, take: 40,
  });
  return {
    ...vue(m, maintenant),
    liste: m.steps.filter((s) => !s.supersededAt).map((s) => ({
      cle: s.key, titre: s.title, type: s.capability?.startsWith("geste:") ? "Geste" : (TYPE_DE_NOEUD[s.nodeType] ?? s.nodeType),
      statut: s.status, erreur: s.error, depuis: s.status === "WAITING" ? s.updatedAt.toISOString() : null,
    })),
    carnet: lireCarnet(m.carnet),
    journal: evenements.map((e) => ({ at: e.at.toISOString(), texte: e.summary })),
  };
}
