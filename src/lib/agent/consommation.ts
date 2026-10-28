import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { logAiUsage } from "@/lib/ai-settings";
import { notifyUser } from "@/lib/notify";
import {
  coutEstimeUsd, debutJourAlger, jourAlger, normaliserReglages, refusPlafondJour, refusPlafondTour,
  REGLAGES_PAR_DEFAUT, type ReglagesAssistantIa, type Tarif,
} from "@/lib/agent/consommation-regles";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA CONSOMMATION DE L'ASSISTANT IA — chaque appel compté, chaque tour borné (lot V3-D, rapport 06,
 * IA-ASSISTANT-03).
 *
 * ── LE TROU ──────────────────────────────────────────────────────────────────────────────
 *
 * MiMo est appelé par Mastra en direct, hors de la passerelle d'Adam : aucun appel n'était journalisé
 * (`AiUsageLog` comme `ModelCallLog` ignoraient l'Assistant IA), et rien ne bornait la dépense — un seul
 * message en arrière-plan pouvait envoyer ≈ 220 k jetons, dix en file par personne, sans trace.
 *
 * ── LE REMÈDE, AUX DEUX SEULES PORTES ────────────────────────────────────────────────────
 *
 * `repondreAvecSecours` (conversation, fil, routines) et `genererTexte` (résumés, traductions) —
 * les deux portes déjà tenues par l'interrupteur — OUVRENT un budget avant d'appeler le modèle et le
 * FERMENT après :
 *
 *   1. OUVRIR : lire les réglages du Super Admin, sommer les jetons du jour de la personne. Plafond du
 *      jour atteint → refus dit (`PlafondIaAtteint`), aucun appel ne part, le Super Admin est prévenu
 *      (une fois par personne et par jour).
 *   2. COMPTER : chaque ÉTAPE de Mastra (= un appel du modèle) rend son usage (`onStepFinish`) ; le
 *      budget l'additionne et, dès que le tour dépasse son plafond (par tour, ou ce qui reste du
 *      jour), le tour s'arrête — l'appel suivant ne part pas.
 *   3. FERMER : une ligne `ModelCallLog` PAR APPEL (personne, conversation, modèle, jetons, durée,
 *      coût estimé) et une ligne `AiUsageLog` PAR TOUR (agrégats) — la feature `assistant_ia`.
 *
 * Un résumé de document lancé PAR UN OUTIL pendant un tour s'inscrit dans le budget de ce tour : le
 * budget voyage avec l'exécution (`AsyncLocalStorage`), pas en paramètre à travers dix modules.
 *
 * Le journal est BEST-EFFORT (il ne fait jamais échouer un tour) ; le plafond, lui, est une garde :
 * réglages illisibles → les défauts, qui sont des plafonds.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const FEATURE_ASSISTANT_IA = "assistant_ia" as const;

/** D'où part l'appel — la colonne `role` du journal : ce que « par usage » distingue à l'écran. */
export type OrigineAppel = "conversation" | "fil" | "routine" | "redaction";

export class PlafondIaAtteint extends Error {
  constructor(message: string) { super(message); this.name = "PlafondIaAtteint"; }
}

// ─────────────────────────────── Les réglages ───────────────────────────────

/**
 * LES RÉGLAGES S'INJECTENT dans un banc, comme l'interrupteur (§118.115) : la ligne est GLOBALE et la
 * suite tourne en parallèle — un test qui l'écrirait réglerait l'assistant de tous ses voisins.
 */
let reglagesDeTest: ReglagesAssistantIa | null = null;

/** RÉSERVÉ AUX TESTS — jamais appelé en production (cliquet `consommation.test.ts`). `null` rend la vraie lecture. */
export function remplacerReglagesPourTests(r: Partial<ReglagesAssistantIa> | null): void {
  reglagesDeTest = r ? { ...REGLAGES_PAR_DEFAUT, ...r } : null;
}

export async function lireReglagesAssistantIa(): Promise<ReglagesAssistantIa> {
  if (reglagesDeTest) return reglagesDeTest;
  try {
    return normaliserReglages(await prisma.assistantIaReglage.findUnique({ where: { id: "global" } }));
  } catch {
    return REGLAGES_PAR_DEFAUT;
  }
}

// ─────────────────────────────── Le tarif ───────────────────────────────

/**
 * LE TARIF DE MIMO N'EST PAS DANS LE CODE — il se pose dans l'environnement (dollars par million de
 * jetons), comme les tarifs surchargés d'Adam (`ADAM_PRICE_*`). Absent : le coût est INCONNU, et
 * l'écran le dit ; jamais un chiffre deviné.
 */
