/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CANAL « BOÎTE GMAIL D'ADAM » — RÉSERVÉ AU SUPER ADMIN (P1 bis, décision 0047 ; Direction, 02/11 : « à part le super
 * admin, les autres users n'ont pas le droit et ne savent pas qu'ils peuvent envoyer à travers Adam des mails »).
 *
 * Règle d'ARCHITECTURE, pas de consigne : pour toute autre personne, l'opération `envoyer_gmail` n'est pas ouverte (donc
 * absente de la sélection d'outils), `mes_boites_mail` / `envoyer_mail` ne décrivent ni ne rendent la boîte d'Adam, et
 * aucune consigne, carte, erreur ou réponse ne la nomme. Le rôle PRINCIPAL compte seul — un rôle secondaire ne l'ouvre pas.
 * Règles PURES ; leur seule importation : la table des accès (`profil-acces.ts`, pure elle aussi).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
import { canalOuvert, type CompteProfil } from "../profil-acces";

/**
 * Le canal d'Adam est-il ouvert à ce compte ? Lu dans la table des accès (lot I2) : le Super Admin en personne — rôle
 * principal, hors Vue exacte (avant I2, le rôle seul : une Vue exacte l'aurait ouvert si le tour n'était pas déjà fermé).
 */
export const canalAdamOuvert = (u: CompteProfil): boolean => canalOuvert(u, "gmailAdam");

/**
 * OÙ SE RELIE LE GMAIL D'ADAM — l'écran réel (`/adam/reglages`, bouton « Connecter le compte Google »). L'ancien renvoi,
 * « Chief of Staff › Réglages », menait à une entrée MASQUÉE depuis la décision 0056 : le modèle répétait une adresse morte
 * (rejeu réel AU3, 03/11).
 */
export const OU_RELIER_GMAIL_ADAM = "[Adam › Réglages](/adam/reglages) › « Connecter le compte Google »";

/** La consigne de la boîte d'Adam — ajoutée au tour du Super Admin SEULEMENT. */
export const CONSIGNE_BOITE_ADAM =
  "- Ta boîte d'envoi, c'est le Gmail d'ADAM (`envoyer_mail` l'emploie par défaut) ; `mes_boites_mail` lit son état réel. Non reliée : la carte part par l'envoi de l'ERP et tu dis en une phrase où la relier.";

/** Ce que les mots du canal d'Adam ne doivent JAMAIS laisser passer vers un non-Super-Admin (banc ML-ADAM-). */
export const MOTS_DU_CANAL_ADAM = /\b(gmail\s+d['’]\s*adam|bo[iî]te\s+(?:gmail\s+)?d['’]\s*adam|mail\s+d['’]\s*adam|gmail_adam|envoyer_gmail)\b/i;

/**
 * LA GARDE DE SORTIE (serveur) : pour qui n'est pas Super Admin, une réponse qui NOMME le canal d'Adam — le modèle répète
 * la demande (« depuis la boîte d'Adam ») ou l'instruction piégée d'un mail reçu — le voit remplacé par une tournure
 * neutre. Aucune consigne ne suffit à garantir « jamais nommé » : ceci le garantit.
 */
const CANAL_ADAM_ET_ARTICLE = /(?:\b(?:la|le|du|de la|sa|ta|votre|ton)\s+)?(?:bo[iî]te\s+(?:gmail\s+)?d['’]\s*adam|gmail\s+d['’]\s*adam|compte\s+gmail\s+d['’]\s*adam|mail\s+d['’]\s*adam|`?gmail_adam`?|`?envoyer_gmail`?)/gi;
export function taireCanalAdam(texte: string): string {
  return texte.replace(CANAL_ADAM_ET_ARTICLE, "une boîte qui ne vous est pas ouverte");
}
