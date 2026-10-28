import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import PizZip from "pizzip";
import { docxToPdf } from "./to-pdf";
import { lireDocx } from "./docx-lecture";
import { remplirOrdreDeMission, VALEURS_DU_MODELE } from "@/modules/rh/api";

/**
 * LA FIDÉLITÉ DU PDF, MESURÉE CONTRE WORD.
 *
 * La Direction a jugé le rendu sur l'ordre de mission : « le PDF ne reproduit que le texte ». Les
 * cotes ci-dessous ont été RELEVÉES sur le PDF que Word lui-même exporte du même ordre de mission
 * rempli (Word 365, export PDF) : ligne de base de chaque ligne, position de chaque image. Le rendu
 * du serveur doit tomber dessus à 1,5 pt près — avec la vraie police comme avec la police standard
 * de repli (cas du serveur Linux sans Calibri).
 */

const MODELE = readFileSync(path.join(__dirname, "../../modules/rh/infra/ordre-mission/modele-ordre-de-mission.docx"));

async function ordreDeMission(): Promise<Buffer> {
  return remplirOrdreDeMission(MODELE, {
    dateEmission: "2026-07-23",
    reference: "007/DPG/2026",
    entreprise: VALEURS_DU_MODELE.entreprise,
    adresse: VALEURS_DU_MODELE.adresse,
    collaborateur: "Mme Radia KEBIR",
    fonction: "Déléguée médicale",
    objet: "de récupérer une commande de produits pharmaceutiques auprès du laboratoire « SAIDAL » et d’assurer sa livraison — en toute sécurité — au dépôt central",
    destination: "Constantine",
    datesDepart: ["2026-07-23", "2026-07-24"],
    datesRetour: ["2026-07-25"],
    transport: "Véhicule de service",
    signataire: VALEURS_DU_MODELE.signataire,
    signataireFonction: VALEURS_DU_MODELE.signataireFonction,
  });
}

interface LigneLue { texte: string; x: number; base: number; police: string }

/** Chaque ligne de la page : son texte, l'origine (ligne de base) de son premier caractère, sa police. */
async function lignes(pdf: Buffer, page = 0): Promise<LigneLue[]> {
  const mupdf = await import("mupdf");
  const doc = mupdf.Document.openDocument(pdf, "application/pdf");
  const out: LigneLue[] = [];
  let cur: LigneLue | null = null;
  doc.loadPage(page).toStructuredText("preserve-whitespace").walk({
    beginLine() { cur = { texte: "", x: Number.NaN, base: Number.NaN, police: "" }; },
    onChar(c: string, origin: [number, number], font: { getName(): string }) {
      if (!cur) return;
      if (Number.isNaN(cur.x) && c.trim()) { cur.x = origin[0]; cur.base = origin[1]; cur.police = font.getName(); }
      cur.texte += c;
    },
    endLine() { if (cur && cur.texte.trim()) out.push({ ...cur, texte: cur.texte.trim() }); cur = null; },
  });
  return out;
}

async function images(pdf: Buffer): Promise<{ x: number; y: number; w: number; h: number }[]> {
  const mupdf = await import("mupdf");
  const doc = mupdf.Document.openDocument(pdf, "application/pdf");
  const st = JSON.parse(doc.loadPage(0).toStructuredText("preserve-images").asJSON()) as { blocks: { type: string; bbox: { x: number; y: number; w: number; h: number } }[] };
  return st.blocks.filter((b) => b.type === "image").map((b) => b.bbox);
}

interface Segment { x1: number; y1: number; x2: number; y2: number }
interface Aplat { couleur: string; x: number; y: number; w: number; h: number }

