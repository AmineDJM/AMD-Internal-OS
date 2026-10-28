/**
 * L'ADAPTATEUR WORD — la LECTURE du modèle : paragraphes de corps numérotés à l'humaine (hors
 * tableaux), styles de fragment, images, tableaux, titres et pages estimées.
 */
import PizZip from "pizzip";
import { type Alignment, type DocxModel, type ImageNode, type OutlineEntry, type ParagraphNode, type RunNode, type TableNode, type TextStyle, STYLE_NEUTRE, demiPtEnPt, emuEnCm, twipEnCm } from "@/lib/artifact/object-model/model";
import { abreger } from "@/lib/artifact/object-model/text";
import { type XmlNode, attr, child, children, descendants, firstDescendant, textOf } from "@/lib/artifact/object-model/xml";

const ALIGN_MODELE: Record<string, Alignment> = { left: "left", start: "left", center: "center", right: "right", end: "right", both: "justify", distribute: "justify" };

// ─────────────────────────── Lecture du modèle ───────────────────────────

/** Le `w:rPr` d'un fragment, traduit en unités humaines. */
function lireStyleRun(run: XmlNode): TextStyle {
  const rPr = child(run, "w:rPr");
  if (!rPr) return { ...STYLE_NEUTRE };
  const onOff = (nom: string): boolean => {
    const el = child(rPr, nom);
    if (!el) return false;
    const v = attr(el, "w:val");
    // OOXML : la balise SEULE vaut « vrai » ; `w:val="0"` et `"false"` valent faux.
    return v === null || !["0", "false", "off"].includes(v);
  };
  const sz = child(rPr, "w:sz");
  const szVal = sz ? Number(attr(sz, "w:val")) : NaN;
  const fonts = child(rPr, "w:rFonts");
  const color = child(rPr, "w:color");
  const colorVal = color ? attr(color, "w:val") : null;
  return {
    bold: onOff("w:b"),
    italic: onOff("w:i"),
    underline: Boolean(child(rPr, "w:u")),
    sizePt: Number.isFinite(szVal) && szVal > 0 ? demiPtEnPt(szVal) : null,
    font: fonts ? attr(fonts, "w:ascii") ?? attr(fonts, "w:hAnsi") ?? attr(fonts, "w:cs") : null,
    color: colorVal && colorVal !== "auto" ? colorVal.toUpperCase() : null,
  };
}

function lireImages(p: XmlNode, depart: number): { images: ImageNode[]; noeuds: XmlNode[] } {
  const images: ImageNode[] = [];
  const noeuds: XmlNode[] = [];
  // `wp:inline` (dans le fil du texte) et `wp:anchor` (flottante) portent tous deux `wp:extent`.
  for (const balise of ["wp:inline", "wp:anchor"]) {
    for (const el of descendants(p, balise)) {
      const extent = child(el, "wp:extent");
      const docPr = child(el, "wp:docPr");
      const cx = extent ? Number(attr(extent, "cx")) : NaN;
      const cy = extent ? Number(attr(extent, "cy")) : NaN;
      images.push({
        id: `img${depart + images.length + 1}`,
        index: depart + images.length + 1,
        widthCm: Number.isFinite(cx) ? emuEnCm(cx) : 0,
        heightCm: Number.isFinite(cy) ? emuEnCm(cy) : 0,
        description: docPr ? attr(docPr, "descr") ?? attr(docPr, "name") : null,
      });
      noeuds.push(el);
    }
  }
  return { images, noeuds };
}

export interface EtatDocx {
  zip: PizZip;
  racine: XmlNode;
  body: XmlNode;
  /** Paragraphes de CORPS, dans l'ordre, avec leur nœud XML. Reconstruit après chaque commande. */
  paragraphes: { noeud: XmlNode; modele: ParagraphNode }[];
  tables: { noeud: XmlNode; modele: TableNode }[];
  images: { noeud: XmlNode; modele: ImageNode }[];
  modele: DocxModel;
}

