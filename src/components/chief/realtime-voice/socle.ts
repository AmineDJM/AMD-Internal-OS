/**
 * COUCHE TRANSPORT DE L'APPEL VOCAL — la classe de base du fournisseur (voir son commentaire).
 */
import { deliveryWatchdogAction, deliveryFallbackText, stuckTurnAction, STUCK_TURN_TICK_MS, DELIVERY_WATCHDOG_TICK_MS, DELIVERY_WATCHDOG_GRACE_MS } from "@/lib/assistant/voice-tuning";
import { type ProviderOptions, type VoiceCallState, type PendingDelivery, type VoiceUsageTotals, usageVide } from "./contrats";

/**
 * LE SOCLE DU TRANSPORT VOCAL — l'état d'un appel et tout ce qui ne lit PAS le data channel :
 * la propriété de la réponse (obligations de restitution, watchdog, tour bloqué), l'émission des
 * tours, le barge-in confirmé, et les gestes publics (texte, contexte, interruption, micro, fin).
 * `OpenAIGptRealtime21Provider` en hérite et y ajoute la connexion WebRTC et la lecture des
 * événements. Membres `protected` : ils étaient `private` dans la classe d'un seul tenant.
 */
export abstract class SocleAppelRealtime {
  protected opts: ProviderOptions;
  protected pc: RTCPeerConnection | null = null;
  protected dc: RTCDataChannel | null = null;
  protected mic: MediaStream | null = null;
  protected audioEl: HTMLAudioElement | null = null;
  protected _state: VoiceCallState = "IDLE";
  protected _threadId: string | null = null;
  protected alive = false;
  protected muted = false;

  // ── UN `response.id` = UN SEUL TOUR ADAM ──────────────────────────────────────────────
  //
  // LA PANNE, telle qu'elle s'affichait au PDG :
  //
  //     Adam 13:49  D'accord, je vais
  //     Adam 13:49  (vide)
  //     Adam 13:49  D'accord, je vais consulter l'annuaire de l'entreprise…
  //
  // Trois messages pour UNE réponse. La cause tenait en une ligne : le tour était émis depuis
  // l'événement de TRANSCRIPTION UTILISATEUR (`…transcription.completed`), c'est-à-dire au
  // milieu des deltas de l'assistant. Il partait donc avec un texte PARTIEL, remettait
  // `assistantText` à zéro, et la suite des deltas repartait dans un second tour — dont la
  // moitié utilisateur, déjà consommée, devenait « (intervention vocale) ».
  //
  // Le tour appartient désormais à la RÉPONSE, et à elle seule : ouvert par `response.created`,
  // fermé UNE fois par `response.done`. `emittedTurns` interdit structurellement le doublon,
  // quel que soit l'ordre d'arrivée des événements.
  protected userText = "";
  protected assistantText = "";
  /** La réponse qui POSSÈDE le texte en cours d'accumulation. */
  protected turnResponseId: string | null = null;
  /** Les réponses dont le tour est DÉJÀ parti — le verrou anti-doublon. */
  protected emittedTurns = new Set<string>();
  /** Un tour clos qui attend encore sa moitié utilisateur (transcription en retard). */
  protected awaitingUserHalf: { responseId: string; assistant: string; isDelivery: boolean } | null = null;
  protected turnTimer: ReturnType<typeof setTimeout> | null = null;
  protected firstAudioAt: number | null = null;
  /** Le tour en cours est une RESTITUTION spontanée (résultat d'analyse) — pas une intervention. */
  protected turnIsDelivery = false;

