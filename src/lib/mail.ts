import crypto from "crypto";
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { simpleParser } from "mailparser";
import type { MailAccount } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { exigerSortieAutorisee } from "@/lib/sortie/garde";
import { noterEffetExterne } from "@/lib/effets/magasin";
import { sansBloquer, attendu } from "@/lib/journal";

/**
 * Couche e-mail — **serveur uniquement** (jamais côté client). Connexion par
 * utilisateur à sa boîte Infomaniak : IMAP (lecture) + SMTP (envoi). Le mot de
 * passe d'application est chiffré au repos (AES-256-GCM) et n'est déchiffré qu'au
 * moment d'ouvrir une connexion. Aucune fuite vers le navigateur.
 */

// ───────────────────────────── Chiffrement du secret ─────────────────────────────

function masterKey(): Buffer {
  const s = process.env.MAIL_ENCRYPTION_KEY || process.env.DRIVE_ENCRYPTION_KEY || process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET || "dev-mail-key-change-me";
  return crypto.createHash("sha256").update(s).digest(); // 32 octets
}

export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", masterKey(), iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return [iv.toString("base64"), c.getAuthTag().toString("base64"), enc.toString("base64")].join(":");
}

export function decryptSecret(blob: string): string {
  const [iv, tag, enc] = blob.split(":").map((s) => Buffer.from(s, "base64"));
  const d = crypto.createDecipheriv("aes-256-gcm", masterKey(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString("utf8");
}

// ───────────────────────────── Types ─────────────────────────────

export interface MailEnvelope {
  uid: number;
  subject: string;
  from: string;
  fromAddr: string;
  date: string | null;
  seen: boolean;
}
export interface MailAttachmentMeta { index: number; filename: string; contentType: string; size: number }
export interface MailMessage {
  uid: number;
  subject: string;
  from: string;
  fromAddr: string;
  to: string;
  cc: string;
  date: string | null;
  html: string | null;
  text: string | null;
  attachments: MailAttachmentMeta[];
}
export interface MailboxInfo { path: string; name: string; role: string; unseen: number; total: number }

export async function getMailAccount(userId: string): Promise<MailAccount | null> {
  return prisma.mailAccount.findUnique({ where: { userId } });
}

// ───────────────────────────── IMAP (lecture) ─────────────────────────────

function imapClient(account: { email: string; passwordEnc: string; imapHost: string; imapPort: number }): ImapFlow {
  return new ImapFlow({
    host: account.imapHost,
    port: account.imapPort,
    secure: true,
    auth: { user: account.email, pass: decryptSecret(account.passwordEnc) },
    logger: false,
    emitLogs: false,
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 30000,
  });
}

const addrStr = (a?: { name?: string; address?: string }[] | null): { label: string; addr: string } => {
  const first = a?.[0];
  return { label: first?.name || first?.address || "", addr: first?.address || "" };
};

/** Erreur IMAP transitoire (limite de connexions / coupure réseau) → on peut réessayer. */
function isTransientMailError(e: unknown): boolean {
  const m = String((e as Error)?.message ?? "").toLowerCase();
  return /command failed|timeout|timed out|econnreset|socket|closed|too many|connection limit|temporar|try again|unavailable|busy|throttl/.test(m);
}

/** Message d'erreur clair pour l'utilisateur (la plupart des soucis viennent du fournisseur). */
export function friendlyMailError(e: unknown): string {
  const msg = String((e as Error)?.message ?? "");
  const low = msg.toLowerCase();
  if (/too many|connection limit|maximum.*connection|throttl/.test(low))
    return "Trop de connexions simultanées vers la boîte mail (limite du fournisseur). Patientez quelques secondes puis réessayez.";
  if (/auth|login|invalid cred|password|denied/.test(low))
    return "Identifiants refusés par le serveur de messagerie. Vérifiez l'adresse et le mot de passe d'application Infomaniak.";
  if (/timeout|timed out|socket|econnreset|closed|connect/.test(low))
    return "Le serveur de messagerie n'a pas répondu à temps. Réessayez dans un instant.";
  if (/command failed/.test(low))
    return "La boîte mail a momentanément refusé la commande (souvent une limite de connexions côté fournisseur, ou l'adresse IP du serveur temporairement bloquée). Réessayez dans quelques secondes.";
  return msg || "Connexion à la boîte mail impossible.";
}

/** Catégorise une erreur IMAP en cause probable (pour le diagnostic admin). */
export type MailDiagCategory =
  | "OK" | "TOO_MANY_CONNECTIONS" | "AUTH_FAILED" | "IP_BLOCKED" | "TIMEOUT" | "COMMAND_FAILED" | "OTHER";

export interface MailDiagnostic {
  ok: boolean;
  category: MailDiagCategory;
  label: string;
  raw: string; // message d'erreur BRUT renvoyé par le serveur (Infomaniak)
  host: string;
  email: string;
}

const DIAG_LABEL: Record<MailDiagCategory, string> = {
  OK: "Connexion réussie — la boîte répond normalement.",
  TOO_MANY_CONNECTIONS: "Limite de connexions simultanées atteinte (throttling fournisseur). Se débloque seul ; réessayez dans quelques secondes.",
  AUTH_FAILED: "Identifiants refusés. Vérifiez l'adresse et le mot de passe d'application (2FA → mot de passe dédié).",
  IP_BLOCKED: "L'adresse IP du serveur semble bloquée par le fournisseur. Ouvrir un ticket Infomaniak pour la débloquer.",
  TIMEOUT: "Le serveur n'a pas répondu à temps (réseau / surcharge). Réessayez.",
  COMMAND_FAILED: "Commande refusée (« command failed ») — le plus souvent une limite de connexions, parfois une IP bloquée.",
  OTHER: "Erreur non catégorisée — voir le message brut ci-dessous.",
};

function classifyMailError(e: unknown): MailDiagCategory {
  const m = String((e as Error)?.message ?? "").toLowerCase();
  if (/too many|connection limit|maximum.*connection|throttl|rate/.test(m)) return "TOO_MANY_CONNECTIONS";
  if (/auth|login failed|invalid cred|password|denied|authenticationfailed|\[auth/.test(m)) return "AUTH_FAILED";
  if (/blocked|blacklist|spamhaus|banned|access denied|not allowed from|your ip/.test(m)) return "IP_BLOCKED";
  if (/timeout|timed out|econnreset|etimedout|socket|closed|connect|enotfound|ehostunreach/.test(m)) return "TIMEOUT";
  if (/command failed/.test(m)) return "COMMAND_FAILED";
  return "OTHER";
}

/**
 * Diagnostic : tente une connexion IMAP réelle et renvoie l'erreur BRUTE d'Infomaniak +
 * sa cause probable. N'effectue aucune action sur la boîte (juste connect + status + logout).
 */
export async function mailDiagnostic(account: { email: string; passwordEnc: string; imapHost: string; imapPort: number }): Promise<MailDiagnostic> {
  const base = { host: account.imapHost, email: account.email };
  // Sérialisé par compte (comme les autres opérations) pour ne pas créer une
  // connexion concurrente qui fausserait le diagnostic. Pas de réessai : on veut
  // l'erreur BRUTE telle quelle.
  return withAccountLock(account.email, async () => {
    dropPooled(account.email); // pas de connexion chaude concurrente pendant le diagnostic
    const c = imapClient(account);
    try {
      await c.connect();
      await c.status("INBOX", { messages: true }).catch(sansBloquer("mail.mailDiagnostic.status"));
      await c.logout().catch(attendu("fermeture au mieux : la ressource est abandonnée de toute façon"));
      return { ok: true, category: "OK" as MailDiagCategory, label: DIAG_LABEL.OK, raw: "", ...base };
    } catch (e) {
      await c.logout().catch(attendu("fermeture au mieux : la ressource est abandonnée de toute façon"));
      const category = classifyMailError(e);
      return { ok: false, category, label: DIAG_LABEL[category], raw: String((e as Error)?.message ?? e ?? "erreur inconnue").slice(0, 600), ...base };
    }
  });
}

/**
 * Verrou **par compte** (clé = adresse e-mail) : Infomaniak limite le nombre de
 * connexions IMAP SIMULTANÉES par boîte. Comme le poller (toutes les 12 s) et les
 * actions utilisateur (lecture, envoi, pièce jointe…) peuvent viser la même boîte
 * en même temps, on sérialise : au plus UNE connexion IMAP par compte à la fois.
 * C'est la cause la plus fréquente des « command failed » / connexions refusées.
 */
const imapChains = new Map<string, Promise<unknown>>();
function withAccountLock<T>(email: string, fn: () => Promise<T>): Promise<T> {
  const key = email.toLowerCase();
  const prev = imapChains.get(key) ?? Promise.resolve();
  const run = prev.catch(attendu("l\'erreur du maillon appartient à son appelant, qui l\'a déjà reçue")).then(fn);
  // On garde la chaîne vivante (sans propager l'erreur) pour sérialiser le suivant.
  const tail = run.catch(attendu("l\'erreur du maillon appartient à son appelant, qui l\'a déjà reçue"));
  imapChains.set(key, tail);
  // Nettoyage : si personne ne s'est enchaîné derrière, on libère l'entrée.
  tail.then(() => { if (imapChains.get(key) === tail) imapChains.delete(key); });
  return run;
}

/**
 * **Pool de connexions IMAP par compte** : la boîte reste connectée entre deux actions
 * (au lieu de se reconnecter — TLS + login ~1-2 s — à CHAQUE lecture / actualisation /
 * ouverture de message). C'est ce qui rend le webmail quasi instantané. On garde **une
 * seule** connexion authentifiée par compte, réutilisée tant qu'elle est saine, puis
 * fermée après ~90 s d'inactivité. Réutiliser plutôt que rouvrir réduit AUSSI les
 * « too many connections » d'Infomaniak (c'est l'ouverture/fermeture en rafale qui les
 * déclenche). Sérialisé par compte : au plus une opération à la fois sur la connexion.
 */
interface PooledConn { client: ImapFlow; idleTimer: ReturnType<typeof setTimeout> | null; lastUsed: number }
const imapPool = new Map<string, PooledConn>();
const IMAP_IDLE_MS = Number(process.env.MAIL_IMAP_IDLE_MS ?? "90000");
const poolKey = (email: string) => email.toLowerCase();

/**
 * **Plafond global de connexions IMAP simultanées** (tous comptes confondus). Sur
 * l'hébergement, TOUS les comptes sortent par la MÊME adresse IP : Infomaniak limite
 * les connexions IMAP par IP. Sans plafond, plusieurs utilisateurs actifs en même
 * temps (ou une rafale de reconnexions) saturent l'IP → « command failed » / IP
 * bloquée EN CONTINU. On borne donc les opérations IMAP concurrentes ; au-delà, on
 * attend un créneau (file d'attente). Réglable via `MAIL_MAX_CONCURRENCY`.
 */
const MAIL_MAX_CONCURRENCY = Math.max(1, Number(process.env.MAIL_MAX_CONCURRENCY ?? "3"));
let activeImap = 0;
const imapWaiters: Array<() => void> = [];
function acquireSlot(): Promise<void> {
  if (activeImap < MAIL_MAX_CONCURRENCY) { activeImap++; return Promise.resolve(); }
  return new Promise<void>((resolve) => imapWaiters.push(resolve));
}
function releaseSlot(): void {
  const next = imapWaiters.shift();
  if (next) next(); // transfert du créneau au suivant (activeImap inchangé)
  else activeImap = Math.max(0, activeImap - 1);
}
async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  await acquireSlot();
  try { return await fn(); } finally { releaseSlot(); }
}

// Plafond du nombre de connexions **chaudes** gardées ouvertes (sockets sur l'IP
// partagée) : au-delà, on ferme la moins récemment utilisée. Réglable via MAIL_MAX_POOL.
const MAIL_MAX_POOL = Math.max(1, Number(process.env.MAIL_MAX_POOL ?? "8"));
// Une connexion réutilisée restée inactive plus longtemps que ce seuil est revalidée (NOOP).
const IMAP_REVALIDATE_MS = 15_000;

/** Attente exponentielle (avec gigue) entre deux tentatives IMAP. */
function imapBackoff(attempt: number): Promise<void> {
  const ms = Math.min(4000, 400 * 2 ** attempt) + Math.floor(Math.random() * 200);
  return new Promise((r) => setTimeout(r, ms));
}

/** Ferme la connexion chaude la moins récemment utilisée tant que le pool dépasse le plafond. */
function evictColdest(exceptKey: string): void {
  while (imapPool.size >= MAIL_MAX_POOL) {
    let coldKey: string | null = null;
    let coldest = Infinity;
    for (const [k, p] of imapPool) {
      if (k === exceptKey) continue;
      if (p.lastUsed < coldest) { coldest = p.lastUsed; coldKey = k; }
    }
    if (!coldKey) break;
    const p = imapPool.get(coldKey);
    if (p?.idleTimer) clearTimeout(p.idleTimer);
    imapPool.delete(coldKey);
    try { p?.client.close(); } catch { /* déjà fermée */ }
  }
}

/**
 * **Disjoncteur (circuit breaker) + cache mémoire.** Solution définitive contre les
 * blocages Infomaniak : quand le fournisseur sature (limite de connexions / IP
 * momentanément bloquée), CONTINUER à le solliciter **prolonge et aggrave** le
 * blocage. On ouvre donc un disjoncteur : pendant un temps de repos, on **cesse
 * totalement** de contacter Infomaniak et on sert la boîte depuis le **dernier
 * contenu synchronisé** (cache). L'IP « refroidit » et se débloque seule ; côté
 * utilisateur, la boîte reste consultable en permanence.
 */
function isOverloadError(e: unknown): boolean {
  const m = String((e as Error)?.message ?? "").toLowerCase();
  return /too many|connection limit|maximum.*connection|command failed|blocked|throttl|rate|temporar|unavailable|busy|try again/.test(m);
}

let breakerUntil = 0;
let breakerFails = 0;
const BREAKER_THRESHOLD = Math.max(1, Number(process.env.MAIL_BREAKER_THRESHOLD ?? "3"));
const BREAKER_COOLDOWN_MS = Number(process.env.MAIL_BREAKER_COOLDOWN_MS ?? "30000");
export const mailBreakerRemainingMs = (): number => Math.max(0, breakerUntil - Date.now());
function noteMailSuccess(): void { breakerFails = 0; breakerUntil = 0; }
function noteMailFailure(e: unknown): void {
  if (!isOverloadError(e)) return; // auth/box HS ≠ saturation IP → n'ouvre pas le disjoncteur
  breakerFails++;
  if (breakerFails >= BREAKER_THRESHOLD) breakerUntil = Date.now() + BREAKER_COOLDOWN_MS;
}

interface ListingCacheEntry { at: number; data: { messages: MailEnvelope[]; mailboxes?: MailboxInfo[] } }
const listingCache = new Map<string, ListingCacheEntry>();
const LISTING_FRESH_MS = Number(process.env.MAIL_CACHE_FRESH_MS ?? "10000");   // servi sans toucher IMAP (coalescing)
const LISTING_STALE_MS = Number(process.env.MAIL_CACHE_STALE_MS ?? "900000");  // repli si IMAP indisponible (15 min)
const listingKey = (email: string, mailbox: string, limit: number, withFolders: boolean, search?: string) =>
  `${email.toLowerCase()}::${mailbox}::${limit}::${withFolders ? 1 : 0}::${search ?? ""}`;

const messageCache = new Map<string, { at: number; msg: MailMessage }>();
const MESSAGE_CACHE_MAX = 80;
const msgKey = (email: string, mailbox: string, uid: number) => `${email.toLowerCase()}::${mailbox}::${uid}`;
function rememberMessage(key: string, msg: MailMessage): void {
  messageCache.set(key, { at: Date.now(), msg });
  // LRU grossier : on borne la taille.
  if (messageCache.size > MESSAGE_CACHE_MAX) {
    const oldest = messageCache.keys().next().value as string | undefined;
    if (oldest) messageCache.delete(oldest);
  }
}

/** Ferme et retire la connexion en pool d'un compte (connexion morte / avant diagnostic). */
function dropPooled(email: string): void {
  const key = poolKey(email);
  const p = imapPool.get(key);
  if (!p) return;
  if (p.idleTimer) clearTimeout(p.idleTimer);
  imapPool.delete(key);
  try { p.client.close(); } catch { /* déjà fermée */ }
}

/** Ferme la connexion chaude d'un compte (déconnexion / changement de mot de passe) et purge son cache. */
export function closeMailConnection(email: string): void {
  dropPooled(email);
  const prefix = `${email.toLowerCase()}::`;
  for (const k of listingCache.keys()) if (k.startsWith(prefix)) listingCache.delete(k);
  for (const k of messageCache.keys()) if (k.startsWith(prefix)) messageCache.delete(k);
}

/** Récupère une connexion chaude (réutilisée) ou en ouvre une neuve. */
async function acquirePooled(account: { email: string; passwordEnc: string; imapHost: string; imapPort: number }): Promise<ImapFlow> {
  const key = poolKey(account.email);
  const existing = imapPool.get(key);
  if (existing) {
    if (existing.idleTimer) { clearTimeout(existing.idleTimer); existing.idleTimer = null; }
    if (existing.client.usable) {
      // Réutilisation immédiate si récente ; sinon on revalide (NOOP) pour ne pas
      // surfacer un « command failed » sur une connexion morte côté serveur.
      if (Date.now() - existing.lastUsed < IMAP_REVALIDATE_MS) return existing.client;
      try { await existing.client.noop(); existing.lastUsed = Date.now(); return existing.client; }
      catch { dropPooled(account.email); }
    } else {
      dropPooled(account.email); // connexion inutilisable : on repart de zéro
    }
  }
  // Respecte le plafond de connexions chaudes (ferme la plus ancienne au besoin).
  evictColdest(key);
  const c = imapClient(account);
  // Un listener 'error' évite que l'événement 'error' d'ImapFlow ne fasse planter le process.
  c.on("error", () => {});
  c.on("close", () => { const p = imapPool.get(key); if (p && p.client === c) imapPool.delete(key); });
  await c.connect();
  imapPool.set(key, { client: c, idleTimer: null, lastUsed: Date.now() });
  return c;
}

/** Laisse la connexion « au chaud » : programme sa fermeture après IMAP_IDLE_MS d'inactivité. */
function keepWarm(email: string): void {
  const key = poolKey(email);
  const p = imapPool.get(key);
  if (!p) return;
  p.lastUsed = Date.now();
  if (p.idleTimer) clearTimeout(p.idleTimer);
  p.idleTimer = setTimeout(() => {
    const cur = imapPool.get(key);
    if (cur && cur.client === p.client) {
      imapPool.delete(key);
      cur.client.logout().catch(() => { try { cur.client.close(); } catch { /* ignore */ } });
    }
  }, IMAP_IDLE_MS);
  // Ne pas empêcher le process de s'arrêter à cause du minuteur.
  (p.idleTimer as unknown as { unref?: () => void }).unref?.();
}

/**
 * Exécute `fn` sur la connexion IMAP du compte (réutilisée depuis le pool), avec
 * **réessai** en cas d'erreur transitoire (connexion tombée, limite fournisseur). En
 * cas de succès, la connexion reste chaude ; en cas d'erreur, elle est fermée (la
 * prochaine opération en rouvrira une saine).
 */
function withImap<T>(
  account: { email: string; passwordEnc: string; imapHost: string; imapPort: number },
  fn: (c: ImapFlow) => Promise<T>,
  retries = 3,
): Promise<T> {
  // Sérialisé par compte (≤1 op/compte) PUIS borné globalement (≤N ops toutes boîtes
  // confondues, cf. plafond de l'IP partagée).
  return withAccountLock(account.email, () => withSlot(async () => {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      let c: ImapFlow;
      try {
        c = await acquirePooled(account);
      } catch (e) {
        lastErr = e;
        dropPooled(account.email);
        if (attempt < retries && isTransientMailError(e)) { await imapBackoff(attempt); continue; }
        throw e;
      }
      try {
        const result = await fn(c);
        keepWarm(account.email); // succès → on garde la connexion ouverte pour la prochaine action
        return result;
      } catch (e) {
        lastErr = e;
        dropPooled(account.email); // opération en échec : la connexion est douteuse, on la ferme
        if (attempt < retries && isTransientMailError(e)) { await imapBackoff(attempt); continue; }
        throw e;
      }
    }
    throw lastErr;
  }));
}

// Alias historique (mêmes garanties, désormais sérialisé par compte).
const withClient = withImap;

/** Teste la connexion IMAP (login). Renvoie null si OK, sinon un message d'erreur clair. */
export async function testImap(account: { email: string; passwordEnc: string; imapHost: string; imapPort: number }): Promise<string | null> {
  try {
    await withClient(account, async () => undefined);
    return null;
  } catch (e) {
    return friendlyMailError(e);
  }
}

async function readBoxes(c: ImapFlow): Promise<MailboxInfo[]> {
  const boxes = await c.list();
  const out: MailboxInfo[] = [];
  for (const b of boxes) {
    if (b.flags?.has("\\Noselect")) continue;
    let unseen = 0, total = 0;
    try { const st = await c.status(b.path, { unseen: true, messages: true }); unseen = st.unseen ?? 0; total = st.messages ?? 0; } catch { /* ignore */ }
    out.push({ path: b.path, name: b.name, role: b.specialUse?.replace("\\", "") ?? "", unseen, total });
  }
  return out;
}

async function readEnvelopes(c: ImapFlow, mailbox: string, limit: number, search?: string): Promise<MailEnvelope[]> {
  const lock = await c.getMailboxLock(mailbox);
  try {
    const status = await c.status(mailbox, { messages: true });
    const total = status.messages ?? 0;
    if (total === 0) return [];

    // Recherche : IMAP SEARCH sur expéditeur / destinataire / objet / corps (inclut
    // les correspondants externes). On garde les `limit` résultats les plus récents.
    let range: string;
    const q = search?.trim();
    if (q) {
      let uids: number[] = [];
      try {
        uids = (await c.search({ or: [{ from: q }, { to: q }, { cc: q }, { subject: q }, { body: q }] }, { uid: true })) || [];
      } catch { uids = []; }
      if (uids.length === 0) return [];
      const slice = uids.slice(-limit);
      range = slice.join(",");
    } else {
      range = `${Math.max(1, total - limit + 1)}:*`;
    }

    const out: MailEnvelope[] = [];
    for await (const msg of c.fetch(range, { uid: true, envelope: true, flags: true, internalDate: true }, { uid: Boolean(q) })) {
      const f = addrStr(msg.envelope?.from);
      const d = msg.internalDate ?? msg.envelope?.date;
      out.push({
        uid: msg.uid,
        subject: msg.envelope?.subject || "(sans objet)",
        from: f.label, fromAddr: f.addr,
        date: d ? new Date(d).toISOString() : null,
        seen: msg.flags?.has("\\Seen") ?? false,
      });
    }
    return out.reverse(); // plus récents d'abord
  } finally { lock.release(); }
}

export async function listMessages(account: MailAccount, mailbox = "INBOX", limit = 30): Promise<MailEnvelope[]> {
  return withClient(account, (c) => readEnvelopes(c, mailbox, limit));
}

/**
 * Charge la boîte (et éventuellement les dossiers) en **une seule** connexion IMAP,
 * protégée par le **cache + disjoncteur** : sert le cache frais sans toucher
 * Infomaniak (coalescing), NE se connecte PAS pendant le repos du disjoncteur, et
 * retombe sur le dernier contenu synchronisé si le fournisseur est indisponible
 * (`stale: true`) — la boîte reste toujours consultable.
 */
export async function loadInbox(
  account: MailAccount, mailbox = "INBOX", limit = 30, withFolders = false, search?: string,
): Promise<{ messages: MailEnvelope[]; mailboxes?: MailboxInfo[]; stale?: boolean; syncedAt?: number }> {
  const key = listingKey(account.email, mailbox, limit, withFolders, search);
  const cached = listingCache.get(key);
  const now = Date.now();

  // 1) Cache FRAIS → réponse immédiate, aucune connexion (coalescing des actions rapprochées).
  if (cached && now - cached.at < LISTING_FRESH_MS) return { ...cached.data };

  // 2) Disjoncteur ouvert → on NE contacte PAS Infomaniak ; on sert le dernier contenu connu.
  if (mailBreakerRemainingMs() > 0) {
    if (cached && now - cached.at < LISTING_STALE_MS) return { ...cached.data, stale: true, syncedAt: cached.at };
    throw new Error(`command failed (pause ${Math.ceil(mailBreakerRemainingMs() / 1000)}s)`);
  }

  // 3) Tentative Infomaniak ; succès → on met en cache ; échec → repli sur le cache.
  try {
    const data = await withClient(account, async (c) => {
      const messages = await readEnvelopes(c, mailbox, limit, search);
      const mailboxes = withFolders ? await readBoxes(c) : undefined;
      return { messages, mailboxes };
    });
    listingCache.set(key, { at: Date.now(), data });
    noteMailSuccess();
    return data;
  } catch (e) {
    noteMailFailure(e);
    if (cached && Date.now() - cached.at < LISTING_STALE_MS) return { ...cached.data, stale: true, syncedAt: cached.at };
    throw e;
  }
}

export async function getMessage(account: MailAccount, mailbox: string, uid: number): Promise<MailMessage | null> {
  const key = msgKey(account.email, mailbox, uid);
  // Disjoncteur ouvert → on sert le message déjà consulté (cache) sans contacter Infomaniak.
  if (mailBreakerRemainingMs() > 0) {
    const c = messageCache.get(key);
    if (c) return c.msg;
    throw new Error(`command failed (pause ${Math.ceil(mailBreakerRemainingMs() / 1000)}s)`);
  }
  try {
    const msg = await withClient(account, async (c) => {
      const lock = await c.getMailboxLock(mailbox);
      try {
        const m = await c.fetchOne(String(uid), { source: true, flags: true }, { uid: true });
        if (!m || !m.source) return null;
        const parsed = await simpleParser(m.source as Buffer);
        const from = { label: parsed.from?.value?.[0]?.name || parsed.from?.value?.[0]?.address || "", addr: parsed.from?.value?.[0]?.address || "" };
        const toList = Array.isArray(parsed.to) ? parsed.to : parsed.to ? [parsed.to] : [];
        const to = toList.flatMap((t) => t.value).map((v) => v.address).filter(Boolean).join(", ");
        const ccList = Array.isArray(parsed.cc) ? parsed.cc : parsed.cc ? [parsed.cc] : [];
        const cc = ccList.flatMap((t) => t.value).map((v) => v.address).filter(Boolean).join(", ");
        // Marque comme lu (best-effort).
        c.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true }).catch(sansBloquer("mail.getMessage.messageFlagsAdd"));
        return {
          uid,
          subject: parsed.subject || "(sans objet)",
          from: from.label, fromAddr: from.addr, to, cc,
          date: parsed.date?.toISOString() ?? null,
          html: parsed.html || null,
          text: parsed.text || null,
          attachments: (parsed.attachments ?? []).map((a, i) => ({ index: i, filename: a.filename || `piece-${i + 1}`, contentType: a.contentType || "application/octet-stream", size: a.size || 0 })),
        } as MailMessage;
      } finally { lock.release(); }
    });
    noteMailSuccess();
    if (msg) rememberMessage(key, msg);
    return msg;
  } catch (e) {
    noteMailFailure(e);
    const c = messageCache.get(key);
    if (c) return c.msg; // repli : message déjà consulté auparavant
    throw e;
  }
}

