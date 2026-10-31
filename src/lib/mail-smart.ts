import { createHmac, timingSafeEqual } from "node:crypto";
import { sortieAutorisee } from "@/lib/sortie/garde";
import { noterEffetExterne } from "@/lib/effets/magasin";

/**
 * COURRIER « SMART » — l'e-mail sans SMTP.
 *
 * Le problème réglé : les ports SMTP (25/465/587) sont filtrés à peu près partout — hébergeur,
 * réseau d'entreprise, opérateur — et l'envoi « bloque sans arrêt », de façon imprévisible.
 * Ici, tout passe par une **API HTTPS sur le port 443**, celui du web : s'il passe, le courrier
 * passe. Pas de connexion longue, pas de TLS à négocier, pas de mot de passe d'application.
 *
 * Ce module ne connaît aucun fournisseur en particulier : Resend, Postmark et Brevo parlent
 * tous les trois HTTPS + JSON, et le choix se fait par variable d'environnement. Changer de
 * fournisseur, c'est changer deux variables — jamais une ligne de code métier.
 *
 * ⚠️ Pour que l'envoi fonctionne réellement, il faut (côté humain, pas côté code) :
 *   1. un compte chez l'un des trois fournisseurs → `MAIL_PROVIDER` + `MAIL_API_KEY` ;
 *   2. le domaine d'expédition vérifié chez lui, avec SPF, DKIM et DMARC en DNS —
 *      sans quoi les messages partent mais atterrissent en indésirables ;
 *   3. pour la réception : un webhook pointé sur `/api/mail/inbound` et son secret
 *      (`MAIL_WEBHOOK_SECRET`).
 * Tant que ce n'est pas fait, `smartMailConfigured()` renvoie false et l'app le dit clairement
 * plutôt que d'échouer silencieusement.
 */

export type MailProvider = "resend" | "postmark" | "brevo";

const PROVIDERS: MailProvider[] = ["resend", "postmark", "brevo"];

export function mailProvider(): MailProvider | null {
  const p = (process.env.MAIL_PROVIDER ?? "").trim().toLowerCase();
  return (PROVIDERS as string[]).includes(p) ? (p as MailProvider) : null;
}

export function mailFrom(): string {
  return (process.env.MAIL_FROM ?? "").trim();
}

/** Prêt à envoyer ? (fournisseur + clé + adresse d'expédition) */
export function smartMailConfigured(): boolean {
  return !!mailProvider() && !!(process.env.MAIL_API_KEY ?? "").trim() && !!mailFrom();
}

/** Ce qui manque, en clair — affiché à l'administrateur plutôt qu'une erreur opaque. */
export function smartMailMissing(): string[] {
  const missing: string[] = [];
  if (!mailProvider()) missing.push("MAIL_PROVIDER (resend, postmark ou brevo)");
  if (!(process.env.MAIL_API_KEY ?? "").trim()) missing.push("MAIL_API_KEY (clé d'API du fournisseur)");
  if (!mailFrom()) missing.push("MAIL_FROM (adresse d'expédition du domaine vérifié)");
  if (!(process.env.MAIL_WEBHOOK_SECRET ?? "").trim()) missing.push("MAIL_WEBHOOK_SECRET (réception — facultatif si vous n'envoyez que)");
  return missing;
}

// ───────────────────────────── Envoi ─────────────────────────────

export interface SendEmailInput {
  to: string[];
  cc?: string[];
  subject: string;
  /** Corps en texte simple (toujours fourni — sert de repli si `html` est absent). */
  text: string;
  html?: string;
  replyTo?: string;
}

export interface SendEmailResult {
  ok: boolean;
  /** Identifiant du message chez le fournisseur (traçabilité). */
  providerId?: string;
  error?: string;
}

interface ProviderCall {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  /** Extrait l'identifiant de message de la réponse du fournisseur. */
  idOf: (json: unknown) => string | undefined;
}

/**
 * Traduit un envoi en un appel HTTPS chez le fournisseur choisi. Fonction PURE : elle
 * n'envoie rien — c'est ce qui la rend testable sans réseau ni compte.
 */
