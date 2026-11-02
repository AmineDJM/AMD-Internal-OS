/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA MESURE D'UNE CONVERSION (décision 0019) — ce que le banc et les tests comptent, et rien d'autre.
 *
 * Les critères de fin fixés par la Direction :
 *   • taux d'erreur de caractères (CER) ≤ 1 % contre le texte source, après normalisation ;
 *   • 100 % des images conservées (nombre ET dimensions en pixels) ;
 *   • 0 caractère interdit (U+FFFD, mojibake « Ø§Ù„ », formes de présentation arabes, ligatures, contrôles bidi,
 *     zone privée) ;
 *   • direction RTL juste sur 100 % des paragraphes arabes (w:bidi sur le paragraphe, w:rtl sur ses runs arabes) ;
 *   • tableaux reconstruits (lignes × colonnes).
 *
 * Pur (octets → chiffres) : utilisé par `scripts/bench/conversions.ts` et par les tests.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import PizZip from "pizzip";
import { lireImage } from "@/lib/artifact/object-model/image";
import { attr, children, descendants, parseXml, unescapeXml, type XmlNode } from "@/lib/artifact/object-model/xml";

// ─────────────────────────── Texte ───────────────────────────

const ARABE = /[؀-ۿݐ-ݿࢠ-ࣿ]/;
const LATIN = /[A-Za-zÀ-ɏ]/;

export function estArabe(t: string): boolean {
  let r = 0;
  let l = 0;
  for (const c of t) {
    if (ARABE.test(c)) r += 1;
    else if (LATIN.test(c)) l += 1;
  }
  return r > l;
}

