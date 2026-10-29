/**
 * L'ADAPTATEUR EXCEL — la LECTURE d'un classeur : chaînes partagées, valeur d'une cellule, table des
 * styles et mise en forme d'un `xf` traduite dans le modèle.
 */
import PizZip from "pizzip";
import { type Alignment, type TextStyle, STYLE_NEUTRE } from "@/lib/artifact/object-model/model";
import { type XmlNode, attr, child, children, parseXml, textOf } from "@/lib/artifact/object-model/xml";

const ALIGN_MODELE: Record<string, Alignment> = { left: "left", center: "center", right: "right", justify: "justify", centerContinuous: "center" };

// ─────────────────────────── Lecture ───────────────────────────

/** Les chaînes partagées, dans l'ordre — un index `t="s"` s'y résout. */
export function lireChainesPartagees(zip: PizZip): string[] {
  const f = zip.file("xl/sharedStrings.xml");
  if (!f) return [];
  const racine = parseXml(f.asText());
  const sst = child(racine, "sst") ?? racine;
  // Un `<si>` peut être un `<t>` simple ou plusieurs `<r><t>` (texte enrichi) : on concatène.
  return children(sst, "si").map((si) => textOf(si));
}

export function valeurCellule(c: XmlNode, chaines: string[]): string {
  const t = attr(c, "t");
  if (t === "inlineStr") {
    const is = child(c, "is");
    return is ? textOf(is) : "";
  }
  const v = child(c, "v");
  const brut = v ? textOf(v) : "";
  if (t === "s") {
    const i = Number(brut);
    return Number.isInteger(i) && i >= 0 && i < chaines.length ? chaines[i] : "";
  }
  if (t === "b") return brut === "1" ? "VRAI" : "FAUX";
  return brut;
}

export interface StylesClasseur {
  racine: XmlNode;
  cellXfs: XmlNode;
  fonts: XmlNode;
  fills: XmlNode;
  numFmts: XmlNode | null;
}

export function lireStyles(zip: PizZip): StylesClasseur | null {
  const f = zip.file("xl/styles.xml");
  if (!f) return null;
  const racine = parseXml(f.asText());
  const ss = child(racine, "styleSheet");
  if (!ss) return null;
  const cellXfs = child(ss, "cellXfs");
  const fonts = child(ss, "fonts");
  const fills = child(ss, "fills");
  if (!cellXfs || !fonts || !fills) return null;
  return { racine, cellXfs, fonts, fills, numFmts: child(ss, "numFmts") };
}

export function styleDeXf(st: StylesClasseur | null, idx: number): { style: TextStyle; fill: string | null; align: Alignment | null; numFmt: string | null } {
  const neutre = { style: { ...STYLE_NEUTRE }, fill: null, align: null, numFmt: null };
  if (!st) return neutre;
  const xf = children(st.cellXfs, "xf")[idx];
  if (!xf) return neutre;

  const fontId = Number(attr(xf, "fontId") ?? "0");
  const font = children(st.fonts, "font")[fontId];
  const style: TextStyle = { ...STYLE_NEUTRE };
  if (font) {
    style.bold = Boolean(child(font, "b"));
    style.italic = Boolean(child(font, "i"));
    style.underline = Boolean(child(font, "u"));
    const sz = child(font, "sz");
    const szv = sz ? Number(attr(sz, "val")) : NaN;
    style.sizePt = Number.isFinite(szv) ? szv : null;
    const name = child(font, "name");
    style.font = name ? attr(name, "val") : null;
    const color = child(font, "color");
    const rgb = color ? attr(color, "rgb") : null;
    // Excel écrit AARRGGBB : on ne garde que RRGGBB, comme partout ailleurs dans le système.
    style.color = rgb && rgb.length === 8 ? rgb.slice(2).toUpperCase() : rgb ? rgb.toUpperCase() : null;
  }

  let fill: string | null = null;
  if (attr(xf, "applyFill") !== "0") {
    const fillId = Number(attr(xf, "fillId") ?? "0");
    const f = children(st.fills, "fill")[fillId];
    const pat = f ? child(f, "patternFill") : null;
    const fg = pat ? child(pat, "fgColor") : null;
    const rgb = fg ? attr(fg, "rgb") : null;
    if (rgb) fill = rgb.length === 8 ? rgb.slice(2).toUpperCase() : rgb.toUpperCase();
  }

  const al = child(xf, "alignment");
  const alv = al ? attr(al, "horizontal") : null;

  const numFmtId = attr(xf, "numFmtId");
  let numFmt: string | null = null;
  if (numFmtId && st.numFmts) {
    const trouve = children(st.numFmts, "numFmt").find((n) => attr(n, "numFmtId") === numFmtId);
    numFmt = trouve ? attr(trouve, "formatCode") : null;
  }

  return { style, fill, align: alv ? ALIGN_MODELE[alv] ?? null : null, numFmt };
}
