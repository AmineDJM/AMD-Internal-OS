/**
 * ═════════════════════════════════════════════════════════════════════════════════════
 * LA COUCHE IA HISTORIQUE — aujourd'hui une FAÇADE sur la passerelle, et plus un second chemin.
 *
 * ── CE QUI A ÉTÉ MESURÉ, ET POURQUOI CE FICHIER A CHANGÉ DE NATURE ──────────────────
 *
 * `models/gateway.ts` porte en tête : « LA PASSERELLE — le SEUL endroit d'Adam qui parle à un
 * fournisseur de modèle ». C'était faux. Ce module ouvrait sa propre connexion HTTP vers
 * Anthropic, et VINGT-SEPT appelants passaient par là — dont la distillation de la mémoire, le
 * découpage en épisodes, le brief quotidien, l'analyse de contrat, l'extraction des lignes
 * d'appel d'offres, l'arbitrage de faits et le simulateur d'examen.
 *
 * Le banc live l'a rendu visible d'un coup : à chaque tour, `[ai] anthropic error 401`. Le
 * déploiement tourne sur OpenAI (`ADAM_MODEL_PROVIDER` vaut `openai` par défaut) ; ce chemin-là
 * partait chez Anthropic quoi qu'il arrive. Trois conséquences, aucune visible à l'écran :
 *
 *   1. **La capacité ne s'exécutait pas.** La mémoire durable d'Adam était branchée, appelée,
 *      et morte à l'arrivée. `catch` silencieux — par dessein, la mémoire ne doit pas casser un
 *      tour — donc rien ne le disait.
 *   2. **Le coût était FAUX.** `recordModelCall` vit dans la passerelle. Ces appels-là n'y
 *      passant pas, ils ne comptaient ni en jetons, ni en dollars : un total partiel présenté
 *      comme un total, ce que `contract.ts` interdit en toutes lettres.
 *   3. **L'abstention était malhonnête.** `aiConfigured()` lisait `ANTHROPIC_API_KEY`. Sur un
 *      déploiement OpenAI parfaitement configuré, une demi-douzaine de modules répondaient
 *      « pas de clé → pas d'IA » alors que le modèle était là.
 *
 * ── CE QUE CE FICHIER FAIT MAINTENANT ───────────────────────────────────────
 *
 * Il traduit deux PALIERS historiques en deux RÔLES du registre, et rien d'autre :
 *
 *   • palier QUALITÉ (`askClaude`)  → rôle `worker` ;
 *   • palier ÉCO     (`askClaudeCheap`) → rôle `bulk`.
 *
 * Les vingt-sept appelants ne changent pas d'une ligne : même signature, même `AiTextResult`.
 * Ce qu'ils gagnent, ils l'obtiennent par la passerelle et sans le demander — le fournisseur
 * actif, la télémétrie, le coût, la file d'attente, le budget de sortie, le choix de protocole.
 *
 * Le nom `askClaude` reste : le renommer toucherait vingt-sept fichiers pour ne rien prouver.
 * Ce qu'il désigne, c'est « une question, une réponse en texte, au palier qualité ».
 * ════════════════════════════════════════════════════════════════════════════════════
 */

import { askModel } from "./models/gateway";
import { bindingFor, roleConfigured } from "./models/registry";
import type { ModelRole } from "./models/contract";
import {
  callClaude as appelPasserelle,
  callClaudeStream as fluxPasserelle,
  type ClaudeMessage as MessageClaude,
  type ClaudeRawResult as ResultatClaude,
  type CompatOptions,
} from "./models/compat";

// Assainissement partagé avec la voie Luna — défini à part pour que les deux fournisseurs
// s'en servent sans se tirer l'un l'autre dans leur graphe d'imports.
import { sanitizeForModel } from "./ai-text";
// L'interrupteur général de l'écran « Contrôle de l'IA » — lu ici, AVANT tout appel (voir `IA_COUPEE`).
import { interrupteurIaCoupe, REFUS_IA_COUPEE } from "./ai-settings";
import { attendu } from "@/lib/journal";
export { sanitizeForModel };

