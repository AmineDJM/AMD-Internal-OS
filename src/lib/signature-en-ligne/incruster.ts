import sharp from "sharp";
import QRCode from "qrcode";
import { chargerMupdf } from "@/lib/artifact/adapters/pdf/adapter";
import { ajuster, matricePdf, placement, rectDuQuad, type Qualite, type Rect } from "./placement";

/**
 * INCRUSTER UNE SIGNATURE EN LIGNE DANS LE PDF D'UN BC (Direction, 15/11/2026) — serveur seulement (mupdf, sharp).
 *
 * Sur la DERNIÈRE page : la signature et le cachet de la personne sous la mention « Signature et cachet », puis son SCEAU
 * au pied de la page — un QR qui ouvre la page de vérification, et la mention « Signé électroniquement par … le … ».
 * Le contenu existant de la page est enveloppé (`q … Q`) avant l'ajout : un état graphique laissé ouvert par le
 * générateur ne déplace jamais la signature. Rien d'autre n'est touché ; une signature précédente reste en place.
 */

export interface Apposition {
  qualite: Qualite;
  signature: Buffer;
  cachet: Buffer;
  /** « Signé électroniquement par Assia — Direction Marketing — le 15/11/2026 à 10:42 ». */
  mention: string;
  /** L'adresse de vérification portée par le QR. */
  urlVerification: string;
}

const echapper = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);

/** Le sceau : 900 × 200 px (sa place sur le PDF ne change pas), le texte à droite du QR (180 px). */
const L_SCEAU = 900;
const H_SCEAU = 200;
const X_TEXTE = 210;
export const LARGEUR_TEXTE_SCEAU = L_SCEAU - X_TEXTE - 20;
/** Une chasse moyenne PRUDENTE (DejaVu Sans, lettres accentuées comprises) : 0,6 em par caractère. */
export const CHASSE_SCEAU = 0.6;

/**
 * LES LIGNES DU SCEAU — chacune ENTIÈRE, à la plus grande taille qui tient dans la largeur (recette, 21/11/2026). Coupée à
 * 70 caractères et dessinée en 30 px, la mention sortait du sceau : la qualité, la date — et, pour un Super Admin, « en
 * suppléance » — n'étaient pas sur le PDF ; l'adresse de vérification imprimée perdait la fin de son jeton. La mention
 * arrive en lignes (`\n`) : le nom, la qualité, la date ; l'adresse de vérification suit.
 */
export function lignesDuSceau(mention: string, url: string): { texte: string; taille: number }[] {
  const textes = [...mention.split("\n").map((t) => t.trim()).filter(Boolean), `Vérifier : ${url}`].map((t) => t.slice(0, 140));
  return textes.map((texte, i) => {
    const plafond = i === 0 ? 30 : 24;
    const tient = Math.floor(LARGEUR_TEXTE_SCEAU / (Math.max(1, texte.length) * CHASSE_SCEAU));
    return { texte, taille: Math.max(10, Math.min(plafond, tient)) };
  });
}

