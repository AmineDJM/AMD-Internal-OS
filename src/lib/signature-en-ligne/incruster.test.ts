import { describe, it, expect } from "vitest";
import PDFDocument from "pdfkit";
import sharp from "sharp";
import { incruster } from "./incruster";
import { chargerMupdf } from "@/lib/artifact/adapters/pdf/adapter";
import { placement, rectDuQuad } from "./placement";

/** Un BC minimal : deux pages, la mention « Signature et cachet » sur la dernière. */
function bcDeTest(): Promise<Buffer> {
  return new Promise((ok) => {
    const doc = new PDFDocument({ size: "A4" });
    const morceaux: Buffer[] = [];
    doc.on("data", (c: Buffer) => morceaux.push(c));
    doc.on("end", () => ok(Buffer.concat(morceaux)));
    doc.text("BON DE COMMANDE N° 047/DG/2026");
    doc.addPage();
    // Un état graphique laissé ouvert : la signature ne doit pas en hériter.
    doc.save().translate(40, 40);
    doc.text("Pour Adventum Pharma", 340, 560);
    doc.text("Signature et cachet", 340, 580);
    doc.end();
  });
}

const image = (couleur: string) =>
  sharp({ create: { width: 300, height: 150, channels: 4, background: couleur } }).png().toBuffer();

async function pixelSombre(pdf: Buffer, r: { x: number; y: number; w: number; h: number }): Promise<boolean> {
  const mupdf = await chargerMupdf();
  const doc = new mupdf.PDFDocument(pdf);
  const page = doc.loadPage(doc.countPages() - 1);
  const pix = page.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false);
  const px = pix.getPixels(), n = pix.getNumberOfComponents() + (pix.getAlpha() ? 1 : 0);
  // Le centre du quart gauche : la signature, jamais recouverte par le cachet posé à sa droite.
  const cx = Math.round(r.x + r.w / 4), cy = Math.round(r.y + r.h / 2);
  const i = cy * pix.getStride() + cx * n;
  return px[i] + px[i + 1] + px[i + 2] < 600;
}

describe("incruster une signature en ligne dans un BC", () => {
  it("pose signature, cachet et sceau sur la dernière page, sans perdre le texte ; les deux signataires se suivent", async () => {
    const base = await bcDeTest();
    const signature = await image("#1d4ed8");
    const cachet = await image("#b91c1c");
    const commun = { signature, cachet, urlVerification: "https://exemple.test/verifier-bc/abc" };
    const apresDm = await incruster(base, { ...commun, qualite: "DIRECTION_MARKETING", mention: "Signé électroniquement par Assia — Direction Marketing" });
    const apresFi = await incruster(apresDm, { ...commun, qualite: "FINANCES", mention: "Signé électroniquement par Redouane — Finances" });

    const mupdf = await chargerMupdf();
    const doc = new mupdf.PDFDocument(apresFi);
    expect(doc.countPages()).toBe(2);
    const page = doc.loadPage(1);
    const hits = page.search("Signature et cachet");
    expect(hits.length).toBe(1);
    const [x0, y0, x1, y1] = page.getBounds();
    const ancre = rectDuQuad(hits[0][0]);
    for (const q of ["DIRECTION_MARKETING", "FINANCES"] as const) {
      const p = placement({ w: x1 - x0, h: y1 - y0 }, ancre, q);
      expect(await pixelSombre(apresFi, p.signature)).toBe(true);
      expect(await pixelSombre(apresFi, p.sceau)).toBe(true);
    }
  }, 30_000);
});