export interface AiTextResult {
  ok: boolean;
  configured: boolean;
  text?: string;
  error?: string;
}

/**
 * L'INTERRUPTEUR GÉNÉRAL, LU EN PREMIER PAR CHAQUE PORTE DE CE FICHIER (audit 360°, rapport 19, F3).
 *
 * Ce module ne le lisait pas. Le Super Admin coupait toute l'IA depuis « Contrôle de l'IA », l'écran
 * le lui confirmait — « Toute l'IA est coupée » —, et l'analyse d'un AO PCH, d'un contrat RH, le
 * compte rendu de réunion, le brief du matin et dix modules réglementaires appelaient le modèle
 * quand même. Chaque porte d'ici qui parle à un fournisseur lit désormais l'interrupteur AVANT la
 * clé et AVANT la passerelle : coupé, aucun appel ne part, aucun jeton n'est compté, rien n'est
 * journalisé.
 *
 * LA FORME RENDUE est l'échec que les appelants traitent déjà — `ok: false`, la phrase dans `error` —
 * avec `configured: true`. `configured: false` veut dire « la clé manque » partout dans ce dépôt, et
 * des écrans y répondent en renvoyant vers les variables d'environnement (la synthèse des processus
 * affiche alors « la clé du fournisseur … est absente », icône de clé à l'appui). Ce serait un remède
 * FAUX — la clé est là, c'est l'interrupteur qui est coupé —, et un remède faux coûte plus qu'aucun
 * (§118.128).
 *
 * Effet en production, dit d'avance : si la ligne enregistrée porte déjà l'interrupteur coupé, ces
 * analyses s'ARRÊTENT au déploiement. C'est l'interrupteur qui fait ce que l'écran annonce ; le
 * remède est de le rallumer, sur ce même écran.
 */
const IA_COUPEE = { ok: false, configured: true, error: REFUS_IA_COUPEE } as const;

/**
 * LES DEUX PALIERS, exprimés en RÔLES du registre — pas en noms de modèles.
 *
 * Un nom de modèle écrit ici serait faux le jour où le registre change, et il y en aurait deux
 * à corriger. Un rôle, lui, désigne une INTENTION : `worker` pour ce qui demande du
 * raisonnement (revue CTD, simulateur, réponse aux réserves, brain, analyse de contrat),
 * `bulk` pour ce qui est mécanique (extraction, résumé, brouillon, Q&R ancrée, mémoire).
 *
 * Le repli en aval — schéma, ancrage des preuves, citations — est ce qui rend le palier ÉCO sûr
 * sur ces tâches-là. Il n'a pas changé.
 */
const ROLE_QUALITE: ModelRole = "worker";
const ROLE_ECO: ModelRole = "bulk";

/**
 * L'IA est-elle utilisable ? La question porte sur le FOURNISSEUR ACTIF, pas sur Anthropic.
 *
 * Elle lisait `ANTHROPIC_API_KEY`. Sur un déploiement OpenAI — le défaut — une demi-douzaine de
 * modules bien écrits (`arbitrate-facts`, `ai-facts`, `draft`, `simulator/run`) s'abstenaient
 * honnêtement d'un travail qu'ils pouvaient parfaitement faire. Une abstention fondée sur une
 * clé qu'on n'utilise pas n'est pas de la prudence, c'est une panne silencieuse.
 */
export function aiConfigured(): boolean {
  return roleConfigured(ROLE_QUALITE);
}

/**
 * LE NOM DE LA CLÉ QUI MANQUE — demandé souvent, gravé nulle part.
 *
 * Trois écrans annonçaient « ANTHROPIC_API_KEY absente » sur un déploiement qui tourne chez
 * OpenAI. Chacun avait recopié le nom. Le renvoyer d\'ici évite la quatrième recopie, et évite
 * surtout que `regulatory/` ait à interroger le registre des modèles pour une chaîne de
 * caractères — ce qui créait un cycle entre deux domaines (`domains.test.ts` l\'a refusé).
 */
