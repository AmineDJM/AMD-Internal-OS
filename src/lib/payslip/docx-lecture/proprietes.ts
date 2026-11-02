/**
 * LIRE UN `.docx` — les propriétés PARTIELLES de caractère (`rPr`) et de paragraphe (`pPr`) avant
 * cascade, leur fusion couche par couche, et leur résolution en propriétés complètes.
 */
import { type XmlNode, attr, children } from "@/lib/artifact/object-model/xml";
import type { ProprietesTexte, ProprietesParagraphe, Tabulation, Bordure } from "./modele";
import { nombre, enfant, bascule, att, TWIP, AUTO_ESPACEMENT } from "./unites";
import { type Theme, couleurWord, COULEURS_NOMMEES } from "./theme";

// ─────────────────────────── Propriétés partielles (avant cascade) ───────────────────────────

export type RPr = Partial<ProprietesTexte>;

export interface PPr {
  alignement?: ProprietesParagraphe["alignement"];
  retraitGauche?: number;
  retraitDroit?: number;
  retraitPremiere?: number;
  avant?: number;
  apres?: number;
  avantAuto?: boolean;
  apresAuto?: boolean;
  interligne?: ProprietesParagraphe["interligne"];
  tabs?: Tabulation[];
  garderAvecSuivant?: boolean;
  garderLignes?: boolean;
  sautAvant?: boolean;
  veuves?: boolean;
  espacementContextuel?: boolean;
  fond?: string | null;
  bordures?: Partial<ProprietesParagraphe["bordures"]>;
  numId?: string;
  niveau?: number;
}

export function lireBordure(n: XmlNode | null, theme: Theme): Bordure | null | undefined {
  if (!n) return undefined;
  const val = attr(n, "w:val") ?? "single";
  if (val === "nil" || val === "none") return null;
  const sz = nombre(attr(n, "w:sz")) ?? 4;
  const couleur = couleurWord(attr(n, "w:color"), attr(n, "w:themeColor"), attr(n, "w:themeShade"), attr(n, "w:themeTint"), theme) ?? "000000";
  const style: Bordure["style"] = /double/i.test(val) ? "double" : /dot/i.test(val) ? "pointille" : /dash/i.test(val) ? "tirets" : "simple";
  return { epaisseurPt: Math.max(0.25, sz / 8), couleur, style, espacePt: Math.max(0, Math.min(31, nombre(attr(n, "w:space")) ?? 0)) };
}

export function lireRPr(rPr: XmlNode | null, theme: Theme): RPr {
  const r: RPr = {};
  if (!rPr) return r;
  const polices = enfant(rPr, "w:rFonts");
  if (polices) {
    const th = attr(polices, "w:asciiTheme") ?? attr(polices, "w:hAnsiTheme");
    const nom = th ? (/^major/.test(th) ? theme.majeure : theme.mineure) : attr(polices, "w:ascii") ?? attr(polices, "w:hAnsi");
    if (nom) r.police = nom;
  }
  const b = bascule(enfant(rPr, "w:b"));
  if (b !== undefined) r.gras = b;
  const i = bascule(enfant(rPr, "w:i"));
  if (i !== undefined) r.italique = i;
  const caps = bascule(enfant(rPr, "w:caps"));
  if (caps !== undefined) r.majuscules = caps;
  const pcaps = bascule(enfant(rPr, "w:smallCaps"));
  if (pcaps !== undefined) r.petitesMajuscules = pcaps;
  const barre = bascule(enfant(rPr, "w:strike")) ?? bascule(enfant(rPr, "w:dstrike"));
  if (barre !== undefined) r.barre = barre;
  const masque = bascule(enfant(rPr, "w:vanish"));
  if (masque !== undefined) r.masque = masque;
  const sz = nombre(att(enfant(rPr, "w:sz"), "w:val"));
  if (sz != null && sz > 0) r.taillePt = sz / 2;
  const c = enfant(rPr, "w:color");
  if (c) r.couleur = couleurWord(attr(c, "w:val"), attr(c, "w:themeColor"), attr(c, "w:themeShade"), attr(c, "w:themeTint"), theme);
  const u = enfant(rPr, "w:u");
  if (u) {
    const v = attr(u, "w:val") ?? "single";
    r.souligne = v === "none" || v === "0" ? null : /double/i.test(v) ? "double" : "simple";
  }
  const hl = att(enfant(rPr, "w:highlight"), "w:val");
  if (hl) r.surlignage = hl === "none" ? null : COULEURS_NOMMEES[hl] ?? null;
  const shd = enfant(rPr, "w:shd");
  if (shd) r.fond = couleurWord(attr(shd, "w:fill"), attr(shd, "w:themeFill"), attr(shd, "w:themeFillShade"), attr(shd, "w:themeFillTint"), theme);
  const va = att(enfant(rPr, "w:vertAlign"), "w:val");
  if (va) r.position = va === "superscript" ? "exposant" : va === "subscript" ? "indice" : "normal";
  const esp = nombre(att(enfant(rPr, "w:spacing"), "w:val"));
  if (esp != null) r.espacementPt = esp / TWIP;
  return r;
}

