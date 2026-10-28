import crypto from "crypto";
import JSZip from "jszip";
import { nomReduit, profilReduction, reductionRetenue, typeReduit, type NatureReduction } from "./politique";
import { zipUneEntree } from "./zip-ecriture";
import { listerZip, lireEntreeZip, sourceTampon } from "@/lib/storage/zip-lecteur";
import { sansBloquer } from "@/lib/journal";

/**
 * LA VERSION « TAILLE RÉDUITE » D'UN FICHIER — ce qu'on propose à côté de l'original au
 * téléchargement. Elle n'est JAMAIS stockée, ne remplace JAMAIS l'original et ne sert à aucun
 * contrôle, signature ou contrat : c'est une copie de confort, produite à la demande.
 *
 * Principe : pas de perte VISIBLE, et le DIRE quand il y a une perte.
 *   • JPEG  : ré-encodé à la qualité 80, côté ≤ 4096 px (la seule perte de ce module — dite) ;
 *   • PNG, TIFF : SANS PERTE (recompression), pixels comparés à l'original avant d'être rendus ;
 *   • PDF   : réécriture SANS PERTE (objets dédupliqués, flux compressés) par mupdf ; jamais pour un
 *     PDF signé, chiffré, PDF/A (la conformité d'archivage est ce qu'il faut garder), ni réparé ;
 *     le nombre de pages et le texte des pages sont relus avant d'être rendus ;
 *   • Office (DOCX/XLSX/PPTX) : médias internes (JPEG, PNG) optimisés, tout le reste recopié OCTET
 *     POUR OCTET ; structure et contenus relus ;
 *   • texte (CSV, JSON, XML, HTML…) : une archive ZIP (deflate 9), relue.
 *
 * Tout est refusé (`ok: false`, avec sa raison) quand le résultat n'est pas au moins
 * `GAIN_MIN_REDUCTION` plus petit, ou quand sa relecture échoue : un « réduit » plus gros, ou
 * qu'on ne saurait pas rouvrir, serait pire que de ne rien proposer (§118.27).
 */

export type ResultatReduction =
  | { ok: true; octets: Buffer; nom: string; mime: string; methode: string }
  | { ok: false; raison: string };

const ko = (raison: string): { ok: false; raison: string } => ({ ok: false, raison });

/** Une réduction est un travail de processeur : deux à la fois au plus, les autres attendent (une page ne se met pas à ramer pour ça). */
const MAX_SIMULTANEES = 2;
let enCours = 0;
const attente: (() => void)[] = [];
async function avecPlace<T>(f: () => Promise<T>): Promise<T> {
  if (enCours >= MAX_SIMULTANEES) await new Promise<void>((r) => attente.push(r));
  enCours++;
  try { return await f(); } finally { enCours--; attente.shift()?.(); }
}

const MAX_COTE_JPEG = 4096;
const QUALITE_JPEG = 80;
const MAX_PIXELS_JPEG = 80_000_000;
/** Un PNG ou un TIFF se compare pixel à pixel : le tampon décodé d'un côté tient en mémoire — 25 Mpx ≈ 100 Mo. */
const MAX_PIXELS_SANS_PERTE = 25_000_000;
/** Un document Office qui se décompresse au-delà de cette taille n'est pas ouvert (« bombe » de décompression). */
const MAX_DECOMPRESSE_OFFICE = 500 * 1024 * 1024;
const MIN_MEDIA_OFFICE = 100 * 1024;
const QUALITE_JPEG_OFFICE = 85;

async function sharpModule() { return (await import("sharp")).default; }

