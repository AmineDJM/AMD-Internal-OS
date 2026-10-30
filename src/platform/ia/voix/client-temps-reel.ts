/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CLIENT DE LA VOIX TEMPS RÉEL — côté NAVIGATEUR, au socle IA (lot J13, décision 0025). Zéro import.
 *
 * Volontairement mince (le transport d'Adam, `components/chief/realtime-voice/`, porte vingt défenses propres à son
 * appel exécutif ; il n'est pas touché). Ici : la connexion WebRTC (micro → fournisseur, voix → haut-parleur), et le
 * canal d'événements, lu pour trois choses :
 *
 *   1. LES OUTILS — `response.function_call_arguments.done` : l'appel part au SERVEUR (`executer`), qui revérifie
 *      droits et familles, et rend ce que la voix peut dire ; le résultat revient au modèle, puis `response.create`.
 *   2. CE QUI S'AFFICHE — la parole de la personne (transcription) et celle de l'assistant (transcript), et les CARTES
 *      que les outils ont préparées : l'écran les montre, le bouton seul les exécute.
 *   3. LA LATENCE — de la fin de la parole (`input_audio_buffer.speech_stopped`) au premier son de la réponse
 *      (`output_audio_buffer.started` en WebRTC, ou le premier `response.output_audio.delta`) : la cible est 1,5 s au p50.
 *
 * Tout ce qui touche le navigateur (micro, `RTCPeerConnection`, `fetch`, l'horloge) est INJECTABLE : le banc rejoue un
 * flux d'événements sans réseau ni micro.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type EtatVoix = "INACTIF" | "CONNEXION" | "ECOUTE" | "REFLEXION" | "PAROLE" | "ERREUR" | "TERMINE";

export interface ResultatOutilVocal {
  /** Ce que le modèle vocal reçoit : aucune valeur sensible, aucune confirmation. */
  pourModele: string;
  /** Une carte préparée — affichée, jamais exécutée à la voix. */
  carte?: unknown;
  /** Les valeurs confidentielles révélées pour l'écran seulement (à qui a le droit de les voir). */
  ecran?: string | null;
}

export interface Rappels {
  etat?: (e: EtatVoix, detail?: string) => void;
  /** Une ligne de conversation : ce que la personne a dit, ou ce que l'assistant a répondu. */
  ligne?: (qui: "personne" | "assistant", texte: string) => void;
  outil?: (nom: string, r: ResultatOutilVocal) => void;
  latence?: (ms: number) => void;
}

export interface DependancesClient {
  executer: (nom: string, args: Record<string, unknown>) => Promise<ResultatOutilVocal>;
  maintenant?: () => number;
  fetchImpl?: typeof fetch;
  micro?: () => Promise<MediaStream>;
  connexion?: () => RTCPeerConnection;
  haut?: () => HTMLAudioElement;
}

export interface Consommation { entree: number; sortie: number; reponses: number }

interface Evenement {
  type: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  transcript?: string;
  response?: { usage?: { input_tokens?: number; output_tokens?: number } };
  error?: { message?: string };
}

export class ClientVoixTempsReel {
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private micro: MediaStream | null = null;
  private finParole: number | null = null;
  private attenduPremierSon = false;
  private outilsEnCours = 0;
  readonly latences: number[] = [];
  readonly consommation: Consommation = { entree: 0, sortie: 0, reponses: 0 };
  private _etat: EtatVoix = "INACTIF";

  constructor(private readonly deps: DependancesClient, private readonly rappels: Rappels = {}) {}

  get etat(): EtatVoix { return this._etat; }

  private poser(e: EtatVoix, detail?: string) {
    this._etat = e;
    this.rappels.etat?.(e, detail);
  }

  private get maintenant() { return (this.deps.maintenant ?? (() => performance.now()))(); }

  /** Ouvre l'appel : micro, connexion WebRTC, échange SDP avec le secret éphémère. */
  async connecter(secret: string, urlAppel: string): Promise<void> {
    this.poser("CONNEXION");
    try {
      this.micro = await (this.deps.micro ?? (() => navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })))();
      const pc = (this.deps.connexion ?? (() => new RTCPeerConnection()))();
      this.pc = pc;
      const audio = (this.deps.haut ?? (() => { const a = document.createElement("audio"); a.autoplay = true; return a; }))();
      pc.ontrack = (e) => { audio.srcObject = e.streams[0]; };
      for (const t of this.micro.getTracks()) pc.addTrack(t, this.micro);
      const dc = pc.createDataChannel("oai-events");
      this.dc = dc;
      dc.onmessage = (m) => { void this.recevoir(String(m.data)); };
      dc.onopen = () => this.poser("ECOUTE");
      const offre = await pc.createOffer();
      await pc.setLocalDescription(offre);
      const res = await (this.deps.fetchImpl ?? fetch)(urlAppel, {
        method: "POST", body: offre.sdp ?? "", headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/sdp" },
      });
      if (!res.ok) throw new Error(`échange refusé (HTTP ${res.status})`);
      await pc.setRemoteDescription({ type: "answer", sdp: await res.text() });
    } catch (e) {
      this.fermer();
      this.poser("ERREUR", e instanceof Error && /Permission|NotAllowed/i.test(e.name + e.message) ? "Micro refusé : autorisez-le dans le navigateur." : "La connexion vocale a échoué.");
      throw e;
    }
  }

  private envoyer(evt: Record<string, unknown>) {
    if (this.dc?.readyState === "open") this.dc.send(JSON.stringify(evt));
  }

  /** Lit UN événement du fournisseur. Public pour le banc (flux rejoué sans réseau). */
  async recevoir(brut: string): Promise<void> {
    let e: Evenement;
    try { e = JSON.parse(brut) as Evenement; } catch { return; }
    switch (e.type) {
      case "input_audio_buffer.speech_started":
        this.poser("ECOUTE");
        break;
      case "input_audio_buffer.speech_stopped":
        this.finParole = this.maintenant;
        this.attenduPremierSon = true;
        this.poser("REFLEXION");
        break;
      case "output_audio_buffer.started":
      case "response.output_audio.delta":
        if (this.attenduPremierSon && this.finParole != null && this.outilsEnCours === 0) {
          const ms = Math.round(this.maintenant - this.finParole);
          this.latences.push(ms);
          this.rappels.latence?.(ms);
        }
        this.attenduPremierSon = false;
        this.poser("PAROLE");
        break;
      case "output_audio_buffer.stopped":
        this.poser("ECOUTE");
        break;
      case "conversation.item.input_audio_transcription.completed":
        if (e.transcript?.trim()) this.rappels.ligne?.("personne", e.transcript.trim());
        break;
      case "response.output_audio_transcript.done":
        if (e.transcript?.trim()) this.rappels.ligne?.("assistant", e.transcript.trim());
        break;
      case "response.done":
        this.consommation.reponses += 1;
        this.consommation.entree += e.response?.usage?.input_tokens ?? 0;
        this.consommation.sortie += e.response?.usage?.output_tokens ?? 0;
        break;
      case "response.function_call_arguments.done":
        await this.appelOutil(e);
        break;
      case "error":
        console.warn("[voix] erreur du fournisseur", e.error?.message);
        break;
      default:
        break;
    }
  }

  private async appelOutil(e: Evenement) {
    if (!e.call_id || !e.name) return;
    // Un tour qui passe par un outil n'est pas une mesure de la latence de réponse : il attend le serveur.
    this.outilsEnCours += 1;
    this.attenduPremierSon = false;
    let args: Record<string, unknown> = {};
    try { args = JSON.parse(e.arguments || "{}") as Record<string, unknown>; } catch { args = {}; }
    let r: ResultatOutilVocal;
    try {
      r = await this.deps.executer(e.name, args);
    } catch {
      r = { pourModele: JSON.stringify({ statut: "ECHEC", raison: "L'outil n'a pas répondu. Dis-le et propose de réessayer." }) };
    } finally {
      this.outilsEnCours -= 1;
    }
    this.rappels.outil?.(e.name, r);
    this.envoyer({ type: "conversation.item.create", item: { type: "function_call_output", call_id: e.call_id, output: r.pourModele } });
    this.envoyer({ type: "response.create" });
  }

  /** Coupe le micro sans raccrocher. */
  muet(oui: boolean) {
    for (const t of this.micro?.getTracks() ?? []) t.enabled = !oui;
  }

  fermer() {
    try { this.dc?.close(); } catch { /* déjà fermé */ }
    try { this.pc?.close(); } catch { /* déjà fermé */ }
    for (const t of this.micro?.getTracks() ?? []) t.stop();
    this.dc = null;
    this.pc = null;
    this.micro = null;
    if (this._etat !== "ERREUR") this.poser("TERMINE");
  }
}