/** LE SCEAU : QR + les lignes de la mention et l'adresse de vérification, rendu en PNG (le texte ne dépend d'aucune police du PDF). */
export async function imageDuSceau(mention: string, url: string): Promise<Buffer> {
  const qr = await QRCode.toBuffer(url, { margin: 0, width: 180, errorCorrectionLevel: "M" });
  const lignes = lignesDuSceau(mention, url);
  // Le bloc de texte, centré en hauteur ; le sceau ne grandit que si les lignes ne tiennent pas (jamais à quatre lignes).
  const hauteurs = lignes.map(({ taille }) => Math.round(taille * 1.4));
  const total = hauteurs.reduce((a, b) => a + b, 0);
  const h = Math.max(H_SCEAU, total + 24);
  let y = Math.round((h - total) / 2);
  const textes = lignes.map(({ texte, taille }, i) => {
    y += hauteurs[i];
    return `<text x="${X_TEXTE}" y="${y - Math.round(taille * 0.3)}" font-family="DejaVu Sans, Arial, Helvetica, sans-serif" font-size="${taille}" fill="#0f172a">${echapper(texte)}</text>`;
  });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${L_SCEAU}" height="${h}">
    <rect width="100%" height="100%" fill="white" fill-opacity="0.92"/>
    <rect x="1" y="1" width="${L_SCEAU - 2}" height="${h - 2}" fill="none" stroke="#1d4ed8" stroke-width="3" rx="10"/>
    ${textes.join("")}
  </svg>`;
  return sharp(Buffer.from(svg)).composite([{ input: qr, left: 10, top: 10 }]).png().toBuffer();
}

/** Une image prête à poser : PNG, fond transparent conservé, 800 px au plus. */
export async function normaliserImage(octets: Buffer): Promise<{ png: Buffer; l: number; h: number }> {
  const png = await sharp(octets).rotate().resize({ width: 800, height: 800, fit: "inside", withoutEnlargement: true }).png().toBuffer();
  const m = await sharp(png).metadata();
  return { png, l: m.width ?? 1, h: m.height ?? 1 };
}

/**
 * Combien d'états graphiques (`q`) un flux de contenu laisse ouverts — les chaînes littérales `( … )` et les données
 * d'images en ligne écartées d'abord, pour ne pas compter une lettre « q » de texte comme un opérateur.
 */
export function profondeurOuverte(flux: string): number {
  const sansTexte = flux.replace(/\((?:\\.|[^\\)])*\)/g, " ").replace(/BI[\s\S]*?EI/g, " ");
  let n = 0;
  for (const m of sansTexte.matchAll(/(?:^|\s)([qQ])(?=\s|$)/g)) n += m[1] === "q" ? 1 : -1;
  return n;
}

export async function incruster(pdf: Buffer, a: Apposition): Promise<Buffer> {
  const mupdf = await chargerMupdf();
  const doc = new mupdf.PDFDocument(pdf);
  try {
    const n = doc.countPages();
    if (n < 1) throw new Error("PDF sans page.");
    const page = doc.loadPage(n - 1);
    const [x0, y0, x1, y1] = page.getBounds() as number[];
    const dims = { w: x1 - x0, h: y1 - y0 };
    const hits = page.search("Signature et cachet") as number[][][];
    const ancre = hits.length > 0 ? rectDuQuad(hits[hits.length - 1][0]) : null;
    const ou = placement(dims, ancre ? { ...ancre, x: ancre.x - x0, y: ancre.y - y0 } : null, a.qualite);

    const sceau = await imageDuSceau(a.mention, a.urlVerification);
    const images: { nom: string; png: Buffer; rect: Rect }[] = [];
    for (const [nom, octets, rect] of [["SigAMD", a.signature, ou.signature], ["CachetAMD", a.cachet, ou.cachet], ["SceauAMD", sceau, ou.sceau]] as const) {
      const img = await normaliserImage(octets);
      images.push({ nom: `${nom}${a.qualite === "FINANCES" ? "F" : "M"}`, png: img.png, rect: ajuster(rect, img.l, img.h) });
    }

    const pageObj = page.getObject();
    let ressources = pageObj.getInheritable("Resources");
    if (!ressources || ressources.isNull()) {
      ressources = doc.newDictionary();
      pageObj.put("Resources", ressources);
    }
    ressources = ressources.resolve();
    let xobjets = ressources.get("XObject");
    if (!xobjets || xobjets.isNull()) {
      xobjets = doc.newDictionary();
      ressources.put("XObject", xobjets);
    }
    xobjets = xobjets.resolve();
    const ops: string[] = [];
    for (const im of images) {
      xobjets.put(im.nom, doc.addImage(new mupdf.Image(im.png)));
      const [ma, mb, mc, md, me, mf] = matricePdf(im.rect, dims.h).map((v) => Number(v.toFixed(3)));
      ops.push(`q ${ma} ${mb} ${mc} ${md} ${me} ${mf} cm /${im.nom} Do Q`);
    }
    // Envelopper le contenu existant : « q » avant, autant de « Q » après qu'il en faut pour refermer AUSSI les états que
    // le générateur aurait laissés ouverts (une translation oubliée déplacerait la signature), puis nos images.
    const contenus = pageObj.get("Contents");
    const flux: { readStream(): { asString(): string } }[] = [];
    if (contenus && contenus.isArray()) contenus.forEach((c: never) => flux.push(c));
    else if (contenus && !contenus.isNull()) flux.push(contenus);
    const ouverts = Math.max(0, flux.reduce((n, f) => n + profondeurOuverte(f.readStream().asString()), 0));
    const avant = doc.addStream("q\n", {});
    const apres = doc.addStream(`${"Q\n".repeat(ouverts + 1)}${ops.join("\n")}\n`, {});
    const tableau = doc.newArray();
    tableau.push(avant);
    if (contenus && contenus.isArray()) contenus.forEach((c: unknown) => tableau.push(c));
    else if (contenus && !contenus.isNull()) tableau.push(contenus);
    tableau.push(apres);
    pageObj.put("Contents", tableau);
    return Buffer.from(doc.saveToBuffer("compress").asUint8Array());
  } finally {
    doc.destroy?.();
  }
}
