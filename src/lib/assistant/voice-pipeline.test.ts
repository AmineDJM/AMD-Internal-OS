import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenAIGptRealtime21Provider, type VoiceToolUi } from "@/components/chief/realtime-voice";
import { BARGE_IN_SUSTAIN_MS } from "@/lib/assistant/voice-tuning";

/**
 * GOLDEN RÉGRESSION — LES DEUX PANNES BLOQUANTES DE L'APPEL DE PRODUCTION, rejouées sur le
 * VRAI pipeline d'événements du provider (handleEvent), canal stubbé, timers simulés :
 *
 *   BUG 1 — « Je vais analyser… » puis SILENCE INFINI : le résultat existait, la restitution
 *   n'avait pas de propriétaire. Ici : chaque résultat crée une OBLIGATION qui ne s'éteint
 *   qu'une fois la réponse réellement PARLÉE — collision VAD replanifiée, create perdu
 *   rattrapé par le watchdog, complétion muette relancée, résultat pendant la parole
 *   utilisateur livré en fin de tour, session terminée → persisté. « Alors ? » ne révèle
 *   plus rien de caché : il n'y a plus rien de caché.
 *
 *   BUG 2 — INTERRUPTIONS FANTÔMES « (intervention vocale) » : pendant que le haut-parleur
 *   joue, la durée seule ne confirme RIEN (l'écho est un signal soutenu parfait) ; les
 *   événements d'une réponse annulée sont PÉRIMÉS ; un segment = une confirmation max ; un
 *   commit de bruit en pièce silencieuse est supprimé et sa réponse auto annulée muette.
 */

type Sent = { type: string } & Record<string, unknown>;

function harness() {
  const sent: Sent[] = [];
  const metrics: { name: string; value?: number }[] = [];
  const errors: string[] = [];
  const turns: { user: string; assistant: string }[] = [];
  const orphans: string[] = [];
  const assistantFinals: string[] = [];
  const toolResolvers: ((r: { output: string; ui?: VoiceToolUi | null }) => void)[] = [];
  const toolRejecters: ((e: Error) => void)[] = [];

  const p = new OpenAIGptRealtime21Provider({
    getGrant: async () => { throw new Error("connect() hors sujet ici"); },
    callTool: () => new Promise((res, rej) => { toolResolvers.push(res); toolRejecters.push(rej); }),
    callbacks: {
      onState: () => undefined,
      onUserTranscript: () => undefined,
      onAssistantTranscript: (text, final) => { if (final) assistantFinals.push(text); },
      onTurnComplete: (t) => turns.push(t),
      onToolUi: () => undefined,
      onError: (_m, code) => errors.push(code ?? "?"),
      onMetric: (name, value) => metrics.push({ name, value }),
    },
    persistOrphanResult: (t) => orphans.push(t),
  });
  // Le harnais force l'état « connecté » sans WebRTC : le canal est un stub qui capture tout.
  const priv = p as unknown as {
    alive: boolean; dc: unknown; _state: string;
    handleEvent(raw: string): void;
  };
  priv.alive = true;
  priv.dc = { readyState: "open", send: (s: string) => sent.push(JSON.parse(s) as Sent), close: () => undefined };
  priv._state = "LISTENING";

  const feed = (ev: Record<string, unknown>) => priv.handleEvent(JSON.stringify(ev));
  const count = (type: string) => sent.filter((s) => s.type === type).length;
  const metric = (name: string) => metrics.filter((m) => m.name === name);
  const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
  return { p, priv, sent, metrics, errors, turns, orphans, assistantFinals, toolResolvers, toolRejecters, feed, count, metric, flush };
}

