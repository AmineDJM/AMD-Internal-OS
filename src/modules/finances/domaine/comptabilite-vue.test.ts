import { describe, expect, it } from "vitest";
import {
  categorieDuTypePiece, choixDePeriode, etatDeLaFacture, libelleJustificatif, libelleTiers, lirePeriodeListe, lireVueCompta,
  montantRecherche, motifDeContrePassation, NOTE_IMPORT_RELEVE, origineDeLEcriture, origineSansDossier, peutDemanderLePaiement,
  peutRattacherAUnPaiement, REFUS_DEPENSE_SANS_JUSTIFICATIF, refusDepenseSansJustificatif,
} from "./comptabilite-vue";

/** Les règles pures de l'écran « Comptabilité » (maquette validée, 24/11/2026). */

describe("l'autre partie : « Payé à » / « Reçu de » — jamais « bénéficiaire »", () => {
  it("une dépense est payée À quelqu'un, une recette est reçue DE quelqu'un", () => {
    expect(libelleTiers("OUT")).toBe("Payé à");
    expect(libelleTiers("IN")).toBe("Reçu de");
    expect(libelleTiers("n'importe quoi")).toBe("Payé à");
  });
});

describe("l'origine d'une écriture se lit dans ses liens", () => {
  const ordre = (sourceType: string | null, o: Partial<{ caisse: boolean; category: string }> = {}) =>
    ({ reference: "OD-2026-412", sourceType, category: o.category ?? "EVENEMENT", caisse: o.caisse ?? false });

  it("l'ordre réglé et la famille de sa source : Ad & Pro, Paie, BV, Information médicale, Caisse", () => {
    expect(origineDeLEcriture({ category: "EVENEMENT", ordre: ordre("AD_PRO_ITEM") })).toBe("Ad & Pro · OD-2026-412");
    expect(origineDeLEcriture({ category: "EVENEMENT", ordre: ordre("SPONSORING") })).toBe("Ad & Pro · OD-2026-412");
    expect(origineDeLEcriture({ category: "SALAIRE", ordre: ordre("PAYROLL") })).toBe("Paie · OD-2026-412");
    expect(origineDeLEcriture({ category: "AUTRE", ordre: ordre("REGULATORY_PRODUCT") })).toBe("BV · OD-2026-412");
    expect(origineDeLEcriture({ category: "AUTRE", ordre: ordre("MEDICAL_INFO_DECLARATION") })).toBe("Information médicale · OD-2026-412");
    // La remise d'une caisse d'avance se dit « Caisse », quelle que soit la source de l'ordre.
    expect(origineDeLEcriture({ category: "AUTRE", ordre: ordre(null, { caisse: true }) })).toBe("Caisse · OD-2026-412");
  });

  it("un ordre sans source dit sa catégorie quand elle suffit (impôts), sinon « Ordre de dépense » ; une source inconnue garde son nom", () => {
    expect(origineDeLEcriture({ category: "IMPOT", ordre: ordre(null, { category: "IMPOT" }) })).toBe("Impôts & cotisations · OD-2026-412");
    expect(origineDeLEcriture({ category: "AUTRE", ordre: ordre(null, { category: "AUTRE" }) })).toBe("Ordre de dépense · OD-2026-412");
    expect(origineDeLEcriture({ category: "AUTRE", ordre: ordre("NOUVEAU_CIRCUIT") })).toBe("NOUVEAU_CIRCUIT · OD-2026-412");
  });

  it("sans ordre : la compensation d'abord, puis la paie, la facture réglée, l'import, la catégorie, la saisie", () => {
    expect(origineDeLEcriture({ category: "FOURNISSEUR", compensation: "CONTRE_PASSATION", ordre: ordre("AD_PRO_ITEM") })).toBe("Contre-passation");
    expect(origineDeLEcriture({ category: "AUTRE", compensation: "A_RECUPERER" })).toBe("À récupérer");
    expect(origineDeLEcriture({ category: "SALAIRE", paie: true })).toBe("Paie");
    expect(origineDeLEcriture({ category: "AUTRE", factureReglee: "F-0451" })).toBe("Facture · F-0451");
    expect(origineDeLEcriture({ category: "CHARGES", notes: `${NOTE_IMPORT_RELEVE} Ligne 4.` })).toBe("Import relevé");
    expect(origineDeLEcriture({ category: "IMPOT" })).toBe("Impôts & cotisations");
    expect(origineDeLEcriture({ category: "BANQUE" })).toBe("Frais bancaires");
    expect(origineDeLEcriture({ category: "FOURNISSEUR", notes: "note libre" })).toBe("Écriture manuelle");
  });

  it("une origine sans dossier (saisie, import, catégorie) n'ouvre rien", () => {
    expect(origineSansDossier("Écriture manuelle")).toBe(true);
    expect(origineSansDossier("Import relevé")).toBe(true);
    expect(origineSansDossier("Ad & Pro · OD-2026-412")).toBe(false);
  });
});

