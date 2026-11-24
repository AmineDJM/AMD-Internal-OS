import { describe, it, expect } from "vitest";
import { dansLePerimetreOperations, filtreDuPerimetre } from "./perimetre";
import { PERMISSIONS, defaultScope } from "@/lib/rbac";

describe("Adventum Brain limité au périmètre des opérations (Direction, 08/10)", () => {
  it("les risques des opérations y sont : PCH, stocks, logistique, force de vente, terrain", () => {
    for (const r of [
      { category: "PCH", module: "PCH — Marchés" }, { category: "PCH", module: "Stocks PCH" }, { category: "PCH", module: "Logistique" },
      { category: "PCH", module: "PCH · Stock" }, { category: "FIELD", module: "Force de vente" }, { category: "MEDICAL", module: "Visite médicale" }, { category: "MEDICAL", module: "Promotion médicale" },
      { category: "QUALITY", module: "Rapports terrain" },
    ]) expect(dansLePerimetreOperations(r), r.module).toBe(true);
  });

  it("le marketing, le réglementaire, les RH, les finances et les budgets n'y sont pas — même par une catégorie voisine", () => {
    for (const r of [
      { category: "FINANCE", module: "Ad & Pro · Bons de commande" }, { category: "BUDGET", module: "Ad & Pro" }, { category: "SPONSORING", module: "Sponsoring" },
      { category: "REGULATORY", module: "Regulatory" }, { category: "REGULATORY", module: "Information médicale" }, { category: "HR", module: "Recrutement" },
      { category: "FINANCE", module: "Espace comptable" }, { category: "BUDGET", module: "Budgets" }, { category: "AI", module: "Contrôle de l'IA" },
      { category: "VALIDATION", module: "Adventum Brain — Process" }, { category: "CONGRESS", module: "Congrès" },
    ]) expect(dansLePerimetreOperations(r), r.module).toBe(false);
  });

  it("le Super Admin voit tout ; toute autre personne, le périmètre", () => {
    const rh = { category: "HR", module: "Recrutement" };
    expect(filtreDuPerimetre(true)(rh)).toBe(true);
    expect(filtreDuPerimetre(false)(rh)).toBe(false);
  });
});

describe("Directeur des opérations — les droits décidés le 08/10", () => {
  const od = PERMISSIONS.OPERATIONS_DIRECTOR;
  it("gère la Force de vente (portée TOUT) et les Business Units ; le Marketing cockpit reste en lecture", () => {
    expect(od.SALES_PLANNING).toEqual(expect.arrayContaining(["VIEW", "CREATE", "UPDATE", "DELETE", "VALIDATE"]));
    expect(defaultScope("OPERATIONS_DIRECTOR", "SALES_PLANNING")).toBe("ALL");
    expect(od.BUSINESS_UNITS).toEqual(expect.arrayContaining(["VIEW", "CREATE", "UPDATE", "DELETE"]));
    expect(od.MARKETING_COCKPIT ?? []).not.toContain("UPDATE");
  });
  it("lit Adventum Brain et y agit (périmètre borné ailleurs) ; Process Intelligence reste au Super Admin", () => {
    expect(od.ADVENTUM_BRAIN).toEqual(["VIEW", "UPDATE"]);
    expect(od.PROCESS_INTELLIGENCE).toBeUndefined();
    expect(od.ADMIN).toBeUndefined();
  });
});
