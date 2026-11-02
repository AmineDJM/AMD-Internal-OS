import { ROLES_DIRECTEUR_DES_OPERATIONS } from "@/lib/promo-material/validateurs";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * QUI SUPPRIME UNE DEMANDE AD & PRO (§118.175).
 *
 * « Donner la main au Directeur des opérations pour la suppression des demandes Ad&Pro, pareil
 * pour la directrice marketing » (Direction, 01/10). Jusqu'ici, le Super Admin seul.
 *
 * Deux lectures, et ce sont celles que le dépôt fait déjà ailleurs (§118.5) :
 *   • « le directeur des opérations », ce sont les DEUX libellés de la même fonction — la
 *     Direction des opérations (`DIRECTION`) et le Directeur des Opérations
 *     (`OPERATIONS_DIRECTOR`), rôle principal ou casquette secondaire, comme le stock
 *     promotionnel et le circuit du matériel les lisent ;
 *   • « la directrice marketing », c'est la CHEFFE de la Direction Marketing lue sur
 *     l'organigramme (porteuse du rôle, personne du rôle au-dessus d'elle) — pas toute porteuse du
 *     rôle : un référent de gamme porte aussi « Direction Marketing », et la demande parle d'UNE
 *     personne. Ouvrir la suppression au rôle entier élargirait l'empreinte au-delà de la demande
 *     (§118.16).
 *
 * Ce qui ne change pas : la suppression reste RÉVERSIBLE (corbeille, lot entier, §118.162) et
 * refusée quand une branche porte un fait qui a quitté l'ERP. Supprimer reste un rangement que le
 * Super Admin peut défaire — jamais une destruction.
 *
 * Module PUR : des faits en entrée, un oui ou un non en sortie.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Les demandes du pôle Ad & Pro, par leur nature dans le registre de suppression. */
export const DEMANDES_AD_PRO_SUPPRIMABLES = [
  "SPONSORING", "CONGRESS_INTERNATIONAL", "CONGRESS_NATIONAL", "EVENT", "PROMO_MATERIAL", "CONSULTING_CONTRACT", "AD_PRO_OTHER",
] as const;

export type DemandeAdProSupprimable = (typeof DEMANDES_AD_PRO_SUPPRIMABLES)[number];

export function estDemandeAdProSupprimable(kind: string): kind is DemandeAdProSupprimable {
  return (DEMANDES_AD_PRO_SUPPRIMABLES as readonly string[]).includes(kind);
}

export interface FaitsSuppressionAdPro {
  role: string;
  secondaryRole?: string | null;
  /** Cheffe de la Direction Marketing, lue sur l'organigramme par l'appelant. */
  estCheffeMarketing: boolean;
}

/** Peut-on supprimer une demande Ad & Pro ? La LIGNE, elle, doit encore être visible — l'appelant le vérifie. */
export function peutSupprimerDemandeAdPro(f: FaitsSuppressionAdPro): boolean {
  if (f.role === "SUPER_ADMIN") return true;
  const roles = [f.role, f.secondaryRole ?? null];
  if (roles.some((r) => r != null && (ROLES_DIRECTEUR_DES_OPERATIONS as readonly string[]).includes(r))) return true;
  return f.estCheffeMarketing;
}

export const REFUS_SUPPRESSION_AD_PRO =
  "Supprimer une demande Ad & Pro est réservé au Super Admin, au directeur des opérations et à la directrice marketing.";
