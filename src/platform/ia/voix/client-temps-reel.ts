/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CLIENT DE LA VOIX GPT-LIVE — côté NAVIGATEUR, au socle IA (lot J13, décision 0025). Zéro import.
 *
 * Volontairement mince (le transport d'Adam, `components/chief/realtime-voice/`, est le sien et n'est pas touché). Ici :
 * la connexion WebRTC (micro → GPT-Live, voix → haut-parleur ; l'offre SDP passe par NOTRE serveur, qui seul parle au
 * fournisseur), et le canal d'événements, lu pour trois choses :
 *
 *   1. LA DÉLÉGATION — `session.delegation.created` : la demande de la personne (ce qu'elle a dit depuis la délégation
 *      précédente) part à NOTRE serveur (`deleguer`), où l'assistant la traite sous ses droits ; ce qu'il rend revient à
 *      GPT-Live par `session.commentary.append` (500 jetons au plus), avec l'identifiant de la délégation.
 *      K9 (décision 0039) : le serveur rend AUSSITÔT ; un TRAVAIL lancé est SUIVI ici (`suivre`) et son résultat
 *      injecté de lui-même quand il arrive, même minutes plus tard ; ce que la personne dit entre-temps part comme
 *      PRÉCISION du travail en cours (`enCours`).
 *      La personne qui parle pendant que la voix parle COUPE le son tout de suite (barge-in, côté navigateur).
 *   2. CE QUI S'AFFICHE — les fragments de transcription (`session.input_transcript.delta`, `…output_transcript.delta`)
 *      regroupés en répliques, et les CARTES que l'assistant a préparées : l'écran les montre ; la personne confirme au
 *      bouton ou à l'oral (décision 0035 : le serveur juge le oui sur SA transcription, `parole`).
 *   3. LA LATENCE — sur la LIGNE DE TEMPS DE LA SESSION (les `start_ms` / `end_ms` des fragments, pas l'arrivée des
 *      paquets) : de la fin de la parole de la personne au début de la réponse parlée. Cible : 1,5 s au p50.
 *
 * Tout ce qui touche le navigateur (micro, `RTCPeerConnection`, l'horloge) est INJECTABLE : le banc rejoue un flux
 * d'événements sans réseau ni micro.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type EtatVoix = "INACTIF" | "CONNEXION" | "ECOUTE" | "REFLEXION" | "PAROLE" | "FERMETURE" | "ERREUR" | "TERMINE";

export interface ResultatDelegation {
  /** Ce que la voix reçoit (et paraphrase) : jamais une valeur que la personne n'a pas le droit d'entendre. */
  pourVoix: string;
  /** Une carte préparée — résumée à l'oral ; l'écran la montre aussi. */
  carte?: unknown;
  /** La réponse écrite de l'assistant — pour la conversation (l'écran n'est jamais requis). */
  ecran?: string | null;
  /** K9 : un travail lancé, que ce client suit jusqu'au résultat. */
  travail?: string;
  /** K9 : la carte a changé d'état à l'oral (exécutée, abandonnée). */
  etatCarte?: { intentId: string; status: string };
  /** K9 : une commande que ce client applique (« stop », « plus court »). */
  commande?: "stop" | "plus_court";
}

/** K9 : l'état d'un travail suivi. */
export type SuiviTravail =
  | { etat: "en_cours"; etapes?: string[] }
  | ({ etat: "pret" } & ResultatDelegation)
  | { etat: "echec"; pourVoix: string }
  | { etat: "remplace"; par: string }
  | { etat: "inconnu" };

export interface Rappels {
  etat?: (e: EtatVoix, detail?: string) => void;
  /** Une réplique complète : ce que la personne a dit, ou ce que l'assistant a répondu. */
  ligne?: (qui: "personne" | "assistant", texte: string) => void;
  delegation?: (demande: string, r: ResultatDelegation) => void;
  latence?: (ms: number) => void;
  /** K9 : un travail est suivi (vrai) ou terminé (faux) — l'écran dit « je regarde… ». */
  travail?: (enCours: boolean) => void;
}

export interface DependancesClient {
  /** Remet l'offre SDP à NOTRE serveur, qui ouvre la session et rend la réponse SDP (K9 : l'identifiant, les reprises). */
  ouvrir: (sdp: string) => Promise<{ sdp: string; session?: string; reprises?: string[] }>;
  /**
   * `ctx.parole` (K4) : ce que la personne a RÉELLEMENT dit depuis la délégation précédente — vide si rien de neuf (la
   * demande est alors la précédente, répétée) : le serveur n'entend jamais un « oui » répété. `session`, `enCours` (K9) :
   * la session vocale, et le travail suivi auquel une précision s'ajoute.
   */
  deleguer: (demande: string, delegationId: string, ctx?: { session: string | null; enCours: string | null; parole: string }) => Promise<ResultatDelegation>;
  /** K9 : l'état d'un travail lancé par une délégation. */
  suivre?: (travail: string, session: string | null) => Promise<SuiviTravail>;
  /** K9 : l'intervalle de suivi d'un travail (1,5 s ; 0 au banc : le banc appelle `suivreMaintenant`). */
  suiviMs?: number;
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
  private audio: HTMLAudioElement | null = null;
  /** K9 : l'identifiant de la session vocale (rendu par notre serveur) et ce qui est à dire en ouvrant. */
  session: string | null = null;
  private reprises: string[] = [];
  /** K9 : le travail suivi, et la délégation sous laquelle son résultat sera dit. */
  travail: { id: string; delegationId: string } | null = null;
  private suivi: ReturnType<typeof setInterval> | null = null;
  private suiviEnVol = false;
  /** K9 : le son coupé parce que la personne parle (barge-in) — rouvert à la réponse suivante. */
  coupe = false;
  interruptions = 0;
  private finCoupureMs = 0;
  /** La fin (ligne de temps de la session) de la dernière parole de la voix. */
  private dernierSonMs = 0;
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
      this.audio = audio;
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
      this.session = reponse.session ?? null;
      this.reprises = reponse.reprises ?? [];
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
        // K9 : ce qui est arrivé après la dernière session — dit en ouvrant, sans délégation.
        for (const r of this.reprises.splice(0)) this.dire(null, `Résultat arrivé depuis la dernière conversation : ${r}`);
        break;
      case "session.input_transcript.delta":
        // K9 — BARGE-IN : la personne parle pendant que la voix parle → le son est coupé ICI, tout de suite.
        if (this._etat === "PAROLE" && !this.coupe) this.couperSon(e.start_ms);
        if (this.parleur !== "personne") { this.finirReplique(); this.parleur = "personne"; }
        this.replique += e.delta ?? "";
        this.demande += e.delta ?? "";
        this.dernierFragment = Date.now();
        if (typeof e.end_ms === "number") this.finParoleMs = e.end_ms;
        this.reponseAttendue = true;
        if (this._etat !== "FERMETURE") this.poser("ECOUTE");
        break;
      case "session.output_transcript.delta":
        // La réponse suivante (après l'interruption) rouvre le son.
        if (this.coupe && typeof e.start_ms === "number" && e.start_ms >= this.finCoupureMs) this.rouvrirSon();
        if (typeof e.end_ms === "number") this.dernierSonMs = Math.max(this.dernierSonMs, e.end_ms);
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
    // K9 : la transcription d'un « oui » court peut arriver APRÈS la délégation, au-delà de 1,5 s (relevé par K4) — rien
    // de neuf entendu : on attend son premier fragment jusqu'à 4 s, puis le silence habituel.
    const premier = Date.now() + (silence > 0 ? 4_000 : 0);
    while (!this.demande.trim() && Date.now() < premier) await new Promise((r) => setTimeout(r, 100));
    for (const limite = Date.now() + 1_500; silence > 0 && Date.now() < limite && Date.now() - this.dernierFragment < silence;) {
      await new Promise((r) => setTimeout(r, 100));
    }
    // La demande : ce que la personne a dit depuis la délégation précédente (sinon sa dernière demande, reformulée).
    const parole = this.demande.trim().slice(0, 2_000);
    const demande = (parole || this.derniereDemande).slice(0, 4_000);
    this.demande = "";
    this.derniereDemande = demande;
    this.delegations += 1;
    if (this._etat !== "FERMETURE") this.poser("REFLEXION");
    let r: ResultatDelegation;
    try {
      r = await this.deps.deleguer(demande, delegationId, { session: this.session, enCours: this.travail?.id ?? null, parole });
    } catch {
      r = { pourVoix: "Le serveur n'a pas répondu : dis-le simplement et propose de réessayer." };
    }
    this.rappels.delegation?.(demande, r);
    if (r.commande) this.appliquer(r.commande);
    // « stop » : on ne relance pas la parole — le résultat reste silencieux (contexte seulement).
    if (r.commande === "stop") this.envoyer({ type: "session.thinking.append", event_id: `resultat_${++this.numero}`, delegation_id: delegationId, content: r.pourVoix.slice(0, MAX_COMMENTAIRE) });
    else this.dire(delegationId, r.pourVoix || "Rien à dire de plus.");
    if (r.travail) this.suivreTravail(r.travail, delegationId);
  }

  /** Dit (la voix paraphrase) — sous une délégation, ou pour toute la session (`null`). */
  private dire(delegationId: string | null, contenu: string) {
    const id = `resultat_${++this.numero}`;
    this.envoyer({ type: "session.commentary.append", event_id: id, delegation_id: delegationId, content: contenu.slice(0, MAX_COMMENTAIRE) });
  }

  /** « stop » : la voix se tait (interruption) ; « plus court » : la consigne vaut pour toute la suite de la session. */
  private appliquer(c: "stop" | "plus_court") {
    if (c === "stop") {
      // Coupé jusqu'à une parole qui commence APRÈS ce qui était en cours.
      this.couperSon(this.dernierSonMs + 1);
      this.envoyer({ type: "session.instructions.append", event_id: `consigne_${++this.numero}`, delegation_id: null, content: "La personne a dit stop : arrête de parler maintenant et attends qu'elle reparle." });
    } else {
      this.envoyer({ type: "session.instructions.append", event_id: `consigne_${++this.numero}`, delegation_id: null, content: "Désormais, réponds en une phrase : la réponse d'abord, sans détail sauf si la personne le demande." });
    }
  }

  private couperSon(depuisMs?: number) {
    this.coupe = true;
    this.interruptions += 1;
    this.finCoupureMs = typeof depuisMs === "number" ? depuisMs : 0;
    if (this.audio) this.audio.muted = true;
  }

  private rouvrirSon() {
    this.coupe = false;
    if (this.audio) this.audio.muted = false;
  }

  /** K9 : suivre un travail lancé — son résultat sera dit sous la DERNIÈRE délégation qui le concerne. */
  private suivreTravail(id: string, delegationId: string) {
    this.travail = { id, delegationId };
    this.rappels.travail?.(true);
    const ms = this.deps.suiviMs ?? 1_500;
    if (ms > 0 && !this.suivi) this.suivi = setInterval(() => { void this.suivreMaintenant(); }, ms);
  }

  /** Une lecture de l'état du travail suivi. Public pour le banc. */
  async suivreMaintenant(): Promise<void> {
    const t = this.travail;
    if (!t || !this.deps.suivre || this.suiviEnVol) return;
    this.suiviEnVol = true;
    try {
      let s: SuiviTravail;
      // Un suivi qui échoue (réseau) se retente au battement suivant : le travail est toujours « en cours ».
      try { s = await this.deps.suivre(t.id, this.session); } catch { s = { etat: "en_cours" }; }
      if (this.travail?.id !== t.id) return;
      if (s.etat === "remplace") { this.travail = { id: s.par, delegationId: t.delegationId }; return; }
      if (s.etat === "en_cours") return;
      this.arreterSuivi();
      if (s.etat === "inconnu") return;
      if (s.etat === "pret") this.rappels.delegation?.(this.derniereDemande, s);
      this.dire(t.delegationId, s.pourVoix || "Le résultat est arrivé, sans rien à dire de plus.");
    } finally {
      this.suiviEnVol = false;
    }
  }

  private arreterSuivi() {
    if (this.suivi) clearInterval(this.suivi);
    this.suivi = null;
    this.travail = null;
    this.rappels.travail?.(false);
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
    if (this.suivi) clearInterval(this.suivi);
    this.suivi = null;
    try { this.dc?.close(); } catch { /* déjà fermé */ }
    try { this.pc?.close(); } catch { /* déjà fermé */ }
    for (const t of this.micro?.getTracks() ?? []) t.stop();
    this.dc = null;
    this.pc = null;
    this.micro = null;
  }
}
