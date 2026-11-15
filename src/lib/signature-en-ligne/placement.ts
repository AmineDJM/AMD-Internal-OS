/**
 * OÙ POSER LA SIGNATURE, LE CACHET ET LE SCEAU SUR LA DERNIÈRE PAGE D'UN BC (Direction, 15/11/2026) — PUR.
 *
 * Repère « page » (origine en haut à gauche, y vers le bas, en points), celui que rend la recherche de texte de mupdf.
 * Le BC porte la mention « Signature et cachet » : les deux signataires se posent SOUS elle, côte à côte — la Direction
 * Marketing à gauche, les Finances à droite. Sans la mention (une pièce d'un autre gabarit), le bloc se pose en bas à
 * droite, au-dessus des sceaux. Chaque signataire a son SCEAU (QR de vérification + mention) au pied de la page, chacun
 * sa moitié : deux signatures ne se recouvrent jamais.
 */

export type Qualite = "DIRECTION_MARKETING" | "FINANCES";
export interface Rect { x: number; y: number; w: number; h: number }

const MARGE = 30;
const LARGEUR_BLOC = 150;
const ECART = 20;
const HAUTEUR_SCEAU = 46;

/** Le rectangle englobant d'un quadrilatère mupdf `[ulx, uly, urx, ury, llx, lly, lrx, lry]`. */
export function rectDuQuad(q: readonly number[]): Rect {
  const xs = [q[0], q[2], q[4], q[6]], ys = [q[1], q[3], q[5], q[7]];
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

export interface Placement { signature: Rect; cachet: Rect; sceau: Rect }

export function placement(page: { w: number; h: number }, ancre: Rect | null, qualite: Qualite): Placement {
  const largeurDuo = 2 * LARGEUR_BLOC + ECART;
  const basSceaux = page.h - MARGE / 2 - HAUTEUR_SCEAU;
  let debut = ancre ? ancre.x - 10 : page.w - MARGE - largeurDuo;
  debut = Math.max(MARGE, Math.min(debut, page.w - MARGE - largeurDuo));
  let haut = ancre ? ancre.y + ancre.h + 6 : basSceaux - 90;
  // Un bloc qui mordrait sur les sceaux remonte au-dessus d'eux.
  if (haut + 80 > basSceaux) haut = basSceaux - 85;
  const x = qualite === "DIRECTION_MARKETING" ? debut : debut + LARGEUR_BLOC + ECART;
  const demi = (page.w - 2 * MARGE - ECART) / 2;
  return {
    signature: { x, y: haut + 8, w: 110, h: 55 },
    cachet: { x: x + 72, y: haut, w: 72, h: 72 },
    sceau: { x: qualite === "DIRECTION_MARKETING" ? MARGE : MARGE + demi + ECART, y: basSceaux, w: demi, h: HAUTEUR_SCEAU },
  };
}

/** Une image (l × h) logée dans un rectangle sans la déformer — centrée. */
export function ajuster(r: Rect, l: number, h: number): Rect {
  if (!(l > 0 && h > 0)) return r;
  const k = Math.min(r.w / l, r.h / h);
  const w = l * k, hh = h * k;
  return { x: r.x + (r.w - w) / 2, y: r.y + (r.h - hh) / 2, w, h: hh };
}

/** La matrice PDF (`a b c d e f` de l'opérateur `cm`) qui pose une image dans un rectangle du repère « page ». */
export function matricePdf(r: Rect, hauteurPage: number): [number, number, number, number, number, number] {
  return [r.w, 0, 0, r.h, r.x, hauteurPage - r.y - r.h];
}
