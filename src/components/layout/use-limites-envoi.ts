"use client";

import * as React from "react";
import { sansBloquer } from "@/lib/journal";

/** Ce que le serveur dit des envois — lu une fois par onglet, puis gardé. */
export interface LimitesEnvoi {
  maxUploadMb: number;
  maxDriveUploadMb: number;
  stockageObjet: boolean;
  seuilDirectOctets: number;
  maxSansStockageObjetMo: number;
}

let promesse: Promise<LimitesEnvoi | null> | null = null;

/** Lit les limites (cache d'onglet). `null` si le serveur ne répond pas : on n'empêche alors rien. */
export function lireLimitesEnvoi(): Promise<LimitesEnvoi | null> {
  promesse ??= fetch("/api/uploads/limites", { cache: "no-store" })
    .then((r) => (r.ok ? (r.json() as Promise<LimitesEnvoi>) : null))
    .catch(sansBloquer("use-limites-envoi.lireLimitesEnvoi.fetch", null))
    .then((l) => { if (!l) promesse = null; return l; });
  return promesse;
}

export function useLimitesEnvoi(): LimitesEnvoi | null {
  const [l, setL] = React.useState<LimitesEnvoi | null>(null);
  React.useEffect(() => { let vivant = true; void lireLimitesEnvoi().then((x) => { if (vivant) setL(x); }); return () => { vivant = false; }; }, []);
  return l;
}
