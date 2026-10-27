/**
 * OÙ MÈNE UNE NOTIFICATION Ad & Pro — la fiche de la demande (sponsoring, congrès, événement, « autre ») et,
 * quand la notification parle d'UN poste, ce poste sur la fiche (ancre `#poste-<id>`).
 *
 * La même table vivait recopiée dans le moteur de circuit, les missions, les postes, la prise en
 * charge et le transfert : cinq copies d'une adresse, c'est la garantie qu'une finira par mener à
 * l'ancien écran (§118.5).
 *
 * Module PUR — aucune importation (les types d'entité sont repris en chaînes).
 */

export type ParentAdPro = "SPONSORING" | "CONGRESS_NATIONAL" | "CONGRESS_INTERNATIONAL" | "EVENT" | "AD_PRO_OTHER";

export const CHEMIN_PARENT_AD_PRO: Record<ParentAdPro, string> = {
  SPONSORING: "/sponsoring",
  CONGRESS_NATIONAL: "/congress-national",
  CONGRESS_INTERNATIONAL: "/congress-international",
  EVENT: "/events",
  // La demande « autre » suit le même circuit depuis le 27/10/2026 (décision #17) : sa fiche est ici.
  AD_PRO_OTHER: "/ad-pro/autres",
};

/** La fiche d'une demande Ad & Pro. */
export function lienDemandeAdPro(type: ParentAdPro, id: string): string {
  return `${CHEMIN_PARENT_AD_PRO[type]}/${id}`;
}

/** L'ancre d'un poste sur la fiche de sa demande (posée par `AdProItemsPanel`). */
export function ancrePoste(itemId: string): string {
  return `poste-${itemId}`;
}

/** UN poste, sur la fiche de sa demande. */
export function lienPosteAdPro(type: ParentAdPro, parentId: string, itemId: string): string {
  return `${lienDemandeAdPro(type, parentId)}#${ancrePoste(itemId)}`;
}

/** Le centre de validation Ad & Pro (les sièges du centre y tranchent les BC et les dépassements). */
export const CHEMIN_CENTRE_AD_PRO = "/centre-ad-pro";

/**
 * Le centre ouvert SUR UNE LIGNE (`?ligne=<id de l'objet>`) : la demande, le contrat, le matériel, le
 * poste (bon de commande) ou la pièce Legal dont parle la notification. L'écran pose `ancreLigneCentre`
 * sur la ligne et la fait venir sous les yeux ; sans identifiant, le centre s'ouvre en tête de file.
 */
export function ancreLigneCentre(entityId: string): string {
  return `ligne-centre-${entityId}`;
}

export function lienLigneCentreAdPro(entityId?: string | null): string {
  return entityId ? `${CHEMIN_CENTRE_AD_PRO}?ligne=${encodeURIComponent(entityId)}` : CHEMIN_CENTRE_AD_PRO;
}