export function cleModeleRequise(): "ANTHROPIC_API_KEY" | "OPENAI_API_KEY" {
  return bindingFor(ROLE_QUALITE).provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
}

/**
 * LE FOURNISSEUR, EN CLAIR — pour qu'un écran n'ait plus à comparer un nom de variable.
 *
 * La console d'administration écrivait `cleModeleRequise() === "ANTHROPIC_API_KEY" ? … : …` :
 * juste, mais elle remettait le littéral dans un `.tsx`, ce qui rend le cliquet de §118.128
 * inapplicable. Un écran veut le NOM DU FOURNISSEUR ; il le demande.
 */
export function fournisseurDeRaisonnement(): "Anthropic" | "OpenAI" {
  return bindingFor(ROLE_QUALITE).provider === "anthropic" ? "Anthropic" : "OpenAI";
}

/**
 * ANCIENNES VARIABLES `AI_MODEL` / `AI_MODEL_CHEAP` — dites, pas ignorées en douce.
 *
 * Elles nommaient un modèle pour une passerelle qui ne décide plus. C'est `ADAM_MODEL_WORKER` /
 * `ADAM_MODEL_BULK` qui le font, dans le registre. Les honorer ici rendrait un nom de modèle
 * Anthropic à un appel qui part chez OpenAI : un 404 au lieu d'une réponse.
 *
 * Le silence serait pire que le changement : quelqu'un a posé cette variable en pensant régler
 * quelque chose. On le dit une fois, au démarrage, à l'endroit où on la lit.
 */
let legsAnnonce = false;
function annoncerLegs(): void {
  if (legsAnnonce) return;
  legsAnnonce = true;
  const posees = ["AI_MODEL", "AI_MODEL_CHEAP"].filter((k) => process.env[k]);
  if (posees.length === 0) return;
  console.warn(
    `[ai] ${posees.join(" et ")} n'a plus d'effet : le modèle est choisi par le registre ` +
    `(ADAM_MODEL_WORKER / ADAM_MODEL_BULK). Modèles en vigueur : ` +
    `${bindingFor(ROLE_QUALITE).model} (qualité), ${bindingFor(ROLE_ECO).model} (éco).`,
  );
}

/** Le modèle qui SERT le palier qualité — celui qui répondra, pas celui qu'on croyait. */
export function aiModel(): string {
  annoncerLegs();
  return bindingFor(ROLE_QUALITE).model;
}

/** Le modèle qui SERT le palier éco. Journalisé tel quel dans `AiUsage`. */
export function aiModelCheap(): string {
  annoncerLegs();
  return bindingFor(ROLE_ECO).model;
}

interface AskOptions {
  system?: string;
  maxTokens?: number;
  temperature?: number;
}

/**
 * UNE QUESTION, UNE RÉPONSE EN TEXTE, au palier demandé.
 *
 * `sanitizeForModel` reste appliqué ICI en plus de la passerelle : les deux barrières ne
 * protègent pas de la même chose et aucune ne coûte assez pour qu'on choisisse.
 */
async function demander(role: ModelRole, prompt: string, opts: AskOptions): Promise<AiTextResult> {
  // L'interrupteur AVANT la clé : coupé, la réponse vraie est « coupé », même sans clé — rallumé,
  // la personne apprendra ensuite ce qui manque encore. Jamais l'inverse.
  if (await interrupteurIaCoupe()) return { ...IA_COUPEE };
  if (!roleConfigured(role)) {
    const cle = bindingFor(role).provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
    return { ok: false, configured: false, error: `Clé ${cle} non configurée.` };
  }
  const { text, reply } = await askModel(role, sanitizeForModel(prompt), {
    system: opts.system,
    maxOutputTokens: opts.maxTokens ?? 1024,
    temperature: opts.temperature ?? 0.3,
  });
  if (!reply.ok || text === null) {
    return { ok: false, configured: reply.configured, error: reply.error ?? "Appel à l'IA impossible." };
  }
  return { ok: true, configured: true, text: text.trim() };
}

