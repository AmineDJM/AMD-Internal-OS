"use client";

import * as React from "react";
import { BellRing, Loader2, Check } from "lucide-react";
import { sansBloquer } from "@/lib/journal";
import { getKey, subscribe, supported } from "./push-register";

/**
 * Bouton visible : demande la permission **notifications** puis, si le serveur a des clés
 * VAPID, abonne l'appareil au **Web Push** (réception même navigateur fermé). Sans VAPID,
 * la permission suffit : les **notifications bureau** pour un nouveau message s'affichent
 * quand l'onglet est ouvert (même en arrière-plan / sur un autre site). Donc utile dans
 * tous les cas — on n'exige plus la configuration serveur pour proposer l'activation.
 */
export function EnablePushButton() {
  const [state, setState] = React.useState<"idle" | "busy" | "on" | "denied" | "unsupported">("idle");
  const key = React.useRef<{ enabled: boolean; publicKey: string } | null>(null);

  React.useEffect(() => {
    if (!supported()) { setState("unsupported"); return; }
    void getKey().then((k) => { key.current = k; }); // pré-charge la clé VAPID (si configurée)
    if (Notification.permission === "granted") setState("on");
    else if (Notification.permission === "denied") setState("denied");
  }, []);

  async function enable() {
    setState("busy");
    try {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") { setState(perm === "denied" ? "denied" : "idle"); return; }
      // Web Push (navigateur fermé) uniquement si le serveur a des clés VAPID ; sinon les
      // notifications bureau locales (onglet ouvert) fonctionnent déjà avec la permission.
      const k = key.current ?? (await getKey());
      if (k?.enabled && k.publicKey) await subscribe(k.publicKey).catch(sansBloquer("push-register.enable.subscribe"));
      setState("on");
    } catch { setState("idle"); }
  }

  if (state === "unsupported") return null;
  if (state === "on") {
    return <span className="inline-flex items-center gap-1.5 rounded-lg bg-success/10 px-3 py-1.5 text-sm font-medium text-success"><Check className="h-4 w-4" /> Notifications activées sur cet appareil</span>;
  }
  if (state === "denied") {
    return <span className="text-sm text-muted-foreground">Notifications bloquées par le navigateur — autorisez-les dans les réglages du site.</span>;
  }
  return (
    <button onClick={enable} disabled={state === "busy"}
      className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-60">
      {state === "busy" ? <Loader2 className="h-4 w-4 animate-spin" /> : <BellRing className="h-4 w-4" />}
      Activer les notifications sur cet appareil
    </button>
  );
}
