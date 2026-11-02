/**
 * LIRE UN `.docx` — le THÈME (polices majeure/mineure, couleurs) et la résolution des couleurs
 * Word et DrawingML (teintes, ombres, luminance).
 */
import PizZip from "pizzip";
import { parseXml, type XmlNode, attr } from "@/lib/artifact/object-model/xml";
import { premier, att, enfant, elements, hex6, nombre } from "./unites";

// ─────────────────────────── Le thème ───────────────────────────

export interface Theme { majeure: string; mineure: string; couleurs: Map<string, string> }

export function lireTheme(zip: PizZip): Theme {
  const theme: Theme = { majeure: "Calibri Light", mineure: "Calibri", couleurs: new Map() };
  const nom = Object.keys(zip.files).find((f) => /^word\/theme\/theme\d*\.xml$/.test(f));
  const f = nom ? zip.file(nom) : null;
  if (!f) return theme;
  const racine = parseXml(f.asText());
  const maj = premier(racine, "a:majorFont");
  const min = premier(racine, "a:minorFont");
  const latin = (n: XmlNode | null) => att(enfant(n, "a:latin"), "typeface");
  theme.majeure = latin(maj) || theme.majeure;
  theme.mineure = latin(min) || theme.mineure;
  const schema = premier(racine, "a:clrScheme");
  if (schema) {
    for (const c of elements(schema)) {
      const srgb = enfant(c, "a:srgbClr");
      const sys = enfant(c, "a:sysClr");
      const v = hex6(att(srgb, "val")) ?? hex6(att(sys, "lastClr"));
      if (v) theme.couleurs.set(c.name.replace(/^a:/, ""), v);
    }
  }
  return theme;
}

const ALIAS_THEME: Record<string, string> = { tx1: "dk1", bg1: "lt1", tx2: "dk2", bg2: "lt2", text1: "dk1", background1: "lt1", text2: "dk2", background2: "lt2", dark1: "dk1", light1: "lt1", dark2: "dk2", light2: "lt2", hyperlink: "hlink", followedHyperlink: "folHlink" };

function rgb(hex: string): [number, number, number] {
  return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
}
function versHex([r, g, b]: [number, number, number]): string {
  return [r, g, b].map((x) => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, "0")).join("").toUpperCase();
}
function versHsl([r, g, b]: [number, number, number]): [number, number, number] {
  const rr = r / 255, gg = g / 255, bb = b / 255;
  const max = Math.max(rr, gg, bb), min = Math.min(rr, gg, bb);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === rr ? (gg - bb) / d + (gg < bb ? 6 : 0) : max === gg ? (bb - rr) / d + 2 : (rr - gg) / d + 4;
  return [h / 6, s, l];
}
function depuisHsl([h, s, l]: [number, number, number]): [number, number, number] {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
}

/** Une couleur DrawingML (`a:srgbClr`, `a:schemeClr`, `a:sysClr`, `a:prstClr`) et ses modificateurs. */
export function couleurDrawing(n: XmlNode | null, theme: Theme): string | null {
  if (!n) return null;
  const c = elements(n).find((e) => /^a:(srgbClr|schemeClr|sysClr|prstClr|scrgbClr)$/.test(e.name));
  if (!c) return null;
  let base: string | null = null;
  if (c.name === "a:srgbClr") base = hex6(attr(c, "val"));
  else if (c.name === "a:sysClr") base = hex6(attr(c, "lastClr")) ?? (attr(c, "val") === "window" ? "FFFFFF" : "000000");
  else if (c.name === "a:schemeClr") {
    const v = attr(c, "val") ?? "";
    base = theme.couleurs.get(ALIAS_THEME[v] ?? v) ?? (v === "bg1" || v === "lt1" ? "FFFFFF" : null);
  } else if (c.name === "a:prstClr") base = COULEURS_NOMMEES[attr(c, "val") ?? ""] ?? null;
  if (!base) return null;
  let col = rgb(base);
  for (const m of elements(c)) {
    const val = (nombre(attr(m, "val")) ?? 100000) / 100000;
    if (m.name === "a:lumMod" || m.name === "a:lumOff") {
      const hsl = versHsl(col);
      hsl[2] = m.name === "a:lumMod" ? hsl[2] * val : hsl[2] + val;
      hsl[2] = Math.max(0, Math.min(1, hsl[2]));
      col = depuisHsl(hsl);
    } else if (m.name === "a:shade") col = col.map((x) => x * val) as [number, number, number];
    else if (m.name === "a:tint") col = col.map((x) => x + (255 - x) * (1 - val)) as [number, number, number];
  }
  return versHex(col);
}

/** `w:color` / `w:shd` : la valeur explicite, sinon la couleur du thème nuancée. */
export function couleurWord(val: string | null, themeColor: string | null, shade: string | null, tint: string | null, theme: Theme): string | null {
  if (val && val !== "auto") {
    const h = hex6(val);
    if (h) return h;
  }
  if (!themeColor) return null;
  const base = theme.couleurs.get(ALIAS_THEME[themeColor] ?? themeColor);
  if (!base) return null;
  let col = rgb(base);
  const s = shade ? parseInt(shade, 16) / 255 : null;
  const t = tint ? parseInt(tint, 16) / 255 : null;
  if (s != null && Number.isFinite(s)) col = col.map((x) => x * s) as [number, number, number];
  if (t != null && Number.isFinite(t)) col = col.map((x) => x + (255 - x) * (1 - t)) as [number, number, number];
  return versHex(col);
}

export const COULEURS_NOMMEES: Record<string, string> = {
  black: "000000", blue: "0000FF", cyan: "00FFFF", green: "00FF00", magenta: "FF00FF", red: "FF0000", yellow: "FFFF00", white: "FFFFFF",
  darkBlue: "000080", darkCyan: "008080", darkGreen: "008000", darkMagenta: "800080", darkRed: "800000", darkYellow: "808000",
  darkGray: "808080", lightGray: "C0C0C0",
};
