import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { construireXlsxCommercial, ecartsAvecLeCalcul, nomFichierExcel } from "@/lib/artifact/factory/xlsx";
import { calculerTotaux, type SpecDocumentCommercial } from "@/lib/artifact/factory/commercial";
import { figerEtVerifierClasseur } from "@/lib/artifact/sheets/build";

/**
 * LA PIÈCE SUR EXCEL — le bon de commande 012/DG/2026 d'Adventum (794 500 HT, Taxe Pub 2 % = 15 890, TVA 19 % =
 * 150 955 sur le HT seul, TTC 961 345) rendu en classeur à FORMULES. Les chiffres sont ceux de l'original : c'est
 * contre eux que le classeur se juge, pas contre un jeu d'essai inventé.
 */
const adventum = {
  nom: "SARL ADVENTUM Pharma", formeJuridique: "SARL", adresse: "N° 14 Rue El Moudjahidine, Chéraga - Alger",
  rc: "16/00 1019094 B 23", nif: "002316101909460", ai: "16500570121", nis: "002316500139550", telephone: "020 339 430", email: "contact@societe-test.dz",
};
const bonDeCommande = (extra: Partial<SpecDocumentCommercial> = {}): SpecDocumentCommercial => ({
  type: "BON_DE_COMMANDE", numero: "012/DG/2026", date: "2026-08-06", emetteur: adventum, couleur: "#087084",
  tiers: { nom: "INSIGNE CONSEIL", adresse: "Bat 10B n°04 Cité les sources.\nBir Mourad Rais", telephone: "021 54 11 56" },
  contact: { nom: "Mme ABDELAZIZ ASSIA", telephone: "0770530674" }, referenceAmont: "26/0576", referenceAmontDate: "2026-07-20",
  modePaiement: "CHEQUE", conditionsPaiement: "ou virement bancaire", taxes: [{ libelle: "Taxe Pub", taux: 0.02 }],
  livraison: { delai: "15 jours" },
  lignes: [
    { designation: "Conception ADV", quantite: 1, prixUnitaire: 145_000, details: ["Nombre de page: 25"] },
    { designation: "Adaptation format papier", quantite: 1, prixUnitaire: 0 },
    { designation: "Impression ADV", quantite: 1, prixUnitaire: 15_000, details: ["Format A4", "Forfait 10 exemplaires"] },
    { designation: "Campagne Raltégravir", section: true, quantite: 0, prixUnitaire: 0 },
    { designation: "Conception et impression d'une fiche posologique", quantite: 500, prixUnitaire: 225 },
    { designation: "Conception & impression banner", quantite: 3, prixUnitaire: 33_000 },
    { designation: "Campagne Dolutégravir", section: true, quantite: 0, prixUnitaire: 0 },
    { designation: "Conception et impression d'une fiche posologique", quantite: 500, prixUnitaire: 225 },
    { designation: "Conception & Impression banner", quantite: 3, prixUnitaire: 33_000 },
    { designation: "Campagne Darunavir", section: true, quantite: 0, prixUnitaire: 0 },
    { designation: "Conception et impression d'une fiche posologique", quantite: 500, prixUnitaire: 225 },
    { designation: "Conception & Impression banner", quantite: 3, prixUnitaire: 33_000 },
  ],
  ...extra,
});

async function ouvrir(octets: Buffer): Promise<ExcelJS.Worksheet> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(octets as unknown as ArrayBuffer);
  return wb.worksheets[0];
}
/** La ligne dont la première cellule porte exactement `libelle`. */
function ligneDe(ws: ExcelJS.Worksheet, libelle: string): ExcelJS.Row {
  let trouvee: ExcelJS.Row | null = null;
  ws.eachRow((row) => { if (!trouvee && row.getCell(1).value === libelle) trouvee = row; });
  expect(trouvee, `la ligne « ${libelle} » doit exister`).not.toBeNull();
  return trouvee as unknown as ExcelJS.Row;
}
const resultat = (cell: ExcelJS.Cell): unknown => (cell.value && typeof cell.value === "object" && "result" in cell.value ? (cell.value as ExcelJS.CellFormulaValue).result : cell.value);
const formule = (cell: ExcelJS.Cell): string | null => (cell.value && typeof cell.value === "object" && "formula" in cell.value ? String((cell.value as ExcelJS.CellFormulaValue).formula) : null);

