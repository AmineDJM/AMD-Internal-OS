import { createHmac, timingSafeEqual } from "node:crypto";
import { lireNotificationWhatsApp, nomDuMedia, telechargerMediaWhatsApp, type ConfigWhatsApp } from "./whatsapp";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE PORT DU CANAL ENTRANT (lot K6, décision 0036) — un message reçu, quel que soit le transport.
 *
 * Aucune réception WhatsApp n'existe dans le dépôt (vérifié le 31/10/2026 : ni route, ni `IngestedEvent`, ni
 * `/api/events/inbound/generic` qui transporte des médias). Si un service extérieur relie aujourd'hui le WhatsApp de la
 * Direction (Make, n8n, Twilio…), il se branche ICI : chaque transport est un ADAPTATEUR qui rend des `MessageEntrant` —
 *   • `messagesDepuisMeta` : l'API Cloud de Meta (webhook `/api/canaux/whatsapp`) ;
 *   • `messagesDepuisRelais` : un relais (Make, n8n, Twilio) qui poste un JSON simple, signé (`/api/canaux/relais`).
 * Le module (`recevoirPieces`) ne connaît que le message : expéditeur, identifiant, texte, pièces à charger.
 * Zéro import de l'ERP.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type ChargementPiece = { ok: true; octets: Buffer; mime: string | null } | { ok: false; raison: string };

export interface PieceEntrante {
  nom: string;
  mime: string | null;
  /** Le contenu, chargé SEULEMENT une fois l'expéditeur reconnu (un inconnu ne fait rien télécharger). */
  charger: () => Promise<ChargementPiece>;
}

export interface MessageEntrant {
  canal: "WHATSAPP";
  /** La clé d'idempotence (`wamid…`, identifiant du relais). */
  id: string;
  /** Le numéro de l'expéditeur, chiffres seuls. */
  de: string;
  texte: string;
  pieces: PieceEntrante[];
}

export const TAILLE_MAX_PIECE_ENTRANTE = 25 * 1024 * 1024;

/** L'adaptateur Meta (API Cloud) : la notification → des messages, médias téléchargés à la demande. */
export function messagesDepuisMeta(charge: unknown, cfg: ConfigWhatsApp | null): MessageEntrant[] {
  return lireNotificationWhatsApp(charge).map((m) => ({
    canal: "WHATSAPP" as const, id: m.id, de: m.de, texte: m.texte,
    pieces: m.media ? [{
      nom: nomDuMedia(m), mime: m.media.mime,
      charger: async (): Promise<ChargementPiece> => {
        if (!cfg) return { ok: false, raison: "WhatsApp n'est pas configuré pour télécharger les médias (WHATSAPP_TOKEN)" };
        const t = await telechargerMediaWhatsApp(cfg, m.media!.id, TAILLE_MAX_PIECE_ENTRANTE);
        return t.ok ? { ok: true, octets: t.octets, mime: t.mime ?? m.media!.mime } : { ok: false, raison: t.raison };
      },
    }] : [],
  }));
}

// ─────────────────────────────── L'adaptateur « relais » ───────────────────────────────

/** La signature d'un relais : HMAC-SHA256 hexadécimal du corps brut (« sha256=… » accepté). */
export function signatureRelaisValide(brut: string, entete: string | null | undefined, secret: string): boolean {
  if (!secret || !entete) return false;
  const recue = entete.trim().replace(/^sha256=/i, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(recue)) return false;
  return timingSafeEqual(Buffer.from(createHmac("sha256", secret).update(brut, "utf8").digest("hex"), "hex"), Buffer.from(recue, "hex"));
}

const objet = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {});
const texte = (v: unknown): string => (typeof v === "string" ? v : "");

async function chargerUrl(url: string, fetchImpl: typeof fetch): Promise<ChargementPiece> {
  // Seulement du HTTPS public : jamais une adresse interne que le serveur irait lire pour un tiers.
  let u: URL;
  try { u = new URL(url); } catch { return { ok: false, raison: "adresse du média illisible" }; }
  if (u.protocol !== "https:" || /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1)/i.test(u.hostname)) {
    return { ok: false, raison: "adresse du média refusée (HTTPS public seulement)" };
  }
  let r: Response;
  try { r = await fetchImpl(u.toString()); } catch { return { ok: false, raison: "média injoignable" }; }
  if (!r.ok) return { ok: false, raison: `média refusé (${r.status})` };
  const octets = Buffer.from(await r.arrayBuffer());
  if (octets.length > TAILLE_MAX_PIECE_ENTRANTE) return { ok: false, raison: "fichier trop volumineux" };
  return { ok: true, octets, mime: r.headers.get("content-type") };
}

/**
 * Le JSON d'un relais : `{ id, de, texte?, pieces?: [{ nom, mime?, base64? | url? }] }` — ou une liste de tels messages
 * (`{ messages: [...] }`). Un relais Twilio/Make/n8n le construit en une étape.
 */
export function messagesDepuisRelais(charge: unknown, fetchImpl: typeof fetch = fetch): MessageEntrant[] {
  const racine = objet(charge);
  const liste = Array.isArray(racine.messages) ? racine.messages : [racine];
  const out: MessageEntrant[] = [];
  for (const brut of liste.slice(0, 20)) {
    const m = objet(brut);
    const id = texte(m.id).trim();
    const de = texte(m.de ?? m.from).replace(/\D/g, "");
    if (!id || !de) continue;
    const pieces = (Array.isArray(m.pieces) ? m.pieces : []).slice(0, 10).map((p): PieceEntrante => {
      const o = objet(p);
      const nom = (texte(o.nom ?? o.name) || "piece-jointe").replace(/[\\/:*?"<>|]+/g, "_").slice(0, 180);
      const mime = texte(o.mime ?? o.contentType) || null;
      const b64 = texte(o.base64).replace(/\s+/g, "");
      const url = texte(o.url);
      return {
        nom, mime,
        charger: async (): Promise<ChargementPiece> => {
          if (b64) {
            const octets = Buffer.from(b64, "base64");
            return octets.length > TAILLE_MAX_PIECE_ENTRANTE ? { ok: false, raison: "fichier trop volumineux" } : { ok: true, octets, mime };
          }
          if (url) return chargerUrl(url, fetchImpl);
          return { ok: false, raison: "le relais n'a transmis ni contenu ni adresse" };
        },
      };
    });
    out.push({ canal: "WHATSAPP", id: `relais:${id}`.slice(0, 250), de, texte: texte(m.texte ?? m.text).slice(0, 4_000), pieces });
  }
  return out;
}
