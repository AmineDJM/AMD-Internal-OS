/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE NUMÉRO DE RÉFÉRENCE D'UN BON DE COMMANDE — MODIFIABLE (Direction, 14/10/2026).
 *
 * « Chaque bon de commande a un numéro de référence, modifiable quand on le compose ; il peut être soit écrit
 * manuellement, soit modifié quand on modifie ou qu'on révise n'importe quel bon de commande. »
 *
 *   • À LA COMPOSITION : le champ est prérempli avec le prochain numéro automatique ; gardé, la série attribue le prochain
 *     libre ; écrit à la main, il est vérifié (forme, unicité) et le compteur monte jusqu'à lui s'il est plus haut.
 *   • À LA MODIFICATION / RÉVISION (tous les chemins : fiche Legal, demande au secrétariat, poste Ad & Pro, dossier de
 *     matériel promotionnel, aperçu d'un BC à régénérer) : le numéro se change DANS le même formulaire que le reste.
 *   • UNICITÉ : un numéro déjà porté par un autre document de la même série — le registre commun NNN/DG/AAAA de la société
 *     (tous documents confondus), ou les pièces de même nature de la société hors registre — est refusé, en le nommant.
 *   • LE COMPTEUR NE RECULE JAMAIS : il est porté AU MOINS au numéro saisi (`GREATEST`), jamais en dessous de ce qu'il était.
 *   • TRACÉ : ancien → nouveau, qui, quand (journal d'audit, `field = numero`), et l'historique des versions de la pièce.
 *
 * PUR, SANS IMPORT : le composeur (navigateur), la fabrique (serveur) et les tests lisent la même règle.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Au-delà, une saisie n'est plus un numéro. */
export const LONGUEUR_MAX_NUMERO = 40;

/** Les caractères qu'un numéro ne porte pas (ceux qu'un nom de fichier refuse). */
const INTERDITS = /[\\<>|"*?]/;

/** La saisie, nettoyée : espaces de bord retirés, espaces multiples réduits. */
export const nettoyerNumero = (saisie: string | null | undefined): string => String(saisie ?? "").trim().replace(/\s+/g, " ");

/** Deux numéros sont-ils le même ? (casse et espaces ignorés : « 040/dg/2026 » est « 040/DG/2026 »). */
export function memeNumero(a: string | null | undefined, b: string | null | undefined): boolean {
  const n = (x: string | null | undefined) => nettoyerNumero(x).replace(/\s*\/\s*/g, "/").toUpperCase();
  return n(a) !== "" && n(a) === n(b);
}

/** Ce qui rend une saisie libre (série hors registre) inacceptable — ou `null`. */
export function refusNumeroLibre(saisie: string | null | undefined): string | null {
  const s = nettoyerNumero(saisie);
  if (!s) return "Le numéro de référence est obligatoire.";
  if (s.length > LONGUEUR_MAX_NUMERO) return `Le numéro de référence ne dépasse pas ${LONGUEUR_MAX_NUMERO} caractères.`;
  if (INTERDITS.test(s)) return "Le numéro de référence porte un caractère interdit (\\ < > | \" * ?).";
  if (!/\d/.test(s)) return "Le numéro de référence doit porter un numéro.";
  return null;
}

const echapper = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/**
 * LA SÉQUENCE QUE PORTE UN NUMÉRO DE LA SÉRIE — l'inverse de `formaterNumero` (« {n:3}/FS/{aa} », « {prefixe}-{aaaa}-{n:4} ») :
 * « 012/FS/26 » → 12 pour l'année 2026. `null` quand le numéro ne suit pas le motif (un numéro libre) : il ne touche pas au
 * compteur, qui ne le croisera jamais (il n'a pas la forme de ce que la série attribue).
 */
export function sequenceDuNumero(numero: string, opts: { prefixe: string; annee: number; motif: string }): number | null {
  const s = nettoyerNumero(numero);
  if (!s) return null;
  let regex = "";
  let groupes = 0;
  const jeton = /\{(n(?::(\d{1,2}))?|aaaa|aa|prefixe)\}/g;
  let dernier = 0;
  for (const m of opts.motif.matchAll(jeton)) {
    regex += echapper(opts.motif.slice(dernier, m.index));
    const j = m[1];
    if (j === "aaaa") regex += String(opts.annee);
    else if (j === "aa") regex += String(opts.annee).slice(-2);
    else if (j === "prefixe") regex += echapper(opts.prefixe.trim().toUpperCase());
    else { regex += "(\\d{1,6})"; groupes++; }
    dernier = (m.index ?? 0) + m[0].length;
  }
  regex += echapper(opts.motif.slice(dernier));
  if (groupes !== 1) return null;
  const lu = new RegExp(`^${regex}$`, "i").exec(s);
  if (!lu) return null;
  const n = Number(lu[1]);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

/** Le compteur après une saisie : porté AU MOINS à elle, jamais en arrière. */
export const compteurApres = (dernier: number, saisi: number | null): number => Math.max(dernier, saisi ?? 0);

/** La phrase du refus d'un numéro déjà porté par un autre document. */
export function phraseNumeroPris(numero: string, porteur: { libelle: string; reference?: string | null } | null): string {
  return `Le numéro ${numero} est déjà porté par ${porteur ? `${porteur.libelle}${porteur.reference ? ` ${porteur.reference}` : ""}` : "un autre document de la même série"} : un numéro de référence est unique dans sa série. Choisissez-en un autre, ou gardez le numéro actuel.`;
}

/** Ce que le journal retient d'un changement de numéro. */
export const resumeChangementNumero = (ancien: string, nouveau: string): string => `numéro ${ancien} → ${nouveau}`;
