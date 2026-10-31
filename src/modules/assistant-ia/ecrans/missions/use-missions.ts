"use client";

import { useEffect, useSyncExternalStore } from "react";
import type { TableauDesMissions } from "@/modules/assistant-ia/api";
import { lireMonTableauDeMissions } from "@/modules/assistant-ia/actions-travaux";
import { sansBloquer } from "@/lib/journal";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE TABLEAU DE BORD EN TEMPS RÉEL, CÔTÉ ÉCRAN (K3, décision 0033) — UNE connexion par onglet, partagée par
 * l'indicateur de l'en-tête, les cartes de la conversation et le tableau « Missions ».
 *
 *   • FLUX : `EventSource("/api/assistant-ia/missions/flux")` — le serveur pousse le tableau dès qu'une étape change ;
 *     il ferme de lui-même toutes les 4 min 30 et le navigateur se reconnecte (`retry`).
 *   • REPLI : trois erreurs de suite sans un seul message, ou l'onglet sans `EventSource` → SONDAGE COURT (3 s) par
 *     l'action serveur, et un nouvel essai du flux toutes les 30 s. Jamais le sondage de 15 s d'avant.
 *   • DISCRET : onglet caché → flux fermé ; revenu → rouvert (le tableau repart à jour).
 *   • FIN D'UNE MISSION : l'écran relit la conversation (`assistant-fil:relancer`) — la synthèse y apparaît aussitôt.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type ModeFlux = "connexion" | "direct" | "releve" | "arret";

interface Etat {
  tableau: TableauDesMissions | null;
  mode: ModeFlux;
  /** Quand le dernier tableau est arrivé (horloge de l'écran) — l'écran le montre, le banc mesure la latence. */
  recuLe: number | null;
}

const SONDAGE_MS = 3_000;
const REESSAI_FLUX_MS = 30_000;
const ERREURS_AVANT_RELEVE = 3;

let etat: Etat = { tableau: null, mode: "arret", recuLe: null };
const abonnes = new Set<() => void>();
let utilisateurs = 0;
let source: EventSource | null = null;
let erreurs = 0;
let sondage: ReturnType<typeof setInterval> | null = null;
let reessai: ReturnType<typeof setTimeout> | null = null;

function publier(maj: Partial<Etat>) {
  const avant = etat.tableau;
  etat = { ...etat, ...maj };
  if (maj.tableau && avant) {
    // Une mission vient de FINIR : la conversation se relit (la synthèse s'y écrit à ce moment-là).
    const finies = new Set(maj.tableau.missions.filter((m) => ["TERMINE", "ANNULE", "ECHEC", "BLOQUE"].includes(m.etat)).map((m) => m.id));
    if (avant.missions.some((m) => finies.has(m.id) && !["TERMINE", "ANNULE", "ECHEC", "BLOQUE"].includes(m.etat))) {
      window.dispatchEvent(new Event("assistant-fil:relancer"));
      setTimeout(() => window.dispatchEvent(new Event("assistant-fil:relancer")), 4_000);
    }
  }
  for (const f of abonnes) f();
}

function recevoir(t: TableauDesMissions) {
  publier({ tableau: t, recuLe: Date.now() });
}

async function relever() {
  try {
    const r = await lireMonTableauDeMissions();
    if (r.ok) recevoir(r.tableau);
  } catch (e) {
    sansBloquer("missions.relever")(e);
  }
}

function arreterSondage() {
  if (sondage) clearInterval(sondage);
  sondage = null;
}

function passerEnReleve() {
  fermerFlux();
  publier({ mode: "releve" });
  if (!sondage) { void relever(); sondage = setInterval(() => void relever(), SONDAGE_MS); }
  if (reessai) clearTimeout(reessai);
  reessai = setTimeout(() => { reessai = null; if (utilisateurs > 0) ouvrirFlux(); }, REESSAI_FLUX_MS);
}

function fermerFlux() {
  if (source) { source.close(); source = null; }
}

function ouvrirFlux() {
  if (typeof window === "undefined" || source) return;
  if (typeof EventSource === "undefined") { passerEnReleve(); return; }
  erreurs = 0;
  publier({ mode: etat.tableau ? etat.mode : "connexion" });
  const s = new EventSource("/api/assistant-ia/missions/flux");
  source = s;
  s.addEventListener("tableau", (ev) => {
    erreurs = 0;
    arreterSondage();
    try { recevoir(JSON.parse((ev as MessageEvent<string>).data) as TableauDesMissions); } catch (e) { sansBloquer("missions.flux.json")(e); }
    if (etat.mode !== "direct") publier({ mode: "direct" });
  });
  s.onerror = () => {
    erreurs += 1;
    // Le navigateur se reconnecte seul ; au-delà de trois échecs sans un message, le flux ne passe pas (mandataire) :
    // relève courte, et nouvel essai plus tard.
    if (erreurs >= ERREURS_AVANT_RELEVE || s.readyState === EventSource.CLOSED) passerEnReleve();
    else publier({ mode: "connexion" });
  };
}

function demarrer() {
  ouvrirFlux();
  document.addEventListener("visibilitychange", surVisibilite);
}

function arreter() {
  fermerFlux();
  arreterSondage();
  if (reessai) clearTimeout(reessai);
  reessai = null;
  document.removeEventListener("visibilitychange", surVisibilite);
  publier({ mode: "arret" });
}

function surVisibilite() {
  if (document.visibilityState === "hidden") { fermerFlux(); arreterSondage(); return; }
  if (etat.mode === "releve") passerEnReleve(); else ouvrirFlux();
}

const abonner = (f: () => void) => { abonnes.add(f); return () => { abonnes.delete(f); }; };
const lire = () => etat;
const SERVEUR: Etat = { tableau: null, mode: "arret", recuLe: null };

/** Le tableau de bord en temps réel — la connexion vit tant qu'un composant s'en sert. `actif: false` en Vue exacte. */
export function useMissions(actif = true): Etat & { relire: () => Promise<void> } {
  useEffect(() => {
    if (!actif) return;
    utilisateurs += 1;
    if (utilisateurs === 1) demarrer();
    return () => {
      utilisateurs -= 1;
      if (utilisateurs === 0) arreter();
    };
  }, [actif]);
  const e = useSyncExternalStore(abonner, lire, () => SERVEUR);
  return { ...e, relire: relever };
}
