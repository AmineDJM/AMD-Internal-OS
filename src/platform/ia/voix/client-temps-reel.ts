/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CLIENT DE LA VOIX GPT-LIVE — côté NAVIGATEUR, au socle IA (lot J13, décision 0025). Zéro import.
 *
 * Volontairement mince (le transport d'Adam, `components/chief/realtime-voice/`, est le sien et n'est pas touché). Ici :
 * la connexion WebRTC (micro → GPT-Live, voix → haut-parleur ; l'offre SDP passe par NOTRE serveur, qui seul parle au
 * fournisseur), et le canal d'événements, lu pour trois choses :
 *
 *   1. LA DÉLÉGATION — `session.delegation.created` : la demande de la personne (ce qu'elle a dit depuis la délégation
 *      précédente) part à NOTRE serveur (`deleguer`), où l'assistant la traite sous ses droits ; le résultat revient à
 *      GPT-Live par `session.commentary.append` (500 jetons au plus), avec l'identifiant de la délégation.
 *   2. CE QUI S'AFFICHE — les fragments de transcription (`session.input_transcript.delta`, `…output_transcript.delta`)
 *      regroupés en répliques, et les CARTES que l'assistant a préparées : l'écran les montre, le bouton seul exécute.
 *   3. LA LATENCE — sur la LIGNE DE TEMPS DE LA SESSION (les `start_ms` / `end_ms` des fragments, pas l'arrivée des
 *      paquets) : de la fin de la parole de la personne au début de la réponse parlée. Cible : 1,5 s au p50.
 *
 * Tout ce qui touche le navigateur (micro, `RTCPeerConnection`, l'horloge) est INJECTABLE : le banc rejoue un flux
 * d'événements sans réseau ni micro.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type EtatVoix = "INACTIF" | "CONNEXION" | "ECOUTE" | "REFLEXION" | "PAROLE" | "FERMETURE" | "ERREUR" | "TERMINE";

export interface ResultatDelegation {
  /** Ce que la voix reçoit (et paraphrase) : aucune valeur sensible, aucune confirmation. */
  pourVoix: string;
  /** Une carte préparée — affichée, jamais exécutée à la voix. */
  carte?: unknown;
  /** La réponse écrite de l'assistant, valeurs révélées à qui a le droit — pour l'écran seulement. */
  ecran?: string | null;
}

export interface Rappels {
  etat?: (e: EtatVoix, detail?: string) => void;
  /** Une réplique complète : ce que la personne a dit, ou ce que l'assistant a répondu. */
  ligne?: (qui: "personne" | "assistant", texte: string) => void;
  delegation?: (demande: string, r: ResultatDelegation) => void;
  latence?: (ms: number) => void;
}

export interface DependancesClient {
  /** Remet l'offre SDP à NOTRE serveur, qui ouvre la session et rend la réponse SDP. */
  ouvrir: (sdp: string) => Promise<{ sdp: string }>;
  deleguer: (demande: string, delegationId: string) => Promise<ResultatDelegation>;
  micro?: () => Promise<MediaStream>;
  connexion?: () => RTCPeerConnection;
  haut?: () => HTMLAudioElement;
  attendreFermetureMs?: number;
  /**
   * La délégation peut arriver AVANT la fin de la transcription de la phrase (documentation GPT-Live) : on attend que les
   * fragments se taisent ce temps-là (1,5 s au plus) avant d'envoyer la demande. 0 au banc.
   */
  silenceTranscriptionMs?: number;
}

interface Evenement {
  type: string;
  delta?: string;
  start_ms?: number;
  end_ms?: number;
  delegation?: { id?: string; target?: string };
  usage?: { seconds?: number };
  session?: { id?: string };
  error?: { message?: string };
}

const MAX_COMMENTAIRE = 1_800;

export class ClientVoixTempsReel {
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private micro: MediaStream | null = null;
  private _etat: EtatVoix = "INACTIF";
  private parleur: "personne" | "assistant" | null = null;
  private replique = "";
  /** Ce que la personne a dit depuis la dernière délégation — la demande de la prochaine. */
  private demande = "";
  private derniereDemande = "";
  private finParoleMs: number | null = null;
  private reponseAttendue = false;
  private numero = 0;
  private dernierFragment = 0;
  private fermeture: (() => void) | null = null;
  readonly latences: number[] = [];
  /** Durée vocale facturée (secondes), la dernière lue — finale quand `session.closed` est arrivé. */
  secondes = 0;
  usageConfirme = false;
  delegations = 0;

  constructor(private readonly deps: DependancesClient, private readonly rappels: Rappels = {}) {}

  get etat(): EtatVoix { return this._etat; }

  private poser(e: EtatVoix, detail?: string) {
    this._etat = e;
    this.rappels.etat?.(e, detail);
  }

  /** Ouvre l'appel : micro, connexion WebRTC, offre complète (candidats réunis), échange par notre serveur. */
  async connecter(): Promise<void> {
    this.poser("CONNEXION");
    try {
      this.micro = await (this.deps.micro ?? (() => navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })))();
      const pc = (this.deps.connexion ?? (() => new RTCPeerConnection()))();
      this.pc = pc;
      const audio = (this.deps.haut ?? (() => { const a = document.createElement("audio"); a.autoplay = true; return a; }))();
      pc.ontrack = (e) => { audio.srcObject = new MediaStream([e.track]); };
      for (const t of this.micro.getAudioTracks()) pc.addTrack(t, this.micro);
      // Le canal d'événements AVANT l'offre.
      const dc = pc.createDataChannel("oai-events");
      this.dc = dc;
      dc.onmessage = (m) => { void this.recevoir(String(m.data)); };
      dc.onclose = () => { if (this._etat !== "TERMINE" && this._etat !== "ERREUR") this.terminer(); };
      await pc.setLocalDescription(await pc.createOffer());
      await this.candidatsReunis(pc);
      const sdp = pc.localDescription?.sdp;
      if (!sdp) throw new Error("offre SDP absente");
      const reponse = await this.deps.ouvrir(sdp);
      await pc.setRemoteDescription({ type: "answer", sdp: reponse.sdp });
    } catch (e) {
      this.liberer();
      const refus = e instanceof Error && /Permission|NotAllowed/i.test(e.name + e.message);
      this.poser("ERREUR", refus ? "Micro refusé : autorisez-le dans le navigateur." : e instanceof Error && e.message ? e.message : "La connexion vocale a échoué.");
      throw e;
    }
  }

  private candidatsReunis(pc: RTCPeerConnection): Promise<void> {
    if (pc.iceGatheringState === "complete") return Promise.resolve();
    return new Promise((ok) => {
      const fin = () => { clearTimeout(t); pc.removeEventListener("icegatheringstatechange", etat); ok(); };
      const etat = () => { if (pc.iceGatheringState === "complete") fin(); };
      const t = setTimeout(fin, 10_000);
      pc.addEventListener("icegatheringstatechange", etat);
    });
  }

  private envoyer(evt: Record<string, unknown>) {
    if (this.dc?.readyState === "open") this.dc.send(JSON.stringify(evt));
  }

  private finirReplique() {
    const t = this.replique.trim();
    if (t && this.parleur) this.rappels.ligne?.(this.parleur, t);
    this.replique = "";
  }

  /** Lit UN événement du fournisseur. Public pour le banc (flux rejoué sans réseau). */
  async recevoir(brut: string): Promise<void> {
    let e: Evenement;
    try { e = JSON.parse(brut) as Evenement; } catch { return; }
    switch (e.type) {
      case "session.started":
        this.poser("ECOUTE");
        break;
      case "session.input_transcript.delta":
        if (this.parleur !== "personne") { this.finirReplique(); this.parleur = "personne"; }
        this.replique += e.delta ?? "";
        this.demande += e.delta ?? "";
        this.dernierFragment = Date.now();
        if (typeof e.end_ms === "number") this.finParoleMs = e.end_ms;
        this.reponseAttendue = true;
        if (this._etat !== "FERMETURE") this.poser("ECOUTE");
        break;
      case "session.output_transcript.delta":
        if (this.parleur !== "assistant") { this.finirReplique(); this.parleur = "assistant"; }
        this.replique += e.delta ?? "";
        if (this.reponseAttendue && this.finParoleMs != null && typeof e.start_ms === "number") {
          const ms = Math.max(0, Math.round(e.start_ms - this.finParoleMs));
          this.latences.push(ms);
          this.rappels.latence?.(ms);
        }
        this.reponseAttendue = false;
        if (this._etat !== "FERMETURE") this.poser("PAROLE");
        break;
      case "session.delegation.created":
        if (e.delegation?.id && e.delegation.target !== "responses") await this.deleguer(e.delegation.id);
        break;
      case "session.usage.updated":
        if (typeof e.usage?.seconds === "number") this.secondes = e.usage.seconds;
        break;
      case "session.closed":
        if (typeof e.usage?.seconds === "number") this.secondes = e.usage.seconds;
        this.usageConfirme = true;
        this.terminer();
        break;
      case "error":
        console.warn("[voix] erreur du fournisseur", e.error?.message);
        break;
      default:
        break;
    }
  }

  private async deleguer(delegationId: string) {
    const silence = this.deps.silenceTranscriptionMs ?? 500;
    for (const limite = Date.now() + 1_500; silence > 0 && Date.now() < limite && Date.now() - this.dernierFragment < silence;) {
      await new Promise((r) => setTimeout(r, 100));
    }
    // La demande : ce que la personne a dit depuis la délégation précédente (sinon sa dernière demande, reformulée).
    const demande = (this.demande.trim() || this.derniereDemande).slice(0, 4_000);
    this.demande = "";
    this.derniereDemande = demande;
    this.delegations += 1;
    if (this._etat !== "FERMETURE") this.poser("REFLEXION");
    let r: ResultatDelegation;
    try {
      r = await this.deps.deleguer(demande, delegationId);
    } catch {
      r = { pourVoix: "Le serveur n'a pas répondu : dis-le simplement et propose de réessayer." };
    }
    this.rappels.delegation?.(demande, r);
    this.envoyer({
      type: "session.commentary.append", event_id: `resultat_${++this.numero}`, delegation_id: delegationId,
      content: (r.pourVoix || "Rien à dire de plus.").slice(0, MAX_COMMENTAIRE),
    });
  }

  /** Coupe le micro sans raccrocher. */
  muet(oui: boolean) {
    for (const t of this.micro?.getTracks() ?? []) t.enabled = !oui;
  }

  /**
   * RACCROCHER PROPREMENT : `session.close`, puis on attend `session.closed` (la consommation finale) avant de libérer le
   * micro et la connexion — 15 s au plus ; au-delà, la consommation reste « non confirmée ».
   */
  async fermer(): Promise<void> {
    if (this._etat === "TERMINE" || this._etat === "ERREUR") return;
    if (this.dc?.readyState !== "open") { this.terminer(); return; }
    this.poser("FERMETURE");
    await new Promise<void>((ok) => {
      const t = setTimeout(() => { this.fermeture = null; ok(); }, this.deps.attendreFermetureMs ?? 15_000);
      this.fermeture = () => { clearTimeout(t); ok(); };
      this.envoyer({ type: "session.close" });
    });
    this.terminer();
  }

  private terminer() {
    this.finirReplique();
    this.liberer();
    const f = this.fermeture;
    this.fermeture = null;
    f?.();
    if (this._etat !== "TERMINE" && this._etat !== "ERREUR") this.poser("TERMINE");
  }

  private liberer() {
    try { this.dc?.close(); } catch { /* déjà fermé */ }
    try { this.pc?.close(); } catch { /* déjà fermé */ }
    for (const t of this.micro?.getTracks() ?? []) t.stop();
    this.dc = null;
    this.pc = null;
    this.micro = null;
  }
}