export function buildProviderCall(provider: MailProvider, from: string, apiKey: string, input: SendEmailInput): ProviderCall {
  const rec = (j: unknown, k: string): string | undefined => {
    const v = (j as Record<string, unknown> | null)?.[k];
    return typeof v === "string" ? v : undefined;
  };
  switch (provider) {
    case "resend":
      return {
        url: "https://api.resend.com/emails",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: {
          from, to: input.to, ...(input.cc?.length ? { cc: input.cc } : {}),
          subject: input.subject, text: input.text,
          ...(input.html ? { html: input.html } : {}),
          ...(input.replyTo ? { reply_to: input.replyTo } : {}),
        },
        idOf: (j) => rec(j, "id"),
      };
    case "postmark":
      return {
        url: "https://api.postmarkapp.com/email",
        headers: { "X-Postmark-Server-Token": apiKey, "content-type": "application/json", accept: "application/json" },
        body: {
          From: from, To: input.to.join(", "), ...(input.cc?.length ? { Cc: input.cc.join(", ") } : {}),
          Subject: input.subject, TextBody: input.text,
          ...(input.html ? { HtmlBody: input.html } : {}),
          ...(input.replyTo ? { ReplyTo: input.replyTo } : {}),
          MessageStream: "outbound",
        },
        idOf: (j) => rec(j, "MessageID"),
      };
    case "brevo":
      return {
        url: "https://api.brevo.com/v3/smtp/email",
        headers: { "api-key": apiKey, "content-type": "application/json", accept: "application/json" },
        body: {
          sender: { email: from },
          to: input.to.map((email) => ({ email })),
          ...(input.cc?.length ? { cc: input.cc.map((email) => ({ email })) } : {}),
          subject: input.subject, textContent: input.text,
          ...(input.html ? { htmlContent: input.html } : {}),
          ...(input.replyTo ? { replyTo: { email: input.replyTo } } : {}),
        },
        idOf: (j) => rec(j, "messageId"),
      };
  }
}

/** Adresses valides et dédoublonnées — on ne laisse jamais partir une saisie approximative. */
export function cleanRecipients(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const a = raw.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(a) || seen.has(a)) continue;
    seen.add(a);
    out.push(a);
  }
  return out;
}

/**
 * Envoie réellement le message. Ne lève jamais : renvoie un résultat structuré — l'appelant
 * journalise (`OutboundEmail`) et affiche le motif exact en cas de refus.
 */
export async function sendSmartEmail(input: SendEmailInput): Promise<SendEmailResult> {
  // ═══════════════════════════════════════════════════════════════════════════════════════
  // LA GARDE D'ABORD — avant de lire la clé d'API, avant de composer la requête.
  //
  // Ce module était le QUATRIÈME émetteur du dépôt et le SEUL sans garde. Les deux règles
  // d'architecture qui l'auraient dit s'armaient sur un import de transport (`nodemailer`,
  // `web-push`) ou sur un appel reconnu (`transport.sendMail(`, `implements MailProvider`) :
  // ici il n'y a ni paquet ni interface, juste un `fetch` HTTPS vers l'API d'un fournisseur.
  // Une garde qui ne s'arme pas sur la forme qu'on lui donne est désarmée en ayant l'air
  // armée (§118.17) — la troisième règle juge donc le FAIT « ce module appelle le réseau ET
  // exporte une fonction d'ENVOI », qui ne dépend d'aucun paquet.
  //
  // La variante qui NE LÈVE PAS, parce que le contrat de cette fonction est de ne jamais
  // lever : elle enregistre la tentative — le banc garde la preuve de ce qui serait parti —
  // et rend un refus STRUCTURÉ, que l'appelant journalise comme n'importe quel échec.
  // ═══════════════════════════════════════════════════════════════════════════════════════
  // LE PORT DE SIMULATION (J7) : un geste simulé note le courriel et ne l'envoie pas.
  if (noterEffetExterne({ acte: "COURRIEL", cible: (input.to ?? []).join(", ") || "(sans destinataire)", apercu: `« ${input.subject ?? ""} »`, origine: "mail-smart:sendSmartEmail" })) {
    return { ok: true, providerId: "simulation" };
  }
  if (!sortieAutorisee("COURRIEL", (input.to ?? []).join(", ") || "(sans destinataire)", {
    apercu: `« ${input.subject ?? ""} »`,
    origine: "mail-smart:sendSmartEmail",
  })) {
    return { ok: false, error: "Sorties externes interdites dans cet environnement (garde de sortie)." };
  }
  const provider = mailProvider();
  const apiKey = (process.env.MAIL_API_KEY ?? "").trim();
  const from = mailFrom();
  if (!provider || !apiKey || !from) {
    return { ok: false, error: `Courrier non configuré : ${smartMailMissing().join(", ")}.` };
  }
  const to = cleanRecipients(input.to);
  if (to.length === 0) return { ok: false, error: "Aucun destinataire valide." };
  const cc = input.cc ? cleanRecipients(input.cc) : undefined;

  const call = buildProviderCall(provider, from, apiKey, { ...input, to, cc });
  try {
    const res = await fetch(call.url, { method: "POST", headers: call.headers, body: JSON.stringify(call.body) });
    const raw = await res.text();
    let json: unknown = null;
    try { json = raw ? JSON.parse(raw) : null; } catch { /* réponse non JSON : on garde le texte brut */ }
    if (!res.ok) {
      return { ok: false, error: `Refus du fournisseur (HTTP ${res.status}) : ${raw.slice(0, 300)}` };
    }
    return { ok: true, providerId: call.idOf(json) };
  } catch (err) {
    console.error("[mail-smart] envoi impossible", err);
    return { ok: false, error: "Envoi impossible (réseau)." };
  }
}

