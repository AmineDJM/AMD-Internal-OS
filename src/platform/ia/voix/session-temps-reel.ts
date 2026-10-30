/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA SESSION VOCALE TEMPS RÉEL — côté SERVEUR, au socle IA (lot J13, décision 0025). Zéro import.
 *
 * Le navigateur parle directement à l'API Realtime d'OpenAI (WebRTC) ; le serveur garde ce que rien ne délègue :
 * la CLÉ (le navigateur ne reçoit qu'un secret éphémère de quelques minutes) et la CONFIGURATION (modèle, consignes,
 * outils, transcription) — un client trafiqué ne peut ni élargir ses outils ni réécrire ses consignes.
 *
 * Partagée : Adam a la sienne (`lib/assistant/voice-realtime.ts`, inchangée) ; l'Assistant IA prend celle-ci. Le
 * fournisseur se joint par un `fetch` injectable : le banc tient le contrat sans réseau.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const URL_SECRETS_TEMPS_REEL = "https://api.openai.com/v1/realtime/client_secrets";
export const URL_APPELS_TEMPS_REEL = "https://api.openai.com/v1/realtime/calls";

export interface OutilTempsReel {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface DemandeSession {
  cle: string;
  modele: string;
  instructions: string;
  outils: OutilTempsReel[];
  voix: string;
  /** Le moteur de transcription parallèle (ce que l'écran affiche de la parole de la personne). */
  transcription: string;
  /** `null` : la langue n'est pas forcée (français et arabe dialectal mêlés). */
  langue?: string | null;
  dureeS?: number;
  fetchImpl?: typeof fetch;
  urlSecrets?: string;
}

export type SessionAccordee = { ok: true; secret: string; expireA: number | null; modele: string; voix: string; urlAppel: string };
export type SessionRefusee = { ok: false; erreur: string; statut: number };

/** Le corps envoyé au fournisseur — exporté pour que le banc vérifie ce qui part (outils, langue, consignes). */
export function corpsSession(d: DemandeSession): Record<string, unknown> {
  return {
    expires_after: { anchor: "created_at", seconds: Math.min(Math.max(d.dureeS ?? 600, 60), 1800) },
    session: {
      type: "realtime",
      model: d.modele,
      instructions: d.instructions,
      tools: d.outils,
      tool_choice: "auto",
      audio: {
        input: {
          transcription: { model: d.transcription, ...(d.langue ? { language: d.langue } : {}) },
          // VAD sémantique, empressement « auto » : la réponse part dès la fin de phrase — la cible est 1,5 s au p50.
          turn_detection: { type: "semantic_vad", eagerness: "auto", create_response: true, interrupt_response: true },
        },
        output: { voice: d.voix },
      },
    },
  };
}

export async function ouvrirSessionTempsReel(d: DemandeSession): Promise<SessionAccordee | SessionRefusee> {
  if (!d.cle) return { ok: false, erreur: "La voix temps réel n'est pas configurée (clé du fournisseur absente).", statut: 503 };
  const f = d.fetchImpl ?? fetch;
  try {
    const res = await f(d.urlSecrets ?? URL_SECRETS_TEMPS_REEL, {
      method: "POST",
      headers: { Authorization: `Bearer ${d.cle}`, "Content-Type": "application/json" },
      body: JSON.stringify(corpsSession(d)),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      let detail = "";
      try { detail = await res.text(); } catch (e) { detail = `corps illisible : ${e instanceof Error ? e.message : String(e)}`; }
      console.error("[voix] session refusée par le fournisseur", res.status, detail.slice(0, 300));
      return { ok: false, erreur: "La voix temps réel est momentanément indisponible.", statut: 502 };
    }
    const data = (await res.json()) as { value?: string; expires_at?: number };
    if (!data.value) return { ok: false, erreur: "La voix temps réel est momentanément indisponible.", statut: 502 };
    return { ok: true, secret: data.value, expireA: data.expires_at ?? null, modele: d.modele, voix: d.voix, urlAppel: URL_APPELS_TEMPS_REEL };
  } catch (e) {
    console.error("[voix] session temps réel : réseau", e instanceof Error ? e.message : e);
    return { ok: false, erreur: "La voix temps réel est momentanément indisponible (réseau).", statut: 502 };
  }
}
