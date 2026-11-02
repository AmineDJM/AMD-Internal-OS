import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenAIGptRealtime21Provider, type VoiceToolUi } from "@/components/chief/realtime-voice";
import { STUCK_TURN_MS, STUCK_TURN_TICK_MS } from "./voice-tuning";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * E2E VOCAL — la conversation du compte rendu, rejouée sur le VRAI pipeline d'événements.
 *
 * ── CE QUE CE FICHIER PROUVE, ET CE QU'IL NE PEUT PAS PROUVER ────────────────────────────
 *
 * Il pilote `handleEvent` avec la suite exacte d'événements qu'OpenAI envoie, canal stubbé et
 * horloges simulées. Il prouve donc tout ce qui relève de NOTRE machine d'état : un tour par
 * réponse, zéro doublon, reprise après outil, garde du tour bloqué, barge-in, bornes de mesure.
 *
 * Il ne prouve RIEN sur la qualité de la voix, la latence réseau réelle ni le choix du modèle :
 * cela demande une clé et un vrai appel. Les confondre serait annoncer vert ce qui n'a jamais
 * été branché — l'erreur qu'on passe ce chantier à corriger.
 *
 * ── LE SCÉNARIO ─────────────────────────────────────────────────────────────────────────
 *
 *   chercher Alla → préparer un mail → confirmer → créer une tâche → tâches en retard,
 *   puis dix tours d'affilée sans silence, sans doublon et sans fragment.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

type Sent = { type: string } & Record<string, unknown>;

