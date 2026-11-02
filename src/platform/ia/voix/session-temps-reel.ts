/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA SESSION VOCALE GPT-LIVE — côté SERVEUR, au socle IA (lot J13, décision 0025). Zéro import.
 *
 * GPT-Live (décision de Direction du 30/10 : `gpt-live-1` seul, sans modèle de secours) tient la CONVERSATION ; le
 * travail est DÉLÉGUÉ à notre serveur (délégation « client ») : c'est notre assistant, sous les droits de la personne,
 * qui lit, prépare les cartes et rend le résultat que la voix dit.
 *
 * L'ÉCHANGE SE FAIT ICI, PAS DANS LE NAVIGATEUR : le navigateur crée son offre WebRTC (SDP), notre serveur la remet à
 * `POST /v1/live/sessions` avec la clé du projet et la configuration (modèle, consignes, voix, délégation), et rend la
 * réponse SDP. Aucun secret — même éphémère — n'atteint le navigateur ; un client trafiqué ne peut ni changer de modèle
 * ni réécrire les consignes. Le fournisseur se joint par un `fetch` injectable : le banc tient le contrat sans réseau.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const URL_SESSIONS_LIVE = "https://api.openai.com/v1/live/sessions";

export interface DemandeSessionLive {
  cle: string;
  modele: string;
  /** Les consignes de CONVERSATION (16 384 jetons au plus) — les règles métier vivent dans l'assistant délégué. */
  instructions: string;
  voix: string;
  /** L'offre SDP du navigateur. */
  sdp: string;
  /** Délai avant l'accusé automatique d'une délégation (« je regarde ») — laissé au modèle par défaut. */
  delaiAccuseMs?: number | null;
  fetchImpl?: typeof fetch;
  url?: string;
}

export type SessionLiveOuverte = { ok: true; id: string; sdp: string; modele: string };
export type SessionLiveRefusee = { ok: false; erreur: string; statut: number };

/** Le corps envoyé au fournisseur — exporté pour que le banc vérifie ce qui part (modèle, délégation, pas de format audio). */
export function corpsSessionLive(d: DemandeSessionLive): Record<string, unknown> {
  return {
    session: {
      model: d.modele,
      instructions: d.instructions,
      // WebRTC négocie le format audio dans le SDP : `audio.format` ne s'envoie pas.
      audio: { output: { voice: d.voix } },
      delegation: { type: "client", ...(d.delaiAccuseMs != null ? { acknowledgement_delay_ms: d.delaiAccuseMs } : {}) },
    },
    transport: { type: "webrtc", sdp: d.sdp },
  };
}

export async function ouvrirSessionLive(d: DemandeSessionLive): Promise<SessionLiveOuverte | SessionLiveRefusee> {
  if (!d.cle) return { ok: false, erreur: "La conversation vocale n'est pas configurée (clé du fournisseur absente).", statut: 503 };
  if (!d.sdp?.trim() || d.sdp.length > 200_000) return { ok: false, erreur: "Offre de connexion invalide.", statut: 400 };
  const f = d.fetchImpl ?? fetch;
  const indisponible = `Le modèle vocal ${d.modele} ne répond pas : la conversation vocale est indisponible pour le moment.`;
  try {
    const res = await f(d.url ?? URL_SESSIONS_LIVE, {
      method: "POST",
      headers: { Authorization: `Bearer ${d.cle}`, "Content-Type": "application/json" },
      body: JSON.stringify(corpsSessionLive(d)),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      let detail = "";
      try { detail = await res.text(); } catch (e) { detail = `corps illisible : ${e instanceof Error ? e.message : String(e)}`; }
      console.error("[voix] session GPT-Live refusée", res.status, detail.slice(0, 300));
      return { ok: false, erreur: indisponible, statut: 502 };
    }
    const data = (await res.json()) as { session?: { id?: string }; transport?: { sdp?: string } };
    if (!data.session?.id || !data.transport?.sdp) return { ok: false, erreur: indisponible, statut: 502 };
    return { ok: true, id: data.session.id, sdp: data.transport.sdp, modele: d.modele };
  } catch (e) {
    console.error("[voix] session GPT-Live : réseau", e instanceof Error ? e.message : e);
    return { ok: false, erreur: indisponible, statut: 502 };
  }
}
