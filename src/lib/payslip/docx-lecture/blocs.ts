/**
 * LIRE UN `.docx` — les BLOCS : tableaux (grille, fusions, bordures conditionnelles, cellules qui
 * contiennent à leur tour des blocs), conteneurs (`lireBlocs`) et bandes d'en-tête / de pied.
 */
import { type XmlNode, children, attr, child, parseXml } from "@/lib/artifact/object-model/xml";
import type { Tableau, Rangee, Cellule, Bordure, Bloc, Bande } from "./modele";
import { enfant, att, TWIP, nombre, bascule, elements, premier } from "./unites";
import { couleurWord } from "./theme";
import { fusionPPr, fusionRPr } from "./proprietes";
import { chaine, type BordsTableau, type MargesCellule, type Conditionnel, lireBordsTableau, lireMarges } from "./styles";
import { type Ctx, lireRels } from "./contexte";
import { lireParagraphe } from "./paragraphes";

// ─────────────────────────── Tableaux ───────────────────────────

const CONDITIONS = ["wholeTable", "band1Vert", "band2Vert", "band1Horz", "band2Horz", "firstCol", "lastCol", "firstRow", "lastRow", "neCell", "nwCell", "seCell", "swCell"] as const;

function lireTableau(tbl: XmlNode, ctx: Ctx): Tableau {
  const tblPr = enfant(tbl, "w:tblPr");
  const styleId = att(enfant(tblPr, "w:tblStyle"), "w:val") ?? ctx.styles.tableauDefaut;
  const ch = chaine(ctx.styles, styleId);
  const bordsStyle: BordsTableau = Object.assign({}, ...ch.map((s) => s.bords));
  const margesStyle: MargesCellule = Object.assign({}, ...ch.map((s) => s.marges));
  const conditionnels = new Map<string, Conditionnel>();
  for (const s of ch) for (const [k, v] of s.conditionnels) {
    const avant = conditionnels.get(k);
    conditionnels.set(k, avant ? { pPr: fusionPPr(avant.pPr, v.pPr), rPr: fusionRPr(avant.rPr, v.rPr), fond: v.fond !== undefined ? v.fond : avant.fond, bords: { ...avant.bords, ...v.bords } } : v);
  }
  const pStyleTable = fusionPPr(...ch.map((s) => s.pPr));
  const rStyleTable = fusionRPr(...ch.map((s) => s.rPr));
  const bords: BordsTableau = { ...bordsStyle, ...lireBordsTableau(enfant(tblPr, "w:tblBorders"), ctx.theme) };
  const marges = { gauche: 108 / TWIP, haut: 0, droite: 108 / TWIP, bas: 0, ...margesStyle, ...lireMarges(enfant(tblPr, "w:tblCellMar")) };
  const look = enfant(tblPr, "w:tblLook");
  const masqueLook = parseInt(att(look, "w:val") ?? "04A0", 16);
  const drapeau = (nom: string, bit: number) => { const v = att(look, nom); return v != null ? v === "1" || v === "true" : (masqueLook & bit) !== 0; };
  const lk = { firstRow: drapeau("w:firstRow", 0x20), lastRow: drapeau("w:lastRow", 0x40), firstCol: drapeau("w:firstColumn", 0x80), lastCol: drapeau("w:lastColumn", 0x100), noH: drapeau("w:noHBand", 0x200), noV: drapeau("w:noVBand", 0x400) };
  const jc = att(enfant(tblPr, "w:jc"), "w:val");
  const ind = enfant(tblPr, "w:tblInd");
  const retrait = att(ind, "w:type") === "pct" ? 0 : (nombre(att(ind, "w:w")) ?? 0) / TWIP;
  let grille = children(enfant(tbl, "w:tblGrid") ?? tbl, "w:gridCol").map((g) => (nombre(attr(g, "w:w")) ?? 0) / TWIP);

  const trs = children(tbl, "w:tr");
  const nbLignes = trs.length;
  const rangees: Rangee[] = [];
  let enTete = true;
  trs.forEach((tr, r) => {
    const trPr = enfant(tr, "w:trPr");
    const estEntete = enTete && bascule(enfant(trPr, "w:tblHeader")) === true;
    if (!estEntete) enTete = false;
    const trH = enfant(trPr, "w:trHeight");
    const hv = nombre(att(trH, "w:val"));
    const hauteur = hv && hv > 0 ? { valeur: hv / TWIP, regle: att(trH, "w:hRule") === "exact" ? "exact" as const : "atLeast" as const } : null;
    let col = nombre(att(enfant(trPr, "w:gridBefore"), "w:val")) ?? 0;
    const tcs = children(tr, "w:tc");
    const cellules: Cellule[] = [];
    const nbCols = Math.max(grille.length, tcs.reduce((s, tc) => s + (nombre(att(enfant(enfant(tc, "w:tcPr"), "w:gridSpan"), "w:val")) ?? 1), col));
    tcs.forEach((tc, ci) => {
      const tcPr = enfant(tc, "w:tcPr");
      const span = Math.max(1, nombre(att(enfant(tcPr, "w:gridSpan"), "w:val")) ?? 1);
      const vm = enfant(tcPr, "w:vMerge");
      const fusionV = vm ? (attr(vm, "w:val") === "restart" ? "debut" : "suite") : null;
      // Les conditions qui s'appliquent à CETTE cellule, de la plus faible à la plus forte.
      const bandeIndex = r - rangees.filter((x) => x.entete).length - (lk.firstRow && !rangees.some((x) => x.entete) && r > 0 ? 1 : 0);
      const conds: string[] = ["wholeTable"];
      if (!lk.noH && !(lk.firstRow && r === 0) && !(lk.lastRow && r === nbLignes - 1)) conds.push(bandeIndex % 2 === 0 ? "band1Horz" : "band2Horz");
      if (!lk.noV) conds.push(ci % 2 === 0 ? "band1Vert" : "band2Vert");
      if (lk.firstCol && col === 0) conds.push("firstCol");
      if (lk.lastCol && col + span >= nbCols) conds.push("lastCol");
      if (lk.firstRow && (r === 0 || estEntete)) conds.push("firstRow");
      if (lk.lastRow && r === nbLignes - 1) conds.push("lastRow");
      const actifs = CONDITIONS.filter((c) => conds.includes(c)).map((c) => conditionnels.get(c)).filter((c): c is Conditionnel => !!c);
      const ctxCellule: Ctx = { ...ctx, tableau: { pPr: fusionPPr(pStyleTable, ...actifs.map((a) => a.pPr)), rPr: fusionRPr(rStyleTable, ...actifs.map((a) => a.rPr)) } };
      const blocs = lireBlocs(tc, ctxCellule);
      const shd = enfant(tcPr, "w:shd");
      const fondDirect = shd ? couleurWord(attr(shd, "w:fill"), attr(shd, "w:themeFill"), attr(shd, "w:themeFillShade"), attr(shd, "w:themeFillTint"), ctx.theme) : undefined;
      let fond: string | null = null;
      for (const a of actifs) if (a.fond !== undefined) fond = a.fond;
      if (fondDirect) fond = fondDirect;
      // Les bordures : la cellule d'abord, puis le style conditionnel, puis le tableau selon la position.
      const tcB = lireBordsTableau(enfant(tcPr, "w:tcBorders"), ctx.theme);
      const condB: BordsTableau = Object.assign({}, ...actifs.map((a) => a.bords));
      const premiereL = r === 0, derniereL = r === nbLignes - 1, premiereC = col === 0, derniereC = col + span >= nbCols;
      const choisir = (cell: Bordure | null | undefined, cond: Bordure | null | undefined, ext: keyof BordsTableau, int: keyof BordsTableau, estBord: boolean): Bordure | null => {
        if (cell !== undefined) return cell;
        const condV = estBord ? cond ?? condB[ext] : cond ?? condB[int];
        if (condV !== undefined) return condV;
        const v = estBord ? bords[ext] : bords[int];
        return v ?? null;
      };
      const tcMar = lireMarges(enfant(tcPr, "w:tcMar"));
      const va = att(enfant(tcPr, "w:vAlign"), "w:val");
      cellules.push({
        blocs,
        colonne: col,
        span,
        fusionV,
        fond,
        bordures: {
          haut: choisir(tcB.haut, condB.haut, "haut", "interieurH", premiereL),
          bas: choisir(tcB.bas, condB.bas, "bas", "interieurH", derniereL),
          gauche: choisir(tcB.gauche, condB.gauche, "gauche", "interieurV", premiereC),
          droite: choisir(tcB.droite, condB.droite, "droite", "interieurV", derniereC),
        },
        alignV: va === "center" ? "centre" : va === "bottom" ? "bas" : "haut",
        marges: { ...marges, ...tcMar },
      });
      col += span;
    });
    rangees.push({ cellules, hauteur, entete: estEntete });
  });

  // Sans grille utilisable, la largeur déclarée des cellules de la première ligne.
  const nbCols = Math.max(0, ...rangees.map((rg) => rg.cellules.reduce((m, c) => Math.max(m, c.colonne + c.span), 0)));
  if (grille.length < nbCols || grille.every((w) => w <= 0)) {
    const premiere = trs[0];
    const largeurs: number[] = [];
    if (premiere) for (const tc of children(premiere, "w:tc")) {
      const tcW = enfant(enfant(tc, "w:tcPr"), "w:tcW");
      const w = att(tcW, "w:type") === "dxa" || att(tcW, "w:type") == null ? (nombre(att(tcW, "w:w")) ?? 0) / TWIP : 0;
      const span = Math.max(1, nombre(att(enfant(enfant(tc, "w:tcPr"), "w:gridSpan"), "w:val")) ?? 1);
      for (let i = 0; i < span; i++) largeurs.push(w / span);
    }
    grille = largeurs.length >= nbCols && largeurs.every((w) => w > 0) ? largeurs : [];
  }
  return { type: "tableau", grille, alignement: jc === "center" ? "center" : jc === "right" || jc === "end" ? "right" : "left", retrait, rangees };
}

