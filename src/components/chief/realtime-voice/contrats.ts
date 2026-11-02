/**
 * COUCHE TRANSPORT DE L'APPEL VOCAL — les CONTRATS : l'interface `VoiceRealtimeProvider`, ses
 * rappels, le jeton de session, les événements lus sur le data channel, l'obligation de
 * restitution et la consommation cumulée (pure).
 */

export type VoiceCallState =
  | "IDLE" | "CONNECTING" | "LISTENING" | "USER_SPEAKING" | "THINKING"
  | "ASSISTANT_SPEAKING" | "RECONNECTING" | "ERROR" | "ENDED";

export interface VoiceSessionGrant {
  clientSecret: string;
  model: string;
  callUrl: string;
  voice: string;
  threadId: string | null;
}

export interface VoiceToolUi {
  reply?: string | null;
  proposals?: unknown[] | null;
  trace?: string[];
  sources?: { label: string; href: string }[];
}

export interface VoiceProviderCallbacks {
  onState: (state: VoiceCallState) => void;
  /** Transcription de l'UTILISATEUR (finale quand `final`). */
  onUserTranscript: (text: string, final: boolean) => void;
  /** Transcription de l'ASSISTANT — deltas pendant qu'il parle, puis texte final. */
  onAssistantTranscript: (text: string, final: boolean) => void;
  /** Un TOUR complet (parole utilisateur + réponse) — à afficher et à persister. */
  onTurnComplete: (turn: { user: string; assistant: string }) => void;
  /** Charge utile UI d'un outil (cartes d'action, sources) — à afficher pendant que la voix parle. */
  onToolUi: (ui: VoiceToolUi) => void;
  onError: (message: string, reasonCode?: string) => void;
  /** État de la connexion WebRTC — le composant décide de la reconnexion. */
  onConnectionChange?: (state: RTCPeerConnectionState) => void;
  /** Métriques (premier audio, interruptions, restitutions…) — à remonter au journal. */
  onMetric?: (
    name:
      | "first_audio_out" | "interruption" | "tool_call" | "tool_error"
      // Politique de barge-in CONFIRMÉ : signal possible → confirmé (latence en valeur) /
      // ignoré comme bruit — les DEUX métriques s'optimisent ensemble.
      | "possible_barge_in" | "barge_in_confirmed" | "false_barge_in_ignored"
      // Propriété de la réponse : obligation créée → prête → RESTITUÉE (latence en valeur) ;
      // et les chemins de rattrapage — complétion muette, watchdog, échec terminal.
      | "pending_turn_created" | "pending_turn_ready" | "pending_turn_delivered"
      | "silent_completion_detected" | "watchdog_recovered" | "delivery_failed"
      // Hygiène des événements : périmés ignorés, réponse fantôme annulée avant d'avoir parlé.
      | "stale_event_ignored" | "phantom_response_cancelled"
      // ── LA FRISE D'UN TOUR, horodatée ────────────────────────────────────────────────
      // Six bornes, dans l'ordre où elles tombent. Elles ne servent à rien isolées et
      // répondent ensemble à la seule question qui compte quand un appel « rame » : OÙ le
      // temps est-il passé ? « Adam est lent » n'est pas un diagnostic ; « 2,4 s entre la fin
      // de ma phrase et le premier son, dont 1,9 s dans l'outil » en est un.
      | "user_speech_ended" | "response_started" | "first_audio"
      | "tool_started" | "tool_completed" | "response_completed"
      // Le tour perdu — celui qui obligeait le PDG à dire « Alors ? ».
      | "turn_watchdog_recovered" | "turn_stuck_surfaced",
    value?: number,
  ) => void;
}

export interface VoiceRealtimeProvider {
  connect(): Promise<void>;
  disconnect(): void;
  /** Message TEXTE dans la session vocale (« l'utilisateur tape pendant l'appel »). */
  sendText(text: string): void;
  /**
   * CONTEXTE D'ÉCRAN : informe la session de ce que l'utilisateur consulte (route/fiche) —
   * SANS déclencher de réponse. « Explique-moi ça » se résout alors tout seul.
   */
  sendContext(text: string): void;
  /** Coupe la réponse en cours (bouton, ou ceinture-bretelles du barge-in). */
  interrupt(): void;
  setMuted(muted: boolean): void;
  readonly state: VoiceCallState;
  readonly threadId: string | null;
  /** Les totaux de consommation de la session (jetons texte/audio, cache) — pour le journal d'usage. */
  getUsage?(): VoiceUsageTotals;
}