export function tarifDe(provider: string, env: NodeJS.ProcessEnv = process.env): Tarif | null {
  if (provider !== "mimo") return null;
  const e = Number(env.MIMO_PRICE_IN);
  const s = Number(env.MIMO_PRICE_OUT);
  return env.MIMO_PRICE_IN && env.MIMO_PRICE_OUT && Number.isFinite(e) && Number.isFinite(s) && e >= 0 && s >= 0
    ? { entreeParM: e, sortieParM: s }
    : null;
}

// ─────────────────────────────── Le jour ───────────────────────────────

/** Les jetons (entrée + sortie) de l'Assistant IA consommés AUJOURD'HUI (heure d'Alger) par cette personne. */
export async function jetonsDuJour(userId: string, now: Date = new Date()): Promise<number> {
  const s = await prisma.modelCallLog.aggregate({
    where: { feature: FEATURE_ASSISTANT_IA, userId, at: { gte: debutJourAlger(now) } },
    _sum: { inputTokens: true, outputTokens: true },
  });
  return (s._sum.inputTokens ?? 0) + (s._sum.outputTokens ?? 0);
}

/**
 * LE SUPER ADMIN EST PRÉVENU — une fois par personne et par jour. La clé unique (`userId`, `jour`) fait
 * le tri : deux tours qui franchissent le plafond ensemble n'écrivent qu'une ligne, un seul avis part.
 */
export async function signalerPlafondJour(userId: string, jetons: number, plafond: number, now: Date = new Date()): Promise<boolean> {
  try {
    const r = await prisma.assistantIaPlafondAtteint.createMany({
      data: [{ userId, jour: jourAlger(now), jetons: Math.round(jetons), plafond }],
      skipDuplicates: true,
    });
    if (!r.count) return false;
    const [personne, admins] = await Promise.all([
      prisma.user.findUnique({ where: { id: userId }, select: { name: true } }),
      prisma.user.findMany({ where: { role: "SUPER_ADMIN", isActive: true }, select: { id: true } }),
    ]);
    const nom = personne?.name ?? "Une personne";
    for (const a of admins) {
      await notifyUser({
        userId: a.id, type: "GENERIC",
        title: `Assistant IA : ${nom} a atteint son plafond du jour`,
        body: `${Math.round(jetons).toLocaleString("fr-FR")} jetons consommés pour un plafond de ${plafond.toLocaleString("fr-FR")}. `
          + "Ses demandes sont refusées jusqu'à minuit (heure d'Alger). Le plafond se règle dans Consommation IA.",
        link: "/admin/ai/consommation",
      }).catch(() => undefined);
    }
    return true;
  } catch (e) {
    console.error("[assistant-ia] avis de plafond", e);
    return false;
  }
}

// ─────────────────────────────── Le budget d'un tour ───────────────────────────────

export interface AppelModele {
  provider: string;
  model: string;
  entree: number;
  sortie: number;
  cache: number;
  raisonnement: number;
  /** Durée de l'ÉTAPE : l'appel du modèle et les outils qu'il a demandés. */
  ms: number;
}

export class Budget {
  readonly turnId = randomUUID();
  readonly appels: AppelModele[] = [];

  constructor(
    readonly userId: string | null,
    readonly origine: OrigineAppel,
    readonly conversation: string | null,
    readonly reglages: ReglagesAssistantIa,
    /** Ce que la personne avait déjà consommé aujourd'hui à l'ouverture. */
    readonly consommeAvant: number,
  ) {}

  get consomme(): number {
    return this.appels.reduce((s, a) => s + a.entree + a.sortie, 0);
  }

  /** Ce qui reste du jour à l'ouverture — infini quand l'appel n'a pas de personne (aucune n'est plafonnée). */
  private get resteJour(): number {
    return this.userId ? Math.max(0, this.reglages.plafondJetonsJour - this.consommeAvant) : Infinity;
  }

  /** La borne du tour : son plafond, ou ce qui reste du jour s'il est plus bas. */
  get limite(): number {
    return Math.min(this.reglages.plafondJetonsTour, this.resteJour);
  }

  get depasse(): boolean {
    return this.consomme >= this.limite;
  }

  /** Inscrit un appel ; rend VRAI quand le tour a atteint sa borne — l'appelant arrête alors la boucle. */
  enregistrer(a: AppelModele): boolean {
    this.appels.push(a);
    return this.depasse;
  }

  /** La phrase du refus — qui dit QUEL plafond a arrêté le tour. */
  refus(): string {
    const parJour = this.resteJour < this.reglages.plafondJetonsTour;
    return refusPlafondTour(parJour ? this.resteJour : this.reglages.plafondJetonsTour, parJour);
  }
}

/** Ouvre le budget d'un tour — ou refuse, si la personne a atteint son plafond du jour. */
export async function ouvrirBudget(p: { userId: string | null; origine: OrigineAppel; conversation?: string | null }): Promise<Budget> {
  const reglages = await lireReglagesAssistantIa();
  const avant = p.userId ? await jetonsDuJour(p.userId) : 0;
  if (p.userId && avant >= reglages.plafondJetonsJour) {
    await signalerPlafondJour(p.userId, avant, reglages.plafondJetonsJour);
    throw new PlafondIaAtteint(refusPlafondJour(reglages.plafondJetonsJour));
  }
  return new Budget(p.userId, p.origine, p.conversation ?? null, reglages, avant);
}

