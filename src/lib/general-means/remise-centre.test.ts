import { describe, expect, it } from "vitest";
import {
  ETAT_REMISE_LABEL,
  LIBELLE_A_CONFIRMER,
  PREFIXE_REFUS_REMISE,
  etatRemise,
  libelleRemise,
  motifDuRefus,
  refusConfirmationRemise,
  remiseEnAttente,
  statutPourLeFond,
  type EtatRemise,
} from "./remise-centre";

/**
 * LA REMISE DE CAISSE AU CENTRE DE PAIEMENT — les règles PURES (§118.176).
 *
 * Le banc de flux (`hr/centre-paie-caisse-flow.test.ts`) les exerce par les vraies actions ; celui-ci
 * les tient une par une. L'en-tête du module annonçait « testé » avant que ce fichier existe
 * (§118.116).
 */

const ordre = (status: string, centralStatus: string) => ({ status, centralStatus });
const TOUS: EtatRemise[] = ["EN_ATTENTE", "A_VERSER", "VERSEE", "REFUSEE", "ANNULEE"];

describe("etatRemise — le livre fait foi sur l'argent sorti", () => {
  it("une remise d'AVANT la règle n'a pas d'ordre : elle est versée, et se confirme comme avant", () => {
    expect(etatRemise({ aUnOrdre: false, ordre: null, transactionId: null })).toBe("VERSEE");
  });

  it("une écriture posée vaut versement, quoi que dise l'ordre", () => {
    expect(etatRemise({ aUnOrdre: true, ordre: ordre("PENDING", "AWAITING"), transactionId: "tx" })).toBe("VERSEE");
    expect(etatRemise({ aUnOrdre: true, ordre: null, transactionId: "tx" })).toBe("VERSEE");
  });

  it("un ordre disparu SANS écriture n'a rien versé", () => {
    expect(etatRemise({ aUnOrdre: true, ordre: null, transactionId: null })).toBe("ANNULEE");
  });

  it("un ordre réglé dont le crochet n'a pas encore posé l'écriture est versé — on ne relance pas les Finances", () => {
    expect(etatRemise({ aUnOrdre: true, ordre: ordre("PAID", "APPROVED"), transactionId: null })).toBe("VERSEE");
  });

  it("annulée, refusée, autorisée, historique, en attente", () => {
    const de = (status: string, centralStatus: string) => etatRemise({ aUnOrdre: true, ordre: ordre(status, centralStatus), transactionId: null });
    expect(de("CANCELLED", "APPROVED")).toBe("ANNULEE");
    expect(de("PENDING", "REFUSED")).toBe("REFUSEE");
    expect(de("PENDING", "APPROVED")).toBe("A_VERSER");
    expect(de("PENDING", "NOT_REQUIRED")).toBe("A_VERSER");
    expect(de("PENDING", "AWAITING")).toBe("EN_ATTENTE");
  });
});

describe("ce qui attend l'argent n'est ni dans le fond, ni à solder", () => {
  it("en attente et à verser attendent ; versée, refusée et annulée non", () => {
    expect(TOUS.filter(remiseEnAttente)).toEqual(["EN_ATTENTE", "A_VERSER"]);
  });

  it("chaque état a son libellé", () => {
    for (const e of TOUS) expect(ETAT_REMISE_LABEL[e].label.length).toBeGreaterThan(0);
  });
});

describe("refusConfirmationRemise — on ne confirme pas avoir reçu ce qui n'est pas parti (§118.15)", () => {
  it("versée : la détentrice confirme", () => {
    expect(refusConfirmationRemise("VERSEE")).toBeNull();
  });

  it("chaque refus nomme ce qu'on attend, et de qui", () => {
    expect(refusConfirmationRemise("EN_ATTENTE")).toMatch(/autorisation du centre de paiement/);
    expect(refusConfirmationRemise("A_VERSER")).toMatch(/les Finances doivent encore la payer/);
    expect(refusConfirmationRemise("REFUSEE")).toMatch(/refusé/);
    expect(refusConfirmationRemise("ANNULEE")).toMatch(/annulée/);
  });
});

describe("le circuit du 24/11/2026 — payée n'est pas reçue, et c'est le caissier qui fait compter la somme", () => {
  it("les libellés disent qui l'on attend : le centre, les Finances, le caissier — et « Refusé »", () => {
    expect(libelleRemise("EN_ATTENTE", "ALLOTTED").label).toBe("En attente du centre de paiement");
    expect(libelleRemise("A_VERSER", "ALLOTTED").label).toBe("Autorisée — à payer par les Finances");
    expect(libelleRemise("REFUSEE", "CLOSED")).toEqual({ label: "Refusé", tone: "danger" });
    expect(libelleRemise("VERSEE", "ALLOTTED")).toEqual({ label: LIBELLE_A_CONFIRMER, tone: "warning" });
    expect(LIBELLE_A_CONFIRMER).toBe("Versée — à confirmer par le caissier");
    expect(libelleRemise("VERSEE", "RECEIVED").tone).toBe("success");
    expect(libelleRemise("VERSEE", "CLOSED").label).toBe("Caisse soldée");
  });

  it("le fond : versée = son statut ; en attente jamais reçue = dehors ; confirmée puis « non payée » = à confirmer (sa somme sort, ses dépenses restent)", () => {
    expect(statutPourLeFond("VERSEE", "ALLOTTED", 0)).toBe("ALLOTTED");
    expect(statutPourLeFond("VERSEE", "RECEIVED", 0)).toBe("RECEIVED");
    expect(statutPourLeFond("EN_ATTENTE", "ALLOTTED", 0)).toBeNull();
    expect(statutPourLeFond("A_VERSER", "ALLOTTED", 0)).toBeNull();
    expect(statutPourLeFond("A_VERSER", "RECEIVED", 0)).toBe("ALLOTTED");
    expect(statutPourLeFond("A_VERSER", "RECEIVED", 2)).toBe("ALLOTTED");
    expect(statutPourLeFond("A_VERSER", "ALLOTTED", 1), "des dépenses imputées ne disparaissent pas du fond").toBe("ALLOTTED");
  });

  it("le motif du refus se relit dans la note, même derrière une précision de la remise", () => {
    expect(motifDuRefus(`${PREFIXE_REFUS_REMISE}Caisse suffisante`)).toBe("Caisse suffisante");
    expect(motifDuRefus(`Achats de rentrée — ${PREFIXE_REFUS_REMISE}Pas ce mois-ci`)).toBe("Pas ce mois-ci");
    expect(motifDuRefus("Achats de rentrée")).toBeNull();
    expect(motifDuRefus(null)).toBeNull();
  });
});
