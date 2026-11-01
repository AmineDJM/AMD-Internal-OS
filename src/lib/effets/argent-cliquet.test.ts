import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { CONTRATS_ACTIONS } from "@/lib/actions/contrat.genere";
import { CHEMIN_CLICHE, type LigneCliche } from "@/platform/ia/capacites/cliche";
import { DECLARATIONS_ARGENT } from "./declarations/argent";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * CLIQUET K10a — AUCUNE ACTION D'ARGENT QUI ÉCRIT N'EST « SANS ANNULATION » (décision 0040).
 *
 * « Toute action qui a été faite peut être réversible » (Direction, 31/10/2026). Le périmètre de l'argent — finance,
 * trésorerie, paiements, caisse, paie, factures, budgets, fournisseurs — est lu par FICHIER d'actions : une action
 * ajoutée demain à l'un d'eux, qui écrit sans passer par `annulable(…)`, est classée « aucune » par le registre et
 * fait échouer ce test, avec son nom. Une lecture (R0) n'a rien à défaire : hors périmètre.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
const PERIMETRE_ARGENT = /^(actualisation-soldes|budget-campagne|budget-depense-poste|budget-envelope|department-budget|expense|finance|invoice|payment-centre|payment-centre-seat|payment-request|payroll-hr|petty-cash|supplier|ventes-pch)-actions$/;

/** Les fichiers d'actions migrés dans un module (les autres vivent dans `src/lib/actions/`). */
const CHEMINS: Record<string, string> = {
  "actualisation-soldes-actions": "src/modules/finances/actions-soldes.ts", "expense-actions": "src/modules/finances/actions-depenses.ts",
  "finance-actions": "src/modules/finances/actions-tresorerie.ts", "payment-centre-actions": "src/modules/finances/actions-centre.ts",
  "payment-centre-seat-actions": "src/modules/finances/actions-sieges.ts", "payment-request-actions": "src/modules/finances/actions-demandes.ts",
  "payroll-hr-actions": "src/modules/rh/actions-paie.ts",
};
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

  it("chaque action écrivante du périmètre est DÉCLARÉE (`declarations/argent.ts`) et ENROBÉE (`annulable(\"son id\"`) — pas une annulation devinée", () => {
    const ecrivantes = duPerimetre.filter((c) => cliche[c.id]?.risque !== "R0");
    expect(ecrivantes.filter((c) => !DECLARATIONS_ARGENT[c.id]).map((c) => c.id)).toEqual([]);
    // La déclaration sans l'enrobage serait une promesse : le corps doit passer par le journal, sous SON identifiant.
    const sources = new Map<string, string>();
    const lire = (f: string) => sources.get(f) ?? (sources.set(f, readFileSync(f, "utf8")), sources.get(f)!);
    const fichiers = [...new Set(ecrivantes.map((c) => c.fichier))];
    const tout = fichiers.map((f) => {
      const chemin = CHEMINS[f] ?? `src/lib/actions/${f}.ts`;
      return lire(chemin);
    }).join("\n");
    const sansEffet = (id: string) => DECLARATIONS_ARGENT[id]?.mecanisme === "sans-effet";
    expect(ecrivantes.filter((c) => !sansEffet(c.id) && !tout.includes(`annulable("${c.id}"`)).map((c) => c.id)).toEqual([]);
    // « sans effet » n'est permis qu'à une action dont le contrat ne lit AUCUNE écriture.
    expect(ecrivantes.filter((c) => sansEffet(c.id) && c.ecrit).map((c) => c.id)).toEqual([]);
    expect(Object.keys(DECLARATIONS_ARGENT).filter((id) => !CONTRATS_ACTIONS.some((c) => c.id === id))).toEqual([]);
  });

  it("l'argent qui se crée se COMPENSE : saisie, encaissement, import, règlement et paiement déclarent « compensation »", () => {
    const attendues = [
      "finance-actions:createTransaction", "finance-actions:createQuickIncome", "finance-actions:importTransactions",
      "expense-actions:settleExpenseOrder", "invoice-actions:setInvoicePaid", "payment-centre-actions:decidePayment", "payroll-hr-actions:markSalaryPaid",
    ];
    for (const id of attendues) expect(cliche[id]?.annulation, id).toBe("compensation");
  });
});
