import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CANAL WHATSAPP ENTRANT (lot K6, décision 0036) — l'API Cloud de Meta, côté socle.
 *
 * Zéro import de l'ERP : le webhook (`app/api/canaux/whatsapp`) l'utilise pour VÉRIFIER (signature, jeton d'abonnement),
 * LIRE (la notification → des messages simples), TÉLÉCHARGER un média (deux appels : l'URL, puis le contenu, jeton à
 * chaque fois) et RÉPONDRE en texte (accusé, refus poli). Le métier (qui est la personne, où va la pièce) est au module.
 *
 * Variables : `WHATSAPP_BASE_URL` (https://graph.facebook.com/v21.0), `WHATSAPP_PHONE_ID`, `WHATSAPP_TOKEN` (envoi et
 * médias, déjà posées pour l'envoi), `WHATSAPP_VERIFY_TOKEN` (abonnement du webhook), `WHATSAPP_APP_SECRET` (signature).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type SorteMessageWhatsApp = "document" | "image" | "audio" | "video" | "sticker" | "text" | "autre";

export interface MessageWhatsApp {
  /** `wamid.…` — la clé d'idempotence. */
  id: string;
  /** Le numéro de l'expéditeur, chiffres seuls, indicatif compris (« 213555123456 »). */
  de: string;
  nomProfil: string | null;
  sorte: SorteMessageWhatsApp;
  /** Le média joint (document, image, audio, vidéo). */
  media: { id: string; mime: string | null; nom: string | null; sha256: string | null } | null;
  /** La légende du média, ou le corps d'un message texte. */
  texte: string;
  horodatage: Date | null;
}

const SORTES_MEDIA = new Set(["document", "image", "audio", "video", "sticker"]);

/** La signature `X-Hub-Signature-256` (« sha256=<hex> ») du corps BRUT, avec le secret de l'app Meta. */
export function signatureWhatsAppValide(brut: string, entete: string | null | undefined, secret: string): boolean {
  if (!secret || !entete) return false;
  const recue = entete.trim().replace(/^sha256=/i, "");
  if (!/^[0-9a-f]{64}$/i.test(recue)) return false;
  const attendue = createHmac("sha256", secret).update(brut, "utf8").digest("hex");
  return timingSafeEqual(Buffer.from(attendue, "hex"), Buffer.from(recue.toLowerCase(), "hex"));
}

/** Signer un corps comme Meta le fait (bancs et tests). */
export const signerCommeMeta = (brut: string, secret: string): string => `sha256=${createHmac("sha256", secret).update(brut, "utf8").digest("hex")}`;

/**
 * L'ABONNEMENT DU WEBHOOK (GET) : Meta envoie `hub.mode=subscribe`, `hub.verify_token`, `hub.challenge` ; on rend le
 * défi tel quel si le jeton est le nôtre. Sans jeton configuré, rien n'est accepté.
 */
export function verifierAbonnement(params: URLSearchParams, jeton: string): string | null {
  if (!jeton) return null;
  if (params.get("hub.mode") !== "subscribe") return null;
  const recu = params.get("hub.verify_token") ?? "";
  const a = Buffer.from(recu);
  const b = Buffer.from(jeton);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return params.get("hub.challenge") ?? "";
}

const texteDe = (v: unknown): string => (typeof v === "string" ? v : "");
const objet = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {});
const tableau = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** La notification de Meta → les messages reçus (les accusés de lecture et de remise sont ignorés). */
export function lireNotificationWhatsApp(charge: unknown): MessageWhatsApp[] {
  const out: MessageWhatsApp[] = [];
  for (const entree of tableau(objet(charge).entry)) {
    for (const changement of tableau(objet(entree).changes)) {
      const valeur = objet(objet(changement).value);
      const profils = new Map(tableau(valeur.contacts).map((c) => [texteDe(objet(c).wa_id), texteDe(objet(objet(c).profile).name)]));
      for (const brut of tableau(valeur.messages)) {
        const m = objet(brut);
        const id = texteDe(m.id);
        const de = texteDe(m.from).replace(/\D/g, "");
        if (!id || !de) continue;
        const type = texteDe(m.type);
        const sorte: SorteMessageWhatsApp = SORTES_MEDIA.has(type) ? type as SorteMessageWhatsApp : type === "text" ? "text" : "autre";
        const corps = objet(m[type]);
        const media = SORTES_MEDIA.has(type) && texteDe(corps.id)
          ? { id: texteDe(corps.id), mime: texteDe(corps.mime_type) || null, nom: texteDe(corps.filename) || null, sha256: texteDe(corps.sha256) || null }
          : null;
        const ts = Number(texteDe(m.timestamp));
        out.push({
          id, de, nomProfil: profils.get(de) || null, sorte, media,
          texte: (sorte === "text" ? texteDe(objet(m.text).body) : texteDe(corps.caption)).slice(0, 4_000),
          horodatage: Number.isFinite(ts) && ts > 0 ? new Date(ts * 1000) : null,
        });
      }
    }
  }
  return out;
}

/** Un nom de fichier lisible pour un média sans nom (une photo) : « WhatsApp 31-10-2026 14h05.jpg ». */
export function nomDuMedia(m: MessageWhatsApp, quand = new Date()): string {
  if (m.media?.nom) return m.media.nom.replace(/[\\/:*?"<>|]+/g, "_").slice(0, 180);
  const ext = (m.media?.mime ?? "").split("/")[1]?.split(";")[0]?.replace("jpeg", "jpg").replace("ogg", "ogg") || "bin";
  const d = new Intl.DateTimeFormat("fr-FR", { timeZone: "Africa/Algiers", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })
    .format(m.horodatage ?? quand).replace(/\//g, "-").replace(/\s+/, " ").replace(":", "h");
  return `WhatsApp ${d}.${ext}`;
}

export interface ConfigWhatsApp { base: string; jeton: string; telephoneId: string }

export function configWhatsApp(env: Record<string, string | undefined> = process.env): ConfigWhatsApp | null {
  const base = (env.WHATSAPP_BASE_URL ?? "").trim().replace(/\/+$/, "") || "https://graph.facebook.com/v21.0";
  const jeton = (env.WHATSAPP_TOKEN ?? "").trim();
  const telephoneId = (env.WHATSAPP_PHONE_ID ?? "").trim();
  return jeton ? { base, jeton, telephoneId } : null;
}

/** Un appel réseau qui ne lève pas : une panne (réseau, DNS) rend `null`, que l'appelant DIT (« réseau »). */
async function appeler(fetchImpl: typeof fetch, url: string, init: RequestInit): Promise<Response | null> {
  try {
    return await fetchImpl(url, init);
  } catch (e) {
    console.warn("[canal whatsapp] appel impossible", url.replace(/\?.*$/, ""), e instanceof Error ? e.message : e);
    return null;
  }
}

async function lireJson(r: Response): Promise<unknown> {
  try {
    return await r.json();
  } catch {
    return {};
  }
}

/**
 * TÉLÉCHARGER UN MÉDIA : `GET /{media-id}` rend une URL de courte durée, puis `GET <url>` (même jeton) rend le contenu.
 * La taille est bornée AVANT de lire (`file_size`) et PENDANT (le contenu réel).
 */
export async function telechargerMediaWhatsApp(
  cfg: ConfigWhatsApp, mediaId: string, maxOctets: number, fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; octets: Buffer; mime: string | null } | { ok: false; raison: string; trop?: boolean }> {
  const auth = { authorization: `Bearer ${cfg.jeton}` };
  const r1 = await appeler(fetchImpl, `${cfg.base}/${encodeURIComponent(mediaId)}`, { headers: auth });
  if (!r1 || !r1.ok) return { ok: false, raison: `média introuvable chez Meta (${r1?.status ?? "réseau"})` };
  const meta = objet(await lireJson(r1));
  const url = texteDe(meta.url);
  const taille = Number(meta.file_size);
  if (!url) return { ok: false, raison: "Meta n'a pas rendu l'adresse du média" };
  if (Number.isFinite(taille) && taille > maxOctets) return { ok: false, raison: "fichier trop volumineux", trop: true };
  const r2 = await appeler(fetchImpl, url, { headers: auth });
  if (!r2 || !r2.ok) return { ok: false, raison: `téléchargement refusé (${r2?.status ?? "réseau"})` };
  const octets = Buffer.from(await r2.arrayBuffer());
  if (octets.length > maxOctets) return { ok: false, raison: "fichier trop volumineux", trop: true };
  return { ok: true, octets, mime: texteDe(meta.mime_type) || r2.headers.get("content-type") };
}

/** RÉPONDRE EN TEXTE (accusé, refus poli) — dans la fenêtre de 24 h ouverte par le message reçu. Ne lève jamais. */
export async function envoyerTexteWhatsApp(cfg: ConfigWhatsApp | null, a: string, texte: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  if (!cfg || !cfg.telephoneId || !a) return false;
  const r = await appeler(fetchImpl, `${cfg.base}/${encodeURIComponent(cfg.telephoneId)}/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${cfg.jeton}`, "content-type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to: a, type: "text", text: { body: texte.slice(0, 1_000) } }),
  });
  return !!r?.ok;
}
