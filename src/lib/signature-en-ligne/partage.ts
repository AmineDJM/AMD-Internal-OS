/**
 * CE QUE L'ÉCRAN SAIT DE LA SIGNATURE EN LIGNE (Direction, 15/11/2026) — PUR, sûr pour le navigateur.
 */

/** Ce qui est prêt chez la personne qui regarde : l'image de sa signature, celle de son cachet, son code de signature. */
export interface SignaturePrete { signature: boolean; cachet: boolean; code: boolean }

export const SIGNATURE_RIEN_DE_PRET: SignaturePrete = { signature: false, cachet: false, code: false };

export const signaturePrete = (p: SignaturePrete): boolean => p.signature && p.cachet && p.code;

/** La page où chaque signataire prépare sa signature, son cachet et son code. */
export const CHEMIN_MA_SIGNATURE = "/mon-espace/signature";
