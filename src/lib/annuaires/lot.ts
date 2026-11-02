/**
 * L'ANNUAIRE TENU EN LOT (lot T2, décision 0052) — la forme PURE d'un lot, partagée par l'action de l'ERP
 * (`lib/actions/fournisseurs-annuaire-actions.ts`, « use server » : il n'exporte que ses actions) et par l'Assistant IA qui le
 * prépare. Aucun import.
 */

/** Les champs qu'un lot peut écrire, par fiche — le nom du champ du formulaire de l'écran. */
export const CHAMPS_LOT = {
  medecin: { telephone: "phone", email: "email", specialite: "specialty", etablissement: "institution", wilaya: "wilaya", region: "region", nom: "name", commentaires: "comments" },
  etablissement: { telephone: "phone", email: "email", adresse: "address", wilaya: "wilaya", region: "region", nom: "name", notes: "notes", type: "type" },
  fournisseur: { telephone: "phone", email: "contactEmail", contact: "contactName", site: "website", adresse: "address", ville: "city", pays: "country", nom: "name", notes: "notes" },
} as const;
export type CibleLot = keyof typeof CHAMPS_LOT;
export interface LigneLot { cible: CibleLot; id: string; champs: Record<string, string | null> }
export interface CompteRenduLot { faites: number; refusees: { id: string; raison: string }[] }

export interface GroupeFusion { garder: string; absorber: string[] }
