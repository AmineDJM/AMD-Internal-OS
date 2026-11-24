import { describe, expect, it } from "vitest";
import {
  achatsApresCorrection, etapeDuCircuitBc, etatDuPoste, etatDuProfessionnel, jugerNouveauPrix, montantEngage, phraseCircuitBc,
  prixAValider, refusAchatDeLaLigne, refusAchatHorsBc, refusPaiementDuBc, resteAMettreEnBc, totalAPayer, type LigneAchat,
} from "./achats";

const ligne = (p: Partial<LigneAchat> = {}): LigneAchat => ({
  bcNumero: 1, statut: "ACTIVE", montantDzd: 100_000, montantAchatDzd: null, rembourse: null, rembourseDzd: null, bcSigneFinances: true, ...p,
});

describe("circuit d'achat — la marge de prix de l'assistante (10 %)", () => {
  it("sans BC, le prix change librement", () => {
    expect(jugerNouveauPrix(150_000, []).voie).toBe("LIBRE");
    expect(jugerNouveauPrix(150_000, [ligne({ statut: "RETIREE_AVANT_ACHAT" })]).voie).toBe("LIBRE");
  });
  it("+8 % : dans la marge, sans nouveau BC", () => {
    const j = jugerNouveauPrix(108_000, [ligne()]);
    expect(j).toMatchObject({ voie: "DANS_LA_MARGE", base: 100_000, plafond: 110_000 });
  });
  it("+10 % pile : encore dans la marge ; une baisse l'est toujours", () => {
    expect(jugerNouveauPrix(110_000, [ligne()]).voie).toBe("DANS_LA_MARGE");
    expect(jugerNouveauPrix(40_000, [ligne()]).voie).toBe("DANS_LA_MARGE");
  });
  it("+15 % : hors marge, le complément part dans un BC complémentaire", () => {
    expect(jugerNouveauPrix(115_000, [ligne()])).toMatchObject({ voie: "HORS_MARGE", complement: 15_000, plafond: 110_000 });
  });
  it("le paiement du BC demandé fige le montant", () => {
    expect(jugerNouveauPrix(101_000, [ligne({ bcPaiementDemande: true, bcNumero: 2 })])).toEqual({ voie: "PAIEMENT_DEMANDE", bcNumero: 2 });
  });
  it("le prix d'achat se reporte sur la dernière ligne vivante, jamais sous zéro", () => {
    const ls = [ligne({ montantDzd: 100_000 }), ligne({ bcNumero: 2, montantDzd: 15_000 })];
    expect(achatsApresCorrection(120_000, ls)).toEqual([null, 20_000]);
    expect(achatsApresCorrection(50_000, ls)).toEqual([null, 0]);
    expect(achatsApresCorrection(1, [ligne({ statut: "RETIREE_AVANT_ACHAT" })])).toEqual([null]);
  });
  it("ce qui reste à mettre en BC : le validé moins les lignes vivantes (achat réel)", () => {
    expect(resteAMettreEnBc(115_000, [ligne()])).toBe(15_000);
    expect(resteAMettreEnBc(108_000, [ligne({ montantAchatDzd: 108_000 })])).toBe(0);
    expect(resteAMettreEnBc(100_000, [ligne({ statut: "RETIREE_AVANT_ACHAT" })])).toBe(100_000);
    expect(resteAMettreEnBc(null, [])).toBe(0);
  });
});

