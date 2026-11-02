import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import JSZip from "jszip";
import { extractAttachmentText, buildAttachmentContext } from "./assistant-files";

/**
 * Lecture des pièces jointes de l'assistant : l'assistant doit pouvoir « lire » un Excel
 * COMPLET (toutes les feuilles), un PPTX (texte des diapositives) et les formats texte.
 * Les formats binaires hérités et les fichiers vides sont signalés, jamais une exception.
 */

function xlsxBuffer(): Buffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Produit", "Ventes"], ["Doliprane", 1250], ["Aspirine", 830]]), "Feuille1");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Note"], ["Deuxième feuille lue"]]), "Feuille2");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

async function pptxBuffer(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<?xml version=\"1.0\"?><Types/>");
  const slide = (t: string) => `<?xml version="1.0"?><p:sld xmlns:a="a"><p:cSld><p:spTree><a:t>${t}</a:t></p:spTree></p:cSld></p:sld>`;
  zip.file("ppt/slides/slide1.xml", slide("Titre de la présentation"));
  zip.file("ppt/slides/slide2.xml", slide("Deuxième diapositive"));
  return (await zip.generateAsync({ type: "nodebuffer" })) as Buffer;
}

describe("extractAttachmentText — lecture des pièces jointes", () => {
  it("lit un Excel COMPLET (toutes les feuilles)", async () => {
    const r = await extractAttachmentText("ventes.xlsx", xlsxBuffer());
    expect(r.note).toBeNull();
    expect(r.text).toContain("Doliprane");
    expect(r.text).toContain("1250");
    expect(r.text).toContain("Deuxième feuille lue"); // la 2ᵉ feuille est bien incluse
  });

  it("lit le texte d'un PPTX (diapositives)", async () => {
    const r = await extractAttachmentText("deck.pptx", await pptxBuffer());
    expect(r.note).toBeNull();
    expect(r.text).toContain("Titre de la présentation");
    expect(r.text).toContain("Deuxième diapositive");
  });

  it("lit un CSV / texte brut", async () => {
    const r = await extractAttachmentText("data.csv", Buffer.from("a,b\n1,2\n", "utf8"));
    expect(r.text).toContain("a,b");
  });

  it("signale un format binaire hérité sans lever", async () => {
    const r = await extractAttachmentText("vieux.ppt", Buffer.from([0xd0, 0xcf, 0x11, 0xe0]));
    expect(r.text).toBe("");
    expect(r.note).toBeTruthy();
  });

  it("assemble un contexte à partir de plusieurs pièces (et signale les non lisibles)", () => {
    const ctx = buildAttachmentContext([
      { name: "a.xlsx", text: "Doliprane 1250", note: null, truncated: false },
      { name: "b.ppt", text: "", note: "Format non pris en charge.", truncated: false },
    ]);
    expect(ctx).toContain("a.xlsx");
    expect(ctx).toContain("Doliprane 1250");
    expect(ctx).toContain("Format non pris en charge.");
  });
});
