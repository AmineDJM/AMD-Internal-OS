"use client";

import React, { useEffect, useState } from "react";
import { ReglageDOffice } from "../missions/reglage-d-office";
import { Bell, LogOut, Monitor, Moon, Smartphone, Sun, Volume2, X } from "lucide-react";
import { deconnecterMonAppareil, listerMesAppareils, type AppareilConnecte } from "@/modules/assistant-ia/actions-conversations";
import { activerNotifications } from "./hors-ligne";
import { sansBloquer } from "@/lib/journal";
import { useEchap } from "../use-echap";

/**
 * LES RÉGLAGES D'ADVENTUM IA — thème (clair, sombre, comme l'appareil), réponses vocales, notifications de CET
 * appareil, appareils connectés (déconnexion à distance : un téléphone perdu se déconnecte d'ici), se déconnecter.
 */
export type Theme = "systeme" | "clair" | "sombre";
const CLE_THEME = "adventum-ia:theme";

export function lireTheme(): Theme {
  try { const t = localStorage.getItem(CLE_THEME); return t === "clair" || t === "sombre" ? t : "systeme"; } catch { return "systeme"; }
}

/** Applique le thème : `data-theme` pour les jetons de l'app, classe `dark` pour les composants partagés avec l'ERP. */
export function appliquerTheme(t: Theme, racine: HTMLElement | null): void {
  try { localStorage.setItem(CLE_THEME, t); } catch { /* navigation privée : le choix vaut pour la page */ }
  const sombre = t === "sombre" || (t === "systeme" && window.matchMedia?.("(prefers-color-scheme: dark)").matches);
  if (racine) {
    if (t === "systeme") racine.removeAttribute("data-theme");
    else racine.setAttribute("data-theme", t);
  }
  document.documentElement.classList.toggle("dark", !!sombre);
}

export function Reglages({ theme, onTheme, reponseVocale, onReponseVocale, onFermer, deconnexion }: {
  theme: Theme;
  onTheme: (t: Theme) => void;
  reponseVocale: boolean;
  onReponseVocale: () => void;
  onFermer: () => void;
  /** Le formulaire de déconnexion (action d'authentification de l'ERP, posée par la page). */
  deconnexion: React.ReactNode;
}) {
  const [appareils, setAppareils] = useState<AppareilConnecte[] | null>(null);
  const [avis, setAvis] = useState<string | null>(null);
  const relire = () => void listerMesAppareils().then((r) => setAppareils(r.ok ? r.appareils : [])).catch(sansBloquer("reglages.appareils"));
  useEffect(relire, []);
  useEchap(onFermer);

  const choix = (t: Theme, libelle: string, Icone: typeof Sun) => (
    <button type="button" aria-pressed={theme === t} onClick={() => onTheme(t)}
      className="flex flex-1 flex-col items-center gap-1 rounded-lg border border-[var(--aia-filet)] px-2 py-2 text-[12.5px] hover:bg-[var(--aia-survol)] aria-pressed:border-[var(--aia-accent)] aria-pressed:bg-[var(--aia-accent-doux)] aria-pressed:text-[var(--aia-accent)]">
      <Icone className="h-4 w-4" aria-hidden /> {libelle}
    </button>
  );

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/40 p-4" role="dialog" aria-modal="true" aria-label="Réglages">
      <button type="button" aria-label="Fermer" onClick={onFermer} className="absolute inset-0" />
      <div className="relative flex max-h-[90dvh] w-full max-w-[520px] flex-col gap-4 overflow-y-auto rounded-2xl bg-[var(--aia-panneau)] p-5 text-[var(--aia-texte)] shadow-2xl">
        <div className="flex items-center">
          <h2 className="flex-1 text-[19px] font-semibold">Réglages</h2>
          <button type="button" onClick={onFermer} aria-label="Fermer" className="flex h-9 w-9 items-center justify-center rounded-lg hover:bg-[var(--aia-survol)]"><X className="h-4 w-4" /></button>
        </div>

        <section className="flex flex-col gap-2">
          <h3 className="text-[13px] font-semibold">Thème</h3>
          <div className="flex gap-2">{choix("clair", "Clair", Sun)}{choix("sombre", "Sombre", Moon)}{choix("systeme", "Comme l'appareil", Monitor)}</div>
        </section>

        <section className="flex flex-col gap-2">
          <h3 className="text-[13px] font-semibold">Voix</h3>
          <label className="flex items-center gap-3 text-[14px]">
            <Volume2 className="h-4 w-4 text-[var(--aia-discret)]" aria-hidden />
            <span className="flex-1">Lire aussi chaque réponse à voix haute</span>
            <input type="checkbox" checked={reponseVocale} onChange={onReponseVocale} className="h-4 w-4 accent-[var(--aia-accent)]" />
          </label>
        </section>

        <section className="flex flex-col gap-2">
          <h3 className="text-[13px] font-semibold">Missions en arrière-plan</h3>
          <ReglageDOffice />
        </section>

        <section className="flex flex-col gap-2">
          <h3 className="text-[13px] font-semibold">Notifications</h3>
          <p className="text-[13px] text-[var(--aia-discret)]">Une réponse prête, un travail terminé, une validation qui vous attend : l&apos;app vous prévient et s&apos;ouvre sur la bonne conversation.</p>
          <button type="button" onClick={async () => setAvis(await activerNotifications().catch(sansBloquer("reglages.activerNotifications", "L'activation a échoué. Réessayez.")))}
            className="inline-flex items-center gap-2 self-start rounded-lg bg-[var(--aia-accent)] px-3 py-2 text-[13.5px] font-medium text-[var(--aia-accent-fg)] hover:bg-[var(--aia-accent-fort)]">
            <Bell className="h-4 w-4" aria-hidden /> Activer sur cet appareil
          </button>
          {avis && <p role="status" className="text-[12.5px] text-[var(--aia-discret)]">{avis}</p>}
        </section>

        <section className="flex flex-col gap-2" aria-label="Appareils connectés">
          <h3 className="text-[13px] font-semibold">Appareils connectés</h3>
          <p className="text-[12.5px] text-[var(--aia-discret)]">Vous restez connecté 30 jours sur votre téléphone. Un appareil perdu ? Déconnectez-le d&apos;ici.</p>
          {appareils?.map((a) => (
            <div key={a.id} className="flex items-center gap-2 rounded-lg border border-[var(--aia-filet)] px-3 py-2 text-[13.5px]">
              <Smartphone className="h-4 w-4 shrink-0 text-[var(--aia-discret)]" aria-hidden />
              <span className="min-w-0 flex-1 truncate">{a.appareil}{a.courant && <span className="text-[var(--aia-accent)]"> · cet appareil</span>}</span>
              {!a.courant && (
                <button type="button" className="text-[12.5px] text-[var(--aia-danger)] hover:underline"
                  onClick={async () => { const r = await deconnecterMonAppareil(a.id); setAvis(r.ok ? "Appareil déconnecté." : r.erreur); relire(); }}>
                  Déconnecter
                </button>
              )}
            </div>
          ))}
        </section>

        <section className="flex items-center gap-2 border-t border-[var(--aia-filet)] pt-3">
          <LogOut className="h-4 w-4 text-[var(--aia-discret)]" aria-hidden />
          {deconnexion}
        </section>
      </div>
    </div>
  );
}
