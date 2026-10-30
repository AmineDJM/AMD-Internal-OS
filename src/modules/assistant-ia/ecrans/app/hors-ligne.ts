"use client";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * ADVENTUM IA HORS LIGNE — LE MINIMUM (décision 0027, point 11) — et les notifications de l'appareil.
 *
 * Un vocal enregistré sans réseau (métro, avion, zone blanche) n'est PAS perdu : il attend dans l'appareil (IndexedDB)
 * et part de lui-même au retour du réseau, dans la conversation où il a été dit. Rien d'autre n'est gardé hors ligne.
 * Quand le lot J13 (vocaux terrain hors ligne) sera sur la base, sa file remplacera celle-ci par la même porte
 * (`mettreEnFile` / `viderLaFile`).
 *
 * Les notifications : le service worker de l'app (`/ia-sw.js`, portée `/ia`) reçoit le Web Push (clés VAPID
 * existantes) et ouvre la bonne conversation au toucher.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const BASE = "adventum-ia";
const MAGASIN = "vocaux";

export interface VocalEnFile { id: string; conversation: string | null; audio: Blob; dureeS: number; creeLe: number }

function ouvrir(): Promise<IDBDatabase> {
  return new Promise((ok, ko) => {
    const r = indexedDB.open(BASE, 1);
    r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(MAGASIN)) r.result.createObjectStore(MAGASIN, { keyPath: "id" }); };
    r.onsuccess = () => ok(r.result);
    r.onerror = () => ko(r.error);
  });
}

async function transaction<T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await ouvrir();
  return new Promise<T>((ok, ko) => {
    const req = f(db.transaction(MAGASIN, mode).objectStore(MAGASIN));
    req.onsuccess = () => ok(req.result);
    req.onerror = () => ko(req.error);
  }).finally(() => db.close());
}

export async function mettreEnFile(v: Omit<VocalEnFile, "id" | "creeLe">): Promise<void> {
  await transaction("readwrite", (s) => s.put({ ...v, id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, creeLe: Date.now() }));
}

export async function vocauxEnFile(): Promise<VocalEnFile[]> {
  try { return await transaction("readonly", (s) => s.getAll() as IDBRequest<VocalEnFile[]>); } catch { return []; }
}

/** Envoie ce qui attend, dans l'ordre ; s'arrête à la première panne réseau (on réessaiera au prochain retour). */
export async function viderLaFile(envoyer: (v: VocalEnFile) => Promise<boolean>): Promise<number> {
  let partis = 0;
  for (const v of (await vocauxEnFile()).sort((a, b) => a.creeLe - b.creeLe)) {
    if (!(await envoyer(v))) break;
    await transaction("readwrite", (s) => s.delete(v.id));
    partis++;
  }
  return partis;
}

// ── Notifications de l'appareil ──────────────────────────────────────────────────────────────

function cleVapid(base64: string): Uint8Array {
  const b64 = (base64 + "=".repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const brut = atob(b64);
  return Uint8Array.from(brut, (c) => c.charCodeAt(0));
}

export const notificationsPossibles = (): boolean =>
  typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

/** Le service worker de l'app : notifications et coquille hors ligne. Silencieux en cas d'échec. */
export function enregistrerServiceWorker(): void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("/ia-sw.js", { scope: "/ia" }).catch(() => undefined);
}

/** Demande la permission (geste de la personne) et abonne CET appareil. Rend la phrase à afficher. */
export async function activerNotifications(): Promise<string> {
  if (!notificationsPossibles()) return "Cet appareil ne reçoit pas de notifications. Sur iPhone : ajoutez d'abord l'app à l'écran d'accueil (Partager › Sur l'écran d'accueil).";
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return "Notifications refusées : autorisez-les dans les réglages de l'appareil.";
  const cle = await fetch("/api/push/key", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null) as { enabled?: boolean; publicKey?: string } | null;
  if (!cle?.enabled || !cle.publicKey) return "Les notifications ne sont pas configurées sur le serveur (clés VAPID).";
  const reg = await navigator.serviceWorker.register("/ia-sw.js", { scope: "/ia" });
  await navigator.serviceWorker.ready;
  const abonnement = (await reg.pushManager.getSubscription())
    ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: cleVapid(cle.publicKey) as BufferSource }));
  const r = await fetch("/api/push/subscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(abonnement.toJSON()) });
  return r.ok ? "Notifications activées sur cet appareil." : "L'abonnement n'a pas été enregistré. Réessayez.";
}
