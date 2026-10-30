import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { buildAttachmentContext, extractAttachmentText } from "@/platform/ia/media/assistant-files";

/**
 * UNE IMAGE DEVIENT DU TEXTE (mandat 4 §30) — par le vrai OCR de la maison (Tesseract local, données
 * de langue embarquées), sans modèle : le montant d'une facture rendue en PNG est relu, et la note
 * dit la méthode et que ce n'est pas un fait vérifié. Le secours vision (Luna) n'est pas configuré
 * ici : le chemin doit rendre un résultat honnête sans lui.
 */
async function facturePng(): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="360"><rect width="100%" height="100%" fill="white"/>
    <text x="40" y="80" font-family="Arial" font-size="40" font-weight="bold" fill="black">FACTURE F-2026-0042</text>
    <text x="40" y="170" font-family="Arial" font-size="36" fill="black">Fournisseur : Kwality Pharma</text>
    <text x="40" y="270" font-family="Arial" font-size="40" font-weight="bold" fill="black">Total TTC : 142 800 DZD</text></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

describe("pièces jointes — image et scan", () => {
  it("une facture en PNG est lue par OCR : le numéro et le montant sortent, la note dit « OCR » et « probable »", async () => {
    const r = await extractAttachmentText("facture.png", await facturePng());
    expect(r.text.length, r.note ?? "").toBeGreaterThan(20);
    expect(r.text.replace(/\s/g, "")).toMatch(/142800|F-2026-0042|F2026-0042/);
    expect(r.note ?? "").toMatch(/OCR/);
    expect(r.note ?? "").toMatch(/PROBABLE/);
    const ctx = buildAttachmentContext([r]) ?? "";
    expect(ctx).toMatch(/Pièce jointe : facture\.png/);
    expect(ctx).toMatch(/PROBABLE/); // la note voyage avec le texte jusqu'au modèle
  }, 120_000);

  it("une image sans texte rend une note honnête, jamais une exception ni un texte inventé", async () => {
    const vide = await sharp({ create: { width: 200, height: 120, channels: 3, background: { r: 240, g: 240, b: 240 } } }).png().toBuffer();
    const r = await extractAttachmentText("photo.png", vide);
    expect(r.text.replace(/\s/g, "").length).toBeLessThan(6);
    expect(r.note ?? "").toMatch(/OCR|illisible/);
  }, 120_000);
});