/** Le décor « l'assistant parle » : réponse active r-X, item audible i-X, haut-parleur ACTIF. */
function speakingScene(h: ReturnType<typeof harness>, rid = "r-parle", itemId = "i-parle") {
  h.feed({ type: "response.created", response: { id: rid } });
  h.feed({ type: "response.output_item.added", response_id: rid, item: { id: itemId, type: "message" } });
  h.feed({ type: "output_audio_buffer.started", response_id: rid });
  h.feed({ type: "response.output_audio_transcript.delta", response_id: rid, delta: "Je détaille le dossier…" });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval", "Date", "performance"] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("BUG 1 — propriété de la réponse : une analyse terminée est TOUJOURS restituée", () => {
  it("chemin nominal : outil résolu → function_call_output + response.create + RESTITUÉ (exactly-once)", async () => {
    const h = harness();
    // La réponse d'accusé (« Je regarde. ») porte le function call, puis se termine SANS
    // déclencher le détecteur de complétion muette (l'outil tourne encore).
    h.feed({ type: "response.created", response: { id: "r1" } });
    h.feed({ type: "response.function_call_arguments.done", name: "delegate_to_chief_of_staff", call_id: "c1", arguments: "{}" });
    expect(h.metric("pending_turn_created")).toHaveLength(1);
    h.feed({ type: "response.done", response: { id: "r1", status: "completed" } });
    expect(h.metric("silent_completion_detected")).toHaveLength(0);

    // Le job se termine : l'output est posé ET la conversation est RÉVEILLÉE.
    h.toolResolvers[0]({ output: JSON.stringify({ reponse: "Le dossier bloque au comité." }), ui: { reply: "Analyse détaillée : le dossier bloque au comité depuis 12 jours." } });
    await h.flush();
    const output = h.sent.find((s) => s.type === "conversation.item.create" && (s.item as { type?: string })?.type === "function_call_output");
    expect(output).toBeTruthy();
    expect(h.count("response.create")).toBe(1);
    expect(h.metric("pending_turn_ready")).toHaveLength(1);

    // La réponse de restitution parle → l'obligation s'éteint, la latence job→voix se mesure.
    h.feed({ type: "response.created", response: { id: "r2" } });
    h.feed({ type: "response.output_audio_transcript.delta", response_id: "r2", delta: "Voici le résultat : le dossier bloque au comité." });
    h.feed({ type: "response.done", response: { id: "r2", status: "completed" } });
    expect(h.metric("pending_turn_delivered")).toHaveLength(1);
    // EXACTLY-ONCE : un seul response.create pour cette restitution, pas de doublon ensuite.
    expect(h.count("response.create")).toBe(1);

    // Le tour restitué se nomme honnêtement — jamais « (intervention vocale) ».
    await vi.advanceTimersByTimeAsync(3_100);
    expect(h.turns).toHaveLength(1);
    expect(h.turns[0].user).toBe("(restitution d'une analyse terminée)");
  });

  it("collision avec la réponse AUTO de la VAD : l'intention n'est jamais perdue — la réponse auto restitue", async () => {
    const h = harness();
    h.feed({ type: "response.created", response: { id: "r1" } });
    h.feed({ type: "response.function_call_arguments.done", name: "time_travel", call_id: "c1", arguments: "{}" });
    h.feed({ type: "response.done", response: { id: "r1", status: "completed" } });
    h.toolResolvers[0]({ output: "État au 1er juin : SOUMIS." });
    await h.flush();
    expect(h.count("response.create")).toBe(1);

    // Notre create heurte une réponse auto en cours de création côté serveur → erreur codée.
    h.feed({ type: "error", error: { code: "conversation_already_has_active_response", message: "conflit" } });
    expect(h.errors).toHaveLength(0); // pas une erreur utilisateur : une replanification

    // La réponse auto arrive : elle ABSORBE l'attente et PORTE l'obligation.
    h.feed({ type: "response.created", response: { id: "r-auto" } });
    h.feed({ type: "response.output_audio_transcript.delta", response_id: "r-auto", delta: "État au 1er juin : soumis." });
    h.feed({ type: "response.done", response: { id: "r-auto", status: "completed" } });
    expect(h.metric("pending_turn_delivered")).toHaveLength(1);
    // Et RIEN de surnuméraire après elle (pas de réponse en trop).
    expect(h.count("response.create")).toBe(1);
  });

  it("create PERDU : le watchdog déterministe rattrape — jamais de silence infini, jamais « Alors ? »", async () => {
    const h = harness();
    h.feed({ type: "response.created", response: { id: "r1" } });
    h.feed({ type: "response.function_call_arguments.done", name: "time_travel", call_id: "c1", arguments: "{}" });
    h.feed({ type: "response.done", response: { id: "r1", status: "completed" } });
    h.toolResolvers[0]({ output: "Résultat prêt." });
    await h.flush();
    expect(h.count("response.create")).toBe(1);

    // AUCUN response.created ne revient (create perdu / rejeté silencieusement).
    await vi.advanceTimersByTimeAsync(2_500);
    expect(h.count("response.create")).toBeGreaterThanOrEqual(2); // le watchdog a relancé
    expect(h.metric("watchdog_recovered").length).toBeGreaterThanOrEqual(1);

    // La relance aboutit : restitué, l'obligation s'éteint, le watchdog n'a plus rien à faire.
    h.feed({ type: "response.created", response: { id: "r2" } });
    h.feed({ type: "response.output_audio_transcript.delta", response_id: "r2", delta: "Résultat : prêt." });
    h.feed({ type: "response.done", response: { id: "r2", status: "completed" } });
    expect(h.metric("pending_turn_delivered")).toHaveLength(1);
    const creates = h.count("response.create");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.count("response.create")).toBe(creates); // plus AUCUNE relance après restitution
  });

  it("RESULT_READY pendant que l'utilisateur parle : jamais par-dessus — livré à la fin de SON tour", async () => {
    const h = harness();
    h.feed({ type: "response.created", response: { id: "r1" } });
    h.feed({ type: "response.function_call_arguments.done", name: "time_travel", call_id: "c1", arguments: "{}" });
    h.feed({ type: "response.done", response: { id: "r1", status: "completed" } });

    // L'utilisateur prend la parole (état non-occupé → USER_SPEAKING), et LÀ le job finit.
    h.feed({ type: "input_audio_buffer.speech_started", item_id: "u1" });
    h.toolResolvers[0]({ output: "Résultat pendant sa phrase." });
    await h.flush();
    // L'output est posé (le contexte est prêt) mais AUCUN response.create ne part.
    expect(h.sent.some((s) => s.type === "conversation.item.create" && (s.item as { type?: string })?.type === "function_call_output")).toBe(true);
    expect(h.count("response.create")).toBe(0);

    // Fin du tour utilisateur → la réponse AUTO de la VAD arrive et restitue tout.
    h.feed({ type: "input_audio_buffer.speech_stopped" });
    h.feed({ type: "response.created", response: { id: "r-auto" } });
    h.feed({ type: "response.output_audio_transcript.delta", response_id: "r-auto", delta: "Réponse et résultat." });
    h.feed({ type: "response.done", response: { id: "r-auto", status: "completed" } });
    expect(h.metric("pending_turn_delivered")).toHaveLength(1);
    expect(h.count("response.create")).toBe(0); // la VAD a suffi — zéro création parasite
  });

  it("LE PIÈGE DE L'ACCUSÉ MUET : une réponse « terminée » sans un mot n'éteint RIEN — rappel + relance", async () => {
    const h = harness();
    h.feed({ type: "response.created", response: { id: "r1" } });
    h.feed({ type: "response.function_call_arguments.done", name: "time_travel", call_id: "c1", arguments: "{}" });
    h.feed({ type: "response.done", response: { id: "r1", status: "completed" } });
    h.toolResolvers[0]({ output: "Résultat X." });
    await h.flush();

    // La réponse de restitution se « termine » SANS transcript ni audio : complétion muette.
    h.feed({ type: "response.created", response: { id: "r2" } });
    h.feed({ type: "response.done", response: { id: "r2", status: "completed" } });
    expect(h.metric("silent_completion_detected")).toHaveLength(1);
    // Le rappel explicite est posé (une seule fois) et une nouvelle réponse est demandée.
    const nudges = h.sent.filter((s) => s.type === "conversation.item.create" && JSON.stringify(s).includes("RESTITUTION VOCALE"));
    expect(nudges).toHaveLength(1);
    expect(h.count("response.create")).toBe(2);

    // La relance PARLE : restitué.
    h.feed({ type: "response.created", response: { id: "r3" } });
    h.feed({ type: "response.output_audio_transcript.delta", response_id: "r3", delta: "Résultat X." });
    h.feed({ type: "response.done", response: { id: "r3", status: "completed" } });
    expect(h.metric("pending_turn_delivered")).toHaveLength(1);
  });

  it("SESSION TERMINÉE pendant le job : le résultat n'est PAS perdu — persisté dans le fil", async () => {
    const h = harness();
    h.feed({ type: "response.created", response: { id: "r1" } });
    h.feed({ type: "response.function_call_arguments.done", name: "delegate_to_chief_of_staff", call_id: "c1", arguments: "{}" });
    h.feed({ type: "response.done", response: { id: "r1", status: "completed" } });

    h.p.disconnect(); // raccroché pendant l'analyse
    h.toolResolvers[0]({ output: JSON.stringify({ reponse: "Synthèse courte." }), ui: { reply: "Analyse complète arrivée après l'appel." } });
    await h.flush();
    expect(h.orphans).toHaveLength(1);
    expect(h.orphans[0]).toContain("Analyse complète arrivée après l'appel.");
    // Et rien n'est envoyé dans un canal mort.
    expect(h.sent.some((s) => s.type === "conversation.item.create" && (s.item as { type?: string })?.type === "function_call_output")).toBe(false);
  });

  it("l'ÉCHEC d'un outil se DIT — il suit le même chemin de restitution que le succès", async () => {
    const h = harness();
    h.feed({ type: "response.created", response: { id: "r1" } });
    h.feed({ type: "response.function_call_arguments.done", name: "time_travel", call_id: "c1", arguments: "{}" });
    h.feed({ type: "response.done", response: { id: "r1", status: "completed" } });
    h.toolRejecters[0](new Error("réseau"));
    await h.flush();
    const failOutput = h.sent.find((s) => s.type === "conversation.item.create" && JSON.stringify(s).includes("échoué"));
    expect(failOutput).toBeTruthy();
    expect(h.count("response.create")).toBe(1); // l'échec est PARLÉ, jamais silencieux
  });

  it("échec TERMINAL de restitution : dit à voix d'erreur ET persisté au fil — jamais évaporé", async () => {
    const h = harness();
    h.feed({ type: "response.created", response: { id: "r1" } });
    h.feed({ type: "response.function_call_arguments.done", name: "time_travel", call_id: "c1", arguments: "{}" });
    h.feed({ type: "response.done", response: { id: "r1", status: "completed" } });
    h.toolResolvers[0]({ output: "Résultat que la voix n'arrive pas à dire." });
    await h.flush();

    // Aucune réponse ne démarre JAMAIS : relances plafonnées, puis abandon honnête.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.errors).toContain("DELIVERY_FAILED");
    expect(h.orphans.some((o) => o.includes("n'arrive pas à dire"))).toBe(true);
    expect(h.metric("delivery_failed")).toHaveLength(1);
    const creates = h.count("response.create");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.count("response.create")).toBe(creates); // le watchdog s'est tu (plus d'obligation)
  });
});

