import PDFDocument from "pdfkit";
import { enClair } from "@/platform/ia/analyse/affichage";
import type { CelluleAnalyse, ColonneAnalyse } from "@/platform/ia/workspace/analyse";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UN TABLEAU EN PDF (lot K7, décision 0037 : « l'export de tout ») — mis en page, pas un vidage.
 *
 * A4, en PAYSAGE dès que le tableau est large ; un bandeau (titre, source, date) ; l'en-tête des colonnes RÉPÉTÉ à
 * chaque page ; les nombres alignés à droite et formatés en français (« 12 345 DZD », « 12,5 % ») par le même
 * formateur que l'écran (`enClair`) ; une ligne de totaux quand des colonnes s'additionnent ; « page n / N ».
 * Helvetica couvre le français sans police à embarquer : les espaces fines deviennent des espaces.
 *
 * Pur (octets en sortie, aucun accès disque ni base) — partagé par l'Assistant IA et, demain, par Adam.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface TablePdf {
  titre: string;
  source: string;
  colonnes: readonly ColonneAnalyse[];
  lignes: readonly CelluleAnalyse[][];
  totaux?: readonly (number | null)[] | null;
  auteur?: string;
  maintenant?: Date;
}

const ENCRE = "#18212F";
const GRIS = "#5B6676";
const TRAIT = "#D5DCE6";
const ZEBRE = "#F4F6FA";
const M = 32;
const propre = (s: string): string => s.replace(/[  ]/g, " ").replace(/[→]/g, "->").replace(/[−]/g, "-").replace(/[^\x09\x0a\x0d\x20-\x7e -ÿŒœŸ–—‘’“”…€]/g, "?");
const aDroite = (c: ColonneAnalyse): boolean => c.format !== "texte" && c.format !== "date";

export function rendrePdfTableau(t: TablePdf): Promise<Buffer> {
  const paysage = t.colonnes.length > 6;
  const doc = new PDFDocument({ size: "A4", layout: paysage ? "landscape" : "portrait", margin: M, bufferPages: true, info: { Title: propre(t.titre), Author: propre(t.auteur ?? "Adventum IA") } });
  const morceaux: Buffer[] = [];
  doc.on("data", (b: Buffer) => morceaux.push(b));
  const fini = new Promise<Buffer>((ok) => doc.on("end", () => ok(Buffer.concat(morceaux))));

  const L = doc.page.width, H = doc.page.height, largeur = L - 2 * M;
  const taille = t.colonnes.length > 12 ? 6.5 : t.colonnes.length > 8 ? 7.5 : 8.5;
  // LES LARGEURS : lues sur le contenu (en-tête et 200 premières lignes), puis ramenées à la page.
  doc.font("Helvetica").fontSize(taille);
  const brutes = t.colonnes.map((c, j) => Math.min(220, Math.max(
    doc.widthOfString(propre(c.libelle)) + 8,
    ...t.lignes.slice(0, 200).map((r) => doc.widthOfString(propre(enClair(r[j] ?? null, c.format))) + 8),
  )));
  const somme = brutes.reduce((a, b) => a + b, 0) || 1;
  const larg = brutes.map((w) => (w * largeur) / somme);
  const hLigne = taille + 7;

  const bandeau = () => {
    doc.rect(0, 0, L, 46).fill("#0B2545");
    doc.rect(0, 46, L, 2).fill("#1B7F79");
    doc.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(13).text(propre(t.titre), M, 12, { width: largeur, lineBreak: false, ellipsis: true });
    const date = (t.maintenant ?? new Date()).toLocaleString("fr-FR", { timeZone: "Africa/Algiers", dateStyle: "short", timeStyle: "short" });
    doc.fillColor("#D8DEE6").font("Helvetica").fontSize(8).text(propre(`${t.source} · ${t.lignes.length} ligne(s) · ${date}`), M, 30, { width: largeur, lineBreak: false, ellipsis: true });
  };
  const ligne = (cellules: string[], y: number, gras: boolean, fond?: string) => {
    if (fond) doc.rect(M, y, largeur, hLigne).fill(fond);
    doc.fillColor(ENCRE).font(gras ? "Helvetica-Bold" : "Helvetica").fontSize(taille);
    let x = M;
    cellules.forEach((c, j) => {
      doc.text(propre(c), x + 3, y + 3.5, { width: larg[j]! - 6, height: hLigne - 3, lineBreak: false, ellipsis: true, align: aDroite(t.colonnes[j]!) ? "right" : "left" });
      x += larg[j]!;
    });
  };
  const entete = (y: number) => {
    ligne(t.colonnes.map((c) => c.libelle), y, true, "#E3E9F2");
    doc.moveTo(M, y + hLigne).lineTo(M + largeur, y + hLigne).strokeColor(TRAIT).lineWidth(0.6).stroke();
    return y + hLigne;
  };

  bandeau();
  let y = entete(60);
  const bas = H - M - 14;
  t.lignes.forEach((r, i) => {
    if (y + hLigne > bas) { doc.addPage(); bandeau(); y = entete(60); }
    ligne(t.colonnes.map((c, j) => enClair(r[j] ?? null, c.format)), y, false, i % 2 ? ZEBRE : undefined);
    y += hLigne;
  });
  if (t.totaux && t.lignes.length > 1) {
    if (y + hLigne > bas) { doc.addPage(); bandeau(); y = entete(60); }
    doc.moveTo(M, y).lineTo(M + largeur, y).strokeColor(ENCRE).lineWidth(0.8).stroke();
    ligne(t.colonnes.map((c, j) => (j === 0 ? "Total" : t.totaux?.[j] === null || t.totaux?.[j] === undefined ? "" : enClair(t.totaux[j]!, c.format))), y + 1, true);
  }
  if (!t.lignes.length) doc.fillColor(GRIS).font("Helvetica").fontSize(9).text("Aucune ligne.", M, y + 6);

  const pages = doc.bufferedPageRange();
  for (let p = 0; p < pages.count; p++) {
    doc.switchToPage(pages.start + p);
    doc.fillColor(GRIS).font("Helvetica").fontSize(7)
      .text("Adventum Pharma · export de l'Assistant IA", M, H - M + 4, { width: 300, lineBreak: false })
      .text(`page ${p + 1} / ${pages.count}`, L - M - 120, H - M + 4, { width: 120, align: "right", lineBreak: false });
  }
  doc.end();
  return fini;
}
