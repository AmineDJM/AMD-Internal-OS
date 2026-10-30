import { describe, expect, it } from "vitest";
import { corpsSession, ouvrirSessionTempsReel } from "./session-temps-reel";
import { ClientVoixTempsReel, type ResultatOutilVocal } from "./client-temps-reel";

/**
 * LE SOCLE DE LA VOIX TEMPS RÉEL (lot J13) — sans réseau ni micro : le fournisseur est un `fetch` injecté, le flux
 * d'événements est rejoué. On tient : la clé ne part qu'au serveur du fournisseur ; la session porte les outils et la
 * langue non forcée ; la latence se mesure de la fin de la parole au premier son, hors tours d'outil ; un appel
 * d'outil va au serveur et son résultat revient au modèle, suivi d'une nouvelle réponse.
 */
describe("session temps réel (serveur)", () => {
  const base = { cle: "sk-banc", modele: "gpt-realtime-2.1", instructions: "Consignes", outils: [{ type: "function" as const, name: "directory_lookup", description: "d", parameters: {} }], voix: "marin", transcription: "gpt-transcribe" };

  it("le corps : modèle, outils, transcription sans langue forcée, VAD sémantique", () => {
    const c = corpsSession({ ...base, langue: null }) as { session: { tools: unknown[]; audio: { input: { transcription: Record<string, unknown>; turn_detection: { type: string } } } } };
    expect(c.session.tools).toHaveLength(1);
    expect(c.session.audio.input.transcription).toEqual({ model: "gpt-transcribe" });
    expect(c.session.audio.input.turn_detection.type).toBe("semantic_vad");
  });

  it("rend le secret éphémère ; la clé n'est envoyée qu'au fournisseur ; sans clé, refus 503", async () => {
    const vus: { url: string; auth: string }[] = [];
    const f = (async (url: string | URL, init?: RequestInit) => {
      vus.push({ url: String(url), auth: String((init?.headers as Record<string, string>).Authorization) });
      return Response.json({ value: "ek_123", expires_at: 99 });
    }) as typeof fetch;
    const s = await ouvrirSessionTempsReel({ ...base, fetchImpl: f });
    expect(s).toMatchObject({ ok: true, secret: "ek_123", expireA: 99 });
    expect(vus[0]).toEqual({ url: "https://api.openai.com/v1/realtime/client_secrets", auth: "Bearer sk-banc" });
    expect(await ouvrirSessionTempsReel({ ...base, cle: "" })).toMatchObject({ ok: false, statut: 503 });
    const panne = (async () => new Response("non", { status: 500 })) as typeof fetch;
    expect(await ouvrirSessionTempsReel({ ...base, fetchImpl: panne })).toMatchObject({ ok: false, statut: 502 });
  });
});

describe("client temps réel (navigateur) — flux rejoué", () => {
  function client(executer: (n: string, a: Record<string, unknown>) => Promise<ResultatOutilVocal>) {
    let t = 0;
    const envoyes: Record<string, unknown>[] = [];
    const lignes: string[] = [];
    const c = new ClientVoixTempsReel({ executer, maintenant: () => t }, { ligne: (q, x) => lignes.push(`${q}:${x}`) });
    // Le canal de données, ouvert, sans WebRTC.
    (c as unknown as { dc: { readyState: string; send: (s: string) => void } }).dc = { readyState: "open", send: (s) => envoyes.push(JSON.parse(s)) };
    return { c, envoyes, lignes, avancer: (ms: number) => { t += ms; } };
  }
  const ev = (o: Record<string, unknown>) => JSON.stringify(o);

  it("mesure la latence (fin de parole → premier son) et en tient la médiane", async () => {
    const { c, avancer } = client(async () => ({ pourModele: "" }));
    for (const ms of [900, 1300, 2100]) {
      await c.recevoir(ev({ type: "input_audio_buffer.speech_stopped" }));
      avancer(ms);
      await c.recevoir(ev({ type: "output_audio_buffer.started" }));
      await c.recevoir(ev({ type: "response.output_audio.delta" })); // un second signal ne compte pas deux fois
    }
    expect(c.latences).toEqual([900, 1300, 2100]);
  });

  it("un appel d'outil part au serveur, son résultat revient au modèle, puis une réponse ; le tour d'outil n'est pas une latence", async () => {
    const appels: [string, Record<string, unknown>][] = [];
    const { c, envoyes, lignes, avancer } = client(async (n, a) => { appels.push([n, a]); return { pourModele: '{"ok":1}', carte: { title: "Carte" } }; });
    await c.recevoir(ev({ type: "conversation.item.input_audio_transcription.completed", transcript: "Prépare le compte rendu" }));
    await c.recevoir(ev({ type: "input_audio_buffer.speech_stopped" }));
    await c.recevoir(ev({ type: "response.function_call_arguments.done", call_id: "c1", name: "terrain_compte_rendu", arguments: '{"synthese":"x"}' }));
    avancer(4000);
    await c.recevoir(ev({ type: "output_audio_buffer.started" }));
    await c.recevoir(ev({ type: "response.output_audio_transcript.done", transcript: "La carte est affichée." }));
    await c.recevoir(ev({ type: "response.done", response: { usage: { input_tokens: 120, output_tokens: 30 } } }));
    expect(appels).toEqual([["terrain_compte_rendu", { synthese: "x" }]]);
    expect(envoyes).toEqual([
      { type: "conversation.item.create", item: { type: "function_call_output", call_id: "c1", output: '{"ok":1}' } },
      { type: "response.create" },
    ]);
    expect(c.latences).toEqual([]);
    expect(lignes).toEqual(["personne:Prépare le compte rendu", "assistant:La carte est affichée."]);
    expect(c.consommation).toEqual({ entree: 120, sortie: 30, reponses: 1 });
  });

  it("un outil qui échoue rend une phrase au modèle, jamais un silence", async () => {
    const { c, envoyes } = client(async () => { throw new Error("réseau"); });
    await c.recevoir(ev({ type: "response.function_call_arguments.done", call_id: "c2", name: "x", arguments: "{cassé" }));
    expect(String((envoyes[0].item as { output: string }).output)).toContain("ECHEC");
  });
});
