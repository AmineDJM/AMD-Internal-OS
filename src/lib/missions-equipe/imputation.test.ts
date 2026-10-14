import { describe, expect, it } from "vitest";
import { CATEGORIES_OPERATIONS, CLE_MASSE_SALARIALE } from "@/lib/budget-operations/force-de-vente";
import {
  CATEGORIE_EQUIPE_PAR_DEFAUT, categorieParDefaut, categoriesImputables, etatBudgetaireNoteFrais, imputationHistorique,
  optionsImputation, poleDeLImputation, texteImputation, type CategorieCandidate,
} from "./imputation";

const ENV = "Operations & Sales 2026";
const cat = (id: string, name: string, extra: Partial<CategorieCandidate> = {}): CategorieCandidate => ({ id, name, parentId: null, cle: null, envelopeName: ENV, ...extra });
const CATS = [
  cat("ms", "Masse salariale de la force de vente", { cle: CLE_MASSE_SALARIALE }),
  cat("ms-bu", "Oncologie", { cle: CLE_MASSE_SALARIALE, parentId: "ms" }),
  cat("veh", "Véhicules & carburant"),
  cat("dep", "Frais de déplacement terrain"),
  cat("log", "Logistique"),
  cat("log-sub", "Transport colis", { parentId: "log" }),
];

describe("Imputation de l'équipe Adventum — Operations & Sales, jamais Ad & Pro", () => {
  it("la catégorie par défaut est une catégorie d'office du pôle", () => {
    expect(CATEGORIES_OPERATIONS.map((c) => c.nom)).toContain(CATEGORIE_EQUIPE_PAR_DEFAUT);
  });

  it("la masse salariale (et ses sous-catégories par BU) n'est jamais proposée", () => {
    const ids = categoriesImputables(CATS).map((c) => c.id);
    expect(ids).not.toContain("ms");
    expect(ids).not.toContain("ms-bu");
    expect(ids).toEqual(["veh", "dep", "log", "log-sub"]);
  });

  it("« Frais de déplacement terrain » par défaut, en tête des options, chemin complet", () => {
    expect(categorieParDefaut(CATS)?.id).toBe("dep");
    const opts = optionsImputation(CATS);
    expect(opts[0]).toEqual({ id: "dep", label: `${ENV} › Frais de déplacement terrain` });
    expect(opts.find((o) => o.id === "log-sub")?.label).toBe(`${ENV} › Logistique › Transport colis`);
  });

  it("sans « Frais de déplacement terrain », la première catégorie de 1er niveau imputable ; sans rien, aucune", () => {
    expect(categorieParDefaut(CATS.filter((c) => c.id !== "dep"))?.id).toBe("veh");
    expect(categorieParDefaut(CATS.filter((c) => c.id.startsWith("ms")))).toBeNull();
  });

  it("le pôle d'une imputation : Operations, Ad & Pro (historique), autre", () => {
    expect(poleDeLImputation({ domaine: "OPERATIONS" })).toBe("OPERATIONS");
    expect(poleDeLImputation({ domaine: "MARKETING" })).toBe("AD_PRO");
    expect(poleDeLImputation({ domaine: "GENERAL", modules: ["CONGRESS_INTERNATIONAL"] })).toBe("AD_PRO");
    expect(poleDeLImputation({ domaine: "GENERAL", module: "SPONSORING" })).toBe("AD_PRO");
    expect(poleDeLImputation({ domaine: "REGULATORY" })).toBe("AUTRE");
  });

  it("l'écran dit où va l'imputation — et montre une ancienne imputation Ad & Pro telle quelle", () => {
    const ops = { categoryId: "dep", libelle: `${ENV} › Frais de déplacement terrain`, pole: "OPERATIONS" as const, parDefaut: true };
    expect(texteImputation(ops, null)).toBe(`${ENV} › Frais de déplacement terrain (par défaut)`);
    expect(texteImputation({ ...ops, parDefaut: false }, null)).toBe(`${ENV} › Frais de déplacement terrain`);
    const adPro = { categoryId: "x", libelle: "Ad & Pro 2026 › Congrès", pole: "AD_PRO" as const, parDefaut: false };
    expect(texteImputation(adPro, null)).toBe("Ad & Pro 2026 › Congrès — ancienne imputation Ad & Pro");
    expect(imputationHistorique(adPro)).toBe(true);
    expect(imputationHistorique(ops)).toBe(false);
    expect(texteImputation(null, "O&S › Déplacements")).toBe("O&S › Déplacements (par défaut)");
    expect(texteImputation(null, null)).toBe("Operations & Sales — catégorie à choisir");
  });

  it("la note de frais vue du budget : engagée en route, consommée une fois validée, rien si refusée", () => {
    expect(etatBudgetaireNoteFrais("PENDING", "PENDING")).toBe("ENGAGE");
    expect(etatBudgetaireNoteFrais("IN_PROGRESS", null)).toBe("ENGAGE");
    expect(etatBudgetaireNoteFrais("PENDING", "REJECTED")).toBeNull();
    expect(etatBudgetaireNoteFrais("READY", "APPROVED")).toBe("CONSOMME");
    expect(etatBudgetaireNoteFrais("DELIVERED", null)).toBe("CONSOMME");
    expect(etatBudgetaireNoteFrais("REJECTED", null)).toBeNull();
    expect(etatBudgetaireNoteFrais("CANCELLED", null)).toBeNull();
  });
});
