/**
 * LIRE UN `.docx` — les LISTES (`numbering.xml`) : niveaux, formats de numéro, puces.
 */
import { type XmlNode, attr, parseXml, children } from "@/lib/artifact/object-model/xml";
import PizZip from "pizzip";
import type { Etiquette } from "./modele";
import { enfant, att, nombre, premier } from "./unites";
import type { Theme } from "./theme";
import { type PPr, type RPr, lirePPr, lireRPr } from "./proprietes";

// ─────────────────────────── Les listes ───────────────────────────

interface Niveau { debut: number; format: string; texte: string; suffixe: Etiquette["suffixe"]; pPr: PPr; rPr: RPr; policeSymbole: string | null }
export interface Numerotation {
  abstraits: Map<string, Map<number, Niveau>>;
  nums: Map<string, { abstrait: string; surcharges: Map<number, { debut?: number; niveau?: Niveau }> }>;
  compteurs: Map<string, (number | undefined)[]>;
  dejaVus: Set<string>;
}

function lireNiveau(lvl: XmlNode, theme: Theme): Niveau {
  const rPrN = enfant(lvl, "w:rPr");
  const polices = enfant(rPrN, "w:rFonts");
  const suff = att(enfant(lvl, "w:suff"), "w:val");
  return {
    debut: nombre(att(enfant(lvl, "w:start"), "w:val")) ?? 1,
    format: att(enfant(lvl, "w:numFmt"), "w:val") ?? "decimal",
    texte: att(enfant(lvl, "w:lvlText"), "w:val") ?? "",
    suffixe: suff === "space" ? "space" : suff === "nothing" ? "nothing" : "tab",
    pPr: lirePPr(enfant(lvl, "w:pPr"), theme),
    rPr: lireRPr(rPrN, theme),
    policeSymbole: polices ? attr(polices, "w:ascii") ?? attr(polices, "w:hAnsi") : null,
  };
}

export function lireNumerotation(zip: PizZip, theme: Theme): Numerotation {
  const n: Numerotation = { abstraits: new Map(), nums: new Map(), compteurs: new Map(), dejaVus: new Set() };
  const f = zip.file("word/numbering.xml");
  if (!f) return n;
  const racine = premier(parseXml(f.asText()), "w:numbering");
  if (!racine) return n;
  for (const a of children(racine, "w:abstractNum")) {
    const id = attr(a, "w:abstractNumId");
    if (id == null) continue;
    const niveaux = new Map<number, Niveau>();
    for (const lvl of children(a, "w:lvl")) niveaux.set(nombre(attr(lvl, "w:ilvl")) ?? 0, lireNiveau(lvl, theme));
    n.abstraits.set(id, niveaux);
  }
  for (const num of children(racine, "w:num")) {
    const id = attr(num, "w:numId");
    const abs = att(enfant(num, "w:abstractNumId"), "w:val");
    if (id == null || abs == null) continue;
    const surcharges = new Map<number, { debut?: number; niveau?: Niveau }>();
    for (const o of children(num, "w:lvlOverride")) {
      const ilvl = nombre(attr(o, "w:ilvl")) ?? 0;
      const debut = nombre(att(enfant(o, "w:startOverride"), "w:val"));
      const lvl = enfant(o, "w:lvl");
      surcharges.set(ilvl, { debut: debut ?? undefined, niveau: lvl ? lireNiveau(lvl, theme) : undefined });
    }
    n.nums.set(id, { abstrait: abs, surcharges });
  }
  return n;
}

export function niveauDe(num: Numerotation, numId: string, ilvl: number): Niveau | null {
  const def = num.nums.get(numId);
  if (!def) return null;
  return def.surcharges.get(ilvl)?.niveau ?? num.abstraits.get(def.abstrait)?.get(ilvl) ?? null;
}

const ROMAINS: [number, string][] = [[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"], [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]];
export function romain(n: number): string {
  let out = "";
  let r = Math.max(1, Math.floor(n));
  for (const [v, s] of ROMAINS) while (r >= v) { out += s; r -= v; }
  return out;
}
function lettres(n: number): string {
  const k = Math.max(1, n);
  const l = String.fromCharCode(97 + ((k - 1) % 26));
  return l.repeat(Math.floor((k - 1) / 26) + 1);
}
export function formaterNombre(n: number, format: string): string {
  switch (format) {
    case "lowerRoman": return romain(n);
    case "upperRoman": return romain(n).toUpperCase();
    case "lowerLetter": return lettres(n);
    case "upperLetter": return lettres(n).toUpperCase();
    case "decimalZero": return n < 10 ? `0${n}` : String(n);
    case "none": return "";
    case "ordinal": return n === 1 ? "1er" : `${n}e`;
    default: return String(n);
  }
}

/** Le caractère de puce, ramené à une forme qu'on DESSINE (les polices Symbol/Wingdings ne sont pas embarquées). */
export function puceDe(texte: string, police: string | null): Etiquette["puce"] | "texte" {
  const c = texte.codePointAt(0) ?? 0;
  const p = (police ?? "").toLowerCase();
  if (texte === "o" && /courier/.test(p)) return "cercle";
  if (c === 0xf0a7 || (p.includes("wingdings") && c === 0xa7) || c === 0x25aa || c === 0x25a0) return "carre";
  if (c === 0xf076 || c === 0x2756) return "losange";
  if (c === 0xf0d8 || c === 0xf0e0 || c === 0xf0e8 || c === 0x27a2 || c === 0x25ba) return "fleche";
  if (c === 0xf0b7 || c === 0x2022 || c === 0xb7 || c === 0x25cf || (c >= 0xf000 && c <= 0xf0ff) || p.includes("symbol") || p.includes("wingdings")) return "disque";
  if (c === 0x25cb || c === 0x25e6) return "cercle";
  return "texte";
}
