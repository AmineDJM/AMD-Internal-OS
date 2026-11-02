/**
 * COMPOSER UN `.docx` — les DESSINS : tracés des images, formes et zones de texte, et la position
 * d'un objet ancré (page, marge, paragraphe).
 */
import type { ElementGraphique, Ancre, PositionAncre } from "../docx-lecture";
import { type Ctx, type Abs, type Trace, NOIR, deplacer, type Geo } from "./contrats";
import { composerBlocsFixe } from "./flux";

// ─────────────────────────── Dessins : images, formes, zones de texte ───────────────────────────

export function tracesGraphiques(contenu: readonly ElementGraphique[], x0: number, y0: number, ctx: Ctx, abs: Abs): Trace[] {
  const out: Trace[] = [];
  for (const el of contenu) {
    const x = x0 + el.x;
    const y = y0 + el.y;
    if (el.type === "image") {
      out.push({ t: "image", x, y, largeur: el.largeur, hauteur: el.hauteur, image: el.image, rognage: el.rognage, ...abs });
      continue;
    }
    if (el.geometrie === "ligne") {
      const t = el.trait ?? { couleur: NOIR, epaisseur: 0.75 };
      out.push({ t: "ligne", x1: el.retourneH ? x + el.largeur : x, y1: el.retourneV ? y + el.hauteur : y, x2: el.retourneH ? x : x + el.largeur, y2: el.retourneV ? y : y + el.hauteur, couleur: t.couleur, epaisseur: t.epaisseur, style: "simple", ...abs });
    } else if (el.fond || el.trait) {
      out.push({ t: "rect", x, y, largeur: el.largeur, hauteur: el.hauteur, fond: el.fond, trait: el.trait, forme: el.geometrie, ...abs });
    }
    if (el.texte) {
      const m = el.texte.marges;
      const inner = composerBlocsFixe(el.texte.blocs, Math.max(1, el.largeur - m.gauche - m.droite), ctx, false);
      const libre = el.hauteur - m.haut - m.bas - inner.hauteur;
      const oy = libre > 0 ? (el.texte.ancrageV === "centre" ? libre / 2 : el.texte.ancrageV === "bas" ? libre : 0) : 0;
      out.push(...deplacer([...inner.derriere, ...inner.corps, ...inner.devant], x + m.gauche, y + m.haut + oy, abs));
    }
  }
  return out;
}

/** Où se pose un objet ancré. Un axe rapporté à la page ou à la marge est ABSOLU ; au paragraphe, relatif. */
export function positionner(a: Ancre, geo: Geo, zone: { gauche: number; largeur: number }, yParagraphe: number): { x: number; y: number; ax: boolean; ay: boolean } {
  const regionH = (rel: string): [number, number, boolean] => {
    switch (rel) {
      case "page": return [0, geo.largeur, true];
      case "leftMargin": case "insideMargin": return [0, geo.marges.gauche, true];
      case "rightMargin": case "outsideMargin": return [geo.largeur - geo.marges.droite, geo.marges.droite, true];
      case "margin": return [geo.marges.gauche, geo.largeur - geo.marges.gauche - geo.marges.droite, true];
      default: return [zone.gauche, zone.largeur, false];
    }
  };
  const regionV = (rel: string): [number, number, boolean] => {
    switch (rel) {
      case "page": return [0, geo.hauteur, true];
      case "margin": return [geo.texte.haut, geo.texte.bas - geo.texte.haut, true];
      case "topMargin": case "insideMargin": return [0, geo.texte.haut, true];
      case "bottomMargin": case "outsideMargin": return [geo.texte.bas, geo.hauteur - geo.texte.bas, true];
      default: return [yParagraphe, 0, false];
    }
  };
  const place = (pos: PositionAncre, region: [number, number, boolean], taille: number): number => {
    const [o, l] = region;
    if (pos.align) {
      if (pos.align === "center") return o + (l - taille) / 2;
      if (pos.align === "right" || pos.align === "bottom" || pos.align === "outside") return o + l - taille;
      return o;
    }
    if (pos.pct != null) return o + pos.pct * l;
    return o + (pos.decalage ?? 0);
  };
  const rh = regionH(a.h.rel);
  const rv = regionV(a.v.rel);
  return { x: place(a.h, rh, a.largeur), y: place(a.v, rv, a.hauteur), ax: rh[2], ay: rv[2] };
}
