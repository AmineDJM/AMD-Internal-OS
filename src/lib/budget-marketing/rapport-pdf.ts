import PDFDocument from "pdfkit";
import { OTHER_COLOR, SERIES } from "@/components/charts/palette";
import { CLE_SANS } from "@/lib/budget/marketing-vue";
import type { ExportMarketing } from "@/lib/budget-export";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * BUDGET MARKETING — LE RAPPORT PDF (vue d'ensemble, sous les filtres de l'écran). Serveur uniquement.
 *
 * A4 portrait : la synthèse (disponible, rythme, À traiter, tableau par catégorie) ; les trois camemberts ; les barres
 * par catégorie et le payé par mois avec son cumul ; les demandes qui pèsent le plus. Les graphiques sont DESSINÉS
 * (vectoriels), pas des captures : ils restent nets à l'impression. Helvetica couvre le français sans police à embarquer
 * — d'où les espaces fines remplacées et les flèches écrites « -> ».
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const ENCRE = "#18212F";
const GRIS = "#5B6676";
const TRAIT = "#D5DCE6";
const FOND = "#EEF2F7";
const BLEU = "#2a78d6";
const AMBRE = "#eda100";
const VIOLET = "#7c5cd6";
const ROUGE = "#C8323C";

const L = 595.28, H = 841.89, M = 40;
const texte = (s: string) => s.replace(/[  ]/g, " ").replace(/→/g, "->").replace(/−/g, "-");
const nb = (n: number) => texte(Math.round(n).toLocaleString("fr-FR"));
const mio = (n: number) => texte(Math.abs(n) >= 1e6 ? `${(n / 1e6).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} M` : nb(n));
const couleur = (i: number) => SERIES[i % SERIES.length];

type Doc = PDFKit.PDFDocument;

function entete(doc: Doc, titre: string, sousTitre: string) {
  doc.rect(0, 0, L, 64).fill("#0B2545");
  doc.rect(0, 64, L, 3).fill("#1B7F79");
  doc.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(15).text(texte(titre), M, 18, { width: L - 2 * M });
  doc.fillColor("#D8DEE6").font("Helvetica").fontSize(9).text(texte(sousTitre), M, 40, { width: L - 2 * M });
}

function pied(doc: Doc, page: number) {
  doc.fillColor(GRIS).font("Helvetica").fontSize(8)
    .text("Adventum Pharma · Budget Marketing", M, H - 30, { width: 300, lineBreak: false })
    .text(`Page ${page}`, L - M - 100, H - 30, { width: 100, align: "right", lineBreak: false });
}

function titreSection(doc: Doc, t: string, y: number) {
  doc.fillColor(ENCRE).font("Helvetica-Bold").fontSize(11).text(texte(t), M, y, { width: L - 2 * M });
}

/** Un camembert (anneau) et sa légende chiffrée à droite. */
function anneau(doc: Doc, x: number, y: number, r: number, parts: { nom: string; valeur: number; couleur: string }[]) {
  const total = parts.reduce((a, p) => a + p.valeur, 0);
  if (!(total > 0)) { doc.fillColor(GRIS).font("Helvetica").fontSize(9).text("Rien sur cette sélection.", x, y + r - 5); return; }
  const cx = x + r, cy = y + r, ri = r * 0.58;
  let a0 = -Math.PI / 2;
  for (const p of parts) {
    const a1 = a0 + (p.valeur / total) * Math.PI * 2;
    const grand = a1 - a0 > Math.PI ? 1 : 0;
    const pt = (rr: number, a: number) => `${(cx + rr * Math.cos(a)).toFixed(2)} ${(cy + rr * Math.sin(a)).toFixed(2)}`;
    if (parts.length === 1) {
      doc.circle(cx, cy, r).fill(p.couleur);
      doc.circle(cx, cy, ri).fill("#FFFFFF");
    } else {
      doc.path(`M ${pt(r, a0)} A ${r} ${r} 0 ${grand} 1 ${pt(r, a1)} L ${pt(ri, a1)} A ${ri} ${ri} 0 ${grand} 0 ${pt(ri, a0)} Z`).fill(p.couleur);
    }
    a0 = a1;
  }
  let ly = y;
  const lx = x + 2 * r + 18;
  for (const p of parts.slice(0, 12)) {
    doc.rect(lx, ly + 2, 8, 8).fill(p.couleur);
    doc.fillColor(ENCRE).font("Helvetica").fontSize(8.5)
      .text(texte(`${p.nom}`), lx + 13, ly, { width: L - M - lx - 13 - 110, lineBreak: false, ellipsis: true });
    doc.fillColor(GRIS).text(`${nb(p.valeur)}  (${Math.round((p.valeur / total) * 100)} %)`, L - M - 110, ly, { width: 110, align: "right", lineBreak: false });
    ly += 14;
  }
}

