"use client";

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  OpenAIGptRealtime21Provider,
  type VoiceCallState, type VoiceToolUi, type VoiceSessionGrant,
} from "@/app/(app)/assistant/realtime-voice";
import { cooldownFor, cooldownMessage, rateLimitFrom } from "@/lib/assistant/voice-cooldown";
import { CallScreen } from "@/app/(app)/assistant/voice-mode";
import { sansBloquer } from "@/lib/journal";

/**
 * L'APPEL GLOBAL — « je suis au téléphone avec mon Chief of Staff », partout dans l'ERP.
 *
 * L'appel vit AU NIVEAU DU LAYOUT, pas dans la page /chief-of-staff : ouvrir une fiche, un
 * document ou un module ne raccroche pas. Le provider porte TOUTE la logique de session
 * (connexion, timer, transcript, cartes, persistance des tours, résumé d'appel) ; l'écran
 * d'appel (CallScreen) n'est que la peau. Le chat du Chief of Staff se BRANCHE dessus
 * (bridge) quand il est monté : les tours et les cartes d'action s'y affichent — et quand il
 * ne l'est pas, tout est bufferisé et persisté côté serveur : rien ne se perd.
 *
 * CONTEXTE D'ÉCRAN ≠ espionnage : seule la ROUTE (et la référence d'entité qui s'y lit) est
 * transmise à la session — jamais une capture, jamais des données. « Explique-moi ça » se
 * résout, et les permissions restent celles des outils côté serveur.
 *
 * CAPABLE ≠ EXÉCUTÉ : le provider ne déclenche RIEN de lui-même — pas de briefing d'accueil,
 * pas d'analyse spontanée. Il transporte la conversation ; l'intention vient du PDG.
 */

export interface CallBridge {
  onTurn: (user: string, assistant: string) => void;
  onToolUi: (ui: VoiceToolUi) => void;
  onThreadId: (tid: string) => void;
}

export interface CallCard { label: string; href: string }

interface CallContextValue {
  enabled: boolean;
  /** true dès CONNECTING jusqu'au raccrochage. */
  active: boolean;
  status: VoiceCallState | "IDLE";
  minimized: boolean;
  muted: boolean;
  /** Secondes écoulées depuis la CONNEXION réelle (pas depuis le clic). */
  elapsed: number;
  threadId: string | null;
  start: (opts?: { threadId?: string | null; screenContext?: string | null }) => void;
  end: () => void;
  toggleMute: () => void;
  setMinimized: (b: boolean) => void;
  /** Envoie un texte DANS l'appel ; false si aucun appel actif (le chat repasse au SSE). */
  sendText: (text: string) => boolean;
  setBridge: (bridge: CallBridge | null) => void;
}

const CallContext = React.createContext<CallContextValue | null>(null);

export function useCall(): CallContextValue {
  const ctx = React.useContext(CallContext);
  if (ctx) return ctx;
  // Hors provider (ou voix non configurée) : un objet inerte — les pages n'ont pas à se garder.
  return {
    enabled: false, active: false, status: "IDLE", minimized: false, muted: false, elapsed: 0,
    threadId: null, start: () => undefined, end: () => undefined, toggleMute: () => undefined,
    setMinimized: () => undefined, sendText: () => false, setBridge: () => undefined,
  };
}

interface TranscriptLine { role: "user" | "assistant"; text: string; final: boolean }

