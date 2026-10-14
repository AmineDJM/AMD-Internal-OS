import { describe, expect, it } from "vitest";
import PizZip from "pizzip";
import { adaptateurDocx } from "@/lib/artifact/adapters/docx/adapter";
import { construireDocumentCommercial } from "@/lib/artifact/factory/build";
import { papierEnTeteDeDemonstration } from "@/lib/artifact/factory/word";
import type { SpecDocumentCommercial } from "@/lib/artifact/factory/commercial";
import type { DocxModel } from "@/lib/artifact/object-model/model";

/**
 * LES DEUX PIÈCES DE RÉFÉRENCE de la société (septembre 2026) : la facture 001/FS/26 de
 * Pharmagène à Biogalenic, et le bon de commande 012/DG/2026 d'Adventum à Insigne Conseil.
 * Les chiffres sont ceux imprimés sur les originaux — c'est contre eux que la mise en page et
 * l'arithmétique se jugent, pas contre un jeu d'essai inventé.
 */
const pharmagene = {
  nom: "SARL PHARMAGENE", formeJuridique: "SARL", adresse: "N°123, Lot. BENHEDADI Saïd, 1er étage Chéraga – Alger",
  rc: "16/00-1010258 B 15", nif: "001516101025823", ai: "16500657343", nis: "001516100000001", telephone: "021 00 00 00",
  banque: "BNA — Agence Chéraga", rib: "001 00123 0123456789 45",
};
const adventum = {
  nom: "SARL ADVENTUM Pharma", formeJuridique: "SARL", adresse: "N° 14 Rue El Moudjahidine, Sec. 45 GP 15 Lot. 01 RDC Chéraga - Alger",
  rc: "16/00 1019094 B 23", nif: "002316101909460", ai: "16500570121", nis: "002316500139550", telephone: "020 339 430", email: "contact@societe-test.dz",
};

const facture = (extra: Partial<SpecDocumentCommercial> = {}): SpecDocumentCommercial => ({
  type: "FACTURE", numero: "001/FS/26", date: "2026-07-09", emetteur: pharmagene, numeroClient: "00003",
  tiers: { nom: "Sarl. BIOGALENIC", adresse: "Zone Industrielle, Aissa Ben Hamida\n(Didouche Mourad), Constantine 25210, Algérie", telephone: "031 90 78 89/79 21", rc: "99 B 62900", nif: "099925006290089" },
  lignes: [
    { designation: "TRAVAUX DE CONSULTING", section: true, quantite: 0, prixUnitaire: 0 },
    { designation: "Frais TRIMESTRE 4/2025.", quantite: 3, prixUnitaire: 2_500_000 },
  ],
  modePaiement: "CHEQUE", conditionsPaiement: "ou virement bancaire", couleur: "#8DB4E2",
  ...extra,
});

