/**
 * COMPOSER UN `.docx` — les TABLEAUX : largeurs de colonnes, fusions, cellules composées (chacune
 * par `composerBlocsFixe`, récursion entre fonctions seulement).
 */
import type { Cellule, Bordure, Tableau, Bloc } from "../docx-lecture";
import { columnWidths } from "../layout";
import type { Ctx } from "./contrats";
import { type BoiteFixe, composerBlocsFixe } from "./flux";

// ─────────────────────────── Les tableaux ───────────────────────────

export interface CelluleComposee {
  cellule: Cellule;
  x: number;
  largeur: number;
  contenu: BoiteFixe;
  /** Nombre de rangées couvertes (fusion verticale). */
  rangs: number;
  suite: boolean;
  bas: Bordure | null;
}
export interface TableauCompose {
  decalage: number;
  rangees: { hauteur: number; filetHaut: number; entete: boolean; cellules: CelluleComposee[] }[];
  /** Vrai quand la rangée continue une fusion commencée plus haut : on ne coupe pas la page devant elle. */
  soudee: boolean[];
}

export function composerTableau(t: Tableau, largeur: number, ctx: Ctx): TableauCompose {
  let parLargeur = ctx.tableaux.get(t);
  if (!parLargeur) { parLargeur = new Map(); ctx.tableaux.set(t, parLargeur); }
  const cle = Math.round(largeur * 100);
  const deja = parLargeur.get(cle);
  if (deja) return deja;

  const nbCols = Math.max(1, ...t.rangees.map((r) => r.cellules.reduce((m, c) => Math.max(m, c.colonne + c.span), 0)));
  let grille = t.grille.slice(0, Math.max(nbCols, t.grille.length));
  if (grille.length < nbCols || grille.some((w) => !(w > 0))) {
    const simple = t.rangees.every((r) => r.cellules.every((c) => c.span === 1) && r.cellules.length === nbCols);
    grille = simple
      ? columnWidths(t.rangees.map((r) => r.cellules.map((c) => texteBrut(c.blocs))), largeur)
      : Array.from({ length: nbCols }, () => largeur / nbCols);
  }
  let total = grille.reduce((a, b) => a + b, 0);
  // Un tableau un peu plus large que la zone de texte déborde dans la marge, comme dans Word ;
  // un tableau taillé pour une autre page est ramené à la largeur disponible.
  if (total > largeur + 24) {
    const k = largeur / total;
    grille = grille.map((w) => w * k);
    total = largeur;
  }
  const decalage = t.alignement === "center" ? (largeur - total) / 2 : t.alignement === "right" ? largeur - total : t.retrait;
  const debutCol = (c: number) => grille.slice(0, c).reduce((a, b) => a + b, 0);
  const largeurCols = (c: number, n: number) => grille.slice(c, c + n).reduce((a, b) => a + b, 0);

  const rangees: TableauCompose["rangees"] = t.rangees.map((r) => ({
    hauteur: 0,
    filetHaut: 0,
    entete: r.entete,
    cellules: r.cellules.map((c) => {
      const w = largeurCols(c.colonne, c.span);
      const contenu = c.fusionV === "suite"
        ? { hauteur: 0, corps: [], derriere: [], devant: [] }
        : composerBlocsFixe(c.blocs, Math.max(1, w - c.marges.gauche - c.marges.droite), ctx, true);
      return { cellule: c, x: debutCol(c.colonne), largeur: w, contenu, rangs: 1, suite: c.fusionV === "suite", bas: c.bordures.bas };
    }),
  }));
  // Les fusions verticales : une cellule « début » couvre les « suite » de même colonne en dessous.
  rangees.forEach((rg, r) => {
    for (const cc of rg.cellules) {
      if (cc.cellule.fusionV !== "debut") continue;
      let k = 1;
      while (r + k < rangees.length) {
        const sous = rangees[r + k]!.cellules.find((x) => x.cellule.colonne === cc.cellule.colonne && x.suite);
        if (!sous) break;
        cc.bas = sous.cellule.bordures.bas;
        k += 1;
      }
      cc.rangs = k;
    }
  });
  // Le filet du HAUT de chaque rangée (et celui du bas de la dernière) prend sa place dans la
  // hauteur, comme dans Word : mesuré, une rangée d'une ligne en 11 pt sous un filet de ½ pt
  // fait 13,9 pt, pas 13,4.
  const epaisseur = (b: Bordure | null) => (b ? (b.style === "double" ? b.epaisseurPt * 3 : b.epaisseurPt) : 0);
  t.rangees.forEach((r, i) => {
    const rg = rangees[i]!;
    rg.filetHaut = Math.max(0, ...rg.cellules.filter((c) => !c.suite).map((c) => epaisseur(c.cellule.bordures.haut)));
    const filetBas = i === t.rangees.length - 1 ? Math.max(0, ...rg.cellules.map((c) => epaisseur(c.bas))) : 0;
    let h = 0;
    for (const cc of rg.cellules) {
      if (cc.suite || cc.rangs > 1) continue;
      h = Math.max(h, cc.contenu.hauteur + cc.cellule.marges.haut + cc.cellule.marges.bas);
    }
    h += rg.filetHaut + filetBas;
    if (r.hauteur?.regle === "exact") h = r.hauteur.valeur;
    else if (r.hauteur) h = Math.max(h, r.hauteur.valeur);
    rg.hauteur = Math.max(h, 1);
  });
  // Une cellule fusionnée plus haute que ses rangées agrandit la DERNIÈRE de ces rangées.
  rangees.forEach((rg, r) => {
    for (const cc of rg.cellules) {
      if (cc.rangs <= 1) continue;
      const besoin = cc.contenu.hauteur + cc.cellule.marges.haut + cc.cellule.marges.bas + rg.filetHaut;
      const dispo = rangees.slice(r, r + cc.rangs).reduce((s, x) => s + x.hauteur, 0);
      if (besoin > dispo) rangees[r + cc.rangs - 1]!.hauteur += besoin - dispo;
    }
  });
  const soudee = rangees.map(() => false);
  rangees.forEach((rg, r) => { for (const cc of rg.cellules) for (let k = 1; k < cc.rangs; k++) soudee[r + k] = true; });
  const res = { decalage, rangees, soudee };
  parLargeur.set(cle, res);
  return res;
}

function texteBrut(blocs: readonly Bloc[]): string {
  return blocs.map((b) => (b.type === "paragraphe" ? b.contenu.map((c) => (c.k === "texte" ? c.texte : c.k === "tab" ? " " : "")).join("") : "")).join(" ");
}