/** Palier QUALITÉ (raisonnement) — revue CTD, simulateur, brain, analyse de contrat. */
export async function askClaude(prompt: string, opts: AskOptions = {}): Promise<AiTextResult> {
  return demander(ROLE_QUALITE, prompt, opts);
}

/**
 * Palier ÉCO (tâches mécaniques) — extraction, résumé, brouillon, Q&R ancrée, mémoire durable.
 */
export async function askClaudeCheap(prompt: string, opts: AskOptions = {}): Promise<AiTextResult> {
  return demander(ROLE_ECO, prompt, opts);
}

// ─────────────────────────── Sonde de santé (test quotidien du chatbot) ───────────────────────────

export interface AiHealthResult {
  ok: boolean;
  configured: boolean;
  model: string;
  latencyMs: number;
  status?: number; // code HTTP si une réponse a été reçue
  error?: string; // message EXACT (statut + message de l'API, ou erreur réseau)
}

/**
 * PING RÉEL DU FOURNISSEUR ACTIF — et pourquoi il ne pouvait pas rester câblé sur Anthropic.
 *
 * L'écran d'administration lit cette fonction pour dire « l'IA répond » ou « voici quoi
 * corriger ». Elle pingait `api.anthropic.com` avec le modèle rendu par `aiModel()`. Le jour où
 * `aiModel()` a cessé de mentir — il rend désormais le modèle qui SERT, donc un modèle OpenAI —
 * ce ping serait parti demander `gpt-5.6-terra` à Anthropic. Un 404, et un écran qui annonce une
 * panne pendant que le produit fonctionne : le pire des deux mondes, car on corrige le mauvais
 * problème.
 *
 * En passant par la passerelle, le ping interroge le fournisseur qui répondra vraiment, et le
 * message d'erreur remonté est celui de l'API (statut + `error.message`), pas un code nu.
 * Il demande huit jetons sur le rôle `bulk` : un diagnostic ne se fait pas sur le modèle cher. Le
 * plancher du fournisseur (16 chez OpenAI, `PLANCHER_SORTIE_RESPONSES`) s'applique dans
 * l'adaptateur — c'est lui qui transformait ce ping en 400, donc en fausse panne (§118.153).
 *
 * LA SEULE PORTE DE CE FICHIER QUI NE LIT PAS L'INTERRUPTEUR GÉNÉRAL — exprès. La sonde envoie le
 * mot « ping » et rien d'autre : aucun document, aucune donnée. La couper sous l'interrupteur ferait
 * échouer le test quotidien (`ai-health.ts`), qui alerterait alors les Super Admins « Chatbot IA
 * indisponible » chaque jour où l'IA est coupée VOLONTAIREMENT — une fausse panne de plus — et
 * ôterait à l'administrateur le bouton « Tester maintenant », c'est-à-dire le moyen de vérifier la
 * clé AVANT de rallumer.
 */
export async function aiSelfTest(): Promise<AiHealthResult> {
  const { model, provider } = bindingFor(ROLE_ECO);
  const started = Date.now();
  if (!roleConfigured(ROLE_ECO)) {
    const cle = provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
    return {
      ok: false, configured: false, model, latencyMs: 0,
      error: `Clé ${cle} absente : le chatbot et toutes les fonctions IA sont désactivés. Ajoutez la clé (Render → variables d'environnement).`,
    };
  }
  const { text, reply } = await askModel(ROLE_ECO, "ping", { maxOutputTokens: 8, temperature: 0 });
  const latencyMs = Date.now() - started;
  if (reply.ok && text !== null) return { ok: true, configured: true, model, latencyMs, status: 200 };
  return { ok: false, configured: reply.configured, model, latencyMs, error: reply.error ?? "Le modèle n'a rien renvoyé." };
}