const bonDeCommande = (extra: Partial<SpecDocumentCommercial> = {}): SpecDocumentCommercial => ({
  type: "BON_DE_COMMANDE", numero: "012/DG/2026", date: "2026-08-06", emetteur: adventum, couleur: "#1F5C99",
  tiers: { nom: "INSIGNE CONSEIL", adresse: "Bat 10B n°04 Cité les sources.\nBir Mourad Rais", telephone: "021 54 11 56" },
  contact: { nom: "Mme ABDELAZIZ ASSIA", telephone: "0770530674" }, referenceAmont: "26/0576", referenceAmontDate: "2026-07-20",
  modePaiement: "CHEQUE", conditionsPaiement: "ou virement bancaire", taxes: [{ libelle: "Taxe Pub", taux: 0.02 }],
  lignes: [
    { designation: "Conception ADV", quantite: 1, prixUnitaire: 145_000, details: ["Nombre de page: 25"] },
    { designation: "Adaptation format papier", quantite: 1, prixUnitaire: 0 },
    { designation: "Impression ADV", quantite: 1, prixUnitaire: 15_000, details: ["Format A4", "Impression quadri recto verso sur 300g", "Pelliculage mat, finition spirale", "Forfait 10 exemplaires"] },
    { designation: "Campagne Raltégravir", section: true, quantite: 0, prixUnitaire: 0 },
    { designation: "Conception et impression d'une fiche posologique", quantite: 500, prixUnitaire: 225, details: ["Format fermé a5, 3 volets ouvert: 15cm x63cm", "Impression quadri recto verso sur 300g", "RCP, max 12 pages, sur 80g pique à l'intérieur"] },
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

async function modele(octets: Buffer): Promise<DocxModel> {
  return (await adaptateurDocx.ouvrir(octets)).modele() as DocxModel;
}
const texteDe = (m: DocxModel) => [...m.paragraphs.map((p) => p.text), ...m.tables.flatMap((t) => t.cells.map((c) => c.text))].join("\n");
const NBSP = " ";

describe("le constructeur de pièces commerciales — la mise en page des pièces de référence", () => {
  it("LA FACTURE (modèle Pharmagène) : numéro de client, « Facturer à », section sans chiffre, SOMME À PAYER, lettres en capitales, mode de paiement", async () => {
    const r = await construireDocumentCommercial(facture());
    expect(r.verification.bloquants).toEqual([]);
    expect(r.verification.ok).toBe(true);
    expect(r.verification.relu).toMatchObject({ numero: true, tiers: true, ttc: true, lettres: true });
    // Les chiffres de l'original : 3 × 2 500 000 = 7 500 000 HT, TVA 19 % = 1 425 000, TTC 8 925 000.
    expect(r.totaux?.totalHt).toBe(7_500_000);
    expect(r.totaux?.totalTva).toBe(1_425_000);
    expect(r.totaux?.totalTtc).toBe(8_925_000);
    expect(r.surPapierEnTete).toBe(false);
    const m = await modele(r.octets);
    const texte = texteDe(m);
    expect(texte).toContain("SARL PHARMAGENE");
    expect(texte).toContain("Siège Social : ");
    expect(texte).toContain("Numéro de client :");
    expect(texte).toContain("00003");
    expect(texte).toContain("Numéro de facture :");
    expect(texte).toContain("001/FS/26");
    expect(texte).toContain("Date de facture :");
    expect(texte).toContain("09/07/2026");
    expect(texte).toContain("Facturer à :");
    expect(texte).toContain("Tél/Fax : 031 90 78 89/79 21");
    expect(texte).toContain("RC : 99 B 62900");
    expect(texte).toContain("NIF : 099925006290089");
    expect(texte).toContain("AI : —"); // l'original imprime des tirets quand l'AI du client manque
    expect(texte).toContain("Document Ref :");
    const lignes = m.tables.find((t) => t.header[0] === "Description")!;
    expect(lignes.header).toEqual(["Description", "Quantité", "Prix unitaire HT", "Prix total HT"]);
    expect(lignes.rows).toBe(3); // en-tête + section + ligne chiffrée
    expect(lignes.cells.find((c) => c.row === 2 && c.col === 1)?.text).toBe("TRAVAUX DE CONSULTING");
    expect(lignes.cells.find((c) => c.row === 2 && c.col === 4)?.text).toBe("-");
    expect(lignes.cells.find((c) => c.row === 3 && c.col === 3)?.text).toBe(`2${NBSP}500${NBSP}000,00`);
    expect(texte).toContain("Arrêtée la présente facture à la somme de :");
    expect(texte).toContain("HUIT MILLIONS NEUF CENT VINGT-CINQ MILLE DINARS ALGÉRIENS");
    expect(texte).toContain("SOUS-TOTAL :");
    expect(texte).toContain("TAUX DE TVA :");
    expect(texte).toContain(`19${NBSP}%`);
    expect(texte).toContain("MONTANT TVA :");
    expect(texte).toContain("TOTAL TTC :");
    expect(texte).toContain("SOMME À PAYER :");
    expect(texte).toContain(`8${NBSP}925${NBSP}000,00`);
    expect(texte).toContain("PAIEMENT PAR CHÈQUE");
    expect(texte).toContain("OU VIREMENT BANCAIRE");
    // Sans papier en-tête, le code imprime l'identité en pied ; la banque aussi sur une facture.
    expect(texte).toContain("RC N° : 16/00-1010258 B 15");
    expect(texte).toContain("Banque : BNA — Agence Chéraga");
    expect(m.hasHeader).toBe(false);
  });

  it("LE BON DE COMMANDE (modèle Adventum) : B.C, A / Adresse de livraison, bande Date · Contact · Devis N° · Modalités, détails, sections grisées, Offert, Taxe Pub hors base TVA, totaux dans le tableau", async () => {
    const r = await construireDocumentCommercial(bonDeCommande());
    expect(r.verification.bloquants).toEqual([]);
    expect(r.verification.ok).toBe(true);
    // Les chiffres de l'original : 794 500 HT, Taxe Pub 2 % = 15 890, TVA 19 % = 150 955 (sur le HT seul), TTC 961 345.
    expect(r.totaux?.totalHt).toBe(794_500);
    expect(r.totaux?.taxes).toEqual([{ libelle: "Taxe Pub", taux: 0.02, base: 794_500, montant: 15_890 }]);
    expect(r.totaux?.totalTva).toBe(150_955);
    expect(r.totaux?.totalTtc).toBe(961_345);
    const m = await modele(r.octets);
    // LE TITRE AU CENTRE, sous l'en-tête (Direction, 10/2026), puis la ligne de référence de la pièce d'origine.
    expect(m.paragraphs[0].text).toBe("BON DE COMMANDE");
    expect(m.paragraphs[1].text).toBe("B.C : N° 012/DG/2026");
    const texte = texteDe(m);
    expect(texte).toContain("A :");
    expect(texte).toContain("Société : INSIGNE CONSEIL");
    expect(texte).toContain("Adresse : Bat 10B n°04 Cité les sources.");
    expect(texte).toContain("Adresse de livraison :");
    expect(texte).toContain("Siège Social : N° 14 Rue El Moudjahidine");
    expect(texte).toContain("TEL : 020 339 430");
    // Le téléphone n'est PAS répété sous le montant (le pied ne le porte plus sur un bon de commande).
    expect(texte).not.toContain("Tél. 020 339 430");
    const bande = m.tables.find((t) => t.header[0] === "Date")!;
    expect(bande.header).toEqual(["Date", "Contact", "Référence", "Modalités de paiement"]);
    expect(texte).toContain("Mme ABDELAZIZ ASSIA");
    expect(texte).toContain("Tel 0770530674");
    expect(texte).toContain("26/0576");
    expect(texte).toContain("du 20/07/2026");
    expect(texte).toContain("Chèque");
    const lignes = m.tables.find((t) => t.header[0] === "Désignation")!;
    // « Désignation | Unité | Qte | PU HT | Total HT » : la colonne Unité est toujours là sur un bon de commande.
    expect(lignes.header).toEqual(["Désignation", "Unité", "Qte", "PU HT", "Total HT"]);
    expect(texte).toContain("Impression quadri recto verso sur 300g");
    expect(texte).toContain("Campagne Raltégravir");
    expect(texte).toContain("Offert");
    expect(texte).toContain(`145${NBSP}000,00${NBSP}DZD`);
    expect(texte).toContain(`112${NBSP}500,00${NBSP}DZD`);
    // Les totaux sont les DERNIÈRES lignes du tableau des lignes, comme sur l'original.
    const dernieres = lignes.cells.filter((c) => c.row >= lignes.rows - 3).map((c) => c.text);
    expect(dernieres).toEqual(expect.arrayContaining(["Total HT", `794${NBSP}500,00${NBSP}DZD`, `Taxe Pub 2${NBSP}%`, `15${NBSP}890,00${NBSP}DZD`, `Frais TVA 19${NBSP}%`, `150${NBSP}955,00${NBSP}DZD`, "Montant TTC", `961${NBSP}345,00${NBSP}DZD`]));
    expect(texte).toContain("Arrêté le présent bon de commande à la somme de :");
    expect(texte).toContain("Neuf cent soixante et un mille trois cent quarante-cinq dinars algériens");
    // Sans papier : l'identité d'Adventum en pied.
    expect(texte).toContain("NIF : 002316101909460");
  });

  it("montre Unité, Remise et TVA seulement quand les lignes en portent — et le devis emprunte la mise en page du bon de commande", async () => {
    const r = await construireDocumentCommercial(bonDeCommande({
      type: "DEVIS", numero: "DEV-2026-0001", validiteJours: 15, referenceAmont: null, referenceAmontDate: null, taxes: null,
      lignes: [
        { designation: "Formation", quantite: 2, unite: "jour", prixUnitaire: 60_000, tva: 0.09, remise: 0.1 },
        { designation: "Support", quantite: 1, prixUnitaire: 10_000 },
      ],
    }));
    expect(r.verification.ok).toBe(true);
    const m = await modele(r.octets);
    expect(m.paragraphs[0].text).toBe("DEVIS");
    expect(m.paragraphs[1].text).toBe("DEVIS : N° DEV-2026-0001");
    const lignes = m.tables.find((t) => t.header[0] === "Désignation")!;
    expect(lignes.header).toEqual(["Désignation", "Unité", "Qte", "Remise", "TVA", "PU HT", "Total HT"]);
    const texte = texteDe(m);
    expect(texte).toContain("Validité");
    expect(texte).toContain("jusqu'au 21/08/2026");
    expect(texte).toContain("Client :");
    expect(texte).toContain("Émetteur :");
    expect(texte).toContain("Bon pour accord");
    expect(texte).toContain("Arrêté le présent devis à la somme de :");
    expect(texte).toContain(`Frais TVA 9${NBSP}%`);
    expect(texte).toContain(`Frais TVA 19${NBSP}%`);
  });

  it("pose la pièce sur le papier en-tête : en-tête et pied conservés, et le code n'imprime plus l'identité en pied — le papier la porte", async () => {
    const r = await construireDocumentCommercial(bonDeCommande({ livraison: { adresse: "Dépôt de Oued Smar", delai: "sous 10 jours", date: "2026-10-20" } }), { base: papierEnTeteDeDemonstration() });
    expect(r.verification.ok).toBe(true);
    expect(r.surPapierEnTete).toBe(true);
    const m = await modele(r.octets);
    expect(m.hasHeader).toBe(true);
    expect(m.hasFooter).toBe(true);
    const texte = texteDe(m);
    // « Adresse de livraison : <lieu> » puis le siège ; la date de livraison s'imprime en mention.
    expect(texte).toContain("Adresse de livraison : Dépôt de Oued Smar");
    expect(texte).toContain("Siège Social : N° 14 Rue El Moudjahidine");
    expect(texte).toContain("Date de livraison : 20/10/2026");
    expect(texte).toContain("Délai : sous 10 jours");
    expect(texte).not.toContain("RC N° :");
  });

  it("refuse une facture dont l'émetteur n'a pas ses mentions — rien n'est composé", async () => {
    const r = await construireDocumentCommercial(facture({ emetteur: { ...pharmagene, nif: null, nis: null } }));
    expect(r.verification.ok).toBe(false);
    expect(r.octets.length).toBe(0);
    expect(r.totaux).toBeNull();
    expect(r.verification.bloquants[0]).toMatch(/NIF/);
  });

  it("refuse de livrer une pièce où traîne un reste de brouillon, même si tout le reste est juste", async () => {
    const r = await construireDocumentCommercial(facture({ lignes: [{ designation: "Prestation TODO préciser", quantite: 1, prixUnitaire: 100 }] }));
    expect(r.verification.ok).toBe(false);
    expect(r.verification.bloquants.some((b) => /TODO/.test(b))).toBe(true);
  });
});

describe("le titre au centre et le bleu canard de la maison (Direction, 10/2026)", () => {
  const xmlDe = (octets: Buffer): string => new PizZip(octets).file("word/document.xml")!.asText();
  /** Le paragraphe `<w:p>` qui porte `texte` — le premier. */
  const paragrapheDe = (xml: string, texte: string): string => {
    const i = xml.indexOf(texte);
    expect(i, `« ${texte} » doit se lire dans le document`).toBeGreaterThan(-1);
    const debut = xml.lastIndexOf("<w:p>", i) >= 0 ? xml.lastIndexOf("<w:p>", i) : xml.lastIndexOf("<w:p ", i);
    return xml.slice(debut, xml.indexOf("</w:p>", i) + 6);
  };

  it("« BON DE COMMANDE » est un titre CENTRÉ, gras, à l'accent de la pièce — avant la ligne « B.C : N° … »", async () => {
    const r = await construireDocumentCommercial(bonDeCommande());
    const xml = xmlDe(r.octets);
    const titre = paragrapheDe(xml, "BON DE COMMANDE");
    expect(titre).toContain('<w:jc w:val="center"/>');
    expect(titre).toContain("<w:b/>");
    expect(titre).toContain('w:val="1F5C99"');
    expect(titre).toContain('<w:sz w:val="32"/>');
    expect(xml.indexOf("BON DE COMMANDE")).toBeLessThan(xml.indexOf("B.C"));
    // Le devis porte « DEVIS » — jamais « BON DE COMMANDE ».
    const d = await construireDocumentCommercial(bonDeCommande({ type: "DEVIS", numero: "DEV-2026-0002", referenceAmont: null, referenceAmontDate: null, taxes: null }));
    expect(xmlDe(d.octets)).not.toContain("BON DE COMMANDE");
    expect(paragrapheDe(xmlDe(d.octets), "DEVIS")).toContain('<w:jc w:val="center"/>');
  });

  it("sans couleur de charte, l'accent est le BLEU CANARD (R 8, V 112, B 132) — la bande des références, les totaux, le titre", async () => {
    const r = await construireDocumentCommercial(bonDeCommande({ couleur: null }));
    const xml = xmlDe(r.octets);
    expect(r.verification.ok).toBe(true);
    expect(paragrapheDe(xml, "BON DE COMMANDE")).toContain('w:val="087084"');
    // La bande d'en-tête des tableaux est remplie à l'accent.
    expect(xml).toMatch(/w:fill="087084"/);
    // Aucun rouge franc ne reste : ni le rouge Word, ni les rouges d'alerte courants.
    expect(xml).not.toMatch(/w:(?:val|fill|color)="(?:FF0000|C00000|DC2626|E30613|B91C1C)"/i);
    // Et la couleur d'une charte explicite l'emporte toujours (pièce déjà émise, marque réglée).
    const marque = await construireDocumentCommercial(bonDeCommande({ couleur: "#0B6E4F" }));
    expect(paragrapheDe(xmlDe(marque.octets), "BON DE COMMANDE")).toContain('w:val="0B6E4F"');
  });

  it("la facture garde sa mise en page de référence — « Facture » à droite de l'en-tête — mais prend le même accent", async () => {
    const f = await construireDocumentCommercial(facture({ couleur: null }));
    const xml = xmlDe(f.octets);
    expect(f.verification.ok).toBe(true);
    expect(xml).toMatch(/w:fill="087084"/);
    expect(xml).toContain("Facture");
    expect(xml).not.toContain("BON DE COMMANDE");
  });
});
