"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import type { DonneesImpots, EcheanceVue } from "../../infra/impots";
import type { SaisiesFiscales } from "../../domaine/impots";

/**
 * Les petites pièces partagées par les panneaux d'« Impôts & cotisations » : la pastille de choix, la note, l'en-tête
 * de panneau, le résultat d'une action (le message du serveur, tel qu'il le dit).
 */

export type Societe = DonneesImpots["societes"][number];
export type Ligne = EcheanceVue;

/** Le message d'un geste réussi, montré en tête d'écran (maquette : un bandeau « Fermer »). */
export type Annoncer = (message: string) => void;

export const nomSociete = (s: Societe | undefined) => (s ? s.shortName?.trim() || s.name : "—");

/** Une pastille à bascule (filtre, société, organisme) — `aria-pressed`, comme la maquette. */
export function Pastille({ actif, onClick, children, disabled }: { actif: boolean; onClick: () => void; children: React.ReactNode; disabled?: boolean }) {
  return (
    <button
      type="button" aria-pressed={actif} onClick={onClick} disabled={disabled}
      className={cn(
        "h-9 rounded-full border px-3 text-sm transition-colors disabled:opacity-60",
        actif ? "border-primary bg-primary/10 font-semibold text-primary" : "border-border bg-card text-muted-foreground hover:bg-secondary",
      )}
    >
      {children}
    </button>
  );
}

/** Une note en tête de panneau : ambre (à vérifier), rouge (refus), neutre. */
export function Note({ ton = "alerte", children }: { ton?: "alerte" | "refus" | "neutre"; children: React.ReactNode }) {
  return (
    <div
      role="note"
      className={cn(
        "rounded-lg border px-3 py-2.5 text-sm leading-relaxed",
        ton === "alerte" && "border-warning/30 bg-warning/10 text-foreground",
        ton === "refus" && "border-destructive/30 bg-destructive/10 text-destructive",
        ton === "neutre" && "border-border bg-secondary/50 text-foreground",
      )}
    >
      {children}
    </div>
  );
}

export function EnTetePanneau({ surtitre, titre, children, onFermer }: { surtitre: string; titre: string; children?: React.ReactNode; onFermer: () => void }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="text-sm text-muted-foreground">{surtitre}</p>
        <h2 className="mt-1 text-lg font-bold [overflow-wrap:anywhere]">{titre}</h2>
        {children}
      </div>
      <button type="button" onClick={onFermer} aria-label="Fermer le panneau" className="h-9 w-9 flex-none rounded-lg border border-border bg-card hover:bg-secondary">✕</button>
    </div>
  );
}

export function TitreSection({ children }: { children: React.ReactNode }) {
  return <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{children}</h3>;
}

/** Une puce d'étape : fait (✓), refusé (✕), en attente (…). */
export function PuceEtape({ etat }: { etat: "fait" | "refuse" | "attente" }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex h-6 w-6 flex-none items-center justify-center rounded-full text-xs font-bold",
        etat === "fait" && "bg-success/10 text-success",
        etat === "refuse" && "bg-destructive/10 text-destructive",
        etat === "attente" && "bg-secondary text-muted-foreground",
      )}
    >
      {etat === "fait" ? "✓" : etat === "refuse" ? "✕" : "…"}
    </span>
  );
}

export const dateCourte = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString("fr-FR", { day: "numeric", month: "short", timeZone: "Africa/Algiers" }) : "";

/** Les saisies d'une ligne en cours d'édition : celles de l'écran si on y a touché, sinon celles enregistrées. */
export function saisiesDe(l: Ligne, brouillons: Record<string, SaisiesFiscales>): SaisiesFiscales {
  return brouillons[l.id] ?? l.saisies ?? {};
}

export const champ = "h-10 w-full rounded-lg border border-border bg-card px-2.5 text-sm disabled:opacity-60";
