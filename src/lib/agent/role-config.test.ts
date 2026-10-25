import { describe, expect, it } from "vitest";
import type { CurrentUser } from "@/lib/session";
import type { PowerTool } from "@/lib/assistant/power-tools";
import {
  filtrerOutilsParRole,
  resoudreConsignesRole,
  sauvegarderRoleConfig,
} from "./role-config";

function creerOutil(nom: string): PowerTool {
  return {
    def: {
      name: nom,
      description: `Description ${nom}`,
      input_schema: { type: "object" },
    } as PowerTool["def"],
    allowed: () => true,
    label: "Outil de test",
    run: async () => "ok",
  };
}

describe("role-config — Jalon 4 (Décisions Q4 & Q12)", () => {
  describe("filtrerOutilsParRole — Le RBAC reste le plafond", () => {
    it("laisse passer tous les outils permis si aucune restriction de rôle n'est définie", () => {
      const outils = [creerOutil("annuaire"), creerOutil("regulatory"), creerOutil("taches")];
      const resultat = filtrerOutilsParRole(outils, null);
      expect(resultat.map((o) => o.def.name)).toEqual(["annuaire", "regulatory", "taches"]);
    });

    it("restreint les outils à la liste configurée", () => {
      const outils = [creerOutil("annuaire"), creerOutil("regulatory"), creerOutil("taches")];
      const resultat = filtrerOutilsParRole(outils, { allowedTools: ["annuaire", "taches"] });
      expect(resultat.map((o) => o.def.name)).toEqual(["annuaire", "taches"]);
    });

    it("ne peut jamais inventer un outil absent de la liste RBAC initiale", () => {
      const outils = [creerOutil("annuaire")];
      // La config tente d'autoriser "finances", mais "finances" n'est pas permis par RBAC
      const resultat = filtrerOutilsParRole(outils, { allowedTools: ["annuaire", "finances"] });
      expect(resultat.map((o) => o.def.name)).toEqual(["annuaire"]);
    });
  });

  describe("resoudreConsignesRole", () => {
    it("assemble le nom, le ton et les consignes", () => {
      const config = {
        role: "MEDICAL_DELEGATE" as const,
        assistantName: "Luna Terrain",
        tone: "Direct et synthétique",
        customInstructions: "Priorité aux rendez-vous de la wilaya d'Alger.",
        allowedTools: [],
        confirmationLevel: "CRITIQUE",
        enforcedModel: null,
        updatedAt: new Date(),
        updatedById: null,
      };

      const texte = resoudreConsignesRole(config);
      expect(texte).toContain("Luna Terrain");
      expect(texte).toContain("Direct et synthétique");
      expect(texte).toContain("wilaya d'Alger");
    });

    it("retourne undefined si la configuration est vide", () => {
      expect(resoudreConsignesRole(null)).toBeUndefined();
    });
  });

  describe("sauvegarderRoleConfig — validation et contrôle", () => {
    it("refuse la modification pour un utilisateur non-admin", async () => {
      const stagiaire = {
        id: "u-stagiaire",
        role: "VIEWER",
        access: { modules: new Map(), rowGrants: new Map() },
      } as unknown as CurrentUser;

      const resultat = await sauvegarderRoleConfig(
        { role: "MEDICAL_DELEGATE", tone: "formel" },
        stagiaire
      );

      expect(resultat.ok).toBe(false);
      expect(resultat.error).toContain("Seul un administrateur");
    });

    it("refuse des consignes dépassant 2 000 caractères", async () => {
      const admin = {
        id: "u-admin",
        role: "SUPER_ADMIN",
        access: { modules: new Map(), rowGrants: new Map() },
      } as unknown as CurrentUser;

      const texteTropLong = "A".repeat(2005);
      const resultat = await sauvegarderRoleConfig(
        { role: "HEAD_OF_REGULATORY", customInstructions: texteTropLong },
        admin
      );

      expect(resultat.ok).toBe(false);
      expect(resultat.error).toContain("2 000 caractères");
    });
  });
});