/** Les filets tracés (segments) et les aplats remplis de la page, en coordonnées de page (y vers le bas). */
async function dessins(pdf: Buffer, page = 0): Promise<{ filets: Segment[]; aplats: Aplat[] }> {
  const mupdf = await import("mupdf");
  const filets: Segment[] = [];
  const aplats: Aplat[] = [];
  const pts = (chemin: { walk(w: { moveTo?(x: number, y: number): void; lineTo?(x: number, y: number): void }): void }, m: number[]) => {
    const out: [number, number][] = [];
    const t = (x: number, y: number): [number, number] => [m[0]! * x + m[2]! * y + m[4]!, m[1]! * x + m[3]! * y + m[5]!];
    chemin.walk({ moveTo: (x, y) => out.push(t(x, y)), lineTo: (x, y) => out.push(t(x, y)) });
    return out;
  };
  const hex = (c: number[]) => c.map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("").toUpperCase();
  const device = new mupdf.Device({
    strokePath(chemin, _trait, ctm) {
      const p = pts(chemin, ctm as unknown as number[]);
      for (let i = 1; i < p.length; i++) filets.push({ x1: p[i - 1]![0], y1: p[i - 1]![1], x2: p[i]![0], y2: p[i]![1] });
    },
    fillPath(chemin, _eo, ctm, _cs, couleur) {
      const p = pts(chemin, ctm as unknown as number[]);
      if (p.length === 0) return;
      const xs = p.map((q) => q[0]), ys = p.map((q) => q[1]);
      aplats.push({ couleur: hex(couleur), x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) });
    },
  });
  mupdf.Document.openDocument(pdf, "application/pdf").loadPage(page).run(device, mupdf.Matrix.identity);
  device.close();
  return { filets, aplats };
}

const ligne = (ls: LigneLue[], debut: string): LigneLue => {
  const l = ls.find((x) => x.texte.startsWith(debut));
  if (!l) throw new Error(`« ${debut} » introuvable dans : ${ls.map((x) => x.texte).join(" | ")}`);
  return l;
};

/** Les cotes relevées sur l'export PDF de Word (points, depuis le haut de la page A4). */
const WORD = {
  date: { x: 355.3, base: 132.4 },
  titre: { x: 202.6, base: 172.7 },
  entreprise: 229.9,
  adresse: 244.6,
  objet: [333.05, 347.7, 362.3, 377.0],
  lieu: 407.1,
  destination: 436.1,
  depart: 495.3,
  mode: 569.1,
  signataire: { x: 319.9, base: 597.7 },
  fonctionSignataire: 612.4,
  logo: { x: 37, y: 36.6, w: 515, h: 57 },
  pied: { x: 51, y: 727.6, w: 493, h: 93.5 },
};

