/**
 * LIRE UN `.docx` — les unités (twips, EMU) et les petits lecteurs XML partagés par tous les morceaux.
 */
import { type XmlNode, attr, child } from "@/lib/artifact/object-model/xml";

// ─────────────────────────── Unités et petits lecteurs ───────────────────────────

export const TWIP = 20;
export const EMU = 12_700;
export const AUTO_ESPACEMENT = 14;

export const nombre = (v: string | null | undefined): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
export const att = (n: XmlNode | null | undefined, nom: string): string | null => (n ? attr(n, nom) : null);
export const enfant = (n: XmlNode | null | undefined, nom: string): XmlNode | null => (n ? child(n, nom) : null);
export const hex6 = (v: string | null): string | null => (v && /^[0-9A-Fa-f]{6}$/.test(v) ? v.toUpperCase() : null);
export const elements = (n: XmlNode): XmlNode[] => n.children.filter((c) => c.type === "element");

/** Une bascule OOXML (`<w:b/>`, `<w:b w:val="0"/>`) : `undefined` quand l'élément manque. */
export function bascule(n: XmlNode | null): boolean | undefined {
  if (!n) return undefined;
  const v = attr(n, "w:val");
  return !(v === "0" || v === "false" || v === "off");
}

/** Le premier descendant d'un nom donné, sans jamais entrer dans `mc:Fallback`. */
export function premier(n: XmlNode, nom: string): XmlNode | null {
  for (const c of n.children) {
    if (c.type !== "element" || c.name === "mc:Fallback") continue;
    if (c.name === nom) return c;
    const t = premier(c, nom);
    if (t) return t;
  }
  return null;
}
