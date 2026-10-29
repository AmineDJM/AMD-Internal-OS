/**
 * COMPOSER UN `.docx` — les BOÎTES d'un paragraphe : mots, espaces, tabulations, sauts, dessins en
 * ligne, champs et puce, mesurés avec la police rendue.
 */
import type { ProprietesTexte, ElementGraphique, Etiquette, Tabulation, Paragraphe } from "../docx-lecture";
import { type PoliceRendu, type Mesureur, borne, type Ctx } from "./contrats";

// ─────────────────────────── Les boîtes d'un paragraphe ───────────────────────────

type TypeBoite = "mot" | "espace" | "tab" | "saut" | "dessin" | "champ" | "puce";
export interface Boite {
  type: TypeBoite;
  texte: string;
  p: ProprietesTexte;
  police: PoliceRendu;
  taille: number;
  decalage: number;
  largeur: number;
  asc: number;
  desc: number;
  coupureAvant: boolean;
  x: number;
  etiree?: boolean;
  ptab?: "left" | "center" | "right";
  saut?: "ligne" | "page" | "colonne";
  dessin?: { largeur: number; hauteur: number; contenu: ElementGraphique[] };
  champ?: "PAGE" | "NUMPAGES";
  puce?: NonNullable<Etiquette["puce"]>;
  points?: Tabulation["points"];
}

export function metriques(p: ProprietesTexte, mes: Mesureur): { police: PoliceRendu; taille: number; asc: number; desc: number } {
  const police = mes.police(p);
  const taille = borne(p.taillePt, 1, 400);
  return { police, taille, asc: taille * police.ascent, desc: taille * (police.interligne - police.ascent) };
}

export function boites(par: Paragraphe, ctx: Ctx): Boite[] {
  const { mes } = ctx;
  const out: Boite[] = [];
  let coupe = true;
  const vide = (type: TypeBoite, p: ProprietesTexte): Boite => {
    const m = metriques(p, mes);
    return { type, texte: "", p, police: m.police, taille: m.taille, decalage: 0, largeur: 0, asc: m.asc, desc: m.desc, coupureAvant: true, x: 0 };
  };
  const ajouterTexte = (brut: string, p: ProprietesTexte) => {
    const m = metriques(p, mes);
    const texte = p.majuscules ? brut.toUpperCase() : brut;
    // Petites majuscules : les minuscules passent en capitales, à 80 % de la taille.
    const segments: { s: string; petit: boolean }[] = [];
    if (p.petitesMajuscules) {
      for (const c of texte) {
        const petit = c !== c.toUpperCase();
        const dernier = segments[segments.length - 1];
        if (dernier && dernier.petit === petit) dernier.s += petit ? c.toUpperCase() : c;
        else segments.push({ s: petit ? c.toUpperCase() : c, petit });
      }
    } else segments.push({ s: texte, petit: false });
    const reduit = p.position !== "normal" ? 0.65 : 1;
    const decalage = p.position === "exposant" ? -m.taille * 0.33 : p.position === "indice" ? m.taille * 0.14 : 0;
    for (const seg of segments) {
      const taille = m.taille * reduit * (seg.petit ? 0.8 : 1);
      for (const tok of seg.s.split(/( +)/)) {
        if (!tok) continue;
        const espace = /^ +$/.test(tok);
        const parts = espace ? [tok] : tok.split(/(?<=[-–—])(?=[^\s\-–—])/);
        for (const part of parts) {
          const t = mes.nettoyer(m.police, part);
          const largeur = mes.largeur(m.police, t, taille) + p.espacementPt * [...t].length;
          out.push({ type: espace ? "espace" : "mot", texte: t, p, police: m.police, taille, decalage, largeur, asc: m.asc, desc: m.desc, coupureAvant: espace || coupe, x: 0 });
          coupe = espace || /[-–—]$/.test(part);
        }
      }
    }
  };

  const e = par.etiquette;
  if (e) {
    if (e.puce) {
      const b = vide("puce", e.p);
      b.puce = e.puce;
      b.largeur = Math.max(b.taille * 0.45, mes.largeur(b.police, "•", b.taille));
      if (e.symbole) {
        // Mesuré contre Word : une ligne qui porte une puce Symbol est plus haute (15,0 pt au lieu
        // de 14,5 pour du Calibri 11 en interligne 1,08) — ce sont les métriques de Symbol.
        b.asc = Math.max(b.asc, b.taille * 1.005);
        b.desc = Math.max(b.desc, b.taille * 0.259);
      }
      out.push(b);
    } else if (e.texte) ajouterTexte(e.texte, e.p);
    if (e.suffixe === "tab") out.push(vide("tab", e.p));
    else if (e.suffixe === "space") ajouterTexte(" ", e.p);
    coupe = true;
  }
  for (const it of par.contenu) {
    switch (it.k) {
      case "texte":
        ajouterTexte(it.texte, it.p);
        break;
      case "tab":
      case "ptab": {
        const b = vide("tab", it.p);
        if (it.k === "ptab") b.ptab = it.alignement;
        out.push(b);
        coupe = true;
        break;
      }
      case "saut": {
        const b = vide("saut", it.p);
        b.saut = it.type;
        out.push(b);
        coupe = true;
        break;
      }
      case "dessin": {
        const b = vide("dessin", it.p);
        b.dessin = { largeur: it.largeur, hauteur: it.hauteur, contenu: it.contenu };
        b.largeur = it.largeur;
        b.asc = it.hauteur;
        b.desc = 0;
        out.push(b);
        coupe = true;
        break;
      }
      case "champ": {
        const b = vide("champ", it.p);
        b.champ = it.code;
        b.texte = it.repli || "1";
        b.largeur = mes.largeur(b.police, b.texte, b.taille);
        b.coupureAvant = coupe;
        out.push(b);
        coupe = false;
        break;
      }
    }
  }
  return out;
}