/** Les caractères qu'aucun document converti ne doit porter — avec leur nom, pour le dire. */
export function caracteresInterdits(t: string): { car: string; code: string; motif: string }[] {
  const out: { car: string; code: string; motif: string }[] = [];
  const code = (c: string) => `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;
  for (const c of t) {
    const o = c.codePointAt(0)!;
    let motif: string | null = null;
    if (o === 0xfffd) motif = "caractère de remplacement";
    else if ((o >= 0xfb50 && o <= 0xfdff) || (o >= 0xfe70 && o <= 0xfeff)) motif = "forme de présentation arabe (ou BOM)";
    else if (o >= 0xfb00 && o <= 0xfb06) motif = "ligature latine";
    else if (o >= 0xe000 && o <= 0xf8ff) motif = "zone privée (glyphe sans Unicode)";
    else if ([0x200e, 0x200f, 0x061c].includes(o) || (o >= 0x202a && o <= 0x202e) || (o >= 0x2066 && o <= 0x2069)) motif = "contrôle bidi parasite";
    else if (o === 0x200b || o === 0x00ad) motif = "invisible parasite";
    if (motif) out.push({ car: c, code: code(c), motif });
  }
  // Mojibake : de l'UTF-8 relu en Windows-1252 (« Ø§Ù„ », « Ã© »).
  for (const m of t.matchAll(/(?:[Â-ß][\u0080-¿‘-›€ŒœŠšŸŽžƒˆ˜]){2,}/g)) {
    out.push({ car: m[0], code: "mojibake", motif: "UTF-8 relu en Windows-1252" });
  }
  return out;
}

/** La normalisation de comparaison : NFC, puces retirées, blancs ramenés à une espace. */
export function normaliserPourComparer(t: string): string {
  return t.normalize("NFC").replace(/[•▪◦○■□◆❖➢✓·]/g, " ").replace(/[‎‏؜‪-‮⁦-⁩]/g, "")
    .replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim();
}

/** Distance d'édition (Levenshtein), en points de code. */
export function distance(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  if (!x.length) return y.length;
  if (!y.length) return x.length;
  let prec = Array.from({ length: y.length + 1 }, (_, j) => j);
  let cour = new Array<number>(y.length + 1);
  for (let i = 1; i <= x.length; i++) {
    cour[0] = i;
    for (let j = 1; j <= y.length; j++) {
      cour[j] = Math.min(prec[j]! + 1, cour[j - 1]! + 1, prec[j - 1]! + (x[i - 1] === y[j - 1] ? 0 : 1));
    }
    [prec, cour] = [cour, prec];
  }
  return prec[y.length]!;
}

/** Taux d'erreur de caractères du texte obtenu contre la référence (normalisés tous deux). */
export function tauxErreurCaracteres(reference: string, obtenu: string): number {
  const r = normaliserPourComparer(reference);
  const o = normaliserPourComparer(obtenu);
  return r.length ? distance(r, o) / [...r].length : o.length ? 1 : 0;
}

// ─────────────────────────── Le Word ───────────────────────────

export interface ParagrapheLu {
  texte: string;
  zone: "entete" | "corps" | "cellule" | "pied";
  bidi: boolean;
  /** Runs portant des lettres arabes SANS w:rtl : la direction du texte serait fausse dans Word. */
  runsArabesSansRtl: number;
  /** Runs arabes sans police de script complexe (w:cs). */
  runsArabesSansCs: number;
}

export interface AnalyseDocx {
  paragraphes: ParagrapheLu[];
  /** Le texte dans l'ordre de lecture : en-têtes, corps (cellules comprises, ligne par ligne), pieds. */
  texte: string;
  images: { largeur: number; hauteur: number }[];
  tableaux: { lignes: number; colonnes: number }[];
}

function texteDuParagraphe(p: XmlNode): string {
  let t = "";
  const parcourir = (n: XmlNode) => {
    for (const c of n.children) {
      if (c.type !== "element") continue;
      if (c.name === "w:t") t += unescapeXml(c.children.map((x) => x.text).join(""));
      else if (c.name === "w:tab") t += "\t";
      else if (c.name === "w:br") t += "\n";
      else if (c.name !== "w:pPr" && c.name !== "w:rPr" && c.name !== "w:instrText") parcourir(c);
    }
  };
  parcourir(p);
  return t;
}

function lireParagraphe(p: XmlNode, zone: ParagrapheLu["zone"]): ParagrapheLu {
  const ppr = children(p, "w:pPr")[0];
  const bidiEl = ppr ? children(ppr, "w:bidi")[0] : undefined;
  const bidi = Boolean(bidiEl) && !["0", "false"].includes(attr(bidiEl!, "w:val") ?? "");
  let sansRtl = 0;
  let sansCs = 0;
  for (const r of descendants(p, "w:r")) {
    const t = descendants(r, "w:t").map((x) => unescapeXml(x.children.map((c) => c.text).join(""))).join("");
    if (!ARABE.test(t)) continue;
    const rpr = children(r, "w:rPr")[0];
    if (!rpr || !children(rpr, "w:rtl").length) sansRtl += 1;
    const fonts = rpr ? children(rpr, "w:rFonts")[0] : undefined;
    if (!fonts || !attr(fonts, "w:cs")) sansCs += 1;
  }
  return { texte: texteDuParagraphe(p), zone, bidi, runsArabesSansRtl: sansRtl, runsArabesSansCs: sansCs };
}

function parcourirCorps(racine: XmlNode, zone: "entete" | "corps" | "pied", out: ParagrapheLu[], tableaux: AnalyseDocx["tableaux"]): string[] {
  const lignes: string[] = [];
  const visiter = (n: XmlNode, dansCellule: boolean) => {
    for (const c of n.children) {
      if (c.type !== "element") continue;
      if (c.name === "w:p") {
        const p = lireParagraphe(c, dansCellule ? "cellule" : zone);
        out.push(p);
        lignes.push(p.texte);
      } else if (c.name === "w:tbl") {
        const rangs = children(c, "w:tr");
        tableaux.push({ lignes: rangs.length, colonnes: Math.max(0, ...rangs.map((r) => children(r, "w:tc").length)) });
        for (const r of rangs) for (const tc of children(r, "w:tc")) visiter(tc, true);
      } else if (c.name !== "w:sectPr" && c.name !== "w:pPr") {
        visiter(c, dansCellule);
      }
    }
  };
  visiter(racine, false);
  return lignes;
}

export function analyserDocx(octets: Buffer): AnalyseDocx {
  const zip = new PizZip(octets);
  const lire = (nom: string) => zip.file(nom)?.asText() ?? null;
  const doc = parseXml(lire("word/document.xml") ?? "<w:document/>");
  const rels = parseXml(lire("word/_rels/document.xml.rels") ?? "<Relationships/>");
  const cible = new Map<string, string>();
  for (const r of descendants(rels, "Relationship")) cible.set(attr(r, "Id") ?? "", attr(r, "Target") ?? "");
  const paragraphes: ParagrapheLu[] = [];
  const tableaux: AnalyseDocx["tableaux"] = [];
  // En-têtes et pieds RÉFÉRENCÉS par les sections (une fois chacun), dans l'ordre : par défaut d'abord.
  const parties = (genre: "headerReference" | "footerReference") => {
    const vus = new Set<string>();
    for (const ref of descendants(doc, `w:${genre}`)) {
      const t = cible.get(attr(ref, "r:id") ?? "");
      if (t && !vus.has(t)) vus.add(t);
    }
    return [...vus].map((t) => `word/${t.replace(/^\/?word\//, "")}`);
  };
  const corps = descendants(doc, "w:body")[0];
  const texte: string[] = [];
  for (const nom of parties("headerReference")) {
    const x = lire(nom);
    if (x) texte.push(...parcourirCorps(parseXml(x), "entete", paragraphes, []));
  }
  if (corps) texte.push(...parcourirCorps(corps, "corps", paragraphes, tableaux));
  for (const nom of parties("footerReference")) {
    const x = lire(nom);
    if (x) texte.push(...parcourirCorps(parseXml(x), "pied", paragraphes, []));
  }
  // Les images DESSINÉES (a:blip r:embed), corps et en-têtes, chacune une fois par apparition.
  const images: AnalyseDocx["images"] = [];
  for (const blip of descendants(doc, "a:blip")) {
    const t = cible.get(attr(blip, "r:embed") ?? "");
    const f = t ? zip.file(`word/${t.replace(/^\/?word\//, "")}`) : null;
    const lue = f ? lireImage(Buffer.from(f.asUint8Array())) : null;
    if (lue) images.push({ largeur: lue.largeurPx, hauteur: lue.hauteurPx });
  }
  return { paragraphes, texte: texte.filter((l) => l.trim()).join("\n"), images, tableaux };
}

// ─────────────────────────── Le verdict ───────────────────────────

export interface Attendu {
  texte: string[];
  arabes: string[];
  tableaux: [number, number][];
  images: [number, number][];
  scan?: boolean;
}

export interface Mesure {
  cer: number;
  interdits: { car: string; code: string; motif: string }[];
  images: { attendues: number; trouvees: number; dimensionsJustes: number };
  rtl: { paragraphesArabes: number; justes: number; fautes: string[] };
  tableaux: { attendus: string[]; trouves: string[]; justes: number };
}

/** Compare une analyse à ce que le corpus attend. Les images d'un scan ne se comptent pas (la page entière en est une). */
export function mesurer(a: AnalyseDocx, att: Attendu): Mesure {
  const reference = att.texte.join("\n");
  const cer = tauxErreurCaracteres(reference, a.texte);
  const interdits = caracteresInterdits(a.paragraphes.map((p) => p.texte).join("\n"));
  const restantes = [...a.images];
  let dims = 0;
  for (const [w, h] of att.images) {
    const i = restantes.findIndex((x) => x.largeur === w && x.hauteur === h);
    if (i >= 0) {
      dims += 1;
      restantes.splice(i, 1);
    }
  }
  const arabes = a.paragraphes.filter((p) => p.texte.trim() && estArabe(p.texte));
  const fautes = arabes.filter((p) => !p.bidi || p.runsArabesSansRtl > 0 || p.runsArabesSansCs > 0);
  const attendus = att.tableaux.map(([l, c]) => `${l}×${c}`);
  const trouves = a.tableaux.map((t) => `${t.lignes}×${t.colonnes}`);
  const reste = [...trouves];
  let tJustes = 0;
  for (const t of attendus) {
    const i = reste.indexOf(t);
    if (i >= 0) {
      tJustes += 1;
      reste.splice(i, 1);
    }
  }
  return {
    cer,
    interdits,
    images: { attendues: att.images.length, trouvees: a.images.length, dimensionsJustes: dims },
    rtl: { paragraphesArabes: arabes.length, justes: arabes.length - fautes.length, fautes: fautes.map((p) => p.texte.slice(0, 60)) },
    tableaux: { attendus, trouves, justes: tJustes },
  };
}
