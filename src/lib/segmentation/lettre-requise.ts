import type { Lettre, Statut } from "./regles";

/**
 * LA LETTRE PARTOUT (Direction, 07/10) — module PUR : pour un praticien, la lettre de segmentation (H, A–D, NA, non
 * ciblé) et les visites qu'elle demande par cycle (lettre × In/Out × fréquence du secteur, calculées par le moteur), vues
 * depuis le KAM ou la BU qui le regarde. C'est le SEUL « requis » : pilotage, cockpit, Ma journée et plan de tournée le
 * lisent ici.
 *
 * Repli : un praticien rangé dans AUCUNE stratégie publiée garde l'ancien palier de potentiel (`MedicalDoctor.potential`
 * × `SfeSettings.frequencyByTier`) — sans lettre. Il ne disparaît pas des comptes, et l'écran dit d'où vient le chiffre.
 *
 * Zéro import de valeur : un composant client peut le lire.
 */

/** Le praticien dans UNE stratégie (une BU), tel que le moteur le classe. */
export interface EntreeLettre {
  buId: string;
  strategieId: string;
  lettre: Lettre;
  /** Visites requises par cycle (0 pour NA et non ciblé ; 0,5 = une visite tous les deux cycles). */
  visites: number;
  statut: Statut | null;
  secteurId: string | null;
  secteurNom: string | null;
}

export type SourceRequis = "SEGMENTATION" | "POTENTIEL";

export interface RequisPraticien {
  /** null = hors de toute stratégie : repli sur le palier de potentiel. */
  lettre: Lettre | null;
  visites: number;
  source: SourceRequis;
  buId: string | null;
  statut: Statut | null;
}

/**
 * LA STRATÉGIE QUI PARLE pour ce praticien : celle de la BU demandée (le KAM qui le voit, la BU qu'on pilote) ; à
 * défaut, la première où il est classé (ordre de chargement — BU par ordre d'affichage). Aucune : null.
 */
export function choisirEntree(entrees: readonly EntreeLettre[] | undefined, buId: string | null | undefined): EntreeLettre | null {
  if (!entrees || entrees.length === 0) return null;
  return (buId ? entrees.find((e) => e.buId === buId) : undefined) ?? entrees[0];
}

/** Le requis d'un praticien : sa lettre et ses visites, sinon le palier de potentiel. */
export function requisDuPraticien(
  entrees: readonly EntreeLettre[] | undefined,
  buId: string | null | undefined,
  potentiel: string | null | undefined,
  frequenceParPalier: Readonly<Record<string, number>>,
): RequisPraticien {
  const e = choisirEntree(entrees, buId);
  if (e) return { lettre: e.lettre, visites: e.visites, source: "SEGMENTATION", buId: e.buId, statut: e.statut };
  return { lettre: null, visites: potentiel ? frequenceParPalier[potentiel] ?? 0 : 0, source: "POTENTIEL", buId: null, statut: null };
}

/** Le requis d'un panel : Σ des visites de ses praticiens (un seul nombre, celui que le pilotage affiche). */
export function requisDuPanel(
  praticiens: readonly { id: string; potential: string | null }[],
  lettres: ReadonlyMap<string, readonly EntreeLettre[]>,
  buId: string | null | undefined,
  frequenceParPalier: Readonly<Record<string, number>>,
): number {
  let total = 0;
  for (const p of praticiens) total += requisDuPraticien(lettres.get(p.id), buId, p.potential, frequenceParPalier).visites;
  return total;
}

/** L'ordre d'affichage des lettres dans un panel (NA et non ciblé à part). */
export const LETTRES_PANEL = ["H", "A", "B", "C", "D"] as const;
export type LettrePanel = (typeof LETTRES_PANEL)[number];

/** Le compte d'un panel par lettre (H, A, B, C, D) — NA, non ciblé et hors stratégie ne s'y comptent pas. */
export function panelParLettre(lettres: readonly (Lettre | null)[]): Record<LettrePanel, number> {
  const out: Record<LettrePanel, number> = { H: 0, A: 0, B: 0, C: 0, D: 0 };
  for (const l of lettres) if (l && (LETTRES_PANEL as readonly string[]).includes(l)) out[l as LettrePanel]++;
  return out;
}