describe("le justificatif", () => {
  it("la colonne dit la pièce, ou son absence (et si elle a été demandée)", () => {
    expect(libelleJustificatif([{ nom: "F-0912.pdf" }, { nom: "bc.pdf" }])).toEqual({ present: true, libelle: "✓ F-0912.pdf" });
    expect(libelleJustificatif([])).toEqual({ present: false, libelle: "✕ manquant" });
    expect(libelleJustificatif([], true)).toEqual({ present: false, libelle: "✕ manquant · demandé" });
  });

  it("une DÉPENSE sans pièce est refusée, avec le remède ; une recette passe", () => {
    expect(refusDepenseSansJustificatif("OUT", 0)).toBe(REFUS_DEPENSE_SANS_JUSTIFICATIF);
    expect(REFUS_DEPENSE_SANS_JUSTIFICATIF).toMatch(/^Joignez le justificatif/);
    expect(refusDepenseSansJustificatif("OUT", 1)).toBeNull();
    expect(refusDepenseSansJustificatif("IN", 0)).toBeNull();
  });

  it("le type de pièce range le fichier sous sa catégorie ; un type inconnu tombe en « autre »", () => {
    expect(categorieDuTypePiece("Facture")).toBe("INVOICE");
    expect(categorieDuTypePiece("Bordereau")).toBe("PAYMENT_SLIP");
    expect(categorieDuTypePiece("Bon de versement")).toBe("PAYMENT_SLIP");
    expect(categorieDuTypePiece("Quittance")).toBe("PAYMENT_RECEIPT");
    expect(categorieDuTypePiece("???")).toBe("OTHER");
    expect(categorieDuTypePiece(null)).toBe("OTHER");
  });
});