// ─────────────────────────── Tool-use (boucle agent — Chatbot) ───────────────────────────

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'APPEL AVEC OUTILS — RÉEXPORTÉ, plus réimplémenté.
 *
 * `models/compat.ts` porte exactement les mêmes types et la même signature ; il les traduit vers
 * la passerelle. Ce fichier en tenait une SECONDE copie, câblée en dur sur Anthropic, avec sa
 * propre boucle de reprise et son propre décodeur d'événements — et un appelant de production
 * qui l'utilisait encore : la boucle agent du dossier Regulatory (`knowledge/dossier-agent.ts`).
 *
 * Deux implémentations de la même chose divergent toujours, et c'est la moins regardée qui garde
 * le défaut. Celle-ci avait le sien : elle ne comptait aucun jeton, et elle partait chez un
 * fournisseur que le déploiement n'utilise pas.
 *
 * Le RÔLE par défaut est `worker` et non `orchestrator` : ces appelants-ci ne tiennent pas une
 * conversation, ils font un travail de fond. C'est la seule différence avec `compat`, et elle
 * porte sur qui paie.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export type { ClaudeToolDef, ClaudeContentBlock, ClaudeMessage, ClaudeRawResult } from "./models/compat";

type CallOptions = Omit<CompatOptions, "role">;

/** Appel avec outils et historique multi-tours. Serveur uniquement. */
export async function callClaude(messages: MessageClaude[], opts: CallOptions = {}): Promise<ResultatClaude> {
  // Même porte que `demander` : la boucle agent du dossier Regulatory passe par ici.
  if (await interrupteurIaCoupe()) return { ...IA_COUPEE };
  return appelPasserelle(messages, { ...opts, role: ROLE_QUALITE });
}

/** Variante STREAMING : même entrée, même sortie, le texte arrive au fil de l'eau. */
export async function callClaudeStream(
  messages: MessageClaude[],
  onText: (chunk: string) => void,
  opts: CallOptions = {},
): Promise<ResultatClaude> {
  // Coupé : `onText` n'est jamais appelé — aucun fragment ne s'écrit à l'écran comme s'il venait du modèle.
  if (await interrupteurIaCoupe()) return { ...IA_COUPEE };
  return fluxPasserelle(messages, onText, { ...opts, role: ROLE_QUALITE });
}

// ─────────────────────────── Speech-to-text (Whisper / OpenAI) ───────────────────────────

export function sttConfigured(): boolean {
  return Boolean(process.env.OPENAI_API_KEY);
}

export interface TranscriptionResult {
  ok: boolean;
  configured: boolean;
  text?: string;
  error?: string;
}

/** Transcrit un audio en texte via l'API OpenAI Whisper (français). Serveur uniquement.
 *  Réessaie sur 429/5xx (limite de débit transitoire) ; message clair si quota dépassé. */