/** Barres horizontales groupées (une ligne par libellé, une barre par série). */
function barresH(doc: Doc, x: number, y: number, w: number, lignes: { nom: string; valeurs: number[] }[], series: { nom: string; couleur: string }[]): number {
  const max = Math.max(1, ...lignes.flatMap((l) => l.valeurs));
  const lab = 150, epaisseur = 7, pas = series.length * (epaisseur + 2) + 10;
  const zone = w - lab - 70;
  let cy = y;
  for (const l of lignes) {
    doc.fillColor(ENCRE).font("Helvetica").fontSize(8.5).text(texte(l.nom), x, cy + (pas - 22) / 2, { width: lab - 8, lineBreak: false, ellipsis: true });
    l.valeurs.forEach((v, i) => {
      const by = cy + i * (epaisseur + 2);
      doc.rect(x + lab, by, Math.max(0.5, (v / max) * zone), epaisseur).fill(series[i].couleur);
      doc.fillColor(GRIS).fontSize(7).text(mio(v), x + lab + (v / max) * zone + 4, by, { width: 60, lineBreak: false });
    });
    cy += pas;
  }
  // Légende
  let lx = x + lab;
  for (const s of series) {
    doc.rect(lx, cy + 4, 8, 8).fill(s.couleur);
    doc.fillColor(ENCRE).fontSize(8).text(texte(s.nom), lx + 12, cy + 3, { lineBreak: false });
    lx += 12 + doc.widthOfString(texte(s.nom)) + 16;
  }
  return cy + 20;
}

