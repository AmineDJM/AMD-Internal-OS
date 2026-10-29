import { describe, expect, it } from "vitest";
import { TAUX_TVA_ADMIS } from "@/lib/artifact/factory/commercial";
import {
  refusValidationLigne, lignesValidees, lignesDuBon, totauxValides, decisionBcDuDevis, refusBcFige, refusChangementDeValidation,
  refusEditionDesLignes, etapeDEnsemble, refusDepassement, refusGenerationBC, lignesDepuisLaLecture, ecartAvecLeTotalImprime,
  refusTauxDuDevis, TAUX_TVA_PCT_ADMIS,
  type LigneDevisPoste, type EnteteDevisPoste, type BcActifDuDevis,
} from "./devis-poste";

/**
 * LES RÈGLES PURES DES LIGNES DE DEVIS ET DU BC QU'ELLES FONT GÉNÉRER (§118.206). Le flux, par les vraies actions, est
 * dans `devis-bc-flow.test.ts` : ce banc-ci tient la décision seule, et chaque cas nomme ce qui le ferait tomber.
 */

const ENTETE: EnteteDevisPoste = { tvaRate: 19, extraTaxLabel: null, extraTaxRate: null, announcedTotal: null };
const ligne = (id: string, o: Partial<LigneDevisPoste> = {}): LigneDevisPoste => ({
  id, position: 0, reference: `Réf ${id}`, unit: "u", quantity: 10, unitPrice: 1000, lue: null, aVerifier: null, validatedItemId: null, bcId: null, ...o,
});
const bc = (o: Partial<BcActifDuDevis> = {}): BcActifDuDevis => ({ id: "bc1", reference: "BC-0001", etape: "A_VALIDER", signe: false, facture: null, ...o });

describe("une ligne se valide COMPLÈTE", () => {
  it("refuse une désignation vide, une quantité nulle ou illisible, un prix illisible — et nomme ce qui manque", () => {
    expect(refusValidationLigne(ligne("a"))).toBeNull();
    expect(refusValidationLigne(ligne("a", { reference: "  " }))).toMatch(/sans désignation/);
    expect(refusValidationLigne(ligne("a", { quantity: null }))).toMatch(/quantité est illisible/);
    expect(refusValidationLigne(ligne("a", { quantity: 0 }))).toMatch(/quantité est illisible ou nulle/);
    expect(refusValidationLigne(ligne("a", { unitPrice: null }))).toMatch(/prix unitaire est illisible/);
    expect(refusValidationLigne(ligne("a", { unitPrice: -1 }))).toMatch(/prix unitaire est illisible/);
    // Un prix NUL est lisible (une ligne offerte) : le refuser serait un refus à tort.
    expect(refusValidationLigne(ligne("a", { unitPrice: 0 }))).toBeNull();
  });

  it("ne garde, pour un poste, que les lignes validées POUR LUI et complètes, dans l'ordre du devis", () => {
    const lignes = [
      ligne("c", { position: 2, validatedItemId: "p1" }),
      ligne("a", { position: 0, validatedItemId: "p1" }),
      ligne("autre", { position: 1, validatedItemId: "p2" }),
      ligne("sans-prix", { position: 3, validatedItemId: "p1", unitPrice: null }),
      ligne("nonvalidee", { position: 4 }),
    ];
    expect(lignesValidees(lignes, "p1").map((l) => l.id)).toEqual(["a", "c"]);
    expect(lignesValidees(lignes, "p2").map((l) => l.id)).toEqual(["autre"]);
  });
});

