import { describe, expect, it } from "vitest";
import { corpsSessionLive, ouvrirSessionLive } from "./session-temps-reel";
import { ClientVoixTempsReel, type ResultatDelegation } from "./client-temps-reel";

/**
 * LE SOCLE DE LA VOIX GPT-LIVE (lot J13) — sans réseau ni micro : le fournisseur est un `fetch` injecté, le flux
 * d'événements est rejoué. On tient : la clé ne part qu'au fournisseur, depuis le serveur ; la session est en
 * délégation « client », sans format audio (WebRTC le négocie) ; une délégation part à NOTRE serveur avec ce que la
 * personne a dit, et son résultat revient par `session.commentary.append` sous le même identifiant ; la latence se lit
 * sur la ligne de temps de la session ; on raccroche en attendant la consommation finale.
 */
describe("session GPT-Live (serveur)", () => {
  const base = { cle: "sk-banc", modele: "gpt-live-1", instructions: "Consignes", voix: "marin", sdp: "v=0 offre" };

  it("le corps : modèle, consignes, voix, délégation client, transport WebRTC — pas de format audio", () => {
    expect(corpsSessionLive(base)).toEqual({
      session: { model: "gpt-live-1", instructions: "Consignes", audio: { output: { voice: "marin" } }, delegation: { type: "client" } },
      transport: { type: "webrtc", sdp: "v=0 offre" },
    });
  });

  it("rend la réponse SDP ; la clé ne va qu'au fournisseur ; sans clé 503 ; sans secours, l'échec est dit", async () => {
    const vus: { url: string; auth: string }[] = [];
    const f = (async (url: string | URL, init?: RequestInit) => {
      vus.push({ url: String(url), auth: String((init?.headers as Record<string, string>).Authorization) });
      return Response.json({ session: { id: "live_1" }, transport: { type: "webrtc", sdp: "v=0 réponse" } }, { status: 201 });
    }) as typeof fetch;
    expect(await ouvrirSessionLive({ ...base, fetchImpl: f })).toEqual({ ok: true, id: "live_1", sdp: "v=0 réponse", modele: "gpt-live-1" });
    expect(vus).toEqual([{ url: "https://api.openai.com/v1/live/sessions", auth: "Bearer sk-banc" }]);
    expect(await ouvrirSessionLive({ ...base, cle: "" })).toMatchObject({ ok: false, statut: 503 });
    expect(await ouvrirSessionLive({ ...base, sdp: " " })).toMatchObject({ ok: false, statut: 400 });
    const panne = (async () => new Response("non", { status: 500 })) as typeof fetch;
    expect(await ouvrirSessionLive({ ...base, fetchImpl: panne })).toMatchObject({ ok: false, statut: 502, erreur: expect.stringContaining("gpt-live-1 ne répond pas") });
  });
});

describe("client GPT-Live (navigateur) — flux rejoué", () => {
  function client(deleguer: (d: string, id: string) => Promise<ResultatDelegation>) {
    const envoyes: Record<string, unknown>[] = [];
    const lignes: string[] = [];
    const c = new ClientVoixTempsReel({ ouvrir: async () => ({ sdp: "" }), deleguer, attendreFermetureMs: 50, silenceTranscriptionMs: 0 }, { ligne: (q, x) => lignes.push(`${q}:${x}`) });
    (c as unknown as { dc: { readyState: string; send: (s: string) => void; close: () => void } }).dc = { readyState: "open", send: (s) => envoyes.push(JSON.parse(s)), close: () => {} };
    return { c, envoyes, lignes };
  }
  const ev = (o: Record<string, unknown>) => JSON.stringify(o);

  it("latence sur la ligne de temps : fin de la parole → début de la réponse, une fois par tour", async () => {
    const { c } = client(async () => ({ pourVoix: "" }));
    for (const [fin, debut] of [[1000, 1900], [5000, 6300], [9000, 11100]]) {
      await c.recevoir(ev({ type: "session.input_transcript.delta", delta: "question ", start_ms: fin - 500, end_ms: fin }));
      await c.recevoir(ev({ type: "session.output_transcript.delta", delta: "réponse ", start_ms: debut, end_ms: debut + 300 }));
      await c.recevoir(ev({ type: "session.output_transcript.delta", delta: "suite", start_ms: debut + 300, end_ms: debut + 600 }));
    }
    expect(c.latences).toEqual([900, 1300, 2100]);
  });

  it("une délégation : la demande dite part au serveur, le résultat revient sous le même identifiant", async () => {
    const appels: [string, string][] = [];
    const { c, envoyes, lignes } = client(async (d, id) => { appels.push([d, id]); return { pourVoix: "La carte est affichée.", carte: { title: "Compte rendu" } }; });
    await c.recevoir(ev({ type: "session.input_transcript.delta", delta: "Prépare le compte rendu ", start_ms: 0, end_ms: 800 }));
    await c.recevoir(ev({ type: "session.input_transcript.delta", delta: "du Dr Benali.", start_ms: 800, end_ms: 1500 }));
    await c.recevoir(ev({ type: "session.delegation.created", offset_ms: 1600, delegation: { id: "item_1", type: "delegation", target: "client" } }));
    await c.recevoir(ev({ type: "session.output_transcript.delta", delta: "La carte est affichée.", start_ms: 4000, end_ms: 5000 }));
    expect(appels).toEqual([["Prépare le compte rendu du Dr Benali.", "item_1"]]);
    expect(envoyes).toEqual([{ type: "session.commentary.append", event_id: "resultat_1", delegation_id: "item_1", content: "La carte est affichée." }]);
    expect(lignes).toEqual(["personne:Prépare le compte rendu du Dr Benali."]);
    expect(c.delegations).toBe(1);
  });

  it("un serveur muet : une phrase revient quand même à la voix, jamais un silence", async () => {
    const { c, envoyes } = client(async () => { throw new Error("réseau"); });
    await c.recevoir(ev({ type: "session.delegation.created", delegation: { id: "item_2", target: "client" } }));
    expect(String(envoyes[0].content)).toContain("n'a pas répondu");
  });

  it("raccrocher : session.close, puis la consommation finale de session.closed", async () => {
    const { c, envoyes } = client(async () => ({ pourVoix: "" }));
    await c.recevoir(ev({ type: "session.usage.updated", usage: { seconds: 12 } }));
    const fin = c.fermer();
    await c.recevoir(ev({ type: "session.closed", usage: { seconds: 15 } }));
    await fin;
    expect(envoyes).toEqual([{ type: "session.close" }]);
    expect(c.secondes).toBe(15);
    expect(c.usageConfirme).toBe(true);
    expect(c.etat).toBe("TERMINE");
  });
});

