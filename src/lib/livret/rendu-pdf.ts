import { readFile } from "fs/promises";
import { join } from "path";
import PDFDocument from "pdfkit";
import type { Bloc, CelluleTable, CoordonneesLivret, Livret, LigneInfo, Section } from "./modele";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE LIVRET DE SÉJOUR EN PDF — le dessin, selon la CHARTE ADVENTUM PHARMA. Serveur uniquement (pdfkit, fichiers).
 *
 * A5 portrait, fond blanc. Ce que la charte impose, et où c'est tenu :
 *   • le LOGO HORIZONTAL officiel (`assets/adventum-logo-horizontal.png`, le fichier de la charte, jamais redessiné ;
 *     le vertical est retiré), proportions gardées (seule la largeur est donnée), toujours ≥ 20 mm de large ;
 *   • Pantone 7714 C (#087084, teal) en couleur principale, Pantone 2945 C (#1B589E, bleu) pour les titres ;
 *     titres en bleu, sous-titres en teal ;
 *   • Calibri pour titres (gras) et sous-titres (regular) — embarquée en CARLITO, sa jumelle métrique sous licence
 *     libre (OFL, `assets/OFL-Carlito.txt`) — et Helvetica (police standard du PDF) pour le corps du texte ;
 *   • puces carrées, mosaïque de carrés (le picto) dans le bandeau des pages intérieures ;
 *   • le pied du papier à en-tête : long filet teal, court filet bleu ; coordonnées, et sur la lettre les mentions
 *     légales (NIF, RC, article).
 * Le logo d'un partenaire ou de l'événement, s'il en vient un un jour, se place à GAUCHE du logo Adventum.
 *
 * Les mesures reprennent la maquette validée, écrite en « cqw » : 1 cqw = 1 % de la largeur de la feuille (`U`).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface AssetsLivret { logo: Buffer; regular: Buffer; bold: Buffer }

const DOSSIER = join(process.cwd(), "src", "lib", "livret", "assets");

let cache: Promise<AssetsLivret> | null = null;
export function chargerAssetsLivret(): Promise<AssetsLivret> {
  cache ??= Promise.all([
    readFile(join(DOSSIER, "adventum-logo-horizontal.png")),
    readFile(join(DOSSIER, "Carlito-Regular.woff")),
    readFile(join(DOSSIER, "Carlito-Bold.woff")),
  ]).then(([logo, regular, bold]) => ({ logo, regular, bold })).catch((e) => { cache = null; throw e; });
  return cache;
}

// ── La charte ──
const TEAL = "#087084";
const BLEU = "#1B589E";
const NOIR = "#1A1A1A";
const GRIS = "#53565A";
const FILET = "#DFE7EA";
const BLOC = "#F7FAFB";
const BLEU_CLAIR = "#A3C7D2";
const SEPARATEUR = "#B3DCE0";
const CYAN = "#3CBCD8";

const W = 419.53;
const H = 595.28;
const U = W / 100;
const MX = 9 * U;
const LARGEUR = W - 2 * MX;
const ENTETE = 17 * U;
const LOGO_RATIO = 835 / 3000;
const GAP = 2.6 * U;
const CORPS = 9.4;

const T = "Carlito-Bold";
const S = "Carlito";
const B = "Helvetica";
const BG = "Helvetica-Bold";

// LES COORDONNÉES IMPRIMÉES sont celles de la société qui invite (`Livret.societe`, lues de sa carte Legal) — plus aucune
// n'est écrite ici (Direction, 10/2026 : « l'e-mail dépend vraiment de la société »). Une société sans e-mail n'en imprime pas.
const contactsDe = (s: CoordonneesLivret | null): string[] =>
  s ? [...s.telephones, s.email, s.adresse].filter((x): x is string => Boolean(x && x.trim())) : [];
const siteDe = (s: CoordonneesLivret | null): string => (s?.siteWeb ?? "").replace(/^https?:\/\//i, "");

// Helvetica (WinAnsi) et Carlito (sous-ensemble latin) : tout caractère hors de ces jeux est ramené à sa lettre de base.
const WINANSI_EXTRA = new Set("ŒœŠšŸŽžƒˆ˜–—‘’‚“”„†‡•…‰‹›€™");
export function propre(s: string): string {
  return s
    .replace(/[    ]/g, " ")
    .replace(/[→⟶➔]/g, "–")
    .replace(/[‐‑]/g, "-")
    .split("")
    .map((c) => {
      const n = c.charCodeAt(0);
      if ((n >= 32 && n <= 126) || (n >= 160 && n <= 255) || WINANSI_EXTRA.has(c) || c === "\n") return c;
      const base = c.normalize("NFD").replace(/[̀-ͯ]/g, "");
      return base && [...base].every((x) => x.charCodeAt(0) <= 255) ? base : "?";
    })
    .join("");
}

type Doc = PDFKit.PDFDocument;

// Mosaïque du bandeau : 3 rangées × 8 carrés, de plus en plus présents vers la droite (0 = vide).
const TEINTES: [string, number][] = [["#FFFFFF", 0], [BLEU, 0.06], [BLEU, 0.12], [BLEU, 0.22], [CYAN, 0.18], [BLEU, 0.38], [TEAL, 0.3]];
const MOSAIQUES: number[][][] = [
  [[0, 0, 1, 0, 1, 2, 1, 3], [0, 0, 0, 1, 0, 4, 2, 5], [0, 1, 0, 0, 2, 1, 6, 3]],
  [[0, 0, 0, 1, 0, 2, 3, 1], [0, 1, 0, 0, 1, 4, 1, 5], [0, 0, 1, 0, 1, 2, 3, 6]],
  [[0, 1, 0, 0, 2, 1, 3, 5], [0, 0, 0, 1, 0, 4, 2, 1], [0, 0, 1, 0, 1, 2, 6, 3]],
  [[0, 0, 1, 0, 1, 3, 2, 1], [0, 1, 0, 0, 2, 1, 4, 5], [0, 0, 0, 1, 0, 2, 3, 6]],
];

class Dessin {
  doc: Doc;
  logo: unknown;
  page = 0;
  y = 0;
  titre = "";
  constructor(doc: Doc, logo: unknown, private pied: string, private societe: CoordonneesLivret | null) {
    this.doc = doc;
    this.logo = logo;
  }

  private image(x: number, y: number, largeur: number) {
    // La largeur seule est donnée : pdfkit garde les proportions du logo (jamais déformé).
    (this.doc as unknown as { image: (src: unknown, x: number, y: number, o: { width: number }) => void }).image(this.logo, x, y, { width: largeur });
  }

  private nouvelle() {
    this.doc.addPage({ size: [W, H], margin: 0 });
    this.page += 1;
  }

  private barres(x: number, y: number, largeur: number) {
    const g = 0.6 * U;
    const long = (largeur - g) * 0.72;
    this.doc.rect(x, y, long, 0.55 * U).fill(TEAL);
    this.doc.rect(x + long + g, y, largeur - long - g, 0.55 * U).fill(BLEU);
  }

  /** Le pied d'une page intérieure (ou de la couverture) : les deux filets, puis une ligne. */
  private piedSimple(gauche: string, droite: string, numero: boolean) {
    const yTexte = H - 4.4 * U - 9;
    this.barres(MX, yTexte - 1.8 * U - 0.55 * U, LARGEUR);
    this.doc.font(B).fontSize(7.3).fillColor(GRIS).text(this.couper(propre(gauche), LARGEUR - 60), MX, yTexte + 1, { lineBreak: false });
    if (numero) this.doc.font(T).fontSize(9.2).fillColor(TEAL).text(droite, W - MX - 50, yTexte, { width: 50, align: "right", lineBreak: false });
    else this.doc.font(B).fontSize(7.3).fillColor(GRIS).text(propre(droite), W - MX - 150, yTexte + 1, { width: 150, align: "right", lineBreak: false });
  }

  /** Une ligne qui tient dans `largeur` (police courante), coupée d'un « … » sinon. */
  couper(s: string, largeur: number): string {
    if (this.doc.widthOfString(s) <= largeur) return s;
    let t = s;
    while (t.length > 1 && this.doc.widthOfString(`${t}…`) > largeur) t = t.slice(0, -1);
    return `${t.trimEnd()}…`;
  }

  limite(): number {
    return H - 4.4 * U - 9 - 1.8 * U - 0.55 * U - 12;
  }

  // ── Couverture ──
  couverture(c: Livret["couverture"]) {
    this.nouvelle();
    const d = this.doc;
    this.image(MX, 9 * U, 46 * U);

    // Le titre, calé sur le bas (22 cqw au-dessus du bord) : on mesure d'abord, le picto s'ajuste au-dessus.
    const titre = propre(c.titre);
    let taille = 10 * U;
    d.font(T);
    while (taille > 6 * U && d.fontSize(taille).heightOfString(titre, { width: LARGEUR, lineGap: -0.04 * taille }) > taille * 2.1) taille -= 0.5 * U;
    const hTitre = d.fontSize(taille).heightOfString(titre, { width: LARGEUR, lineGap: -0.04 * taille });
    const hLieu = d.font(S).fontSize(3.8 * U).heightOfString(propre(c.lieu), { width: LARGEUR });
    const hPour = d.font(T).fontSize(4.6 * U).heightOfString(propre(c.pourNom), { width: LARGEUR });
    const total = 3 * U + 1.6 * U + hTitre + 1.6 * U + hLieu + 2.4 * U + 2.4 * U + 9.6 + 2 + hPour;
    let y = H - 22 * U - total;

    // Le picto : les carrés du logo, en grand, débordant à droite — réduit s'il fallait, pour ne jamais passer sous le titre.
    const oy = 22 * U;
    const k = Math.min(1, Math.max(0.55, (y - 4 * U - oy) / (64 * U)));
    const ox = W + 6 * U - 78 * U * k;
    const carre = (l: number, t: number, w: number, h: number, r: number, de: string, a: string) => {
      const [x0, y0] = [ox + l * U * k, oy + t * U * k];
      const grad = d.linearGradient(x0, 0, x0 + w * U * k, 0);
      grad.stop(0, de).stop(1, a);
      d.roundedRect(x0, y0, w * U * k, h * U * k, r * U * k).fill(grad);
    };
    carre(0, 4, 9, 9, 1.6, "#40C0DC", "#0D7487");
    carre(40, 2, 28, 26, 3, "#40C0DC", "#0D7487");
    carre(12, 14, 42, 42, 3, "#2E78BF", "#1F4F98");
    carre(4, 46, 18, 18, 3, "#40C0DC", "#0D7487");
    carre(58, 54, 9, 9, 1.6, "#40C0DC", "#0D7487");

    d.font(S).fontSize(3 * U).fillColor(TEAL).text(propre(c.surtitre), MX, y, { width: LARGEUR, characterSpacing: 0.3 });
    y += 3 * U + 1.6 * U;
    d.font(T).fontSize(taille).fillColor(BLEU).text(titre, MX, y, { width: LARGEUR, lineGap: -0.04 * taille });
    y += hTitre + 1.6 * U;
    d.font(S).fontSize(3.8 * U).fillColor(TEAL).text(propre(c.lieu), MX, y, { width: LARGEUR });
    y += hLieu + 2.4 * U;
    d.moveTo(MX, y).lineTo(W - MX, y).lineWidth(0.3 * U).strokeColor(SEPARATEUR).stroke();
    y += 2.4 * U;
    d.font(B).fontSize(9.6).fillColor(GRIS).text(propre(c.pourEtiquette), MX, y, { width: LARGEUR });
    y += 9.6 + 2;
    d.font(T).fontSize(4.6 * U).fillColor(NOIR).text(propre(c.pourNom), MX, y, { width: LARGEUR });
    this.piedSimple(siteDe(this.societe), this.societe?.email ?? "", false);
  }

  // ── Lettre, sur le papier à en-tête ──
  lettre(l: Livret["lettre"]) {
    this.nouvelle();
    const d = this.doc;
    this.image(MX, 9 * U, 36 * U);
    const haut = 9 * U + 36 * U * LOGO_RATIO + 6 * U;

    // Le pied du papier à en-tête : filets, coordonnées (pastilles teal), mentions légales à droite.
    const ligne = 9.4;
    const yPied = H - 4.4 * U - 4 * ligne;
    this.barres(MX, yPied - 1.8 * U - 0.55 * U, LARGEUR);
    contactsDe(this.societe).slice(0, 4).forEach((t, i) => {
      const yy = yPied + i * ligne;
      d.circle(MX + 0.75 * U, yy + 3.4, 0.75 * U).fill(TEAL);
      d.font(B).fontSize(7.3).fillColor(BLEU).text(propre(t), MX + 2.6 * U, yy, { width: 60 * U, lineBreak: false });
    });
    (this.societe?.mentions ?? []).slice(0, 4).forEach(([cle, val], i) => {
      const yy = yPied + i * ligne;
      const wv = d.font(B).fontSize(7.3).widthOfString(val);
      const wc = d.font(BG).fontSize(7.3).widthOfString(propre(cle));
      d.font(BG).fillColor(TEAL).text(propre(cle), W - MX - wv - wc, yy, { lineBreak: false });
      d.font(B).fillColor(BLEU).text(val, W - MX - wv, yy, { lineBreak: false });
    });

    // Le corps : on essaie à 10 pt, et on resserre si la lettre déborderait sur le pied.
    const bas = yPied - 1.8 * U - 14;
    let taille = 10;
    const hauteur = (t: number) => this.lettreCorps(l, haut, t, false);
    while (taille > 8 && haut + hauteur(taille) > bas) taille -= 0.25;
    this.lettreCorps(l, haut, taille, true);
  }

  private lettreCorps(l: Livret["lettre"], y0: number, t: number, dessiner: boolean): number {
    const d = this.doc;
    const gap = 2.2 * U * (t / 10);
    const lg = t * 0.45;
    let y = y0;
    const para = (texte: string, font: string, taille: number, couleur: string, align: "left" | "right" = "left") => {
      const s = propre(texte);
      d.font(font).fontSize(taille);
      const h = d.heightOfString(s, { width: LARGEUR, lineGap: lg });
      if (dessiner) d.fillColor(couleur).text(s, MX, y, { width: LARGEUR, lineGap: lg, align });
      y += h + gap;
    };
    para(l.date, B, t, GRIS, "right");
    if (l.destinataire?.length) {
      const [nom, ...reste] = l.destinataire;
      d.font(BG).fontSize(t);
      const h1 = d.heightOfString(propre(nom!), { width: LARGEUR, lineGap: lg });
      if (dessiner) d.fillColor(NOIR).text(propre(nom!), MX, y, { width: LARGEUR, lineGap: lg });
      y += h1;
      if (reste.length) para(reste.join("\n"), B, t, NOIR); else y += gap;
    }
    para(l.objet, T, t * 1.22, BLEU);
    para(l.salutation, B, t, NOIR);
    for (const p of l.paragraphes) para(p, B, t, NOIR);
    para(l.formule, B, t, NOIR);
    // La signature, à droite.
    const xs = W - MX - 40 * U;
    if (dessiner) {
      d.font(T).fontSize(t * 1.22).fillColor(BLEU).text("La Direction Marketing", xs, y + 0.6 * U, { width: 40 * U });
      d.font(B).fontSize(t * 0.88).fillColor(GRIS).text("Adventum Pharma", xs, y + 0.6 * U + t * 1.5, { width: 40 * U });
      const yl = y + 0.6 * U + t * 1.5 + t * 1.2 + 8 * U;
      d.moveTo(xs, yl).lineTo(W - MX, yl).lineWidth(0.25 * U).strokeColor(FILET).stroke();
    }
    y += 0.6 * U + t * 2.7 + 8 * U;
    return y - y0;
  }

  // ── Pages intérieures ──
  pageInterieure(titre: string, sous: string | null, suite: boolean) {
    this.nouvelle();
    const d = this.doc;
    const grad = d.linearGradient(0, 0, 0, ENTETE);
    grad.stop(0, "#F3F5F7").stop(1, "#FAFBFC");
    d.rect(0, 0, W, ENTETE).fill(grad);
    const cote = ENTETE / 3;
    const motif = MOSAIQUES[this.page % MOSAIQUES.length]!;
    motif.forEach((rangee, r) => rangee.forEach((k, c) => {
      if (!k) return;
      const [couleur, opacite] = TEINTES[k]!;
      d.save();
      d.fillOpacity(opacite).rect(W - (8 - c) * cote, r * cote, cote, cote).fill(couleur);
      d.restore();
    }));
    d.fillOpacity(1);
    this.image(MX, 5.2 * U, 36 * U);
    this.piedSimple(this.pied, String(this.page), true);

    this.titre = titre;
    let y = ENTETE + 5 * U;
    const t = propre(suite ? `${titre} (suite)` : titre);
    d.font(T).fontSize(6.2 * U);
    const ht = d.heightOfString(t, { width: LARGEUR, lineGap: -0.05 * 6.2 * U });
    d.fillColor(BLEU).text(t, MX, y, { width: LARGEUR, lineGap: -0.05 * 6.2 * U, characterSpacing: -0.1 });
    y += ht;
    if (sous && !suite) {
      const s = propre(sous);
      d.font(S).fontSize(3.4 * U);
      const hs = d.heightOfString(s, { width: LARGEUR });
      d.fillColor(TEAL).text(s, MX, y + 1.2 * U, { width: LARGEUR });
      y += 1.2 * U + hs;
    }
    this.y = y + GAP;
  }

  /** Une place de `h` points, sinon une nouvelle page (« suite »). */
  place(h: number): boolean {
    if (this.y + h <= this.limite()) return false;
    this.pageInterieure(this.titre, null, true);
    return true;
  }

  // ── Les blocs ──
  private mesureLignes(lignes: LigneInfo[], largeurValeur: number): number[] {
    return lignes.map((l) => {
      const hv = this.doc.font(l.fort ? BG : B).fontSize(CORPS).heightOfString(propre(l.valeur), { width: largeurValeur, lineGap: 1.6 });
      const hc = this.doc.font(B).fontSize(CORPS).heightOfString(propre(l.cle), { width: 22 * U, lineGap: 1.6 });
      return Math.max(hv, hc);
    });
  }

  private cadre(y: number, h: number) {
    this.doc.rect(MX, y, LARGEUR, h).fill(BLOC);
    this.doc.rect(MX, y, 0.7 * U, h).fill(TEAL);
  }

  blocLignes(b: { etiquette?: string; lignes: LigneInfo[] }, avant?: (y: number) => number, hAvant = 0) {
    const d = this.doc;
    const px = 0.7 * U + 2.8 * U, py = 2 * U;
    const xv = MX + px + 22 * U + 2 * U;
    const wv = W - MX - 2.8 * U - xv;
    const hs = this.mesureLignes(b.lignes, wv);
    const hEt = b.etiquette ? 2.5 * U + 0.8 * U + 2 : 0;
    const h = py * 2 + hEt + hAvant + hs.reduce((a, x) => a + x, 0) + Math.max(0, hs.length - 1) * 0.8 * U - 1.6;
    this.place(h);
    let y = this.y;
    this.cadre(y, h);
    y += py;
    if (b.etiquette) {
      d.font(T).fontSize(2.5 * U).fillColor(TEAL).text(this.couper(propre(b.etiquette), LARGEUR - px * 2), MX + px, y, { lineBreak: false });
      y += hEt;
    }
    if (avant) y = avant(y);
    b.lignes.forEach((l, i) => {
      d.font(B).fontSize(CORPS).fillColor(GRIS).text(propre(l.cle), MX + px, y, { width: 22 * U, lineGap: 1.6 });
      d.font(l.fort ? BG : B).fontSize(CORPS).fillColor(NOIR).text(propre(l.valeur), xv, y, { width: wv, lineGap: 1.6 });
      y += hs[i]! + 0.8 * U;
    });
    this.y += h + GAP;
  }

  blocVol(b: Extract<Bloc, { t: "vol" }>) {
    const d = this.doc;
    const px = 0.7 * U + 2.8 * U;
    const zone = (LARGEUR - px - 2.8 * U) * 0.38;
    const tailleVille = (s: string) => {
      let t = 6 * U;
      d.font(T);
      while (t > 11 && d.fontSize(t).widthOfString(s) > zone) t -= 0.5;
      return t;
    };
    const de = propre(b.de), vers = propre(b.vers);
    const t = Math.min(tailleVille(de), tailleVille(vers));
    const hVol = t * 1.12 + 2 + 9 + 0.8 * U * 2;
    this.blocLignes({ etiquette: b.etiquette, lignes: b.lignes }, (y) => {
      const y0 = y + 0.4 * U;
      const xg = MX + px, xd = W - MX - 2.8 * U;
      d.font(T).fontSize(t).fillColor(BLEU);
      const wde = d.widthOfString(de), wvers = d.widthOfString(vers);
      d.text(de, xg, y0, { lineBreak: false });
      d.text(vers, xd - wvers, y0, { lineBreak: false });
      d.font(B).fontSize(7.9).fillColor(GRIS);
      d.text(propre(b.sousDe), xg, y0 + t * 1.12 + 2, { lineBreak: false });
      const wsv = d.widthOfString(propre(b.sousVers));
      d.text(propre(b.sousVers), xd - wsv, y0 + t * 1.12 + 2, { lineBreak: false });
      // Le trajet : un filet bleu clair entre un carré teal (départ) et un carré bleu (arrivée).
      const a = xg + wde + 2.4 * U, z = xd - wvers - 2.4 * U, ym = y0 + t * 0.62, c = 1.6 * U;
      if (z - a > 3 * c) {
        d.rect(a, ym - 0.15 * U, z - a, 0.3 * U).fill(BLEU_CLAIR);
        d.rect(a, ym - c / 2, c, c).fill(TEAL);
        d.rect(z - c, ym - c / 2, c, c).fill(BLEU);
      }
      return y + hVol;
    }, hVol);
  }

  h3(texte: string) {
    const d = this.doc;
    const h = 3.1 * U + 1 * U;
    // Jamais un intertitre seul en bas de page : il emmène au moins une ligne avec lui.
    this.place(h + 40);
    const y = this.y + 1 * U;
    d.rect(MX, y + 0.75 * U, 1.7 * U, 1.7 * U).fill(TEAL);
    d.font(T).fontSize(3.1 * U).fillColor(BLEU).text(propre(texte), MX + 1.7 * U + 1.6 * U, y, { width: LARGEUR - 4 * U, lineBreak: false });
    this.y = y + 3.1 * U + GAP * 0.6;
  }

  texte(t: string) {
    const s = propre(t);
    const h = this.doc.font(B).fontSize(CORPS).heightOfString(s, { width: LARGEUR, lineGap: 2 });
    this.place(h);
    this.doc.fillColor(GRIS).text(s, MX, this.y, { width: LARGEUR, lineGap: 2 });
    this.y += h + GAP;
  }

  puces(items: string[]) {
    const d = this.doc;
    for (const it of items) {
      const s = propre(it);
      const h = d.font(B).fontSize(CORPS).heightOfString(s, { width: LARGEUR - 2.6 * U, lineGap: 1.6 });
      this.place(h);
      d.rect(MX, this.y + 1.8, 1.5 * U, 1.5 * U).fill(TEAL);
      d.fillColor(NOIR).text(s, MX + 2.6 * U, this.y, { width: LARGEUR - 2.6 * U, lineGap: 1.6 });
      this.y += h + 0.6 * U + 2;
    }
    this.y += GAP - 0.6 * U;
  }

  contacts(cartes: { titre: string; lignes: string[] }[]) {
    const d = this.doc;
    const g = 2 * U, w = (LARGEUR - g) / 2, px = 0.7 * U + 2.4 * U, py = 2 * U;
    for (let i = 0; i < cartes.length; i += 2) {
      const rang = cartes.slice(i, i + 2);
      const hauteur = (c: { titre: string; lignes: string[] }) =>
        py * 2 + 2.8 * U + 6 + c.lignes.reduce((a, l) => a + d.font(B).fontSize(CORPS).heightOfString(propre(l), { width: w - px - 2 * U }) + 1.5, 0);
      const h = Math.max(...rang.map(hauteur));
      this.place(h);
      rang.forEach((c, k) => {
        const x = MX + k * (w + g);
        d.rect(x, this.y, w, h).fill(BLOC);
        d.rect(x, this.y, 0.7 * U, h).fill(TEAL);
        let y = this.y + py;
        d.font(T).fontSize(2.8 * U).fillColor(BLEU).text(propre(c.titre), x + px, y, { width: w - px - 2 * U, lineBreak: false });
        y += 2.8 * U + 6;
        for (const l of c.lignes) {
          const s = propre(l);
          d.font(B).fontSize(CORPS).fillColor(NOIR).text(s, x + px, y, { width: w - px - 2 * U });
          y += d.heightOfString(s, { width: w - px - 2 * U }) + 1.5;
        }
      });
      this.y += h + g;
    }
    this.y += GAP - g;
  }

  table(b: Extract<Bloc, { t: "table" }>) {
    const d = this.doc;
    const ws = b.colonnes.map((c) => c.part * LARGEUR);
    const p = 1 * U, taille = 8.4;
    const entete = () => {
      const h = 9.2 + 1.8 * U;
      let x = MX;
      d.rect(MX, this.y, LARGEUR, h).fill(TEAL);
      b.colonnes.forEach((c, i) => {
        d.font(T).fontSize(9.2).fillColor("#FFFFFF").text(this.couper(propre(c.titre), ws[i]! - 2 * p), x + p, this.y + 0.9 * U, { lineBreak: false });
        x += ws[i]!;
      });
      this.y += h;
    };
    const hCell = (c: CelluleTable, w: number) =>
      (c.fort ? d.font(BG).fontSize(taille).heightOfString(propre(c.fort), { width: w - 2 * p, lineGap: 1 }) : 0)
      + (c.texte ? d.font(B).fontSize(taille).heightOfString(propre(c.texte), { width: w - 2 * p, lineGap: 1 }) : 0);
    this.place(9.2 + 1.8 * U + 30);
    entete();
    b.lignes.forEach((ligne, r) => {
      const h = Math.max(...ligne.map((c, i) => hCell(c, ws[i]!))) + 2 * p;
      if (this.place(h)) entete();
      if (r % 2 === 1) d.rect(MX, this.y, LARGEUR, h).fill(BLOC);
      let x = MX;
      ligne.forEach((c, i) => {
        let y = this.y + p;
        if (c.fort) {
          d.font(BG).fontSize(taille).fillColor(NOIR).text(propre(c.fort), x + p, y, { width: ws[i]! - 2 * p, lineGap: 1 });
          y += d.heightOfString(propre(c.fort), { width: ws[i]! - 2 * p, lineGap: 1 });
        }
        if (c.texte) d.font(B).fontSize(taille).fillColor(c.fort ? GRIS : NOIR).text(propre(c.texte), x + p, y, { width: ws[i]! - 2 * p, lineGap: 1 });
        x += ws[i]!;
      });
      d.rect(MX, this.y + h - 0.2 * U, LARGEUR, 0.2 * U).fill(FILET);
      this.y += h;
    });
    this.y += GAP;
  }

  jour(b: Extract<Bloc, { t: "jour" }>, dernier: boolean) {
    const d = this.doc;
    const wb = 11 * U, xt = MX + wb + 2.4 * U, wh = 8.5 * U, xi = xt + wh + 1.4 * U, wi = W - MX - xi;
    const hs = b.items.map((it) => d.font(B).fontSize(9.2).heightOfString(propre(it.texte), { width: wi, lineGap: 1 }));
    const hItems = hs.reduce((a, x) => a + x, 0) + Math.max(0, hs.length - 1) * 0.5 * U;
    const hBoite = 1 * U + 5 * U + 2 + 1.9 * U + 1.2 * U;
    const h = Math.max(hBoite, hItems) + 1.6 * U;
    this.place(h);
    d.rect(MX, this.y, wb, hBoite).fill(TEAL);
    d.font(T).fontSize(5 * U).fillColor("#FFFFFF").text(b.numero, MX, this.y + 1 * U, { width: wb, align: "center", lineBreak: false });
    d.font(S).fontSize(1.9 * U).text(propre(b.semaine.toUpperCase()), MX, this.y + 1 * U + 5 * U + 1, { width: wb, align: "center", lineBreak: false, characterSpacing: 0.6 });
    let y = this.y;
    b.items.forEach((it, i) => {
      d.font(T).fontSize(2.45 * U).fillColor(TEAL).text(propre(it.heure), xt, y - 1.2, { width: wh, lineBreak: false });
      d.font(B).fontSize(9.2).fillColor(NOIR).text(propre(it.texte), xi, y + 0.4, { width: wi, lineGap: 1 });
      y += hs[i]! + 0.5 * U;
    });
    this.y += h;
    if (!dernier) d.rect(MX, this.y - 0.2 * U, LARGEUR, 0.2 * U).fill(FILET);
    this.y += 1.6 * U;
  }

  section(s: Section) {
    this.pageInterieure(s.titre, s.sousTitre, false);
    s.blocs.forEach((b, i) => {
      switch (b.t) {
        case "vol": this.blocVol(b); break;
        case "lignes": this.blocLignes(b); break;
        case "h3": this.h3(b.texte); break;
        case "texte": this.texte(b.texte); break;
        case "puces": this.puces(b.items); break;
        case "contacts": this.contacts(b.cartes); break;
        case "table": this.table(b); break;
        case "jour": this.jour(b, s.blocs[i + 1]?.t !== "jour"); break;
      }
    });
  }

  // ── Dos ──
  dos() {
    this.nouvelle();
    const d = this.doc;
    const wl = 52 * U, hl = wl * LOGO_RATIO;
    const s = this.societe;
    const lignes = [
      [s?.telephones[0], s?.email].filter((x): x is string => Boolean(x && x.trim())).join(" · "),
      s?.adresse ?? "",
      siteDe(s),
    ].filter((x) => x.trim()).join("\n");
    const ht = d.font(B).fontSize(2.2 * U).heightOfString(propre(lignes), { width: W - 24 * U, lineGap: 0.7 * 2.2 * U, align: "center" });
    const total = hl + 4 * U + 0.55 * U + 4 * U + ht;
    let y = (H - total) / 2;
    this.image((W - wl) / 2, y, wl);
    y += hl + 4 * U;
    this.barres((W - 30 * U) / 2, y, 30 * U);
    y += 0.55 * U + 4 * U;
    d.font(B).fontSize(2.2 * U).fillColor(GRIS).text(propre(lignes), 12 * U, y, { width: W - 24 * U, align: "center", lineGap: 0.7 * 2.2 * U });
  }
}

/** Dessine le livret. Les octets du logo et des polices sont lus une fois (`chargerAssetsLivret`) et passés ici. */
export async function rendreLivretPdf(livret: Livret, assets?: AssetsLivret): Promise<Buffer> {
  const a = assets ?? (await chargerAssetsLivret());
  const doc = new PDFDocument({
    size: [W, H], margin: 0, autoFirstPage: false,
    info: { Title: propre(livret.nomFichier.replace(/\.pdf$/, "")), Author: livret.societe?.nom ?? "", Subject: livret.type === "GENERAL" ? "Livret de la délégation" : "Livret de séjour" },
  });
  const morceaux: Buffer[] = [];
  doc.on("data", (c: Buffer) => morceaux.push(c));
  const fin = new Promise<Buffer>((resolve, reject) => { doc.on("end", () => resolve(Buffer.concat(morceaux))); doc.on("error", reject); });
  doc.registerFont(S, a.regular);
  doc.registerFont(T, a.bold);
  const logo = (doc as unknown as { openImage: (b: Buffer) => unknown }).openImage(a.logo);
  const dessin = new Dessin(doc, logo, livret.pied, livret.societe ?? null);
  dessin.couverture(livret.couverture);
  dessin.lettre(livret.lettre);
  for (const s of livret.sections) dessin.section(s);
  if (livret.dos) dessin.dos();
  doc.end();
  return fin;
}
