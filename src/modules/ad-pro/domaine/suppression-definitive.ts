/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * SUPPRIMER DÉFINITIVEMENT UNE DEMANDE AD & PRO — les règles (Super Admin, 24/11/2026).
 *
 * « Permets au super administrateur de supprimer toutes les demandes de manière définitive, même si
 * les ordres de dépense ont déjà été réglés ou engagés ou payés. Tout est retiré. Mais uniquement ce
 * qui est lié à la demande. »
 *
 * À ne pas confondre avec « Supprimer la demande » (`suppression.ts`) : celle-là range à la corbeille,
 * se délègue, et refuse ce qui a quitté l'ERP. Celle-ci DÉTRUIT, ne se délègue pas, et passe outre —
 * c'est l'unique exception documentée aux invariants d'argent (`lib/suppression/definitive.ts`).
 *
 * Module PUR : des faits en entrée, un oui ou un non en sortie.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Les 5 natures Ad & Pro et le matériel promotionnel — le libellé que l'aperçu et la trace emploient. */
export const NATURES_SUPPRESSION_DEFINITIVE = {
  SPONSORING: "Sponsoring",
  CONGRESS_NATIONAL: "Prise en charge nationale",
  CONGRESS_INTERNATIONAL: "Prise en charge internationale",
  EVENT: "Événement",
  AD_PRO_OTHER: "Autre demande",
  PROMO_MATERIAL: "Matériel promotionnel",
} as const;

export type NatureSuppressionDefinitive = keyof typeof NATURES_SUPPRESSION_DEFINITIVE;

export function estNatureSuppressionDefinitive(kind: string): kind is NatureSuppressionDefinitive {
  return Object.prototype.hasOwnProperty.call(NATURES_SUPPRESSION_DEFINITIVE, kind);
}

export const REFUS_SUPPRESSION_DEFINITIVE =
  "La suppression définitive d'une demande Ad & Pro est réservée au Super Admin. Pour retirer une demande à la corbeille, utilisez « Supprimer la demande ».";
export const REFUS_SOUS_VUE_EXACTE =
  "La suppression définitive ne se fait pas sous « Vue exacte » / « Agir comme » : quittez la vue, puis recommencez en votre nom.";
export const REFUS_REFERENCE =
  "La référence retapée ne correspond pas : recopiez exactement la référence de la demande pour confirmer — rien n'a été supprimé.";

/**
 * QUI PEUT DÉTRUIRE — le Super Admin RÉEL, et lui seul. Ni le rôle secondaire, ni une clé de console, ni le DG.
 * Sous « Agir comme », la personne de la requête est celle qu'on incarne (`impersonatedBy`) : le geste est refusé
 * même si elle est Super Admin — une destruction se fait en son propre nom.
 */
export function refusSuppressionDefinitive(u: { role: string; impersonatedBy?: unknown }): string | null {
  if (u.impersonatedBy) return REFUS_SOUS_VUE_EXACTE;
  if (u.role !== "SUPER_ADMIN") return REFUS_SUPPRESSION_DEFINITIVE;
  return null;
}

/** La RÉFÉRENCE affichée d'une demande — la sienne, ou, pour une nature qui n'en porte pas, celle de la liste Ad & Pro. */
export function referenceDeLaDemande(d: { id: string; reference?: string | null }): string {
  const r = d.reference?.trim();
  return r ? r : d.id.slice(-6).toUpperCase();
}

/** La référence RETAPÉE confirme-t-elle ? Espaces autour et casse ignorés — un caractère de travers, non. */
export function referenceConfirmee(saisie: string | null | undefined, attendue: string): boolean {
  const s = (saisie ?? "").trim().toUpperCase();
  return s.length > 0 && s === attendue.trim().toUpperCase();
}