describe("circuit d'achat — où en est un poste, un professionnel", () => {
  const faits = (p: Partial<Parameters<typeof etatDuPoste>[0]> = {}) => ({ chiffre: false, prixDzd: null, valideDzd: null, enChiffrage: false, lignes: [], ...p });
  it("proposé → chiffrage demandé → chiffré à valider → validé → dans le BC → acheté", () => {
    expect(etatDuPoste(faits()).code).toBe("PROPOSE");
    expect(etatDuPoste(faits({ enChiffrage: true })).code).toBe("CHIFFRAGE_DEMANDE");
    expect(etatDuPoste(faits({ chiffre: true, prixDzd: 46_000 })).libelle).toBe("Chiffré — à valider");
    expect(etatDuPoste(faits({ chiffre: true, prixDzd: 46_000, valideDzd: 46_000 })).libelle).toBe("Validé — pas encore dans un BC");
    const l = ligne({ montantDzd: 46_000, bcSigneFinances: false });
    expect(etatDuPoste(faits({ chiffre: true, prixDzd: 46_000, valideDzd: 46_000, lignes: [l] })).libelle).toBe("Dans le BC n°1 — en signature");
    expect(etatDuPoste(faits({ chiffre: true, prixDzd: 46_000, valideDzd: 46_000, lignes: [{ ...l, bcSigneFinances: true }] })).code).toBe("DANS_BC_A_ACHETER");
    expect(etatDuPoste(faits({ chiffre: true, prixDzd: 46_000, valideDzd: 46_000, lignes: [{ ...l, statut: "ACHETEE" }] })).libelle).toBe("Acheté · BC n°1");
  });
  it("un prix relevé au-delà de la marge redevient à valider (complément)", () => {
    const e = etatDuPoste(faits({ chiffre: true, prixDzd: 115_000, valideDzd: 100_000, lignes: [ligne({ statut: "ACHETEE" })] }));
    expect(e).toEqual({ code: "A_VALIDER", libelle: "Complément chiffré — à valider" });
    expect(prixAValider({ chiffre: true, prixDzd: 100_000, valideDzd: 100_000 })).toBe(false);
  });
  it("retiré : barré avant achat, « remboursé ? » après, remboursé", () => {
    expect(etatDuPoste(faits({ lignes: [ligne({ statut: "RETIREE_AVANT_ACHAT" })] })).libelle).toBe("Retiré du BC n°1 avant achat");
    expect(etatDuPoste(faits({ lignes: [ligne({ statut: "RETIREE_APRES_ACHAT" })] })).code).toBe("RETIRE_APRES_ACHAT");
    expect(etatDuPoste(faits({ lignes: [ligne({ statut: "RETIREE_APRES_ACHAT", rembourse: true })] })).code).toBe("REMBOURSE");
  });
  it("le professionnel se lit par ce qui attend un geste d'abord ; retiré, il se lit barré", () => {
    const postes = [faits({ chiffre: true, prixDzd: 1, valideDzd: 1, lignes: [ligne({ statut: "ACHETEE" })] }), faits({ chiffre: true, prixDzd: 5 })];
    expect(etatDuProfessionnel({ retire: false, enChiffrage: false, postes }).code).toBe("A_VALIDER");
    expect(etatDuProfessionnel({ retire: false, enChiffrage: true, postes: [] }).code).toBe("CHIFFRAGE_DEMANDE");
    expect(etatDuProfessionnel({ retire: true, enChiffrage: false, postes: [faits({ lignes: [ligne({ statut: "RETIREE_AVANT_ACHAT" })] })] }).code).toBe("RETIRE");
    expect(etatDuProfessionnel({ retire: true, enChiffrage: false, postes: [] })).toEqual({ code: "RETIRE", libelle: "Retiré" });
  });
});

