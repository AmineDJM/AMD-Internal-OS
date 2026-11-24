import { ajouterVisiteImprevue, rapporterVisite } from "@/lib/actions/tour-visit-actions";
import type { ActionResult } from "@/lib/actions/types";
import type { SorteBrouillon } from "@/lib/sfe/brouillons-visite";

/**
 * L'ENVOI D'UN RAPPORT DE VISITE — le SEUL endroit de l'écran qui appelle les deux actions (11/2026).
 *
 * La règle tient en une ligne : une visite PLANIFIÉE se rapporte (`rapporterVisite`, la ligne existe et se met à
 * jour) ; tout autre médecin est une visite HORS PLAN (`ajouterVisiteImprevue`, elle se crée). La saisie directe et
 * la file hors ligne passent par ici : elles ne peuvent pas diverger. `logVisit` n'est plus appelé par l'écran — il
 * reste pour Adam et l'API.
 */
export function envoyerVisite(sorte: SorteBrouillon, fd: FormData): Promise<ActionResult> {
  return sorte === "RAPPORT" ? rapporterVisite(fd) : ajouterVisiteImprevue(fd);
}

/** Le délai au-delà duquel un envoi est tenu pour perdu dans le réseau (la requête a pu partir). */
export const DELAI_ENVOI_MS = 20_000;

/** L'envoi, borné : une requête qui ne revient jamais ne doit pas figer la feuille. Lève « délai » au-delà. */
export async function envoyerAvecDelai(sorte: SorteBrouillon, fd: FormData, delaiMs: number = DELAI_ENVOI_MS): Promise<ActionResult> {
  let minuterie: ReturnType<typeof setTimeout> | undefined;
  const delai = new Promise<never>((_, ko) => { minuterie = setTimeout(() => ko(new Error("délai dépassé")), delaiMs); });
  try {
    return await Promise.race([envoyerVisite(sorte, fd), delai]);
  } finally {
    if (minuterie) clearTimeout(minuterie);
  }
}
