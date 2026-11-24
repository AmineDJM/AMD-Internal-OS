/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE COMPTE APPLICATIF NAÎT AVEC LA FICHE (Super Admin, 24/11/2026 — lot rhdepart).
 *
 * « Quand on crée le salarié, on lui crée automatiquement son compte. » Le compte se crée PAR INVITATION
 * (`lib/user-invites.ts`) : aucun mot de passe ne transite, le compte est inconnectable tant que la personne n'a pas
 * ouvert son lien. Ce module dit ce qu'il faut faire d'une fiche — rien, relier un compte qui existe déjà sous la même
 * adresse, en créer un, ou dire pourquoi on ne peut pas — et quel rôle le compte reçoit.
 *
 * PUR, SANS AUCUN IMPORT.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type DecisionCompte =
  | { geste: "DEJA_LIE" }
  | { geste: "INACTIVE"; phrase: string }
  | { geste: "SANS_EMAIL"; phrase: string }
  | { geste: "EMAIL_PRIS"; phrase: string }
  | { geste: "RELIER"; userId: string }
  | { geste: "CREER"; email: string };

/** Une adresse plausible, ramenée à sa forme de connexion (minuscules, sans espaces). `null` sinon. */
export function emailDeConnexion(email: string | null | undefined): string | null {
  const e = (email ?? "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
}

/**
 * CE QU'ON FAIT DU COMPTE D'UNE FICHE. Idempotent par construction : une fiche déjà reliée ne reçoit rien ; un compte
 * existant sous la même adresse, libre de toute fiche, est RELIÉ (pas doublé) ; une adresse tenue par la fiche d'un
 * autre salarié est refusée — deux personnes ne partagent pas une connexion.
 */
export function decisionCompteSalarie(
  fiche: { userId: string | null; email: string | null; isActive: boolean; fullName: string },
  compteMemeAdresse: { id: string; ficheId: string | null } | null,
): DecisionCompte {
  if (fiche.userId) return { geste: "DEJA_LIE" };
  if (!fiche.isActive) return { geste: "INACTIVE", phrase: `La fiche de ${fiche.fullName} est inactive : aucun compte ne lui est créé.` };
  const email = emailDeConnexion(fiche.email);
  if (!email) return { geste: "SANS_EMAIL", phrase: `Ajoutez l'e-mail de ${fiche.fullName} sur sa fiche : son compte applicatif se créera aussitôt.` };
  if (compteMemeAdresse) {
    if (compteMemeAdresse.ficheId) return { geste: "EMAIL_PRIS", phrase: `L'adresse ${email} est déjà le compte d'un autre salarié : corrigez l'e-mail de la fiche.` };
    return { geste: "RELIER", userId: compteMemeAdresse.id };
  }
  return { geste: "CREER", email };
}

/**
 * LE RÔLE DU COMPTE CRÉÉ. La fiche ne porte pas de rôle : le compte naît « Lecteur » (il voit son espace, son dossier
 * RH, ses demandes) — un rôle plus large est une décision de DROITS, prise par qui administre les comptes. Le rôle
 * choisi au formulaire n'est retenu que si l'auteur peut administrer les comptes (et jamais Super Admin par ce chemin).
 */
export function roleDuCompteSalarie(saisi: string | null | undefined, peutAdministrer: boolean, rolesConnus: readonly string[]): string {
  const r = (saisi ?? "").trim();
  if (!r || !peutAdministrer || r === "SUPER_ADMIN" || !rolesConnus.includes(r)) return "VIEWER";
  return r;
}