describe("circuit d'achat — l'argent", () => {
  it("l'engagement : barré libéré, retiré après achat moins le remboursement, prix chiffré tant que la personne est prise en charge", () => {
    expect(montantEngage({ actif: true, chiffre: true, prixDzd: 46_000, lignes: [] })).toBe(46_000);
    expect(montantEngage({ actif: false, chiffre: true, prixDzd: 46_000, lignes: [ligne({ statut: "RETIREE_AVANT_ACHAT" })] })).toBe(0);
    expect(montantEngage({ actif: false, chiffre: true, prixDzd: 100_000, lignes: [ligne({ statut: "RETIREE_APRES_ACHAT", rembourse: true, rembourseDzd: 60_000 })] })).toBe(40_000);
    expect(montantEngage({ actif: false, chiffre: true, prixDzd: 100_000, lignes: [ligne({ statut: "RETIREE_APRES_ACHAT", rembourse: false })] })).toBe(100_000);
    expect(montantEngage({ actif: true, chiffre: true, prixDzd: 108_000, lignes: [ligne({ statut: "ACHETEE", montantAchatDzd: 108_000 })] })).toBe(108_000);
  });
  it("le total à payer d'un BC : les achats réels, remboursements déduits ; les lignes barrées ne comptent pas", () => {
    expect(totalAPayer([
      ligne({ statut: "ACHETEE", montantAchatDzd: 108_000 }), ligne({ statut: "RETIREE_AVANT_ACHAT", montantDzd: 50_000 }),
      ligne({ statut: "RETIREE_APRES_ACHAT", montantDzd: 30_000, rembourse: true, rembourseDzd: 30_000 }),
    ])).toBe(108_000);
  });
  it("le paiement : signé par les Finances, tout acheté, « remboursé ? » répondu, facture OBLIGATOIRE, une seule fois", () => {
    const base = { signeFinances: true, paiementDemande: false, facture: true, lignes: [ligne({ statut: "ACHETEE" })] };
    expect(refusPaiementDuBc(base)).toBeNull();
    expect(refusPaiementDuBc({ ...base, facture: false })).toMatch(/facture/);
    expect(refusPaiementDuBc({ ...base, signeFinances: false })).toMatch(/Finances/);
    expect(refusPaiementDuBc({ ...base, paiementDemande: true })).toMatch(/un seul ordre/);
    expect(refusPaiementDuBc({ ...base, lignes: [ligne()] })).toMatch(/pas encore achetée/);
    expect(refusPaiementDuBc({ ...base, lignes: [ligne({ statut: "RETIREE_APRES_ACHAT" })] })).toMatch(/Remboursé/);
    expect(refusPaiementDuBc({ ...base, lignes: [ligne({ statut: "RETIREE_AVANT_ACHAT" })] })).toMatch(/Rien/);
  });
  it("l'achat : seulement une ligne d'un BC signé par les Finances", () => {
    expect(refusAchatDeLaLigne(ligne())).toBeNull();
    expect(refusAchatDeLaLigne(ligne({ bcSigneFinances: false }))).toMatch(/pas encore signé/);
    expect(refusAchatDeLaLigne(ligne({ statut: "ACHETEE" }))).toMatch(/déjà achetée/);
    expect(refusAchatDeLaLigne(ligne({ statut: "RETIREE_AVANT_ACHAT" }))).toMatch(/retiré/);
    expect(refusAchatHorsBc([])).toMatch(/aucun bon de commande signé/);
    expect(refusAchatHorsBc([ligne({ bcSigneFinances: false })])).toMatch(/pas encore signé/);
    expect(refusAchatHorsBc([ligne()])).toBeNull();
  });
});

describe("circuit d'achat — le circuit d'un BC se lit", () => {
  it("signature DM → centre → Finances → achat → paiement", () => {
    const f = { annule: false, signeDm: false, etapeBc: "HORS_CIRCUIT", lignesActives: 1, paiementDemande: false, paye: false };
    expect(etapeDuCircuitBc(f)).toBe("SIGNATURE_DM");
    expect(etapeDuCircuitBc({ ...f, signeDm: true, etapeBc: "A_VALIDER" })).toBe("CENTRE");
    expect(etapeDuCircuitBc({ ...f, signeDm: true, etapeBc: "A_SIGNER" })).toBe("SIGNATURE_FINANCES");
    expect(etapeDuCircuitBc({ ...f, signeDm: true, etapeBc: "SIGNE" })).toBe("ACHAT");
    expect(etapeDuCircuitBc({ ...f, signeDm: true, etapeBc: "SIGNE", lignesActives: 0 })).toBe("PAIEMENT");
    expect(phraseCircuitBc({ ...f, signeDm: true, etapeBc: "SIGNE", lignesActives: 0, paiementDemande: true })).toMatch(/paiement demandé/);
    expect(etapeDuCircuitBc({ ...f, signeDm: true, etapeBc: "SIGNE", lignesActives: 0, paiementDemande: true, paye: true })).toBe("PAYE");
    expect(etapeDuCircuitBc({ ...f, annule: true })).toBe("ANNULE");
  });
});
