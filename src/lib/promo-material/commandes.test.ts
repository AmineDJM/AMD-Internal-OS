import { describe, expect, it } from "vitest";
import {
  commandesSoldees, formaliteDuDossier, gesteDeLaCommande, jourMois, pastillesDeLaCommande, totalDesCommandes,
  type CommandeFaits, type FactureDeCommande, type RegardCommande,
} from "./fiche";

/**
 * LE TABLEAU « COMMANDES » (maquette validée, étape 4 « Commande, livraison, paiement ») — une ligne par BC, une pastille
 * par colonne, UN bouton (le prochain geste de la personne qui regarde), le total, et la condition de la clôture
 * automatique.
 */

const facture = (p: Partial<FactureDeCommande> = {}): FactureDeCommande => ({
  lignes: 2, enAttente: 2, recues: 0, renoncees: 0, derniereReception: null,
  paiementDemande: false, reglee: false, etatReglement: "NON_ENVOYE", demandeIM: false, ...p,
});

const commande = (p: Partial<CommandeFaits> = {}): CommandeFaits => ({
  etape: "SIGNE", brouillon: false, envoyeLe: "2026-10-12T10:00:00.000Z", resteAFacturer: true, factures: [], ...p,
});

const DEMANDEUR: RegardCommande = { ouvert: true, pilote: true, peutReceptionner: true };
const ASSISTANTE: RegardCommande = { ouvert: true, pilote: true, peutReceptionner: false };

describe("les pastilles d'une ligne — « état — chez qui »", () => {
  it("le BC dit où il est tant qu'il n'est pas parti, puis se tait", () => {
    expect(pastillesDeLaCommande(commande({ etape: null, brouillon: true, envoyeLe: null })).bc).toEqual({ texte: "aperçu à vérifier", ton: "warning" });
    expect(pastillesDeLaCommande(commande({ etape: "A_SIGNER", envoyeLe: null })).bc?.texte).toBe("chez les Finances");
    expect(pastillesDeLaCommande(commande({ etape: "A_VALIDER", envoyeLe: null })).bc?.texte).toBe("au centre Ad & Pro");
    expect(pastillesDeLaCommande(commande({ envoyeLe: null })).bc?.texte).toBe("signé — à envoyer");
    expect(pastillesDeLaCommande(commande()).bc).toBeNull();
  });

  it("la livraison : attendue, en partie, reçue le jj/mm — lue sur les lignes de la facture", () => {
    expect(pastillesDeLaCommande(commande({ envoyeLe: null, etape: "A_SIGNER" })).livraison).toBeNull();
    expect(pastillesDeLaCommande(commande()).livraison).toEqual({ texte: "attendue", ton: "warning" });
    expect(pastillesDeLaCommande(commande({ factures: [facture({ enAttente: 1, recues: 1 })] })).livraison?.texte).toBe("en partie — 1/2");
    const recue = commande({ factures: [facture({ enAttente: 0, recues: 2, derniereReception: "2026-10-20T12:00:00.000Z" })] });
    expect(pastillesDeLaCommande(recue).livraison).toEqual({ texte: `reçue le ${jourMois("2026-10-20T12:00:00.000Z")}`, ton: "success" });
    expect(jourMois("2026-10-20T12:00:00.000Z")).toBe("20/10");
    expect(pastillesDeLaCommande(commande({ factures: [facture({ enAttente: 0, recues: 1, renoncees: 1 })] })).livraison?.texte).toBe("reçue en partie");
    // Une facture d'avant le détail ligne à ligne : pas de réception à suivre.
    expect(pastillesDeLaCommande(commande({ factures: [facture({ lignes: 0, enAttente: 0 })] })).livraison).toBeNull();
  });

  it("la facture, le paiement, le visa", () => {
    expect(pastillesDeLaCommande(commande()).facture).toEqual({ texte: "attendue", ton: "neutral" });
    expect(pastillesDeLaCommande(commande({ resteAFacturer: false, factures: [facture()] })).facture?.texte).toBe("jointe");
    expect(pastillesDeLaCommande(commande({ factures: [facture()] })).facture?.texte).toBe("en partie");

    const p = (f: Partial<FactureDeCommande>) => pastillesDeLaCommande(commande({ resteAFacturer: false, factures: [facture({ enAttente: 0, ...f })] }));
    expect(p({}).paiement).toEqual({ texte: "à demander", ton: "warning" });
    expect(p({ paiementDemande: true, etatReglement: "AUX_FINANCES", demandeIM: true }).paiement?.texte).toBe("chez les Finances");
    expect(p({ paiementDemande: true, etatReglement: "AU_CENTRE", demandeIM: true }).paiement?.texte).toBe("au centre de paiement");
    expect(p({ paiementDemande: true, reglee: true, etatReglement: "REGLE", demandeIM: true }).paiement).toEqual({ texte: "payé", ton: "success" });

    expect(p({}).visa).toBeNull();
    expect(p({ paiementDemande: true, demandeIM: true }).visa?.texte).toBe("demandée avec le paiement");
    expect(p({ paiementDemande: true, demandeIM: false }).visa).toEqual({ texte: "à adresser", ton: "warning" });
  });
});