describe("l'ordre de mission de la Direction, rendu comme Word l'imprime", () => {
  for (const policesSysteme of [true, false]) {
    const mode = policesSysteme ? "police du système quand elle existe" : "police standard de repli (serveur sans Calibri)";

    it(`une page, l'en-tête et le pied avec leurs IMAGES, à leur place — ${mode}`, async () => {
      const r = await docxToPdf(await ordreDeMission(), { policesSysteme });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.pages).toBe(1);
      // Deux images embarquées (logo d'en-tête, bandeau de pied) — et pas une par dessin : pdfkit
      // écrit chaque image une fois, plus son masque de transparence.
      const objets = (r.pdf.toString("latin1").match(/\/Subtype\s*\/Image/g) ?? []).length;
      expect(objets).toBeGreaterThanOrEqual(2);
      const ims = await images(r.pdf);
      expect(ims).toHaveLength(2);
      const [logo, pied] = [...ims].sort((a, b) => a.y - b.y);
      for (const [lu, attendu] of [[logo!, WORD.logo], [pied!, WORD.pied]] as const) {
        expect(Math.abs(lu.x - attendu.x)).toBeLessThan(1.5);
        expect(Math.abs(lu.y - attendu.y)).toBeLessThan(1.5);
        expect(Math.abs(lu.w - attendu.w)).toBeLessThan(1.5);
        expect(Math.abs(lu.h - attendu.h)).toBeLessThan(1.5);
      }
    });

    it(`chaque ligne tombe où Word la met : tabulations, centrage, tailles, espacements — ${mode}`, async () => {
      const r = await docxToPdf(await ordreDeMission(), { policesSysteme });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const ls = await lignes(r.pdf);
      const proche = (v: number, attendu: number) => expect(Math.abs(v - attendu), `${v} ≠ ${attendu}`).toBeLessThan(1.5);

      // « Date, le … » poussée à droite par huit tabulations par défaut (8 × 35,4 pt).
      const date = ligne(ls, "Date, le 23/07/2026");
      proche(date.x, WORD.date.x);
      proche(date.base, WORD.date.base);
      // Le titre, centré, en gras.
      const titre = ligne(ls, "ORDRE DE MISSION N° 007/DPG/2026");
      proche(titre.x, WORD.titre.x);
      proche(titre.base, WORD.titre.base);
      expect(titre.police).toMatch(/Bold/i);
      proche(ligne(ls, "Entreprise :").base, WORD.entreprise);
      expect(ligne(ls, "Entreprise :").police).toMatch(/Bold/i);
      proche(ligne(ls, "Adresse :").base, WORD.adresse);
      // L'objet de la mission : quatre lignes, coupées aux mêmes mots que Word.
      const objet = ls.filter((l) => l.base > 320 && l.base < 380);
      expect(objet.map((l) => l.texte.split(" ")[0])).toEqual(["Le", "effectuer", "produits", "toute"]);
      objet.forEach((l, i) => proche(l.base, WORD.objet[i]!));
      // Les intertitres en 13,5 pt, gras.
      proche(ligne(ls, "Lieu de la mission").base, WORD.lieu);
      proche(ligne(ls, "Destination :").base, WORD.destination);
      proche(ligne(ls, "Date de départ :").base, WORD.depart);
      proche(ligne(ls, "Mode de transport :").base, WORD.mode);
      // Le signataire, poussé à droite par sept tabulations.
      const sig = ligne(ls, "M. DJOUAMAI Redouane");
      proche(sig.x, WORD.signataire.x);
      proche(sig.base, WORD.signataire.base);
      proche(ligne(ls, "Directeur Des Ressources Humaines").base, WORD.fonctionSignataire);
      // Les caractères français survivent tels quels.
      const tout = ls.map((l) => l.texte).join("\n");
      for (const s of ["Cité des Moudjahidine", "Chéraga", "« SAIDAL »", "d’assurer", "— en", "Véhicule de service", "Déléguée médicale"]) expect(tout).toContain(s);
    });
  }

  it("les intertitres sont SOULIGNÉS (des filets tracés sous le texte, pas seulement du gras)", async () => {
    const r = await docxToPdf(await ordreDeMission());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { filets } = await dessins(r.pdf);
    const horizontaux = filets.filter((s) => Math.abs(s.y1 - s.y2) < 0.01);
    // Sous le titre (172,7), sous « Lieu de la mission : » (407,1) et sous « Durée de la mission » (466,3) —
    // et pas sous « Moyens de transport », que le modèle ne souligne pas.
    for (const base of [172.7, 407.1, 466.3]) expect(horizontaux.some((s) => s.y1 > base && s.y1 < base + 3.5), `pas de soulignement sous ${base}`).toBe(true);
    expect(horizontaux.some((s) => s.y1 > 540.1 && s.y1 < 543.6)).toBe(false);
    // Le soulignement du titre court sous tout le titre (≈ 190 pt), pas sous un seul mot.
    const sousTitre = horizontaux.filter((s) => s.y1 > 172.7 && s.y1 < 176.2);
    expect(Math.max(...sousTitre.map((s) => Math.abs(s.x2 - s.x1)))).toBeGreaterThan(180);
  });
});

// ─────────────────────────── Mécanismes, sur des documents minimaux ───────────────────────────

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

