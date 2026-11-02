/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA VUE — ce que le serveur envoie au workspace pour qu'il DESSINE le document (§5-6, §28).
 *
 * ── LA DÉCISION D'ARCHITECTURE, ET POURQUOI ELLE EST LA BONNE ───────────────────────────
 *
 * Le serveur envoie un MODÈLE, pas des pixels. Le navigateur fait la mise en page.
 *
 * L'alternative — convertir chaque modification en PDF puis en images — a été mesurée et
 * écartée : elle demande LibreOffice, qui n'est pas installable sur l'hébergement de ce projet
 * (`render.yaml` : `runtime: node`, pas de conteneur, pas d'apt), et elle coûterait deux à cinq
 * secondes par retouche là où §29 en demande moins d'une. Surtout, elle rendrait le texte
 * NON SÉLECTIONNABLE : on ne pourrait plus cliquer un paragraphe pour le désigner (§31).
 *
 * Le navigateur, lui, mesure le texte pour de vrai. Une police de 16 pt en Aptos y occupe
 * exactement la largeur qu'elle occupera, et la pagination qui en découle est juste.
 *
 * L'EXCEPTION EST LE PDF : un PDF n'a pas de modèle à re-dessiner — il EST une mise en page.
 * Ses pages sont donc rastérisées par MuPDF, ce qui donne une fidélité parfaite, et l'opération
 * est instantanée parce qu'elle ne concerne que les pages VISIBLES.
 *
 * ── CE FICHIER EST PUR ──────────────────────────────────────────────────────────────────
 *
 * Aucun import lourd : il traverse la frontière client / serveur (le workspace est un composant
 * `"use client"`). Voir CLAUDE.md, « Frontière client / serveur ».
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import type {
  ArtifactFormat, ArtifactModel, DocxModel, PdfModel, PptxModel, TextStyle, XlsxModel,
} from "@/lib/artifact/object-model/model";

/** Un bloc dessinable dans le flux d'un document Word. */
export interface BlocVue {
  id: string;
  type: "paragraphe" | "tableau" | "image";
  /** Rang HUMAIN, 1-indexé — c'est ce que le workspace affiche dans la marge. */
  index: number;
  texte: string;
  alignement: string | null;
  style: TextStyle;
  styleName: string | null;
  indentLeftCm: number | null;
  indentRightCm: number | null;
  spacingBeforePt: number | null;
  spacingAfterPt: number | null;
  /** Pour un tableau : les lignes, en clair. */
  lignes: string[][];
  /** Pour une image : ses dimensions. */
  largeurCm: number | null;
  hauteurCm: number | null;
  /** La page où le bloc commence (Word), d'après `paginationSource`. */
  page: number | null;
}

export interface VueDocx {
  kind: "DOCX";
  pageWidthCm: number;
  pageHeightCm: number;
  marginTopCm: number;
  marginBottomCm: number;
  marginLeftCm: number;
  marginRightCm: number;
  hasHeader: boolean;
  hasFooter: boolean;
  blocs: BlocVue[];
  /** Le nombre de pages, et d'où il vient (`word` : enregistré par Word ; `estimee` : calculé, ±1 page). */
  pages: number;
  paginationSource: "word" | "estimee";
  /** Le plan : titres, niveaux, rangs et pages — la carte d'un long document. */
  plan: { niveau: number; texte: string; index: number; page: number | null }[];
  /** Le nombre TOTAL de paragraphes de corps — `blocs` peut être tronqué (voir `MAX_BLOCS`). */
  paragraphes: number;
}

export interface VuePdf {
  kind: "PDF";
  pages: { id: string; index: number; widthPt: number; heightPt: number; rotation: number; apercu: string }[];
}

export interface VueXlsx {
  kind: "XLSX";
  feuilles: {
    id: string;
    index: number;
    nom: string;
    lignes: number;
    colonnes: number;
    largeurs: (number | null)[];
    figeLignes: number;
    figeColonnes: number;
    fusions: string[];
    cellules: {
      id: string; ref: string; row: number; col: number; valeur: string;
      formule: string | null; style: TextStyle; fond: string | null; align: string | null; format: string | null;
    }[];
    /** Les images posées sur la feuille — avec la CELLULE où elles s'accrochent. */
    images: { id: string; index: number; nom: string; ancre: string | null; largeurCm: number; hauteurCm: number }[];
  }[];
}

export interface VuePptx {
  kind: "PPTX";
  largeurCm: number;
  hauteurCm: number;
  diapos: {
    id: string; index: number; titre: string;
    formes: {
      id: string; index: number; nom: string; role: string;
      xCm: number; yCm: number; largeurCm: number; hauteurCm: number;
      texte: string; style: TextStyle; align: string | null;
    }[];
  }[];
}

export type VueContenu = VueDocx | VuePdf | VueXlsx | VuePptx;

/** L'objet complet que reçoit le workspace : l'état de la session ET le contenu à dessiner. */
export interface VueArtefact {
  sessionId: string;
  blockId: string;
  nodeId: string;
  nom: string;
  format: ArtifactFormat;
  etat: string;
  /** §64 : s'incrémente à chaque commande. Le workspace remplace, il n'empile pas. */
  revision: number;
  dirty: boolean;
  baseVersion: number;
  savedVersion: number | null;
  /** Working set (§4). */
  activePage: number | null;
  activeSlide: number | null;
  activeSheet: string | null;
  /** Identifiants mis en évidence — ce que la dernière commande a touché, ou les candidats. */
  surbrillance: string[];
  /** Peut-on annuler / rétablir maintenant ? Le workspace grise ses boutons avec ça. */
  peutAnnuler: boolean;
  peutRetablir: boolean;
  /** L'historique lisible : « ¶1 → centré », « ¶3 supprimé »… */
  historique: {
    operationId: string; seq: number; resume: string; annulee: boolean; quand: string;
    /** La revue de la personne (Atelier, J3) : acceptée, refusée (= annulée), ou pas encore revue. */
    revue?: "ACCEPTEE" | "REFUSEE" | null;
    /** Les zones que l'opération a touchées — surlignées à l'écran. */
    touches?: string[];
    /** Qui l'a faite (« Assistant IA », le nom de la personne). */
    acteur?: string;
  }[];
  contenu: VueContenu;
  /** Constats du contrôle qualité visuel (§26) — vides quand tout va bien. */
  alertes: string[];
}

const MAX_BLOCS = 4000;
const MAX_CELLULES_VUE = 20_000;

/** Transforme le modèle d'un adaptateur en vue dessinable. Aucune décision métier ici. */
export function vueDuModele(m: ArtifactModel): VueContenu {
  switch (m.kind) {
    case "DOCX": return vueDocx(m);
    case "PDF": return vuePdf(m);
    case "XLSX": return vueXlsx(m);
    case "PPTX": return vuePptx(m);
  }
}

function vueDocx(m: DocxModel): VueDocx {
  const blocs: BlocVue[] = [];
  // Les paragraphes et les tableaux sont RE-FUSIONNÉS dans l'ordre du document : le modèle les
  // sépare (deux numérotations distinctes), la vue les remet dans l'ordre où ils se lisent.
  for (const p of m.paragraphs) {
    if (blocs.length >= MAX_BLOCS) break;
    blocs.push({
      id: p.id, type: "paragraphe", index: p.index, texte: p.text,
      alignement: p.alignment, style: p.style, styleName: p.styleName,
      indentLeftCm: p.indentLeftCm, indentRightCm: p.indentRightCm,
      spacingBeforePt: p.spacingBeforePt, spacingAfterPt: p.spacingAfterPt,
      lignes: [], largeurCm: null, hauteurCm: null, page: p.page,
    });
  }
  for (const t of m.tables) {
    const lignes: string[][] = [];
    for (let r = 1; r <= t.rows; r += 1) {
      lignes.push(t.cells.filter((c) => c.row === r).sort((a, b) => a.col - b.col).map((c) => c.text));
    }
    blocs.push({
      id: t.id, type: "tableau", index: t.index, texte: t.header.join(" · "),
      alignement: null, style: { bold: false, italic: false, underline: false, sizePt: null, font: null, color: null },
      styleName: null, indentLeftCm: null, indentRightCm: null, spacingBeforePt: null, spacingAfterPt: null,
      lignes, largeurCm: null, hauteurCm: null, page: null,
    });
  }
  for (const i of m.images) {
    blocs.push({
      id: i.id, type: "image", index: i.index, texte: i.description ?? "",
      alignement: null, style: { bold: false, italic: false, underline: false, sizePt: null, font: null, color: null },
      styleName: null, indentLeftCm: null, indentRightCm: null, spacingBeforePt: null, spacingAfterPt: null,
      lignes: [], largeurCm: i.widthCm, hauteurCm: i.heightCm, page: null,
    });
  }
  return {
    kind: "DOCX",
    pageWidthCm: m.pageWidthCm, pageHeightCm: m.pageHeightCm,
    marginTopCm: m.marginTopCm, marginBottomCm: m.marginBottomCm,
    marginLeftCm: m.marginLeftCm, marginRightCm: m.marginRightCm,
    hasHeader: m.hasHeader, hasFooter: m.hasFooter,
    blocs,
    pages: m.pages, paginationSource: m.paginationSource, plan: m.plan.slice(0, 200), paragraphes: m.paragraphs.length,
  };
}

function vuePdf(m: PdfModel): VuePdf {
  return {
    kind: "PDF",
    pages: m.pages.map((p) => ({
      id: p.id, index: p.index, widthPt: p.widthPt, heightPt: p.heightPt,
      rotation: p.rotation, apercu: p.preview,
    })),
  };
}

function vueXlsx(m: XlsxModel): VueXlsx {
  return {
    kind: "XLSX",
    feuilles: m.sheets.map((s) => ({
      id: s.id, index: s.index, nom: s.name, lignes: s.rows, colonnes: s.cols,
      largeurs: s.columnWidths, figeLignes: s.frozenRows, figeColonnes: s.frozenCols, fusions: s.merges,
      cellules: s.cells.slice(0, MAX_CELLULES_VUE).map((c) => ({
        id: c.id, ref: c.ref, row: c.row, col: c.col, valeur: c.value,
        formule: c.formula, style: c.style, fond: c.fill, align: c.align, format: c.numFmt,
      })),
      images: s.images.map((i) => ({
        id: i.id, index: i.index, nom: i.name, ancre: i.anchorRef,
        largeurCm: i.widthCm, hauteurCm: i.heightCm,
      })),
    })),
  };
}

function vuePptx(m: PptxModel): VuePptx {
  return {
    kind: "PPTX",
    largeurCm: m.slideWidthCm, hauteurCm: m.slideHeightCm,
    diapos: m.slides.map((s) => ({
      id: s.id, index: s.index, titre: s.title,
      formes: s.shapes.map((f) => ({
        id: f.id, index: f.index, nom: f.name, role: f.role,
        xCm: f.xCm, yCm: f.yCm, largeurCm: f.widthCm, hauteurCm: f.heightCm,
        texte: f.text, style: f.style, align: f.alignment,
      })),
    })),
  };
}