// ─────────────────────────── Conteneurs, bandes, sections ───────────────────────────

/**
 * Les blocs d'un conteneur, dans l'ordre. `fins` (corps du document seulement) note les paragraphes
 * qui portent un `sectPr` : chacun FERME sa section.
 */
export function lireBlocs(conteneur: XmlNode, ctx: Ctx, fins?: Map<Bloc, XmlNode>): Bloc[] {
  const blocs: Bloc[] = [];
  for (const n of elements(conteneur)) {
    if (n.name === "w:p") {
      const p = lireParagraphe(n, ctx);
      blocs.push(p);
      const sp = enfant(enfant(n, "w:pPr"), "w:sectPr");
      if (sp && fins) fins.set(p, sp);
    } else if (n.name === "w:tbl") blocs.push(lireTableau(n, ctx));
    else if (n.name === "w:sdt") {
      const c = child(n, "w:sdtContent");
      if (c) blocs.push(...lireBlocs(c, ctx, fins));
    } else if (n.name === "w:customXml" || n.name === "w:ins" || n.name === "w:moveTo") blocs.push(...lireBlocs(n, ctx, fins));
    else if (n.name === "mc:AlternateContent") {
      const c = child(n, "mc:Choice") ?? child(n, "mc:Fallback");
      if (c) blocs.push(...lireBlocs(c, ctx, fins));
    }
  }
  return blocs;
}

export function lireBande(ctx: Ctx, rid: string | null): Bande | null {
  const rel = rid ? ctx.rels.get(rid) : undefined;
  if (!rel || rel.externe) return null;
  const f = ctx.zip.file(rel.cible);
  if (!f) return null;
  const racine = parseXml(f.asText());
  const conteneur = premier(racine, "w:hdr") ?? premier(racine, "w:ftr") ?? racine;
  const sous: Ctx = { ...ctx, rels: lireRels(ctx.zip, rel.cible), tableau: null };
  return { blocs: lireBlocs(conteneur, sous) };
}
