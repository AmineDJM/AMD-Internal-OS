/**
 * LIRE UN `.docx` — les SECTIONS (format, marges, en-têtes et pieds) et l'entrée `lireDocx` : des
 * octets au modèle complet.
 */
import { type XmlNode, children, attr, parseXml, child } from "@/lib/artifact/object-model/xml";
import PizZip from "pizzip";
import type { Section, DocumentDocx, Bloc } from "./modele";
import { TWIP, enfant, nombre, att, bascule, premier } from "./unites";
import { lireTheme } from "./theme";
import { lireStyles } from "./styles";
import { lireNumerotation } from "./listes";
import { type Ctx, lireRels } from "./contexte";
import { lireBande, lireBlocs } from "./blocs";

const A4 = { largeur: 11906 / TWIP, hauteur: 16838 / TWIP };

function lireSection(sectPr: XmlNode | null, ctx: Ctx, precedente: Section | null): Section {
  const pgSz = enfant(sectPr, "w:pgSz");
  const pgMar = enfant(sectPr, "w:pgMar");
  let largeur = (nombre(att(pgSz, "w:w")) ?? 0) / TWIP || precedente?.largeur || A4.largeur;
  let hauteur = (nombre(att(pgSz, "w:h")) ?? 0) / TWIP || precedente?.hauteur || A4.hauteur;
  if (att(pgSz, "w:orient") === "landscape" && largeur < hauteur) [largeur, hauteur] = [hauteur, largeur];
  const m = (nom: string, defaut: number) => { const v = nombre(att(pgMar, nom)); return v == null ? defaut : v / TWIP; };
  const pm = precedente?.marges;
  const haut = m("w:top", pm?.haut ?? 72);
  const bas = m("w:bottom", pm?.bas ?? 72);
  const gouttiere = m("w:gutter", 0);
  const borne = (v: number, max: number, defaut: number) => (Number.isFinite(v) && Math.abs(v) < max ? v : defaut);
  const marges = {
    haut: borne(Math.abs(haut), hauteur / 2, 72),
    bas: borne(Math.abs(bas), hauteur / 2, 72),
    gauche: borne(m("w:left", pm?.gauche ?? 72) + gouttiere, largeur / 2, 72),
    droite: borne(m("w:right", pm?.droite ?? 72), largeur / 2, 72),
    entete: borne(m("w:header", pm?.entete ?? 35.4), hauteur / 2, 35.4),
    pied: borne(m("w:footer", pm?.pied ?? 35.4), hauteur / 2, 35.4),
  };
  const bandes = (genre: "header" | "footer"): Section["entetes"] => {
    const out: Section["entetes"] = {};
    for (const ref of sectPr ? children(sectPr, `w:${genre}Reference`) : []) {
      const t = attr(ref, "w:type") ?? "default";
      const b = lireBande(ctx, attr(ref, "r:id"));
      if (t === "first") out.premiere = b;
      else if (t === "even") out.paire = b;
      else out.defaut = b;
    }
    // Une section sans référence HÉRITE des bandes de la précédente (règle Word).
    const prec = genre === "header" ? precedente?.entetes : precedente?.pieds;
    return { defaut: out.defaut !== undefined ? out.defaut : prec?.defaut, premiere: out.premiere !== undefined ? out.premiere : prec?.premiere, paire: out.paire !== undefined ? out.paire : prec?.paire };
  };
  const type = att(enfant(sectPr, "w:type"), "w:val");
  const pgNum = enfant(sectPr, "w:pgNumType");
  return {
    largeur, hauteur, marges,
    hautExact: haut < 0,
    basExact: bas < 0,
    entetes: bandes("header"),
    pieds: bandes("footer"),
    titrePage: bascule(enfant(sectPr, "w:titlePg")) === true,
    type: type === "continuous" ? "continuous" : type === "evenPage" ? "evenPage" : type === "oddPage" ? "oddPage" : "nextPage",
    debutNumero: nombre(att(pgNum, "w:start")),
    formatNumero: att(pgNum, "w:fmt") ?? "decimal",
    colonnes: Math.max(1, nombre(att(enfant(sectPr, "w:cols"), "w:num")) ?? 1),
  };
}

/**
 * LE DOCUMENT, SECTION PAR SECTION.
 *
 * Lève si le fichier n'est pas un `.docx` lisible : l'appelant garde alors l'original.
 */
export function lireDocx(octets: Buffer | Uint8Array): DocumentDocx {
  const zip = new PizZip(octets);
  const entree = zip.file("word/document.xml");
  if (!entree) throw new Error("Ce fichier ne contient pas de document Word (word/document.xml absent).");
  const racine = parseXml(entree.asText());
  const body = premier(racine, "w:body");
  if (!body) throw new Error("Document Word sans corps (w:body absent).");
  const theme = lireTheme(zip);
  const ctx: Ctx = {
    zip, rels: lireRels(zip, "word/document.xml"), styles: lireStyles(zip, theme), theme,
    num: lireNumerotation(zip, theme), images: new Map(), ignores: new Set(), tableau: null,
  };
  const reglages = zip.file("word/settings.xml");
  const xmlReglages = reglages ? parseXml(reglages.asText()) : null;
  const tab = xmlReglages ? nombre(att(premier(xmlReglages, "w:defaultTabStop"), "w:val")) : null;
  const pairesImpaires = xmlReglages ? bascule(premier(xmlReglages, "w:evenAndOddHeaders")) === true : false;

  // Les sections se TERMINENT par leur `sectPr` : on accumule les blocs, et chaque `sectPr` de
  // paragraphe ferme la section en cours avec les blocs lus jusque-là.
  const sections: DocumentDocx["sections"] = [];
  let courant: Bloc[] = [];
  let precedente: Section | null = null;
  const fins = new Map<Bloc, XmlNode>();
  for (const b of lireBlocs(body, ctx, fins)) {
    courant.push(b);
    const sp = fins.get(b);
    if (sp) {
      const s = lireSection(sp, ctx, precedente);
      sections.push({ section: s, blocs: courant });
      precedente = s;
      courant = [];
    }
  }
  const finale = lireSection(child(body, "w:sectPr"), ctx, precedente);
  if (courant.length > 0 || sections.length === 0) sections.push({ section: finale, blocs: courant });
  return { sections, tabDefaut: tab && tab > 0 ? tab / TWIP : 36, pairesImpaires, ignores: ctx.ignores };
}
