/**
 * COMPOSER UN `.docx` — le FLUX : remplir une zone bloc après bloc (espacements, pagination, lignes
 * solidaires, veuves et orphelines, objets ancrés), et la composition d'une boîte de hauteur libre.
 */
import type { Ancre, Bloc, Paragraphe, Bordure, Tableau } from "../docx-lecture";
import { type Trace, type Ctx, deplacer } from "./contrats";
import { composerParagraphe } from "./lignes";
import { positionner, tracesGraphiques } from "./dessins";
import { composerTableau, type TableauCompose, type CelluleComposee } from "./tableaux";

// ─────────────────────────── Le flux ───────────────────────────

export interface Cible { corps: Trace[]; derriere: Trace[]; devant: Trace[] }
export interface Zone { gauche: number; largeur: number; haut: number; bas: number }
interface Precedent { apres: number; apresAuto: boolean; styleId: string | null; contextuel: boolean }
export interface BoiteFixe extends Cible { hauteur: number; ancres?: { x: number; y: number; largeur: number; hauteur: number; ax: boolean; ay: boolean; ancre: Ancre }[] }

/**
 * LE FLUX : il pose les blocs les uns sous les autres. Paginé (le corps du document), il change de
 * page quand la place manque ; fixe (une cellule, un en-tête, une zone de texte), il ne fait que
 * mesurer et empiler, à partir de (0, 0).
 */
export class Flux {
  y: number;
  surPage = false;
  precedent: Precedent | null = null;
  ancres: NonNullable<BoiteFixe["ancres"]> = [];

  /** La page courante ouvre une section (ou le document) : l'espace avant y est conservé. */
  debutSection = true;

  constructor(
    private readonly ctx: Ctx,
    public zone: Zone,
    public cible: Cible,
    private readonly changer: (() => { zone: Zone; cible: Cible; debutSection: boolean }) | null,
  ) {
    this.y = zone.haut;
  }

  get pagine(): boolean { return this.changer !== null; }

  nouvellePage(): void {
    if (!this.changer) return;
    const n = this.changer();
    this.zone = n.zone;
    this.cible = n.cible;
    this.debutSection = n.debutSection;
    this.y = n.zone.haut;
    this.surPage = false;
    this.precedent = null;
  }

  placerBlocs(blocs: readonly Bloc[], cellule: boolean): void {
    blocs.forEach((b, k) => {
      if (b.type === "paragraphe") this.placerParagraphe(b, blocs[k + 1], cellule && k === 0, cellule && k === blocs.length - 1);
      else this.placerTableau(b);
    });
  }

  private espaceAvant(p: Paragraphe, premierDeCellule: boolean): number {
    // En tête d'une page ouverte par un saut (manuel ou naturel), Word SUPPRIME l'espace avant —
    // mesuré : le titre de la page 2 d'un rapport tombe sur la marge haute, pas 12 pt plus bas.
    if (this.pagine && !this.surPage && !this.debutSection) return 0;
    let avant = premierDeCellule && p.pp.avantAuto ? 0 : p.pp.avant;
    const prec = this.precedent;
    if (!prec) return avant;
    let apres = prec.apres;
    if (p.pp.espacementContextuel && prec.styleId === p.pp.styleId) avant = 0;
    if (prec.contextuel && prec.styleId === p.pp.styleId) apres = 0;
    // L'espacement automatique se comporte comme les marges HTML : il FUSIONNE.
    if (prec.apresAuto && p.pp.avantAuto) return Math.max(apres, avant);
    return apres + avant;
  }

  /** La hauteur à garder avec un paragraphe « lié au suivant » : le début du bloc suivant. */
  private hauteurDebut(b: Bloc | undefined, profondeur = 0): number {
    if (!b || profondeur > 3) return 0;
    if (b.type === "tableau") {
      const t = composerTableau(b, this.zone.largeur, this.ctx);
      return t.rangees[0]?.hauteur ?? 0;
    }
    const l = composerParagraphe(b, this.zone.largeur, this.ctx);
    return b.pp.avant + (l[0]?.hauteur ?? 0);
  }

