import { describe, expect, it } from "vitest";
import { payeeDuPoste, type SourcesPayee } from "./payee-poste";

const vide: SourcesPayee = { agenceRetenue: null, bcs: [], fournisseur: null, devis: [] };

describe("payeeDuPoste — « Agence / bénéficiaire » d'un poste déclaré (recette sponsoring, 23/11/2026)", () => {
  it("le poste billetterie : sans agence retenue, le tiers de son BC signé — plus « — »", () => {
    expect(payeeDuPoste({ ...vide, bcs: [{ tiers: "Tassili Voyages & Billetterie", etape: "SIGNE" }] })).toBe("Tassili Voyages & Billetterie");
  });

  it("l'agence retenue passe avant tout le reste", () => {
    expect(payeeDuPoste({
      agenceRetenue: "Agence Horizon", bcs: [{ tiers: "Autre", etape: "SIGNE" }], fournisseur: "Fournisseur", devis: [{ tiers: "Devis" }],
    })).toBe("Agence Horizon");
  });

  it("les BC signés d'abord ; à défaut, ceux en circuit ; jamais un BC refusé", () => {
    expect(payeeDuPoste({ ...vide, bcs: [{ tiers: "En circuit", etape: "A_SIGNER" }, { tiers: "Signé", etape: "SIGNE" }] })).toBe("Signé");
    expect(payeeDuPoste({ ...vide, bcs: [{ tiers: "En circuit", etape: "A_VALIDER" }] })).toBe("En circuit");
    expect(payeeDuPoste({ ...vide, bcs: [{ tiers: "Refusé", etape: "REFUSE" }], fournisseur: "Fournisseur du poste" })).toBe("Fournisseur du poste");
  });

  it("un BC par devis : les tiers distincts se lisent tous, sans doublon", () => {
    expect(payeeDuPoste({
      ...vide,
      bcs: [{ tiers: "Air Algérie", etape: "SIGNE" }, { tiers: "Tassili Airlines", etape: "SIGNE" }, { tiers: " air algérie ", etape: "SIGNE" }],
    })).toBe("Air Algérie, Tassili Airlines");
  });

  it("un BC sans tiers ne masque pas le fournisseur, puis le devis accepté", () => {
    expect(payeeDuPoste({ ...vide, bcs: [{ tiers: "  ", etape: "SIGNE" }], fournisseur: "Imprimerie du Centre" })).toBe("Imprimerie du Centre");
    expect(payeeDuPoste({ ...vide, devis: [{ tiers: null }, { tiers: "Hôtel El Djazair" }] })).toBe("Hôtel El Djazair");
  });

  it("rien de connu : rien (l'écran écrit « — »)", () => {
    expect(payeeDuPoste(vide)).toBeNull();
  });
});
