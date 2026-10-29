import { describe, it, expect } from "vitest";
import {
  canSubmitDossier, dossierHint, hasJustifyingPiece, isBonDeVersement, JUSTIFYING_KINDS,
  type DossierGate,
} from "./payment-dossier";

const gate = (o: Partial<DossierGate> = {}): DossierGate => ({
  entityType: null, pieces: [], paymentMethodStated: false, ...o,
});

describe("la pièce qui JUSTIFIE la dépense", () => {
  it("le bon de commande, la facture et le DEVIS", () => {
    expect([...JUSTIFYING_KINDS].sort()).toEqual(["INVOICE", "PURCHASE_ORDER", "QUOTE"]);
    expect(hasJustifyingPiece([{ kind: "INVOICE" }])).toBe(true);
    expect(hasJustifyingPiece([{ kind: "PURCHASE_ORDER" }])).toBe(true);
  });

  it("LE DEVIS JUSTIFIE — beaucoup de dépenses se règlent sur devis, la facture ne venant qu'après", () => {
    // L'exclure obligeait à inventer un bon de commande pour satisfaire l'écran : fabriquer une
    // pièce pour passer une règle est exactement ce qu'une règle doit empêcher.
    expect(hasJustifyingPiece([{ kind: "QUOTE" }])).toBe(true);
  });

  it("un bon de livraison ne justifie PAS — il dit ce qu'on a REÇU, pas ce qu'on doit", () => {
    expect(hasJustifyingPiece([{ kind: "DELIVERY_NOTE" }, { kind: "PROOF" }, { kind: "OTHER" }])).toBe(false);
    expect(hasJustifyingPiece([{ kind: "CONTRACT" }])).toBe(false);
  });

  it("n'importe laquelle des trois suffit — exiger bon ET facture bloquerait les paiements d'avance", () => {
    expect(hasJustifyingPiece([{ kind: "INVOICE" }, { kind: "OTHER" }])).toBe(true);
    expect(hasJustifyingPiece([{ kind: "QUOTE" }, { kind: "DELIVERY_NOTE" }])).toBe(true);
  });
});

describe("transmettre une demande de paiement ordinaire", () => {
  it("un dossier VIDE ne part pas", () => {
    const r = canSubmitDossier(gate());
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/bon de commande, une facture ou un devis/i);
  });

  it("des pièces qui n'engagent rien ne suffisent pas, et on DIT laquelle manque", () => {
    const r = canSubmitDossier(gate({ pieces: [{ kind: "DELIVERY_NOTE" }, { kind: "OTHER" }], paymentMethodStated: true }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/DEVIS/);
    expect(r.reason).toMatch(/bon de livraison/i);
  });

  it("un DEVIS seul, avec la case cochée, suffit à partir", () => {
    expect(canSubmitDossier(gate({ pieces: [{ kind: "QUOTE" }], paymentMethodStated: true })).ok).toBe(true);
  });

  it("la facture SANS la case du moyen de paiement ne part pas", () => {
    const r = canSubmitDossier(gate({ pieces: [{ kind: "INVOICE" }], paymentMethodStated: false }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/moyen de paiement/i);
  });

  it("bon de commande + case cochée : elle part", () => {
    expect(canSubmitDossier(gate({ pieces: [{ kind: "PURCHASE_ORDER" }], paymentMethodStated: true })).ok).toBe(true);
  });

  it("les AUTRES pièces restent facultatives — on n'exige jamais contrat ni justificatif", () => {
    const complet = gate({ pieces: [{ kind: "INVOICE" }, { kind: "QUOTE" }, { kind: "OTHER" }], paymentMethodStated: true });
    expect(canSubmitDossier(complet).ok).toBe(true);
    const minimal = gate({ pieces: [{ kind: "INVOICE" }], paymentMethodStated: true });
    expect(canSubmitDossier(minimal).ok).toBe(true);
  });

  it("un seul reproche à la fois — un formulaire n'est pas une liste de fautes", () => {
    const r = canSubmitDossier(gate({ pieces: [], paymentMethodStated: false }));
    expect(r.reason?.split("\n")).toHaveLength(1);
  });
});

describe("l'exception du BON DE VERSEMENT", () => {
  const bv = gate({ entityType: "MEDICAL_INFO_DECLARATION" });

  it("se reconnaît à son rattachement, jamais au titre", () => {
    expect(isBonDeVersement({ entityType: "MEDICAL_INFO_DECLARATION" })).toBe(true);
    expect(isBonDeVersement({ entityType: "SPONSORING" })).toBe(false);
    expect(isBonDeVersement({ entityType: null })).toBe(false);
    // Écrire « bon de versement » dans l'objet d'une demande fournisseur n'ouvre rien : sinon
    // l'exemption appartiendrait à qui connaît la formule.
    expect(isBonDeVersement({ entityType: undefined })).toBe(false);
  });

  it("part SANS pièce, sans justificatif et sans la case", () => {
    // Le BV n'a ni bon de commande ni facture, et ne peut pas en avoir : la quittance n'existe
    // qu'APRÈS le versement. L'exiger reviendrait à exiger la preuve d'un paiement pour
    // autoriser ce paiement.
    expect(canSubmitDossier(bv).ok).toBe(true);
  });

  it("un BV avec des pièces part aussi — l'exemption n'interdit rien", () => {
    expect(canSubmitDossier({ ...bv, pieces: [{ kind: "OTHER" }] }).ok).toBe(true);
  });
});

describe("ce que le formulaire annonce pendant qu'on le remplit", () => {
  it("dit ce qui manque, AVANT d'essayer d'envoyer", () => {
    expect(dossierHint(gate())).toMatch(/bon de commande, une facture ou un devis/i);
    expect(dossierHint(gate({ pieces: [{ kind: "INVOICE" }] }))).toMatch(/moyen de paiement/i);
  });

  it("se tait quand le dossier est complet, et sur un BV", () => {
    expect(dossierHint(gate({ pieces: [{ kind: "INVOICE" }], paymentMethodStated: true }))).toBeNull();
    expect(dossierHint(gate({ entityType: "MEDICAL_INFO_DECLARATION" }))).toBeNull();
  });
});
