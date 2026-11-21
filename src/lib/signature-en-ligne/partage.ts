/**
 * CE QUE L'ÉCRAN SAIT DE LA SIGNATURE EN LIGNE (Direction, 15/11/2026) — PUR, sûr pour le navigateur.
 */

/** La place qu'une signature prend sur un BC : la Direction Marketing d'abord, puis les Finances. */
export type QualiteSignature = "DIRECTION_MARKETING" | "FINANCES";

/**
 * Ce qui est prêt chez la personne qui regarde : l'image de sa signature, celle de son cachet, son code de signature — et,
 * pour un Super Admin, les places qu'il ne tiendrait qu'en SUPPLÉANCE (`enSuppleance`, serveur).
 */
export interface SignaturePrete {
  signature: boolean;
  cachet: boolean;
  code: boolean;
  suppleance?: Partial<Record<QualiteSignature, boolean>>;
}

export const SIGNATURE_RIEN_DE_PRET: SignaturePrete = { signature: false, cachet: false, code: false };

export const signaturePrete = (p: SignaturePrete): boolean => p.signature && p.cachet && p.code;

/** La page où chaque signataire prépare sa signature, son cachet et son code. */
export const CHEMIN_MA_SIGNATURE = "/mon-espace/signature";

export const LIBELLE_QUALITE_SIGNATURE: Record<QualiteSignature, string> = { DIRECTION_MARKETING: "Direction Marketing", FINANCES: "Finances" };
const DE_LA_QUALITE: Record<QualiteSignature, string> = { DIRECTION_MARKETING: "de la Direction Marketing", FINANCES: "des Finances" };

/**
 * LA SUPPLÉANCE DU SUPER ADMIN (Direction, 21/11/2026) — « que l'administrateur puisse faire l'étape de la signature ».
 *
 * Le Super Admin tient déjà les deux places (il tranche toute étape, il a le droit de signer les BC). Mais une signature en
 * ligne est celle d'une PERSONNE : il signe depuis SON compte, avec SON mot de passe, SON code, SA signature et SON cachet —
 * jamais ceux de la Direction Marketing ou des Finances (« Agir comme » reste refusé). Le BC le dit donc : son nom, puis
 * « Super Admin, en suppléance de la Direction Marketing » — sur le sceau du PDF, sur la page de vérification, au journal.
 * Écrire « Direction Marketing » sous son nom ferait croire qu'elle a signé.
 */
export function titreSignataire(qualite: QualiteSignature, suppleance: boolean): string {
  return suppleance ? `Super Admin, en suppléance ${DE_LA_QUALITE[qualite]}` : LIBELLE_QUALITE_SIGNATURE[qualite];
}

/** Ce que le formulaire dit au Super Admin AVANT qu'il signe à une place qui n'est pas la sienne. */
export function avertissementSuppleance(qualite: QualiteSignature): string {
  return `Vous signez en suppléance ${DE_LA_QUALITE[qualite]} : le PDF portera VOTRE nom, votre signature et votre cachet, `
    + `avec la mention « ${titreSignataire(qualite, true)} » — sur le sceau, la page de vérification et le journal.`;
}