export async function getAttachment(account: MailAccount, mailbox: string, uid: number, index: number): Promise<{ filename: string; contentType: string; content: Buffer } | null> {
  return withImap(account, async (c) => {
    const lock = await c.getMailboxLock(mailbox);
    try {
      const msg = await c.fetchOne(String(uid), { source: true }, { uid: true });
      if (!msg || !msg.source) return null;
      const parsed = await simpleParser(msg.source as Buffer);
      const a = parsed.attachments?.[index];
      if (!a) return null;
      return { filename: a.filename || `piece-${index + 1}`, contentType: a.contentType || "application/octet-stream", content: a.content as Buffer };
    } finally { lock.release(); }
  });
}

// ───────────────────────────── SMTP (envoi) ─────────────────────────────

export interface MailAttachment { filename: string; content: Buffer; contentType?: string }
export interface SendOptions { to: string; cc?: string; subject: string; text?: string; html?: string; attachments?: MailAttachment[] }

export async function sendMail(account: MailAccount, opts: SendOptions): Promise<void> {
  // LA GARDE D'ABORD — avant de composer, avant de déchiffrer le mot de passe SMTP, avant
  // d'ouvrir quoi que ce soit. Un banc qui échoue APRÈS avoir lu un identifiant a déjà fait
  // une chose de trop.
  // LE PORT DE SIMULATION (J7) : un geste simulé note le courriel et ne l'envoie pas.
  if (noterEffetExterne({ acte: "COURRIEL", cible: opts.to, apercu: `« ${opts.subject} »`, origine: "mail:sendMail" })) return;
  exigerSortieAutorisee("COURRIEL", opts.to, {
    apercu: `« ${opts.subject} »${opts.attachments?.length ? ` + ${opts.attachments.length} pièce(s)` : ""}`,
    origine: "mail:sendMail",
  });
  const mail = {
    from: account.displayName ? `"${account.displayName}" <${account.email}>` : account.email,
    to: opts.to,
    cc: opts.cc || undefined,
    subject: opts.subject,
    text: opts.text || undefined,
    html: opts.html || undefined,
    // Pièces jointes : intégrées au MIME construit une seule fois → présentes à
    // l'envoi ET dans la copie déposée dans « Envoyés ».
    attachments: opts.attachments?.length
      ? opts.attachments.map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType }))
      : undefined,
  };

  // 1) Construit le MIME UNE fois — pour envoyer ET archiver la même copie.
  const builder = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: "windows" });
  const built = await builder.sendMail(mail);
  const raw = built.message as Buffer;

  // 2) Envoi SMTP du message construit.
  const transport = nodemailer.createTransport({
    host: account.smtpHost,
    port: account.smtpPort,
    secure: account.smtpPort === 465,
    auth: { user: account.email, pass: decryptSecret(account.passwordEnc) },
  });
  await transport.sendMail({ envelope: built.envelope, raw });

  // 3) Copie dans « Envoyés » (best-effort) — sans ça, le message n'apparaît pas
  //    dans le dossier Envoyés (l'envoi SMTP seul ne l'y dépose pas).
  await appendToSent(account, raw).catch((e) => console.error("[mail] append to Sent failed", e));
}