/** Un `w:p` est-il DANS un tableau ? On remonte : un `w:tc` au-dessus tranche la question. */
function dansTableau(p: XmlNode): boolean {
  let n = p.parent;
  while (n) {
    if (n.name === "w:tc") return true;
    n = n.parent;
  }
  return false;
}

/** Le niveau de titre d'un nom de style : `Heading1` / `Titre2` / `Title` → 1 / 2 / 1 ; sinon `null`. */
export function niveauDeTitre(styleName: string | null): number | null {
  if (!styleName) return null;
  const m = /^(?:Heading|Titre|Title|heading|titre)\s*(\d)?$/.exec(styleName.trim());
  if (!m) return null;
  return m[1] ? Number(m[1]) : 1;
}

/**
 * LES MARQUES DE PAGE d'un paragraphe, dans l'ordre du texte :
 *   `avant`  — nombre de sauts qui tombent AVANT le premier caractère (le paragraphe COMMENCE
 *              sur une nouvelle page) ;
 *   `apres`  — nombre de sauts qui tombent après (les paragraphes suivants changent de page) ;
 *   `word`   — vrai si au moins une marque vient de Word (`w:lastRenderedPageBreak`), ce qui
 *              signe une pagination ENREGISTRÉE, pas estimée.
 */
function marquesDePage(p: XmlNode): { avant: number; apres: number; word: boolean } {
  let avant = 0; let apres = 0; let word = false; let texteVu = false;
  const pPr = child(p, "w:pPr");
  if (pPr && child(pPr, "w:pageBreakBefore")) avant += 1;
  for (const run of children(p, "w:r")) {
    for (const el of run.children) {
      if (el.type !== "element") continue;
      if (el.name === "w:lastRenderedPageBreak") { word = true; if (texteVu) apres += 1; else avant += 1; }
      else if (el.name === "w:br" && attr(el, "w:type") === "page") { if (texteVu) apres += 1; else avant += 1; }
      else if (el.name === "w:t" && textOf(el).length > 0) texteVu = true;
      else if (el.name === "w:drawing" || el.name === "w:tab") texteVu = true;
    }
  }
  // Un saut de section « page suivante » dans les propriétés du paragraphe : la suite commence
  // sur une nouvelle page.
  const sectPr = pPr ? child(pPr, "w:sectPr") : null;
  if (sectPr) {
    const type = child(sectPr, "w:type");
    const val = type ? attr(type, "w:val") : null;
    if (!val || val === "nextPage" || val === "oddPage" || val === "evenPage") apres += 1;
  }
  return { avant, apres, word };
}

function lireParagraphe(p: XmlNode, index: number, imgDepart: number): { modele: ParagraphNode; imgNoeuds: XmlNode[] } {
  const pPr = child(p, "w:pPr");
  const jc = pPr ? child(pPr, "w:jc") : null;
  const jcVal = jc ? attr(jc, "w:val") : null;
  const pStyle = pPr ? child(pPr, "w:pStyle") : null;
  const spacing = pPr ? child(pPr, "w:spacing") : null;
  const ind = pPr ? child(pPr, "w:ind") : null;

  const runs: RunNode[] = [];
  let r = 0;
  for (const run of children(p, "w:r")) {
    r += 1;
    // Uniquement les `w:t` : `textOf(run)` ramasserait aussi les codes de champ (`w:instrText`),
    // qui ne sont pas du texte lisible et fausseraient « le paragraphe qui contient … ».
    const contenu = children(run, "w:t").map(textOf).join("");
    runs.push({ id: `p${index}.r${r}`, index: r, text: contenu, style: lireStyleRun(run) });
  }
  const { images, noeuds } = lireImages(p, imgDepart);
  const nombreTwip = (el: XmlNode | null, a: string): number | null => {
    if (!el) return null;
    const v = Number(attr(el, a));
    return Number.isFinite(v) ? twipEnCm(v) : null;
  };
  const nombrePt = (el: XmlNode | null, a: string): number | null => {
    if (!el) return null;
    const v = Number(attr(el, a));
    // `w:spacing` s'exprime en vingtièmes de point.
    return Number.isFinite(v) ? Math.round((v / 20) * 10) / 10 : null;
  };
  const dominant = runs.find((x) => x.text.trim())?.style ?? runs[0]?.style ?? { ...STYLE_NEUTRE };

  return {
    modele: {
      id: `p${index}`,
      index,
      text: runs.map((x) => x.text).join(""),
      alignment: jcVal ? ALIGN_MODELE[jcVal] ?? null : null,
      styleName: pStyle ? attr(pStyle, "w:val") : null,
      style: dominant,
      runs,
      indentLeftCm: nombreTwip(ind, "w:left") ?? nombreTwip(ind, "w:start"),
      indentRightCm: nombreTwip(ind, "w:right") ?? nombreTwip(ind, "w:end"),
      spacingBeforePt: nombrePt(spacing, "w:before"),
      spacingAfterPt: nombrePt(spacing, "w:after"),
      inTable: dansTableau(p),
      images,
      page: null,
      headingLevel: niveauDeTitre(pStyle ? attr(pStyle, "w:val") : null),
    },
    imgNoeuds: noeuds,
  };
}

