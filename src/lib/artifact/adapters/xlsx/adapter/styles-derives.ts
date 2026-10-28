/**
 * L'ADAPTATEUR EXCEL — les STYLES DÉRIVÉS : un `xf` (et sa police, son remplissage, son format de
 * nombre) dérivé de l'existant, jamais modifié en place — voir le piège n° 2 de la porte.
 */
import type { Alignment } from "@/lib/artifact/object-model/model";
import type { CommandeArtefact } from "@/lib/artifact/commands/ir";
import { attr, child, children, cloneNode, element, ensureChild, markDirty, removeChild, serializeXml, setAttr } from "@/lib/artifact/object-model/xml";
import type { StylesClasseur } from "./lecture";

const ALIGN_XLSX: Record<Alignment, string> = { left: "left", center: "center", right: "right", justify: "justify" };

// ─────────────────────────── Styles dérivés ───────────────────────────

/**
 * DÉRIVE un `xf` : on part de l'existant, on n'y change QUE ce qui est demandé, et on ajoute
 * le résultat s'il n'existe pas déjà. C'est ce qui empêche « mets B4 en gras » de mettre en
 * gras les deux cents cellules qui partageaient son style.
 */
export function deriverStyle(st: StylesClasseur, idx: number, c: CommandeArtefact): number {
  const xfs = children(st.cellXfs, "xf");
  const source = xfs[idx] ?? xfs[0];
  const copie = source ? cloneNode(source, st.cellXfs) : element("xf", { numFmtId: "0", fontId: "0", fillId: "0", borderId: "0" });
  copie.raw = null;

  if (c.gras !== null || c.italique !== null || c.souligne !== null || c.taillePt !== null || c.police !== null || c.couleur !== null) {
    copie.attrs.set("fontId", String(deriverPolice(st, Number(attr(copie, "fontId") ?? "0"), c)));
    copie.attrs.set("applyFont", "1");
  }
  if (c.remplissage !== null) {
    copie.attrs.set("fillId", String(deriverRemplissage(st, c.remplissage)));
    copie.attrs.set("applyFill", "1");
  }
  if (c.formatNombre !== null) {
    copie.attrs.set("numFmtId", String(deriverFormatNombre(st, c.formatNombre)));
    copie.attrs.set("applyNumberFormat", "1");
  }
  if (c.alignement !== null) {
    const al = ensureChild(copie, "alignment", []);
    setAttr(al, "horizontal", ALIGN_XLSX[c.alignement as Alignment]);
    copie.attrs.set("applyAlignment", "1");
  }
  markDirty(copie);

  const signature = serializeXml(copie);
  const deja = xfs.findIndex((x) => serializeXml(x) === signature);
  if (deja >= 0) return deja;
  copie.parent = st.cellXfs;
  st.cellXfs.children.push(copie);
  st.cellXfs.selfClosing = false;
  setAttr(st.cellXfs, "count", String(children(st.cellXfs, "xf").length));
  markDirty(st.cellXfs);
  return children(st.cellXfs, "xf").length - 1;
}

function deriverPolice(st: StylesClasseur, idx: number, c: CommandeArtefact): number {
  const polices = children(st.fonts, "font");
  const source = polices[idx] ?? polices[0];
  const copie = source ? cloneNode(source, st.fonts) : element("font");
  copie.raw = null;
  const poser = (nom: string, actif: boolean) => {
    const el = child(copie, nom);
    if (actif && !el) ensureChild(copie, nom, []);
    else if (!actif && el) removeChild(copie, el);
  };
  if (c.gras !== null) poser("b", c.gras);
  if (c.italique !== null) poser("i", c.italique);
  if (c.souligne !== null) poser("u", c.souligne);
  if (c.taillePt !== null) setAttr(ensureChild(copie, "sz", []), "val", String(c.taillePt));
  if (c.police !== null) setAttr(ensureChild(copie, "name", []), "val", c.police);
  if (c.couleur !== null) {
    const col = ensureChild(copie, "color", []);
    col.attrs.delete("theme");
    col.attrs.delete("indexed");
    setAttr(col, "rgb", `FF${c.couleur.toUpperCase()}`);
  }
  markDirty(copie);
  const signature = serializeXml(copie);
  const deja = polices.findIndex((x) => serializeXml(x) === signature);
  if (deja >= 0) return deja;
  copie.parent = st.fonts;
  st.fonts.children.push(copie);
  st.fonts.selfClosing = false;
  setAttr(st.fonts, "count", String(children(st.fonts, "font").length));
  markDirty(st.fonts);
  return children(st.fonts, "font").length - 1;
}

function deriverRemplissage(st: StylesClasseur, couleur: string): number {
  const rgb = `FF${couleur.replace(/^#/, "").toUpperCase()}`;
  const fills = children(st.fills, "fill");
  const deja = fills.findIndex((f) => {
    const p = child(f, "patternFill");
    return p !== null && attr(p, "patternType") === "solid" && attr(child(p, "fgColor") ?? element("x"), "rgb") === rgb;
  });
  if (deja >= 0) return deja;
  const fg = element("fgColor", { rgb });
  const bg = element("bgColor", { indexed: "64" });
  const pat = element("patternFill", { patternType: "solid" }, [fg, bg]);
  const fill = element("fill", {}, [pat]);
  fill.parent = st.fills;
  st.fills.children.push(fill);
  st.fills.selfClosing = false;
  setAttr(st.fills, "count", String(children(st.fills, "fill").length));
  markDirty(st.fills);
  return children(st.fills, "fill").length - 1;
}

function deriverFormatNombre(st: StylesClasseur, code: string): number {
  const ss = child(st.racine, "styleSheet")!;
  let numFmts = st.numFmts;
  if (!numFmts) {
    numFmts = element("numFmts", { count: "0" });
    numFmts.parent = ss;
    // `numFmts` doit ouvrir la feuille de styles : le schéma l'exige avant `fonts`.
    ss.children.unshift(numFmts);
    markDirty(ss);
    st.numFmts = numFmts;
  }
  const existants = children(numFmts, "numFmt");
  const deja = existants.find((n) => attr(n, "formatCode") === code);
  if (deja) return Number(attr(deja, "numFmtId"));
  // Les identifiants < 164 sont RÉSERVÉS aux formats intégrés d'Excel : on démarre après.
  const ids = existants.map((n) => Number(attr(n, "numFmtId"))).filter(Number.isFinite);
  const id = Math.max(163, ...ids) + 1;
  const el = element("numFmt", { numFmtId: String(id), formatCode: code });
  el.parent = numFmts;
  numFmts.children.push(el);
  numFmts.selfClosing = false;
  setAttr(numFmts, "count", String(children(numFmts, "numFmt").length));
  markDirty(numFmts);
  return id;
}
