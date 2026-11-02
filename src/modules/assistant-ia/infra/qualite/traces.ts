import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { ModelRouterLanguageModel } from "@mastra/core/llm";
import { prisma } from "@/lib/prisma";
import type { PowerTool } from "@/platform/ia/outil";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES TRACES REJOUABLES (J14, décision 0022) — chaque tour de l'Assistant IA se rejoue À L'IDENTIQUE, sans
 * rappeler le modèle, pour reproduire un bug.
 *
 * ── CE QUI EST ENREGISTRÉ ────────────────────────────────────────────────────────────────
 *
 *   • l'ENTRÉE de la boucle (`repondreAvecSecours`) : consigne, message, historique, outils offerts (schéma, libellé) ;
 *   • chaque APPEL du modèle, dans l'ordre : sa nature (tour, vision, rédaction), l'empreinte du prompt reçu
 *     (sha-256 — le prompt lui-même n'est pas gardé : il est déjà dans l'entrée), les outils actifs, et TOUT ce que le
 *     modèle a rendu (les morceaux du flux, ou le résultat d'un appel non diffusé) ;
 *   • chaque SORTIE D'OUTIL, telle que le modèle l'a reçue ; et le texte final.
 *
 * Rien de plus sensible que ce qui est déjà parti au modèle : la saisie filtrée, les sorties jetonnées (repères).
 * Compressé (gzip) dans `AssistantIaTrace`, gardé `ASSISTANT_IA_TRACES_JOURS` jours (30 par défaut). Coupure :
 * `ASSISTANT_IA_TRACES=off`.
 *
 * ── LE REJEU ─────────────────────────────────────────────────────────────────────────────
 *
 * `npm run assistant:rejouer -- <tour>` : le même `repondreAvecSecours`, mais le modèle est un REJOUEUR (il rend les
 * sorties enregistrées et compare l'empreinte de ce qu'il reçoit) et les outils rendent leurs sorties enregistrées.
 * Le rejeu dit chaque DIVERGENCE (un prompt qui n'est plus le même, un outil appelé autrement) : c'est là qu'est le bug.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const VERSION_TRACE = 1;
export type NatureAppel = "tour" | "redaction" | "vision" | string;

export interface AppelTrace {
  nature: NatureAppel;
  modelId: string;
  empreinte: string;
  outils: string[];
  mode: "flux" | "generation";
  parties?: unknown[];
  resultat?: { content: unknown; finishReason: unknown; usage: unknown };
  ms: number;
}

export interface EntreeTrace {
  message: string;
  historique: { role: "user" | "assistant"; content: string }[];
  instructions: string;
  outils: { name: string; description: string; input_schema: unknown; label: string }[];
  nomAssistant: string | null;
  maxEtapes: number | null;
  delaiMs: number;
}

export interface Trace {
  version: number;
  tourId: string;
  messageId: string | null;
  userId: string;
  quand: string;
  entree: EntreeTrace | null;
  appels: AppelTrace[];
  sorties: { nom: string; entree: unknown; sortie: string }[];
  resultat: { texte: string; outilsAppeles: string[] } | null;
  erreur: string | null;
}

type Contexte =
  | { mode: "enregistrer"; trace: Trace }
  | { mode: "rejouer"; trace: Trace; servis: Record<string, number>; sortiesServies: Record<string, number>; divergences: string[] };

const ALS = new AsyncLocalStorage<Contexte>();

export const tracesActives = (env: Record<string, string | undefined> = process.env) => (env.ASSISTANT_IA_TRACES ?? "").trim().toLowerCase() !== "off";
export const JOURS_TRACES = () => Math.max(1, Number(process.env.ASSISTANT_IA_TRACES_JOURS) || 30);

/** L'empreinte d'un prompt et des outils qui l'accompagnent — stable d'un passage à l'autre pour une même entrée. */
export function empreinte(prompt: unknown, outils: string[]): string {
  // Mastra horodate chaque message (`providerOptions.mastra.createdAt`) : ce n'est pas ce que le modèle lit.
  return createHash("sha256").update(JSON.stringify(prompt ?? null, (k, v) => (k === "mastra" ? undefined : v))).update("\u0000").update(outils.join(",")).digest("hex").slice(0, 32);
}

const nomsOutils = (o: { tools?: { name?: string }[] }) => (o.tools ?? []).map((t) => t.name ?? "").filter(Boolean);
/** Les morceaux qu'un rejeu peut rendre : pas les métadonnées de réponse (dates, identifiants du fournisseur). */
const garder = (p: { type?: string }) => p.type !== "response-metadata" && p.type !== "raw";

// ─────────────────────────────── L'enregistrement ───────────────────────────────

/** Joue `fn` en enregistrant sa trace ; l'enregistre ensuite (jamais bloquant : un échec se dit en console). */
export async function avecTrace<T>(cle: { tourId: string; messageId?: string | null }, userId: string, fn: () => Promise<T>): Promise<T> {
  if (!tracesActives() || ALS.getStore()) return fn();
  const trace: Trace = {
    version: VERSION_TRACE, tourId: cle.tourId, messageId: cle.messageId ?? null, userId, quand: new Date().toISOString(),
    entree: null, appels: [], sorties: [], resultat: null, erreur: null,
  };
  try {
    return await ALS.run({ mode: "enregistrer", trace }, fn);
  } catch (e) {
    trace.erreur = e instanceof Error ? e.message.slice(0, 500) : String(e);
    throw e;
  } finally {
    await sauvegarderTrace(trace).catch((e) => console.warn("[assistant-ia] trace non enregistrée", e instanceof Error ? e.message : e));
  }
}

export async function sauvegarderTrace(t: Trace): Promise<void> {
  if (!t.entree && !t.appels.length) return;
  const donnees = gzipSync(Buffer.from(JSON.stringify(t)));
  const data = { messageId: t.messageId, userId: t.userId, version: t.version, appels: t.appels.length, octets: donnees.length, donnees };
  await prisma.assistantIaTrace.upsert({ where: { tourId: t.tourId }, create: { tourId: t.tourId, ...data }, update: { ...data, createdAt: new Date() } });
}

export function decoderTrace(octets: Uint8Array): Trace {
  return JSON.parse(gunzipSync(Buffer.from(octets)).toString("utf8")) as Trace;
}

/** La trace d'un tour : par l'identifiant de la réponse, ou par celui du message de la personne. */
export async function lireTrace(id: string): Promise<Trace | null> {
  const t = await prisma.assistantIaTrace.findFirst({ where: { OR: [{ tourId: id }, { messageId: id }] }, orderBy: { createdAt: "desc" } });
  return t ? decoderTrace(t.donnees) : null;
}

/** Les traces au-delà de la durée de garde, retirées (tâche de fond). */
export async function purgerTraces(maintenant = new Date()): Promise<number> {
  const r = await prisma.assistantIaTrace.deleteMany({ where: { createdAt: { lt: new Date(maintenant.getTime() - JOURS_TRACES() * 86_400_000) } } });
  return r.count;
}

/** L'entrée de la boucle, et ses outils enveloppés pour enregistrer (ou, au rejeu, servir) leurs sorties. */
export function tracerEntree(e: () => EntreeTrace, outils: PowerTool[]): PowerTool[] {
  const c = ALS.getStore();
  if (!c) return outils;
  if (c.mode === "enregistrer") {
    c.trace.entree ??= e();
    return outils.map((o) => ({
      ...o,
      run: async (entree, u) => {
        const sortie = await o.run(entree, u);
        c.trace.sorties.push({ nom: o.def.name, entree, sortie });
        return sortie;
      },
    }));
  }
  return outils;
}

/** Le résultat de la boucle, gardé avec la trace. */
export function tracerResultat(r: { texte: string; outilsAppeles: string[] }): void {
  const c = ALS.getStore();
  if (c?.mode === "enregistrer" && !c.trace.resultat) c.trace.resultat = { texte: r.texte, outilsAppeles: r.outilsAppeles };
}

interface ModeleV2 {
  specificationVersion: "v2";
  provider: string;
  modelId: string;
  supportedUrls: unknown;
  doGenerate: (o: never) => PromiseLike<unknown>;
  doStream: (o: never) => PromiseLike<{ stream: ReadableStream<unknown> } & Record<string, unknown>>;
}

const estModele = (m: unknown): m is ModeleV2 => typeof m === "object" && m !== null && typeof (m as ModeleV2).doStream === "function";

/**
 * LE MODÈLE QUE REÇOIT MASTRA pour un appel. Hors trace : `defaut` tel quel (le routeur `openai/…`). En
 * enregistrement : le même modèle, ENVELOPPÉ (ses sorties sont gardées au passage). Au rejeu : le rejoueur.
 */
export function modeleTrace(defaut: unknown, nature: NatureAppel): unknown {
  const c = ALS.getStore();
  if (!c) return defaut;
  if (c.mode === "rejouer") return rejoueur(c, nature);
  const base = estModele(defaut)
    ? defaut
    : typeof defaut === "object" && defaut && "id" in defaut
      ? (new ModelRouterLanguageModel(defaut as never) as unknown as ModeleV2)
      : null;
  return base ? enregistreur(base, nature, c.trace) : defaut;
}

function enregistreur(m: ModeleV2, nature: NatureAppel, trace: Trace): ModeleV2 {
  return {
    specificationVersion: "v2", provider: m.provider, modelId: m.modelId, supportedUrls: m.supportedUrls,
    async doGenerate(o: never) {
      const t0 = Date.now();
      const outils = nomsOutils(o as { tools?: { name?: string }[] });
      const r = (await m.doGenerate(o)) as { content: unknown; finishReason: unknown; usage: unknown };
      trace.appels.push({ nature, modelId: m.modelId, empreinte: empreinte((o as { prompt?: unknown }).prompt, outils), outils, mode: "generation", resultat: { content: r.content, finishReason: r.finishReason, usage: r.usage }, ms: Date.now() - t0 });
      return r;
    },
    async doStream(o: never) {
      const t0 = Date.now();
      const outils = nomsOutils(o as { tools?: { name?: string }[] });
      const r = await m.doStream(o);
      const parties: unknown[] = [];
      const appel: AppelTrace = { nature, modelId: m.modelId, empreinte: empreinte((o as { prompt?: unknown }).prompt, outils), outils, mode: "flux", parties, ms: 0 };
      trace.appels.push(appel);
      const copie = new TransformStream<unknown, unknown>({
        transform(p, ctrl) {
          if (garder(p as { type?: string })) parties.push(JSON.parse(JSON.stringify(p)));
          ctrl.enqueue(p);
        },
        flush() { appel.ms = Date.now() - t0; },
      });
      return { ...r, stream: r.stream.pipeThrough(copie) };
    },
  };
}

// ─────────────────────────────── Le rejeu ───────────────────────────────

function rejoueur(c: Extract<Contexte, { mode: "rejouer" }>, nature: NatureAppel): ModeleV2 {
  const prochain = (o: never): AppelTrace => {
    const liste = c.trace.appels.filter((a) => a.nature === nature);
    const i = c.servis[nature] ?? 0;
    c.servis[nature] = i + 1;
    const a = liste[i];
    if (!a) throw new Error(`Trace épuisée : l'appel ${nature} n° ${i + 1} n'a pas été enregistré (le code fait un appel de plus qu'à l'origine).`);
    const e = empreinte((o as { prompt?: unknown }).prompt, nomsOutils(o as { tools?: { name?: string }[] }));
    if (e !== a.empreinte) c.divergences.push(`appel ${nature} n° ${i + 1} : le prompt reçu diffère de l'enregistrement (empreinte ${e} ≠ ${a.empreinte})`);
    return a;
  };
  return {
    specificationVersion: "v2", provider: "rejeu", modelId: c.trace.appels.find((a) => a.nature === nature)?.modelId ?? "rejeu", supportedUrls: {},
    async doGenerate(o: never) {
      const a = prochain(o);
      if (a.resultat) return { ...a.resultat, warnings: [] };
      return { content: [], finishReason: "error", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, warnings: [] };
    },
    async doStream(o: never) {
      const a = prochain(o);
      const parties = a.parties ?? (a.resultat ? partiesDepuisResultat(a.resultat) : []);
      return { stream: new ReadableStream({ start(ctrl) { for (const p of parties) ctrl.enqueue(p); ctrl.close(); } }) };
    },
  };
}

/** Un appel enregistré sans flux, rendu en flux (le rejeu lit comme le produit). */
function partiesDepuisResultat(r: NonNullable<AppelTrace["resultat"]>): unknown[] {
  const contenu = (Array.isArray(r.content) ? r.content : []) as { type?: string; text?: string }[];
  return [
    { type: "stream-start", warnings: [] },
    ...contenu.flatMap((c, i) => (c.type === "text"
      ? [{ type: "text-start", id: `t${i}` }, { type: "text-delta", id: `t${i}`, delta: c.text ?? "" }, { type: "text-end", id: `t${i}` }]
      : [c])),
    { type: "finish", finishReason: r.finishReason, usage: r.usage },
  ];
}

/** Les outils d'un rejeu : ceux de l'entrée enregistrée, qui rendent les sorties enregistrées (dans l'ordre, par nom). */
export function outilsDuRejeu(trace: Trace): PowerTool[] {
  return (trace.entree?.outils ?? []).map((d) => ({
    def: { name: d.name, description: d.description, input_schema: d.input_schema } as PowerTool["def"],
    label: d.label,
    allowed: () => true,
    run: async (entree) => {
      const c = ALS.getStore();
      if (c?.mode !== "rejouer") return "Rejeu hors contexte.";
      const liste = trace.sorties.filter((s) => s.nom === d.name);
      const i = c.sortiesServies[d.name] ?? 0;
      c.sortiesServies[d.name] = i + 1;
      const s = liste[i];
      if (!s) { c.divergences.push(`outil ${d.name} appelé une fois de plus qu'à l'origine (n° ${i + 1})`); return JSON.stringify({ statut: "ECHEC", raison: "sortie non enregistrée" }); }
      if (JSON.stringify(entree ?? {}) !== JSON.stringify(s.entree ?? {})) c.divergences.push(`outil ${d.name} n° ${i + 1} : entrée ${JSON.stringify(entree)} ≠ ${JSON.stringify(s.entree)}`);
      return s.sortie;
    },
  }));
}

/** Joue `fn` en mode rejeu de `trace` ; rend son résultat et les divergences relevées. */
export async function enRejeu<T>(trace: Trace, fn: () => Promise<T>): Promise<{ resultat: T; divergences: string[]; appelsServis: number }> {
  const c: Contexte = { mode: "rejouer", trace, servis: {}, sortiesServies: {}, divergences: [] };
  const resultat = await ALS.run(c, fn);
  const servis = Object.values(c.servis).reduce((s, n) => s + n, 0);
  for (const [nom, n] of Object.entries(c.sortiesServies)) {
    const attendu = trace.sorties.filter((s) => s.nom === nom).length;
    if (n < attendu) c.divergences.push(`outil ${nom} appelé ${n} fois au rejeu, ${attendu} à l'origine`);
  }
  return { resultat, divergences: c.divergences, appelsServis: servis };
}

/** Les actifs d'une étape au rejeu : ceux que le modèle avait reçus à cet appel. */
export function actifsDuRejeu(trace: Trace): () => string[] {
  return () => {
    const c = ALS.getStore();
    const i = c?.mode === "rejouer" ? c.servis.tour ?? 0 : 0;
    return trace.appels.filter((a) => a.nature === "tour")[i]?.outils ?? [];
  };
}
