/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * SUPPRIMER UNE ENVELOPPE BUDGÉTAIRE — la règle (Super Admin, 25/11/2026).
 *
 * Le geste est à la DIRECTION GÉNÉRALE : le Super Admin ou le Directeur général (rôle principal ou « autre rôle »).
 * Un directeur de pôle, les Finances, un délégué de l'enveloppe : non — une enveloppe porte des engagements que d'autres
 * ont pris. La suppression est RÉVERSIBLE (corbeille du Super Admin) ; les dépenses imputées ne partent pas, elles
 * redeviennent « à imputer » et se rattachent de nouveau à la restauration. On confirme en RETAPANT le nom.
 *
 * Module PUR : lu par l'action (la règle serveur) et par l'écran (le menu ne propose que ce que l'action accepte).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface PorteurDeRole { role: string; secondaryRole?: string | null }

const ROLES_DIRECTION_GENERALE = ["SUPER_ADMIN", "GENERAL_MANAGER"] as const;

/** Super Admin ou Directeur général — par le rôle principal ou l'« autre rôle ». */
export function peutSupprimerEnveloppe(u: PorteurDeRole): boolean {
  return ROLES_DIRECTION_GENERALE.some((r) => u.role === r || u.secondaryRole === r);
}

export const REFUS_SUPPRESSION_ENVELOPPE = "Supprimer une enveloppe est réservé à la Direction générale (Super Admin ou Directeur général). Demandez-lui de le faire, ou désactivez l'enveloppe dans ses réglages.";

/** Le nom retapé correspond-il ? Espaces de bord et casse ignorés — pas les accents ni les chiffres. */
export function nomConfirme(saisi: string | null | undefined, nom: string): boolean {
  const plier = (s: string) => s.trim().replace(/\s+/g, " ").toLocaleLowerCase("fr");
  return !!saisi && plier(saisi) === plier(nom);
}

/** Le refus d'une enveloppe qui porte ce qu'on ne rend pas « à imputer » — ou `null`. */
export function refusDuContenu(p: { lignesBudgetaires: number; lotsIntegration: number }): string | null {
  if (p.lignesBudgetaires > 0) {
    return `Cette enveloppe porte ${p.lignesBudgetaires} dépense(s) saisie(s) dans ses catégories (lignes budgétaires : BV, frais, saisies manuelles) : elles n'existent que dans l'enveloppe et ne peuvent pas redevenir « à imputer ». Déplacez-les vers une autre catégorie (ou supprimez-les) d'abord.`;
  }
  if (p.lotsIntegration > 0) {
    return `Cette enveloppe porte ${p.lotsIntegration} lot(s) d'intégration Ad & Pro : elle ne se supprime pas. Désactivez-la plutôt.`;
  }
  return null;
}