export function lirePPr(pPr: XmlNode | null, theme: Theme): PPr {
  const p: PPr = {};
  if (!pPr) return p;
  const jc = att(enfant(pPr, "w:jc"), "w:val");
  if (jc) p.alignement = jc === "center" ? "center" : jc === "right" || jc === "end" ? "right" : jc === "both" || jc === "distribute" || /Kashida/.test(jc) ? "justify" : "left";
  const ind = enfant(pPr, "w:ind");
  if (ind) {
    const g = nombre(attr(ind, "w:left") ?? attr(ind, "w:start"));
    const d = nombre(attr(ind, "w:right") ?? attr(ind, "w:end"));
    const fl = nombre(attr(ind, "w:firstLine"));
    const hg = nombre(attr(ind, "w:hanging"));
    if (g != null) p.retraitGauche = g / TWIP;
    if (d != null) p.retraitDroit = d / TWIP;
    if (hg != null) p.retraitPremiere = -hg / TWIP;
    else if (fl != null) p.retraitPremiere = fl / TWIP;
  }
  const sp = enfant(pPr, "w:spacing");
  if (sp) {
    const av = nombre(attr(sp, "w:before"));
    const ap = nombre(attr(sp, "w:after"));
    if (av != null) p.avant = av / TWIP;
    if (ap != null) p.apres = ap / TWIP;
    const vrai = (v: string) => v === "1" || v === "true" || v === "on";
    const aa = attr(sp, "w:beforeAutospacing");
    const pa = attr(sp, "w:afterAutospacing");
    if (aa != null) p.avantAuto = vrai(aa);
    if (pa != null) p.apresAuto = vrai(pa);
    const ligne = nombre(attr(sp, "w:line"));
    if (ligne != null && ligne > 0) {
      const regle = attr(sp, "w:lineRule") ?? "auto";
      p.interligne = regle === "exact" ? { regle: "exact", valeur: ligne / TWIP } : regle === "atLeast" ? { regle: "atLeast", valeur: ligne / TWIP } : { regle: "auto", valeur: ligne / 240 };
    }
  }
  const tabs = enfant(pPr, "w:tabs");
  if (tabs) {
    p.tabs = children(tabs, "w:tab").map((t) => {
      const v = attr(t, "w:val") ?? "left";
      const type: Tabulation["type"] = v === "clear" ? "clear" : v === "center" ? "center" : v === "right" || v === "end" ? "right" : v === "decimal" ? "decimal" : v === "bar" ? "bar" : "left";
      const l = attr(t, "w:leader");
      return { pos: (nombre(attr(t, "w:pos")) ?? 0) / TWIP, type, points: l === "dot" || l === "hyphen" || l === "underscore" || l === "middleDot" ? l : null };
    });
  }
  const b = (nom: string): boolean | undefined => bascule(enfant(pPr, nom));
  if (b("w:keepNext") !== undefined) p.garderAvecSuivant = b("w:keepNext");
  if (b("w:keepLines") !== undefined) p.garderLignes = b("w:keepLines");
  if (b("w:pageBreakBefore") !== undefined) p.sautAvant = b("w:pageBreakBefore");
  if (b("w:widowControl") !== undefined) p.veuves = b("w:widowControl");
  if (b("w:contextualSpacing") !== undefined) p.espacementContextuel = b("w:contextualSpacing");
  const shd = enfant(pPr, "w:shd");
  if (shd) p.fond = couleurWord(attr(shd, "w:fill"), attr(shd, "w:themeFill"), attr(shd, "w:themeFillShade"), attr(shd, "w:themeFillTint"), theme);
  const bdr = enfant(pPr, "w:pBdr");
  if (bdr) {
    p.bordures = {};
    const h = lireBordure(enfant(bdr, "w:top"), theme);
    const bas = lireBordure(enfant(bdr, "w:bottom"), theme);
    const g = lireBordure(enfant(bdr, "w:left") ?? enfant(bdr, "w:start"), theme);
    const d = lireBordure(enfant(bdr, "w:right") ?? enfant(bdr, "w:end"), theme);
    if (h !== undefined) p.bordures.haut = h;
    if (bas !== undefined) p.bordures.bas = bas;
    if (g !== undefined) p.bordures.gauche = g;
    if (d !== undefined) p.bordures.droite = d;
  }
  const numPr = enfant(pPr, "w:numPr");
  if (numPr) {
    const id = att(enfant(numPr, "w:numId"), "w:val");
    const lvl = nombre(att(enfant(numPr, "w:ilvl"), "w:val"));
    if (id != null) p.numId = id;
    if (lvl != null) p.niveau = lvl;
  }
  return p;
}

