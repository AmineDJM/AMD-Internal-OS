/**
 * LIRE UN `.docx` — les STYLES (`styles.xml`) : défauts du document, chaîne `basedOn`, styles de
 * tableau et leur mise en forme conditionnelle.
 */
import { type XmlNode, parseXml, children, attr } from "@/lib/artifact/object-model/xml";
import PizZip from "pizzip";
import type { Bordure } from "./modele";
import { enfant, nombre, att, TWIP, premier } from "./unites";
import { type Theme, couleurWord } from "./theme";
import { type PPr, type RPr, lireBordure, lireRPr, lirePPr } from "./proprietes";

// ─────────────────────────── Les styles ───────────────────────────

export interface BordsTableau { haut?: Bordure | null; bas?: Bordure | null; gauche?: Bordure | null; droite?: Bordure | null; interieurH?: Bordure | null; interieurV?: Bordure | null }
export interface MargesCellule { gauche?: number; haut?: number; droite?: number; bas?: number }
export interface Conditionnel { pPr: PPr; rPr: RPr; fond?: string | null; bords: BordsTableau }

interface StyleBrut {
  id: string;
  type: string;
  base: string | null;
  pPr: PPr;
  rPr: RPr;
  bords: BordsTableau;
  marges: MargesCellule;
  conditionnels: Map<string, Conditionnel>;
}

export interface Styles {
  bruts: Map<string, StyleBrut>;
  defautRPr: RPr;
  defautPPr: PPr;
  paragrapheDefaut: string | null;
  tableauDefaut: string | null;
}

export function lireBordsTableau(n: XmlNode | null, theme: Theme): BordsTableau {
  const b: BordsTableau = {};
  if (!n) return b;
  const pose = (cle: keyof BordsTableau, ...noms: string[]) => {
    for (const nom of noms) {
      const v = lireBordure(enfant(n, nom), theme);
      if (v !== undefined) { b[cle] = v; return; }
    }
  };
  pose("haut", "w:top");
  pose("bas", "w:bottom");
  pose("gauche", "w:left", "w:start");
  pose("droite", "w:right", "w:end");
  pose("interieurH", "w:insideH");
  pose("interieurV", "w:insideV");
  return b;
}

export function lireMarges(n: XmlNode | null): MargesCellule {
  const m: MargesCellule = {};
  if (!n) return m;
  const w = (nom: string) => { const e = enfant(n, nom); const v = nombre(att(e, "w:w")); return e && v != null && att(e, "w:type") !== "pct" ? v / TWIP : undefined; };
  const g = w("w:left") ?? w("w:start"), h = w("w:top"), d = w("w:right") ?? w("w:end"), b = w("w:bottom");
  if (g !== undefined) m.gauche = g;
  if (h !== undefined) m.haut = h;
  if (d !== undefined) m.droite = d;
  if (b !== undefined) m.bas = b;
  return m;
}

export function lireStyles(zip: PizZip, theme: Theme): Styles {
  const s: Styles = { bruts: new Map(), defautRPr: {}, defautPPr: {}, paragrapheDefaut: null, tableauDefaut: null };
  const f = zip.file("word/styles.xml");
  if (!f) return s;
  const racine = parseXml(f.asText());
  const styles = premier(racine, "w:styles") ?? racine;
  const defs = enfant(styles, "w:docDefaults");
  s.defautRPr = lireRPr(enfant(enfant(defs, "w:rPrDefault"), "w:rPr"), theme);
  s.defautPPr = lirePPr(enfant(enfant(defs, "w:pPrDefault"), "w:pPr"), theme);
  for (const st of children(styles, "w:style")) {
    const id = attr(st, "w:styleId");
    if (!id) continue;
    const type = attr(st, "w:type") ?? "paragraph";
    const defaut = attr(st, "w:default") === "1" || attr(st, "w:default") === "true";
    if (defaut && type === "paragraph") s.paragrapheDefaut = id;
    if (defaut && type === "table") s.tableauDefaut = id;
    const tblPr = enfant(st, "w:tblPr");
    const conditionnels = new Map<string, Conditionnel>();
    for (const c of children(st, "w:tblStylePr")) {
      const t = attr(c, "w:type");
      if (!t) continue;
      const tcPr = enfant(c, "w:tcPr");
      const shd = enfant(tcPr, "w:shd");
      conditionnels.set(t, {
        pPr: lirePPr(enfant(c, "w:pPr"), theme),
        rPr: lireRPr(enfant(c, "w:rPr"), theme),
        fond: shd ? couleurWord(attr(shd, "w:fill"), attr(shd, "w:themeFill"), attr(shd, "w:themeFillShade"), attr(shd, "w:themeFillTint"), theme) : undefined,
        bords: { ...lireBordsTableau(enfant(enfant(c, "w:tblPr"), "w:tblBorders"), theme), ...lireBordsTableau(enfant(tcPr, "w:tcBorders"), theme) },
      });
    }
    s.bruts.set(id, {
      id,
      type,
      base: att(enfant(st, "w:basedOn"), "w:val"),
      pPr: lirePPr(enfant(st, "w:pPr"), theme),
      rPr: lireRPr(enfant(st, "w:rPr"), theme),
      bords: lireBordsTableau(enfant(tblPr, "w:tblBorders"), theme),
      marges: lireMarges(enfant(tblPr, "w:tblCellMar")),
      conditionnels,
    });
  }
  return s;
}

/** La CHAÎNE d'un style, de la base la plus lointaine au style lui-même (bornée : un cycle ne boucle pas). */
export function chaine(styles: Styles, id: string | null): StyleBrut[] {
  const out: StyleBrut[] = [];
  let cur = id ? styles.bruts.get(id) ?? null : null;
  while (cur && out.length < 20 && !out.includes(cur)) {
    out.unshift(cur);
    cur = cur.base ? styles.bruts.get(cur.base) ?? null : null;
  }
  return out;
}
