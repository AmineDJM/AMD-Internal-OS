/**
 * LE SIGNAL « CE GESTE S'ANNULE » (K10c) — pur, sans import : `use-action.ts` (la coque) le lance quand une action
 * réversible rend `annulable: { gesteId, libelle }` ; le bandeau (`bandeau-annulable.tsx`, chargé tard) l'écoute.
 */

export interface AnnulableVu { gesteId: string; libelle: string }

export const EVENEMENT_ANNULABLE = "amd:geste-annulable";

/** Le geste annulable d'un résultat d'action, s'il en porte un. */
export function annulableDe(r: unknown): AnnulableVu | null {
  const a = (r && typeof r === "object" ? (r as { annulable?: unknown }).annulable : null) as Partial<AnnulableVu> | null | undefined;
  return a && typeof a.gesteId === "string" && a.gesteId ? { gesteId: a.gesteId, libelle: typeof a.libelle === "string" ? a.libelle : "Geste" } : null;
}

export function signalerAnnulable(r: unknown): void {
  const a = annulableDe(r);
  if (a && typeof window !== "undefined") window.dispatchEvent(new CustomEvent<AnnulableVu>(EVENEMENT_ANNULABLE, { detail: a }));
}
