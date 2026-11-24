import type { QualiteSignature } from "./partage";

/**
 * DEUX SIGNATURES, DEUX PERSONNES (Super Admin, 24/11/2026) — un BC porte la signature de la Direction Marketing et celle
 * des Finances : la même personne ne signe pas les deux. Une personne qui cumule les deux fonctions (Direction Marketing
 * avec, en « autre rôle », le droit de signer les BC) en signe une, et laisse l'autre à quelqu'un d'autre — sinon les deux
 * contrôles n'en font qu'un. SEUL le Super Admin (rôle principal ou « autre rôle ») peut tenir les deux places : c'est la
 * suppléance voulue (`enSuppleance`), et le sceau le dit sous son nom.
 *
 * La règle porte sur l'identité telle que la session la résout ; « Agir comme » n'est pas traité ici.
 *
 * PUR (sans import serveur) : testé sans base, et lisible par l'écran.
 */

/** Une signature déjà posée sur le BC : sa place, et qui l'a donnée (`null` : une signature sans compte connu). */
export interface SignaturePosee {
  qualite: string;
  userId: string | null;
}

/** Qui s'apprête à signer — son compte et ses deux rôles. */
export interface SignataireBC {
  id: string;
  role: string;
  secondaryRole?: string | null;
}

const AUTRE: Record<QualiteSignature, QualiteSignature> = { DIRECTION_MARKETING: "FINANCES", FINANCES: "DIRECTION_MARKETING" };
const POUR: Record<QualiteSignature, string> = { DIRECTION_MARKETING: "pour la Direction Marketing", FINANCES: "pour les Finances" };
const LA_SIGNATURE: Record<QualiteSignature, string> = { DIRECTION_MARKETING: "la signature de la Direction Marketing", FINANCES: "la signature des Finances" };

const estSuperAdminSignataire = (s: Pick<SignataireBC, "role" | "secondaryRole">): boolean =>
  s.role === "SUPER_ADMIN" || s.secondaryRole === "SUPER_ADMIN";

/** La phrase du refus — la même à l'écran et dans l'action. */
export function refusDejaSigneAutreQualite(qualite: QualiteSignature): string {
  const autre = AUTRE[qualite];
  return `Vous avez déjà signé ce bon de commande ${POUR[autre]} : ${LA_SIGNATURE[qualite]} revient à une autre personne.`;
}

/**
 * Le refus, ou `null` : ce signataire a-t-il déjà signé l'AUTRE place de ce BC ? Une signature de la même place n'est pas
 * l'affaire de cette règle (l'unicité de la place la tient).
 */
export function refusSignataireDouble(posees: readonly SignaturePosee[], qualite: QualiteSignature, signataire: SignataireBC): string | null {
  if (estSuperAdminSignataire(signataire)) return null;
  const autre = AUTRE[qualite];
  const dejaSigne = posees.some((p) => p.qualite === autre && p.userId !== null && p.userId === signataire.id);
  return dejaSigne ? refusDejaSigneAutreQualite(qualite) : null;
}