export async function transcribeAudio(buffer: Buffer, filename: string, mime: string): Promise<TranscriptionResult> {
  // Un enregistrement envoyé à Whisper est un appel d'IA comme un autre : l'interrupteur d'abord.
  // Les trois routes qui appellent cette fonction lisent déjà leur bascule ; la porte d'ici tient
  // pour celle qu'on ajoutera demain sans y penser.
  if (await interrupteurIaCoupe()) return { ...IA_COUPEE };
  const key = process.env.OPENAI_API_KEY;
  if (!key) return { ok: false, configured: false, error: "Clé OPENAI_API_KEY non configurée." };
  const base = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
  const model = process.env.STT_MODEL ?? "whisper-1";

  const MAX_ATTEMPTS = 4;
  let lastError = "Transcription impossible (réseau).";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const form = new FormData();
      form.append("file", new Blob([buffer], { type: mime || "audio/webm" }), filename || "audio.webm");
      form.append("model", model);
      form.append("language", "fr");
      const res = await fetch(`${base.replace(/\/$/, "")}/audio/transcriptions`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}` },
        body: form,
        signal: AbortSignal.timeout(60_000),
      });
      if (res.ok) {
        const data = (await res.json()) as { text?: string };
        return { ok: true, configured: true, text: (data.text ?? "").trim() };
      }
      const body = await res.text().catch(attendu("corps d\'une réponse en échec : le statut HTTP suffit au diagnostic", ""));
      console.error("[ai] whisper error", res.status, body.slice(0, 400));
      if (res.status === 429) {
        // 429 = limite de débit OU quota/crédit épuisé. On réessaie les limites
        // transitoires ; sinon message explicite (la cause la plus fréquente est
        // l'absence de crédit/facturation sur le compte OpenAI).
        const quota = /quota|billing|insufficient/i.test(body);
        lastError = quota
          ? "Transcription indisponible : quota/crédit OpenAI épuisé. Ajoutez du crédit (ou activez la facturation) sur votre compte OpenAI, puis réessayez."
          : "Limite de débit OpenAI atteinte (trop de requêtes). Réessayez dans un instant.";
        if (quota || attempt === MAX_ATTEMPTS) return { ok: false, configured: true, error: lastError };
      } else if (res.status >= 500) {
        lastError = `Service de transcription momentanément indisponible (HTTP ${res.status}).`;
        if (attempt === MAX_ATTEMPTS) return { ok: false, configured: true, error: lastError };
      } else {
        return { ok: false, configured: true, error: `Erreur transcription (HTTP ${res.status}).` };
      }
    } catch (err) {
      console.error(`[ai] whisper call failed (attempt ${attempt})`, err);
      lastError = "Transcription impossible (réseau ou délai dépassé).";
      if (attempt === MAX_ATTEMPTS) return { ok: false, configured: true, error: lastError };
    }
    await new Promise((r) => setTimeout(r, 800 * attempt)); // backoff
  }
  return { ok: false, configured: true, error: lastError };
}

// La synthèse vocale phrase-par-phrase (TTS) a été RETIRÉE : la voix du Chief of Staff est
// désormais une session speech-to-speech temps réel (API Realtime, WebRTC) — voir
// lib/assistant/voice-realtime.ts. La transcription (dictée) ci-dessus reste le repli explicite.

// ─────────────────────────── Analyse IA d'un rapport terrain ───────────────────────────

export interface FieldReportExtraction {
  doctorName?: string;
  institution?: string;
  specialty?: string;
  products?: string;
  interest?: string;
  objection?: string;
  medicalQuestion?: string;
  documentRequest?: string;
  sponsoringRequest?: string;
  careRequest?: string;
  competitorInfo?: string;
  opportunity?: string;
  qualitySignal?: string;
  nextAction?: string;
  summary?: string;
  aiNotes?: string;
}

const FIELD_REPORT_SYSTEM = `Tu structures un compte rendu de visite médicale pour un délégué d'Adventum Pharma
(laboratoire algérien), à partir d'une transcription orale en français. Tu renvoies UNIQUEMENT un objet
JSON valide (sans texte autour) avec ces clés (chaîne vide si absent) :
doctorName, institution, specialty, products, interest, objection, medicalQuestion, documentRequest,
sponsoringRequest, careRequest, competitorInfo, opportunity, qualitySignal, nextAction, summary, aiNotes.
RÈGLES : n'invente jamais un médecin, un produit ou un établissement absent de la transcription. Si une
information est incertaine, mets-la quand même mais ajoute-la à "aiNotes" préfixée par "à confirmer:".
"qualitySignal" = tout signalement qualité ou de pharmacovigilance (à confirmer systématiquement).
"summary" = compte rendu synthétique en 1-2 phrases.`;

export interface FieldAnalysisResult {
  ok: boolean;
  configured: boolean;
  data?: FieldReportExtraction;
  error?: string;
}

function extractJson(text: string): FieldReportExtraction | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as FieldReportExtraction;
  } catch {
    return null;
  }
}

/** Analyse une transcription en champs structurés (Claude). */
export async function analyzeFieldReport(transcript: string): Promise<FieldAnalysisResult> {
  if (!aiConfigured()) return { ok: false, configured: false, error: `Clé ${cleModeleRequise()} non configurée.` };
  // Extraction structurée mécanique → palier ÉCO (schéma Zod + ancrage en aval = sûr).
  const r = await askClaudeCheap(`Transcription :\n"""${transcript.slice(0, 8000)}"""\n\nRenvoie le JSON structuré.`, {
    system: FIELD_REPORT_SYSTEM,
    maxTokens: 1024,
    temperature: 0.1,
  });
  if (!r.ok || !r.text) return { ok: false, configured: r.configured, error: r.error ?? "Analyse impossible." };
  const data = extractJson(r.text);
  if (!data) return { ok: false, configured: true, error: "Réponse IA non exploitable." };
  return { ok: true, configured: true, data };
}

// ───────────────────────── Compte rendu de réunion ─────────────────────────

const MEETING_SYSTEM = `Tu rédiges le COMPTE RENDU d'une réunion interne d'Adventum Pharma (laboratoire algérien,
devise DZD), à partir de sa transcription en français. Tu renvoies UNIQUEMENT un objet JSON valide (sans
texte autour) avec ces clés :
- "summary" : compte rendu clair et structuré en français (points clés, décisions, échéances), en quelques
  phrases ou puces séparées par des retours à la ligne. Reste factuel.
- "tasks" : tableau des actions à entreprendre déduites de la réunion. Chaque élément = un objet
  { "title": "...", "description": "...", "assignee": "..." }. "assignee" = nom de la personne désignée
  dans la réunion (chaîne vide si personne n'est nommé). 0 à 8 tâches, uniquement celles réellement évoquées.
RÈGLES : n'invente jamais une décision, un chiffre ou une personne absente de la transcription. Si rien
n'est exploitable, renvoie summary="" et tasks=[].`;

export interface MeetingTaskSuggestion {
  title: string;
  description?: string;
  assignee?: string;
}
export interface MeetingSummary {
  summary: string;
  tasks: MeetingTaskSuggestion[];
}
export interface MeetingSummaryResult {
  ok: boolean;
  configured: boolean;
  data?: MeetingSummary;
  error?: string;
}

/** Produit un compte rendu + des tâches proposées à partir d'une transcription de réunion. */
export async function summarizeMeetingTranscript(transcript: string): Promise<MeetingSummaryResult> {
  if (!aiConfigured()) return { ok: false, configured: false, error: `Clé ${cleModeleRequise()} non configurée.` };
  const clean = transcript.trim();
  if (!clean) return { ok: false, configured: true, error: "Transcription vide." };
  // Résumé + tâches d'une réunion = tâche mécanique → palier ÉCO.
  const r = await askClaudeCheap(`Transcription de la réunion :\n"""${clean.slice(0, 12000)}"""\n\nRenvoie le JSON (summary + tasks).`, {
    system: MEETING_SYSTEM,
    maxTokens: 1500,
    temperature: 0.2,
  });
  if (!r.ok || !r.text) return { ok: false, configured: r.configured, error: r.error ?? "Compte rendu impossible." };
  const start = r.text.indexOf("{");
  const end = r.text.lastIndexOf("}");
  if (start === -1 || end <= start) return { ok: false, configured: true, error: "Réponse IA non exploitable." };
  try {
    const parsed = JSON.parse(r.text.slice(start, end + 1)) as Partial<MeetingSummary>;
    const tasks = Array.isArray(parsed.tasks)
      ? parsed.tasks
          .filter((t): t is MeetingTaskSuggestion => Boolean(t && typeof t.title === "string" && t.title.trim()))
          .slice(0, 8)
          .map((t) => ({ title: String(t.title).trim(), description: t.description ? String(t.description).trim() : undefined, assignee: t.assignee ? String(t.assignee).trim() : undefined }))
      : [];
    return { ok: true, configured: true, data: { summary: (parsed.summary ?? "").trim(), tasks } };
  } catch {
    return { ok: false, configured: true, error: "Réponse IA non exploitable." };
  }
}
