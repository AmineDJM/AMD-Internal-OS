import { describe, it, expect } from "vitest";
import {
  nextStage,
  canDecideLeave,
  applyLeaveDecision,
  stageNotifyRoles,
  LEAVE_STAGE_LABELS,
  type LeaveStage,
} from "./leave-workflow";

const employee = { id: "u-emp", isManager: false, isHr: false, isDg: false };
const manager = { id: "u-mgr", isManager: true, isHr: false, isDg: false };
const hr = { id: "u-hr", isManager: false, isHr: true, isDg: false };
const dg = { id: "u-dg", isManager: false, isHr: false, isDg: true };

const pending = (stage: LeaveStage) => ({ status: "PENDING" as const, stage, requesterUserId: employee.id });

describe("nextStage", () => {
  it("monte marche par marche puis s'arrête — aux RH : plus de marche DG (Direction, 06/10)", () => {
    expect(nextStage("MANAGER")).toBe("HR");
    expect(nextStage("HR")).toBe("DONE");
    // Une demande arrivée à la DG avant le changement s'y accorde.
    expect(nextStage("DG")).toBe("DONE");
    expect(nextStage("DONE")).toBe("DONE");
  });
});

describe("canDecideLeave", () => {
  it("laisse chaque marche à son titulaire, et à lui seul", () => {
    expect(canDecideLeave(pending("MANAGER"), manager).ok).toBe(true);
    expect(canDecideLeave(pending("MANAGER"), hr).ok).toBe(false);
    expect(canDecideLeave(pending("HR"), hr).ok).toBe(true);
    expect(canDecideLeave(pending("HR"), manager).ok).toBe(false);
    expect(canDecideLeave(pending("DG"), dg).ok).toBe(true);
    expect(canDecideLeave(pending("DG"), hr).ok).toBe(false);
  });

  it("laisse le DG trancher à toute étape (responsable absent = période de congés)", () => {
    expect(canDecideLeave(pending("MANAGER"), dg).ok).toBe(true);
    expect(canDecideLeave(pending("HR"), dg).ok).toBe(true);
  });

  it("refuse l'auto-validation, sauf au DG qui n'a personne au-dessus", () => {
    const own = { status: "PENDING" as const, stage: "MANAGER" as LeaveStage, requesterUserId: manager.id };
    expect(canDecideLeave(own, manager).ok).toBe(false);
    expect(canDecideLeave(own, manager).reason).toMatch(/sa propre demande/i);

    const dgOwn = { status: "PENDING" as const, stage: "DG" as LeaveStage, requesterUserId: dg.id };
    expect(canDecideLeave(dgOwn, dg).ok).toBe(true);
  });

  it("refuse tout ce qui est déjà tranché", () => {
    expect(canDecideLeave({ status: "APPROVED", stage: "DONE" }, dg).ok).toBe(false);
    expect(canDecideLeave({ status: "REJECTED", stage: "DONE" }, dg).ok).toBe(false);
    expect(canDecideLeave({ status: "CANCELLED", stage: "MANAGER" }, dg).ok).toBe(false);
    expect(canDecideLeave({ status: "PENDING", stage: "DONE" }, dg).ok).toBe(false);
  });

  it("dit CE QUI manque, pas « non autorisé »", () => {
    // Un tiers sans mandat : le message doit nommer la marche attendue.
    const bystander = { id: "u-other", isManager: false, isHr: false, isDg: false };
    expect(canDecideLeave(pending("MANAGER"), bystander).reason).toMatch(/responsable/i);
    expect(canDecideLeave(pending("HR"), bystander).reason).toMatch(/ressources humaines/i);
    expect(canDecideLeave(pending("DG"), bystander).reason).toMatch(/direction générale/i);
    // Le demandeur lui-même : un message différent, qui dit pourquoi.
    expect(canDecideLeave(pending("MANAGER"), employee).reason).toMatch(/sa propre demande/i);
  });
});

describe("applyLeaveDecision", () => {
  it("n'accorde le congé qu'à la dernière marche — les RH", () => {
    const a = applyLeaveDecision("MANAGER", "APPROVED");
    expect(a).toEqual({ stage: "HR", status: "PENDING", granted: false });
    const b = applyLeaveDecision("HR", "APPROVED");
    expect(b).toEqual({ stage: "DONE", status: "APPROVED", granted: true });
    // Une demande restée à la DG (d'avant le changement) s'y accorde encore.
    expect(applyLeaveDecision("DG", "APPROVED")).toEqual({ stage: "DONE", status: "APPROVED", granted: true });
  });

  it("un refus arrête tout, à n'importe quelle marche", () => {
    for (const stage of ["MANAGER", "HR", "DG"] as LeaveStage[]) {
      expect(applyLeaveDecision(stage, "REJECTED")).toEqual({ stage: "DONE", status: "REJECTED", granted: false });
    }
  });

  it("le solde n'est débité qu'une fois : une seule transition porte granted", () => {
    const path: LeaveStage[] = ["MANAGER", "HR"];
    const granted = path.map((s) => applyLeaveDecision(s, "APPROVED").granted).filter(Boolean);
    expect(granted).toHaveLength(1);
  });
});

describe("stageNotifyRoles", () => {
  it("prévient la bonne équipe à l'arrivée sur la marche", () => {
    // CES NOMS DOIVENT EXISTER dans l'énumération `UserRole` : « RH_MANAGER » y figurait sans
    // exister, Prisma refusait la requête entière et l'étape RH ne prévenait plus PERSONNE —
    // pas même le Super Admin, pourtant bien listé. On teste donc la valeur exacte.
    expect(stageNotifyRoles("HR")).toEqual(["DIRECTION", "GENERAL_MANAGER", "SUPER_ADMIN"]);
    expect(stageNotifyRoles("DG")).toContain("DIRECTION");
    // La dernière marche appartient au sommet — le Directeur Général en fait partie.
    expect(stageNotifyRoles("DG")).toContain("GENERAL_MANAGER");
    // MANAGER : c'est une personne nommée (le N+1 résolu), pas un rôle.
    expect(stageNotifyRoles("MANAGER")).toEqual([]);
    expect(stageNotifyRoles("DONE")).toEqual([]);
  });
});

describe("LEAVE_STAGE_LABELS", () => {
  it("nomme les quatre états en français", () => {
    for (const s of ["MANAGER", "HR", "DG", "DONE"] as LeaveStage[]) {
      expect(LEAVE_STAGE_LABELS[s]).toBeTruthy();
    }
  });
});