const fmtDuration = (s: number): string =>
  s >= 3600
    ? `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`
    : `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

export function CallProvider({ enabled, children }: { enabled: boolean; children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();

  const [status, setStatus] = React.useState<VoiceCallState | "IDLE">("IDLE");
  const [minimized, setMinimized] = React.useState(false);
  const [muted, setMuted] = React.useState(false);
  const [elapsed, setElapsed] = React.useState(0);
  const [error, setError] = React.useState<string | null>(null);
  const [lines, setLines] = React.useState<TranscriptLine[]>([]);
  const [cards, setCards] = React.useState<CallCard[]>([]);
  const [threadId, setThreadId] = React.useState<string | null>(null);

  const providerRef = React.useRef<OpenAIGptRealtime21Provider | null>(null);
  const statusRef = React.useRef<VoiceCallState | "IDLE">("IDLE");
  const threadRef = React.useRef<string | null>(null);
  const bridgeRef = React.useRef<CallBridge | null>(null);
  const uiBufferRef = React.useRef<VoiceToolUi[]>([]);
  const reconnectsRef = React.useRef(0);
  /** Horodatage jusqu'auquel toute tentative est refusée localement (quota atteint). */
  const rateLimitedUntilRef = React.useRef(0);
  const timerRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  const connectedAtRef = React.useRef<number | null>(null);
  const lastContextRef = React.useRef<string | null>(null);
  const metricsRef = React.useRef({
    startedAt: 0, connectMs: 0, firstAudioMs: 0, toolCalls: 0, toolErrors: 0, interruptions: 0, turns: 0,
    // Politique de barge-in confirmé : les DEUX métriques se lisent ensemble (peu de fausses
    // coupures ET une vraie interruption rapide).
    falseBargeInsIgnored: 0, bargeInLatencyMs: 0,
    // Propriété de la réponse : obligations prêtes vs RESTITUÉES (le SLO de fiabilité), les
    // rattrapages (complétion muette, watchdog) et l'hygiène anti-fantôme.
    deliveriesReady: 0, deliveriesDone: 0, deliveryLatencyMs: 0, silentCompletions: 0,
    watchdogRecoveries: 0, deliveryFailures: 0, staleEventsIgnored: 0, phantomCancels: 0,
  });
  // Matière du RÉSUMÉ D'APPEL : uniquement ce qui s'est réellement produit.
  const summaryRef = React.useRef({ topics: [] as string[], cardLabels: [] as string[], proposals: 0, toolCalls: 0 });

  const setStatusBoth = React.useCallback((s: VoiceCallState | "IDLE") => {
    statusRef.current = s;
    setStatus(s);
  }, []);

  const logEvent = React.useCallback((event: string, extra: Record<string, unknown> = {}) => {
    void fetch("/api/assistant/voice/log", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ event, ...extra }),
    }).catch(sansBloquer("call-provider.CallProvider.fetch"));
  }, []);

  /**
   * ENTRE EN REFROIDISSEMENT — la seule réponse correcte à « ralentis ».
   *
   * On coupe la session en cours (inutile de garder un appel qui n'a jamais abouti), on note
   * jusqu'à quand toute nouvelle tentative est refusée LOCALEMENT, et on dit au PDG une durée
   * plutôt qu'un code. La reconnexion automatique lit la même borne : elle ne repartira pas.
   */
  const enterCooldown = React.useCallback((refus: { retryAfterMs: number | null; status: number; detail: string }) => {
    const wait = cooldownFor(refus.retryAfterMs);
    rateLimitedUntilRef.current = Date.now() + wait;
    providerRef.current?.disconnect();
    setStatusBoth("ERROR");
    setError(cooldownMessage(wait));
    logEvent("voice_session_rate_limited", {
      reasonCode: `SDP_${refus.status}`,
      detail: refus.detail || undefined,
      // Ce que le serveur a demandé, et ce qu'on applique — les deux, pour pouvoir les comparer.
      retryAfterMs: refus.retryAfterMs,
      cooldownMs: wait,
    });
  }, [logEvent, setStatusBoth]);

  const upsertLine = React.useCallback((role: "user" | "assistant", text: string, final: boolean) => {
    if (!text.trim()) return;
    setLines((prev) => {
      const next = [...prev];
      const last = next[next.length - 1];
      if (last && last.role === role && !last.final) next[next.length - 1] = { role, text, final };
      else next.push({ role, text, final });
      return next.slice(-40);
    });
  }, []);

  const forwardUi = React.useCallback((ui: VoiceToolUi) => {
    // Les CARTES LIVE de l'appel : chaque source/lien devient une carte cliquable dans
    // l'écran d'appel — la voix résume, l'écran montre.
    if (ui.sources?.length) {
      setCards((prev) => {
        const merged = [...prev];
        for (const s of ui.sources ?? []) {
          if (!merged.some((c) => c.href === s.href)) merged.unshift({ label: s.label, href: s.href });
        }
        return merged.slice(0, 8);
      });
      for (const s of ui.sources) {
        if (!summaryRef.current.cardLabels.includes(s.label)) summaryRef.current.cardLabels.push(s.label);
      }
    }
    if (ui.proposals?.length) summaryRef.current.proposals += ui.proposals.length;
    // Le chat affiche cartes d'action et analyses détaillées ; s'il n'est pas monté (on
    // navigue ailleurs pendant l'appel), on BUFFERISE — il drainera à son retour.
    if (bridgeRef.current) bridgeRef.current.onToolUi(ui);
    else uiBufferRef.current.push(ui);
  }, []);

  const buildProvider = React.useCallback((screenContext: string | null) => {
    const m = metricsRef.current;
    return new OpenAIGptRealtime21Provider({
      getGrant: async (): Promise<VoiceSessionGrant> => {
        const res = await fetch("/api/assistant/voice/session", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ threadId: threadRef.current, screenContext }),
        });
        const data = (await res.json().catch(sansBloquer("call-provider.getGrant.json", {}))) as Partial<VoiceSessionGrant> & { error?: string };
        if (!res.ok || !data.clientSecret) throw new Error(data.error ?? "Le mode vocal temps réel est momentanément indisponible.");
        if (data.threadId) {
          threadRef.current = data.threadId;
          setThreadId(data.threadId);
          bridgeRef.current?.onThreadId(data.threadId);
        }
        return data as VoiceSessionGrant;
      },
      callTool: async (name, input) => {
        summaryRef.current.toolCalls += 1;
        const res = await fetch("/api/assistant/voice/tool", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ name, input, threadId: threadRef.current }),
        });
        if (!res.ok) throw new Error("tool");
        return (await res.json()) as { output: string; ui?: VoiceToolUi | null };
      },
      // « PAS PERDU » : un résultat que la voix ne peut plus restituer (raccroché pendant
      // l'analyse, restitution en échec terminal) rejoint le FIL de conversation — et le chat
      // s'il est monté. keepalive : la requête survit à une navigation.
      persistOrphanResult: (text) => {
        const user = "(analyse terminée après l'appel)";
        bridgeRef.current?.onTurn(user, text);
        void fetch("/api/assistant/voice/turn", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ threadId: threadRef.current, user, assistant: text }),
          keepalive: true,
        }).catch(sansBloquer("call-provider.persistOrphanResult.fetch"));
      },
      callbacks: {
        onState: (s) => {
          if (statusRef.current === "IDLE") return; // raccroché entre-temps
          setStatusBoth(s);
          // Le TIMER démarre à la CONNEXION RÉELLE — pas au clic.
          if (s === "LISTENING" && connectedAtRef.current === null) {
            connectedAtRef.current = Date.now();
            timerRef.current = setInterval(() => {
              if (connectedAtRef.current) setElapsed(Math.floor((Date.now() - connectedAtRef.current) / 1000));
            }, 1000);
          }
        },
        onUserTranscript: (text, final) => upsertLine("user", text, final),
        onAssistantTranscript: (text, final) => upsertLine("assistant", text, final),
        onTurnComplete: ({ user, assistant }) => {
          const m2 = metricsRef.current;
          m2.turns += 1;
          if (user && user !== "(intervention vocale)") summaryRef.current.topics.push(user);
          if (bridgeRef.current) bridgeRef.current.onTurn(user, assistant);
          void fetch("/api/assistant/voice/turn", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ threadId: threadRef.current, user, assistant }),
          }).then(async (r) => {
            const d = (await r.json().catch(sansBloquer("call-provider.onTurnComplete.json", {}))) as { threadId?: string | null };
            if (d.threadId && d.threadId !== threadRef.current) {
              threadRef.current = d.threadId;
              setThreadId(d.threadId);
              bridgeRef.current?.onThreadId(d.threadId);
            }
          }).catch(sansBloquer("call-provider.onTurnComplete.fetch"));
        },
        onToolUi: forwardUi,
        onError: (message) => { if (statusRef.current !== "IDLE") setError(message); },
        onMetric: (name, value) => {
          if (name === "first_audio_out" && !m.firstAudioMs) {
            m.firstAudioMs = Math.round(performance.now() - m.startedAt);
            logEvent("voice_first_audio_out", { firstAudioMs: m.firstAudioMs });
          }
          if (name === "interruption") m.interruptions += 1;
          if (name === "tool_call") m.toolCalls += 1;
          if (name === "tool_error") m.toolErrors += 1;
          // Barge-in confirmé : bruit ignoré (la réponse a continué) vs vraie coupure (latence).
          if (name === "false_barge_in_ignored") {
            m.falseBargeInsIgnored += 1;
            logEvent("voice_false_barge_in_ignored", { count: m.falseBargeInsIgnored });
          }
          if (name === "barge_in_confirmed") {
            m.bargeInLatencyMs = Math.round(value ?? 0);
            logEvent("voice_barge_in_confirmed", { latencyMs: m.bargeInLatencyMs });
          }
          // Propriété de la réponse : prêtes vs RESTITUÉES = le SLO « aucune analyse muette ».
          if (name === "pending_turn_ready") m.deliveriesReady += 1;
          if (name === "pending_turn_delivered") {
            m.deliveriesDone += 1;
            m.deliveryLatencyMs = Math.round(value ?? 0);
            logEvent("voice_pending_turn_delivered", { latencyMs: m.deliveryLatencyMs });
          }
          if (name === "silent_completion_detected") {
            m.silentCompletions += 1;
            logEvent("voice_silent_completion", { count: m.silentCompletions });
          }
          if (name === "watchdog_recovered") {
            m.watchdogRecoveries += 1;
            logEvent("voice_watchdog_recovered", { count: m.watchdogRecoveries });
          }
          if (name === "delivery_failed") {
            m.deliveryFailures += 1;
            logEvent("voice_delivery_failed", { count: m.deliveryFailures });
          }
          // Hygiène anti-fantôme : événements périmés ignorés (comptés, journalisés à la fin),
          // réponse auto au bruit annulée avant d'avoir parlé.
          if (name === "stale_event_ignored") m.staleEventsIgnored += 1;
          if (name === "phantom_response_cancelled") {
            m.phantomCancels += 1;
            logEvent("voice_phantom_response_cancelled", { count: m.phantomCancels });
          }
        },
        onConnectionChange: (cs) => {
          if (statusRef.current === "IDLE") return;
          // QUOTA ATTEINT → ON NE RECONNECTE PAS. Reconnecter sur un « ralentis » est ce qui a
          // transformé un 429 passager en série de 429 : chaque tentative reforge un secret
          // (une session de plus au compteur) puis se fait refuser au même endroit.
          if (rateLimitedUntilRef.current > Date.now()) return;
          if ((cs === "disconnected" || cs === "failed") && reconnectsRef.current < 2) {
            reconnectsRef.current += 1;
            setStatusBoth("RECONNECTING");
            logEvent("voice_reconnect", { detail: cs });
            providerRef.current?.disconnect();
            // ATTENTE CROISSANTE avant de réessayer (1 s puis 3 s). Se ruer sur un service qui
            // vient de lâcher, c'est lui retirer la seconde dont il a besoin pour se remettre.
            const wait = reconnectsRef.current === 1 ? 1_000 : 3_000;
            window.setTimeout(() => {
              if (statusRef.current === "IDLE" || rateLimitedUntilRef.current > Date.now()) return;
              const p = buildProvider(null);
              providerRef.current = p;
              p.connect().catch((err: unknown) => {
                if (statusRef.current === "IDLE") return;
                const refus = rateLimitFrom(err);
                if (refus) { enterCooldown(refus); return; }
                setStatusBoth("ERROR");
                setError("La connexion vocale n'a pas pu être rétablie.");
              });
            }, wait);
          } else if (cs === "failed") {
            setStatusBoth("ERROR");
            setError("La connexion vocale est perdue.");
          }
        },
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forwardUi, logEvent, setStatusBoth, upsertLine, enterCooldown]);

  const start = React.useCallback((opts: { threadId?: string | null; screenContext?: string | null } = {}) => {
    if (!enabled || statusRef.current !== "IDLE") return;
    // LE REFROIDISSEMENT PASSE AVANT TOUT. Sans lui, le PDG qui reclique sur le téléphone
    // rallume une tentative — et chaque tentative reforge un secret puis se fait refuser, ce
    // qui entretient exactement le quota qu'on attend de voir retomber. On lui dit combien de
    // temps attendre plutôt que de le laisser marteler un bouton qui ne peut pas marcher.
    const reste = rateLimitedUntilRef.current - Date.now();
    if (reste > 0) {
      setStatusBoth("ERROR");
      setError(cooldownMessage(reste));
      return;
    }
    threadRef.current = opts.threadId ?? threadRef.current;
    setError(null); setLines([]); setCards([]); setElapsed(0); setMuted(false); setMinimized(false);
    reconnectsRef.current = 0;
    connectedAtRef.current = null;
    lastContextRef.current = pathname;
    metricsRef.current = {
      startedAt: performance.now(), connectMs: 0, firstAudioMs: 0, toolCalls: 0, toolErrors: 0,
      interruptions: 0, turns: 0, falseBargeInsIgnored: 0, bargeInLatencyMs: 0,
      deliveriesReady: 0, deliveriesDone: 0, deliveryLatencyMs: 0, silentCompletions: 0,
      watchdogRecoveries: 0, deliveryFailures: 0, staleEventsIgnored: 0, phantomCancels: 0,
    };
    summaryRef.current = { topics: [], cardLabels: [], proposals: 0, toolCalls: 0 };
    setStatusBoth("CONNECTING");

    const p = buildProvider(opts.screenContext ?? null);
    providerRef.current = p;
    p.connect()
      .then(() => {
        metricsRef.current.connectMs = Math.round(performance.now() - metricsRef.current.startedAt);
        logEvent("voice_session_connected", { connectMs: metricsRef.current.connectMs });
      })
      .catch((err: unknown) => {
        if (statusRef.current === "IDLE") return;
        const refus = rateLimitFrom(err);
        if (refus) { enterCooldown(refus); return; }

        setStatusBoth("ERROR");
        const msg = err instanceof Error ? err.message : "";
        setError(
          msg === "MIC_UNSUPPORTED" ? "Le micro nécessite une connexion sécurisée (HTTPS) et un navigateur récent."
          : msg.startsWith("SDP_") ? "Le mode vocal temps réel est momentanément indisponible (connexion refusée)."
          : /NotAllowedError|Permission/i.test(String(err)) ? "Micro refusé — autorisez-le dans le navigateur, ou utilisez la dictée."
          : msg || "Impossible de démarrer la conversation vocale.",
        );
        // LE DÉTAIL EST REMONTÉ, désormais. Les journaux de production affichaient
        // `detail: undefined` sur CHAQUE refus : on ne pouvait pas distinguer un plafond de
        // sessions simultanées d'un quota par minute, alors que la réponse le disait. Ici on
        // est déjà hors du cas « quota » (traité plus haut) : ce qui reste est un 4xx/5xx dont
        // le corps explique généralement la cause en une phrase.
        const detail = (err as { detail?: unknown })?.detail;
        logEvent("voice_session_error", {
          reasonCode: msg || "CONNECT_FAILED",
          ...(typeof detail === "string" && detail ? { detail } : {}),
        });
      });
  }, [enabled, pathname, buildProvider, logEvent, setStatusBoth, enterCooldown]);

  const end = React.useCallback(() => {
    if (statusRef.current === "IDLE") return;
    const m = metricsRef.current;
    const s = summaryRef.current;
    const durationS = connectedAtRef.current ? Math.floor((Date.now() - connectedAtRef.current) / 1000) : 0;

    // LE RÉSUMÉ D'APPEL — uniquement ce qui s'est produit, aucune action créée par le résumé.
    if (durationS > 5 || s.topics.length > 0) {
      const summary = [
        `Résumé d'appel — ${fmtDuration(durationS)}`,
        s.topics.length ? `Sujets : ${s.topics.slice(0, 6).map((t) => t.replace(/\s+/g, " ").slice(0, 70)).join(" · ")}` : "Sujets : (aucun tour complet)",
        s.cardLabels.length ? `Cartes et documents affichés : ${s.cardLabels.slice(0, 8).join(", ")}` : null,
        `Outils consultés : ${s.toolCalls}${s.proposals ? ` · Actions proposées : ${s.proposals} (rien d'exécuté sans confirmation)` : " · Aucune action proposée"}`,
      ].filter(Boolean).join("\n");
      bridgeRef.current?.onTurn("(fin de l'appel)", summary);
      void fetch("/api/assistant/voice/turn", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ threadId: threadRef.current, user: "(fin de l'appel)", assistant: summary }),
      }).catch(sansBloquer("call-provider.CallProvider.fetch"));
    }

    logEvent("voice_session_closed", {
      // LA CONSOMMATION DE LA SESSION (texte/audio, cache) — le serveur en fait le coût.
      usage: providerRef.current?.getUsage?.() ?? null,
      sessionMs: durationS * 1000 || Math.round(performance.now() - m.startedAt),
      connectMs: m.connectMs || null, firstAudioMs: m.firstAudioMs || null,
      toolCalls: m.toolCalls, toolErrors: m.toolErrors, interruptions: m.interruptions, turns: m.turns,
      falseBargeInsIgnored: m.falseBargeInsIgnored, bargeInLatencyMs: m.bargeInLatencyMs,
      // Les DEUX SLO de fiabilité se lisent ici : restitutions prêtes vs faites (BUG 1) et
      // fausses coupures/fantômes vs vraies (BUG 2).
      deliveriesReady: m.deliveriesReady, deliveriesDone: m.deliveriesDone,
      deliveryLatencyMs: m.deliveryLatencyMs || null, silentCompletions: m.silentCompletions,
      watchdogRecoveries: m.watchdogRecoveries, deliveryFailures: m.deliveryFailures,
      staleEventsIgnored: m.staleEventsIgnored, phantomCancels: m.phantomCancels,
    });

    providerRef.current?.disconnect();
    providerRef.current = null;
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    connectedAtRef.current = null;
    setStatusBoth("IDLE");
    setMinimized(false);
  }, [logEvent, setStatusBoth]);

  const toggleMute = React.useCallback(() => {
    setMuted((prev) => {
      providerRef.current?.setMuted(!prev);
      return !prev;
    });
  }, []);

  const sendText = React.useCallback((text: string): boolean => {
    const p = providerRef.current;
    const s = statusRef.current;
    const ready = s === "LISTENING" || s === "USER_SPEAKING" || s === "THINKING" || s === "ASSISTANT_SPEAKING";
    if (!p || !ready) return false;
    p.sendText(text);
    return true;
  }, []);

  const setBridge = React.useCallback((bridge: CallBridge | null) => {
    bridgeRef.current = bridge;
    if (bridge && uiBufferRef.current.length) {
      // Le chat revient : il rattrape les cartes arrivées pendant qu'on naviguait ailleurs.
      for (const ui of uiBufferRef.current) bridge.onToolUi(ui);
      uiBufferRef.current = [];
    }
  }, []);

  // CONTEXTE D'ÉCRAN : la ROUTE courante (rien d'autre) est signalée à la session — throttlé,
  // seulement quand elle change, jamais de capture. « Explique-moi ça » = la page ouverte.
  React.useEffect(() => {
    if (statusRef.current === "IDLE" || statusRef.current === "CONNECTING" || statusRef.current === "ERROR") return;
    if (!pathname || pathname === lastContextRef.current) return;
    lastContextRef.current = pathname;
    providerRef.current?.sendContext(
      `[CONTEXTE ÉCRAN] L'utilisateur consulte maintenant la page ${pathname} de l'ERP. « ça », « ce dossier », « cette fiche » se réfèrent à cette page, sauf indication contraire.`,
    );
  }, [pathname]);

  // Échap RÉDUIT l'appel (jamais un raccrochage accidentel — raccrocher est un geste explicite).
  React.useEffect(() => {
    if (status === "IDLE" || minimized) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMinimized(true); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [status, minimized]);

  // Démontage du layout (déconnexion) : raccrocher proprement.
  React.useEffect(() => () => { providerRef.current?.disconnect(); if (timerRef.current) clearInterval(timerRef.current); }, []);

  const openCard = React.useCallback((href: string) => {
    // Ouvrir une carte NE raccroche pas : l'appel se réduit et la navigation continue.
    setMinimized(true);
    router.push(href);
  }, [router]);

  const value = React.useMemo<CallContextValue>(() => ({
    enabled, active: status !== "IDLE", status, minimized, muted, elapsed, threadId,
    start, end, toggleMute, setMinimized, sendText, setBridge,
  }), [enabled, status, minimized, muted, elapsed, threadId, start, end, toggleMute, sendText, setBridge]);

  return (
    <CallContext.Provider value={value}>
      {children}
      {status !== "IDLE" && (
        <CallScreen
          status={status as VoiceCallState}
          elapsed={elapsed}
          muted={muted}
          minimized={minimized}
          error={error}
          lines={lines}
          cards={cards}
          onMute={toggleMute}
          onMinimize={() => setMinimized(true)}
          onRestore={() => setMinimized(false)}
          onEnd={end}
          onSendText={(t) => { void sendText(t); }}
          onOpenCard={openCard}
        />
      )}
    </CallContext.Provider>
  );
}