  private placerParagraphe(p: Paragraphe, suivant: Bloc | undefined, premierDeCellule: boolean, dernierDeCellule: boolean): void {
    let lignes = composerParagraphe(p, this.zone.largeur, this.ctx);
    // Les filets haut et bas d'un paragraphe prennent leur place (épaisseur + `w:space`) : on
    // l'ajoute à la première et à la dernière ligne, la pagination en tient compte d'elle-même.
    const { haut: bh, bas: bb } = p.pp.bordures;
    const extraHaut = bh ? bh.epaisseurPt + bh.espacePt : 0;
    const extraBas = bb ? bb.epaisseurPt + bb.espacePt : 0;
    if (extraHaut || extraBas) {
      lignes = lignes.map((l, i) => {
        let hauteur = l.hauteur;
        let traces = l.traces;
        if (i === 0 && extraHaut) { hauteur += extraHaut; traces = deplacer(traces, 0, extraHaut); }
        if (i === lignes.length - 1 && extraBas) hauteur += extraBas;
        return { ...l, hauteur, traces };
      });
    }
    if (this.pagine && p.pp.sautAvant && this.surPage) this.nouvellePage();
    let avant = this.espaceAvant(p, premierDeCellule);
    const total = lignes.reduce((s, l) => s + l.hauteur, 0);
    const hauteurPage = this.zone.bas - this.zone.haut;
    if (this.pagine && this.surPage) {
      let besoin = 0;
      if (p.pp.garderAvecSuivant && lignes.length <= 3) besoin = avant + total + this.hauteurDebut(suivant);
      else if (p.pp.garderLignes) besoin = avant + total;
      if (besoin > 0 && this.y + besoin > this.zone.bas + 0.01 && besoin <= hauteurPage) {
        this.nouvellePage();
        avant = this.espaceAvant(p, premierDeCellule);
      }
    }
    this.y += avant;

    // Les objets ancrés suivent la page où tombe la première ligne.
    const poserAncres = (yPara: number) => {
      for (const a of p.ancres) {
        const pos = positionner(a, this.ctx.geo, this.zone, yPara);
        const tr = tracesGraphiques(a.contenu, pos.x, pos.y, this.ctx, { ax: pos.ax, ay: pos.ay });
        (a.derriere ? this.cible.derriere : this.cible.devant).push(...tr);
        this.ancres.push({ x: pos.x, y: pos.y, largeur: a.largeur, hauteur: a.hauteur, ax: pos.ax, ay: pos.ay, ancre: a });
      }
    };

    let i = 0;
    let premiereSurPage = true;
    while (i < lignes.length) {
      let k = lignes.length - i;
      if (this.pagine) {
        k = 0;
        let yy = this.y;
        while (i + k < lignes.length && yy + lignes[i + k]!.hauteur <= this.zone.bas + 0.01) {
          yy += lignes[i + k]!.hauteur;
          k += 1;
          if (lignes[i + k - 1]!.sautPage) break;
        }
        const force = k > 0 && lignes[i + k - 1]!.sautPage;
        if (!force && i + k < lignes.length && p.pp.veuves && lignes.length >= 2) {
          if (i === 0 && k === 1 && this.surPage) k = 0; // orpheline : la première ligne seule en bas de page
          else if (lignes.length - (i + k) === 1 && k >= 2) k -= 1; // veuve : la dernière ligne seule en haut
        }
        if (k === 0 && !this.surPage) k = 1; // une ligne plus haute que la page : posée quand même
        if (k === 0) {
          this.nouvellePage();
          continue;
        }
      }
      const debutSegment = this.cible.corps.length;
      const ySegment = this.y;
      if (i === 0 && premiereSurPage) poserAncres(ySegment);
      premiereSurPage = false;
      for (let n = 0; n < k; n++) {
        const l = lignes[i + n]!;
        this.cible.corps.push(...deplacer(l.traces, this.zone.gauche, this.y));
        this.y += l.hauteur;
      }
      this.surPage = true;
      this.decorer(p, debutSegment, ySegment, this.y, i === 0, i + k === lignes.length);
      i += k;
      const dernierePosee = lignes[i - 1]!;
      if (i <= lignes.length && dernierePosee.sautPage && this.pagine) this.nouvellePage();
      else if (i < lignes.length && this.pagine) this.nouvellePage();
    }
    this.precedent = {
      apres: dernierDeCellule && p.pp.apresAuto ? 0 : p.pp.apres,
      apresAuto: p.pp.apresAuto,
      styleId: p.pp.styleId,
      contextuel: p.pp.espacementContextuel,
    };
  }

  /** La trame et les bordures d'un paragraphe, sur le morceau posé dans cette page. */
  private decorer(p: Paragraphe, debut: number, y0: number, y1: number, premier: boolean, dernier: boolean): void {
    const pp = p.pp;
    const x0 = this.zone.gauche + pp.retraitGauche;
    const x1 = this.zone.gauche + this.zone.largeur - pp.retraitDroit;
    if (pp.fond) this.cible.corps.splice(debut, 0, { t: "rect", x: x0, y: y0, largeur: x1 - x0, hauteur: y1 - y0, fond: pp.fond, trait: null, forme: "rect" });
    const b = pp.bordures;
    const ligne = (bd: Bordure, xa: number, ya: number, xb: number, yb: number) => this.cible.corps.push({ t: "ligne", x1: xa, y1: ya, x2: xb, y2: yb, couleur: bd.couleur, epaisseur: bd.epaisseurPt, style: bd.style });
    if (b.haut && premier) ligne(b.haut, x0, y0 + b.haut.epaisseurPt / 2, x1, y0 + b.haut.epaisseurPt / 2);
    if (b.bas && dernier) ligne(b.bas, x0, y1 - b.bas.epaisseurPt / 2, x1, y1 - b.bas.epaisseurPt / 2);
    if (b.gauche) ligne(b.gauche, x0 - b.gauche.espacePt - b.gauche.epaisseurPt / 2, y0, x0 - b.gauche.espacePt - b.gauche.epaisseurPt / 2, y1);
    if (b.droite) ligne(b.droite, x1 + b.droite.espacePt + b.droite.epaisseurPt / 2, y0, x1 + b.droite.espacePt + b.droite.epaisseurPt / 2, y1);
  }

