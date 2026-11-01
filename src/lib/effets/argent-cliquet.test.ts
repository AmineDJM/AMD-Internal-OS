import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { CONTRATS_ACTIONS } from "@/lib/actions/contrat.genere";
import { CHEMIN_CLICHE, type LigneCliche } from "@/platform/ia/capacites/cliche";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * CLIQUET K10a — AUCUNE ACTION D'ARGENT QUI ÉCRIT N'EST « SANS ANNULATION » (décision 0039).
 *
 * « Toute action qui a été faite peut être réversible » (Direction, 31/10/2026). Le périmètre de l'argent — finance,
 * trésorerie, paiements, caisse, paie, factures, budgets, fournisseurs — est lu par FICHIER d'actions : une action
 * ajoutée demain à l'un d'eux, qui écrit sans passer par `annulable(…)`, est classée « aucune » par le registre et
 * fait échouer ce test, avec son nom. Une lecture (R0) n'a rien à défaire : hors périmètre.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
const PERIMETRE_ARGENT = /^(actualisation-soldes|budget-campagne|budget-depense-poste|budget-envelope|department-budget|expense|finance|invoice|payment-centre|payment-centre-seat|payment-request|payroll-hr|petty-cash|supplier|ventes-pch)-actions$/;

const cliche = JSON.parse(readFileSync(CHEMIN_CLICHE, "utf8")) as Record<string, LigneCliche>;
const duPerimetre = CONTRATS_ACTIONS.filter((c) => PERIMETRE_ARGENT.test(c.fichier));

describe("Cliquet K10a — l'argent se défait d'un geste", () => {
  it("PLANCHER : le périmètre est bien lu (une lecture cassée rendrait le cliquet vert sur rien)", () => {
    expect(duPerimetre.length).toBeGreaterThanOrEqual(62);
  });

  it("aucune action écrivante du périmètre n'est classée « aucune » — le refus nomme l'action", () => {
    const sansAnnulation = duPerimetre.filter((c) => cliche[c.id] && cliche[c.id]!.risque !== "R0" && cliche[c.id]!.annulation === "aucune").map((c) => c.id);
    expect(sansAnnulation, "action d'argent qui écrit sans `annulable(…)` : enrobez-la (lib/effets/ecran.ts) et déclarez son mode").toEqual([]);
  });

  it("chaque action écrivante du périmètre DÉCLARE son mode (`annulable`) — pas une annulation devinée", () => {
    const nonDeclarees = duPerimetre.filter((c) => cliche[c.id]?.risque !== "R0" && !c.annulable).map((c) => c.id);
    expect(nonDeclarees).toEqual([]);
  });

  it("l'argent qui se crée se COMPENSE : saisie, encaissement, import, règlement et paiement déclarent « compensation »", () => {
    const attendues = [
      "finance-actions:createTransaction", "finance-actions:createQuickIncome", "finance-actions:importTransactions",
      "expense-actions:settleExpenseOrder", "invoice-actions:setInvoicePaid", "payment-centre-actions:decidePayment", "payroll-hr-actions:markSalaryPaid",
    ];
    for (const id of attendues) expect(cliche[id]?.annulation, id).toBe("compensation");
  });
});
