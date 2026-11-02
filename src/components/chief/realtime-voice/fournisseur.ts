/**
 * COUCHE TRANSPORT DE L'APPEL VOCAL — `OpenAIGptRealtime21Provider` : la connexion WebRTC directe vers
 * l'API Realtime (secret éphémère, micro, échange SDP) et la lecture des événements du data channel.
 */
import { bargeInDecision, isNoiseTranscript, BARGE_IN_SUSTAIN_MS } from "@/lib/assistant/voice-tuning";
import { sansBloquer } from "@/lib/journal";
import { type VoiceRealtimeProvider, type RealtimeEvent, cumulerUsage } from "./contrats";
import { SdpRejection } from "./refus-sdp";
import { SocleAppelRealtime } from "./socle";

export class OpenAIGptRealtime21Provider extends SocleAppelRealtime implements VoiceRealtimeProvider {
  async connect(): Promise<void> {
    this.alive = true;
    this.setState("CONNECTING");

    // 1) Le secret éphémère — le SEUL credential côté navigateur.
    const grant = await this.opts.getGrant();
    this._threadId = grant.threadId;

    // 2) Micro — demandé UNE fois pour toute la session, avec l'hygiène audio du navigateur.
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("MIC_UNSUPPORTED");
    this.mic = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });

    // 3) La connexion WebRTC directe vers l'API Realtime.
    const pc = new RTCPeerConnection();
    this.pc = pc;
    for (const track of this.mic.getTracks()) pc.addTrack(track, this.mic);

    // La voix de l'assistant : une piste distante, jouée EN CONTINU (pas de fichier attendu).
    this.audioEl = new Audio();
    this.audioEl.autoplay = true;
    pc.ontrack = (e) => {
      if (this.audioEl) this.audioEl.srcObject = e.streams[0];
      void this.audioEl?.play().catch(sansBloquer("realtime-voice.connect.play")); // iOS/Safari : play() après geste utilisateur
    };
    pc.onconnectionstatechange = () => {
      this.opts.callbacks.onConnectionChange?.(pc.connectionState);
    };

    const dc = pc.createDataChannel("oai-events");
    this.dc = dc;
    dc.onmessage = (e) => this.handleEvent(e.data as string);

    const opened = new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("DATA_CHANNEL_TIMEOUT")), 15_000);
      dc.onopen = () => { clearTimeout(t); resolve(); };
      dc.onerror = () => { clearTimeout(t); reject(new Error("DATA_CHANNEL_ERROR")); };
    });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    // 4) L'échange SDP officiel : l'offre part avec le secret ÉPHÉMÈRE, la réponse revient.
    const res = await fetch(`${grant.callUrl}?model=${encodeURIComponent(grant.model)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${grant.clientSecret}`, "Content-Type": "application/sdp" },
      body: offer.sdp,
    });
    if (!res.ok) {
      // ── CE QUE LE REFUS DIT, ON LE GARDE ──────────────────────────────────────────────
      //
      // Cette ligne jetait la réponse : `throw new Error("SDP_" + status)`, et rien d'autre.
      // Résultat en production, un soir de 429 : `detail: undefined` dans tous les journaux —
      // impossible de savoir si le compte avait atteint son plafond de sessions SIMULTANÉES ou
      // son quota par minute, deux incidents qui ne se traitent pas pareil. Et surtout, le
      // serveur DIT combien de temps attendre dans `Retry-After` : on l'ignorait pour
      // reconnecter aussitôt, ce qui est exactement la mauvaise réponse à « ralentis ».
      const body = await res.text().catch(sansBloquer("realtime-voice.connect.text", ""));
      const err = new SdpRejection(res.status, body, res.headers.get("retry-after"));
      throw err;
    }
    await pc.setRemoteDescription({ type: "answer", sdp: await res.text() });

    await opened;
    if (this.muted) this.setMuted(true);
    this.setState("LISTENING");
  }

  private handleEvent(raw: string): void {
    let e: RealtimeEvent;
    try { e = JSON.parse(raw) as RealtimeEvent; } catch { return; }
    const cb = this.opts.callbacks;

    switch (e.type) {
      // ── Tour de parole de l'utilisateur ──
      case "input_audio_buffer.speech_started": {
        const busy = this._state === "ASSISTANT_SPEAKING" || this._state === "THINKING";
        if (!busy) { this.setState("USER_SPEAKING"); break; }
        // DEBOUNCE : un segment déjà confirmé ne rouvre pas de fenêtre (une interruption par
        // segment de parole — jamais de double CONFIRMED sur le même souffle).
        if (e.item_id && this.confirmedItemIds.has(e.item_id)) break;
        // BARGE-IN NATIF : le serveur (interrupt_response:true) coupe déjà la génération dès
        // qu'il entend la parole. Le client CONFIRME vite et STT-INDÉPENDANT — une parole
        // soutenue (≥ 180 ms) coupe, avec ou sans mots (voir bargeInDecision) — puis vide le
        // tampon audio local et tronque : le son s'arrête NET. On n'attend plus les mots de la
        // transcription (c'était « je parle et Adam continue de parler »). Le seuil de 180 ms
        // + l'annulation d'écho du navigateur rejettent les salves brèves (clic, écho résiduel).
        this.bargeWindow = { itemId: e.item_id ?? null, at: performance.now() };
        cb.onMetric?.("possible_barge_in");
        if (this.bargeInTimer) clearTimeout(this.bargeInTimer);
        this.bargeInTimer = setTimeout(() => {
          if (!this.bargeWindow) return;
          const verdict = bargeInDecision({
            assistantBusy: true,
            sustainedMs: performance.now() - this.bargeWindow.at,
            hasTranscriptEvidence: false,
            speechStopped: false,
            audioPlaying: this.audioStartedAt !== null,
          });
          if (verdict === "confirm") this.confirmBargeIn();
          // « wait » : la parole n'a pas encore atteint le seuil — la fin du signal
          // (speech_stopped) ou un mot transcrit tranchera. Rien n'est perdu.
        }, BARGE_IN_SUSTAIN_MS);
        break;
      }
      case "input_audio_buffer.speech_stopped": {
        if (this.bargeWindow) {
          const sustained = performance.now() - this.bargeWindow.at;
          const itemId = this.bargeWindow.itemId;
          const verdict = bargeInDecision({
            assistantBusy: true, sustainedMs: sustained, hasTranscriptEvidence: false,
            speechStopped: true, audioPlaying: this.audioStartedAt !== null,
          });
          this.clearBargeWindow();
          if (verdict === "ignore") {
            // FAUX BARGE-IN (bruit bref, ou signal sans mots pendant l'écho possible) : la
            // réponse CONTINUE — tracé. La transcription TARDIVE peut encore requalifier.
            if (itemId) this.ignoredWindows.set(itemId, this.activeResponseId);
            cb.onMetric?.("false_barge_in_ignored");
            break;
          }
          // Signal soutenu (haut-parleur muet) qui se termine : vraie prise de parole.
          this.confirmBargeIn(sustained);
        }
        // LA BORNE DE DÉPART DE TOUTE MESURE DE LATENCE VÉCUE : l'instant où l'utilisateur se
        // tait. Tout ce qu'on mesure ensuite (premier son, outils, fin de réponse) se compte
        // à partir d'ici — pas à partir de l'envoi d'une requête, que l'utilisateur ne vit pas.
        cb.onMetric?.("user_speech_ended", performance.now());
        this.setState("THINKING");
        this.markAwaiting();
        break;
      }

      // ── Transcription de l'utilisateur (parallèle à l'audio) ──
      case "conversation.item.input_audio_transcription.delta":
        // Des MOTS pendant la fenêtre d'évaluation = parole humaine → barge-in confirmé.
        // Un delta d'un ANCIEN segment ne confirme JAMAIS la fenêtre d'un nouveau.
        if (this.bargeWindow && e.delta && /\p{L}/u.test(e.delta)) {
          const sameSegment = !e.item_id || !this.bargeWindow.itemId || e.item_id === this.bargeWindow.itemId;
          if (sameSegment) this.confirmBargeIn();
          else cb.onMetric?.("stale_event_ignored");
        }
        if (e.delta) cb.onUserTranscript(e.delta, false);
        break;
      case "conversation.item.input_audio_transcription.completed":
        if (typeof e.transcript === "string") {
          const t = e.transcript.trim();
          // LE TRANSCRIPT N'EST PAS LA VÉRITÉ TERRAIN : une toux transcrite « … », un artefact
          // sans lettres n'entre ni dans le fil, ni dans la mémoire, ni dans les entités.
          if (isNoiseTranscript(t)) {
            this.handleNoiseCommit(e.item_id);
            break;
          }
          // CONFIRMATION TARDIVE : la fenêtre de ce segment avait été fermée « bruit » faute
          // de mots (transcription lente) — les mots sont là, la MÊME réponse parle toujours :
          // c'était une vraie interruption, elle s'exécute maintenant.
          if (e.item_id && this.ignoredWindows.has(e.item_id)) {
            const duringResponse = this.ignoredWindows.get(e.item_id);
            this.ignoredWindows.delete(e.item_id);
            if (duringResponse !== null && duringResponse === this.activeResponseId && this._state === "ASSISTANT_SPEAKING") {
              this.executeBargeInCut(0);
              if (e.item_id) this.rememberConfirmed(e.item_id);
            }
          }
          this.userText = t;
          cb.onUserTranscript(this.userText, true);
          // ON N'ÉMET PLUS DE TOUR ICI. C'ÉTAIT LE DÉFAUT : émettre depuis la transcription
          // utilisateur coupait la réponse en cours en deux messages, la moitié utilisateur
          // partant avec le premier. On ne fait que RENSEIGNER la moitié utilisateur ; si un
          // tour clos l'attendait, il part maintenant.
          this.userHalfArrived();
        }
        break;

      // ── La réponse de l'assistant ──
      case "response.created": {
        this.activeResponseId = e.response?.id ?? "r-inconnue";
        this.activeResponseSpoke = false;
        this.responseCreatePending = false;
        // LE TOUR S'OUVRE ICI, et il appartient à CETTE réponse. Le texte accumulé pour une
        // réponse précédente n'a rien à faire dans celui-ci : le vider est ce qui garantit
        // qu'un tour ne récupère jamais la fin du précédent.
        if (this.turnResponseId !== this.activeResponseId) {
          this.turnResponseId = this.activeResponseId;
          this.assistantText = "";
        }
        this.stuckAttempts = 0;
        cb.onMetric?.("response_started", performance.now());
        // La réponse qui démarre — la nôtre OU une auto-créée par la VAD — EST la réponse
        // attendue : l'intention en attente est absorbée (pas de réponse surnuméraire après).
        this.pendingResponseCreate = false;
        // EXACTLY-ONCE : la réponse qui démarre PORTE toutes les obligations prêtes — aucune
        // autre réponse ne sera demandée pour elles tant qu'elle vit.
        for (const d of this.deliveries.values()) {
          if (d.state === "READY") { d.state = "DELIVERING"; d.deliveryResponseId = this.activeResponseId; }
        }
        this.setState("THINKING");
        break;
      }
      // Transcript de l'audio de sortie — noms GA et hérité, pour survivre aux renommages.
      case "response.output_audio_transcript.delta":
      case "response.audio_transcript.delta":
        // HYGIÈNE ANTI-PÉRIMÉ : les deltas d'une réponse ANNULÉE (barge-in) continuent
        // d'arriver quelques instants — ils ne polluent ni le transcript ni le tour suivant.
        if (this.isStaleResponseEvent(e.response_id)) { cb.onMetric?.("stale_event_ignored"); break; }
        if (e.delta) {
          this.activeResponseSpoke = true;
          // DU TEXTE PROUVE QUE LE TOUR VIT, autant que du son. Ne désarmer la garde que sur
          // `output_audio_buffer.started` la laissait relancer une réponse qui avait déjà
          // commencé à répondre — une relance par-dessus une réponse en cours, c'est-à-dire
          // exactement le bégaiement qu'une garde de silence doit éviter de fabriquer.
          this.clearAwaiting();
          this.stuckAttempts = 0;
          this.assistantText += e.delta;
          cb.onAssistantTranscript(this.assistantText, false);
        }
        break;
      case "response.output_audio_transcript.done":
      case "response.audio_transcript.done":
        // Même hygiène : le transcript FINAL d'une réponse annulée ne remplace pas la partie
        // réellement entendue par le texte complet jamais joué.
        if (this.isStaleResponseEvent(e.response_id)) { cb.onMetric?.("stale_event_ignored"); break; }
        if (typeof e.transcript === "string") this.assistantText = e.transcript.trim();
        cb.onAssistantTranscript(this.assistantText, true);
        break;

      // L'item de sortie en cours : son id sert au `truncate` du barge-in (synchroniser le
      // contexte serveur avec ce que l'utilisateur a RÉELLEMENT entendu).
      case "response.output_item.added":
        if (this.isStaleResponseEvent(e.response_id)) { cb.onMetric?.("stale_event_ignored"); break; }
        if (e.item?.type === "message" && typeof e.item.id === "string") this.currentItemId = e.item.id;
        break;

      // Le son : événements du tampon de sortie WebRTC — l'état SPEAKING suit le haut-parleur.
      case "output_audio_buffer.started":
        // Un démarrage audio d'une réponse ANNULÉE ne rebascule pas l'état en SPEAKING (les
        // événements de tampon traînent derrière le done — seul le marqueur « annulée » gate :
        // un démarrage légitime peut, lui, arriver juste après le done d'une réponse courte).
        if (e.response_id && this.cancelledResponseIds.has(e.response_id)) { cb.onMetric?.("stale_event_ignored"); break; }
        this.audioStartedAt = performance.now();
        this.activeResponseSpoke = true;
        // LE SON EST LA PREUVE QUE LE TOUR VIT. Toute garde de blocage s'éteint ici, et pas
        // avant : `response.created` ne prouve rien (le compte rendu montre des réponses
        // créées qui n'ont jamais produit un mot).
        this.clearAwaiting();
        this.stuckAttempts = 0;
        // `first_audio` à CHAQUE tour ; `first_audio_out` reste le tout premier de la session
        // (deux questions différentes : « ce tour a-t-il été rapide ? » et « l'appel a-t-il
        // démarré vite ? »). Les confondre, c'était ne pouvoir répondre ni à l'une ni à l'autre.
        cb.onMetric?.("first_audio", this.audioStartedAt);
        if (this.firstAudioAt === null) {
          this.firstAudioAt = performance.now();
          cb.onMetric?.("first_audio_out", this.firstAudioAt);
        }
        this.setState("ASSISTANT_SPEAKING");
        break;
      case "output_audio_buffer.stopped":
      case "output_audio_buffer.cleared":
        // Couper court est TOUJOURS sûr (le haut-parleur s'est tu) — aucune condition d'id.
        this.audioStartedAt = null;
        if (this._state === "ASSISTANT_SPEAKING") this.setState("LISTENING");
        break;

      // ── Appels d'outils : exécutés par NOTRE backend, jamais ici — et EN PARALLÈLE ──
      case "response.function_call_arguments.done": {
        const name = e.name;
        const callId = e.call_id;
        if (!name || !callId) break;
        let args: Record<string, unknown> = {};
        try { args = e.arguments ? (JSON.parse(e.arguments) as Record<string, unknown>) : {}; } catch { /* args illisibles */ }
        cb.onMetric?.("tool_call");
        const toolStartedAt = performance.now();
        cb.onMetric?.("tool_started", toolStartedAt);
        // UN OUTIL QUI TOURNE, C'EST UN TOUR QUI VIT. La garde du tour bloqué ne doit pas
        // relancer une réponse pendant qu'on interroge la base : ce serait couper le travail
        // en cours pour cause de silence — un silence qui a une raison.
        this.clearAwaiting();
        // L'OBLIGATION naît ICI : ce call_id a désormais un propriétaire de réponse. Elle ne
        // s'éteindra qu'une fois le résultat RESTITUÉ (ou persisté au fil en dernier recours).
        this.deliveries.set(callId, {
          callId, tool: name, state: "WAITING_TOOL", readyAt: 0, attempts: 0,
          deliveryResponseId: null, resultText: "", nudged: false,
        });
        cb.onMetric?.("pending_turn_created");
        // PAS de file : chaque outil vit sa vie (call_id l'apparie). Une analyse déléguée de
        // deux minutes n'empêche pas « quelle est la masse salariale ? » de répondre tout de
        // suite — c'est le « travail parallèle » de l'appel.
        void (async () => {
          let output: string;
          let uiReply: string | null = null;
          try {
            const r = await this.opts.callTool(name, args);
            if (r.ui) cb.onToolUi(r.ui);
            output = r.output;
            uiReply = r.ui?.reply ?? null;
          } catch {
            cb.onMetric?.("tool_error");
            // L'échec se DIT — jamais un silence : il suit le même chemin de restitution.
            output = "L'outil a échoué (réseau) — le dire simplement, ne rien inventer.";
          }
          // La DURÉE de l'outil, pas son horodatage : c'est elle qui dit si la lenteur vient
          // de l'ERP ou du modèle, et c'est la première question qu'on se pose.
          cb.onMetric?.("tool_completed", Math.max(0, Math.round(performance.now() - toolStartedAt)));
          this.completeDelivery(callId, output, uiReply);
        })();
        break;
      }

      case "response.done": {
        const rid = e.response?.id ?? this.activeResponseId ?? "r-inconnue";
        const status = e.response?.status ?? "completed";
        // La facture de CETTE réponse s'ajoute aux totaux — même annulée : les jetons sont payés.
        this.usageTotaux = cumulerUsage(this.usageTotaux, e.response?.usage);
        // Le marqueur « annulée » SURVIT au done : les événements de tampon audio de la
        // réponse annulée traînent encore derrière (c'est lui qui les fait ignorer).
        const wasCancelled = this.cancelledResponseIds.has(rid) || status === "cancelled";
        if (this.activeResponseId !== null && e.response?.id && e.response.id !== this.activeResponseId) {
          // done d'une réponse déjà remplacée dans notre suivi : régler ses obligations, sans
          // toucher à la réponse active actuelle NI au tour en cours (qui appartient à l'autre).
          this.settleDeliveries(rid, status, false);
          break;
        }
        this.activeResponseId = null;
        this.settleDeliveries(rid, status, this.activeResponseSpoke && !wasCancelled);
        cb.onMetric?.("response_completed", performance.now());
        // Fin de réponse : le tour de CETTE réponse se clôt — une fois, et une seule.
        if (this._state === "THINKING") this.setState("LISTENING");
        this.closeTurn(rid);
        this.turnResponseId = null;
        // Un résultat arrivé PENDANT cette réponse attendait son tour : maintenant.
        if (this.pendingResponseCreate) {
          this.pendingResponseCreate = false;
          this.requestResponse();
        }
        break;
      }

      case "error": {
        const code = e.error?.code ?? "";
        if (code === "conversation_already_has_active_response") {
          // Notre suivi était en retard sur une réponse AUTO-créée par la VAD serveur :
          // l'intention n'est PAS perdue — elle se replanifie. Si la réponse active est déjà
          // connue, son cycle couvre les obligations (DELIVERING) ; sinon son `created` qui
          // arrive absorbera l'attente, et le watchdog rattrape tout raté. C'était LA cause
          // du silence infini (« Je vais analyser… » puis plus rien).
          this.responseCreatePending = false;
          if (this.activeResponseId === null) {
            this.pendingResponseCreate = true;
            this.startWatchdog();
          }
          break;
        }
        if (code === "response_cancel_not_active") break; // cancel d'une réponse déjà finie — bénin
        cb.onError(e.error?.message ?? "Erreur de session vocale.", e.error?.code);
        break;
      }
    }
  }
}
