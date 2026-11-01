import type { CurrentUser } from "@/lib/session";
import { ANNULATIONS_DECLAREES } from "./declarations";
import type { DetailEffet, EffetLu } from "./annulation";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA POLITIQUE D'ANNULATION D'UNE ACTION MÉTIER (K10c, décision 0044).
 *
 * L'annulation J7 (`annulation.ts`) rend une issue PAR EFFET — juste pour un geste d'assistant qu'on relit effet par
 * effet. Une action métier rendue réversible demande plus :
 *
 *   • TOUT OU RIEN — annuler une décision dont un ordre de paiement est né, alors que l'ordre a été payé depuis, ne
 *     doit pas rouvrir l'étape en laissant l'ordre payé : rien n'est écrit, la liste des effets bloquants est rendue.
 *   • RECTIFIER — une notification déjà lue ne se reprend pas : un rectificatif part au même destinataire.
 *   • UN GESTE INVERSE MÉTIER quand l'effacement ligne à ligne serait faux : un poste supprimé est revenu de la
 *     CORBEILLE (avec ses branches), pas recréé ligne à ligne.
 *
 * S'applique aux actions déclarées (`ANNULATIONS_DECLAREES`) et aux annulations elles-mêmes (« rétablir »).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface ResultatMetier { details: DetailEffet[]; traites: Set<string> }

export interface PolitiqueAnnulation {
  toutOuRien: boolean;
  rectifierLues: boolean;
  metier?: (a: { geste: { id: string; libelle: string; effets: EffetLu[] }; appliquer: boolean; user: CurrentUser }) => Promise<ResultatMetier>;
}

/** Les gestes inverses métier — importés tard : l'annulation ne tire pas l'ERP entier. */
const METIERS: Readonly<Record<string, () => Promise<NonNullable<PolitiqueAnnulation["metier"]>>>> = {
  "ad-pro-item-actions:deleteAdProItem": async () => (await import("@/lib/suppression/coeur")).restaurerDepuisLaCorbeille,
  "reservation-fiche-actions:envoyerFiche": async () => (await import("./annulation-bibliotheque")).indexBibliotheque,
  "reservation-fiche-actions:envoyerFichesPretes": async () => (await import("./annulation-bibliotheque")).indexBibliotheque,
  "reservation-fiche-actions:joindreDevisAgence": async () => (await import("./annulation-bibliotheque")).indexBibliotheque,
  "reservation-fiche-actions:deposerBillet": async () => (await import("./annulation-bibliotheque")).indexBibliotheque,
};

export async function politiqueDe(capaciteId: string | null | undefined): Promise<PolitiqueAnnulation | null> {
  if (!capaciteId) return null;
  if (capaciteId.startsWith("annulation:")) return { toutOuRien: true, rectifierLues: true };
  if (!ANNULATIONS_DECLAREES[capaciteId]) return null;
  const metier = METIERS[capaciteId] ? await METIERS[capaciteId]() : undefined;
  return { toutOuRien: true, rectifierLues: true, metier };
}
