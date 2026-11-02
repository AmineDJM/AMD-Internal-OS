import { describe, it, expect } from "vitest";
import {
  CENTRAL_AUTH_THRESHOLD_DZD, needsCentralAuthorization, initialCentralStatus, canDisburse,
  visibleToFinance, awaitsCentre, awaitsRequester, sitsOnPaymentCentre, applyDecision,
  canResubmit, applyResubmission, blockedReason, type CentralStatus,
  isHighValue, PAYMENT_CENTRE_REFUSAL, statutApresNouveauMontant, statutApresRevision, memeBeneficiaire,
} from "./authorization";

describe("LE GUICHET UNIQUE — plus rien ne contourne le centre", () => {
  it("un petit montant passe par le centre comme un gros — le seuil ne filtre plus", () => {
    // C'était le trou : sous 50 000 DZD, l'ordre filait aux Finances et le centre n'avait aucune
    // vue de ce que la société décaissait réellement.
    expect(needsCentralAuthorization({ amount: 3_000 })).toBe(true);
    expect(initialCentralStatus({ amount: 3_000 })).toBe("AWAITING");
    expect(initialCentralStatus({ amount: 49_999 })).toBe("AWAITING");
    expect(initialCentralStatus({ amount: 2_400_000 })).toBe("AWAITING");
  });

  it("AUCUN module n'est exempté — la petite caisse non plus", () => {
    expect(needsCentralAuthorization({ amount: 900_000, module: "GENERAL_MEANS" })).toBe(true);
    expect(initialCentralStatus({ amount: 4_000, module: "GENERAL_MEANS" })).toBe("AWAITING");
    expect(needsCentralAuthorization({ amount: 80_000, module: "REGULATORY" })).toBe(true);
  });

  it("un montant illisible entre au centre comme les autres", () => {
    expect(needsCentralAuthorization({ amount: Number.NaN })).toBe(true);
    expect(initialCentralStatus({ amount: Number.NaN })).toBe("AWAITING");
  });

  it("le seuil survit comme MARQUEUR d'importance, pas comme filtre", () => {
    // Il sert à trier la file du centre. Il ne décide plus de qui y entre.
    expect(isHighValue(CENTRAL_AUTH_THRESHOLD_DZD)).toBe(true);
    expect(isHighValue(2_400_000)).toBe(true);
    expect(isHighValue(49_999)).toBe(false);
    // Un montant illisible se regarde en premier : le doute profite au contrôle.
    expect(isHighValue(Number.NaN)).toBe(true);
  });
});

describe("Le verrou de décaissement", () => {
  it("ne laisse payer QUE l'autorisé et le non-requis", () => {
    expect(canDisburse("APPROVED")).toBe(true);
    expect(canDisburse("NOT_REQUIRED")).toBe(true);
  });

  it("bloque tout le reste, y compris les allers-retours en cours", () => {
    for (const s of ["AWAITING", "CHANGES_REQUESTED", "INFO_REQUESTED", "REFUSED"] as CentralStatus[]) {
      expect(canDisburse(s), s).toBe(false);
    }
  });

  it("dit POURQUOI c'est bloqué — « non autorisé » seul fait ouvrir un ticket", () => {
    expect(blockedReason("AWAITING")).toContain("attend l'autorisation");
    expect(blockedReason("CHANGES_REQUESTED")).toContain("révision du montant");
    expect(blockedReason("INFO_REQUESTED")).toContain("argumentation");
    expect(blockedReason("REFUSED")).toContain("refusé");
    expect(blockedReason("APPROVED")).toBeNull();
    expect(blockedReason("NOT_REQUIRED")).toBeNull();
  });
});

describe("Ce que les Finances reçoivent", () => {
  it("ne reçoivent RIEN tant que le centre n'a pas tranché", () => {
    expect(visibleToFinance("AWAITING")).toBe(false);
    expect(visibleToFinance("CHANGES_REQUESTED")).toBe(false);
    expect(visibleToFinance("INFO_REQUESTED")).toBe(false);
  });

  it("reçoivent les petits montants sans attendre", () => {
    expect(visibleToFinance("NOT_REQUIRED")).toBe(true);
  });

  it("voient aussi les REFUSÉS — il faut savoir qu'il ne faut pas payer, et pourquoi", () => {
    expect(visibleToFinance("REFUSED")).toBe(true);
    expect(visibleToFinance("APPROVED")).toBe(true);
  });
});