function docx(corps: string, o: { pied?: string; numbering?: string; styles?: string } = {}): Buffer {
  const zip = new PizZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  const rels: string[] = [];
  if (o.pied) { zip.file("word/footer1.xml", `<?xml version="1.0" encoding="UTF-8"?><w:ftr ${NS}>${o.pied}</w:ftr>`); rels.push('<Relationship Id="rIdF" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>'); }
  if (o.numbering) { zip.file("word/numbering.xml", `<?xml version="1.0" encoding="UTF-8"?><w:numbering ${NS}>${o.numbering}</w:numbering>`); rels.push('<Relationship Id="rIdN" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>'); }
  zip.file("word/styles.xml", `<?xml version="1.0" encoding="UTF-8"?><w:styles ${NS}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>${o.styles ?? ""}</w:styles>`);
  rels.push('<Relationship Id="rIdS" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>');
  zip.file("word/_rels/document.xml.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join("")}</Relationships>`);
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8"?><w:document ${NS}><w:body>${corps}<w:sectPr>${o.pied ? '<w:footerReference w:type="default" r:id="rIdF"/>' : ""}<w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`);
  return zip.generate({ type: "nodebuffer" });
}
const p = (contenu: string, pPr = "") => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ""}${contenu}</w:p>`;
const r = (t: string, rPr = "") => `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ""}<w:t xml:space="preserve">${t}</w:t></w:r>`;
const TAB = "<w:r><w:tab/></w:r>";

describe("les mécanismes de mise en page", () => {
  it("une tabulation DROITE à points de suite aligne le montant sur la marge", async () => {
    const r1 = await docxToPdf(docx(p(r("Montant hors taxes") + TAB + r("1 250 000,00 DZD"), '<w:tabs><w:tab w:val="right" w:leader="dot" w:pos="9026"/></w:tabs>')));
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    const ls = await lignes(r1.pdf);
    const texte = ls.map((l) => l.texte).join(" ");
    expect(texte).toMatch(/Montant hors taxes \.{10,}/);
    const mupdf = await import("mupdf");
    let finMontant = 0;
    mupdf.Document.openDocument(r1.pdf, "application/pdf").loadPage(0).toStructuredText().walk({
      onChar(c: string, _o: unknown, _f: unknown, _s: unknown, quad: number[]) { if (c.trim()) finMontant = Math.max(finMontant, quad[2]!); },
    });
    // 72 pt de marge + 451,3 pt de taquet = 523,3 : le « D » final de « DZD » finit sur le taquet.
    expect(Math.abs(finMontant - 523.3)).toBeLessThan(1.5);
  });

  it("les NUMÉROS DE PAGE du pied (« Page X sur Y ») se calculent page par page", async () => {
    const champ = (code: string) => `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> ${code} </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>9</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>`;
    const pied = p(r("Page ") + champ("PAGE") + r(" sur ") + champ("NUMPAGES"), '<w:jc w:val="center"/>');
    const r1 = await docxToPdf(docx(p(r("Première page")) + p('<w:r><w:br w:type="page"/></w:r>') + p(r("Seconde page")), { pied }));
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(r1.pages).toBe(2);
    expect((await lignes(r1.pdf, 0)).map((l) => l.texte)).toContain("Page 1 sur 2");
    expect((await lignes(r1.pdf, 1)).map((l) => l.texte)).toContain("Page 2 sur 2");
    // Le saut de page en fin de paragraphe ne repousse pas une ligne vide : « Seconde page » est
    // la première ligne de la page 2, sur la marge haute.
    const l2 = ligne(await lignes(r1.pdf, 1), "Seconde page");
    expect(l2.base).toBeLessThan(72 + 12);
  });

  it("les LISTES numérotées portent leur numéro au retrait suspendu, et le texte au retrait", async () => {
    const numbering = `<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>`;
    const item = (t: string) => p(r(t), '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>');
    const r1 = await docxToPdf(docx(item("Préparer la commande") + item("Livrer au dépôt") + item("Signer le bon"), { numbering }));
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    const ls = await lignes(r1.pdf);
    for (const n of ["1.", "2.", "3."]) expect(Math.abs(ligne(ls, n).x - 90)).toBeLessThan(1); // 72 + 36 − 18
    expect(Math.abs(ligne(ls, "Livrer au dépôt").x - 108)).toBeLessThan(1); // 72 + 36
  });

  it("un tableau dessine ses filets, sa trame d'en-tête et fusionne ses cellules", async () => {
    const bords = '<w:tblBorders><w:top w:val="single" w:sz="4" w:color="000000"/><w:left w:val="single" w:sz="4" w:color="000000"/><w:bottom w:val="single" w:sz="4" w:color="000000"/><w:right w:val="single" w:sz="4" w:color="000000"/><w:insideH w:val="single" w:sz="4" w:color="000000"/><w:insideV w:val="single" w:sz="4" w:color="000000"/></w:tblBorders>';
    const tc = (t: string, extra = "") => `<w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/>${extra}</w:tcPr>${p(r(t))}</w:tc>`;
    const tableau = `<w:tbl><w:tblPr>${bords}</w:tblPr><w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid>`
      + `<w:tr>${tc("Désignation", '<w:shd w:val="clear" w:fill="D9E2F3"/>')}${tc("Quantité", '<w:shd w:val="clear" w:fill="D9E2F3"/>')}${tc("Total", '<w:shd w:val="clear" w:fill="D9E2F3"/>')}</w:tr>`
      + `<w:tr>${tc("Paracétamol", '<w:vMerge w:val="restart"/>')}${tc("120")}${tc("10 200,00")}</w:tr>`
      + `<w:tr>${tc("", "<w:vMerge/>")}${tc("60")}${tc("4 800,00")}</w:tr></w:tbl>`;
    const r1 = await docxToPdf(docx(tableau + p("")));
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    const { filets, aplats } = await dessins(r1.pdf);
    // La trame d'en-tête : trois cellules de 150 pt (3000 twips) en D9E2F3.
    const trames = aplats.filter((a) => a.couleur === "D9E2F3");
    expect(trames).toHaveLength(3);
    for (const t of trames) expect(Math.abs(t.w - 150)).toBeLessThan(0.5);
    // Les filets verticaux aux bords de la grille : 72, 222, 372, 522.
    const verticaux = filets.filter((s) => Math.abs(s.x1 - s.x2) < 0.01);
    for (const x of [72, 222, 372, 522]) expect(verticaux.some((s) => Math.abs(s.x1 - x) < 0.5), `pas de filet en x=${x}`).toBe(true);
    // La FUSION verticale : entre les rangées 2 et 3, un filet horizontal court sous « 120 », mais
    // PAS sous « Paracétamol » (colonne 1, fusionnée sur deux rangées).
    const ls = await lignes(r1.pdf);
    const y120 = ligne(ls, "120").base;
    const y60 = ligne(ls, "60").base;
    const entre = filets.filter((s) => Math.abs(s.y1 - s.y2) < 0.01 && s.y1 > y120 && s.y1 < y60);
    expect(entre.some((s) => Math.min(s.x1, s.x2) >= 221.5 && Math.max(s.x1, s.x2) <= 372.5)).toBe(true);
    expect(entre.some((s) => Math.min(s.x1, s.x2) < 221)).toBe(false);
  });

  it("le texte hors WinAnsi est SUBSTITUÉ proprement avec la police standard (aucun caractère illisible)", async () => {
    const r1 = await docxToPdf(docx(p(r("Seuil ≥ 10 % ; écart − 2 ; réf. № 12 ; Œuvre « été » — ½ dose"))), { policesSysteme: false });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    const texte = (await lignes(r1.pdf)).map((l) => l.texte).join(" ");
    expect(texte).toContain("Seuil >= 10");
    expect(texte).toContain("N°");
    expect(texte).toContain("Œuvre « été » — ½ dose");
    expect(texte).not.toContain("?");
  });

  it("le modèle relu garde la cascade des styles : police du thème, taille par défaut du document", () => {
    const lu = lireDocx(MODELE);
    const corps = lu.sections[0]!.blocs;
    const titre = corps.find((b) => b.type === "paragraphe" && b.contenu.some((c) => c.k === "texte" && c.texte.startsWith("ORDRE DE MISSION")));
    expect(titre?.type).toBe("paragraphe");
    if (titre?.type !== "paragraphe") return;
    const run = titre.contenu.find((c) => c.k === "texte")!;
    expect(run.p.police).toBe("Calibri"); // `w:asciiTheme="minorHAnsi"` → la police mineure du thème
    expect(run.p.taillePt).toBe(12); // `w:sz="24"` des docDefaults
    expect(run.p.gras).toBe(true);
    expect(run.p.souligne).toBe("simple");
    expect(titre.pp.alignement).toBe("center");
    expect(titre.pp.avantAuto).toBe(true);
    expect(lu.sections[0]!.section.marges.entete).toBeCloseTo(93.55, 1);
    expect(lu.tabDefaut).toBeCloseTo(35.4, 1);
  });
});