describe("l'état d'une facture du registre — « Facture non payée » et son geste", () => {
  const recue = { direction: null, paidDate: null, settlementTxId: null, expenseOrderId: null, statutOrdre: null, demandes: [] as string[] };

  it("une facture reçue que rien ne paie ni ne demande : NON PAYÉE — on peut créer sa demande, ou la rattacher", () => {
    expect(etatDeLaFacture(recue)).toBe("NON_PAYEE");
    expect(peutDemanderLePaiement("NON_PAYEE")).toBe(true);
    expect(peutRattacherAUnPaiement("NON_PAYEE")).toBe(true);
  });

  it("demandée : un ordre vivant, ou une demande de paiement vivante — plus de geste (pas deux paiements)", () => {
    expect(etatDeLaFacture({ ...recue, expenseOrderId: "o", statutOrdre: "PENDING" })).toBe("DEMANDEE");
    expect(etatDeLaFacture({ ...recue, demandes: ["DP-2026-207"] })).toBe("DEMANDEE");
    expect(peutDemanderLePaiement("DEMANDEE")).toBe(false);
    // Un ordre ANNULÉ ne la porte plus : elle redevient à payer.
    expect(etatDeLaFacture({ ...recue, expenseOrderId: "o", statutOrdre: "CANCELLED" })).toBe("NON_PAYEE");
  });

  it("payée : date de règlement, écriture, ordre réglé, ou justificatif d'un paiement déjà fait", () => {
    expect(etatDeLaFacture({ ...recue, paidDate: new Date() })).toBe("PAYEE");
    expect(etatDeLaFacture({ ...recue, settlementTxId: "t" })).toBe("PAYEE");
    expect(etatDeLaFacture({ ...recue, expenseOrderId: "o", statutOrdre: "PAID" })).toBe("PAYEE");
    expect(etatDeLaFacture({ ...recue, justifiePaiement: true })).toBe("PAYEE");
    expect(peutDemanderLePaiement("PAYEE")).toBe(false);
  });

  it("une facture ÉMISE s'encaisse — jamais de demande de paiement", () => {
    expect(etatDeLaFacture({ ...recue, direction: "IN" })).toBe("NON_ENCAISSEE");
    expect(etatDeLaFacture({ ...recue, direction: "IN", paidDate: "2026-11-02" })).toBe("ENCAISSEE");
    expect(peutDemanderLePaiement("NON_ENCAISSEE")).toBe(false);
  });
});

describe("la recherche d'un montant", () => {
  it("« 450 000 », « 450000 », « 450 000,00 DZD » : un montant ; « F-12 », « 12 » : non", () => {
    expect(montantRecherche("450 000")).toBe(450000);
    expect(montantRecherche("450000")).toBe(450000);
    expect(montantRecherche("450 000,00 DZD")).toBe(450000);
    expect(montantRecherche("128 300")).toBe(128300);
    expect(montantRecherche("F-12")).toBeNull();
    expect(montantRecherche("12")).toBeNull();
    expect(montantRecherche("Sonelgaz")).toBeNull();
  });
});

describe("la période d'une liste et l'onglet", () => {
  it("trois choix : le mois en cours, le précédent, l'année — janvier sait revenir à décembre", () => {
    expect(choixDePeriode("2026-11").map((p) => [p.cle, p.libelle])).toEqual([["2026-11", "Nov. 2026"], ["2026-10", "Oct. 2026"], ["2026", "Année 2026"]]);
    expect(choixDePeriode("2027-01")[1]).toMatchObject({ cle: "2026-12", libelle: "Déc. 2026" });
  });

  it("l'adresse est lue telle quelle si elle est valide (un lien du Résultat vise n'importe quel mois), sinon le mois en cours", () => {
    expect(lirePeriodeListe("2026-03", "2026-11")).toMatchObject({ debut: "2026-03", fin: "2026-03", libelle: "Mars 2026" });
    expect(lirePeriodeListe("2026", "2026-11")).toMatchObject({ debut: "2026-01", fin: "2026-12" });
    expect(lirePeriodeListe("2026-13", "2026-11").cle).toBe("2026-11");
    expect(lirePeriodeListe(undefined, "2026-11").cle).toBe("2026-11");
  });

  it("l'onglet : Dépenses par défaut", () => {
    expect(lireVueCompta("rec")).toBe("rec");
    expect(lireVueCompta("res")).toBe("res");
    expect(lireVueCompta("x")).toBe("dep");
    expect(lireVueCompta(undefined)).toBe("dep");
  });
});

describe("le motif d'une contre-passation est obligatoire", () => {
  it("un motif, une précision, ou les deux joints ; rien = refus", () => {
    expect(motifDeContrePassation("Saisie en double", "")).toBe("Saisie en double");
    expect(motifDeContrePassation("", "  rejet BNA ")).toBe("rejet BNA");
    expect(motifDeContrePassation("Erreur de montant", "lu 18 600 au lieu de 16 800")).toBe("Erreur de montant — lu 18 600 au lieu de 16 800");
    expect(motifDeContrePassation(" ", null)).toBeNull();
  });
});