describe("Qui siège au centre", () => {
  it("le PDG, le Directeur Général et le Super Admin, chacun suffisant (point 24, 27/10)", () => {
    expect(sitsOnPaymentCentre({ role: "DIRECTION" })).toBe(true);
    expect(sitsOnPaymentCentre({ role: "GENERAL_MANAGER" })).toBe(true);
    expect(sitsOnPaymentCentre({ role: "SUPER_ADMIN" })).toBe(true);
  });

  it("aucun autre RÔLE — ni le Directeur des opérations ni les Finances", () => {
    // Élargir le centre à la direction opérationnelle recréerait le circuit qu'il remplace.
    for (const role of ["OPERATIONS_DIRECTOR", "FINANCE_BUDGET_MANAGER", "DIRECTION_ASSISTANT", "VIEWER"]) {
      expect(sitsOnPaymentCentre({ role }), role).toBe(false);
    }
  });

  it("mais une personne NOMMÉMENT désignée y siège, quel que soit son rôle", () => {
    // Le siège nommé existe parce que le cercle n'avait qu'un seul élargissement possible :
    // donner le rôle Direction — MANAGE sur tous les pôles, vue globale, Chief of Staff. Autoriser
    // des paiements ne doit pas coûter de devenir quasi-administrateur.
    expect(sitsOnPaymentCentre({ role: "FINANCE_BUDGET_MANAGER", access: { paymentCentreSeat: true } })).toBe(true);
    expect(sitsOnPaymentCentre({ role: "VIEWER", access: { paymentCentreSeat: true } })).toBe(true);
  });

  it("un accès SANS siège ne siège pas — et un accès absent non plus", () => {
    expect(sitsOnPaymentCentre({ role: "VIEWER", access: { paymentCentreSeat: false } })).toBe(false);
    expect(sitsOnPaymentCentre({ role: "VIEWER", access: {} })).toBe(false);
    expect(sitsOnPaymentCentre({ role: "VIEWER" })).toBe(false);
  });

  it("le refus DIT comment on entre — un « non autorisé » sec fait ouvrir un ticket", () => {
    expect(PAYMENT_CENTRE_REFUSAL).toMatch(/désignées/i);
    expect(PAYMENT_CENTRE_REFUSAL).toMatch(/Administration/);
  });
});

describe("Les allers-retours — un refus sec bloque le travail", () => {
  it("autorise et refuse depuis l'attente", () => {
    expect(applyDecision("AWAITING", "APPROVE")).toBe("APPROVED");
    expect(applyDecision("AWAITING", "REFUSE")).toBe("REFUSED");
  });

  it("rend la main au demandeur pour une révision ou une argumentation", () => {
    expect(applyDecision("AWAITING", "REQUEST_CHANGES")).toBe("CHANGES_REQUESTED");
    expect(applyDecision("AWAITING", "REQUEST_INFO")).toBe("INFO_REQUESTED");
    expect(awaitsRequester("CHANGES_REQUESTED")).toBe(true);
    expect(awaitsCentre("CHANGES_REQUESTED")).toBe(false);
  });

  it("le demandeur resoumet, et la balle repasse au centre — autant de fois qu'il faut", () => {
    let s: CentralStatus = "AWAITING";
    s = applyDecision(s, "REQUEST_CHANGES")!;
    s = applyResubmission(s)!;
    expect(s).toBe("AWAITING");
    s = applyDecision(s, "REQUEST_INFO")!;
    s = applyResubmission(s)!;
    expect(s).toBe("AWAITING");
    expect(applyDecision(s, "APPROVE")).toBe("APPROVED");
  });

  it("on ne resoumet pas un dossier que le centre n'a pas encore regardé", () => {
    expect(canResubmit("AWAITING")).toBe(false);
    expect(applyResubmission("AWAITING")).toBeNull();
  });

  it("un dossier tranché ne se re-décide pas — deux administrateurs ne se contrediront pas sans trace", () => {
    expect(applyDecision("APPROVED", "REFUSE")).toBeNull();
    expect(applyDecision("REFUSED", "APPROVE")).toBeNull();
  });

  it("on ne décide pas d'un paiement qui n'avait pas à passer par le centre", () => {
    expect(applyDecision("NOT_REQUIRED", "APPROVE")).toBeNull();
  });
});

