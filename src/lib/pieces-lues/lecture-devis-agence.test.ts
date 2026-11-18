import { describe, expect, it } from "vitest";
import { lireTableau, reconcilier, type Rangee } from "./tableau";
import { repererEntetes } from "./entetes";
import { identiteEmetteurDuTexte } from "./emetteur";
import { emetteurEtDestinataire, nomDuFichier } from "./emetteur-destinataire";
import { montantTtcDuDevis } from "./prerempli-devis-promo";

/**
 * LA RECETTE DU PARCOURS AGENCE (18/11/2026) — pas 7 et 8 : « l'IA ne lit pas bien les fichiers, ni les lignes ».
 * Un devis d'agence banal (en-tête à deux colonnes, tableau « Désignation / Qté / P.U. HT / Total HT » sans N°) se
 * lisait avec 0 ligne, sans référence, au HT au lieu du TTC, et au nom de son FICHIER (« S1 »). Chaque cas ici est
 * la mise en page réelle de ces devis.
 */

const TEXTE_DEVIS = `Horizon Com & Stands

45, bd Krim Belkacem, Oran
Tél. 041 00 00 02  ·  commercial@horizon-com.test
NIF 000031000000002  ·  RC 31/00-TEST002
NIS 000031000000002

DEVIS

N° HC-TEST-77/2026

Date : 16/11/2026

CLIENT
Adventum Pharma — Direction Marketing
Alger

Désignation
Qté
P.U. HT
Total HT

Stand parapluie 9 m² avec comptoir
1
690 000
690 000

Total HT
1 290 000 DZD

TVA 19 %
245 100 DZD

Total TTC
1 535 100 DZD`;

const GROUPE = [{ id: "adv", noms: ["Adventum Pharma"], nifs: [], rcs: [] }];

describe("le tableau d'un devis SANS colonne N°", () => {
  let y = 0;
  const R = (...cells: [string, number][]): Rangee => {
    y += 14;
    return { page: 1, y, taille: 8, cellules: cells.map(([texte, x0]) => ({ texte, x0, x1: x0 + texte.length * 4 })) };
  };
  const L = (des: string, q: string, pu: string, m: string) => R([des, 56], [q, 330], [pu, 400], [m, 480]);

  it("chaque rangée chiffrée sous l'en-tête est une ligne, numérotée dans l'ordre — et la somme fait le HT imprimé", () => {
    y = 0;
    const t = lireTableau([
      R(["Objet : Stand 9 m² — Journée régionale, 12/12/2026", 56]),
      R(["Désignation", 56], ["Qté", 330], ["P.U. HT", 400], ["Total HT", 480]),
      L("Stand modulaire 9 m² avec comptoir", "1", "620 000", "620 000"),
      L("Kakémono roll-up 85 × 200 cm", "4", "18 000", "72 000"),
      L("Brochure A4, 4 pages, couché 170 g", "2000", "120", "240 000"),
      L("Transport, montage et démontage", "1", "248 000", "248 000"),
      R(["Total HT", 400], ["1 180 000 DZD", 480]),
      R(["TVA 19 %", 400], ["224 200 DZD", 480]),
      R(["Délai : livraison le 11/12/2026, 2 jours avant", 56]),
    ]);
    expect(t.lignes.map((l) => [l.numero, l.designation, l.quantite, l.prixUnitaire, l.montant])).toEqual([
      [1, "Stand modulaire 9 m² avec comptoir", 1, 620_000, 620_000],
      [2, "Kakémono roll-up 85 × 200 cm", 4, 18_000, 72_000],
      [3, "Brochure A4, 4 pages, couché 170 g", 2000, 120, 240_000],
      [4, "Transport, montage et démontage", 1, 248_000, 248_000],
    ]);
    expect(t.trous).toEqual([]);
    expect(reconcilier(t, t.totalHt).juste).toBe(true);
  });

  it("une rangée de texte seul sous une ligne reste la suite de sa désignation", () => {
    y = 0;
    const t = lireTableau([
      R(["Désignation", 56], ["Qté", 330], ["P.U. HT", 400], ["Total HT", 480]),
      L("Kakémono roll-up", "4", "18 000", "72 000"),
      { page: 1, y: y + 9, taille: 8, cellules: [{ texte: "impression recto", x0: 56, x1: 120 }] },
    ]);
    expect(t.lignes.map((l) => l.designation)).toEqual(["Kakémono roll-up impression recto"]);
  });

  it("quand l'en-tête nomme une colonne N°, une rangée non numérotée n'est toujours pas une ligne", () => {
    y = 0;
    const t = lireTableau([
      R(["N°", 40], ["Désignation", 70], ["Qté", 330], ["P.U. HT", 400], ["Total HT", 480]),
      R(["1", 44], ["Stylo", 70], ["100", 335], ["45", 405], ["4 500", 485]),
      R(["Option non retenue", 70], ["10", 335], ["300", 405], ["3 000", 485]),
    ]);
    expect(t.lignes.map((l) => l.designation)).toEqual(["Stylo"]);
  });
});

