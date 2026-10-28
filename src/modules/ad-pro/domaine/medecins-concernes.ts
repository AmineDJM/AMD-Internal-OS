/**
 * LES MÉDECINS CONCERNÉS PAR UNE DEMANDE AD & PRO (Direction, 08/10) — le lien générique demande ↔ annuaire.
 *
 * « Permets-moi de modifier les demandes Ad & Pro pour mettre les médecins concernés avec l'annuaire, afin que ce soit lié dans
 * le Marketing cockpit et ailleurs : produits – médecins – dépenses connectés. » Le texte libre `doctor` des demandes (sponsoring,
 * événement, autre) ne se rapproche d'aucune fiche ; ce lien, lui, désigne le praticien de l'annuaire.
 *
 * Module PUR (aucun import) : lu par l'écran client comme par le serveur.
 */

/** Les natures de demande qui portent des médecins concernés — les valeurs de `EntityType` de leurs fiches. */
export const TYPES_MEDECINS_CONCERNES = [
  "SPONSORING", "EVENT", "CONGRESS_NATIONAL", "CONGRESS_INTERNATIONAL", "PROMO_MATERIAL", "AD_PRO_OTHER",
] as const;
export type TypeMedecinsConcernes = (typeof TYPES_MEDECINS_CONCERNES)[number];

export function estTypeMedecinsConcernes(v: unknown): v is TypeMedecinsConcernes {
  return typeof v === "string" && (TYPES_MEDECINS_CONCERNES as readonly string[]).includes(v);
}

/** Le rôle du praticien dans la demande. */
export const ROLES_MEDECIN = ["BENEFICIAIRE", "ORATEUR", "INVITE", "AUTRE"] as const;
export type RoleMedecin = (typeof ROLES_MEDECIN)[number];

export const LIBELLE_ROLE_MEDECIN: Record<RoleMedecin, string> = {
  BENEFICIAIRE: "Bénéficiaire", ORATEUR: "Orateur", INVITE: "Invité", AUTRE: "Autre",
};

export function estRoleMedecin(v: unknown): v is RoleMedecin {
  return typeof v === "string" && (ROLES_MEDECIN as readonly string[]).includes(v);
}

/** L'adresse de la fiche de chaque nature de demande. */
export const CHEMIN_DEMANDE: Record<TypeMedecinsConcernes, string> = {
  SPONSORING: "/sponsoring",
  EVENT: "/events",
  CONGRESS_NATIONAL: "/congress-national",
  CONGRESS_INTERNATIONAL: "/congress-international",
  PROMO_MATERIAL: "/promo-material",
  AD_PRO_OTHER: "/ad-pro/autres",
};

/** Le nom de la nature, dans l'écran du praticien et le cockpit. */
export const LIBELLE_NATURE_DEMANDE: Record<TypeMedecinsConcernes, string> = {
  SPONSORING: "Sponsoring",
  EVENT: "Événement",
  CONGRESS_NATIONAL: "Congrès national",
  CONGRESS_INTERNATIONAL: "Congrès international",
  PROMO_MATERIAL: "Matériel promotionnel",
  AD_PRO_OTHER: "Autre demande Ad & Pro",
};

/** Une demande annulée ou refusée n'a rien engagé : elle ne compte ni en « Ad & Pro » ni en « Investi ». */
export function demandeAbandonnee(statut: string | null | undefined): boolean {
  return statut === "REFUSED" || statut === "CANCELLED";
}

/**
 * CE QU'ON ATTRIBUE À UN PRATICIEN : le montant saisi sur son lien ; à défaut, tout l'accordé d'un sponsoring qui ne nomme
 * QUE lui (sinon on ne sait pas le partager). `null` = rien d'attribuable.
 */
export function montantAttribuable(
  lien: { montant: number | null }, demande: { nature: TypeMedecinsConcernes; montantAccorde: number | null; nbMedecins: number },
): number | null {
  if (lien.montant !== null && lien.montant > 0) return lien.montant;
  if (demande.nature === "SPONSORING" && demande.nbMedecins === 1 && demande.montantAccorde !== null && demande.montantAccorde > 0) return demande.montantAccorde;
  return null;
}
