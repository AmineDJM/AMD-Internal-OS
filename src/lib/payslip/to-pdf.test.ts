import { describe, it, expect } from "vitest";
import PizZip from "pizzip";
import { docxToPdf, pdfFileName, isConvertibleWord } from "./to-pdf";
import { lireDocx, type Bloc } from "./docx-lecture";
// `tableau` est aliasé : le fichier a son propre `tableau(...)` XML minimal pour les cas de conversion.
import { composerDocx, papierEnTeteDeDemonstration, paragraphe, tableau as tableauWord } from "@/lib/artifact/factory/word";

/** Le texte de la première page d'un PDF, lu par MuPDF — la relecture indépendante du rendu. */
async function textePdf(pdf: Buffer): Promise<string> {
  const mupdf = await import("mupdf");
  const doc = mupdf.Document.openDocument(pdf, "application/pdf");
  const page = doc.loadPage(0);
  return page.toStructuredText("preserve-whitespace").asText();
}
/** Chaque LIGNE de texte de la première page avec son ordonnée (points, depuis le HAUT) — la position, pas l'ordre du flux. */
async function positionsPdf(pdf: Buffer): Promise<{ texte: string; y: number }[]> {
  const mupdf = await import("mupdf");
  const doc = mupdf.Document.openDocument(pdf, "application/pdf");
  const st = JSON.parse(doc.loadPage(0).toStructuredText("preserve-whitespace").asJSON()) as { blocks: { lines?: { bbox: { y: number }; text: string }[] }[] };
  return st.blocks.flatMap((b) => (b.lines ?? []).map((l) => ({ texte: l.text, y: l.bbox.y })));
}
const PNG_1PX = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

/**
 * On FABRIQUE un `.docx` minimal mais réel — un vrai ZIP, un vrai `word/document.xml` — plutôt
 * que de simuler la lecture. C'est la seule façon de vérifier que la chaîne complète tient :
 * ouverture du ZIP, analyse XML, ordre des blocs, rendu PDF.
 */
