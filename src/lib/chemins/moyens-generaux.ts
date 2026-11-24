/**
 * OÙ MÈNE UNE NOTIFICATION DES MOYENS GÉNÉRAUX — la remise, la rallonge ou la caisse elle-même.
 *
 * L'écran n'a pas de page par objet : la caisse d'avance, ses remises et ses rallonges vivent sur
 * `/moyens-generaux`. L'adresse porte `?cible=<ancre>` ; l'écran pose l'ancre sur l'élément visé et le
 * fait venir sous les yeux. Si l'élément n'est plus dans la liste (remise soldée, rallonge tranchée et
 * repliée), la caisse d'avance elle-même est entourée à la place.
 *
 * Module PUR — aucune importation.
 */

export const CHEMIN_MOYENS_GENERAUX = "/moyens-generaux";

/** L'ancre de la carte « Caisse d'avance » — le repli quand l'objet visé n'est plus affiché. */
export const ANCRE_CAISSE_AVANCE = "caisse-avance";

/** L'ancre du réglage « service des moyens généraux » dans Administration › Réglages (`/admin/settings`). */
export const ANCRE_SERVICE_MOYENS_GENERAUX = "service-moyens-generaux";

export const ancreRemise = (id: string): string => `remise-${id}`;
export const ancreRallonge = (id: string): string => `rallonge-${id}`;

function lien(ancre: string): string {
  return `${CHEMIN_MOYENS_GENERAUX}?cible=${encodeURIComponent(ancre)}`;
}

/** La caisse d'avance (alerte de fond bas, réglage mensuel, rechargement à venir…). */
export const lienCaisseAvance = (): string => lien(ANCRE_CAISSE_AVANCE);
/** UNE remise de caisse (annoncée, versée, refusée). */
export const lienRemiseCaisse = (id?: string | null): string => (id ? lien(ancreRemise(id)) : lienCaisseAvance());
/** UNE demande de rallonge (à trancher, retirée, accordée, refusée). */
export const lienRallongeCaisse = (id?: string | null): string => (id ? lien(ancreRallonge(id)) : lienCaisseAvance());