/**
 * L'ESTIMATION DE PAGINATION, quand Word n'a rien enregistré (fichier produit par un programme).
 * Une ligne de N points occupe ≈ N × 1,2 pt de haut ; un caractère ≈ N × 0,5 pt de large en
 * corps courant. Les tableaux comptent une ligne par rangée. C'est une estimation à ±1 page,
 * annoncée comme telle par `paginationSource: "estimee"` — jamais une certitude.
 */
function estimerPages(
  ordre: { kind: "p"; modele: ParagraphNode; avant: number; apres: number }[] | { kind: "tbl"; lignes: number; avant: number; apres: number }[],
  page: { largeurCm: number; hauteurCm: number; margesCm: number; margesLatCm: number },
  taillePtDefaut: number,
): number[] {
  const hauteurUtilePt = Math.max(200, (page.hauteurCm - page.margesCm) / 2.54 * 72);
  const largeurUtilePt = Math.max(200, (page.largeurCm - page.margesLatCm) / 2.54 * 72);
  const pages: number[] = [];
  let courante = 1;
  let remplissagePt = 0;
  for (const bloc of ordre as { kind: "p" | "tbl"; modele?: ParagraphNode; lignes?: number; avant: number; apres: number }[]) {
    if (bloc.avant > 0) { courante += bloc.avant; remplissagePt = 0; }
    let hauteurPt: number;
    if (bloc.kind === "p" && bloc.modele) {
      const m = bloc.modele;
      const taille = m.style.sizePt ?? (m.headingLevel ? 14 : taillePtDefaut);
      const parLigne = Math.max(10, Math.floor(largeurUtilePt / (taille * 0.5)));
      const lignes = Math.max(1, Math.ceil((m.text.length || 1) / parLigne));
      hauteurPt = lignes * taille * 1.2 + (m.spacingBeforePt ?? 0) + (m.spacingAfterPt ?? 8);
      if (m.images.length > 0) hauteurPt += m.images.reduce((sum, i) => sum + i.heightCm / 2.54 * 72, 0);
    } else {
      hauteurPt = Math.max(1, bloc.lignes ?? 1) * taillePtDefaut * 1.6 + 12;
    }
    if (remplissagePt + hauteurPt > hauteurUtilePt && remplissagePt > 0) { courante += 1; remplissagePt = 0; }
    pages.push(courante);
    remplissagePt += hauteurPt;
    if (bloc.apres > 0) { courante += bloc.apres; remplissagePt = 0; }
  }
  return pages;
}

function lireTable(t: XmlNode, index: number): TableNode {
  const lignes = children(t, "w:tr");
  const cells: TableNode["cells"] = [];
  let cols = 0;
  lignes.forEach((tr, i) => {
    const tcs = children(tr, "w:tc");
    cols = Math.max(cols, tcs.length);
    tcs.forEach((tc, j) => {
      cells.push({ id: `t${index}.r${i + 1}.c${j + 1}`, row: i + 1, col: j + 1, text: textOf(tc).trim() });
    });
  });
  return {
    id: `t${index}`, index, rows: lignes.length, cols, cells,
    header: cells.filter((c) => c.row === 1).sort((a, b) => a.col - b.col).map((c) => c.text),
  };
}

