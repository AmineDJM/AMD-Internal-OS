import { AsyncLocalStorage } from "node:async_hooks";
import type { ModelRole, ModelUsage } from "./contract";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA MESURE D'UN TOUR — parce qu'« Adam est lent » n'est pas un diagnostic.
 *
 * ── CE QU'ON VEUT POUVOIR RÉPONDRE ───────────────────────────────────────────────────────
 *
 *   • quelle VOIE a été prise (texte, audio A/B, audio C délégué) ;
 *   • combien d'appels de modèle, PAR RÔLE — c'est la seule façon de vérifier la règle « A et B
 *     ne doivent surtout pas appeler l'orchestrateur inutilement » autrement qu'à l'intuition ;
 *   • le temps jusqu'au PREMIER signe de vie, puis jusqu'au résultat final. Les deux comptent, et
 *     pas de la même façon : un tour qui met 6 s mais montre quelque chose à 400 ms est vécu comme
 *     rapide, un tour qui met 3 s sans rien montrer est vécu comme cassé ;
 *   • le coût — quand il est connu (voir `contract.ts` : jamais de tarif inventé).
 *
 * ── POURQUOI `AsyncLocalStorage` ET PAS UN PARAMÈTRE ─────────────────────────────────────
 *
 * Le compteur devrait sinon traverser la boucle d'agent, les outils, les workers et les
 * adaptateurs — des centaines de signatures, dont la plupart n'ont rien à voir avec la mesure.
 * Un contexte asynchrone donne la portée « ce tour-ci » sans toucher à une seule signature, et
 * il se propage naturellement à travers les `await` et les `Promise.all` — donc à travers la
 * parallélisation, qui est justement ce qu'on veut mesurer.
 *
 * HORS D'UN TOUR, tout est silencieux : jamais d'exception parce qu'un appel a lieu depuis un
 * script, un cron ou un test. Ne pas mesurer est acceptable ; planter à cause du compteur, non.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** La VOIE prise par un tour. C'est le fait le plus important à consigner. */
export type TurnRoute =
  | "text"          // demande écrite → orchestrateur directement
  | "voice-direct"  // audio A/B — le temps réel a exécuté seul
  | "voice-deep"    // audio C — le temps réel a délégué à l'orchestrateur
  | "worker"        // sous-tâche lancée par l'orchestrateur
  | "background";   // mission planifiée, brief, cron

export interface ToolTrace {
  name: string;
  ms: number;
  ok: boolean;
  /** true si l'outil a tourné en parallèle d'au moins un autre — pour juger la parallélisation. */
  parallel?: boolean;
}

/**
 * LE CONTEXTE D'UN TOUR — de quoi rattacher chaque appel à une personne, un fil, une mission.
 *
 * Des identifiants OPAQUES, posés par l'appelant qui les connaît (la route, le runtime des
 * missions) ; la passerelle ne sait pas ce qu'ils désignent et n'a pas à le savoir. C'est ce
 * qui permet un coût PAR MISSION ou PAR FIL sans qu'un seul appel de modèle ait à porter une
 * notion métier.
 */
export interface TurnContext {
  userId?: string;
  threadId?: string;
  missionId?: string;
  /** L'usage qui paie : « assistant », « voice », « mission », « nudge », « brief »… */
  feature?: string;
  /** La VERSION DU PROMPT système qui a servi le tour — relier une régression à un texte, pas à une date. */
  promptVersion?: string;
}

export interface TurnTrace {
  turnId: string;
  route: TurnRoute;
  context: TurnContext;
  startedAt: number;
  calls: ModelUsage[];
  tools: ToolTrace[];
  /** Les outils REFUSÉS PAR LE DROIT pendant le tour — la décision de permission, comptée et nommée. */
  refus: string[];
  /** Temps jusqu'au premier signe de vie affiché (texte ou bloc). */
  firstPreviewMs: number | null;
  finalMs: number | null;
  /** Le niveau décidé par le triage, quand il y en a eu un. */
  complexity: "A" | "B" | "C" | null;
  /**
   * LES PHASES DU TOUR, en millisecondes, nommées par l'appelant : « contexte » (lectures de
   * base avant le premier appel), « pre_lectures », « outils », « modele »… C'est ce qui permet
   * de répondre « où sont passées les six secondes ? » sans rejouer le tour.
   */
  phases: Record<string, number>;
}

const storage = new AsyncLocalStorage<TurnTrace>();

let counter = 0;
const newTurnId = (): string => `t${Date.now().toString(36)}${(counter = (counter + 1) % 46656).toString(36).padStart(3, "0")}`;

/** Le tour en cours, s'il y en a un. */
export function currentTurn(): TurnTrace | undefined {
  return storage.getStore();
}

