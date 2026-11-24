import { describe, it, expect } from "vitest";
import {
  initialTrainingStage, initialParticipantState, canRespondToInvitation, countParticipants,
  canEditTraining, grantedAmount, etapeDeFormation,
  type TrainingAttendance, type TrainingParticipantState,
} from "./training";
import { applyChainDecision, canDecideChain } from "./approval-chain";

const p = (attendance: TrainingAttendance, state: TrainingParticipantState) => ({ attendance, state });

describe("initialTrainingStage — d'où part le circuit selon l'origine", () => {
  it("fait monter la demande d'un salarié depuis son responsable", () => {
    expect(initialTrainingStage("EMPLOYEE", true)).toBe("MANAGER");
  });

  it("saute le responsable quand il n'y en a pas — plutôt que d'attendre dans le vide", () => {
    expect(initialTrainingStage("EMPLOYEE", false)).toBe("HR");
  });

  it("envoie DIRECTEMENT à l'autorisation du Directeur des opérations une formation organisée par les RH (réglementaire comprise)", () => {
    // Les RH SONT l'étape RH : les faire signer chez elles serait une signature vide, et le
    // N+1 de l'organisatrice n'a rien à dire d'une formation qui n'est pas pour son équipe.
    // Plus de DG (Super Admin, 24/11/2026) : la dernière marche est le Directeur des opérations.
    expect(initialTrainingStage("HR", true)).toBe("OPERATIONS");
    expect(initialTrainingStage("HR", false)).toBe("OPERATIONS");
  });
});

describe("le circuit d'une formation — N+1 → RH → Directeur des opérations, sans le DG (24/11/2026)", () => {
  it("après les RH, la formation monte au Directeur des opérations, qui l'accorde définitivement", () => {
    expect(applyChainDecision("HR", "APPROVED", { derniere: "OPERATIONS" })).toEqual({ stage: "OPERATIONS", status: "PENDING", granted: false });
    expect(applyChainDecision("OPERATIONS", "APPROVED", { derniere: "OPERATIONS" })).toEqual({ stage: "DONE", status: "APPROVED", granted: true });
  });

  it("seul le Directeur des opérations (ou le Super Admin, outrepasse) tranche cette marche — pas le DG", () => {
    const etat = { status: "PENDING" as const, stage: "OPERATIONS" as const, requesterUserId: "r" };
    expect(canDecideChain(etat, { id: "ops", isManager: false, isHr: false, isDg: false, isOps: true }).ok).toBe(true);
    expect(canDecideChain(etat, { id: "rh", isManager: false, isHr: true, isDg: false }).ok).toBe(false);
    expect(canDecideChain(etat, { id: "sa", isManager: false, isHr: false, isDg: true }).ok).toBe(true);
    // On ne s'autorise pas soi-même.
    expect(canDecideChain(etat, { id: "r", isManager: false, isHr: false, isDg: false, isOps: true }).ok).toBe(false);
  });

  it("une formation restée « chez le DG » se lit à l'autorisation du Directeur des opérations, sans réécrire l'historique", () => {
    expect(etapeDeFormation("DG", "PENDING")).toBe("OPERATIONS");
    expect(etapeDeFormation("DG", "APPROVED")).toBe("DG");
    expect(etapeDeFormation("HR", "PENDING")).toBe("HR");
  });

  it("le congé, lui, ne change pas : il s'arrête aux RH", () => {
    expect(applyChainDecision("HR", "APPROVED", { sansDG: true })).toEqual({ stage: "DONE", status: "APPROVED", granted: true });
  });
});

describe("initialParticipantState / canRespondToInvitation", () => {
  it("enregistre d'emblée la présence d'un convoqué", () => {
    expect(initialParticipantState("MANDATORY")).toBe("ACCEPTED");
    expect(initialParticipantState("VOLUNTARY")).toBe("INVITED");
  });

  it("refuse la réponse d'un convoqué — « obligatoire » n'attend pas d'accord", () => {
    const r = canRespondToInvitation(p("MANDATORY", "ACCEPTED"));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/obligatoire/i);
  });

  it("laisse répondre un invité volontaire, une seule fois", () => {
    expect(canRespondToInvitation(p("VOLUNTARY", "INVITED")).ok).toBe(true);
    expect(canRespondToInvitation(p("VOLUNTARY", "ACCEPTED")).ok).toBe(false);
    expect(canRespondToInvitation(p("VOLUNTARY", "DECLINED")).reason).toMatch(/déjà répondu/i);
  });
});

describe("countParticipants — le chiffre qui sert au traiteur", () => {
  it("compte les convoqués, les réponses et ce qu'on attend encore", () => {
    const c = countParticipants([
      p("MANDATORY", "ACCEPTED"),
      p("MANDATORY", "ACCEPTED"),
      p("VOLUNTARY", "ACCEPTED"),
      p("VOLUNTARY", "DECLINED"),
      p("VOLUNTARY", "INVITED"),
    ]);
    expect(c).toEqual({ total: 5, mandatory: 2, accepted: 3, declined: 1, awaiting: 1, expected: 3 });
  });

  it("ne compte pas comme présent quelqu'un qui n'a pas répondu", () => {
    const c = countParticipants([p("VOLUNTARY", "INVITED"), p("VOLUNTARY", "INVITED")]);
    expect(c.expected).toBe(0);
    expect(c.awaiting).toBe(2);
  });

  it("rend des zéros sur une liste vide", () => {
    expect(countParticipants([])).toEqual({ total: 0, mandatory: 0, accepted: 0, declined: 0, awaiting: 0, expected: 0 });
  });
});

describe("canEditTraining — ce qui a fondé une décision ne se réécrit pas", () => {
  const me = { id: "u1", isHr: false, isDg: false };

  it("laisse le demandeur corriger tant que rien n'est tranché", () => {
    expect(canEditTraining({ status: "PENDING", requesterId: "u1" }, me)).toBe(true);
    expect(canEditTraining({ status: "DRAFT", requesterId: "u1" }, me)).toBe(true);
  });

  it("ferme la porte une fois la formation accordée ou refusée", () => {
    expect(canEditTraining({ status: "APPROVED", requesterId: "u1" }, me)).toBe(false);
    expect(canEditTraining({ status: "REJECTED", requesterId: "u1" }, me)).toBe(false);
  });

  it("n'ouvre pas la demande d'un collègue", () => {
    expect(canEditTraining({ status: "PENDING", requesterId: "autre" }, me)).toBe(false);
  });

  it("laisse les RH corriger une demande en cours, et la Direction toujours", () => {
    expect(canEditTraining({ status: "PENDING", requesterId: "autre" }, { ...me, isHr: true })).toBe(true);
    expect(canEditTraining({ status: "APPROVED", requesterId: "autre" }, { ...me, isDg: true })).toBe(true);
  });
});

describe("grantedAmount", () => {
  it("retient le montant ACCORDÉ dès qu'il existe, sinon le demandé", () => {
    expect(grantedAmount({ amount: 100_000, amountGranted: 80_000 })).toBe(80_000);
    expect(grantedAmount({ amount: 100_000, amountGranted: null })).toBe(100_000);
    // Un accord à zéro est une décision, pas une absence de décision.
    expect(grantedAmount({ amount: 100_000, amountGranted: 0 })).toBe(0);
  });
});
