import QRCode from "qrcode";

/** Génère un QR code (PNG) — utilisé pour les badges participants / check-in. */
export async function qrPng(text: string): Promise<Buffer> {
  return QRCode.toBuffer(text, { type: "png", width: 360, margin: 1, errorCorrectionLevel: "M" });
}