export function construireEtat(zip: PizZip, racine: XmlNode): EtatDocx {
  const body = firstDescendant(racine, "w:body") ?? racine;

  const paragraphes: EtatDocx["paragraphes"] = [];
  const images: EtatDocx["images"] = [];
  // Les marques de page, dans l'ordre du document — Word en a-t-il enregistré ?
  const marques: { avant: number; apres: number }[] = [];
  const blocsOrdonnes: ({ kind: "p"; modele: ParagraphNode; avant: number; apres: number } | { kind: "tbl"; lignes: number; avant: number; apres: number })[] = [];
  let paginationWord = false;
  let rang = 0;
  for (const p of descendants(body, "w:p")) {
    const enTable = dansTableau(p);
    const provisoire = lireParagraphe(p, 0, images.length);
    provisoire.modele.images.forEach((m, k) => images.push({ noeud: provisoire.imgNoeuds[k], modele: m }));
    const marque = marquesDePage(p);
    if (marque.word) paginationWord = true;
    if (enTable) {
      // Une marque de page DANS une cellule fait quand même tourner la page pour la suite.
      if (marque.avant + marque.apres > 0 && marques.length > 0) marques[marques.length - 1].apres += marque.avant + marque.apres;
      continue;
    }

    /**
     * NE REÇOIVENT UN RANG QUE LES PARAGRAPHES VISIBLES.
     *
     * Word insère un `<w:p/>` vide après chaque tableau — c'est obligatoire dans le format, et
     * ce paragraphe n'apparaît nulle part à l'écran. Le compter ferait que « supprime le
     * troisième paragraphe » désignerait, dans un document à tableaux, un paragraphe de plus
     * que celui que la personne montre du doigt. Le décalage serait invisible au test et
     * catastrophique à l'usage.
     *
     * Ces paragraphes restent DANS le document — on ne les supprime jamais, leur retrait
     * casserait la mise en page — ils sont seulement hors du comptage humain.
     */
    const visible = provisoire.modele.text.trim().length > 0 || provisoire.modele.images.length > 0;
    if (!visible) {
      // Un paragraphe vide porteur d'un saut de page tourne la page pour le suivant.
      if (marque.avant + marque.apres > 0) {
        if (marques.length > 0) marques[marques.length - 1].apres += marque.avant + marque.apres;
        else marques.push({ avant: marque.avant + marque.apres, apres: 0 });
      }
      continue;
    }
    rang += 1;
    const { modele } = lireParagraphe(p, rang, images.length - provisoire.modele.images.length);
    // Une marque en tête d'un paragraphe sans prédécesseur enregistré (premier paragraphe) ne
    // tourne pas la page : la page 1 commence là.
    const avant = marques.length === 0 && paragraphes.length === 0 && !marque.word ? 0 : marque.avant;
    if (marques.length === 0 && paragraphes.length === 0 && marque.avant > 0 && paragraphes.length === 0) {
      // marque portée par une ligne vide précédente : déjà reportée
    }
    marques.push({ avant, apres: marque.apres });
    paragraphes.push({ noeud: p, modele });
    blocsOrdonnes.push({ kind: "p", modele, avant, apres: marque.apres });
  }

  const tables: EtatDocx["tables"] = [];
  // Uniquement les tableaux de PREMIER niveau : un tableau imbriqué n'est pas « le 2ᵉ tableau ».
  children(body, "w:tbl").forEach((t, i) => tables.push({ noeud: t, modele: lireTable(t, i + 1) }));

  // ── LA PAGE DE CHAQUE PARAGRAPHE ──────────────────────────────────────────────────────
  //
  // Pagination ENREGISTRÉE par Word : on additionne les marques. Sinon : estimation (voir
  // `estimerPages`). Dans les deux cas, la page d'un paragraphe est celle où il COMMENCE.
  let nbPages = 1;
  if (paginationWord) {
    let courante = 1;
    paragraphes.forEach((x, i) => {
      courante += marques[i]?.avant ?? 0;
      x.modele.page = courante;
      courante += marques[i]?.apres ?? 0;
    });
    nbPages = Math.max(1, courante - (marques[marques.length - 1]?.apres ?? 0) + (marques[marques.length - 1]?.apres ?? 0));
    nbPages = Math.max(nbPages, ...paragraphes.map((x) => x.modele.page ?? 1));
  } else {
    // Les tableaux s'intercalent à leur place dans le corps pour l'estimation.
    const ordre: typeof blocsOrdonnes = [];
    let iP = 0;
    for (const enfant of body.children) {
      if (enfant.type !== "element") continue;
      if (enfant.name === "w:tbl") ordre.push({ kind: "tbl", lignes: children(enfant, "w:tr").length, avant: 0, apres: 0 });
      else if (enfant.name === "w:p" && iP < paragraphes.length && paragraphes[iP].noeud === enfant) { ordre.push(blocsOrdonnes[iP]); iP += 1; }
    }
    while (iP < paragraphes.length) { ordre.push(blocsOrdonnes[iP]); iP += 1; }
    const sectPr0 = firstDescendant(body, "w:sectPr");
    const pgSz0 = sectPr0 ? child(sectPr0, "w:pgSz") : null;
    const pgMar0 = sectPr0 ? child(sectPr0, "w:pgMar") : null;
    const lire = (el: XmlNode | null, a: string, defaut: number) => { if (!el) return defaut; const v = Number(attr(el, a)); return Number.isFinite(v) ? twipEnCm(v) : defaut; };
    const pagesEstimees = estimerPages(ordre as never, {
      largeurCm: lire(pgSz0, "w:w", 21), hauteurCm: lire(pgSz0, "w:h", 29.7),
      margesCm: lire(pgMar0, "w:top", 2.5) + lire(pgMar0, "w:bottom", 2.5),
      margesLatCm: lire(pgMar0, "w:left", 2.5) + lire(pgMar0, "w:right", 2.5),
    }, 11);
    let k = 0;
    ordre.forEach((bloc, i) => { if (bloc.kind === "p") { paragraphes[k].modele.page = pagesEstimees[i]; k += 1; } });
    nbPages = pagesEstimees.length ? Math.max(...pagesEstimees) : 1;
  }
  const plan: OutlineEntry[] = paragraphes
    .filter((x) => x.modele.headingLevel !== null)
    .map((x) => ({ niveau: x.modele.headingLevel!, texte: abreger(x.modele.text, 80), index: x.modele.index, page: x.modele.page }));

  const sectPr = firstDescendant(body, "w:sectPr");
  const pgSz = sectPr ? child(sectPr, "w:pgSz") : null;
  const pgMar = sectPr ? child(sectPr, "w:pgMar") : null;
  const twip = (el: XmlNode | null, a: string, defaut: number): number => {
    if (!el) return defaut;
    const v = Number(attr(el, a));
    return Number.isFinite(v) ? twipEnCm(v) : defaut;
  };

  const modele: DocxModel = {
    kind: "DOCX",
    paragraphs: paragraphes.map((x) => x.modele),
    tables: tables.map((x) => x.modele),
    images: images.map((x) => x.modele),
    pageWidthCm: twip(pgSz, "w:w", 21),
    pageHeightCm: twip(pgSz, "w:h", 29.7),
    marginTopCm: twip(pgMar, "w:top", 2.5),
    marginBottomCm: twip(pgMar, "w:bottom", 2.5),
    marginLeftCm: twip(pgMar, "w:left", 2.5),
    marginRightCm: twip(pgMar, "w:right", 2.5),
    hasHeader: Object.keys(zip.files).some((f) => /^word\/header\d*\.xml$/.test(f)),
    hasFooter: Object.keys(zip.files).some((f) => /^word\/footer\d*\.xml$/.test(f)),
    pages: nbPages,
    paginationSource: paginationWord ? "word" : "estimee",
    plan,
  };
  return { zip, racine, body, paragraphes, tables, images, modele };
}
