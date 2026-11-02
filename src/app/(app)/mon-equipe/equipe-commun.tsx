import * as React from "react";
import { cn, formatDate, initials } from "@/lib/utils";
import type { AlerteEquipe, GenreEvenement, LigneEquipe, TonAlerte } from "@/lib/queries/my-team-overview";

/**
 * Les petites pièces partagées par les trois vues de Mon Équipe et le panneau d'une personne. Rien ici ne lit la base :
 * tout arrive déjà calculé du serveur (`getMyTeamOverview`).
 */

/** « AAAA-MM-JJ » → « 12 oct. » — le jour tel qu'il a été écrit, lu à minuit UTC. */
export const jourCourt = (jour: string) => formatDate(`${jour}T00:00:00Z`, { day: "numeric", month: "short", timeZone: "UTC" });
export const jourLong = (jour: string) => formatDate(`${jour}T00:00:00Z`, { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
export const prenom = (nom: string) => nom.trim().split(/\s+/)[0] ?? nom;

/** Les couleurs des événements — les mêmes dans la semaine, le calendrier et sa légende. */
export const GENRE: Record<GenreEvenement | "ANNIVERSAIRE", { label: string; puce: string; cellule: string }> = {
  CONGE: { label: "Congé", puce: "bg-warning/15 text-warning border-warning/25", cellule: "bg-warning/70" },
  // « Absent » : maladie, maternité, événement familial… — dit sans sa nature (§118.184) ; les RH y lisent le type précis (`libelle`).
  ABSENCE: { label: "Absent", puce: "bg-destructive/10 text-destructive border-destructive/20", cellule: "bg-destructive/60" },
  MISSION: { label: "Mission", puce: "bg-primary/10 text-primary border-primary/20", cellule: "bg-primary/70" },
  FORMATION: { label: "Formation", puce: "bg-purple-500/10 text-purple-700 border-purple-500/20 dark:text-purple-300", cellule: "bg-purple-500/70" },
  ANNIVERSAIRE: { label: "Anniversaire", puce: "bg-success/10 text-success border-success/20", cellule: "bg-success/70" },
};

export const POINT_TON: Record<TonAlerte, string> = {
  danger: "bg-destructive",
  warning: "bg-warning",
  info: "bg-primary",
  success: "bg-success",
};

/** Le statut du jour, en un mot — « Congé → 14 oct. », « Mission Oran ». */
export function statutDuJour(l: LigneEquipe): { texte: string; tone: "success" | "warning" | "info" | "purple" } {
  const a = l.aujourdhui;
  if (a.genre === "CONGE") return { texte: `Congé → ${a.jusquAu ? jourCourt(a.jusquAu) : "—"}`, tone: "warning" };
  // `libelle` n'est rempli que pour qui gère les RH (le type précis) ; pour un encadrant, c'est simplement « Absent ».
  if (a.genre === "ABSENCE") return { texte: `Absent${a.libelle ? ` (${a.libelle.toLowerCase()})` : ""} → ${a.jusquAu ? jourCourt(a.jusquAu) : "—"}`, tone: "warning" };
  if (a.genre === "MISSION") return { texte: `Mission${a.libelle ? ` ${a.libelle}` : ""}`, tone: "info" };
  if (a.genre === "FORMATION") return { texte: "Formation", tone: "purple" };
  return { texte: "Présent", tone: "success" };
}

export function Avatar({ nom, absent, taille = "md" }: { nom: string; absent?: boolean; taille?: "md" | "lg" }) {
  return (
    <span className={cn(
      "relative inline-flex shrink-0 items-center justify-center rounded-full bg-primary/10 font-semibold text-primary",
      taille === "lg" ? "h-12 w-12 text-base" : "h-8 w-8 text-xs",
    )}>
      {initials(nom)}
      {absent && <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-card bg-warning" aria-label="absent aujourd'hui" />}
    </span>
  );
}

/** La plus grave des alertes d'une personne, en une pastille. */
export function PastilleAlerte({ a }: { a: AlerteEquipe | undefined }) {
  if (!a) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs">
      <span className={cn("h-2 w-2 rounded-full", POINT_TON[a.ton])} aria-hidden />
      {a.court}
    </span>
  );
}