describe("le seul bouton de la ligne — le prochain geste de celui qui regarde", () => {
  it("rien tant que le BC n'est pas signé, ni sur un dossier clos", () => {
    expect(gesteDeLaCommande(commande({ etape: "A_SIGNER" }), DEMANDEUR)).toBeNull();
    expect(gesteDeLaCommande(commande(), { ...DEMANDEUR, ouvert: false })).toBeNull();
  });

  it("« Joindre la facture » → « J'ai reçu » → « Demander le paiement » → plus rien", () => {
    expect(gesteDeLaCommande(commande(), DEMANDEUR)).toEqual({ cle: "DEPOSER_FACTURE", libelle: "Joindre la facture" });
    // Signé mais pas envoyé : l'envoi vit dans « ⋯ » (et dans « Ce qu'il reste à faire »), pas de facture à joindre encore.
    expect(gesteDeLaCommande(commande({ envoyeLe: null }), DEMANDEUR)).toBeNull();
    const facturee = commande({ resteAFacturer: false, factures: [facture()] });
    expect(gesteDeLaCommande(facturee, DEMANDEUR)).toEqual({ cle: "RECEPTIONNER", libelle: "J'ai reçu" });
    const recue = commande({ resteAFacturer: false, factures: [facture({ enAttente: 0, recues: 2 })] });
    expect(gesteDeLaCommande(recue, DEMANDEUR)).toEqual({ cle: "DEMANDER_PAIEMENT", libelle: "Demander le paiement" });
    const payee = commande({ resteAFacturer: false, factures: [facture({ enAttente: 0, recues: 2, paiementDemande: true, demandeIM: true })] });
    expect(gesteDeLaCommande(payee, DEMANDEUR)).toBeNull();
  });

  it("la réception est au demandeur : l'assistante ne voit pas « J'ai reçu », mais garde ses propres gestes", () => {
    const facturee = commande({ factures: [facture()] });
    expect(gesteDeLaCommande(facturee, ASSISTANTE)).toEqual({ cle: "DEPOSER_FACTURE", libelle: "Joindre la facture" });
    expect(gesteDeLaCommande(facturee, { ouvert: true, pilote: false, peutReceptionner: true })?.cle).toBe("RECEPTIONNER");
    expect(gesteDeLaCommande(commande(), { ouvert: true, pilote: false, peutReceptionner: false })).toBeNull();
  });

  it("une facture reçue se paie avant de joindre la suivante", () => {
    const c = commande({ factures: [facture({ enAttente: 0, recues: 2 })] });
    expect(gesteDeLaCommande(c, DEMANDEUR)?.cle).toBe("DEMANDER_PAIEMENT");
  });
});

describe("le total, la formalité proposée, la clôture automatique", () => {
  it("le total des TTC, au centime", () => {
    expect(totalDesCommandes([{ ttc: 84700 }, { ttc: 474925 }])).toBe(559625);
    expect(totalDesCommandes([{ ttc: 0.1 }, { ttc: 0.2 }])).toBe(0.3);
    expect(totalDesCommandes([])).toBe(0);
  });

  it("la formalité du paiement suivant : celle de la dernière demande adressée", () => {
    expect(formaliteDuDossier([])).toBeNull();
    expect(formaliteDuDossier([null, { formalite: "MIP" }, null])).toBe("MIP");
    expect(formaliteDuDossier([{ formalite: "MIP" }, { formalite: "AD_VISA" }])).toBe("AD_VISA");
    expect(formaliteDuDossier([{ formalite: "AUTRE" }])).toBeNull();
  });

  it("soldé : chaque BC signé, entièrement facturé, reçu, payé et visé — sinon rien ne se clôt", () => {
    const fa = { enAttente: 0, paiementDemande: true, reglee: true, demandeIM: true };
    const bc = { etape: "SIGNE", resteAFacturer: false, factures: [fa] };
    expect(commandesSoldees([bc, { ...bc }])).toBe(true);
    expect(commandesSoldees([])).toBe(false);
    expect(commandesSoldees([bc, { ...bc, factures: [] }])).toBe(false);
    expect(commandesSoldees([{ ...bc, resteAFacturer: true }])).toBe(false);
    expect(commandesSoldees([{ ...bc, etape: "A_SIGNER" }])).toBe(false);
    expect(commandesSoldees([{ ...bc, factures: [{ ...fa, enAttente: 1 }] }])).toBe(false);
    expect(commandesSoldees([{ ...bc, factures: [{ ...fa, reglee: false }] }])).toBe(false);
    // Le visa part avec le paiement : un paiement sans sa demande à l'information médicale ne solde rien.
    expect(commandesSoldees([{ ...bc, factures: [{ ...fa, demandeIM: false }] }])).toBe(false);
  });
});