/**
 * Ouvre un tour et exécute `fn` dedans. Tout appel de modèle fait à l'intérieur — y compris dans
 * les branches parallèles — s'y rattache tout seul.
 *
 * UN TOUR NE S'IMBRIQUE PAS. Si un tour est déjà ouvert, on le REJOINT au lieu d'en créer un
 * second : quand la voix délègue (niveau C), l'orchestrateur texte tourne à l'intérieur du tour
 * vocal. Ouvrir un tour imbriqué masquerait ses appels au tour parent — c'est-à-dire cacher
 * exactement la preuve qu'on cherche : « un C fait bien travailler l'orchestrateur ». La voie
 * annoncée reste celle du tour d'ORIGINE, qui est celle que l'utilisateur a vécue.
 */
export function withTurn<T>(route: TurnRoute, fn: (trace: TurnTrace) => Promise<T>): Promise<T> {
  const existing = currentTurn();
  if (existing) return fn(existing);

  const trace: TurnTrace = {
    turnId: newTurnId(),
    route,
    context: {},
    startedAt: Date.now(),
    calls: [],
    tools: [],
    refus: [],
    firstPreviewMs: null,
    finalMs: null,
    complexity: null,
    phases: {},
  };
  return storage.run(trace, () => fn(trace));
}

/**
 * LE PUITS — ce qui reçoit CHAQUE appel de modèle, tour ou pas.
 *
 * La passerelle ne persiste rien elle-même (elle ne connaît pas la base) ; elle remet chaque
 * usage à un puits que le produit a branché. Un appel hors de tout tour (un battement, un
 * script) est remis quand même : le compteur doit voir tout ce qui a été payé, pas seulement
 * ce qu'une conversation a demandé. Le puits ne lève jamais vers ici.
 */
export type ModelCallSink = (usage: ModelUsage, turn: TurnTrace | undefined) => void;
let sink: ModelCallSink | null = null;

/**
 * LES APPELS REÇUS AVANT LE PUITS (audit K8, trou E10) : le puits se branche par effet d'import, et un
 * processus qui appelait un modèle avant d'avoir chargé un module qui l'installe PERDAIT la ligne en
 * silence. Ils attendent ici (500 au plus) et partent au branchement.
 */
const enAttente: { usage: ModelUsage; turn: TurnTrace | undefined; imputation: TurnContext | undefined }[] = [];

/**
 * L'IMPUTATION HORS TOUR (audit K8, trou E9) — un appel de la passerelle lancé HORS d'un tour d'Adam (la recherche
 * web de l'Assistant IA, un résumé) arrivait au journal SANS personne ni usage : invisible dans « ma consommation »
 * et hors du plafond du jour. Un module qui sait au nom de qui il travaille le pose ici ; le puits le lit quand le
 * tour n'en dit rien.
 */
const imputations = new AsyncLocalStorage<TurnContext>();

export function sousImputation<T>(ctx: TurnContext, fn: () => T): T {
  return imputations.run({ ...imputations.getStore(), ...ctx }, fn);
}

export function imputationCourante(): TurnContext | undefined {
  return imputations.getStore();
}
const ATTENTE_MAX = 500;

export function setModelCallSink(fn: ModelCallSink | null): void {
  sink = fn;
  if (!fn) return;
  for (const { usage, turn, imputation } of enAttente.splice(0)) {
    try { imputations.run(imputation ?? {}, () => fn(usage, turn)); } catch (err) { console.error("[models] puits d'usage en échec", err); }
  }
}

/** Complète le contexte du tour en cours — sans effet hors d'un tour. */
export function setTurnContext(ctx: TurnContext): void {
  const t = currentTurn();
  if (!t) return;
  for (const [k, v] of Object.entries(ctx)) {
    if (v != null && v !== "") (t.context as Record<string, string>)[k] = v as string;
  }
}

export function recordModelCall(usage: ModelUsage): void {
  const t = currentTurn();
  t?.calls.push(usage);
  if (sink) {
    try { sink(usage, t); } catch (err) { console.error("[models] puits d'usage en échec", err); }
  } else if (enAttente.length < ATTENTE_MAX) {
    enAttente.push({ usage, turn: t, imputation: imputations.getStore() });
  }
}

/**
 * UN APPEL PAYANT HORS PASSERELLE (plongements, transcription, OCR, lots) — même puits, même table
 * (lot K8). Le fournisseur et le rôle sont libres (`mistral`, `stt`…) : la ligne du journal les écrit
 * tels quels. Le coût est calculé par le puits, à la grille (`tarifs.ts`).
 */
export function recordProviderCall(u: Omit<ModelUsage, "provider" | "role" | "costUsd" | "attempts" | "ms"> & {
  provider: string; role: string; costUsd?: number | null; attempts?: number; ms?: number;
}): void {
  recordModelCall({ costUsd: null, attempts: 1, ms: 0, ...u } as unknown as ModelUsage);
}

export function recordTool(trace: ToolTrace): void {
  currentTurn()?.tools.push(trace);
}

/** Un outil demandé et REFUSÉ par le droit : la décision de permission est un fait du tour, elle se compte. */
export function recordPermissionRefusal(name: string): void {
  currentTurn()?.refus.push(name);
}