/** Dépose une copie du message envoyé dans le dossier « Envoyés » de la boîte (IMAP APPEND). */
async function appendToSent(account: MailAccount, raw: Buffer): Promise<void> {
  await withImap(account, async (c) => {
    const boxes = await c.list();
    const sent =
      boxes.find((b) => b.specialUse === "\\Sent") ||
      boxes.find((b) => /^(sent|sent items|sent messages|envoy)/i.test(b.name)) ||
      boxes.find((b) => /sent|envoy/i.test(b.path));
    if (sent) await c.append(sent.path, raw, ["\\Seen"]);
  });
}

/**
 * Contacts récents pour l'autocomplétion de l'adresse : expéditeurs récents (INBOX)
 * + destinataires récents (Envoyés). Dédupliqués par adresse, en minuscules.
 */
export async function listRecentContacts(account: MailAccount, limit = 80): Promise<{ name: string; address: string }[]> {
  return withImap(account, async (c) => {
    const seen = new Map<string, { name: string; address: string }>();
    const boxes = await c.list();
    const sent = boxes.find((b) => b.specialUse === "\\Sent");
    const sources: { path: string; field: "from" | "to" }[] = [{ path: "INBOX", field: "from" }];
    if (sent) sources.push({ path: sent.path, field: "to" });
    for (const src of sources) {
      try {
        const lock = await c.getMailboxLock(src.path);
        try {
          const status = await c.status(src.path, { messages: true });
          const total = status.messages ?? 0;
          if (!total) continue;
          const start = Math.max(1, total - limit + 1);
          for await (const msg of c.fetch(`${start}:*`, { envelope: true })) {
            const addrs = src.field === "from" ? msg.envelope?.from : msg.envelope?.to;
            for (const a of addrs ?? []) {
              const address = (a.address || "").toLowerCase().trim();
              if (!address || seen.has(address)) continue;
              seen.set(address, { name: a.name || "", address });
            }
          }
        } finally { lock.release(); }
      } catch { /* on ignore une source en erreur */ }
    }
    return [...seen.values()];
  });
}
