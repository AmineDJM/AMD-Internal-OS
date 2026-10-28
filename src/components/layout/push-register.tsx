"use client";

/*
 * L'abonnement Web Push de l'appareil. Le bouton « Activer » vit à part (`push-activer.tsx`) : ce module
 * est monté par la coque, qui embarque TOUS ses exports — le bouton n'y servait qu'à la page Notifications.
 */

import * as React from "react";
import { sansBloquer } from "@/lib/journal";

// Convertit la clé publique VAPID (base64url) en Uint8Array pour PushManager.
function urlB64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export async function getKey(): Promise<{ enabled: boolean; publicKey: string } | null> {
  try {
    const r = await fetch("/api/push/key", { cache: "no-store" });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

export async function subscribe(publicKey: string): Promise<boolean> {
  const reg = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(publicKey) });
  }
  const res = await fetch("/api/push/subscribe", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(sub.toJSON()),
  });
  return res.ok;
}

export function supported(): boolean {
  return typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

/** Silencieux : enregistre le SW et (ré)abonne l'appareil si la permission est déjà accordée. */
export function PushRegister() {
  React.useEffect(() => {
    if (!supported()) return;
    navigator.serviceWorker.register("/sw.js").catch(sansBloquer("push-register.PushRegister.register"));
    if (Notification.permission !== "granted") return;
    getKey().then((k) => { if (k?.enabled && k.publicKey) subscribe(k.publicKey).catch(sansBloquer("push-register.PushRegister.subscribe")); });
  }, []);
  return null;
}