/** Empreinte des PIXELS (RGBA 8 bits) : comparer deux images, pas deux fichiers. */
async function empreintePixels(sharp: Awaited<ReturnType<typeof sharpModule>>, octets: Buffer): Promise<{ hash: string; l: number; h: number }> {
  const { data, info } = await sharp(octets, { limitInputPixels: MAX_PIXELS_SANS_PERTE }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { hash: crypto.createHash("sha256").update(data).digest("hex"), l: info.width, h: info.height };
}

// ─────────────────────────────────────────── images ────────────────────────────────────────

async function reduireJpeg(buf: Buffer, qualite = QUALITE_JPEG, maxCote = MAX_COTE_JPEG): Promise<ResultatReduction> {
  if (!(buf[0] === 0xff && buf[1] === 0xd8)) return ko("Le contenu n'est pas un JPEG.");
  const sharp = await sharpModule();
  const entree = sharp(buf, { limitInputPixels: MAX_PIXELS_JPEG, failOn: "error" });
  const meta = await entree.metadata();
  if (!meta.width || !meta.height) return ko("Image illisible.");
  const orient = meta.orientation ?? 1;
  const [lo, ho] = orient >= 5 ? [meta.height, meta.width] : [meta.width, meta.height]; // dimensions APRÈS redressement
  // `rotate()` applique l'orientation EXIF : sans lui, retirer les métadonnées coucherait la photo.
  const sortie = await entree.rotate().resize({ width: maxCote, height: maxCote, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: qualite, progressive: true }).toBuffer();
  const m2 = await sharp(sortie).metadata();
  if (m2.format !== "jpeg" || !m2.width || !m2.height) return ko("Relecture de l'image réduite impossible.");
  // Même cadrage (au pixel d'arrondi près) : une photo réduite ne change pas de proportions.
  if (Math.abs(m2.width / m2.height - lo / ho) > 0.01 * (lo / ho)) return ko("Proportions inattendues après réduction.");
  return { ok: true, octets: sortie, nom: "", mime: "image/jpeg", methode: `JPEG qualité ${qualite}${m2.width < lo ? `, côté ≤ ${maxCote} px` : ""}` };
}

async function reduireSansPerte(buf: Buffer, format: "png" | "tiff"): Promise<ResultatReduction> {
  const sharp = await sharpModule();
  const meta = await sharp(buf, { limitInputPixels: MAX_PIXELS_SANS_PERTE }).metadata().catch(sansBloquer("reduction.reduireSansPerte.metadata", null));
  if (!meta || !meta.width || !meta.height) return ko("Image illisible ou trop grande pour être optimisée ici.");
  if ((meta.pages ?? 1) > 1) return ko("Image animée ou à plusieurs pages : conservée telle quelle.");
  if (meta.depth !== "uchar") return ko("Profondeur de couleur élevée (16 bits) : conservée telle quelle.");
  const avant = await empreintePixels(sharp, buf);
  const base = sharp(buf, { limitInputPixels: MAX_PIXELS_SANS_PERTE });
  const sortie = format === "png"
    ? await base.png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer()
    : await base.tiff({ compression: "deflate", predictor: "horizontal" }).toBuffer();
  // SANS PERTE se PROUVE : les pixels décodés des deux côtés doivent être identiques.
  const apres = await empreintePixels(sharp, sortie);
  if (apres.hash !== avant.hash || apres.l !== avant.l || apres.h !== avant.h) return ko("Les pixels ne retombent pas à l'identique : version réduite écartée.");
  return { ok: true, octets: sortie, nom: "", mime: format === "png" ? "image/png" : "image/tiff", methode: `${format.toUpperCase()} recompressé sans perte` };
}

// ───────────────────────────────────────────── PDF ─────────────────────────────────────────

const PAGES_COMPAREES = 40;

async function reduirePdf(buf: Buffer): Promise<ResultatReduction> {
  if (buf.subarray(0, 5).toString("latin1") !== "%PDF-") return ko("Le contenu n'est pas un PDF.");
  // Ce qu'une réécriture RUINERAIT, détecté sur les octets avant toute ouverture.
  if (buf.includes("/ByteRange")) return ko("PDF signé électroniquement : la réécriture invaliderait la signature — original seulement.");
  if (buf.includes("/Encrypt")) return ko("PDF chiffré : conservé tel quel.");
  if (buf.includes("pdfaid:part")) return ko("PDF/A : la conformité d'archivage est conservée — original seulement.");
  const mupdf = await import("mupdf");
  let doc: ReturnType<typeof mupdf.Document.openDocument> | null = null;
  let relu: ReturnType<typeof mupdf.Document.openDocument> | null = null;
  try {
    doc = mupdf.Document.openDocument(new Uint8Array(buf), "application/pdf");
    const pdf = doc.asPDF();
    if (!pdf) return ko("Ce n'est pas un PDF lisible.");
    if (pdf.needsPassword()) return ko("PDF protégé par mot de passe : conservé tel quel.");
    if (pdf.wasRepaired()) return ko("PDF endommagé (réparé à l'ouverture) : conservé tel quel.");
    const pages = pdf.countPages();
    const sortie = Buffer.from(pdf.saveToBuffer("garbage=deduplicate,compress,objstms").asUint8Array());
    relu = mupdf.Document.openDocument(new Uint8Array(sortie), "application/pdf");
    if (relu.countPages() !== pages) return ko("Le nombre de pages ne retombe pas : version réduite écartée.");
    // RELIRE : le texte des premières et dernières pages doit être identique (la réécriture ne touche pas au contenu).
    const idx = new Set<number>();
    for (let i = 0; i < Math.min(pages, PAGES_COMPAREES / 2); i++) idx.add(i);
    for (let i = Math.max(0, pages - PAGES_COMPAREES / 2); i < pages; i++) idx.add(i);
    for (const i of idx) {
      const a = pdf.loadPage(i); const b = relu.loadPage(i);
      try {
        if (a.toStructuredText().asText() !== b.toStructuredText().asText()) return ko(`Le texte de la page ${i + 1} ne retombe pas : version réduite écartée.`);
        const ra = a.getBounds(); const rb = b.getBounds();
        if (ra.join(",") !== rb.join(",")) return ko(`Le format de la page ${i + 1} ne retombe pas : version réduite écartée.`);
      } finally { a.destroy?.(); b.destroy?.(); }
    }
    return { ok: true, octets: sortie, nom: "", mime: "application/pdf", methode: "PDF réécrit sans perte" };
  } catch (e) {
    return ko(`PDF non optimisable ici (${e instanceof Error ? e.message.slice(0, 80) : "erreur"}).`);
  } finally {
    doc?.destroy?.(); relu?.destroy?.();
  }
}

// ────────────────────────────────────────── Office ─────────────────────────────────────────

const MEDIA_OFFICE = /^(word|xl|ppt)\/media\/.+\.(jpe?g|png)$/i;
const DEJA_COMPRESSE = /\.(jpe?g|png|gif|webp|zip|docx|xlsx|pptx|mp4|mp3|m4a|mov|7z|gz)$/i;

async function reduireOffice(buf: Buffer): Promise<ResultatReduction> {
  if (!(buf[0] === 0x50 && buf[1] === 0x4b)) return ko("Le contenu n'est pas un document Office.");
  let source: JSZip;
  try { source = await JSZip.loadAsync(buf); } catch { return ko("Archive Office illisible : conservée telle quelle."); }
  const noms = Object.keys(source.files);
  if (!source.files["[Content_Types].xml"]) return ko("Document Office sans table des types : conservé tel quel.");
  const sortie = new JSZip();
  const modifies = new Map<string, "jpeg" | "png">();
  let decompresse = 0;
  for (const n of noms) {
    const e = source.files[n];
    if (e.dir) { sortie.file(n, "", { dir: true, date: e.date, createFolders: false }); continue; }
    let data: Buffer = await e.async("nodebuffer");
    decompresse += data.length;
    if (decompresse > MAX_DECOMPRESSE_OFFICE) return ko("Document trop volumineux une fois décompressé : conservé tel quel.");
    if (MEDIA_OFFICE.test(n) && data.length >= MIN_MEDIA_OFFICE) {
      const jpeg = /\.jpe?g$/i.test(n);
      // Même format en sortie : les relations et les types du document restent justes sans y toucher.
      const r = jpeg ? await reduireJpeg(data, QUALITE_JPEG_OFFICE, MAX_COTE_JPEG).catch(sansBloquer("reduction.reduireOffice.reduireJpeg", null)) : await reduireSansPerte(data, "png").catch(sansBloquer("reduction.reduireOffice.reduireSansPerte", null));
      if (r?.ok && reductionRetenue(data.length, r.octets.length)) { data = r.octets; modifies.set(n, jpeg ? "jpeg" : "png"); }
    }
    // Les médias déjà compressés sont STOCKÉS : le deflate ne les réduit pas et les alourdit parfois.
    sortie.file(n, data, { date: e.date, createFolders: false, compression: DEJA_COMPRESSE.test(n) ? "STORE" : "DEFLATE", compressionOptions: { level: 9 } });
  }
  const octets = await sortie.generateAsync({ type: "nodebuffer", platform: "UNIX" });
  // RELIRE : mêmes entrées, dans le même ordre ; tout ce qu'on n'a pas touché est identique OCTET POUR OCTET ;
  // chaque média touché se décode, dans son format d'origine.
  let relu: JSZip;
  try { relu = await JSZip.loadAsync(octets); } catch { return ko("Relecture du document réduit impossible : version écartée."); }
  const noms2 = Object.keys(relu.files);
  if (noms2.length !== noms.length || noms2.some((n, i) => n !== noms[i])) return ko("La liste des fichiers du document ne retombe pas : version écartée.");
  const sharp = await sharpModule();
  for (const n of noms) {
    if (source.files[n].dir) continue;
    const apres = await relu.files[n].async("nodebuffer");
    if (modifies.has(n)) {
      const m = await sharp(apres).metadata().catch(sansBloquer("reduction.reduireOffice.metadata", null));
      if (!m || m.format !== modifies.get(n)) return ko(`L'image « ${n} » ne se relit pas : version écartée.`);
    } else {
      const avant = await source.files[n].async("nodebuffer");
      if (!apres.equals(avant)) return ko(`« ${n} » ne retombe pas à l'identique : version écartée.`);
    }
  }
  const methode = modifies.size > 0 ? `${modifies.size} image(s) du document optimisée(s), le reste intact` : "document recompressé, contenu intact";
  return { ok: true, octets, nom: "", mime: "", methode };
}

// ─────────────────────────────────────────── texte ─────────────────────────────────────────

async function reduireTexte(buf: Buffer, nom: string): Promise<ResultatReduction> {
  const archive = await zipUneEntree(nom, buf);
  // RELIRE avec notre propre lecteur de ZIP (indépendant de l'écrivain) : une entrée, mêmes octets.
  const src = sourceTampon(archive);
  const { entrees } = await listerZip(src);
  if (entrees.length !== 1) return ko("Archive inattendue : version écartée.");
  const relu = await lireEntreeZip(src, entrees[0], buf.length + 1);
  if (!relu.equals(buf)) return ko("Le texte archivé ne retombe pas à l'identique : version écartée.");
  return { ok: true, octets: archive, nom: "", mime: "application/zip", methode: "archive ZIP compressée (deflate 9)" };
}

// ───────────────────────────────────────── point d'entrée ───────────────────────────────────

/**
 * Produit la version réduite d'un fichier, ou dit pourquoi pas. Le profil statique est jugé
 * d'abord (sans rien lire de plus) ; l'opération elle-même passe par une file de deux travaux.
 */
export async function reduire(octets: Buffer, nom: string, mime: string | null): Promise<ResultatReduction> {
  const profil = profilReduction(nom, mime, octets.length);
  if (!profil.nature) return ko(profil.raison || "Déjà optimisé.");
  const nature: NatureReduction = profil.nature;
  const brut = await avecPlace(async (): Promise<ResultatReduction> => {
    try {
      switch (nature) {
        case "jpeg": return await reduireJpeg(octets);
        case "png": return await reduireSansPerte(octets, "png");
        case "tiff": return await reduireSansPerte(octets, "tiff");
        case "pdf": return await reduirePdf(octets);
        case "office": return await reduireOffice(octets);
        case "texte": return await reduireTexte(octets, nom);
        default: return ko("Déjà optimisé.");
      }
    } catch (e) {
      return ko(`Optimisation impossible (${e instanceof Error ? e.message.slice(0, 80) : "erreur"}) — original seulement.`);
    }
  });
  if (!brut.ok) return brut;
  // L'exigence de fond : plus petit d'au moins GAIN_MIN_REDUCTION. Sinon, pas d'offre.
  if (!reductionRetenue(octets.length, brut.octets.length)) return ko("Déjà optimisé : aucune version sensiblement plus petite.");
  return { ...brut, nom: nomReduit(nom, nature), mime: brut.mime || typeReduit(nature, mime ?? "application/octet-stream") };
}
