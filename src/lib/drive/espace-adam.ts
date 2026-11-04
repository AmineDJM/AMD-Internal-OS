/**
 * L'ESPACE D'ADAM — la règle PURE (lot I3, décision 0065, audit AU2 §6.1 (e)).
 *
 * Chaque personne a UN espace du Drive où Adam range ce qu'il produit pour elle (« Brouillons », « Copies », rangement
 * libre) : une catégorie (`DriveSpace`) existante, sans migration, ouverte à elle seule (`accessUserIds` = gestion =
 * [elle]). Elle n'est pas dans « Mon Drive » (une catégorie n'y est jamais) ; elle apparaît comme un onglet pour elle,
 * et pour PERSONNE d'autre — pas même un Super Admin, qui voit sinon toutes les catégories en onglet.
 */

export const NOM_ESPACE_ADAM = "Espace d'Adam";
export const ICONE_ESPACE_ADAM = "Bot";
export const DOSSIERS_ESPACE_ADAM = ["Brouillons", "Copies"] as const;

interface EspaceLu { name: string; icon: string | null; accessUserIds?: readonly string[]; managerUserIds?: readonly string[]; accessRoles?: readonly string[]; managerRoles?: readonly string[] }

/** Est-ce l'espace d'Adam d'une personne ? (nom, icône, une seule personne, aucun rôle.) */
export function estEspaceAdam(s: EspaceLu): boolean {
  return s.name === NOM_ESPACE_ADAM && s.icon === ICONE_ESPACE_ADAM && (s.accessUserIds?.length ?? 0) === 1
    && (s.accessRoles?.length ?? 0) === 0 && (s.managerRoles?.length ?? 0) === 0;
}

/** L'espace d'Adam de QUELQU'UN D'AUTRE : jamais en onglet, jamais dans une liste de catégories. */
export function estEspaceAdamDAutrui(s: EspaceLu, userId: string): boolean {
  return estEspaceAdam(s) && s.accessUserIds?.[0] !== userId;
}