describe("le bon de commande sur Excel", () => {
  it("rend les chiffres de l'original — 794 500 HT, Taxe Pub 15 890, TVA 150 955, TTC 961 345 — par des FORMULES dont la valeur est écrite", async () => {
    const r = await construireXlsxCommercial(bonDeCommande());
    expect(r.verification.bloquants).toEqual([]);
    expect(r.verification.ok).toBe(true);
    expect(r.verification.formules).toBeGreaterThan(8);
    const ws = await ouvrir(r.octets);
    expect(ws.name).toBe("Bon de commande");
    const ht = ligneDe(ws, "Total HT").getCell(7);
    expect(resultat(ht)).toBe(794_500);
    expect(formule(ht)).toMatch(/^ROUND\(SUM\(G\d+:G\d+\),2\)$/);
    const taxe = ligneDe(ws, "Taxe Pub");
    expect(resultat(taxe.getCell(7))).toBe(15_890);
    expect(taxe.getCell(6).value).toBe(0.02);
    // La TVA se calcule sur le HT SEUL : la taxe additionnelle reste hors de sa base.
    const tva = ligneDe(ws, "TVA");
    expect(resultat(tva.getCell(7))).toBe(150_955);
    expect(formule(tva.getCell(7))).toContain("SUMIF");
    expect(resultat(ligneDe(ws, "Montant TTC").getCell(7))).toBe(961_345);
  });

  it("le titre est AU CENTRE, fusionné sur la largeur, à l'accent de la charte ; le numéro et la date dessous ; la bande des références à l'accent", async () => {
    const r = await construireXlsxCommercial(bonDeCommande());
    const ws = await ouvrir(r.octets);
    const titre = ligneDe(ws, "BON DE COMMANDE");
    expect(titre.getCell(1).alignment?.horizontal).toBe("center");
    expect(titre.getCell(1).font?.bold).toBe(true);
    expect(titre.getCell(1).font?.color?.argb).toBe("FF087084");
    expect(ws.model.merges).toContain(`A${titre.number}:G${titre.number}`);
    expect(ws.getCell(`A${titre.number + 1}`).value).toBe("N° 012/DG/2026 — du 06/08/2026");
    const entete = ligneDe(ws, "Désignation");
    expect(entete.getCell(1).fill).toMatchObject({ fgColor: { argb: "FF087084" } });
    // Le papier : A4 portrait, une page de large.
    expect(ws.pageSetup.paperSize).toBe(9);
    expect(ws.pageSetup.fitToWidth).toBe(1);
  });

  it("une quantité modifiée DANS le classeur fait suivre le total : les formules sont vivantes, au centime du calcul de la plateforme", async () => {
    const spec = bonDeCommande();
    const r = await construireXlsxCommercial(spec);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(r.octets as unknown as ArrayBuffer);
    const ws = wb.worksheets[0];
    const ligne = ligneDe(ws, "Conception ADV\nNombre de page: 25");
    ligne.getCell(3).value = 2; // deux conceptions au lieu d'une
    const refait = await figerEtVerifierClasseur(wb, 0);
    const attendu = calculerTotaux({ ...spec, lignes: spec.lignes.map((l) => (l.designation === "Conception ADV" ? { ...l, quantite: 2 } : l)) });
    const ttc = ligneDe(ws, "Montant TTC").number;
    expect(refait.valeurs.get(`Bon de commande!G${ttc}`)).toBe(attendu.totalTtc);
    expect(attendu.totalTtc).toBeGreaterThan(961_345);
  });

  it("multi-TVA, remise de ligne, remise globale, sections et espèces (timbre) : chaque total recalculé retombe sur le calcul du Word", async () => {
    const spec = bonDeCommande({
      couleur: null, taxes: [{ libelle: "Taxe Pub", taux: 0.02 }, { libelle: "Taxe verte", taux: 0.005 }], remiseGlobale: 0.1, modePaiement: "ESPECES", tvaDefaut: 0.19,
      lignes: [
        { designation: "Formation", quantite: 2, unite: "jour", prixUnitaire: 60_000, tva: 0.09, remise: 0.1 },
        { designation: "Support papier", section: true, quantite: 0, prixUnitaire: 0 },
        { designation: "Brochure", quantite: 333, prixUnitaire: 17.35 },
        { designation: "Exonéré", quantite: 1, prixUnitaire: 12_345.67, tva: 0 },
      ],
    });
    const attendu = calculerTotaux(spec);
    expect(attendu.tva.length).toBe(3);
    expect(attendu.timbre).toBeGreaterThan(0);
    const r = await construireXlsxCommercial(spec);
    expect(r.verification.bloquants).toEqual([]);
    expect(r.verification.ok).toBe(true);
    const ws = await ouvrir(r.octets);
    expect(resultat(ligneDe(ws, "Montant TTC").getCell(7))).toBe(attendu.totalTtc);
    expect(resultat(ligneDe(ws, "Droit de timbre").getCell(7))).toBe(attendu.timbre);
    expect(resultat(ligneDe(ws, "Remise globale").getCell(7))).toBe(attendu.remiseGlobale);
    expect(resultat(ligneDe(ws, "Total HT net").getCell(7))).toBe(attendu.totalHt);
    // Sans papier ni charte : le bleu canard de la maison.
    expect(ligneDe(ws, "Désignation").getCell(1).fill).toMatchObject({ fgColor: { argb: "FF087084" } });
  });

  it("la facture et l'avoir : « Somme à payer » ou « Montant crédité », l'échéance, le numéro de client — et le titre de la nature", async () => {
    const f = await construireXlsxCommercial(bonDeCommande({
      type: "FACTURE", numero: "001/FS/26", numeroClient: "00003", echeance: "2026-09-05", referenceAmont: null, referenceAmontDate: null, contact: null, livraison: null,
      emetteur: { ...adventum, banque: "BNA", rib: "001 00123 0123456789 45" },
    }));
    expect(f.verification.ok).toBe(true);
    const ws = await ouvrir(f.octets);
    expect(ws.name).toBe("Facture");
    expect(ligneDe(ws, "FACTURE").getCell(1).alignment?.horizontal).toBe("center");
    expect(resultat(ligneDe(ws, "Somme à payer").getCell(7))).toBe(961_345);
    const a = await construireXlsxCommercial(bonDeCommande({ type: "AVOIR", numero: "AV-2026-0001", objet: "Retour de marchandise", referenceAmont: "001/FS/26", modePaiement: null, conditionsPaiement: null, contact: null, livraison: null }));
    expect(a.verification.bloquants).toEqual([]);
    expect(a.verification.ok).toBe(true);
    expect(resultat(ligneDe(await ouvrir(a.octets), "Montant crédité").getCell(7))).toBe(961_345);
  });

  it("une spécification refusée n'est pas livrée : aucun octet, les raisons dites", async () => {
    const r = await construireXlsxCommercial(bonDeCommande({ lignes: [] }));
    expect(r.verification.ok).toBe(false);
    expect(r.verification.bloquants.length).toBeGreaterThan(0);
    expect(r.octets.length).toBe(0);
  });

  it("le nom du fichier est sûr : les barres du numéro ne passent pas dans un nom de fichier", () => {
    expect(nomFichierExcel({ numero: "032/DG/2026", tiers: { nom: "Sarl BIOGALENIC / Alger" } })).toBe("032-DG-2026 — Sarl BIOGALENIC - Alger.xlsx");
    expect(nomFichierExcel({ numero: "BC-2026-0001", tiers: { nom: "A" } })).toBe("BC-2026-0001 — A.xlsx");
  });
});

describe("le contrôle au centime du classeur — il sait échouer", () => {
  const attendus = [{ nom: "Total HT", ligne: 19, attendu: 794_500 }, { nom: "Total TTC", ligne: 22, attendu: 961_345 }];
  it("rien à dire quand chaque total retombe au centime, même avec le bruit d'un flottant", () => {
    expect(ecartsAvecLeCalcul((l) => (l === 19 ? 794_500.0000001 : 961_345), attendus)).toEqual([]);
  });
  it("un écart d'UN centime est un écart — et il est nommé avec les deux nombres", () => {
    const e = ecartsAvecLeCalcul((l) => (l === 19 ? 794_500 : 961_345.01), attendus);
    expect(e).toHaveLength(1);
    expect(e[0]).toContain("Total TTC");
    expect(e[0]).toContain("961345.01");
    expect(e[0]).toContain("961345.00");
  });
  it("une valeur absente (cellule vide, formule en erreur) n'est pas un zéro : c'est un écart", () => {
    const e = ecartsAvecLeCalcul(() => null, attendus);
    expect(e).toHaveLength(2);
    expect(e.every((x) => x.includes("aucune valeur"))).toBe(true);
  });
});