export interface ProviderOptions {
  getGrant: () => Promise<VoiceSessionGrant>;
  callTool: (name: string, input: Record<string, unknown>) => Promise<{ output: string; ui?: VoiceToolUi | null }>;
  callbacks: VoiceProviderCallbacks;
  /**
   * REPLI DE PERSISTANCE : un résultat d'analyse que la voix ne peut plus restituer (session
   * terminée pendant le job, restitution en échec terminal) est remis au fil de conversation —
   * « pas perdu » est un invariant, pas un vœu.
   */
  persistOrphanResult?: (text: string) => void;
}

/** Un événement du data channel — on ne type que ce qu'on lit, tout le reste est ignoré. */
export interface RealtimeEvent {
  type: string;
  delta?: string;
  transcript?: string;
  text?: string;
  name?: string;
  call_id?: string;
  arguments?: string;
  /** Segment/élément porteur de l'événement — la clé de l'hygiène anti-périmé. */
  item_id?: string;
  /** Réponse porteuse d'un delta / d'un tampon audio — même hygiène. */
  response_id?: string;
  item?: { id?: string; type?: string };
  error?: { message?: string; code?: string };
  response?: {
    id?: string; status?: string;
    output?: { type: string; name?: string; call_id?: string; arguments?: string }[];
    /** La consommation de la réponse, telle que le fournisseur la rapporte sur `response.done`. */
    usage?: RealtimeUsage;
  };
}

/** Ce que `response.done` rapporte — texte et audio séparés, part en cache incluse. */
export interface RealtimeUsage {
  input_tokens?: number;
  output_tokens?: number;
  input_token_details?: { text_tokens?: number; audio_tokens?: number; cached_tokens?: number; cached_tokens_details?: { text_tokens?: number; audio_tokens?: number } };
  output_token_details?: { text_tokens?: number; audio_tokens?: number };
}

/**
 * LES TOTAUX D'UNE SESSION VOCALE — additionnés réponse après réponse, remis au journal à la
 * fermeture. Le coût d'un appel se calcule côté serveur à partir de ces six nombres : la voix
 * était la seule modalité dont personne ne savait le prix.
 */
export interface VoiceUsageTotals {
  responses: number;
  inputText: number;
  inputAudio: number;
  cachedText: number;
  cachedAudio: number;
  outputText: number;
  outputAudio: number;
}

export const usageVide = (): VoiceUsageTotals => ({ responses: 0, inputText: 0, inputAudio: 0, cachedText: 0, cachedAudio: 0, outputText: 0, outputAudio: 0 });

/** Additionne une réponse aux totaux — pur, tolérant aux champs absents. */
export function cumulerUsage(totaux: VoiceUsageTotals, u: RealtimeUsage | undefined): VoiceUsageTotals {
  if (!u) return totaux;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const inDet = u.input_token_details ?? {};
  const outDet = u.output_token_details ?? {};
  // Sans détail, tout est réputé TEXTE — une sous-estimation assumée (l'audio coûte plus) plutôt qu'une invention.
  const inputText = inDet.text_tokens != null || inDet.audio_tokens != null ? n(inDet.text_tokens) : n(u.input_tokens);
  const outputText = outDet.text_tokens != null || outDet.audio_tokens != null ? n(outDet.text_tokens) : n(u.output_tokens);
  return {
    responses: totaux.responses + 1,
    inputText: totaux.inputText + inputText,
    inputAudio: totaux.inputAudio + n(inDet.audio_tokens),
    cachedText: totaux.cachedText + n(inDet.cached_tokens_details?.text_tokens ?? (inDet.cached_tokens_details ? 0 : inDet.cached_tokens)),
    cachedAudio: totaux.cachedAudio + n(inDet.cached_tokens_details?.audio_tokens),
    outputText: totaux.outputText + outputText,
    outputAudio: totaux.outputAudio + n(outDet.audio_tokens),
  };
}

/** L'obligation de restitution d'un résultat d'outil — le « propriétaire de la réponse ». */
export interface PendingDelivery {
  callId: string;
  tool: string;
  /** WAITING_TOOL : l'outil tourne · READY : résultat posé, restitution due · DELIVERING : une réponse identifiée le porte. */
  state: "WAITING_TOOL" | "READY" | "DELIVERING";
  readyAt: number;
  attempts: number;
  /** La réponse qui porte la restitution (exactly-once : une seule à la fois). */
  deliveryResponseId: string | null;
  /** Texte de repli pour la persistance si la voix ne peut plus restituer. */
  resultText: string;
  /** Le rappel « restituer maintenant » n'est envoyé qu'UNE fois (pas de boucle de nudges). */
  nudged: boolean;
}
