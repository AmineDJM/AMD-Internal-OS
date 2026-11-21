/**
 * LE DÉLÉGUÉ MÉDICAL SUIT SES POSTES SANS LES DÉTAILS (Direction, 15/11/2026) — ni montants, ni devis, ni agence, ni
 * pièces ; il voit où en est chaque poste. Sauf s'il porte aussi un rôle qui décide ou exécute (secondaire).
 *
 * UNE SEULE RÈGLE pour l'écran (`contextePostes`) ET pour ce qui lui est ÉCRIT (recette, 21/11/2026) : ses cartes lui
 * cachaient les montants, mais ses notifications lui disaient « Agence retenue : El Bahia Congrès » et « Total de
 * 2 064 770 DZD validé par le Directeur Général ».
 *
 * Module PUR : il se lit côté serveur et dans les tests.
 */
const ROLES_QUI_VOIENT_LES_DETAILS = ["PRODUCT_MANAGER", "SUPER_ADMIN", "NATIONAL_SALES", "DIRECTION_ASSISTANT"] as const;

export function suitSansDetails(u: { role: string; secondaryRole?: string | null } | null | undefined): boolean {
  if (!u) return false;
  return u.role === "MEDICAL_DELEGATE" && !(ROLES_QUI_VOIENT_LES_DETAILS as readonly string[]).includes(String(u.secondaryRole ?? ""));
}
