/**
 * L'ADAPTATEUR WORD — l'ÉCRITURE : `w:pPr` / `w:rPr` créés et complétés dans l'ordre imposé par le
 * schéma, nouveaux fragments, remplacement du texte d'un paragraphe.
 */
import { type Alignment, type ParagraphNode, ptEnDemiPt } from "@/lib/artifact/object-model/model";
import { abreger } from "@/lib/artifact/object-model/text";
import type { CommandeArtefact } from "@/lib/artifact/commands/ir";
import { type XmlNode, child, children, cloneNode, element, ensureChild, insertAfter, markDirty, removeChild, setAttr, textNode } from "@/lib/artifact/object-model/xml";

export const ALIGN_OOXML: Record<Alignment, string> = { left: "left", center: "center", right: "right", justify: "both" };

/** Ordre imposé par le schéma pour les enfants de `w:pPr`. Le violer rend le fichier illisible. */
export const ORDRE_PPR = ["w:pStyle", "w:numPr", "w:pBdr", "w:shd", "w:tabs", "w:spacing", "w:ind", "w:jc"];
/** Idem pour `w:rPr` : `w:rFonts` ouvre, `w:color` et `w:sz` suivent. */
const ORDRE_RPR = ["w:rFonts", "w:b", "w:bCs", "w:i", "w:iCs", "w:caps", "w:strike", "w:color", "w:sz", "w:szCs", "w:u"];

// ─────────────────────────── Écriture ───────────────────────────

export function pPr(p: XmlNode): XmlNode {
  // `w:pPr` doit être le PREMIER enfant de `w:p` — sinon Word refuse le document.
  const existant = child(p, "w:pPr");
  if (existant) return existant;
  const el = element("w:pPr");
  el.parent = p;
  p.children.unshift(el);
  markDirty(p);
  return el;
}

export function rPr(run: XmlNode): XmlNode {
  const existant = child(run, "w:rPr");
  if (existant) return existant;
  const el = element("w:rPr");
  el.parent = run;
  run.children.unshift(el);
  markDirty(run);
  return el;
}

/** Pose (ou retire) une balise « oui/non » du style OOXML : `<w:b/>` présent = gras. */
function poserOnOff(parent: XmlNode, nom: string, actif: boolean, ordre: string[]): void {
  const existant = child(parent, nom);
  if (actif) {
    if (existant) { existant.attrs.delete("w:val"); markDirty(existant); }
    else ensureChild(parent, nom, ordre.slice(0, ordre.indexOf(nom)));
  } else if (existant) {
    removeChild(parent, existant);
  }
}

/** Applique la mise en forme demandée sur un `w:rPr` DÉJÀ rattaché à l'arbre. */
export function appliquerStyleProps(props: XmlNode, c: CommandeArtefact): void {
  if (c.gras !== null) poserOnOff(props, "w:b", c.gras, ORDRE_RPR);
  if (c.italique !== null) poserOnOff(props, "w:i", c.italique, ORDRE_RPR);
  if (c.souligne !== null) {
    const u = child(props, "w:u");
    if (c.souligne) setAttr(u ?? ensureChild(props, "w:u", ORDRE_RPR.slice(0, ORDRE_RPR.indexOf("w:u"))), "w:val", "single");
    else if (u) removeChild(props, u);
  }
  if (c.taillePt !== null) {
    const demi = String(ptEnDemiPt(c.taillePt));
    setAttr(ensureChild(props, "w:sz", ORDRE_RPR.slice(0, ORDRE_RPR.indexOf("w:sz"))), "w:val", demi);
    // `w:szCs` gouverne les écritures complexes (arabe) : sans lui, un titre réduit à 16 pt reste
    // à 24 pt dans les passages arabes du document, ce qui est incompréhensible pour la personne.
    setAttr(ensureChild(props, "w:szCs", ORDRE_RPR.slice(0, ORDRE_RPR.indexOf("w:szCs"))), "w:val", demi);
  }
  if (c.police !== null) {
    const f = ensureChild(props, "w:rFonts", []);
    for (const a of ["w:ascii", "w:hAnsi", "w:cs", "w:eastAsia"]) setAttr(f, a, c.police);
  }
  if (c.couleur !== null) {
    setAttr(ensureChild(props, "w:color", ORDRE_RPR.slice(0, ORDRE_RPR.indexOf("w:color"))), "w:val", c.couleur.toUpperCase());
  }
}

/** Fabrique un `w:r` portant ce texte, en copiant le style d'un fragment de référence. */
export function nouveauRun(texte: string, modele: XmlNode | null): XmlNode {
  const run = element("w:r");
  if (modele) {
    const src = child(modele, "w:rPr");
    if (src) {
      const copie = cloneNode(src, run);
      copie.raw = null;
      run.children.push(copie);
    }
  }
  const t = element("w:t", { "xml:space": "preserve" }, [textNode(texte)]);
  t.parent = run;
  run.children.push(t);
  run.selfClosing = false;
  return run;
}

/** Remplace tout le texte d'un paragraphe par un seul fragment, en gardant sa mise en forme. */
export function remplacerTexteParagraphe(p: XmlNode, texte: string): void {
  const runs = children(p, "w:r");
  const reference = runs[0] ?? null;
  for (const r of runs) removeChild(p, r);
  // Les `w:hyperlink` contiennent aussi du texte : les retirer évite un doublon invisible.
  for (const h of children(p, "w:hyperlink")) removeChild(p, h);
  if (texte) insertAfter(p, child(p, "w:pPr"), nouveauRun(texte, reference));
  markDirty(p);
}

export const libelleParagraphe = (p: ParagraphNode): string => `¶${p.index} ${abreger(p.text || "(vide)", 40)}`;
