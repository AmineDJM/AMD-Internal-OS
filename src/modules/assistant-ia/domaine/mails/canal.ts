/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CANAL « BOÎTE GMAIL D'ADAM » — RÉSERVÉ AU SUPER ADMIN (P1 bis, décision 0047 ; Direction, 02/11 : « à part le super
 * admin, les autres users n'ont pas le droit et ne savent pas qu'ils peuvent envoyer à travers Adam des mails »).
 *
 * Règle d'ARCHITECTURE, pas de consigne : pour toute autre personne, l'opération `envoyer_gmail` n'est pas ouverte (donc
 * absente de la sélection d'outils), `mes_boites_mail` / `envoyer_mail` ne décrivent ni ne rendent la boîte d'Adam, et
 * aucune consigne, carte, erreur ou réponse ne la nomme. Le rôle PRINCIPAL compte seul — un rôle secondaire ne l'ouvre pas.
 * Règles PURES, zéro import.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const canalAdamOuvert = (u: { role?: string | null }): boolean => u.role === "SUPER_ADMIN";

/** La consigne de la boîte d'Adam — ajoutée au tour du Super Admin SEULEMENT. */
export const CONSIGNE_BOITE_ADAM =
  "- Ta boîte d'envoi, c'est le Gmail d'ADAM (`envoyer_mail` l'emploie par défaut) ; `mes_boites_mail` lit son état réel. Non reliée : la carte part par l'envoi de l'ERP et tu dis en une phrase où la relier.";

/** Ce que les mots du canal d'Adam ne doivent JAMAIS laisser passer vers un non-Super-Admin (banc ML-ADAM-). */
export const MOTS_DU_CANAL_ADAM = /\b(gmail\s+d['’]\s*adam|bo[iî]te\s+(?:gmail\s+)?d['’]\s*adam|mail\s+d['’]\s*adam|gmail_adam|envoyer_gmail)\b/i;
