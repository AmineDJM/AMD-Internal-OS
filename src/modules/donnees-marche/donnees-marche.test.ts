import { afterAll, describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { prisma } from "@/lib/prisma";
import { deposerFichierMarche, fluxIqvia, fluxNomenclature, verifierCleApi } from "./api";

/** Banc sur base réelle : un dépôt de chaque nature, son idempotence, et ce que le service lit. */
const crees: string[] = [];
afterAll(async () => { if (crees.length) await prisma.marcheImport.deleteMany({ where: { id: { in: crees } } }); });

function classeur(feuilles: Record<string, unknown[][]>): Buffer {
  const wb = XLSX.utils.book_new();
  for (const [nom, lignes] of Object.entries(feuilles)) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(lignes), nom);
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}
const jeton = `T${Date.now()}`;

describe("dépôt des données marché", () => {
  it("dépose une nomenclature, puis le même fichier ne fait rien, et le flux la sert", async () => {
    const buf = classeur({
      "Nomenclature Test": [
        [`NOMENCLATURE NATIONALE AU 30 JUIN 2099 ${jeton}`],
        ["N°", "N°ENREGISTREMENT", "CODE", "DENOMINATION COMMUNE INTERNATIONALE", "NOM DE MARQUE", "FORME", "DOSAGE", "LABORATOIRES DETENTEUR DE LA DECISION D'ENREGISTREMENT", "TYPE", "STATUT"],
        [1, `001/${jeton}`, "99 Z 001", "TESTOSTATINE", "TESTO", "COMPRIME", "10MG", "LABO A", "GE", "F"],
        [2, `002/${jeton}`, "99 Z 001", "TESTOSTATINE", "TESTA", "COMPRIME", "10MG", "LABO B", "GE", "I"],
      ],
      Retraits: [
        ["N°", "N°ENREGISTREMENT", "CODE", "DENOMINATION COMMUNE INTERNATIONALE", "STATUT", "DATE DE RETRAIT", "MOTIF DE RETRAIT"],
        [1, `003/${jeton}`, "99 Z 001", "TESTOSTATINE", "I", "RETRAIT ", "RETRAIT PAR LE DETENTEUR"],
      ],
    });
    const r = await deposerFichierMarche(`nom-${jeton}.xlsx`, buf, null);
    expect(r.ok && r.nature).toBe("NOMENCLATURE");
    if (!r.ok) return;
    crees.push(r.importId);
    expect(r.lignes).toBe(3);
    expect(r.periode).toBe("2099-06-30");
    const bis = await deposerFichierMarche("autre-nom.xlsx", buf, null);
    expect(bis.ok && bis.deja).toBe(true);
    const flux = await fluxNomenclature("EN_VIGUEUR");
    expect(flux.import?.id).toBe(r.importId);
    expect(flux.lignes.map((l) => l.statut).sort()).toEqual(["F", "I"]);
  });

  it("dépose un audit IQVIA sans compter deux fois une association", async () => {
    const buf = classeur({
      "ATC Prod Mol Lab": [
        ["ATC4", "PRODUIT", "PRESENTATION", "MOLECULE", "LABORATOIRE", "MAT Jul 2099\nUNITES", "MAT Jul 2099\nVALEURS"],
        ["C09", `PROD-${jeton}`, "CP 30", "AMLODIPINE", "LAB", 10, 1000],
        ["C09", `PROD-${jeton}`, "CP 30", "VALSARTAN", "LAB", 10, 1000],
        ["Grand Total", null, null, null, null, 10, 1000],
      ],
    });
    const r = await deposerFichierMarche(`iq-${jeton}.xlsx`, buf, null);
    expect(r.ok && r.nature).toBe("IQVIA");
    if (!r.ok) return;
    crees.push(r.importId);
    expect(r.rapport.controle).toBe(true);
    const flux = await fluxIqvia();
    expect(flux.presentations).toHaveLength(1);
    expect(flux.presentations[0]!.molecules).toEqual(["AMLODIPINE", "VALSARTAN"]);
  });

  it("refait un dépôt resté à moitié au lieu de le prendre pour un doublon", async () => {
    const buf = classeur({ "Nomenclature T2": [
      ["N°", "N°ENREGISTREMENT", "CODE", "DENOMINATION COMMUNE INTERNATIONALE", "STATUT", "DATE D'ENREGISTREMENT INITIAL"],
      [1, `010/${jeton}`, "99 Z 002", "DEMISTATINE", "F", "00/00/2019"],
      [2, `011/${jeton}`, "99 Z 002", "DEMISTATINE", "I", "12/03/2019"],
    ] });
    const r = await deposerFichierMarche(`demi-${jeton}.xlsx`, buf, null);
    if (!r.ok) throw new Error(r.erreur);
    crees.push(r.importId);
    expect(r.lignes).toBe(2);
    await prisma.nomenclatureLigne.deleteMany({ where: { importId: r.importId, numero: 2 } }); // simule une écriture interrompue
    const bis = await deposerFichierMarche(`demi-${jeton}.xlsx`, buf, null);
    if (!bis.ok) throw new Error(bis.erreur);
    crees.push(bis.importId);
    expect(bis.deja).toBe(false);
    expect(await prisma.nomenclatureLigne.count({ where: { importId: bis.importId } })).toBe(2);
  });

  it("refuse un classeur qui n'est ni l'un ni l'autre", async () => {
    const r = await deposerFichierMarche("x.xlsx", classeur({ A: [["x", "y"], [1, 2]] }), null);
    expect(r.ok).toBe(false);
  });
});

describe("clé du service", () => {
  it("refuse tout sans clé configurée, et une mauvaise clé", () => {
    const avant = process.env.DONNEES_MARCHE_API_KEY;
    delete process.env.DONNEES_MARCHE_API_KEY;
    expect(verifierCleApi("Bearer abc")).toEqual({ ok: false, statut: 503 });
    process.env.DONNEES_MARCHE_API_KEY = "k".repeat(32);
    expect(verifierCleApi("Bearer " + "k".repeat(31) + "x")).toEqual({ ok: false, statut: 401 });
    expect(verifierCleApi(null)).toEqual({ ok: false, statut: 401 });
    expect(verifierCleApi("Bearer " + "k".repeat(32))).toEqual({ ok: true });
    if (avant === undefined) delete process.env.DONNEES_MARCHE_API_KEY; else process.env.DONNEES_MARCHE_API_KEY = avant;
  });
});
