import { describe, it, expect } from "vitest";
import {
  buildPaymentChain, chainState, canPay, canDecideStep, canTransfer, adviceBlocksPayment,
  DEFAULT_DG_THRESHOLD_DZD, AUTHORITY_LABEL,
  type ChainApproval, type Authority,
} from "./payment-authority";

const approve = (authority: Authority, by = "u1"): ChainApproval => ({
  authority, decidedById: by, decidedAt: "2026-08-14T10:00:00.000Z",
});
const auth = (...a: Authority[]) => a;

describe("Regulatory — bordereau de versement : les finances, et elles seules", () => {
  const chain = buildPaymentChain({ domain: "REGULATORY_BV", initiator: "OTHER", amount: 2_000_000 });

  it("n'a QU'UNE étape, même sur un montant énorme", () => {
    expect(chain).toHaveLength(1);
    expect(chain[0].authority).toBe("FINANCE");
  });

  it("ne fait passer ni par les opérations ni par la direction générale", () => {
    const authorities = chain.map((s) => s.authority);
    expect(authorities).not.toContain("OPERATIONS");
    expect(authorities).not.toContain("GENERAL_MANAGEMENT");
  });

  it("dit POURQUOI le circuit est court — un raccourci non expliqué se lit comme un oubli", () => {
    expect(chain[0].reason).toMatch(/réglementaire/i);
  });
});

describe("Hors Regulatory — le montant décide de l'autorisation de paiement", () => {
  it("≤ seuil : la direction des opérations termine la chaîne", () => {
    const chain = buildPaymentChain({ domain: "OTHER", initiator: "PRODUCT_MANAGER", amount: 500_000 });
    expect(chain.map((s) => s.authority)).toEqual(["OPERATIONS"]);
  });

  it("> seuil : la direction générale s'ajoute, APRÈS les opérations", () => {
    const chain = buildPaymentChain({ domain: "OTHER", initiator: "PRODUCT_MANAGER", amount: 500_001 });
    expect(chain.map((s) => s.authority)).toEqual(["OPERATIONS", "GENERAL_MANAGEMENT"]);
  });

  it("le seuil est un PARAMÈTRE : le changer change la chaîne, sans toucher au code", () => {
    const chain = buildPaymentChain({ domain: "OTHER", initiator: "PRODUCT_MANAGER", amount: 200_000 }, 100_000);
    expect(chain.map((s) => s.authority)).toContain("GENERAL_MANAGEMENT");
    expect(DEFAULT_DG_THRESHOLD_DZD).toBe(500_000);
  });

  it("exactement AU seuil, la direction générale n'est pas requise", () => {
    // « supérieur à 500 000 » : 500 000 pile reste en dessous. Une borne mal placée fait
    // remonter au patron des dépenses qui n'auraient jamais dû lui parvenir.
    const chain = buildPaymentChain({ domain: "OTHER", initiator: "OTHER", amount: DEFAULT_DG_THRESHOLD_DZD });
    expect(chain.map((s) => s.authority)).not.toContain("GENERAL_MANAGEMENT");
  });
});