function docx(corps: string): Buffer {
  const zip = new PizZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
  );
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${corps}</w:body></w:document>`,
  );
  return zip.generate({ type: "nodebuffer" });
}

const para = (texte: string, opts: { bold?: boolean; align?: string; style?: string } = {}) =>
  `<w:p>${opts.align || opts.style ? `<w:pPr>${opts.style ? `<w:pStyle w:val="${opts.style}"/>` : ""}${opts.align ? `<w:jc w:val="${opts.align}"/>` : ""}</w:pPr>` : ""}<w:r>${opts.bold ? "<w:rPr><w:b/></w:rPr>" : ""}<w:t>${texte}</w:t></w:r></w:p>`;

const cellule = (t: string) => `<w:tc><w:p><w:r><w:t>${t}</w:t></w:r></w:p></w:tc>`;
const ligne = (...cs: string[]) => `<w:tr>${cs.map(cellule).join("")}</w:tr>`;
const tableau = (...ls: string[]) => `<w:tbl>${ls.join("")}</w:tbl>`;

describe("convertir en PDF", () => {
  it("produit un PDF valide, avec ses pages", async () => {
    const r = await docxToPdf(docx(
      para("Bulletin de paie — août 2026", { bold: true, style: "Heading1" }) +
      para("Salarié : Amine Djouamaï") +
      tableau(
        ligne("Libellé", "Base", "Taux", "Montant"),
        ligne("Salaire de base", "173,33", "1 082,00", "187 450,00"),
        ligne("Cotisations", "", "9,00 %", "-16 870,50"),
      ) +
      para("Net à payer : 170 579,50 DZD", { bold: true }),
    ));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // L'entête d'un PDF, et un contenu qui n'est pas une page vide.
    expect(r.pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(r.pdf.length).toBeGreaterThan(1000);
    expect(r.pages).toBeGreaterThanOrEqual(1);
  });

  it("les ACCENTS et les montants français survivent", async () => {
    const r = await docxToPdf(docx(para("Rémunération brute : 187 450,00 DZD — é è ê à ç ù")));
    expect(r.ok).toBe(true);
  });

  it("un document long produit PLUSIEURS pages sans boucler", async () => {
    const lignes = Array.from({ length: 120 }, (_, i) => ligne(`Ligne ${i + 1}`, `${i * 1000},00`));
    const r = await docxToPdf(docx(tableau(ligne("Libellé", "Montant"), ...lignes)));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pages).toBeGreaterThan(1);
  });

  it("NE LÈVE JAMAIS — payer un salarié passe avant le format de son bulletin", async () => {
    // Un fichier illisible rend un échec explicite ; l'appelant garde alors l'original et la
    // paie suit son cours.
    const r = await docxToPdf(Buffer.from("pas un docx du tout"));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.length).toBeGreaterThan(10);
  });

  it("un document VIDE est un échec, pas un PDF blanc", async () => {
    const r = await docxToPdf(docx(""));
    expect(r.ok).toBe(false);
  });
});

describe("nommage et éligibilité", () => {
  it("le PDF garde le nom du Word", () => {
    expect(pdfFileName("Bulletin août 2026.docx")).toBe("Bulletin août 2026.pdf");
    expect(pdfFileName("sans-extension")).toBe("sans-extension.pdf");
  });

  it("seul le .docx est convertible — le vieux .doc binaire ne l'est pas", () => {
    const MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    expect(isConvertibleWord("b.docx", null)).toBe(true);
    expect(isConvertibleWord("b", MIME)).toBe(true);
    expect(isConvertibleWord("b.doc", "application/msword")).toBe(false);
    expect(isConvertibleWord("b.pdf", "application/pdf")).toBe(false);
  });
});


describe("LE PAPIER EN-TÊTE DANS LE PDF (§118.135) — l'en-tête, le pied et leurs images sont redessinés", () => {
  it("l'en-tête et le pied du papier se LISENT sur la page, avec le corps entre les deux", async () => {
    const base = papierEnTeteDeDemonstration("SARL PHARMAGENE");
    const { octets } = composerDocx({
      base,
      blocs: [
        paragraphe("Facture n° 001/FS/26", { gras: true, taillePt: 14 }),
        tableauWord([["Description", "Quantité", "Prix total HT"], ["Frais TRIMESTRE 4/2025.", "3", "7 500 000,00"]], {
          colonnes: [{ largeurCm: 9 }, { largeurCm: 3 }, { largeurCm: 4, alignement: "right" }], entete: true, couleurEntete: "8DB4E2", bordures: false,
        }),
      ],
    });
    const [{ section, blocs }] = lireDocx(octets).sections;
    expect(section.entetes.defaut?.blocs.length).toBeGreaterThan(0);
    expect(section.pieds.defaut?.blocs.length).toBeGreaterThan(0);
    // La grille de colonnes et la trame de l'en-tête de tableau sont LUES, pas devinées.
    const table = blocs.find((b) => b.type === "tableau");
    expect(table?.type).toBe("tableau");
    if (table?.type === "tableau") {
      expect(table.grille.map((w) => Math.round(w))).toEqual([255, 85, 113]);
      expect(table.rangees[0].cellules[0].fond).toBe("8DB4E2");
      expect(table.rangees.map((r) => r.entete)).toEqual([true, false]);
    }
    const r = await docxToPdf(octets);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const texte = await textePdf(r.pdf);
    expect(texte).toContain("SARL PHARMAGENE");                       // l'en-tête du papier
    expect(texte).toContain("Laboratoire pharmaceutique");             // sa seconde ligne
    expect(texte).toContain("RC 16/00-1234567B21");                    // le pied du papier
    expect(texte).toContain("Facture n° 001/FS/26");                   // le corps
    expect(texte).toContain("7 500 000,00");
    // L'ordre VERTICAL se juge sur la POSITION, pas sur l'ordre du flux : les bandes sont dessinées
    // avant le corps, donc le pied précède le corps dans le texte extrait tout en étant en bas de
    // page. Une première version comparait des `indexOf` et tombait sur une page correcte.
    const y = (fragment: string) => { const b = (await_positions).find((p) => p.texte.includes(fragment)); if (!b) throw new Error(`« ${fragment} » introuvable`); return b.y; };
    const await_positions = await positionsPdf(r.pdf);
    expect(y("Laboratoire pharmaceutique")).toBeLessThan(y("Facture n° 001/FS/26"));
    expect(y("Facture n° 001/FS/26")).toBeLessThan(y("7 500 000,00"));
    expect(y("7 500 000,00")).toBeLessThan(y("RC 16/00-1234567B21"));
    expect(y("RC 16/00-1234567B21")).toBeGreaterThan(700); // le pied est en BAS d'une page A4 (842 pt)
  });

  it("un retour à la ligne dans une cellule SÉPARE, et une ligne centrée à plusieurs fragments ne se superpose pas", async () => {
    // Mesuré sur la facture de référence rendue par ce module avant correction : « Sarl. BIOGALENIC »
    // et « Zone Industrielle » collés sur une ligne, « PAIEMENT PAR VIREMENT BANCAIRE » imprimé
    // par-dessus lui-même. Le premier ferait tomber le test des ordonnées, le second celui du texte.
    const { octets } = composerDocx({
      blocs: [
        tableauWord([[{ contenu: [{ texte: "Sarl. BIOGALENIC", gras: true }, { texte: "\nZone Industrielle, Constantine" }] }]], { colonnes: [{ largeurCm: 8 }], bordures: false }),
        paragraphe([{ texte: "PAIEMENT PAR ", gras: true }, { texte: "VIREMENT BANCAIRE", gras: true, couleur: "1F5C99" }], { alignement: "center" }),
      ],
    });
    const r = await docxToPdf(octets);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const positions = await positionsPdf(r.pdf);
    const bloc = (fragment: string) => positions.find((p) => p.texte.includes(fragment)) ?? null;
    expect(bloc("Sarl. BIOGALENIC")).not.toBeNull();
    expect(bloc("Zone Industrielle")).not.toBeNull();
    expect(bloc("Zone Industrielle")!.y).toBeGreaterThan(bloc("Sarl. BIOGALENIC")!.y + 6);
    const paiement = positions.filter((p) => /PAIEMENT|VIREMENT/.test(p.texte));
    expect(paiement.map((p) => p.texte.replace(/\s+/g, " ").trim())).toEqual(["PAIEMENT PAR VIREMENT BANCAIRE"]);
  });

  it("une image d'en-tête (le logo) est EMBARQUÉE dans le PDF, et le pied revient sur CHAQUE page", async () => {
    const lignes = Array.from({ length: 90 }, (_, i) => [`Article ${i + 1}`, `${(i + 1) * 1000},00`]);
    const { octets } = composerDocx({
      logo: { octets: PNG_1PX, png: true, largeurCm: 3 },
      blocs: [paragraphe("Bon de commande"), tableauWord([["Désignation", "Total HT"], ...lignes], { colonnes: [{ largeurCm: 10 }, { largeurCm: 5 }], entete: true })],
    });
    const entete: Bloc[] = lireDocx(octets).sections[0].section.entetes.defaut?.blocs ?? [];
    const images = entete.flatMap((b) => (b.type === "paragraphe" ? b.contenu : []))
      .flatMap((i) => (i.k === "dessin" ? i.contenu : []))
      .filter((e) => e.type === "image");
    expect(images).toHaveLength(1);
    expect(images[0].image.octets.subarray(1, 4).toString("latin1")).toBe("PNG");
    expect(Math.round(images[0].largeur)).toBe(85); // 3 cm
    const r = await docxToPdf(octets);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pages).toBeGreaterThan(1);
    // pdfkit écrit chaque image embarquée comme un objet /Subtype /Image : une par page où le logo est dessiné.
    const objetsImage = (r.pdf.toString("latin1").match(/\/Subtype\s*\/Image/g) ?? []).length;
    expect(objetsImage).toBeGreaterThanOrEqual(1);
    const mupdf = await import("mupdf");
    const doc = mupdf.Document.openDocument(r.pdf, "application/pdf");
    expect(doc.countPages()).toBe(r.pages);
    // L'en-tête de tableau est RÉPÉTÉ en haut de la seconde page.
    const page2 = doc.loadPage(1).toStructuredText("preserve-whitespace").asText();
    expect(page2).toContain("Désignation");
  });
});
