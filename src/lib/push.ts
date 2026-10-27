import webpush from "web-push";
import { prisma } from "./prisma";
import { sortieAutorisee } from "@/lib/sortie/garde";
import { endpointPushAutorise } from "@/lib/notifications/endpoint-push";

/**
 * Notifications **push** (Web Push / PWA) — serveur uniquement.
 *
 * VAPID est **auto-configuré** (Web Push est gratuit et illimité — il passe par les services
 * push des navigateurs) : si `VAPID_PUBLIC_KEY` + `VAPID_PRIVATE_KEY` sont fournis par
 * l'environnement, on les utilise ; sinon on **génère une paire une seule fois** et on la
 * **persiste** dans `AppSetting` (stable ensuite). Résultat : le push fonctionne par défaut,
 * sans configuration. La clé privée n'est jamais exposée au navigateur ; la clé publique est
 * servie via `/api/push/key`.
 */

interface Vapid { pub: string; priv: string }

let cached: Vapid | null = null;
let inflight: Promise<Vapid | null> | null = null;

function envKeys(): Vapid | null {
  const pub = process.env.VAPID_PUBLIC_KEY || "";
  const priv = process.env.VAPID_PRIVATE_KEY || "";
  return pub && priv ? { pub, priv } : null;
}

/** Lit les clés (env → base → génération+persistance). Best-effort : null si la base est indisponible. */
async function loadOrCreateKeys(): Promise<Vapid | null> {
  const env = envKeys();
  if (env) { cached = env; return env; }
  try {
    const s = await prisma.appSetting.findUnique({ where: { id: "global" }, select: { vapidPublicKey: true, vapidPrivateKey: true } });
    if (s?.vapidPublicKey && s?.vapidPrivateKey) { cached = { pub: s.vapidPublicKey, priv: s.vapidPrivateKey }; return cached; }
    // Aucune clé encore : on en génère une et on la persiste (ligne globale créée au besoin).
    const gen = webpush.generateVAPIDKeys();
    await prisma.appSetting.upsert({
      where: { id: "global" },
      create: { id: "global", vapidPublicKey: gen.publicKey, vapidPrivateKey: gen.privateKey },
      update: { vapidPublicKey: gen.publicKey, vapidPrivateKey: gen.privateKey },
    });
    // Relit la valeur réellement enregistrée (en cas de course, on prend la gagnante).
    const fresh = await prisma.appSetting.findUnique({ where: { id: "global" }, select: { vapidPublicKey: true, vapidPrivateKey: true } });
    cached = fresh?.vapidPublicKey && fresh?.vapidPrivateKey
      ? { pub: fresh.vapidPublicKey, priv: fresh.vapidPrivateKey }
      : { pub: gen.publicKey, priv: gen.privateKey };
    return cached;
  } catch (err) {
    console.error("[push] clés VAPID indisponibles", err);
    return null;
  }
}

async function getKeys(): Promise<Vapid | null> {
  if (cached) return cached;
  const env = envKeys();
  if (env) { cached = env; return env; }
  if (!inflight) inflight = loadOrCreateKeys().finally(() => { inflight = null; });
  return inflight;
}

/** Toujours vrai en pratique (clés auto-générées) — faux seulement si la base est injoignable. */
export async function pushConfigured(): Promise<boolean> {
  return (await getKeys()) !== null;
}

export async function vapidPublicKey(): Promise<string> {
  return (await getKeys())?.pub ?? "";
}

let vapidReady = false;
async function ensureVapid(): Promise<boolean> {
  const k = await getKeys();
  if (!k) return false;
  if (!vapidReady) {
    webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:admin@adventum.dz", k.pub, k.priv);
    vapidReady = true;
  }
  return true;
}

export interface PushPayload {
  title: string;
  body?: string;
  url?: string;
  /** Regroupe/relance la notification (ex. un appel = un tag unique). */
  tag?: string;
  /** Garde la notification affichée jusqu'à interaction (appels entrants). */
  requireInteraction?: boolean;
}

/** Pousse une notification à tous les appareils d'un utilisateur (best-effort). */
export async function sendPushToUser(userId: string, payload: PushPayload): Promise<void> {
  // Une notification poussée est « au mieux » : elle ne doit pas faire tomber une mission. On
  // prend donc la variante qui NE LÈVE PAS — mais qui enregistre quand même la tentative, pour
  // que le banc puisse dire ce qu'Adam aurait notifié.
  if (!sortieAutorisee("NOTIFICATION_PUSH", userId, { apercu: payload.title, origine: "push:sendPushToUser" })) return;
  if (!(await ensureVapid())) return;
  try {
    const subs = await prisma.pushSubscription.findMany({ where: { userId } });
    if (subs.length === 0) return;
    const data = JSON.stringify({
      title: payload.title,
      body: payload.body ?? "",
      url: payload.url ?? "/",
      tag: payload.tag,
      requireInteraction: payload.requireInteraction ?? false,
    });
    await Promise.all(
      subs.map(async (s) => {
        try {
          // Abonnement enregistré avant la règle d'adresse : jamais de POST hors des services push.
          if (!endpointPushAutorise(s.endpoint)) return;
          await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, data);
        } catch (e) {
          // 404 / 410 = abonnement expiré → on le supprime.
          const code = (e as { statusCode?: number })?.statusCode;
          if (code === 404 || code === 410) await prisma.pushSubscription.delete({ where: { id: s.id } }).catch(() => {});
        }
      }),
    );
  } catch (err) {
    console.error("[push] send failed", err);
  }
}
