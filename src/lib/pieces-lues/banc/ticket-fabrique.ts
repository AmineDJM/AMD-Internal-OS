import PDFDocument from "pdfkit";

/**
 * LE TICKET DE CAISSE DU BANC (Moyens généraux, 09/11/2026) — le cas qui a fait échouer la lecture : un ticket de
 * 15 articles, SANS colonne N°, scanné sur une page A4 ; le scanner y a posé SA couche texte, où chaque montant a
 * perdu son point décimal (« 230.00DA » → « 23000DA ») et où la quantité se colle au prix (« 1 190.00 » → « 119000 »).
 * Lu par cette couche texte, le ticket ressortait en 6 lignes aux montants centuplés.
 */

export interface ArticleTicket { designation: string; qte: number; pu: number }

export const ARTICLES_TICKET: readonly ArticleTicket[] = [
  { designation: "DIZOL DETARTRANT 700ML", qte: 2, pu: 230 },
  { designation: "LORAGE 750ML", qte: 2, pu: 290 },
  { designation: "AMIR MULTI SURFACES 750ML", qte: 1, pu: 190 },
  { designation: "COTEX CONFFERT 24+8", qte: 2, pu: 680 },
  { designation: "COTEX MILLE 2", qte: 3, pu: 650 },
  { designation: "DOZ JAVEL 5L", qte: 1, pu: 280 },
  { designation: "CLEAN VAISSELLE 5L", qte: 1, pu: 600 },
  { designation: "CLEAN SAVON MAINS 5L", qte: 1, pu: 600 },
  { designation: "Sucre Cristallisé NOUNOURS Doses", qte: 2, pu: 280 },
  { designation: "FIOR BAG 65*55", qte: 5, pu: 100 },
  { designation: "SCOUR POWER 1PES", qte: 1, pu: 60 },
  { designation: "PRO VITE 40*30", qte: 1, pu: 180 },
  { designation: "PANGE LAVETTES", qte: 6, pu: 15 },
  { designation: "DIVERS", qte: 1, pu: 40 },
  { designation: "AIGLE SERPILLIER VISCOSE", qte: 2, pu: 100 },
];
export const TOTAL_TICKET = ARTICLES_TICKET.reduce((s, a) => s + a.qte * a.pu, 0); // 7 650

/** « 1,360.00DA » — le format du ticket (virgule des milliers, point décimal). */
export const montantTicket = (n: number): string =>
  `${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}DA`;

/** Ce que la vision recopie du ticket : sans colonne N°, le modèle y met la QUANTITÉ — le piège réel. */
export const VISION_DU_TICKET = {
  emetteur: { nom: "DROGUERIE DU BANC", nif: "", rc: "" }, client: "", totalHt: montantTicket(TOTAL_TICKET),
  lignes: ARTICLES_TICKET.map((a) => ({
    numero: String(a.qte), designation: a.designation, quantite: String(a.qte),
    prixUnitaire: montantTicket(a.pu), montant: montantTicket(a.qte * a.pu),
  })),
};

/** La couche texte du SCANNER : les décimales perdues, la quantité collée au prix quand elle vaut 1. */
const abime = (n: number) => `${Math.round(n * 100)}DA`;
function coucheTexteDuScanner(marque: string): string {
  return [
    `DROGUERIE DU BANC ${marque}`, "LIBELLE", ...ARTICLES_TICKET.map((a) => a.designation),
    "QTE P.U TOTAL",
    ...ARTICLES_TICKET.map((a) => (a.qte === 1 ? `1${abime(a.pu)} ${abime(a.pu)}` : `${a.qte} ${abime(a.pu)} ${abime(a.qte * a.pu)}`)),
    `Nbre articles ${ARTICLES_TICKET.length}  TOTAL : ${montantTicket(TOTAL_TICKET)}`, "MERCI DE VOTRE VISITE",
  ].join("\n");
}

function enOctets(doc: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    doc.on("data", (c: Buffer) => parts.push(c));
    doc.on("end", () => resolve(Buffer.concat(parts)));
    doc.on("error", reject);
    doc.end();
  });
}

/** Le ticket imprimé (petit, en haut à gauche d'une page A4), avant le scan. */
async function ticketImprime(marque: string): Promise<Buffer> {
  const doc = new PDFDocument({ size: "A4", margin: 0 });
  doc.font("Courier").fontSize(7);
  let y = 40;
  doc.text(`DROGUERIE DU BANC ${marque}`, 20, y); y += 22;
  doc.text("LIBELLE", 20, y); doc.text("QTE", 120, y); doc.text("P.U", 145, y); doc.text("TOTAL", 185, y); y += 14;
  for (const a of ARTICLES_TICKET) {
    doc.text(a.designation.slice(0, 22), 20, y); doc.text(String(a.qte), 125, y);
    doc.text(montantTicket(a.pu), 135, y); doc.text(montantTicket(a.qte * a.pu), 180, y); y += 11;
  }
  y += 8;
  doc.text(`Nbre articles : ${ARTICLES_TICKET.length}`, 20, y); doc.text(`TOTAL : ${montantTicket(TOTAL_TICKET)}`, 130, y);
  return enOctets(doc);
}

/** Le fichier tel qu'il arrive : la page entière en image, et la couche texte (invisible) du scanner par-dessus. */
export async function ticketScanne(marque: string): Promise<Buffer> {
  const mupdf = await import("mupdf");
  const src = mupdf.Document.openDocument(new Uint8Array(await ticketImprime(marque)), "application/pdf");
  let png: Buffer;
  try {
    const page = src.loadPage(0);
    const pix = page.toPixmap(mupdf.Matrix.scale(130 / 72, 130 / 72), mupdf.ColorSpace.DeviceGray, false);
    png = Buffer.from(pix.asPNG());
    pix.destroy?.();
    page.destroy?.();
  } finally {
    src.destroy?.();
  }
  const doc = new PDFDocument({ size: "A4", margin: 0 });
  doc.image(png, 0, 0, { width: 595, height: 842 });
  doc.fillOpacity(0).font("Helvetica").fontSize(6).text(coucheTexteDuScanner(marque), 20, 40, { width: 300 });
  return enOctets(doc);
}
