/**
 * CONFIRMATION RENFORCÉE (actions CRITIQUES) — la comparaison CANONIQUE de la valeur ressaisie.
 *
 * Module PUR (aucun import) : il est chargé par la carte de confirmation côté navigateur ET par
 * l'action serveur qui exécute — la MÊME règle des deux côtés, sinon un bouton « armé » à l'écran
 * peut être refusé au serveur (ou l'inverse, ce qui serait un trou).
 *
 * La normalisation est pensée pour la DICTÉE VOCALE : « R E G tiret 2026 041 » doit valoir
 * « REG-2026-041 », « 1 500 000 » doit valoir « 1500000 », « É » vaut « e ». On ne compare donc
 * que les caractères porteurs (lettres sans accent + chiffres) — la ponctuation, les espaces
 * (y compris insécables) et la casse ne peuvent pas faire échouer une confirmation légitime.
 * Ce qui est vérifié reste le CONTENU exact : un montant ou une référence différents ne passent pas.
 */

export function normalizeConfirmText(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // accents décomposés → retirés (É → E)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, ""); // seuls comptent lettres + chiffres (espaces U+202F, tirets, virgules… ignorés)
}

/**
 * true si la valeur RESSAISIE correspond à la valeur EXIGÉE. Une exigence vide ne « matche »
 * jamais : une carte CRITIQUE sans confirmText est une erreur de proposition, pas un laissez-passer.
 */
export function matchesConfirmText(typed: string, expected: string): boolean {
  const want = normalizeConfirmText(expected);
  if (!want) return false;
  return normalizeConfirmText(typed) === want;
}