describe("La validation MÉTIER dépend du demandeur, jamais du montant", () => {
  it("demande d'un délégué / KAM : superviseur national puis Direction Marketing", () => {
    const chain = buildPaymentChain({ domain: "AD_PRO_EXECUTION", initiator: "FIELD_REP", amount: 50_000 });
    expect(chain.map((s) => s.authority)).toEqual(["NATIONAL_SUPERVISOR", "PRODUCT_MANAGER", "OPERATIONS"]);
  });

  it("demande d'un délégué au-dessus du seuil : la DG s'ajoute en fin de chaîne", () => {
    const chain = buildPaymentChain({ domain: "AD_PRO_EXECUTION", initiator: "FIELD_REP", amount: 900_000 });
    expect(chain.map((s) => s.authority)).toEqual([
      "NATIONAL_SUPERVISOR", "PRODUCT_MANAGER", "OPERATIONS", "GENERAL_MANAGEMENT",
    ]);
  });

  it("demande d'un DIRECTION MARKETING : il ne se valide pas lui-même", () => {
    const chain = buildPaymentChain({ domain: "AD_PRO_EXECUTION", initiator: "PRODUCT_MANAGER", amount: 50_000 });
    expect(chain.map((s) => s.authority)).toEqual(["OPERATIONS"]);
    expect(chain.map((s) => s.authority)).not.toContain("PRODUCT_MANAGER");
  });

  it("fourniture / moyens généraux : RH d'abord, puis les opérations", () => {
    const chain = buildPaymentChain({ domain: "SUPPLIES_ADMIN", initiator: "HR_SUPPLIES", amount: 80_000 });
    expect(chain.map((s) => s.authority)).toEqual(["HR", "OPERATIONS"]);
  });

  it("fourniture au-dessus du seuil : RH → opérations → direction générale", () => {
    const chain = buildPaymentChain({ domain: "SUPPLIES_ADMIN", initiator: "OTHER", amount: 1_200_000 });
    expect(chain.map((s) => s.authority)).toEqual(["HR", "OPERATIONS", "GENERAL_MANAGEMENT"]);
  });

  it("dépense d'exécution Ad & Pro (hôtel, visa) sous le seuil : les opérations SEULES", () => {
    const chain = buildPaymentChain({ domain: "AD_PRO_EXECUTION", initiator: "OTHER", amount: 120_000 });
    expect(chain.map((s) => s.authority)).toEqual(["OPERATIONS"]);
  });
});

describe("Chaque étape se distingue : valider le fond ≠ engager l'argent", () => {
  const chain = buildPaymentChain({ domain: "AD_PRO_EXECUTION", initiator: "FIELD_REP", amount: 900_000 });

  it("le métier valide, la direction engage", () => {
    expect(chain.filter((s) => s.kind === "BUSINESS").map((s) => s.authority))
      .toEqual(["NATIONAL_SUPERVISOR", "PRODUCT_MANAGER"]);
    expect(chain.filter((s) => s.kind === "PAYMENT").map((s) => s.authority))
      .toEqual(["OPERATIONS", "GENERAL_MANAGEMENT"]);
  });

  it("seule la direction générale peut transférer son autorisation", () => {
    expect(chain.find((s) => s.authority === "GENERAL_MANAGEMENT")?.transferable).toBe(true);
    expect(chain.filter((s) => s.authority !== "GENERAL_MANAGEMENT").every((s) => !s.transferable)).toBe(true);
  });
});

describe("Garde de paiement — les finances ne paient pas avant la fin", () => {
  const chain = buildPaymentChain({ domain: "AD_PRO_EXECUTION", initiator: "FIELD_REP", amount: 900_000 });

  it("refuse tant qu'une étape manque, et DIT laquelle", () => {
    const gate = canPay(chainState(chain, [approve("NATIONAL_SUPERVISOR")]));
    expect(gate.ok).toBe(false);
    expect(gate.missing).toEqual(["PRODUCT_MANAGER", "OPERATIONS", "GENERAL_MANAGEMENT"]);
    expect(gate.reason).toContain(AUTHORITY_LABEL.PRODUCT_MANAGER);
  });

  it("refuse même quand TOUT le métier a validé, s'il manque l'engagement financier", () => {
    const gate = canPay(chainState(chain, [approve("NATIONAL_SUPERVISOR"), approve("PRODUCT_MANAGER")]));
    expect(gate.ok).toBe(false);
    expect(gate.missing).toEqual(["OPERATIONS", "GENERAL_MANAGEMENT"]);
  });

  it("refuse encore si la direction générale manque au-dessus du seuil", () => {
    const gate = canPay(chainState(chain, [approve("NATIONAL_SUPERVISOR"), approve("PRODUCT_MANAGER"), approve("OPERATIONS")]));
    expect(gate.ok).toBe(false);
    expect(gate.missing).toEqual(["GENERAL_MANAGEMENT"]);
  });

  it("n'autorise QUE lorsque la chaîne est entière", () => {
    const full = chainState(chain, [
      approve("NATIONAL_SUPERVISOR"), approve("PRODUCT_MANAGER"), approve("OPERATIONS"), approve("GENERAL_MANAGEMENT"),
    ]);
    expect(canPay(full)).toEqual({ ok: true, missing: [] });
  });

  it("un bordereau Regulatory se paie dès l'accord des finances", () => {
    const bv = buildPaymentChain({ domain: "REGULATORY_BV", initiator: "OTHER", amount: 3_000_000 });
    expect(canPay(chainState(bv, [])).ok).toBe(false);
    expect(canPay(chainState(bv, [approve("FINANCE")])).ok).toBe(true);
  });
});