describe("statutApresNouveauMontant — le centre autorise un MONTANT, pas un dossier (§118.148)", () => {
  it("RELEVER un montant autorisé le renvoie au centre", () => {
    expect(statutApresNouveauMontant({ courant: "APPROVED", avant: 500_000, apres: 900_000 })).toBe("AWAITING");
  });
  it("…et un ordre HISTORIQUE non payé aussi : la hausse est un engagement neuf", () => {
    expect(statutApresNouveauMontant({ courant: "NOT_REQUIRED", avant: 10_000, apres: 60_000 })).toBe("AWAITING");
  });
  it("BAISSER ne rouvre rien — c'est un geste qui réduit", () => {
    expect(statutApresNouveauMontant({ courant: "APPROVED", avant: 900_000, apres: 500_000 })).toBe("APPROVED");
    expect(statutApresNouveauMontant({ courant: "APPROVED", avant: 500_000, apres: 500_000 })).toBe("APPROVED");
  });
  it("un REFUS reste un refus : relever le montant ne le rend pas acceptable", () => {
    expect(statutApresNouveauMontant({ courant: "REFUSED", avant: 1, apres: 2 })).toBe("REFUSED");
  });
  it("en attente ou chez le demandeur : la balle ne change pas de camp", () => {
    expect(statutApresNouveauMontant({ courant: "AWAITING", avant: 1, apres: 2 })).toBe("AWAITING");
    expect(statutApresNouveauMontant({ courant: "CHANGES_REQUESTED", avant: 1, apres: 2 })).toBe("CHANGES_REQUESTED");
  });
  it("un montant ILLISIBLE compte comme une hausse — le sens sûr", () => {
    expect(statutApresNouveauMontant({ courant: "APPROVED", avant: 500_000, apres: Number.NaN })).toBe("AWAITING");
    expect(statutApresNouveauMontant({ courant: "APPROVED", avant: Number.NaN, apres: 500_000 })).toBe("AWAITING");
  });
});

describe("statutApresRevision — le centre autorise une somme, À QUELQU'UN (§118.191)", () => {
  const r = (courant: CentralStatus, avant: number, apres: number, ba: string | null, bb: string | null) =>
    statutApresRevision({ courant, avant, apres, beneficiaireAvant: ba, beneficiaireApres: bb });
  it("un AUTRE bénéficiaire rouvre une autorisation donnée, même sans toucher au montant", () => {
    expect(r("APPROVED", 500_000, 500_000, "SARL Atlas", "EURL Ziryab")).toBe("AWAITING");
    expect(r("NOT_REQUIRED", 500_000, 500_000, "SARL Atlas", "EURL Ziryab")).toBe("AWAITING");
  });
  it("…et même en BAISSANT le montant : on ne paie pas moins à quelqu'un d'autre sans que le centre l'ait vu", () => {
    expect(r("APPROVED", 500_000, 100_000, "SARL Atlas", "EURL Ziryab")).toBe("AWAITING");
  });
  it("la casse, les accents et les espaces ne font pas un autre bénéficiaire", () => {
    expect(r("APPROVED", 500_000, 500_000, "Hôtel  Ziryab ", "hotel ziryab")).toBe("APPROVED");
    expect(memeBeneficiaire("SARL Atlas", "sarl   atlas")).toBe(true);
  });
  it("…mais on ne rapproche RIEN d'autre : « Atlas » n'est pas « SARL Atlas »", () => {
    expect(memeBeneficiaire("Atlas", "SARL Atlas")).toBe(false);
    expect(r("APPROVED", 500_000, 500_000, "Atlas", "SARL Atlas")).toBe("AWAITING");
  });
  it("la hausse garde sa règle ; la baisse au même bénéficiaire ne rouvre rien", () => {
    expect(r("APPROVED", 500_000, 900_000, "A", "A")).toBe("AWAITING");
    expect(r("APPROVED", 900_000, 500_000, "A", "A")).toBe("APPROVED");
  });
  it("en attente la balle est déjà au centre ; refusé reste refusé, quel que soit le bénéficiaire", () => {
    expect(r("AWAITING", 1, 2, "A", "B")).toBe("AWAITING");
    expect(r("REFUSED", 1, 2, "A", "B")).toBe("REFUSED");
  });
});
