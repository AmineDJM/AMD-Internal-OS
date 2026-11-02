import { describe, expect, it } from "vitest";
import { normalizeConfirmText, matchesConfirmText } from "@/platform/ia/intentions/confirm";
import { payloadRequiresStrongConfirm, type AssistantActionPayload } from "@/lib/assistant";

/**
 * CONFIRMATION RENFORCÉE — la règle serveur (§ sécurité) : la ressaisie d'une action CRITIQUE
 * est vérifiée PAR LE SERVEUR (executeAssistantAction), plus seulement par la carte. Ces goldens
 * verrouillent les deux briques pures : la comparaison canonique (compatible épellation vocale)
 * et le recalcul du niveau depuis le payload (refus des CRITIQUES arrivées sans intent).
 */

describe("matchesConfirmText — la comparaison canonique, pensée pour la voix", () => {
  it("épellation vocale : « R E G - 2026 041 » vaut « REG-2026-041 »", () => {
    expect(matchesConfirmText("R E G - 2026 041", "REG-2026-041")).toBe(true);
    expect(matchesConfirmText("reg 2026 041", "REG-2026-041")).toBe(true);
  });

  it("montants : « 1 500 000 », « 1500000 », « 1.500.000 » se valent (espaces insécables comprises)", () => {
    expect(matchesConfirmText("1 500 000", "1500000")).toBe(true);
    expect(matchesConfirmText("1.500.000", "1 500 000")).toBe(true);
    expect(matchesConfirmText("1500000", "1 500 000")).toBe(true);
  });

  it("accents et casse ne comptent pas : « lot 3 » vaut « LOT 3 », « Généré » vaut « genere »", () => {
    expect(matchesConfirmText("lot 3", "LOT 3")).toBe(true);
    expect(matchesConfirmText("plan 4", "PLAN 4")).toBe(true);
    expect(matchesConfirmText("Généré", "genere")).toBe(true);
  });

  it("le CONTENU, lui, doit être exact : une autre référence ou un autre montant ne passe PAS", () => {
    expect(matchesConfirmText("REG-2026-042", "REG-2026-041")).toBe(false);
    expect(matchesConfirmText("150000", "1500000")).toBe(false);
    expect(matchesConfirmText("LOT 2", "LOT 3")).toBe(false);
    expect(matchesConfirmText("", "REG-2026-041")).toBe(false);
  });

  it("une exigence VIDE ne matche jamais — pas de laissez-passer par carte mal formée", () => {
    expect(matchesConfirmText("", "")).toBe(false);
    expect(matchesConfirmText("x", "")).toBe(false);
    expect(matchesConfirmText("—", "-  ")).toBe(false); // exigence sans caractère porteur
  });

  it("normalizeConfirmText : NFD sans accents, minuscules, seuls lettres+chiffres restent", () => {
    expect(normalizeConfirmText("Éléphant N° 12-B")).toBe("elephantn12b");
    expect(normalizeConfirmText("1 500 000 DZD")).toBe("1500000dzd");
  });
});

describe("payloadRequiresStrongConfirm — le niveau CRITIQUE se recalcule du payload, jamais du client", () => {
  const p = (x: unknown) => x as AssistantActionPayload;

  it("actions canoniques : delete_record et update_salary sont CRITIQUES, create_task non", () => {
    expect(payloadRequiresStrongConfirm(p({ kind: "delete_record", deleteKind: "drive", targetId: "x", name: "n", label: "l" }))).toBe(true);
    expect(payloadRequiresStrongConfirm(p({ kind: "update_salary", employeeId: "e", employeeName: "E", fields: [] }))).toBe(true);
    expect(payloadRequiresStrongConfirm(p({ kind: "create_task", title: "t" }))).toBe(false);
  });

  it("ops de domaine : le niveau vient du CATALOGUE — drive delete oui, create_folder non", () => {
    expect(payloadRequiresStrongConfirm(p({ kind: "domain_op", tool: "drive_operation", op: "delete", opLabel: "x", args: {}, successMessage: "s" }))).toBe(true);
    expect(payloadRequiresStrongConfirm(p({ kind: "domain_op", tool: "drive_operation", op: "create_folder", opLabel: "x", args: {}, successMessage: "s" }))).toBe(false);
  });

  it("un LOT est critique dès qu'UN item l'est", () => {
    const benign = { kind: "create_task", title: "t" };
    const critical = { kind: "delete_record", deleteKind: "drive", targetId: "x", name: "n", label: "l" };
    expect(payloadRequiresStrongConfirm(p({ kind: "bulk_action", innerTool: "create_task", summary: "s", items: [{ payload: benign, display: "a" }] }))).toBe(false);
    expect(payloadRequiresStrongConfirm(p({ kind: "bulk_action", innerTool: "delete_record", summary: "s", items: [{ payload: benign, display: "a" }, { payload: critical, display: "b" }] }))).toBe(true);
  });

  it("un PLAN est critique par une étape RÉSOLUE critique — ou par une étape DIFFÉRÉE critique ($prev)", () => {
    const benignStep = { kind: "resolved", payload: { kind: "create_task", title: "t" }, display: "a" };
    const criticalResolved = { kind: "resolved", payload: { kind: "domain_op", tool: "drive_operation", op: "delete", opLabel: "x", args: {}, successMessage: "s" }, display: "b" };
    const criticalDeferredDomain = { kind: "deferred", tool: "drive_operation", input: { op: "delete", name: "$prev.name" }, display: "c" };
    const criticalDeferredCore = { kind: "deferred", tool: "delete_record", input: { reference: "$prev.title" }, display: "d" };
    const benignDeferred = { kind: "deferred", tool: "create_task", input: { title: "$prev.title" }, display: "e" };

    expect(payloadRequiresStrongConfirm(p({ kind: "action_plan", summary: "s", steps: [benignStep, benignDeferred] }))).toBe(false);
    expect(payloadRequiresStrongConfirm(p({ kind: "action_plan", summary: "s", steps: [benignStep, criticalResolved] }))).toBe(true);
    expect(payloadRequiresStrongConfirm(p({ kind: "action_plan", summary: "s", steps: [benignStep, criticalDeferredDomain] }))).toBe(true);
    expect(payloadRequiresStrongConfirm(p({ kind: "action_plan", summary: "s", steps: [benignStep, criticalDeferredCore] }))).toBe(true);
  });
});