/** Ferme le budget : le journal (une ligne par appel, une par tour), puis l'avis si le jour vient d'être franchi. */
export async function fermerBudget(b: Budget, issue: { ok: boolean; erreur?: string | null; ms: number; outils?: number }): Promise<void> {
  const lignes = b.appels.map((a) => ({
    turnId: b.turnId, route: b.origine, feature: FEATURE_ASSISTANT_IA,
    userId: b.userId, threadId: b.conversation, missionId: null,
    role: b.origine, provider: a.provider, model: a.model,
    inputTokens: a.entree, outputTokens: a.sortie, cachedInputTokens: a.cache, reasoningTokens: a.raisonnement, webSearchCalls: 0,
    costUsd: coutEstimeUsd(a.entree, a.sortie, tarifDe(a.provider)), ms: a.ms, attempts: 1, incompleteReason: null,
  }));
  if (lignes.length) {
    await prisma.modelCallLog.createMany({ data: lignes }).catch((e) => console.error("[assistant-ia] journal des appels", e));
  }
  const couts = lignes.map((l) => l.costUsd);
  const premier = b.appels[0];
  await logAiUsage({
    feature: FEATURE_ASSISTANT_IA,
    provider: premier?.provider ?? "mimo",
    model: premier?.model ?? null,
    userId: b.userId,
    ok: issue.ok,
    latencyMs: issue.ms,
    errorCode: issue.ok ? null : (issue.erreur ?? "erreur").slice(0, 120),
    turns: b.appels.length,
    toolCalls: issue.outils ?? null,
    turnId: b.turnId,
    route: b.origine,
    threadId: b.conversation,
    llmCalls: b.appels.length,
    inputTokens: b.appels.reduce((s, a) => s + a.entree, 0),
    outputTokens: b.appels.reduce((s, a) => s + a.sortie, 0),
    cachedInputTokens: b.appels.reduce((s, a) => s + a.cache, 0),
    reasoningTokens: b.appels.reduce((s, a) => s + a.raisonnement, 0),
    // Un total partiel se lirait comme un total : un seul appel sans tarif rend le coût du tour inconnu.
    costUsd: couts.length && couts.every((c) => c != null) ? couts.reduce((s, c) => s + (c ?? 0), 0) : null,
  });
  if (b.userId && b.consommeAvant < b.reglages.plafondJetonsJour && b.consommeAvant + b.consomme >= b.reglages.plafondJetonsJour) {
    await signalerPlafondJour(b.userId, b.consommeAvant + b.consomme, b.reglages.plafondJetonsJour);
  }
}

/** L'usage d'une étape de Mastra (AI SDK v2) ramené à un appel du journal. */
export function appelDepuisEtape(m: { provider: string; model: string }, usage: unknown, ms: number): AppelModele {
  const u = (usage ?? {}) as { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; reasoningTokens?: number };
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0);
  return { ...m, entree: n(u.inputTokens), sortie: n(u.outputTokens), cache: n(u.cachedInputTokens), raisonnement: n(u.reasoningTokens), ms: Math.max(0, Math.round(ms)) };
}

// ─────────────────────────────── Qui appelle ───────────────────────────────

/**
 * L'IDENTITÉ DE L'APPEL voyage avec l'exécution : un tour, un passage de routine ou une opération
 * confirmée posent la personne (et la conversation) une fois ; `genererTexte`, appelé dix modules plus
 * bas, la lit ici. Pendant un tour, le BUDGET du tour y est aussi : un résumé lancé par un outil
 * compte dans le tour qui l'a demandé.
 */
interface Porteur {
  userId: string | null;
  conversation: string | null;
  budget: Budget | null;
}

const porteurs = new AsyncLocalStorage<Porteur>();

export function porteurCourant(): Porteur | null {
  return porteurs.getStore() ?? null;
}

/** Exécute `fn` au nom de cette personne : les appels de modèle qu'il déclenche lui sont imputés. */
export function auNomDe<T>(userId: string, fn: () => Promise<T>, conversation: string | null = null): Promise<T> {
  const parent = porteurs.getStore();
  return porteurs.run({ userId, conversation: conversation ?? parent?.conversation ?? null, budget: parent?.budget ?? null }, fn);
}

/** Exécute `fn` sous ce budget (le tour en cours) : les rédactions qu'il lance s'y inscrivent. */
export function sousBudget<T>(b: Budget, fn: () => Promise<T>): Promise<T> {
  return porteurs.run({ userId: b.userId, conversation: b.conversation, budget: b }, fn);
}