  // ── LA GARDE DU TOUR BLOQUÉ ───────────────────────────────────────────────────────────
  // Le watchdog de RESTITUTION ne s'arme que lorsqu'un résultat d'outil attend. Un tour perdu
  // SANS outil — le « Alors ? » du compte rendu — n'était couvert par rien.
  protected stuckTimer: ReturnType<typeof setInterval> | null = null;
  /** Le tour attend-il quelque chose ? Un BOOLÉEN explicite — pas un horodatage détourné :
   *  `awaitingSince > 0` marchait par accident (l'horloge n'est jamais à zéro en vrai) et
   *  rendait la garde intestable, donc invérifiable. Un drapeau qui se lit se teste. */
  protected awaiting = false;
  protected awaitingSince = 0;
  protected stuckAttempts = 0;

  // ── PROPRIÉTÉ DE LA RÉPONSE ──
  // La réponse active est identifiée (response.created → response.done), jamais devinée : les
  // réponses AUTO-créées par la VAD serveur passent par les mêmes événements, donc le même
  // suivi. `responseCreatePending` couvre la fenêtre « create envoyé, created pas encore vu ».
  protected activeResponseId: string | null = null;
  protected activeResponseSpoke = false;
  protected responseCreatePending = false;
  protected responseCreateSentAt = 0;
  /** Une réponse est due dès que l'active se termine (résultat arrivé pendant qu'elle parlait). */
  protected pendingResponseCreate = false;
  protected deliveries = new Map<string, PendingDelivery>();
  protected watchdogTimer: ReturnType<typeof setInterval> | null = null;
  /** Réponses annulées dont les événements résiduels doivent être IGNORÉS. */
  protected cancelledResponseIds = new Set<string>();
  /** La consommation cumulée de la session — lue à la fermeture, jamais estimée. */
  protected usageTotaux: VoiceUsageTotals = usageVide();
  getUsage(): VoiceUsageTotals { return { ...this.usageTotaux }; }

  // ── BARGE-IN CONFIRMÉ ──
  // Un début de signal pendant que l'assistant parle n'interrompt RIEN — il ouvre une fenêtre
  // d'évaluation liée au SEGMENT (`item_id`) : mots transcrits ? durée ? haut-parleur actif ?
  protected bargeWindow: { itemId: string | null; at: number } | null = null;
  protected bargeInTimer: ReturnType<typeof setTimeout> | null = null;
  /** Segments déjà confirmés — UNE interruption par segment de parole (debounce). */
  protected confirmedItemIds = new Set<string>();
  /** Segments ignorés pendant une réponse : la transcription TARDIVE avec mots peut encore
   *  les requalifier en vraie interruption si la MÊME réponse parle toujours. */
  protected ignoredWindows = new Map<string, string | null>();
  // Synchronisation du contexte serveur au barge-in : l'item assistant en cours et le début
  // de son audio — pour `conversation.item.truncate` (ne pas considérer « entendu » ce qui
  // n'a jamais été joué).
  protected currentItemId: string | null = null;
  protected audioStartedAt: number | null = null;

  constructor(opts: ProviderOptions) { this.opts = opts; }

  get state(): VoiceCallState { return this._state; }
  get threadId(): string | null { return this._threadId; }

  protected setState(s: VoiceCallState): void {
    if (!this.alive && s !== "ENDED" && s !== "ERROR") return;
    this._state = s;
    this.opts.callbacks.onState(s);
  }

  protected send(event: Record<string, unknown>): void {
    if (this.dc?.readyState === "open") {
      try { this.dc.send(JSON.stringify(event)); } catch { /* canal en cours de fermeture */ }
    }
  }

  /** Un événement de CONTENU appartient-il à une réponse annulée ou remplacée ?
   *  Les réponses annulées restent marquées APRÈS leur response.done : leurs événements de
   *  tampon audio traînent encore quelques instants derrière. */
  protected isStaleResponseEvent(responseId: string | undefined): boolean {
    if (!responseId) return false; // pas d'étiquette : on reste permissif (anciens noms d'événements)
    if (this.cancelledResponseIds.has(responseId)) return true;
    if (this.activeResponseId === null) return true; // aucune réponse en cours : contenu forcément périmé
    return responseId !== this.activeResponseId;
  }