describe("le BC ne porte QUE les lignes validées", () => {
  const lignes = [
    ligne("a", { position: 0, reference: "Fiche posologique", quantity: 100, unitPrice: 50, validatedItemId: "p1" }),
    ligne("b", { position: 1, reference: "Brochure", quantity: 10, unitPrice: 200 }),
    ligne("c", { position: 2, reference: "Kakémono", quantity: 2, unitPrice: 4000, validatedItemId: "p1" }),
  ];
  it("compose les lignes du BC d'après les validées, et le total d'après elles seules", () => {
    expect(lignesDuBon(ENTETE, lignes, "p1").map((l) => l.designation)).toEqual(["Fiche posologique", "Kakémono"]);
    const t = totauxValides(ENTETE, lignes, "p1");
    expect(t.ht).toBe(13_000);
    expect(t.ttc).toBe(15_470);
  });
  it("la taxe additionnelle reste HORS de la base de TVA (la même arithmétique que le devis du matériel promotionnel)", () => {
    const t = totauxValides({ ...ENTETE, extraTaxLabel: "Taxe Pub", extraTaxRate: 2 }, lignes, "p1");
    expect(t.ttc).toBe(15_470 + 260);
  });
});

describe("ce qu'il y a à faire entre les lignes validées et le BC", () => {
  const base = [ligne("a", { validatedItemId: "p1" }), ligne("b", { validatedItemId: "p1" }), ligne("c")];
  it("AUCUNE_LIGNE, puis A_GENERER dès qu'une ligne est validée sans BC", () => {
    expect(decisionBcDuDevis([ligne("a")], "p1", null).etat).toBe("AUCUNE_LIGNE");
    const d = decisionBcDuDevis(base, "p1", null);
    expect(d.etat).toBe("A_GENERER");
    expect(d.ajoutees).toEqual(["a", "b"]);
  });
  it("A_JOUR quand le BC porte exactement les lignes validées", () => {
    const lignes = base.map((l) => (l.validatedItemId ? { ...l, bcId: "bc1" } : l));
    expect(decisionBcDuDevis(lignes, "p1", bc()).etat).toBe("A_JOUR");
  });
  it("A_REGENERER quand une ligne a été cochée ou décochée depuis — un BC non signé se révise", () => {
    const apresCoche = base.map((l) => ({ ...l, bcId: l.id === "c" ? null : "bc1", validatedItemId: l.id === "c" ? "p1" : l.validatedItemId }));
    const d = decisionBcDuDevis(apresCoche, "p1", bc());
    expect(d).toMatchObject({ etat: "A_REGENERER", ajoutees: ["c"], retirees: [] });
    const apresDecoche = base.map((l) => ({ ...l, bcId: l.validatedItemId ? "bc1" : null })).map((l) => (l.id === "b" ? { ...l, validatedItemId: null } : l));
    expect(decisionBcDuDevis(apresDecoche, "p1", bc())).toMatchObject({ etat: "A_REGENERER", ajoutees: [], retirees: ["b"] });
  });
  it("FIGE quand il faudrait régénérer et que le BC est SIGNÉ ou FACTURÉ — le refus nomme le geste qui reste", () => {
    const apresCoche = base.map((l) => ({ ...l, bcId: l.validatedItemId ? "bc1" : null })).map((l) => (l.id === "c" ? { ...l, validatedItemId: "p1" } : l));
    const signe = decisionBcDuDevis(apresCoche, "p1", bc({ signe: true, etape: "SIGNE" }));
    expect(signe.etat).toBe("FIGE");
    expect(signe.refus).toMatch(/signé par les Finances/);
    expect(signe.refus).toMatch(/joignez un bon de commande existant/);
    const facture = decisionBcDuDevis(apresCoche, "p1", bc({ facture: "FA-12" }));
    expect(facture.etat).toBe("FIGE");
    expect(facture.refus).toMatch(/facture \(FA-12\)/);
    expect(facture.refus).toMatch(/Annulez d'abord la facture/);
  });
  it("A_ANNULER quand plus aucune ligne n'est validée alors qu'un BC existe : on l'annule, on ne le vide pas", () => {
    const lignes = base.map((l) => ({ ...l, validatedItemId: null, bcId: l.id === "c" ? null : "bc1" }));
    const d = decisionBcDuDevis(lignes, "p1", bc());
    expect(d.etat).toBe("A_ANNULER");
    expect(d.refus).toMatch(/annulez-le/);
  });
  it("un BC signé gèle la validation des lignes (une ligne ajoutée resterait validée sans qu'aucun BC la commande)", () => {
    expect(refusChangementDeValidation(null)).toBeNull();
    expect(refusChangementDeValidation(bc())).toBeNull();
    expect(refusChangementDeValidation(bc({ signe: true }))).toMatch(/ne changent plus/);
    expect(refusChangementDeValidation(bc({ facture: "FA-1" }))).toMatch(/ne changent plus/);
    expect(refusBcFige(bc({ reference: null, signe: true }))).toMatch(/du devis est signé/);
  });
  it("les lignes d'un devis ne se corrigent plus tant qu'un BC actif en porte une", () => {
    const lignes = [ligne("a", { bcId: "bc1" }), ligne("b")];
    expect(refusEditionDesLignes(lignes, [{ id: "bc1", reference: "BC-0001" }])).toMatch(/BC-0001/);
    expect(refusEditionDesLignes(lignes, [])).toBeNull();
    expect(refusEditionDesLignes([ligne("b")], [{ id: "bc1", reference: "BC-0001" }])).toBeNull();
  });
});

describe("plusieurs BC pour un poste : le poste n'est « signé » que quand les DEUX le sont", () => {
  it("l'étape d'ensemble est la moins avancée, et un BC d'avant le circuit est le moins avancé de tous", () => {
    expect(etapeDEnsemble([])).toBeNull();
    expect(etapeDEnsemble(["SIGNE", "A_SIGNER"])).toBe("A_SIGNER");
    expect(etapeDEnsemble(["SIGNE", "SIGNE"])).toBe("SIGNE");
    expect(etapeDEnsemble(["SIGNE", "A_VALIDER", "A_SIGNER"])).toBe("A_VALIDER");
    expect(etapeDEnsemble(["SIGNE", null])).toBe("HORS_CIRCUIT");
    expect(etapeDEnsemble(["REFUSE", "SIGNE"])).toBe("REFUSE");
  });
});

describe("le montant : les BC ne dépassent jamais ce que la Direction a accordé", () => {
  it("accepte à l'accordé près (au centime), refuse au-delà en disant les DEUX montants et le geste", () => {
    expect(refusDepassement(100_000, 100_000)).toBeNull();
    expect(refusDepassement(100_000.004, 100_000)).toBeNull();
    expect(refusDepassement(100_000.01, 100_000)).toMatch(/au-delà des/);
    const r = refusDepassement(150_000, 100_000)!;
    expect(r).toMatch(/150\s000,00 DZD TTC/);
    expect(r).toMatch(/100\s000,00 DZD accordés/);
    expect(r).toMatch(/demandez une révision du poste pour le relever \(ou décochez une ligne\)/);
    // Le cas de la Direction (06/10) : 400 000 HT au devis, 476 000 TTC — la phrase dit d'où vient l'écart.
    const tva = refusDepassement(476_000, 400_000, 400_000)!;
    expect(tva).toMatch(/400\s000,00 DZD HT, soit 476\s000,00 DZD TTC avec 76\s000,00 DZD de taxes/);
    expect(tva).toMatch(/s'entend TTC/);
    // Sans montant accordé, il n'y a rien à comparer : on ne refuse pas sur un trou.
    expect(refusDepassement(150_000, null)).toBeNull();
  });
});

describe("la génération est-elle ouverte ? — la MÊME règle pour la carte et l'action", () => {
  const ok = { status: "APPROVED", amountGranted: 100_000, budgetCategoryId: "cat", orderStage: "NONE", expenseOrderId: null, demandeChez: null, demandeOuverte: false };
  it("s'ouvre pour un poste accordé, chiffré et budgété, sans paiement ni demande de BC ouverte", () => {
    expect(refusGenerationBC(ok)).toBeNull();
    expect(refusGenerationBC({ ...ok, orderStage: "REQUESTED" })).toBeNull();
  });
  it("refuse, en nommant le remède, chaque cas qui l'interdit", () => {
    expect(refusGenerationBC({ ...ok, status: "PENDING" })).toMatch(/accordé par la Direction/);
    expect(refusGenerationBC({ ...ok, amountGranted: null })).toMatch(/Affectez d'abord un montant/);
    expect(refusGenerationBC({ ...ok, budgetCategoryId: null })).toMatch(/Choisissez d'abord le budget/);
    expect(refusGenerationBC({ ...ok, expenseOrderId: "o1" })).toMatch(/paiement de ce poste est déjà demandé/);
    expect(refusGenerationBC({ ...ok, orderStage: "ISSUED" })).toMatch(/paiement de ce poste est déjà demandé/);
    expect(refusGenerationBC({ ...ok, demandeOuverte: true, demandeChez: "Amel" })).toMatch(/déjà chez Amel.*Annuler la demande de BC/);
    expect(refusGenerationBC({ ...ok, demandeOuverte: true })).toMatch(/déjà chez l'assistante de direction/);
  });
  it("le montant et le budget ne sont exigés qu'à la PRISE de la marche : un poste dont le BC est déjà demandé ne les redemande pas", () => {
    expect(refusGenerationBC({ ...ok, orderStage: "DIRECTION_OK", amountGranted: null, budgetCategoryId: null })).toBeNull();
  });
});

describe("ce que le BC peut porter : les taux de TVA de l'Algérie, les mêmes que la fabrique", () => {
  it("les taux admis sont EXACTEMENT ceux de la fabrique (en pour cent), et tout autre est refusé avant la marche", () => {
    expect([...TAUX_TVA_PCT_ADMIS].sort((a, b) => a - b)).toEqual([...TAUX_TVA_ADMIS].map((t) => Math.round(t * 100)).sort((a, b) => a - b));
    for (const t of [0, 9, 19]) expect(refusTauxDuDevis(t)).toBeNull();
    expect(refusTauxDuDevis(13)).toMatch(/13 %.*n'existe pas en Algérie.*0, 9 ou 19 %/);
    expect(refusTauxDuDevis(19.5)).not.toBeNull();
  });
});

describe("la lecture, traduite en lignes : un chiffre illisible n'est JAMAIS deviné", () => {
  it("garde une quantité ou un prix illisibles à null, sans les inventer, et dit ce qu'il faut vérifier", () => {
    const l = lignesDepuisLaLecture([
      { rang: 0, reference: " Fiche ", unit: "u", quantity: 10, unitPrice: 5, notes: [] },
      { rang: 1, reference: "Brochure", unit: null, quantity: null, unitPrice: 20, notes: ["quantité illisible", "à vérifier"] },
      { rang: 2, reference: "   ", unit: null, quantity: 1, unitPrice: 1, notes: [] },
      { rang: 3, reference: "Offerte", unit: null, quantity: 0, unitPrice: -3, notes: [] },
    ]);
    expect(l).toHaveLength(3);
    expect(l[0]).toMatchObject({ position: 0, reference: "Fiche", quantity: 10, unitPrice: 5, lue: 0, aVerifier: null });
    expect(l[1]).toMatchObject({ quantity: null, unitPrice: 20, aVerifier: "quantité illisible ; à vérifier" });
    expect(l[2]).toMatchObject({ quantity: null, unitPrice: null });
  });
  it("le total imprimé ne se compare qu'à des lignes toutes lisibles (sans total ou avec un trou : aucun écart déclaré)", () => {
    const lignes = [ligne("a", { quantity: 2, unitPrice: 500 }), ligne("b", { quantity: 1, unitPrice: 1000 })];
    expect(ecartAvecLeTotalImprime({ ...ENTETE, announcedTotal: 2000 }, lignes)).toBeNull();
    expect(ecartAvecLeTotalImprime({ ...ENTETE, announcedTotal: 2500 }, lignes)).toMatchObject({ annonce: 2500 });
    expect(ecartAvecLeTotalImprime({ ...ENTETE, announcedTotal: 9999 }, [...lignes, ligne("c", { unitPrice: null })])).toBeNull();
    expect(ecartAvecLeTotalImprime(ENTETE, lignes)).toBeNull();
  });
});
