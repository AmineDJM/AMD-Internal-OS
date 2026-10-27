import { describe, expect, it } from "vitest";
import { dateLue, repererEntetes } from "@/lib/pieces-lues/entetes";

/** La facture d'un fournisseur, telle qu'un texte natif de PDF la rend — les chiffres du BC de référence (§118.135). */
const FACTURE = `SARL INSIGNE CONSEIL
Agence de communication
RC : 16/00-1234567B21   NIF : 001 916 012 345 678   AI : 16012345678   NIS : 001916012345690
FACTURE N° 001/FS/26
Alger, le 05/09/2026
Client : ADVENTUM PHARMA — NIF : 000016098765432
Désignation   Qté   P.U HT   Montant HT
Conception ADV   1   145 000,00   145 000,00
Fiche posologique   500   225,00   112 500,00
Total HT   794 500,00
Taxe Pub 2 %   15 890,00
TVA 19 %   150 955,00
Total TTC   961 345,00
Arrêtée la présente facture à la somme de : neuf cent soixante et un mille trois cent quarante-cinq dinars
Net à payer : 961 345,00 DA`;

describe("repererEntetes — l'en-tête et les totaux, lus par des règles et prouvés par leur extrait", () => {
  it("la facture du BC de référence : n°, date, identifiants, et chaque total avec sa preuve", () => {
    const r = repererEntetes(FACTURE);
    expect(r.type).toBe("FACTURE");
    expect(r.numero).toMatchObject({ valeur: "001/FS/26", ligne: 4, extrait: "FACTURE N° 001/FS/26" });
    expect(r.date?.valeur).toBe("2026-09-05");
    expect(r.totalHt).toEqual({ valeur: 794_500, raison: null, extrait: "Total HT 794 500,00", ligne: 10 });
    expect(r.taxes).toEqual([{ libelle: "Taxe Pub", taux: 0.02, montant: { valeur: 15_890, raison: null, extrait: "Taxe Pub 2 % 15 890,00", ligne: 11 } }]);
    expect(r.tva.map((t) => [t.taux, t.montant.valeur])).toEqual([[0.19, 150_955]]);
    expect(r.totalTtc?.valeur).toBe(961_345);
    expect(r.netAPayer?.valeur).toBe(961_345);
    expect(r.timbre).toBeNull();
    expect(r.conflits).toEqual([]);
  });

  it("« Total TVA » n'est jamais pris pour le total TTC — ni avant lui, ni à sa place", () => {
    const avec = repererEntetes("Total HT 794 500,00\nTotal TVA 150 955,00\nTotal TTC 961 345,00");
    expect(avec.totalTtc?.valeur).toBe(961_345);
    expect(avec.totalTva?.valeur).toBe(150_955);
    expect(avec.conflits).toEqual([]);
    const sans = repererEntetes("Total HT 794 500,00\nTVA 19 % 150 955,00\nTotal TVA 150 955,00");
    expect(sans.totalTtc).toBeNull();
    expect(sans.netAPayer).toBeNull();
    expect(sans.totalTva?.valeur).toBe(150_955);
    // Un « Montant TVA 19 % » est une TVA à 19 %, pas un total ; « Frais TVA 9 % » aussi.
    const r = repererEntetes("Montant TVA 19 % 150 955,00\nFrais TVA 9 % 2 700,00");
    expect(r.tva.map((t) => [t.taux, t.montant.valeur])).toEqual([[0.09, 2_700], [0.19, 150_955]]);
    expect(r.totalTva).toBeNull();
  });

  it("un « Sous-total », un « Total » sans qualificatif, un total « à reporter » ne sont pas le total HT — le HT net l'emporte sur le brut", () => {
    // Chaque cas SEUL : réunis, deux valeurs fautives feraient un conflit — et un `null` qui ne prouverait rien.
    expect(repererEntetes("TOTAL : 120 000,00").totalHt).toBeNull();
    expect(repererEntetes("Sous-total HT 50 000,00").totalHt).toBeNull();
    expect(repererEntetes("Sous total HT 70 000,00").totalHt).toBeNull();
    expect(repererEntetes("Total HT à reporter 400 000,00\nTotal HT 794 500,00").totalHt?.valeur).toBe(794_500);
    const r = repererEntetes("Total HT brut 58 420,00\nRemise globale 5 % 2 903,90\nTotal HT net 55 516,10");
    expect(r.totalHt?.valeur).toBe(55_516.1);
  });

  it("le même total imprimé deux fois différemment : aucune valeur n'est retenue, le conflit est nommé", () => {
    const r = repererEntetes("Total HT 400 000,00\nTotal HT 794 500,00\nTotal TTC 961 345,00");
    expect(r.totalHt).toBeNull();
    expect(r.conflits).toEqual([expect.objectContaining({ quoi: "HT", champ: "Total HT", valeurs: ["400 000,00", "794 500,00"] })]);
    // Imprimé deux fois À L'IDENTIQUE (un récapitulatif), ce n'est pas un conflit.
    expect(repererEntetes("Total HT 794 500,00\n…\nTotal HT 794 500,00").totalHt?.valeur).toBe(794_500);
  });

  it("plusieurs montants après une étiquette : aucun n'est retenu ; « (3 articles) » devant le montant n'en est pas un", () => {
    const r = repererEntetes("Total HT 794 500,00 15 890,00\nTotal TTC (3 articles) 961 345,00");
    expect(r.totalHt?.valeur).toBeNull();
    expect(r.totalHt?.raison).toMatch(/plusieurs montants/);
    expect(r.totalTtc?.valeur).toBe(961_345);
  });

  it("une ligne aplatie porte plusieurs totaux : chacun prend le sien ; une étiquette seule prend la ligne suivante", () => {
    const r = repererEntetes("Total HT 794 500,00 TVA 19% 150 955,00 Total TTC 961 345,00");
    expect([r.totalHt?.valeur, r.tva[0]?.montant.valeur, r.totalTtc?.valeur]).toEqual([794_500, 150_955, 961_345]);
    const col = repererEntetes("Devis N° DEV-2026-0012\nDate : 20/07/2026\nTotal HT\n120 000,00\nTVA 19 %\n22 800,00\nTotal TTC\n142 800,00");
    expect([col.totalHt?.valeur, col.tva[0]?.montant.valeur, col.totalTtc?.valeur]).toEqual([120_000, 22_800, 142_800]);
    // « Exonéré de TVA » n'est pas une étiquette seule : le montant d'en dessous ne devient pas une TVA.
    expect(repererEntetes("Exonéré de TVA\n120 000,00").totalTva).toBeNull();
  });

  it("« article 41 », un taux suivi de « % », une date ou la base d'une TVA ne sont pas des montants", () => {
    const r = repererEntetes([
      "TVA non applicable, article 41 du CIDTA",
      "Timbre 1 %",
      "TVA 9 % (base 30 000,00) : 2 700,00",
      "TVA 19 % sur 28 078,00 : 5 334,82",
      "Net à payer au 30/09/2026 : 66 773,95",
    ].join("\n"));
    expect(r.totalTva).toBeNull();
    expect(r.timbre).toBeNull();
    expect(r.tva.map((t) => [t.taux, t.montant.valeur])).toEqual([[0.09, 2_700], [0.19, 5_334.82]]);
    expect(r.netAPayer?.valeur).toBe(66_773.95);
  });

  it("un montant ambigu reste ILLISIBLE, avec son extrait — jamais deviné", () => {
    const r = repererEntetes("Total HT : 1.200");
    expect(r.totalHt).toMatchObject({ valeur: null, extrait: "Total HT : 1.200" });
    expect(r.totalHt?.raison).toMatch(/ambigu/);
  });

  it("les totaux de la fabrique elle-même : TVA par taux avec base, montant TVA, timbre, somme à payer", () => {
    const r = repererEntetes("SOUS-TOTAL : 58 078,00\nTVA 9 % (base 30 000,00) : 2 700,00\nTVA 19 % (base 28 078,00) : 5 334,82\nMONTANT TVA : 8 034,82\nDROIT DE TIMBRE : 661,13\nTOTAL TTC : 66 773,95\nSOMME À PAYER : 66 773,95");
    expect(r.totalHt).toBeNull(); // « SOUS-TOTAL » n'est pas dit HT : il n'est pas deviné.
    expect(r.tva.map((t) => t.montant.valeur)).toEqual([2_700, 5_334.82]);
    expect([r.totalTva?.valeur, r.timbre?.valeur, r.totalTtc?.valeur, r.netAPayer?.valeur]).toEqual([8_034.82, 661.13, 66_773.95, 66_773.95]);
  });

  it("une taxe additionnelle se reconnaît à son taux — deux écritures du même libellé ne font pas deux taxes", () => {
    const r = repererEntetes("TAXE PUB 2 % : 15 890,00\nTaxe Pub. 2 % 15 890,00\nTotal toutes taxes comprises 961 345,00");
    expect(r.taxes.map((t) => [t.taux, t.montant.valeur])).toEqual([[0.02, 15_890]]);
    expect(r.totalTtc?.valeur).toBe(961_345);
  });

  it("la date de la pièce : ni l'échéance, ni la livraison, ni celle de la pièce amont ; deux dates → conflit", () => {
    expect(repererEntetes("Facture N° 001 du 05/09/2026\nDate d'échéance : 30/09/2026\nDate de livraison 10/09/2026").date?.valeur).toBe("2026-09-05");
    const amont = repererEntetes("Bon de commande N° 012/DG/2026\nDevis n° DEV-2026-0012 du 20/07/2026");
    expect(amont.date).toBeNull();
    expect(repererEntetes("Suivant devis du 20/07/2026").date).toBeNull();
    const deux = repererEntetes("Date : 05/09/2026\nAlger, le 06/09/2026");
    expect(deux.date).toBeNull();
    expect(deux.conflits.map((c) => c.quoi)).toEqual(["DATE"]);
  });

  it("le premier numéro est celui de la pièce ; les autres sont des références (dont la pièce amont)", () => {
    const r = repererEntetes("Bon de commande N° 012/DG/2026\nSuivant devis n° DEV-2026-0012\nB.C N° 13/DG/2026 bc no 14");
    expect(r.type).toBe("BON_DE_COMMANDE");
    expect(r.numero?.valeur).toBe("012/DG/2026");
    expect(r.references.map((x) => `${x.type}:${x.numero}`)).toEqual(["BON_DE_COMMANDE:012/DG/2026", "DEVIS:DEV-2026-0012", "BON_DE_COMMANDE:13/DG/2026"]);
    expect(repererEntetes("FACTURE\nTotal HT 12 000,00").type).toBe("FACTURE");
  });

  it("NIF, RC, NIS et AI : en LISTES (fournisseur et client), normalisés ; une forme courte ne compte qu'en majuscules", () => {
    const r = repererEntetes(FACTURE);
    expect(r.nif.map((x) => x.valeur)).toEqual(["001916012345678", "000016098765432"]);
    expect(r.rc.map((x) => x.valeur)).toEqual(["16001234567B21"]);
    expect(r.ai.map((x) => x.valeur)).toEqual(["16012345678"]);
    expect(r.nis.map((x) => x.valeur)).toEqual(["001916012345690"]);
    // « j'ai », « rc » en minuscules : de la prose, pas des identifiants.
    const prose = repererEntetes("j'ai 12345678901 ; le rc : 16/00-1234567B21 de la société");
    expect([prose.ai, prose.rc]).toEqual([[], []]);
    const longues = repererEntetes("A.I : 16012345678  Art. Imp. 16012345679  R.C 99B0123456  NIF : 12345");
    expect(longues.ai.map((x) => x.valeur)).toEqual(["16012345678", "16012345679"]);
    expect(longues.rc.map((x) => x.valeur)).toEqual(["99B0123456"]);
    expect(longues.nif).toEqual([expect.objectContaining({ valeur: null, raison: expect.stringMatching(/15 à 20 chiffres/) })]);
  });

  it("une virgule ferme l'identifiant, elle ne le cache pas — les parties d'un contrat citées en ligne", () => {
    const r = repererEntetes("Et : ClimTech SARL, NIF 001616098765432, RC 16/00-0987654B21, ci-après « le Prestataire ».");
    expect(r.nif.map((x) => x.valeur)).toEqual(["001616098765432"]);
    expect(r.rc.map((x) => x.valeur)).toEqual(["16000987654B21"]);
    // Ce qui suit la virgule n'est jamais pris pour la suite de l'identifiant.
    expect(repererEntetes("NIF 001616098765432; 77").nif.map((x) => x.valeur)).toEqual(["001616098765432"]);
  });
});

describe("dateLue — une date imprimée, en ISO", () => {
  it("lit JJ/MM/AAAA, JJ-MM-AA, l'ISO et les mois en lettres ; refuse le 31/02 et le texte autour", () => {
    expect(dateLue("05/09/2026")).toBe("2026-09-05");
    expect(dateLue("5-9-26")).toBe("2026-09-05");
    expect(dateLue("2026-09-05")).toBe("2026-09-05");
    expect(dateLue("1er octobre 2026")).toBe("2026-10-01");
    expect(dateLue("05 Septembre 2026")).toBe("2026-09-05");
    expect(dateLue("31/02/2026")).toBeNull();
    expect(dateLue("le 05/09/2026")).toBeNull();
    expect(dateLue("")).toBeNull();
    expect(dateLue(20260905)).toBeNull();
  });
});
