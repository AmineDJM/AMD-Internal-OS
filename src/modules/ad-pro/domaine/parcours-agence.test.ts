import { describe, it, expect } from "vitest";
import { etapeAgence, friseAgence, pasAgence, conformiteParDefaut, voieParDefaut, voieAgencePossible, lireStatutConformite, type FaitsPosteAgence, type FaitsAgence, type RegardAgence } from "./parcours-agence";

const agence = (a: Partial<FaitsAgence> = {}): FaitsAgence => ({
  prospectionDemandee: false, devisTransmis: false, agenceRetenue: false, brouillonBc: false, bcSoumis: false,
  signatureMarketing: false, bcEnvoye: false, conformiteRequise: false, conformite: null, receptionFaite: false, assistante: "Radia", ...a,
});
const poste = (p: Partial<FaitsPosteAgence> = {}, a: Partial<FaitsAgence> = {}): FaitsPosteAgence => ({
  status: "DRAFT", orderStage: "NONE", bc: null, factures: 0, expenseOrderId: null, expenseOrderStatus: null, agence: agence(a), ...p,
});
const personne = (r: Partial<RegardAgence> = {}): RegardAgence => ({ marketing: false, assistante: false, infoMed: false, centre: false, fige: false, ...r });
const signe = { status: "APPROVED" as const, bc: "SIGNE" as const, orderStage: "DIRECTION_OK" as const };
const choisi = { prospectionDemandee: true, devisTransmis: true, agenceRetenue: true, brouillonBc: true, bcSoumis: true, signatureMarketing: true };

describe("parcours agence — l'étape en cours, dans l'ordre du cycle", () => {
  it("de la prospection au choix", () => {
    expect(etapeAgence(poste())).toBe("PROSPECTION_A_DEMANDER");
    expect(etapeAgence(poste({ status: "PENDING" }, { prospectionDemandee: true }))).toBe("PROSPECTION");
    expect(etapeAgence(poste({ status: "PENDING" }, { prospectionDemandee: true, devisTransmis: true }))).toBe("CHOIX");
  });
  it("le BC : préparé, finalisé par l'assistante, validé et signé par la Direction Marketing", () => {
    const base = { prospectionDemandee: true, devisTransmis: true, agenceRetenue: true };
    expect(etapeAgence(poste({ status: "APPROVED" }, base))).toBe("BC_A_PREPARER");
    expect(etapeAgence(poste({ status: "APPROVED" }, { ...base, brouillonBc: true }))).toBe("BC_CHEZ_ASSISTANTE");
    expect(etapeAgence(poste({ status: "APPROVED" }, { ...base, brouillonBc: true, bcSoumis: true }))).toBe("BC_A_VALIDER");
    expect(etapeAgence(poste({ status: "APPROVED", bc: "A_SIGNER" }, { ...base, brouillonBc: true, bcSoumis: true }))).toBe("BC_A_SIGNER_MARKETING");
  });
  it("au-dessus du seuil le centre vise, puis les Finances signent ; un renvoi des Finances revient à l'assistante", () => {
    expect(etapeAgence(poste({ status: "APPROVED", bc: "A_VALIDER", orderStage: "REQUESTED" }, choisi))).toBe("BC_CHEZ_CENTRE");
    expect(etapeAgence(poste({ status: "APPROVED", bc: "A_SIGNER", orderStage: "DIRECTION_OK" }, choisi))).toBe("BC_A_SIGNER_FINANCES");
    expect(etapeAgence(poste({ status: "APPROVED", bc: "A_CORRIGER", orderStage: "DIRECTION_OK" }, choisi))).toBe("BC_A_CORRIGER");
  });
  it("après la signature : envoi, conformité si requise, réception, facture", () => {
    expect(etapeAgence(poste(signe, choisi))).toBe("BC_A_ENVOYER");
    expect(etapeAgence(poste(signe, { ...choisi, bcEnvoye: true }))).toBe("RECEPTION");
    expect(etapeAgence(poste(signe, { ...choisi, bcEnvoye: true, conformiteRequise: true }))).toBe("BAT_A_ENVOYER");
    expect(etapeAgence(poste(signe, { ...choisi, bcEnvoye: true, conformiteRequise: true, conformite: "EN_CONTROLE" }))).toBe("CONFORMITE");
    expect(etapeAgence(poste(signe, { ...choisi, bcEnvoye: true, conformiteRequise: true, conformite: "NON_CONFORME" }))).toBe("BAT_NON_CONFORME");
    expect(etapeAgence(poste(signe, { ...choisi, bcEnvoye: true, conformiteRequise: true, conformite: "CONFORME" }))).toBe("RECEPTION");
    expect(etapeAgence(poste(signe, { ...choisi, bcEnvoye: true, receptionFaite: true }))).toBe("FACTURE");
  });
  it("le paiement et les fins", () => {
    expect(etapeAgence(poste({ ...signe, expenseOrderId: "o1", expenseOrderStatus: "PENDING" }, choisi))).toBe("PAIEMENT");
    expect(etapeAgence(poste({ ...signe, expenseOrderId: "o1", expenseOrderStatus: "PAID" }, choisi))).toBe("PAYE");
    expect(etapeAgence(poste({ status: "REJECTED" }))).toBe("REFUSE");
    expect(etapeAgence(poste({ status: "APPROVED", bc: "REFUSE" }, choisi))).toBe("REFUSE");
  });
  it("recette du 23/11/2026 : un BC refusé par le DG n'est pas la fin du poste, un paiement refusé le dit", () => {
    expect(etapeAgence(poste({ ...signe, orderStage: "REFUSED", bc: "REFUSE" }, choisi))).toBe("BC_REFUSE_DG");
    const refuse = pasAgence(poste({ ...signe, orderStage: "REFUSED", bc: "REFUSE", orderDecisionNote: "Montant à revoir" }, choisi), personne({ marketing: true }));
    expect(refuse.attente).toContain("Montant à revoir");
    expect(refuse.attente).toContain("Annuler la demande de BC");
    const paiementRefuse = pasAgence(poste({ ...signe, expenseOrderId: "o1", expenseOrderStatus: "PENDING", expenseOrderCentral: "REFUSED" }, choisi), personne({ marketing: true }));
    expect(paiementRefuse.attente).toContain("refusé par le centre de paiement");
  });
});

