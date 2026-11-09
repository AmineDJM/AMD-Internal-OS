import { describe, expect, it } from "vitest";
import type { LigneLue, PieceLue } from "@/lib/pieces-lues/structure";
import {
  articleDuCatalogue, ecartDeLaFacture, lectureFactureDepense, ligneDesTaxes, lignesDeLaFacture, lignesProposeesDepense,
  LIBELLE_TAXES, objetDeLaFacture,
} from "./lecture-facture";

const CATALOGUE = [
  { id: "ram", name: "Ramette papier A4" },
  { id: "sty", name: "Stylo bille bleu" },
  { id: "enc", name: "Encre" },
];

const ligne = (rang: number, designation: string, over: Partial<LigneLue> = {}): LigneLue => ({
  rang, designation, designationCoupee: false, reference: null, unite: null, quantite: 1, prixUnitaire: null,
  remise: null, tva: null, montantHt: null, section: false, forfait: false, illisibles: [], ...over,
} as LigneLue);

const piece = (lignes: LigneLue[]): PieceLue => ({
  type: null, numero: "245", date: "2026-11-08", devise: "DZD", modePaiement: null,
  fournisseur: { nom: "Librairie El Nour", nif: null, rc: null, nis: null, ai: null, adresse: null },
  tvaDefaut: null, remiseGlobale: null, taxes: [], lignes, totaux: { ht: null, tva: null, taxes: null, timbre: null, ttc: null },
  illisibles: [], ecartees: 0, coupees: 0,
} as unknown as PieceLue);

describe("la dépense des moyens généraux lue sur sa facture (09/11/2026)", () => {
  it("reconnaît l'article du catalogue : même nom, ou nom contenu en mots entiers — jamais au hasard", () => {
    expect(articleDuCatalogue("RAMETTE papier a4", CATALOGUE)?.id).toBe("ram");
    expect(articleDuCatalogue("Ramette papier A4 80g blanc", CATALOGUE)?.id).toBe("ram");
    expect(articleDuCatalogue("Stylo bille bleu Bic x10", CATALOGUE)?.id).toBe("sty");
    // « Encre » est contenu en mot entier ; « encreur » ne l'est pas.
    expect(articleDuCatalogue("Cartouche encre noire", CATALOGUE)?.id).toBe("enc");
    expect(articleDuCatalogue("Tampon encreur", CATALOGUE)).toBeNull();
    expect(articleDuCatalogue("Agrafeuse", CATALOGUE)).toBeNull();
    // Deux articles du même nom : aucun choisi.
    expect(articleDuCatalogue("Encre", [...CATALOGUE, { id: "enc2", name: "ENCRE" }])).toBeNull();
  });

  it("chaque ligne lue devient un article : quantité, montant (imprimé, sinon quantité × prix), catalogue ou nouveau", () => {
    const p = piece([
      ligne(1, "Ramette papier A4 80g", { quantite: 10, prixUnitaire: 650, montantHt: 6500 }),
      ligne(2, "agrafeuse  métal", { quantite: 2, prixUnitaire: 1200 }),
      ligne(3, "Fournitures diverses", { section: true, quantite: null }),
      ligne(4, "Livraison", { quantite: null, montantHt: null, prixUnitaire: null }),
    ]);
    expect(lignesDeLaFacture(p, CATALOGUE)).toEqual([
      { rang: 1, label: "Ramette papier A4", quantity: 10, amount: 6500, articleId: "ram", ajouterAuCatalogue: false, notes: [] },
      { rang: 2, label: "Agrafeuse métal", quantity: 2, amount: 2400, articleId: null, ajouterAuCatalogue: true, notes: [] },
      { rang: 4, label: "Livraison", quantity: 1, amount: 0, articleId: null, ajouterAuCatalogue: true, notes: ["montant illisible : saisissez-le depuis la facture"] },
    ]);
  });

  it("la ligne des taxes : un reste plausible du total imprimé (TVA) ; au-delà, l'écart se dit au lieu d'être comblé", () => {
    const lues = lignesDeLaFacture(piece([ligne(1, "Ramette papier A4", { quantite: 10, montantHt: 10000 })]), CATALOGUE);
    expect(ligneDesTaxes(11900, lues)).toMatchObject({ rang: null, label: LIBELLE_TAXES, amount: 1900 });
    expect(ligneDesTaxes(10000.4, lues)).toBeNull();
    expect(ligneDesTaxes(20000, lues)).toBeNull();
    expect(ecartDeLaFacture(20000, lues)).toMatch(/écart de 10\s000 DZD/);
    expect(ecartDeLaFacture(10000, lues)).toBeNull();
  });

  it("la lecture traduite pour le formulaire : objet, précisions, taxes ajoutées, et les lignes proposées à la confirmation", () => {
    const p = piece([
      ligne(1, "Ramette papier A4", { quantite: 10, montantHt: 6500 }),
      ligne(2, "Agrafeuse", { quantite: 2, montantHt: 2400 }),
    ]);
    const l = lectureFactureDepense({
      lectureId: "lec", nomFichier: "facture.pdf", noteMethode: "PDF", sansLignes: null, piece: p, fournisseurNom: "Librairie El Nour",
      entetes: { netAPayer: null, totalTtc: { valeur: 10591, raison: null, extrait: "", ligne: 1 } as never, numero: { valeur: "245" } as never, date: { valeur: "2026-11-08" } as never },
    }, CATALOGUE);
    expect(l).toMatchObject({
      fournisseur: "Librairie El Nour", numero: "245", totalImprime: 10591,
      objet: "Achat — Librairie El Nour, facture n° 245",
      precisions: "Librairie El Nour, facture n° 245, du 08/11/2026",
      ecart: null, sansLignes: null,
    });
    expect(l.lignes.map((x) => [x.label, x.amount])).toEqual([["Ramette papier A4", 6500], ["Agrafeuse", 2400], [LIBELLE_TAXES, 1691]]);
    // La confirmation ne propose que les lignes LUES — la ligne des taxes est composée par nous.
    expect(lignesProposeesDepense(p, CATALOGUE)).toEqual([
      { rang: 1, designation: "Ramette papier A4", quantite: 10, prixUnitaire: 650 },
      { rang: 2, designation: "Agrafeuse", quantite: 2, prixUnitaire: 1200 },
    ]);
    expect(objetDeLaFacture(null, null)).toBe("");
  });
});