export function fusionPPr(...couches: (PPr | null | undefined)[]): PPr {
  const out: PPr = {};
  for (const c of couches) {
    if (!c) continue;
    const { tabs, bordures, ...reste } = c;
    Object.assign(out, reste);
    if (tabs) out.tabs = [...(out.tabs ?? []), ...tabs];
    if (bordures) out.bordures = { ...(out.bordures ?? {}), ...bordures };
  }
  return out;
}

export const fusionRPr = (...couches: (RPr | null | undefined)[]): RPr => Object.assign({}, ...couches.filter(Boolean));

const TEXTE_DEFAUT: ProprietesTexte = {
  police: "Times New Roman", taillePt: 10, gras: false, italique: false, souligne: null, barre: false, couleur: null,
  surlignage: null, fond: null, majuscules: false, petitesMajuscules: false, position: "normal", masque: false, espacementPt: 0, lien: null,
};

export function resoudreTexte(r: RPr): ProprietesTexte {
  return { ...TEXTE_DEFAUT, ...Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined)) } as ProprietesTexte;
}

export function resoudreParagraphe(p: PPr, styleId: string | null): ProprietesParagraphe {
  // Les tabulations : chaque couche AJOUTE ou EFFACE (`clear`) — l'ordre des couches fait foi.
  const tabs: Tabulation[] = [];
  for (const t of p.tabs ?? []) {
    const i = tabs.findIndex((x) => Math.abs(x.pos - t.pos) < 0.6);
    if (i >= 0) tabs.splice(i, 1);
    if (t.type !== "clear") tabs.push(t);
  }
  tabs.sort((a, b) => a.pos - b.pos);
  return {
    alignement: p.alignement ?? "left",
    retraitGauche: p.retraitGauche ?? 0,
    retraitDroit: p.retraitDroit ?? 0,
    retraitPremiere: p.retraitPremiere ?? 0,
    avant: p.avantAuto ? AUTO_ESPACEMENT : p.avant ?? 0,
    apres: p.apresAuto ? AUTO_ESPACEMENT : p.apres ?? 0,
    avantAuto: !!p.avantAuto,
    apresAuto: !!p.apresAuto,
    interligne: p.interligne ?? { regle: "auto", valeur: 1 },
    tabulations: tabs,
    garderAvecSuivant: !!p.garderAvecSuivant,
    garderLignes: !!p.garderLignes,
    sautAvant: !!p.sautAvant,
    veuves: p.veuves ?? true,
    espacementContextuel: !!p.espacementContextuel,
    fond: p.fond ?? null,
    bordures: { haut: p.bordures?.haut ?? null, bas: p.bordures?.bas ?? null, gauche: p.bordures?.gauche ?? null, droite: p.bordures?.droite ?? null },
    styleId,
  };
}