describe("BUG 2 — barge-in natif : la parole soutenue coupe vite, le bruit bref ne coupe pas, les périmés ne polluent pas", () => {
  it("NATIF : parole soutenue (≥180 ms) SANS mots pendant que le haut-parleur joue → COUPE (cancel + clear + truncate)", async () => {
    // LE VIRAGE. L'ancienne politique renvoyait « CONTINUE » ici (durée seule = écho présumé),
    // au prix d'une interruption qui traînait jusqu'à l'arrivée des mots — « je parle et Adam
    // continue de parler ». On fait désormais confiance à l'annulation d'écho du navigateur +
    // semantic_vad : 180 ms de parole soutenue = une vraie prise de parole, on coupe.
    const h = harness();
    speakingScene(h, "r-parle", "i-parle");
    h.feed({ type: "input_audio_buffer.speech_started", item_id: "u1" });
    expect(h.metric("possible_barge_in")).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(BARGE_IN_SUSTAIN_MS + 20);
    expect(h.count("response.cancel")).toBe(1);
    expect(h.count("output_audio_buffer.clear")).toBe(1);
    expect(h.sent.find((s) => s.type === "conversation.item.truncate")).toMatchObject({ item_id: "i-parle" });
    expect(h.metric("barge_in_confirmed")).toHaveLength(1);
    expect(h.priv._state).toBe("USER_SPEAKING");
  });

  it("FAUX BARGE-IN : une salve brève (< 140 ms) sans mots, terminée → la réponse CONTINUE", async () => {
    const h = harness();
    speakingScene(h);
    h.feed({ type: "input_audio_buffer.speech_started", item_id: "u-blip" });
    await vi.advanceTimersByTimeAsync(50); // un clic / un choc bref
    h.feed({ type: "input_audio_buffer.speech_stopped" });
    expect(h.count("response.cancel")).toBe(0); // rien coupé
    expect(h.metric("false_barge_in_ignored")).toHaveLength(1);
    expect(h.priv._state).toBe("ASSISTANT_SPEAKING"); // l'état n'a pas bougé
  });

  it("VRAIE interruption : des MOTS transcrits coupent vite — cancel + clear + truncate, une seule fois", async () => {
    const h = harness();
    speakingScene(h, "r-parle", "i-parle");
    h.feed({ type: "input_audio_buffer.speech_started", item_id: "u2" });
    h.feed({ type: "conversation.item.input_audio_transcription.delta", item_id: "u2", delta: "Attends" });

    expect(h.count("response.cancel")).toBe(1);
    expect(h.count("output_audio_buffer.clear")).toBe(1);
    const truncate = h.sent.find((s) => s.type === "conversation.item.truncate");
    expect(truncate).toMatchObject({ item_id: "i-parle" });
    expect(h.metric("barge_in_confirmed")).toHaveLength(1);
    expect(h.priv._state).toBe("USER_SPEAKING");

    // DEBOUNCE : le même segment ne produit jamais une deuxième coupure.
    h.feed({ type: "conversation.item.input_audio_transcription.delta", item_id: "u2", delta: "encore" });
    expect(h.count("response.cancel")).toBe(1);
  });

  it("haut-parleur MUET (réflexion) : la parole soutenue confirme même sans transcription", async () => {
    const h = harness();
    h.feed({ type: "response.created", response: { id: "r-pense" } }); // THINKING, aucun audio
    h.feed({ type: "input_audio_buffer.speech_started", item_id: "u3" });
    await vi.advanceTimersByTimeAsync(450); // ≥ BARGE_IN_SUSTAIN_MS, aucune source d'écho
    expect(h.count("response.cancel")).toBe(1);
  });

  it("ÉVÉNEMENTS PÉRIMÉS : les deltas et l'audio d'une réponse ANNULÉE sont ignorés — zéro pollution", async () => {
    const h = harness();
    speakingScene(h, "r-annulee", "i-x");
    h.feed({ type: "input_audio_buffer.speech_started", item_id: "u4" });
    h.feed({ type: "conversation.item.input_audio_transcription.delta", item_id: "u4", delta: "Stop" });
    expect(h.count("response.cancel")).toBe(1);
    const finalsAvant = h.assistantFinals.length;

    // La réponse annulée continue d'émettre quelques instants : TOUT est ignoré.
    h.feed({ type: "response.output_audio_transcript.delta", response_id: "r-annulee", delta: " suite jamais entendue" });
    h.feed({ type: "response.output_audio_transcript.done", response_id: "r-annulee", transcript: "Texte complet jamais joué." });
    h.feed({ type: "output_audio_buffer.started", response_id: "r-annulee" });
    expect(h.priv._state).toBe("USER_SPEAKING"); // l'audio fantôme n'a pas rebasculé l'état
    expect(h.assistantFinals.length).toBe(finalsAvant); // le transcript final périmé n'a rien réécrit
    expect(h.metric("stale_event_ignored").length).toBeGreaterThanOrEqual(3);
    // Même après le done de la réponse annulée, son audio résiduel reste périmé.
    h.feed({ type: "response.done", response: { id: "r-annulee", status: "cancelled" } });
    h.feed({ type: "output_audio_buffer.started", response_id: "r-annulee" });
    expect(h.priv._state).not.toBe("ASSISTANT_SPEAKING");
  });

  it("un delta d'un ANCIEN segment ne confirme jamais la fenêtre d'un nouveau", async () => {
    const h = harness();
    speakingScene(h, "r-2", "i-2");
    h.feed({ type: "input_audio_buffer.speech_started", item_id: "u-nouveau" });
    // Delta TARDIF du segment précédent (u-ancien) : ignoré pour la confirmation.
    h.feed({ type: "conversation.item.input_audio_transcription.delta", item_id: "u-ancien", delta: "phrase d'avant" });
    expect(h.count("response.cancel")).toBe(0);
    expect(h.metric("stale_event_ignored")).toHaveLength(1);
  });

  it("CONFIRMATION TARDIVE : fenêtre fermée « bruit », puis les mots arrivent pendant la MÊME réponse → coupure", async () => {
    const h = harness();
    speakingScene(h, "r-lent", "i-lent");
    h.feed({ type: "input_audio_buffer.speech_started", item_id: "u5" });
    h.feed({ type: "input_audio_buffer.speech_stopped" }); // sans mots + haut-parleur actif → ignoré
    expect(h.count("response.cancel")).toBe(0);
    expect(h.metric("false_barge_in_ignored")).toHaveLength(1);

    // La transcription finale arrive EN RETARD avec de vrais mots, la réponse parle encore.
    h.feed({ type: "conversation.item.input_audio_transcription.completed", item_id: "u5", transcript: "Attends deux secondes" });
    expect(h.count("response.cancel")).toBe(1); // c'était une vraie interruption — exécutée
  });

  it("PIÈCE SILENCIEUSE : un commit de bruit est SUPPRIMÉ et sa réponse auto annulée muette — zéro « (intervention vocale) »", async () => {
    const h = harness();
    // Bruit détecté par la VAD alors que rien ne se passe.
    h.feed({ type: "input_audio_buffer.speech_started", item_id: "u-bruit" });
    h.feed({ type: "input_audio_buffer.speech_stopped" });
    // La VAD committe et AUTO-crée une réponse au bruit.
    h.feed({ type: "response.created", response: { id: "r-fantome" } });
    // La transcription révèle le bruit (« … ») AVANT que la réponse n'ait joué le moindre son.
    h.feed({ type: "conversation.item.input_audio_transcription.completed", item_id: "u-bruit", transcript: "…" });

    const del = h.sent.find((s) => s.type === "conversation.item.delete");
    expect(del).toMatchObject({ item_id: "u-bruit" }); // le bruit ne pollue pas le contexte
    expect(h.count("response.cancel")).toBe(1); // l'assistant ne dira pas « Oui ? » à une porte
    expect(h.metric("phantom_response_cancelled")).toHaveLength(1);
    h.feed({ type: "response.done", response: { id: "r-fantome", status: "cancelled" } });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(h.turns).toHaveLength(0); // AUCUN tour fantôme n'est émis
  });

  it("le bruit n'annule JAMAIS une réponse qui a commencé à parler ou qui porte une restitution", async () => {
    const h = harness();
    // Une restitution est en cours de route (obligation prête) : le bruit ne la tue pas.
    h.feed({ type: "response.created", response: { id: "r1" } });
    h.feed({ type: "response.function_call_arguments.done", name: "time_travel", call_id: "c1", arguments: "{}" });
    h.feed({ type: "response.done", response: { id: "r1", status: "completed" } });
    h.toolResolvers[0]({ output: "Résultat." });
    await h.flush();
    h.feed({ type: "response.created", response: { id: "r2" } }); // la restitution démarre
    h.feed({ type: "conversation.item.input_audio_transcription.completed", item_id: "u-bruit2", transcript: "((" });
    expect(h.count("response.cancel")).toBe(0); // la restitution passe avant l'hygiène du bruit
  });
});
