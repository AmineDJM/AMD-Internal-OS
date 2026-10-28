import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenAIGptRealtime21Provider } from "@/app/(app)/assistant/realtime-voice";
import { BARGE_IN_SUSTAIN_MS } from "@/lib/assistant/voice-tuning";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * SCÉNARIOS VOCAUX (audit voix 2026-08) — la liste EXACTE demandée, rejouée sur le VRAI
 * pipeline d'événements du provider (`handleEvent`), canal stubbé, horloges simulées.
 *
 *   phrase courte · phrase longue · silence au milieu d'une phrase · interruption d'Adam ·
 *   faux bruit · interruption puis changement de sujet · plusieurs interruptions successives ·
 *   Adam ne reste jamais muet après un tour valide.
 *
 * ── CE QUE CE BANC PROUVE, ET CE QU'IL NE PEUT PAS ──────────────────────────────────────────
 *
 * Il éprouve NOTRE machine d'état client : intégrité du tour, coupure rapide et STT-indépendante,
 * rejet du bruit bref, non-régression du texte d'un tour à l'autre, garde anti-silence. La
 * FRONTIÈRE serveur (semantic_vad qui gère l'hésitation et le silence au milieu d'une phrase
 * AVANT d'émettre `speech_stopped`) n'est pas simulable ici : elle est réglée par
 * `buildTurnDetection` (eagerness « low ») et vérifiée dans `voice-tuning.test.ts`. Ce banc
 * vérifie que, quels que soient les regroupements que le serveur décide, le client n'invente ni
 * ne perd de tour.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

type Sent = { type: string } & Record<string, unknown>;

function harness() {
  const sent: Sent[] = [];
  const metrics: { name: string; value?: number }[] = [];
  const turns: { user: string; assistant: string }[] = [];
  const errors: string[] = [];

  const p = new OpenAIGptRealtime21Provider({
    getGrant: async () => { throw new Error("connect() hors sujet"); },
    callTool: async () => ({ output: "{}" }),
    callbacks: {
      onState: () => undefined,
      onUserTranscript: () => undefined,
      onAssistantTranscript: () => undefined,
      onTurnComplete: (t) => turns.push(t),
      onToolUi: () => undefined,
      onError: (_m, code) => errors.push(code ?? "?"),
      onMetric: (name, value) => metrics.push({ name, value }),
    },
    persistOrphanResult: () => undefined,
  });
  const priv = p as unknown as { alive: boolean; dc: unknown; _state: string; handleEvent(raw: string): void };
  priv.alive = true;
  priv.dc = { readyState: "open", send: (s: string) => sent.push(JSON.parse(s) as Sent), close: () => undefined };
  priv._state = "LISTENING";

  const feed = (ev: Record<string, unknown>) => priv.handleEvent(JSON.stringify(ev));
  const count = (type: string) => sent.filter((s) => s.type === type).length;
  const metric = (name: string) => metrics.filter((m) => m.name === name);
  const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

  /** L'assistant PARLE : réponse active, item audible, haut-parleur en marche. */
  const parle = (rid: string, itemId: string) => {
    feed({ type: "response.created", response: { id: rid } });
    feed({ type: "response.output_item.added", response_id: rid, item: { id: itemId, type: "message" } });
    feed({ type: "output_audio_buffer.started", response_id: rid });
    feed({ type: "response.output_audio_transcript.delta", response_id: rid, delta: "Je détaille le dossier en cours…" });
  };

  /** Un TOUR COMPLET normal (parole → réponse → texte → audio → fin). */
  const tour = async (rid: string, user: string, assistant: string, itemId = `it-${rid}`) => {
    feed({ type: "input_audio_buffer.speech_started", item_id: itemId });
    feed({ type: "input_audio_buffer.speech_stopped", item_id: itemId });
    feed({ type: "response.created", response: { id: rid } });
    feed({ type: "output_audio_buffer.started", response_id: rid });
    feed({ type: "response.output_audio_transcript.delta", response_id: rid, delta: assistant });
    feed({ type: "conversation.item.input_audio_transcription.completed", item_id: itemId, transcript: user });
    feed({ type: "response.output_audio_transcript.done", response_id: rid, transcript: assistant });
    feed({ type: "output_audio_buffer.stopped", response_id: rid });
    feed({ type: "response.done", response: { id: rid, status: "completed" } });
    await flush();
  };

  return { p, priv, sent, metrics, turns, errors, feed, count, metric, flush, parle, tour };
}

beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval", "performance"] }); });
afterEach(() => { vi.useRealTimers(); });

describe("phrase courte — un tour net, un premier son, une réponse entière", () => {
  it("« Quel est le budget ? » → exactement un tour, borne first_audio posée", async () => {
    const h = harness();
    await h.tour("r1", "Quel est le budget ?", "Il reste treize millions.");
    expect(h.turns).toHaveLength(1);
    expect(h.turns[0]).toEqual({ user: "Quel est le budget ?", assistant: "Il reste treize millions." });
    expect(h.metric("first_audio").length).toBeGreaterThanOrEqual(1);
    expect(h.errors).toHaveLength(0);
  });
});

describe("phrase longue — la réponse en dizaines de morceaux reste UN tour ENTIER", () => {
  it("une longue réponse fragmentée n'est jamais coupée en plusieurs messages", async () => {
    const h = harness();
    const long = "Alors, sur ce dossier, il y a trois points à retenir, et le plus important est le blocage au comité depuis douze jours, que je te résume maintenant sans rien omettre.";
    const rid = "r-long", itemId = "it-long";
    h.feed({ type: "input_audio_buffer.speech_started", item_id: itemId });
    h.feed({ type: "input_audio_buffer.speech_stopped", item_id: itemId });
    h.feed({ type: "response.created", response: { id: rid } });
    h.feed({ type: "output_audio_buffer.started", response_id: rid });
    for (const m of long.match(/.{1,7}/g) ?? []) {
      h.feed({ type: "response.output_audio_transcript.delta", response_id: rid, delta: m });
    }
    h.feed({ type: "conversation.item.input_audio_transcription.completed", item_id: itemId, transcript: "Fais-moi le point complet." });
    h.feed({ type: "response.output_audio_transcript.done", response_id: rid, transcript: long });
    h.feed({ type: "response.done", response: { id: rid, status: "completed" } });
    await h.flush();
    expect(h.turns).toHaveLength(1);
    expect(h.turns[0].assistant).toBe(long); // ENTIÈRE, jamais un préfixe
  });
});

describe("silence au milieu d'une phrase — une hésitation ne fabrique pas de tour", () => {
  it("parole → petite pause (speech_stopped) → reprise, AVANT toute réponse : aucun tour fantôme", async () => {
    // Le serveur (semantic_vad eagerness « low ») REGROUPE l'hésitation ; côté client, tant
    // qu'aucune réponse ni transcription finale n'a clos le tour, rien n'est émis.
    const h = harness();
    h.feed({ type: "input_audio_buffer.speech_started", item_id: "u-1" });
    h.feed({ type: "input_audio_buffer.speech_stopped", item_id: "u-1" }); // « alors… euh… »
    await vi.advanceTimersByTimeAsync(300);
    h.feed({ type: "input_audio_buffer.speech_started", item_id: "u-1" }); // il reprend
    expect(h.turns).toHaveLength(0); // aucun tour n'a été inventé sur la pause
    expect(h.count("response.cancel")).toBe(0); // rien coupé : l'assistant ne parlait pas
  });
});

describe("interruption d'Adam — coupure quasi immédiate, STT-indépendante", () => {
  it("des mots pendant la parole d'Adam coupent TOUT DE SUITE : cancel + clear + truncate", async () => {
    const h = harness();
    h.priv._state = "ASSISTANT_SPEAKING";
    h.parle("r1", "it-1");
    h.feed({ type: "input_audio_buffer.speech_started", item_id: "u1" });
    h.feed({ type: "conversation.item.input_audio_transcription.delta", item_id: "u1", delta: "Attends" });
    expect(h.count("response.cancel")).toBe(1);
    expect(h.count("output_audio_buffer.clear")).toBe(1);
    expect(h.sent.find((s) => s.type === "conversation.item.truncate")).toMatchObject({ item_id: "it-1" });
    expect(h.priv._state).toBe("USER_SPEAKING");
  });

  it("SANS mots (transcription lente), la parole soutenue de 180 ms coupe quand même", async () => {
    const h = harness();
    h.priv._state = "ASSISTANT_SPEAKING";
    h.parle("r1", "it-1");
    h.feed({ type: "input_audio_buffer.speech_started", item_id: "u1" });
    await vi.advanceTimersByTimeAsync(BARGE_IN_SUSTAIN_MS + 20);
    expect(h.count("response.cancel")).toBe(1); // aucune dépendance à la transcription
  });
});

describe("faux bruit — une porte, une toux : Adam ne répond pas et ne se coupe pas", () => {
  it("un commit de bruit (« … ») est SUPPRIMÉ, aucun tour émis, aucune réponse fantôme qui parle", async () => {
    const h = harness();
    h.feed({ type: "input_audio_buffer.speech_started", item_id: "u-bruit" });
    h.feed({ type: "input_audio_buffer.speech_stopped", item_id: "u-bruit" });
    h.feed({ type: "response.created", response: { id: "r-fantome" } });
    h.feed({ type: "conversation.item.input_audio_transcription.completed", item_id: "u-bruit", transcript: "…" });
    expect(h.sent.find((s) => s.type === "conversation.item.delete")).toMatchObject({ item_id: "u-bruit" });
    h.feed({ type: "response.done", response: { id: "r-fantome", status: "cancelled" } });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(h.turns).toHaveLength(0);
  });
});

describe("interruption puis changement de sujet — pas de fuite de l'ancienne réponse", () => {
  it("couper Adam sur le sujet A, puis répondre sur le sujet B : le tour B ne contient pas A", async () => {
    const h = harness();
    // Sujet A : Adam parle, l'utilisateur coupe avec des mots.
    h.priv._state = "ASSISTANT_SPEAKING";
    h.parle("rA", "itA");
    h.feed({ type: "input_audio_buffer.speech_started", item_id: "uB" });
    h.feed({ type: "conversation.item.input_audio_transcription.delta", item_id: "uB", delta: "Non," });
    expect(h.count("response.cancel")).toBe(1);
    // La réponse A annulée émet encore quelques deltas : ils sont PÉRIMÉS.
    h.feed({ type: "response.output_audio_transcript.delta", response_id: "rA", delta: " suite du sujet A jamais entendue" });
    h.feed({ type: "response.done", response: { id: "rA", status: "cancelled" } });

    // Sujet B : nouvelle réponse, nouveau contenu.
    h.feed({ type: "conversation.item.input_audio_transcription.completed", item_id: "uB", transcript: "Non, parle-moi plutôt de la trésorerie." });
    h.feed({ type: "response.created", response: { id: "rB" } });
    h.feed({ type: "output_audio_buffer.started", response_id: "rB" });
    h.feed({ type: "response.output_audio_transcript.delta", response_id: "rB", delta: "La trésorerie est à quatre millions." });
    h.feed({ type: "response.output_audio_transcript.done", response_id: "rB", transcript: "La trésorerie est à quatre millions." });
    h.feed({ type: "response.done", response: { id: "rB", status: "completed" } });
    await h.flush();
    await vi.advanceTimersByTimeAsync(3_100); // la fenêtre de grâce livre les tours en attente

    // L'INVARIANT QUI COMPTE : le sujet B est bien restitué, ENTIER, et AUCUN morceau de la
    // réponse annulée A (les deltas périmés) n'a fui dans un tour — ni dans celui de B, ni ailleurs.
    const B = h.turns.find((t) => t.assistant === "La trésorerie est à quatre millions.");
    expect(B, "le tour du sujet B doit être restitué").toBeTruthy();
    expect(h.turns.some((t) => t.assistant.includes("sujet A"))).toBe(false);
  });
});

describe("plusieurs interruptions successives — chaque segment coupe, une seule fois", () => {
  it("deux prises de parole sur deux réponses → deux coupures, une par segment (debounce)", async () => {
    const h = harness();
    // 1re interruption.
    h.priv._state = "ASSISTANT_SPEAKING";
    h.parle("r1", "it1");
    h.feed({ type: "input_audio_buffer.speech_started", item_id: "u1" });
    h.feed({ type: "conversation.item.input_audio_transcription.delta", item_id: "u1", delta: "Stop" });
    // Le MÊME segment ne recoupe pas.
    h.feed({ type: "conversation.item.input_audio_transcription.delta", item_id: "u1", delta: " encore" });
    expect(h.count("response.cancel")).toBe(1);

    // Adam repart sur une nouvelle réponse, nouvelle interruption.
    h.feed({ type: "response.done", response: { id: "r1", status: "cancelled" } });
    h.priv._state = "ASSISTANT_SPEAKING";
    h.parle("r2", "it2");
    h.feed({ type: "input_audio_buffer.speech_started", item_id: "u2" });
    h.feed({ type: "conversation.item.input_audio_transcription.delta", item_id: "u2", delta: "Attends" });
    expect(h.count("response.cancel")).toBe(2);
    expect(h.metric("barge_in_confirmed")).toHaveLength(2);
  });
});

describe("Adam ne reste jamais muet après un tour valide", () => {
  it("un `response.create` perdu après une vraie question est relancé tout seul, puis restitué", async () => {
    const h = harness();
    h.feed({ type: "input_audio_buffer.speech_started", item_id: "u1" });
    h.feed({ type: "input_audio_buffer.speech_stopped", item_id: "u1" });
    await h.flush();
    const avant = h.count("response.create");
    // Aucun `response.created`, aucun son : le tour est muet.
    await vi.advanceTimersByTimeAsync(5_600);
    expect(h.metric("turn_watchdog_recovered").length).toBeGreaterThanOrEqual(1);
    expect(h.count("response.create")).toBeGreaterThan(avant);
  });
});