describe("Qui peut franchir l'étape — et pas avant son tour", () => {
  const chain = buildPaymentChain({ domain: "AD_PRO_EXECUTION", initiator: "FIELD_REP", amount: 900_000 });

  it("refuse une personne qui n'a pas cette autorité", () => {
    const r = canDecideStep(chainState(chain, []), auth("PRODUCT_MANAGER"));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain(AUTHORITY_LABEL.NATIONAL_SUPERVISOR);
  });

  it("accepte le titulaire de l'étape courante", () => {
    expect(canDecideStep(chainState(chain, []), auth("NATIONAL_SUPERVISOR")).ok).toBe(true);
  });

  it("refuse de sauter un tour — la direction générale ne signe pas avant les opérations", () => {
    const state = chainState(chain, [approve("NATIONAL_SUPERVISOR"), approve("PRODUCT_MANAGER")]);
    const dgStep = chain.find((s) => s.authority === "GENERAL_MANAGEMENT")!;
    const r = canDecideStep(state, auth("GENERAL_MANAGEMENT"), dgStep);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain(AUTHORITY_LABEL.OPERATIONS);
  });

  it("ne laisse rien valider une fois la chaîne complète", () => {
    const full = chainState(chain, [
      approve("NATIONAL_SUPERVISOR"), approve("PRODUCT_MANAGER"), approve("OPERATIONS"), approve("GENERAL_MANAGEMENT"),
    ]);
    expect(canDecideStep(full, auth("GENERAL_MANAGEMENT")).ok).toBe(false);
  });
});

describe("Transfert de l'autorisation — nominatif, et réservé à la direction générale", () => {
  const chain = buildPaymentChain({ domain: "OTHER", initiator: "PRODUCT_MANAGER", amount: 900_000 });
  const atDg = chainState(chain, [approve("OPERATIONS")]);

  it("la direction générale transfère à une personne DÉSIGNÉE", () => {
    expect(canTransfer(atDg.current, auth("GENERAL_MANAGEMENT"), "khaled-id").ok).toBe(true);
  });

  it("refuse un transfert sans destinataire — « je délègue à la direction » n'engage personne", () => {
    const r = canTransfer(atDg.current, auth("GENERAL_MANAGEMENT"), null);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/désignez/i);
  });

  it("les autres autorités ne transfèrent pas la leur", () => {
    const opsChain = buildPaymentChain({ domain: "OTHER", initiator: "PRODUCT_MANAGER", amount: 100_000 });
    const r = canTransfer(chainState(opsChain, []).current, auth("OPERATIONS"), "quelquun");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/ne se transfère pas/i);
  });

  it("personne ne transfère l'autorisation d'autrui", () => {
    expect(canTransfer(atDg.current, auth("OPERATIONS"), "khaled-id").ok).toBe(false);
  });
});

describe("Avis — consultatif, jamais bloquant", () => {
  it("un avis ne retient aucun paiement, par construction", () => {
    expect(adviceBlocksPayment()).toBe(false);
  });

  it("la chaîne d'une dépense d'exécution reste à une seule étape, avis ou pas", () => {
    // C'est tout l'intérêt : la direction des opérations peut consulter la Direction Marketing
    // sans transformer cette consultation en une étape de plus.
    const chain = buildPaymentChain({ domain: "AD_PRO_EXECUTION", initiator: "OTHER", amount: 150_000 });
    expect(chain).toHaveLength(1);
    expect(canPay(chainState(chain, [approve("OPERATIONS")])).ok).toBe(true);
  });
});