  private placerTableau(t: Tableau): void {
    const tc = composerTableau(t, this.zone.largeur, this.ctx);
    if (this.precedent) this.y += this.precedent.apres;
    this.precedent = null;
    const nbEntetes = (() => { let n = 0; while (n < tc.rangees.length && tc.rangees[n]!.entete) n += 1; return n; })();
    for (let r = 0; r < tc.rangees.length; r++) {
      if (this.pagine && this.surPage && !tc.soudee[r]) {
        let fin = r;
        for (let k = r; k <= fin && k < tc.rangees.length; k++) for (const cc of tc.rangees[k]!.cellules) fin = Math.max(fin, k + cc.rangs - 1);
        const besoin = tc.rangees.slice(r, fin + 1).reduce((s, x) => s + x.hauteur, 0);
        if (this.y + besoin > this.zone.bas + 0.01) {
          this.nouvellePage();
          if (r >= nbEntetes) for (let e = 0; e < nbEntetes; e++) this.dessinerRangee(tc, e);
        }
      }
      this.dessinerRangee(tc, r);
    }
  }

  private dessinerRangee(tc: TableauCompose, r: number): void {
    const rg = tc.rangees[r]!;
    const x0 = this.zone.gauche + tc.decalage;
    const y = this.y;
    const cellules = rg.cellules.filter((c) => !c.suite);
    const hauteurDe = (cc: CelluleComposee) => tc.rangees.slice(r, r + cc.rangs).reduce((s, x) => s + x.hauteur, 0);
    for (const cc of cellules) {
      if (cc.cellule.fond) this.cible.corps.push({ t: "rect", x: x0 + cc.x, y, largeur: cc.largeur, hauteur: hauteurDe(cc), fond: cc.cellule.fond, trait: null, forme: "rect" });
    }
    for (const cc of cellules) {
      const c = cc.cellule;
      const h = hauteurDe(cc);
      const libre = h - rg.filetHaut - c.marges.haut - c.marges.bas - cc.contenu.hauteur;
      const oy = libre > 0 ? (c.alignV === "centre" ? libre / 2 : c.alignV === "bas" ? libre : 0) : 0;
      const dx = x0 + cc.x + c.marges.gauche;
      const dy = y + rg.filetHaut + c.marges.haut + oy;
      this.cible.derriere.push(...deplacer(cc.contenu.derriere, dx, dy));
      this.cible.corps.push(...deplacer(cc.contenu.corps, dx, dy));
      this.cible.devant.push(...deplacer(cc.contenu.devant, dx, dy));
    }
    for (const cc of cellules) {
      const b = cc.cellule.bordures;
      const x = x0 + cc.x;
      const h = hauteurDe(cc);
      const ligne = (bd: Bordure | null, xa: number, ya: number, xb: number, yb: number) => {
        if (bd) this.cible.corps.push({ t: "ligne", x1: xa, y1: ya, x2: xb, y2: yb, couleur: bd.couleur, epaisseur: bd.epaisseurPt, style: bd.style });
      };
      ligne(b.haut, x, y, x + cc.largeur, y);
      ligne(cc.bas, x, y + h, x + cc.largeur, y + h);
      ligne(b.gauche, x, y, x, y + h);
      ligne(b.droite, x + cc.largeur, y, x + cc.largeur, y + h);
    }
    this.y += rg.hauteur;
    this.surPage = true;
  }
}

/** Compose des blocs HORS pagination (cellule, bande, zone de texte), à partir de (0, 0). */
export function composerBlocsFixe(blocs: readonly Bloc[], largeur: number, ctx: Ctx, cellule: boolean): BoiteFixe {
  const cible: Cible = { corps: [], derriere: [], devant: [] };
  const f = new Flux(ctx, { gauche: 0, largeur, haut: 0, bas: Number.POSITIVE_INFINITY }, cible, null);
  f.placerBlocs(blocs, cellule);
  return { hauteur: f.y + (f.precedent?.apres ?? 0), ...cible, ancres: f.ancres };
}