describe("la délégation attend la fin de la phrase", () => {
  it("un fragment qui arrive juste après la délégation fait partie de la demande", async () => {
    const appels: string[] = [];
    const c = new ClientVoixTempsReel({ ouvrir: async () => ({ sdp: "" }), deleguer: async (d) => { appels.push(d); return { pourVoix: "ok" }; }, silenceTranscriptionMs: 300 });
    (c as unknown as { dc: { readyState: string; send: () => void } }).dc = { readyState: "open", send: () => {} };
    await c.recevoir(JSON.stringify({ type: "session.input_transcript.delta", delta: "Qui est ", start_ms: 0, end_ms: 400 }));
    const d = c.recevoir(JSON.stringify({ type: "session.delegation.created", delegation: { id: "item_9", target: "client" } }));
    await c.recevoir(JSON.stringify({ type: "session.input_transcript.delta", delta: "Assia ?", start_ms: 400, end_ms: 800 }));
    await d;
    expect(appels).toEqual(["Qui est Assia ?"]);
  });
});

describe("K9 — la voix entièrement orale (flux rejoué)", () => {
  type Envoye = Record<string, unknown>;
  function client(deps: Partial<ConstructorParameters<typeof ClientVoixTempsReel>[0]>) {
    const envoyes: Envoye[] = [];
    const c = new ClientVoixTempsReel({ ouvrir: async () => ({ sdp: "" }), deleguer: async () => ({ pourVoix: "" }), silenceTranscriptionMs: 0, suiviMs: 0, ...deps });
    (c as unknown as { dc: { readyState: string; send: (s: string) => void; close: () => void } }).dc = { readyState: "open", send: (s) => envoyes.push(JSON.parse(s)), close: () => {} };
    return { c, envoyes };
  }
  const ev = (o: Record<string, unknown>) => JSON.stringify(o);
  const dire = (texte: string, debut: number) => ({ type: "session.input_transcript.delta", delta: texte, start_ms: debut, end_ms: debut + 600 });

  it("la délégation ne bloque pas : « je regarde » tout de suite ; la précision part au travail EN COURS ; le résultat est dit de lui-même", async () => {
    const appels: { demande: string; enCours: string | null; session: string | null }[] = [];
    let etat: "en_cours" | "pret" = "en_cours";
    const { c, envoyes } = client({
      deleguer: async (demande, _id, ctx) => {
        appels.push({ demande, enCours: ctx?.enCours ?? null, session: ctx?.session ?? null });
        return ctx?.enCours ? { pourVoix: "Précision transmise.", travail: "t2" } : { pourVoix: "Travail lancé.", travail: "t1" };
      },
      suivre: async (t) => (t === "t1" ? { etat: "remplace", par: "t2" } : etat === "pret" ? { etat: "pret", pourVoix: "À Oran : environ 3,1 millions." } : { etat: "en_cours" }),
    });
    c.session = "live_x";
    await c.recevoir(ev(dire("Le CA des ventes ", 0)));
    await c.recevoir(ev({ type: "session.delegation.created", delegation: { id: "d1", target: "client" } }));
    expect(envoyes.at(-1)).toEqual({ type: "session.commentary.append", event_id: "resultat_1", delegation_id: "d1", content: "Travail lancé." });
    expect(c.travail).toEqual({ id: "t1", delegationId: "d1" });
    // La voix engage la personne ; elle précise ; c'est transmis au travail en cours.
    await c.recevoir(ev(dire("seulement Oran", 3000)));
    await c.recevoir(ev({ type: "session.delegation.created", delegation: { id: "d2", target: "client" } }));
    expect(appels).toEqual([{ demande: "Le CA des ventes", enCours: null, session: "live_x" }, { demande: "seulement Oran", enCours: "t1", session: "live_x" }]);
    expect(c.travail).toEqual({ id: "t2", delegationId: "d2" });
    await c.suivreMaintenant();
    expect(envoyes).toHaveLength(2);
    etat = "pret";
    await c.suivreMaintenant();
    // Deux minutes plus tard ou dix secondes : le résultat est injecté sous la dernière délégation, sans qu'on le demande.
    expect(envoyes.at(-1)).toEqual({ type: "session.commentary.append", event_id: "resultat_3", delegation_id: "d2", content: "À Oran : environ 3,1 millions." });
    expect(c.travail).toBeNull();
  });

  it("le résumé d'une carte : signalé au serveur quand il a été DIT (accusé du fournisseur), pas avant", async () => {
    const dits: string[] = [];
    const { c } = client({
      deleguer: async () => ({ pourVoix: "Carte préparée : créer la tâche « Stand ». C'est bon ?", resumeDe: { intentId: "i1", empreinte: "e1" } }),
      resumeDit: async (r) => { dits.push(`${r.intentId}:${r.empreinte}`); },
    });
    await c.recevoir(ev({ type: "session.delegation.created", delegation: { id: "d1", target: "client" } }));
    expect(dits).toEqual([]);
    await c.recevoir(ev({ type: "session.commentary.appended", client_event_id: "autre" }));
    expect(dits).toEqual([]);
    await c.recevoir(ev({ type: "session.commentary.appended", client_event_id: "resultat_1" }));
    expect(dits).toEqual(["i1:e1"]);
  });

  it("couper la parole (barge-in) : le son est coupé AU NAVIGATEUR dès que la personne parle, rouvert à la réponse suivante", async () => {
    const haut = { muted: false, autoplay: true, srcObject: null } as unknown as HTMLAudioElement;
    const { c } = client({});
    (c as unknown as { audio: HTMLAudioElement }).audio = haut;
    await c.recevoir(ev(dire("Bonjour", 0)));
    await c.recevoir(ev({ type: "session.output_transcript.delta", delta: "Voici une longue réponse ", start_ms: 1000, end_ms: 4000 }));
    expect(c.etat).toBe("PAROLE");
    await c.recevoir(ev(dire("attends", 2500)));
    expect(haut.muted).toBe(true);
    expect(c.interruptions).toBe(1);
    await c.recevoir(ev({ type: "session.output_transcript.delta", delta: "D'accord.", start_ms: 4200, end_ms: 4800 }));
    expect(haut.muted).toBe(false);
  });

  it("« stop » : la voix se tait (consigne d'interruption, aucun nouveau commentaire) ; « plus court » vaut pour la suite", async () => {
    const { c, envoyes } = client({ deleguer: async (d) => (d === "stop" ? { pourVoix: "Tais-toi.", commande: "stop" } : { pourVoix: "Une phrase.", commande: "plus_court" }) });
    await c.recevoir(ev(dire("stop", 0)));
    await c.recevoir(ev({ type: "session.delegation.created", delegation: { id: "d1", target: "client" } }));
    expect(envoyes.map((e) => e.type)).toEqual(["session.instructions.append", "session.thinking.append"]);
    expect(c.coupe).toBe(true);
    await c.recevoir(ev(dire("plus court", 2000)));
    await c.recevoir(ev({ type: "session.delegation.created", delegation: { id: "d2", target: "client" } }));
    expect(envoyes.slice(2).map((e) => e.type)).toEqual(["session.instructions.append", "session.commentary.append"]);
    expect(String(envoyes[2].content)).toContain("une phrase");
  });

  it("la reprise : ce qui est arrivé après la dernière session est dit à l'ouverture", async () => {
    const { c, envoyes } = client({});
    (c as unknown as { reprises: string[] }).reprises = ["Ton rendez-vous de jeudi est confirmé."];
    await c.recevoir(ev({ type: "session.started" }));
    expect(envoyes).toEqual([{ type: "session.commentary.append", event_id: "resultat_1", delegation_id: null, content: "Résultat arrivé depuis la dernière conversation : Ton rendez-vous de jeudi est confirmé." }]);
  });
});