export async function rendreRapportMarketingPdf(e: ExportMarketing): Promise<Buffer> {
  const doc = new PDFDocument({ size: "A4", margin: 0, info: { Title: texte(`Budget Marketing — ${e.enveloppe.nom}`), Author: "Adventum Pharma" } });
  const morceaux: Buffer[] = [];
  doc.on("data", (c: Buffer) => morceaux.push(c));
  const fin = new Promise<Buffer>((resolve) => doc.on("end", () => resolve(Buffer.concat(morceaux))));
  const selection = `${e.periode}${e.categorie ? ` · ${e.categorie}` : ""}${e.comparer ? ` · comparé à ${e.comparer.annee}` : ""}`;
  const sous = `${e.enveloppe.nom} · ${selection} · édité le ${new Date().toLocaleDateString("fr-FR")}`;
  const v = e.vue;
  let page = 1;

  // ── PAGE 1 — la synthèse ──────────────────────────────────────────────────────────────
  entete(doc, "Budget Marketing — vue d'ensemble", sous);
  let y = 86;
  doc.fillColor(GRIS).font("Helvetica").fontSize(9).text("Disponible (enveloppe - payé - engagé)", M, y);
  doc.fillColor(e.totaux.disponible < 0 ? ROUGE : ENCRE).font("Helvetica-Bold").fontSize(24).text(`${nb(e.totaux.disponible)} DZD`, M, y + 12);
  doc.fillColor(GRIS).font("Helvetica").fontSize(9).text(`sur ${nb(e.enveloppe.total)} DZD`, M, y + 42);
  doc.fillColor(ENCRE).font("Helvetica-Bold").fontSize(10).text(texte(e.totaux.rythme), L - M - 220, y + 14, { width: 220, align: "right" });
  doc.fillColor(GRIS).font("Helvetica").fontSize(8.5).text(`${Math.round(e.totaux.utilisePct)} % utilisé · ${Math.round(e.totaux.ecoulePct)} % de l'année écoulée`, L - M - 220, y + 30, { width: 220, align: "right" });
  y += 64;
  const bw = L - 2 * M, t = Math.max(1, e.enveloppe.total);
  doc.roundedRect(M, y, bw, 10, 5).fill(FOND);
  const wp = Math.min(bw, (Math.max(0, e.totaux.paye) / t) * bw);
  const we = Math.min(bw - wp, (Math.max(0, e.totaux.engage) / t) * bw);
  if (wp > 0) doc.rect(M, y, wp, 10).fill(BLEU);
  if (we > 0) doc.rect(M + wp, y, we, 10).fill("#9CC0EE");
  const xr = M + (e.totaux.ecoulePct / 100) * bw;
  doc.rect(xr - 0.75, y - 4, 1.5, 18).fill(ENCRE);
  y += 18;
  doc.fillColor(ENCRE).font("Helvetica").fontSize(8.5)
    .text(`Payé ${nb(e.totaux.paye)}   ·   Engagé, pas encore payé ${nb(e.totaux.engage)}   ·   Disponible ${nb(e.totaux.disponible)}`, M, y);
  y += 22;

  if (e.alertes.length) {
    titreSection(doc, "À traiter", y); y += 16;
    for (const a of e.alertes) {
      doc.rect(M, y, 3, 22).fill(AMBRE);
      doc.fillColor(ENCRE).font("Helvetica-Bold").fontSize(9).text(texte(a.titre), M + 9, y, { width: bw - 9 });
      doc.fillColor(GRIS).font("Helvetica").fontSize(8).text(texte(a.detail), M + 9, y + 11, { width: bw - 9 });
      y += 28;
    }
    y += 6;
  }

  titreSection(doc, "Par catégorie (toute l'enveloppe)", y); y += 16;
  const cols = [{ t: "Catégorie", w: 175, a: "left" }, { t: "Alloué", w: 70 }, { t: "Payé", w: 70 }, { t: "Engagé", w: 62 }, { t: "Reste", w: 70 }, { t: "%", w: 38 }] as const;
  const ligne = (vals: string[], gras: boolean, fond?: string, rouge?: number[]) => {
    if (fond) doc.rect(M, y - 3, bw, 15).fill(fond);
    let x = M;
    vals.forEach((val, i) => {
      doc.fillColor(rouge?.includes(i) ? ROUGE : ENCRE).font(gras ? "Helvetica-Bold" : "Helvetica").fontSize(8.5)
        .text(texte(val), x + 3, y, { width: cols[i].w - 6, align: (cols[i] as { a?: string }).a === "left" ? "left" : "right", lineBreak: false, ellipsis: true });
      x += cols[i].w;
    });
    y += 15;
  };
  ligne(cols.map((c) => c.t), true, FOND);
  let ta = 0, tp = 0, te = 0;
  for (const l of e.lignesCategories) {
    ta += l.alloue; tp += l.paye; te += l.engage;
    ligne([l.nom, nb(l.alloue), nb(l.paye), nb(l.engage), nb(l.reste), l.alloue > 0 ? `${Math.round(l.pct)} %` : "-"], false, undefined, [...(l.reste < 0 ? [4] : []), ...(l.pct > 100 ? [5] : [])]);
    doc.moveTo(M, y - 3).lineTo(M + bw, y - 3).lineWidth(0.4).strokeColor(TRAIT).stroke();
  }
  ligne(["Total", nb(ta), nb(tp), nb(te), nb(ta - tp - te), ta > 0 ? `${Math.round(((tp + te) / ta) * 100)} %` : "-"], true);
  if (e.sansCategorie.total > 0) ligne(["Sans catégorie (à imputer)", "-", nb(e.sansCategorie.total), "-", "-", ""], false);
  pied(doc, page);

  // ── PAGE 2 — les camemberts ───────────────────────────────────────────────────────────
  doc.addPage({ size: "A4", margin: 0 }); page += 1;
  entete(doc, "Répartition, payé et nature", sous);
  y = 90;
  const ordre = e.lignesCategories.map((l) => l.id);
  const cCat = (id: string) => (id === CLE_SANS ? OTHER_COLOR : couleur(Math.max(0, ordre.indexOf(id))));
  titreSection(doc, "Répartition de l'enveloppe (alloué)", y); y += 18;
  anneau(doc, M, y, 70, v.repartition.map((p) => ({ nom: p.nom, valeur: p.valeur, couleur: cCat(p.id) })));
  y += 170;
  titreSection(doc, "Payé par catégorie", y); y += 18;
  anneau(doc, M, y, 70, v.payeParCat.map((p) => ({ nom: p.nom, valeur: p.valeur, couleur: cCat(p.id) })));
  y += 170;
  titreSection(doc, "Par nature de dépense", y); y += 18;
  anneau(doc, M, y, 70, v.natures.map((n, i) => ({ nom: n.nature, valeur: n.montant, couleur: n.nature === "Non renseignée" ? OTHER_COLOR : couleur(i) })));
  pied(doc, page);

  // ── PAGE 3 — barres et mois ───────────────────────────────────────────────────────────
  doc.addPage({ size: "A4", margin: 0 }); page += 1;
  entete(doc, "Alloué, payé, engagé — et le payé mois par mois", sous);
  y = 90;
  titreSection(doc, "Alloué, payé et engagé par catégorie", y); y += 18;
  const series = [{ nom: "Alloué", couleur: "#C9D1DC" }, { nom: "Payé", couleur: BLEU }, { nom: "Engagé", couleur: AMBRE }, ...(e.comparer ? [{ nom: `Payé ${e.comparer.annee}`, couleur: VIOLET }] : [])];
  y = barresH(doc, M, y, bw, v.barres.slice(0, 10).map((b) => ({ nom: b.nom, valeurs: [b.alloue, b.paye, b.engage, ...(e.comparer ? [b.payeN1 ?? 0] : [])] })), series);
  y += 16;
  titreSection(doc, "Payé par mois, cumul et rythme régulier", y); y += 18;
  const gh = 200, gx = M + 40, gw = bw - 80;
  const maxMois = Math.max(1, ...v.mois.map((m) => m.total));
  const maxCumul = Math.max(1, ...v.mois.map((m) => Math.max(m.cumul, m.rythme, m.cumulN1 ?? 0)));
  doc.moveTo(gx, y + gh).lineTo(gx + gw, y + gh).lineWidth(0.6).strokeColor(TRAIT).stroke();
  const pasM = gw / Math.max(1, v.mois.length);
  const catsMois = [...new Set(v.mois.flatMap((m) => Object.keys(m.parCat)))];
  v.mois.forEach((m, i) => {
    let base = y + gh;
    for (const c of catsMois) {
      const h = ((m.parCat[c] ?? 0) / maxMois) * gh;
      if (h > 0) { doc.rect(gx + i * pasM + pasM * 0.18, base - h, pasM * 0.64, h).fill(cCat(c)); base -= h; }
    }
    doc.fillColor(GRIS).font("Helvetica").fontSize(7.5).text(texte(m.libelle), gx + i * pasM, y + gh + 4, { width: pasM, align: "center", lineBreak: false });
  });
  const courbe = (cle: "cumul" | "rythme" | "cumulN1", c: string, tirets: boolean) => {
    const pts = v.mois.map((m, i) => [gx + i * pasM + pasM / 2, y + gh - (((m[cle] as number | undefined) ?? 0) / maxCumul) * gh] as const);
    if (pts.length === 0) return;
    doc.moveTo(pts[0][0], pts[0][1]);
    for (const p of pts.slice(1)) doc.lineTo(p[0], p[1]);
    if (tirets) doc.dash(4, { space: 3 }); else doc.undash();
    doc.lineWidth(1.6).strokeColor(c).stroke();
    doc.undash();
  };
  courbe("rythme", GRIS, true);
  courbe("cumul", ENCRE, false);
  if (e.comparer) courbe("cumulN1", VIOLET, false);
  doc.fillColor(GRIS).fontSize(7).text(mio(maxMois), M, y - 2, { width: 38, align: "right" }).text(`cumul ${mio(maxCumul)}`, gx + gw + 2, y - 2, { width: 60 });
  y += gh + 22;
  let lx = M;
  for (const s of [...catsMois.map((c) => ({ nom: c === CLE_SANS ? "Sans catégorie" : e.lignesCategories.find((l) => l.id === c)?.nom ?? "-", couleur: cCat(c) })), { nom: "Cumul payé", couleur: ENCRE }, { nom: "Rythme régulier", couleur: GRIS }, ...(e.comparer ? [{ nom: `Cumul ${e.comparer.annee}`, couleur: VIOLET }] : [])]) {
    const w = 14 + doc.font("Helvetica").fontSize(8).widthOfString(texte(s.nom)) + 14;
    if (lx + w > L - M) { lx = M; y += 13; }
    doc.rect(lx, y + 1, 8, 8).fill(s.couleur);
    doc.fillColor(ENCRE).text(texte(s.nom), lx + 12, y, { lineBreak: false });
    lx += w;
  }
  pied(doc, page);

  // ── PAGE 4 — les demandes ─────────────────────────────────────────────────────────────
  doc.addPage({ size: "A4", margin: 0 }); page += 1;
  entete(doc, "Les demandes qui pèsent le plus", sous);
  y = 90;
  if (v.top.length === 0) {
    doc.fillColor(GRIS).font("Helvetica").fontSize(9).text("Aucune demande Ad & Pro sur cette sélection.", M, y);
  } else {
    y = barresH(doc, M, y, bw, v.top.map((d) => ({ nom: d.libelle, valeurs: [d.paye, d.engage] })), [{ nom: "Payé", couleur: BLEU }, { nom: "Engagé", couleur: AMBRE }]);
    y += 14;
    titreSection(doc, `Toutes les demandes de la sélection (${v.demandes.length})`, y); y += 16;
    for (const d of v.demandes.slice(0, 30)) {
      if (y > H - 60) break;
      doc.fillColor(ENCRE).font("Helvetica").fontSize(8.5).text(texte(d.libelle), M, y, { width: 300, lineBreak: false, ellipsis: true });
      doc.fillColor(GRIS).text(texte(d.type), M + 305, y, { width: 110, lineBreak: false, ellipsis: true });
      doc.fillColor(ENCRE).text(nb(d.total), L - M - 90, y, { width: 90, align: "right", lineBreak: false });
      y += 14;
    }
  }
  pied(doc, page);

  doc.end();
  return fin;
}