// ───────────────────────────── Réception (webhook) ─────────────────────────────

/**
 * Vérifie la signature du fournisseur : HMAC-SHA256 du corps BRUT, comparé en temps constant.
 * Sans cette vérification, n'importe qui pourrait pousser de faux e-mails dans la plateforme.
 * Renvoie false — jamais une exception — quelle que soit la malformation reçue.
 */
export function verifyInboundSignature(rawBody: string, signature: string | null, secret: string): boolean {
  if (!signature || !secret) return false;
  try {
    // Certains fournisseurs préfixent (« sha256=… ») : on accepte les deux écritures.
    const given = signature.includes("=") ? signature.slice(signature.indexOf("=") + 1) : signature;
    const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
    const a = Buffer.from(given.trim().toLowerCase(), "utf8");
    const b = Buffer.from(expected, "utf8");
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export interface InboundMessage {
  messageId: string | null;
  fromAddress: string;
  fromName: string | null;
  toAddress: string;
  subject: string;
  text: string;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

/**
 * Ramène la charge utile d'un fournisseur à une forme unique. Les trois nomment les mêmes
 * champs différemment ; le reste de l'application n'a pas à le savoir.
 * Renvoie null si le message est inexploitable (pas d'expéditeur, pas de destinataire).
 */
export function normalizeInbound(provider: MailProvider, payload: unknown): InboundMessage | null {
  const p = obj(payload);
  let msg: InboundMessage;

  if (provider === "postmark") {
    const first = Array.isArray(p.ToFull) ? obj(p.ToFull[0]) : {};
    msg = {
      messageId: str(p.MessageID) || null,
      fromAddress: str(p.From).toLowerCase(),
      fromName: str(obj(p.FromFull).Name) || null,
      toAddress: (str(first.Email) || str(p.To)).toLowerCase(),
      subject: str(p.Subject),
      text: str(p.TextBody) || str(p.StrippedTextReply) || str(p.HtmlBody),
    };
  } else if (provider === "brevo") {
    const fromO = obj(p.from);
    const firstTo = Array.isArray(p.to) ? obj(p.to[0]) : {};
    msg = {
      messageId: str(p["message-id"]) || str(p.uuid) || null,
      fromAddress: (str(fromO.address) || str(p.from)).toLowerCase(),
      fromName: str(fromO.name) || null,
      toAddress: (str(firstTo.address) || str(p.to)).toLowerCase(),
      subject: str(p.subject),
      text: str(p.text) || str(p.html),
    };
  } else {
    // resend
    const d = obj(p.data ?? p);
    const to = Array.isArray(d.to) ? str(d.to[0]) : str(d.to);
    msg = {
      messageId: str(d.email_id) || str(d.id) || null,
      fromAddress: str(d.from).toLowerCase(),
      fromName: null,
      toAddress: to.toLowerCase(),
      subject: str(d.subject),
      text: str(d.text) || str(d.html),
    };
  }

  // Une adresse peut arriver sous la forme « Nom <a@b.dz> » : on n'en garde que l'adresse.
  const unwrap = (v: string) => {
    const m = v.match(/<([^>]+)>/);
    return (m ? m[1] : v).trim().toLowerCase();
  };
  msg.fromAddress = unwrap(msg.fromAddress);
  msg.toAddress = unwrap(msg.toAddress);

  if (!msg.fromAddress || !msg.toAddress) return null;
  return msg;
}