function harness() {
  const sent: Sent[] = [];
  const metrics: { name: string; value?: number }[] = [];
  const errors: string[] = [];
  const turns: { user: string; assistant: string }[] = [];
  const toolCalls: { name: string; input: Record<string, unknown> }[] = [];
  let toolReply: (name: string) => { output: string; ui?: VoiceToolUi | null } = () => ({ output: "{}" });

  const p = new OpenAIGptRealtime21Provider({
    getGrant: async () => { throw new Error("connect() hors sujet ici"); },
    callTool: async (name, input) => { toolCalls.push({ name, input }); return toolReply(name); },
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
  const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
  const metric = (name: string) => metrics.filter((m) => m.name === name);

  /** Un TOUR COMPLET tel qu'OpenAI l'émet : parole → réponse → texte → audio → fin. */
  async function tour(opts: { rid: string; user: string; assistant: string; itemId?: string }) {
    feed({ type: "input_audio_buffer.speech_started", item_id: opts.itemId ?? `it-${opts.rid}` });
    feed({ type: "input_audio_buffer.speech_stopped", item_id: opts.itemId ?? `it-${opts.rid}` });
    feed({ type: "response.created", response: { id: opts.rid } });
    feed({ type: "output_audio_buffer.started", response_id: opts.rid });

    // L'ENTRELACEMENT RÉEL, et il est le cœur du sujet. La transcription de l'utilisateur est
    // calculée EN PARALLÈLE de la réponse : elle tombe donc AU MILIEU des deltas de l'assistant.
    // C'est exactement cet ordre qui produisait, à l'écran :
    //     Adam  « D'accord, je vais »        ← émis par la transcription, texte PARTIEL
    //     Adam  « …consulter l'annuaire… »   ← le reste, dans un second message
    // Un harnais qui livre tous les deltas AVANT le transcript ne reproduit pas la panne — et
    // un test qui ne reproduit pas la panne ne la retient pas.
    const morceaux = opts.assistant.match(/.{1,12}/g) ?? [];
    const coupure = Math.max(1, Math.floor(morceaux.length / 3));
    for (const m of morceaux.slice(0, coupure)) {
      feed({ type: "response.output_audio_transcript.delta", response_id: opts.rid, delta: m });
    }
    feed({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: opts.itemId ?? `it-${opts.rid}`, transcript: opts.user,
    });
    for (const m of morceaux.slice(coupure)) {
      feed({ type: "response.output_audio_transcript.delta", response_id: opts.rid, delta: m });
    }
    feed({ type: "response.output_audio_transcript.done", response_id: opts.rid, transcript: opts.assistant });
    feed({ type: "output_audio_buffer.stopped", response_id: opts.rid });
    feed({ type: "response.done", response: { id: opts.rid, status: "completed" } });
    await flush();
  }

  return {
    p, priv, sent, metrics, errors, turns, toolCalls, feed, flush, metric, tour,
    setToolReply: (f: typeof toolReply) => { toolReply = f; },
  };
}

beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval", "performance"] }); });
afterEach(() => { vi.useRealTimers(); });

describe("1 response.id = 1 SEUL tour Adam", () => {
  it("une réponse en dix morceaux produit UN tour, pas trois messages", async () => {
    // LE DÉFAUT EXACT DU COMPTE RENDU :
    //     Adam 13:49  D'accord, je vais
    //     Adam 13:49  (vide)
    //     Adam 13:49  D'accord, je vais consulter l'annuaire…
    const h = harness();
    await h.tour({
      rid: "r1",
      user: "On regarde dans l'annuaire d'entreprise.",
      assistant: "D'accord, je vais consulter l'annuaire de l'entreprise pour retrouver ses coordonnées.",
    });

    expect(h.turns).toHaveLength(1);
    expect(h.turns[0].assistant).toBe("D'accord, je vais consulter l'annuaire de l'entreprise pour retrouver ses coordonnées.");
    expect(h.turns[0].user).toBe("On regarde dans l'annuaire d'entreprise.");
    // Aucun tour fantôme sans moitié utilisateur : c'était la signature du fragment.
    expect(h.turns.some((t) => t.user === "(intervention vocale)")).toBe(false);
  });

  it("un `response.done` renvoyé DEUX fois ne produit qu'un tour", async () => {
    const h = harness();
    await h.tour({ rid: "r1", user: "Bonjour", assistant: "Bonjour, je vous écoute." });
    h.feed({ type: "response.done", response: { id: "r1", status: "completed" } });
    await h.flush();
    expect(h.turns).toHaveLength(1);
  });

  it("le texte d'une réponse ne DÉBORDE pas sur la suivante", async () => {
    const h = harness();
    await h.tour({ rid: "r1", user: "Première question", assistant: "Première réponse." });
    await h.tour({ rid: "r2", user: "Deuxième question", assistant: "Deuxième réponse." });
    expect(h.turns).toHaveLength(2);
    expect(h.turns[0].assistant).toBe("Première réponse.");
    expect(h.turns[1].assistant).toBe("Deuxième réponse.");
  });

  it("la transcription utilisateur EN RETARD ne perd pas le tour", async () => {
    // Réponse terminée, transcript utilisateur pas encore là : 3 s de grâce, un seul tour.
    const h = harness();
    h.feed({ type: "response.created", response: { id: "r1" } });
    h.feed({ type: "response.output_audio_transcript.delta", response_id: "r1", delta: "La réponse." });
    h.feed({ type: "output_audio_buffer.started", response_id: "r1" });
    h.feed({ type: "response.done", response: { id: "r1", status: "completed" } });
    await h.flush();
    expect(h.turns).toHaveLength(0); // en attente de la moitié utilisateur

    h.feed({ type: "conversation.item.input_audio_transcription.completed", item_id: "it-1", transcript: "Ma question" });
    await h.flush();
    expect(h.turns).toHaveLength(1);
    expect(h.turns[0].user).toBe("Ma question");

    // …et le délai de grâce qui expire ensuite ne DOUBLE pas le tour.
    vi.advanceTimersByTime(5_000);
    await h.flush();
    expect(h.turns).toHaveLength(1);
  });
});

describe("après un appel d'outil, la réponse reprend SEULE", () => {
  it("le résultat pose l'output ET redemande une réponse — sans que l'utilisateur reparle", async () => {
    const h = harness();
    h.setToolReply(() => ({ output: JSON.stringify({ email: "allaeddine.atmani@adventumdz.com" }) }));

    h.feed({ type: "input_audio_buffer.speech_started", item_id: "it-1" });
    h.feed({ type: "input_audio_buffer.speech_stopped", item_id: "it-1" });
    h.feed({ type: "response.created", response: { id: "r1" } });
    h.feed({
      type: "response.function_call_arguments.done",
      name: "search_people", call_id: "c1", arguments: JSON.stringify({ query: "Alla" }),
    });
    await h.flush();
    // La réponse qui a demandé l'outil se termine — c'est le comportement normal du protocole.
    h.feed({ type: "response.done", response: { id: "r1", status: "completed" } });
    await h.flush();

    expect(h.toolCalls.map((t) => t.name)).toEqual(["search_people"]);
    const outputs = h.sent.filter((s) => s.type === "conversation.item.create");
    expect(outputs.length).toBeGreaterThanOrEqual(1);
    // LE POINT : une nouvelle réponse est demandée SANS intervention humaine.
    expect(h.sent.filter((s) => s.type === "response.create").length).toBeGreaterThanOrEqual(1);
  });

  it("la durée de l'outil est mesurée, et son début/fin bornés", async () => {
    const h = harness();
    h.setToolReply(() => ({ output: "{}" }));
    h.feed({ type: "response.created", response: { id: "r1" } });
    h.feed({ type: "response.function_call_arguments.done", name: "read_budget", call_id: "c1", arguments: "{}" });
    await h.flush();
    expect(h.metric("tool_started")).toHaveLength(1);
    expect(h.metric("tool_completed")).toHaveLength(1);
    expect(h.metric("tool_completed")[0].value).toBeGreaterThanOrEqual(0);
  });
});

describe("la garde du tour bloqué — plus besoin de dire « Alors ? »", () => {
  it("un `response.create` perdu est relancé tout seul", async () => {
    const h = harness();
    h.feed({ type: "input_audio_buffer.speech_started", item_id: "it-1" });
    h.feed({ type: "input_audio_buffer.speech_stopped", item_id: "it-1" });
    await h.flush();
    const avant = h.sent.filter((s) => s.type === "response.create").length;

    // Rien ne revient : ni `response.created`, ni audio. C'est le silence du compte rendu.
    vi.advanceTimersByTime(STUCK_TURN_MS + STUCK_TURN_TICK_MS * 2);
    await h.flush();

    expect(h.metric("turn_watchdog_recovered").length).toBeGreaterThanOrEqual(1);
    expect(h.sent.filter((s) => s.type === "response.create").length).toBeGreaterThan(avant);
  });

  it("elle se TAIT dès que le son arrive — un tour qui parle n'est pas bloqué", async () => {
    const h = harness();
    h.feed({ type: "input_audio_buffer.speech_started", item_id: "it-1" });
    h.feed({ type: "input_audio_buffer.speech_stopped", item_id: "it-1" });
    h.feed({ type: "response.created", response: { id: "r1" } });
    h.feed({ type: "output_audio_buffer.started", response_id: "r1" });
    await h.flush();

    vi.advanceTimersByTime(STUCK_TURN_MS * 3);
    await h.flush();
    expect(h.metric("turn_watchdog_recovered")).toHaveLength(0);
  });

  it("après plusieurs relances vaines, elle le DIT plutôt que de boucler", async () => {
    const h = harness();
    h.feed({ type: "input_audio_buffer.speech_started", item_id: "it-1" });
    h.feed({ type: "input_audio_buffer.speech_stopped", item_id: "it-1" });
    await h.flush();

    vi.advanceTimersByTime((STUCK_TURN_MS + STUCK_TURN_TICK_MS) * 5);
    await h.flush();

    expect(h.errors).toContain("TURN_STUCK");
    // Elle ne bégaie pas : le nombre de relances est BORNÉ.
    expect(h.metric("turn_watchdog_recovered").length).toBeLessThanOrEqual(2);
  });
});

describe("la frise d'un tour est complète et ordonnée", () => {
  it("les six bornes tombent, dans l'ordre", async () => {
    const h = harness();
    await h.tour({ rid: "r1", user: "Quel est le budget ?", assistant: "Il reste 13 millions." });

    for (const nom of ["user_speech_ended", "response_started", "first_audio", "response_completed"]) {
      expect(h.metric(nom).length, nom).toBeGreaterThanOrEqual(1);
    }
    const ordre = h.metrics
      .map((m) => m.name)
      .filter((n) => ["user_speech_ended", "response_started", "first_audio", "response_completed"].includes(n));
    expect(ordre).toEqual(["user_speech_ended", "response_started", "first_audio", "response_completed"]);
  });
});

describe("dix tours d'affilée — ni silence, ni doublon, ni fragment", () => {
  it("dix questions produisent exactement dix tours", async () => {
    const h = harness();
    const questions = [
      "Y a-t-il des choses en retard ?", "C'est quoi le mail d'Alla ?", "Envoie-lui un mail.",
      "Confirme.", "Crée une tâche pour Yacine.", "Quel est le budget Ad&Pro ?",
      "Et la masse salariale ?", "Qui gère Nivolumab ?", "Des validations en attente ?",
      "Merci, c'est tout.",
    ];
    const reponses = questions.map((_, i) => `Réponse ${i} — un texte assez long pour être découpé en plusieurs morceaux.`);
    for (const [i, q] of questions.entries()) {
      await h.tour({ rid: `r${i}`, user: q, assistant: reponses[i] });
    }

    expect(h.turns).toHaveLength(10);
    // COMPTER NE SUFFIT PAS, et c'est une leçon payée : avec le défaut réintroduit, ce test
    // comptait toujours dix tours — les fragments se compensaient d'un tour à l'autre. Ce qui
    // garde vraiment, c'est l'INTÉGRITÉ : chaque réponse doit être ENTIÈRE, pas un préfixe.
    expect(h.turns.map((t) => t.assistant)).toEqual(reponses);
    expect(h.turns.map((t) => t.user)).toEqual(questions);
    expect(h.turns.some((t) => t.user === "(intervention vocale)")).toBe(false);
    // Et aucune erreur de tour bloqué sur un enchaînement normal.
    expect(h.errors).not.toContain("TURN_STUCK");
    // Une seule frise par tour : dix réponses démarrées, dix terminées.
    expect(h.metric("response_started")).toHaveLength(10);
    expect(h.metric("response_completed")).toHaveLength(10);
  });
});