  /** Marque une réponse annulée — borné (les plus anciennes sortent, l'oubli est sans risque). */
  protected rememberCancelled(responseId: string): void {
    this.cancelledResponseIds.add(responseId);
    if (this.cancelledResponseIds.size > 8) {
      const first = this.cancelledResponseIds.values().next().value;
      if (first !== undefined) this.cancelledResponseIds.delete(first);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PROPRIÉTÉ DE LA RÉPONSE — le cycle de vie d'une obligation de restitution.
  // ─────────────────────────────────────────────────────────────────────────

  /** Le résultat d'un outil est là : poser l'output, marquer PRÊT, RÉVEILLER la conversation. */
  protected completeDelivery(callId: string, output: string, uiReply: string | null): void {
    const d = this.deliveries.get(callId);
    const resultText = deliveryFallbackText(output, uiReply);
    if (!this.alive || this.dc?.readyState !== "open") {
      // SESSION TERMINÉE PENDANT LE JOB : le résultat n'est pas perdu — il rejoint le fil.
      if (d) this.deliveries.delete(callId);
      if (resultText) this.opts.persistOrphanResult?.(resultText);
      return;
    }
    this.send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: callId, output } });
    if (d) {
      d.state = "READY";
      d.readyAt = performance.now();
      d.resultText = resultText;
      this.opts.callbacks.onMetric?.("pending_turn_ready");
    }
    this.requestResponse();
    this.startWatchdog();
  }

  /** Fin d'une réponse : les obligations qu'elle portait sont soit ÉTEINTES, soit replanifiées. */
  protected settleDeliveries(responseId: string, status: string, spoke: boolean): void {
    const carried = [...this.deliveries.values()].filter((d) => d.state === "DELIVERING" && d.deliveryResponseId === responseId);
    if (!carried.length) return;
    if (status === "completed" && spoke) {
      // RESTITUÉ — exactly-once : l'obligation s'éteint, la latence job→voix se mesure.
      for (const d of carried) {
        this.opts.callbacks.onMetric?.("pending_turn_delivered", Math.max(0, Math.round(performance.now() - d.readyAt)));
        this.deliveries.delete(d.callId);
      }
      this.turnIsDelivery = true;
      return;
    }
    if (status === "completed" && !spoke) {
      // LE PIÈGE DE L'ACCUSÉ MUET : la réponse s'est « terminée » sans un mot — le résultat
      // n'a PAS été restitué. On le dit explicitement au modèle (une fois) et on relance.
      this.opts.callbacks.onMetric?.("silent_completion_detected");
      for (const d of carried) {
        d.state = "READY";
        d.deliveryResponseId = null;
        d.attempts += 1;
        if (!d.nudged) {
          d.nudged = true;
          this.send({
            type: "conversation.item.create",
            item: {
              type: "message", role: "system",
              content: [{ type: "input_text", text: "Un résultat d'outil ci-dessus attend sa RESTITUTION VOCALE : le restituer maintenant, en synthèse parlée — ne pas re-promettre, ne pas re-analyser." }],
            },
          });
        }
      }
      this.pendingResponseCreate = true;
      this.startWatchdog();
      return;
    }
    // Annulée (barge-in : la parole de l'utilisateur prime) ou échouée : l'obligation reste
    // due — elle repart PRÊTE et sera restituée au calme (fin du tour utilisateur / watchdog).
    for (const d of carried) {
      d.state = "READY";
      d.deliveryResponseId = null;
      if (status !== "cancelled") d.attempts += 1; // un échec compte, une interruption humaine non
    }
    this.startWatchdog();
  }

  /** `response.create` DISCIPLINÉ : jamais deux réponses demandées — l'intention se replanifie. */
  protected requestResponse(): void {
    if (this.activeResponseId !== null || this.responseCreatePending) {
      this.pendingResponseCreate = true;
      return;
    }
    if (this._state === "USER_SPEAKING" || this.bargeWindow !== null) {
      // RESULT_READY pendant que l'utilisateur parle : ne JAMAIS parler par-dessus — la fin
      // de SON tour déclenche la réponse (VAD auto) ; le watchdog rattrape tout raté.
      this.pendingResponseCreate = true;
      this.startWatchdog();
      return;
    }
    this.responseCreatePending = true;
    this.responseCreateSentAt = performance.now();
    this.send({ type: "response.create" });
    // Un create envoyé est une PROMESSE de réponse. La garde vérifie qu'elle est tenue.
    this.markAwaiting();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // LE TOUR BLOQUÉ — la garde qui supprime le « Alors ? »
  //
  // Distincte du watchdog de RESTITUTION, et il faut les deux : celui-là ne s'arme que
  // lorsqu'un résultat d'outil attend d'être dit. Le compte rendu de production montre des
  // silences SANS outil en jeu — un `response.create` perdu, une réponse créée qui ne produit
  // jamais de son. Rien ne les couvrait, et c'est l'utilisateur qui faisait le watchdog.
  // ─────────────────────────────────────────────────────────────────────────

  /** Le tour attend quelque chose : armer la garde et démarrer le chronomètre. */
  protected markAwaiting(): void {
    this.awaiting = true;
    this.awaitingSince = performance.now();
    if (this.stuckTimer || !this.alive) return;
    this.stuckTimer = setInterval(() => this.stuckTick(), STUCK_TURN_TICK_MS);
  }

  /** Le tour vit (audio, outil en cours, réponse créée) : la garde n'a plus lieu d'être. */
  protected clearAwaiting(): void {
    this.awaiting = false;
    this.awaitingSince = 0;
    if (this.stuckTimer) { clearInterval(this.stuckTimer); this.stuckTimer = null; }
  }

  protected stuckTick(): void {
    if (!this.alive) { this.clearAwaiting(); return; }
    const action = stuckTurnAction({
      awaiting: this.awaiting,
      silentForMs: this.awaiting ? performance.now() - this.awaitingSince : 0,
      activeResponse: this.activeResponseId !== null,
      userSpeaking: this._state === "USER_SPEAKING" || this.bargeWindow !== null,
      audioPlaying: this.audioStartedAt !== null,
      attempts: this.stuckAttempts,
    });

    if (action === "wait") return;

    if (action === "surface") {
      // On a relancé le maximum de fois. INSISTER ne répare plus rien — et un bégaiement
      // facturé est pire qu'un silence expliqué. On le DIT, une fois.
      this.clearAwaiting();
      this.opts.callbacks.onMetric?.("turn_stuck_surfaced", this.stuckAttempts);
      this.opts.callbacks.onError(
        "La réponse ne vient pas. Reformulez votre demande, ou raccrochez et rappelez.",
        "TURN_STUCK",
      );
      return;
    }

    // `revive` : personne ne parle, rien ne vit, le délai est passé. Le create s'est perdu.
    this.stuckAttempts += 1;
    this.awaitingSince = performance.now();
    this.opts.callbacks.onMetric?.("turn_watchdog_recovered", this.stuckAttempts);
    this.responseCreatePending = true;
    this.responseCreateSentAt = performance.now();
    this.send({ type: "response.create" });
  }

  /** La garde déterministe de rattrapage — tourne SEULEMENT quand une restitution est due. */
  protected startWatchdog(): void {
    if (this.watchdogTimer || !this.alive) return;
    this.watchdogTimer = setInterval(() => this.watchdogTick(), DELIVERY_WATCHDOG_TICK_MS);
  }

  protected stopWatchdogIfIdle(): void {
    const dueDeliveries = [...this.deliveries.values()].some((d) => d.state !== "WAITING_TOOL");
    if (!dueDeliveries && !this.pendingResponseCreate && this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  protected watchdogTick(): void {
    if (!this.alive) return;
    const now = performance.now();
    const ready = [...this.deliveries.values()].filter((d) => d.state === "READY");
    if (!ready.length && !this.pendingResponseCreate) { this.stopWatchdogIfIdle(); return; }
    const shared = {
      activeResponse: this.activeResponseId !== null,
      createInFlightMs: this.responseCreatePending ? now - this.responseCreateSentAt : null,
      userSpeaking: this._state === "USER_SPEAKING" || this.bargeWindow !== null,
    };
    let wantCreate = false;
    for (const d of ready) {
      const action = deliveryWatchdogAction({ ...shared, readyForMs: now - d.readyAt, attempts: d.attempts });
      if (action === "give_up") {
        // ÉCHEC TERMINAL de la restitution vocale : il se DIT, et le résultat rejoint le
        // fil — jamais un résultat évaporé, jamais un échec silencieux.
        this.opts.callbacks.onMetric?.("delivery_failed");
        if (d.resultText) this.opts.persistOrphanResult?.(d.resultText);
        this.deliveries.delete(d.callId);
        this.opts.callbacks.onError(
          "La restitution vocale d'un résultat n'a pas abouti — le résultat est conservé dans le fil de conversation.",
          "DELIVERY_FAILED",
        );
      } else if (action === "create") {
        wantCreate = true;
      }
    }
    // `pendingResponseCreate` orphelin (sans obligation PRÊTE) : la même garde le rattrape.
    if (!wantCreate && this.pendingResponseCreate && !shared.activeResponse && !shared.userSpeaking
      && shared.createInFlightMs === null
      && (this.responseCreateSentAt === 0 || now - this.responseCreateSentAt >= DELIVERY_WATCHDOG_GRACE_MS)) {
      wantCreate = true;
    }
    if (wantCreate) {
      // Le create précédent s'est perdu (canal, collision VAD) — RELANCER, une seule fois par
      // tick, pour TOUTES les obligations prêtes (exactly-once : une réponse les couvrira).
      const remaining = [...this.deliveries.values()].filter((d) => d.state === "READY");
      for (const d of remaining) d.attempts += 1;
      this.opts.callbacks.onMetric?.("watchdog_recovered", remaining.length ? Math.max(...remaining.map((d) => d.attempts)) : 1);
      this.pendingResponseCreate = false;
      this.responseCreatePending = true;
      this.responseCreateSentAt = now;
      this.send({ type: "response.create" });
    }
    this.stopWatchdogIfIdle();
  }

  /**
   * FERME LE TOUR D'UNE RÉPONSE — exactement une fois.
   *
   * Appelé UNIQUEMENT depuis `response.done` (et depuis le délai de grâce). Jamais depuis un
   * événement de transcription : c'est précisément ce qui découpait une réponse en trois
   * messages. Le tour ne se ferme que sur la fin de ce qui l'a ouvert.
   */
  protected closeTurn(responseId: string): void {
    // LE VERROU. Deux `response.done` pour le même id (renvoi, réémission, done d'une réponse
    // déjà remplacée) ne produisent qu'un seul tour.
    if (this.emittedTurns.has(responseId)) return;
    const texte = this.assistantText.trim();
    if (!texte) return; // une réponse muette n'est pas un tour — elle est traitée ailleurs

    if (this.userText) {
      this.emitTurn(responseId, texte, this.turnIsDelivery);
      return;
    }
    // Réponse finie, transcription utilisateur pas encore arrivée : 3 s de grâce, et le tour
    // reste IDENTIFIÉ pendant l'attente — un second `done` ne peut pas le doubler.
    this.awaitingUserHalf = { responseId, assistant: texte, isDelivery: this.turnIsDelivery };
    if (this.turnTimer) clearTimeout(this.turnTimer);
    this.turnTimer = setTimeout(() => {
      const en = this.awaitingUserHalf;
      this.awaitingUserHalf = null;
      this.turnTimer = null;
      if (en) this.emitTurn(en.responseId, en.assistant, en.isDelivery);
    }, 3_000);
  }

  /** L'émission proprement dite — le seul endroit qui appelle `onTurnComplete`. */
  protected emitTurn(responseId: string, assistant: string, isDelivery: boolean): void {
    if (this.emittedTurns.has(responseId)) return;
    this.rememberEmitted(responseId);
    // Une RESTITUTION spontanée n'est pas une « intervention vocale » : le fil dit ce qui
    // s'est réellement passé (l'assistant a repris la parole pour livrer un résultat).
    const userHalf = this.userText || (isDelivery ? "(restitution d'une analyse terminée)" : "(intervention vocale)");
    this.userText = "";
    this.assistantText = "";
    this.turnIsDelivery = false;
    this.opts.callbacks.onTurnComplete({ user: userHalf, assistant });
  }

  /** Mémoire bornée des tours émis — l'oubli d'un id très ancien est sans conséquence. */
  protected rememberEmitted(responseId: string): void {
    this.emittedTurns.add(responseId);
    if (this.emittedTurns.size > 32) {
      const first = this.emittedTurns.values().next().value;
      if (first !== undefined) this.emittedTurns.delete(first);
    }
  }

  /**
   * LA MOITIÉ UTILISATEUR EST ARRIVÉE. Si un tour l'attendait, il part MAINTENANT — sans
   * attendre les 3 s : c'est le cas normal, et l'attente se verrait à l'écran.
   */
  protected userHalfArrived(): void {
    const en = this.awaitingUserHalf;
    if (!en) return;
    this.awaitingUserHalf = null;
    if (this.turnTimer) { clearTimeout(this.turnTimer); this.turnTimer = null; }
    this.emitTurn(en.responseId, en.assistant, en.isDelivery);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // BARGE-IN CONFIRMÉ & HYGIÈNE DES SEGMENTS
  // ─────────────────────────────────────────────────────────────────────────

  protected clearBargeWindow(): void {
    this.bargeWindow = null;
    if (this.bargeInTimer) { clearTimeout(this.bargeInTimer); this.bargeInTimer = null; }
  }

  protected rememberConfirmed(itemId: string): void {
    this.confirmedItemIds.add(itemId);
    if (this.confirmedItemIds.size > 16) {
      const first = this.confirmedItemIds.values().next().value;
      if (first !== undefined) this.confirmedItemIds.delete(first);
    }
  }

  /**
   * COMMIT DE BRUIT (pièce silencieuse) : la VAD a committé un segment dont la transcription
   * n'est que du bruit. Le segment est SUPPRIMÉ de la conversation (aucune pollution de
   * contexte, aucune dérive de langue), et la réponse auto qu'il a déclenchée — si elle n'a
   * encore RIEN joué et ne porte aucune restitution — est annulée : l'assistant ne dit pas
   * « Oui ? » à une porte qui claque. Zéro fausse intervention.
   */
  protected handleNoiseCommit(itemId: string | undefined): void {
    if (itemId) {
      this.ignoredWindows.delete(itemId);
      this.send({ type: "conversation.item.delete", item_id: itemId });
    }
    const hasDeliveriesInFlight = [...this.deliveries.values()].some((d) => d.state !== "WAITING_TOOL");
    if (!this.userText && this.activeResponseId !== null && this.audioStartedAt === null && !hasDeliveriesInFlight) {
      this.rememberCancelled(this.activeResponseId);
      this.send({ type: "response.cancel" });
      this.opts.callbacks.onMetric?.("phantom_response_cancelled");
      if (this._state === "THINKING") this.setState("LISTENING");
    }
  }

  /** Confirmation via la FENÊTRE d'évaluation (mots, durée haut-parleur muet, fin de signal). */
  protected confirmBargeIn(sustainedMs?: number): void {
    const window = this.bargeWindow;
    this.clearBargeWindow();
    if (!window) return;
    if (window.itemId) {
      if (this.confirmedItemIds.has(window.itemId)) return; // debounce : déjà coupé pour ce segment
      this.rememberConfirmed(window.itemId);
    }
    this.executeBargeInCut(sustainedMs ?? performance.now() - window.at);
  }

  /**
   * VRAIE interruption : annuler la réponse (`response.cancel`), vider le tampon audio
   * (`output_audio_buffer.clear` — le son s'arrête net), SYNCHRONISER le contexte serveur
   * (`conversation.item.truncate`) sur ce qui a réellement été joué, et MARQUER la réponse
   * annulée pour que ses événements résiduels soient ignorés. Puis la parole de l'utilisateur
   * prime. L'obligation de restitution portée par la réponse annulée redevient DUE
   * (settleDeliveries sur son response.done) — interrompre ne fait rien disparaître.
   */
  protected executeBargeInCut(latencyMs: number): void {
    if (this.activeResponseId !== null) this.rememberCancelled(this.activeResponseId);
    this.send({ type: "response.cancel" });
    this.send({ type: "output_audio_buffer.clear" });
    if (this.currentItemId && this.audioStartedAt !== null) {
      const heardMs = Math.max(0, Math.round(performance.now() - this.audioStartedAt));
      this.send({ type: "conversation.item.truncate", item_id: this.currentItemId, content_index: 0, audio_end_ms: heardMs });
    }
    this.opts.callbacks.onMetric?.("barge_in_confirmed", Math.max(0, Math.round(latencyMs)));
    this.opts.callbacks.onMetric?.("interruption");
    this.setState("USER_SPEAKING");
  }

  sendText(text: string): void {
    const t = text.trim();
    if (!t) return;
    this.userText = t; // le texte tapé EST la moitié utilisateur du tour
    this.send({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: t }] } });
    this.requestResponse();
    this.setState("THINKING");
    this.markAwaiting();
  }

  sendContext(text: string): void {
    const t = text.trim();
    if (!t) return;
    // Un item SYSTÈME, sans response.create : le contexte informe, il ne déclenche rien —
    // « explique-moi ça » se résoudra à la prochaine prise de parole.
    this.send({
      type: "conversation.item.create",
      item: { type: "message", role: "system", content: [{ type: "input_text", text: t.slice(0, 400) }] },
    });
  }

  interrupt(): void {
    if (this.activeResponseId !== null) this.rememberCancelled(this.activeResponseId);
    this.send({ type: "response.cancel" });
    this.send({ type: "output_audio_buffer.clear" });
    if (this._state === "ASSISTANT_SPEAKING" || this._state === "THINKING") this.setState("LISTENING");
    // Couper VOLONTAIREMENT n'est pas un tour bloqué : la garde ne doit pas relancer ce que
    // l'utilisateur vient d'arrêter.
    this.clearAwaiting();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    for (const track of this.mic?.getAudioTracks() ?? []) track.enabled = !muted;
  }

  disconnect(): void {
    this.alive = false;
    if (this.turnTimer) { clearTimeout(this.turnTimer); this.turnTimer = null; }
    this.clearBargeWindow();
    if (this.watchdogTimer) { clearInterval(this.watchdogTimer); this.watchdogTimer = null; }
    this.clearAwaiting();
    // Des résultats PRÊTS jamais restitués au raccrochage : ils rejoignent le fil — pas perdus.
    for (const d of this.deliveries.values()) {
      if (d.state !== "WAITING_TOOL" && d.resultText) this.opts.persistOrphanResult?.(d.resultText);
    }
    this.deliveries.clear();
    try { this.dc?.close(); } catch { /* déjà fermé */ }
    try { this.pc?.close(); } catch { /* déjà fermé */ }
    for (const t of this.mic?.getTracks() ?? []) t.stop();
    if (this.audioEl) { this.audioEl.srcObject = null; this.audioEl = null; }
    this.dc = null; this.pc = null; this.mic = null;
    this._state = "ENDED";
    this.opts.callbacks.onState("ENDED");
  }
}
