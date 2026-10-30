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