describe("parcours agence — la frise", () => {
  it("une seule étape en cours, les précédentes faites", () => {
    const f = friseAgence(poste(signe, { ...choisi, bcEnvoye: true }));
    expect(f.map((e) => e.etat)).toEqual(["FAIT", "FAIT", "FAIT", "FAIT", "EN_COURS", "A_VENIR", "A_VENIR"]);
    expect(f.filter((e) => e.etat === "EN_COURS")).toHaveLength(1);
  });
  it("payé : tout est fait", () => {
    expect(friseAgence(poste({ ...signe, expenseOrderId: "o", expenseOrderStatus: "PAID" }, choisi)).every((e) => e.etat === "FAIT")).toBe(true);
  });
  it("refusé au choix : l'étape du choix est rouge", () => {
    expect(friseAgence(poste({ status: "REJECTED" }, { prospectionDemandee: true, devisTransmis: true }))[1].etat).toBe("REFUSE");
  });
});

describe("parcours agence — chaque personne voit SON geste, les autres savent chez qui", () => {
  it("la Direction Marketing demande la prospection ; l'assistante dépose les devis", () => {
    expect(pasAgence(poste(), personne({ marketing: true })).geste?.cle).toBe("DEMANDER_PROSPECTION");
    expect(pasAgence(poste(), personne()).attente).toMatch(/Direction Marketing/);
    const prosp = poste({ status: "PENDING" }, { prospectionDemandee: true });
    expect(pasAgence(prosp, personne({ assistante: true })).geste?.cle).toBe("DEPOSER_DEVIS");
    expect(pasAgence(prosp, personne({ marketing: true })).attente).toMatch(/chez Radia/);
  });
  it("le choix, le BC, sa validation signée", () => {
    expect(pasAgence(poste({ status: "PENDING" }, { prospectionDemandee: true, devisTransmis: true }), personne({ marketing: true })).geste?.cle).toBe("CHOISIR_AGENCE");
    const base = { prospectionDemandee: true, devisTransmis: true, agenceRetenue: true, brouillonBc: true };
    expect(pasAgence(poste({ status: "APPROVED" }, base), personne({ assistante: true })).geste?.cle).toBe("FINALISER_BC");
    expect(pasAgence(poste({ status: "APPROVED" }, base), personne({ marketing: true })).geste).toBeNull();
    expect(pasAgence(poste({ status: "APPROVED" }, { ...base, bcSoumis: true }), personne({ marketing: true })).geste?.cle).toBe("VALIDER_SIGNER_BC");
  });
  it("le centre vise ; les Finances signent depuis leur page (aucun geste sur la carte)", () => {
    expect(pasAgence(poste({ status: "APPROVED", bc: "A_VALIDER", orderStage: "REQUESTED" }, choisi), personne({ centre: true })).geste?.cle).toBe("VISER_BC");
    const fin = pasAgence(poste({ status: "APPROVED", bc: "A_SIGNER", orderStage: "DIRECTION_OK" }, choisi), personne({ marketing: true }));
    expect(fin.geste).toBeNull();
    expect(fin.attente).toMatch(/Finances/);
  });
  it("l'information médicale contrôle le BAT ; la Direction Marketing réceptionne puis dépose la facture", () => {
    const enControle = poste(signe, { ...choisi, bcEnvoye: true, conformiteRequise: true, conformite: "EN_CONTROLE" });
    expect(pasAgence(enControle, personne({ infoMed: true })).geste?.cle).toBe("CONTROLER_BAT");
    expect(pasAgence(enControle, personne({ marketing: true })).geste).toBeNull();
    expect(pasAgence(poste(signe, { ...choisi, bcEnvoye: true }), personne({ marketing: true })).geste?.cle).toBe("SIGNER_RECEPTION");
    expect(pasAgence(poste(signe, { ...choisi, bcEnvoye: true, receptionFaite: true }), personne({ marketing: true })).geste?.cle).toBe("DEPOSER_FACTURE");
  });
  it("la facture déposée : « Demander le paiement », plus « Déposer la facture » — la frise passe au paiement (recette du 23/11/2026)", () => {
    const recu = { ...choisi, bcEnvoye: true, receptionFaite: true };
    const facture = poste({ ...signe, factures: 1, toutFacture: true }, recu);
    expect(etapeAgence(facture)).toBe("PAIEMENT_A_DEMANDER");
    expect(pasAgence(facture, personne({ marketing: true })).geste).toEqual({ cle: "DEMANDER_PAIEMENT", libelle: "Demander le paiement" });
    expect(pasAgence(facture, personne({ assistante: true }))).toEqual({ geste: null, attente: "Facture déposée — la Direction Marketing demande le paiement." });
    const frise = friseAgence(facture);
    expect(frise.find((e) => e.cle === "FACTURE")?.etat).toBe("FAIT");
    expect(frise.find((e) => e.cle === "PAIEMENT")?.etat).toBe("EN_COURS");
    // Une facture qui ne couvre pas tout (deux BC, une facture) : on dépose encore.
    expect(etapeAgence(poste({ ...signe, factures: 1, toutFacture: false }, recu))).toBe("FACTURE");
    // Le paiement demandé : l'étape d'après, quoi que dise la couverture.
    expect(etapeAgence(poste({ ...signe, factures: 1, toutFacture: true, expenseOrderId: "o", expenseOrderStatus: "PENDING" }, recu))).toBe("PAIEMENT");
  });
  it("LE BUDGET EN PARALLÈLE (recette 24/11/2026) : le BC ne l'attend pas, le paiement si", () => {
    // Agence choisie, budget pas encore choisi : le BC suit son chemin (préparer, finaliser, valider et signer).
    expect(pasAgence(poste({ status: "APPROVED", budgetChoisi: false }, { prospectionDemandee: true, devisTransmis: true, agenceRetenue: true, assistante: "Radia" }), personne({ marketing: true })).geste?.cle).toBe("PREPARER_BC");
    expect(pasAgence(poste({ status: "APPROVED", budgetChoisi: false }, { ...choisi, bcSoumis: false }), personne({ assistante: true })).geste?.cle).toBe("FINALISER_BC");
    // Réceptionné ou facturé sans budget : le paiement attend la Direction Marketing.
    const recu = { ...choisi, bcEnvoye: true, receptionFaite: true };
    expect(pasAgence(poste({ ...signe, budgetChoisi: false }, recu), personne({ marketing: true })))
      .toEqual({ geste: null, attente: "Réceptionné — le paiement attend le budget : la Direction Marketing le choisit." });
    expect(pasAgence(poste({ ...signe, factures: 1, toutFacture: true, budgetChoisi: false }, recu), personne({ marketing: true })).geste).toBeNull();
    expect(pasAgence(poste({ ...signe, factures: 1, toutFacture: true, budgetChoisi: true }, recu), personne({ marketing: true })).geste?.cle).toBe("DEMANDER_PAIEMENT");
  });
  it("une demande close n'offre plus de décision à la Direction Marketing", () => {
    expect(pasAgence(poste(), personne({ marketing: true, fige: true })).geste).toBeNull();
  });
});

describe("parcours agence — défauts proposés", () => {
  it("conformité : l'imprimé et le stand oui, la salle et le traiteur non", () => {
    expect(conformiteParDefaut("PRINTING")).toBe(true);
    expect(conformiteParDefaut("STAND")).toBe(true);
    expect(conformiteParDefaut("VENUE")).toBe(false);
    expect(conformiteParDefaut("CATERING")).toBe(false);
  });
  it("voie : directe pour l'association, agence ailleurs, aucune pour les chemins à part", () => {
    expect(voieParDefaut("ASSOCIATION_SUPPORT")).toBe("DIRECT");
    expect(voieParDefaut("VENUE")).toBe("AGENCE");
    expect(voieParDefaut("TICKETING")).toBeNull();
    expect(voieAgencePossible("STOCK_MATERIAL")).toBe(false);
  });
  it("un statut de conformité inconnu se lit comme absent", () => {
    expect(lireStatutConformite("CONFORME")).toBe("CONFORME");
    expect(lireStatutConformite("bidon")).toBeNull();
    expect(lireStatutConformite(null)).toBeNull();
  });
});