describe("l'en-tête d'un devis d'agence", () => {
  it("le titre « DEVIS » seul sur sa ligne, puis « N° … » dessous : c'est la référence du devis", () => {
    const e = repererEntetes(TEXTE_DEVIS);
    expect(e.type).toBe("DEVIS");
    expect(e.numero?.valeur).toBe("HC-TEST-77/2026");
  });

  it("un « N° … » sans titre au-dessus ne devient pas une référence", () => {
    expect(repererEntetes("Atlas SARL\nAlger\n\nN° 0412\n").numero).toBeNull();
  });

  it("le montant du formulaire est le TTC imprimé — le HT seulement quand le papier n'imprime aucune taxe", () => {
    expect(montantTtcDuDevis({ entetes: repererEntetes(TEXTE_DEVIS), piece: null })).toBe(1_535_100);
    expect(montantTtcDuDevis({ entetes: repererEntetes("PRO FORMA\nTotal HT 300 000 DZD\nExonéré"), piece: null })).toBe(300_000);
    expect(montantTtcDuDevis({ entetes: repererEntetes("DEVIS\nTotal HT 100 000\nTVA 19 % 19 000"), piece: null })).toBeNull();
  });
});

describe("le fournisseur d'un devis d'agence", () => {
  it("le NIF s'arrête où il s'arrête, même suivi du RC sur la même ligne", () => {
    expect(identiteEmetteurDuTexte(TEXTE_DEVIS).nif).toBe("000031000000002");
  });

  it("le nom imprimé en tête de page, en casse de titre, l'emporte sur le nom du fichier", () => {
    const r = emetteurEtDestinataire({ texte: TEXTE_DEVIS, nomFichier: "S1-devis-2-Horizon-Com.pdf", groupe: GROUPE });
    expect(r.emetteur.nom).toBe("Horizon Com & Stands");
    expect(r.emetteur.source).toBe("en-tête");
  });

  it("un nom coupé sur un mot de liaison se recolle ; le titre « PRO FORMA » n'est jamais un nom", () => {
    const texte = "Association Oranaise de\nCardiologie\n\nService de cardiologie, CHU d'Oran\nNIF 000031000000020\n\nPRO FORMA\n\nN° PF-AOC-031";
    expect(emetteurEtDestinataire({ texte, nomFichier: "S3-proforma.pdf", groupe: GROUPE }).emetteur.nom).toBe("Association Oranaise de Cardiologie");
  });

  it("un mot du nom de fichier qui porte un chiffre (« S1 », « V2 ») n'est pas un nom", () => {
    expect(nomDuFichier("S1-devis-2-Horizon-Com.pdf")).toBeNull();
    expect(nomDuFichier("Devis matériel promotionnel INSIGNE.pdf")).toBe("INSIGNE");
  });
});