/** Le premier signe de vie. Seul le PREMIER compte : après, l'utilisateur regarde déjà. */
export function markPreview(): void {
  const t = currentTurn();
  if (t && t.firstPreviewMs == null) t.firstPreviewMs = Date.now() - t.startedAt;
}

export function markFinal(): void {
  const t = currentTurn();
  if (t && t.finalMs == null) t.finalMs = Date.now() - t.startedAt;
}

/** Ajoute une durée à une phase nommée du tour en cours — cumulative, silencieuse hors d'un tour. */
export function addPhase(name: string, ms: number): void {
  const t = currentTurn();
  if (!t || !Number.isFinite(ms)) return;
  t.phases[name] = (t.phases[name] ?? 0) + Math.max(0, Math.round(ms));
}

/** Mesure `fn` et l'impute à la phase `name`. */
export async function timedPhase<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  try { return await fn(); } finally { addPhase(name, Date.now() - t0); }
}

export function markComplexity(level: "A" | "B" | "C"): void {
  const t = currentTurn();
  if (t) t.complexity = level;
}

export interface TurnSummary {
  turnId: string;
  route: TurnRoute;
  context: TurnContext;
  complexity: "A" | "B" | "C" | null;
  llmCalls: number;
  callsByRole: Record<ModelRole, number>;
  toolCalls: number;
  /** Combien d'outils le droit a refusés sur ce tour (voir `recordPermissionRefusal`). */
  permissionsRefusees: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  /**
   * La part des jetons de sortie partie en RÉFLEXION sur tout le tour. Compté ici parce que c'est
   * au niveau du tour que la question se pose : « ce tour a-t-il payé plus à penser qu'à
   * répondre ? » ne se lit sur aucun appel isolé.
   */
  reasoningTokens: number;
  /**
   * COMBIEN D'APPELS ONT ÉTÉ COUPÉS PAR NOTRE PROPRE PLAFOND. Zéro est la valeur normale ; tout
   * autre chiffre est un défaut de calibrage de `budget.ts`, pas une limite du modèle. Le compter
   * par tour est ce qui empêche le problème de redevenir invisible une fois le correctif oublié.
   */
  budgetTruncations: number;
  /** Les recherches web exécutées sur le tour — facturées à l'unité, donc comptées à part. */
  webSearchCalls: number;
  /** `null` dès qu'un seul appel a un tarif inconnu : un total partiel se lirait comme un total. */
  costUsd: number | null;
  firstPreviewMs: number | null;
  finalMs: number | null;
  totalMs: number;
  /** Les phases nommées par l'appelant + « modele » (somme des durées d'appels) et « outils ». */
  phases: Record<string, number>;
}

export function summarize(trace: TurnTrace): TurnSummary {
  const callsByRole = { realtime: 0, orchestrator: 0, worker: 0, bulk: 0 } as Record<ModelRole, number>;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let reasoningTokens = 0;
  let budgetTruncations = 0;
  let webSearchCalls = 0;
  // Un seul tarif manquant rend le TOTAL inconnu. Additionner ce qu'on connaît et présenter la
  // somme comme le coût du tour serait un chiffre faux avec l'air d'un chiffre juste.
  let costUsd: number | null = 0;

  for (const c of trace.calls) {
    callsByRole[c.role] = (callsByRole[c.role] ?? 0) + 1;
    inputTokens += c.inputTokens;
    outputTokens += c.outputTokens;
    cachedInputTokens += c.cachedInputTokens;
    reasoningTokens += c.reasoningTokens ?? 0;
    webSearchCalls += c.webSearchCalls ?? 0;
    if (c.incompleteReason === "max_output_tokens") budgetTruncations++;
    if (c.costUsd == null) costUsd = null;
    else if (costUsd != null) costUsd += c.costUsd;
  }

  return {
    turnId: trace.turnId,
    route: trace.route,
    context: trace.context,
    complexity: trace.complexity,
    llmCalls: trace.calls.length,
    callsByRole,
    toolCalls: trace.tools.length,
    permissionsRefusees: trace.refus.length,
    inputTokens,
    outputTokens,
    cachedInputTokens,
    reasoningTokens,
    budgetTruncations,
    webSearchCalls,
    costUsd: costUsd == null ? null : Math.round(costUsd * 1_000_000) / 1_000_000,
    firstPreviewMs: trace.firstPreviewMs,
    finalMs: trace.finalMs,
    totalMs: Date.now() - trace.startedAt,
    phases: {
      ...trace.phases,
      modele: trace.calls.reduce((s, c) => s + (c.ms ?? 0), 0),
      outils: trace.tools.reduce((s, t) => s + t.ms, 0),
    },
  };
}

/**
 * Consigne le tour dans le journal serveur. Une ligne, structurée : c'est ce qui permet de suivre
 * une régression de latence dans le temps sans instrumenter un tableau de bord d'abord.
 */
export function logTurn(trace: TurnTrace): TurnSummary {
  const s = summarize(trace);
  console.info("[adam] turn", JSON.stringify(s));
  return s;
}
