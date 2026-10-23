import { describe, expect, it } from "vitest";
import type { CurrentUser } from "@/lib/session";
import type { EffectiveAccess } from "@/lib/rbac";
import { outilCreerTache, outilEnvoyerMessage } from "./ecritures";

function creerUtilisateur(role: string, modules: string[] = []): CurrentUser {
  const mapModules = new Map();
  for (const m of modules) {
    mapModules.set(m, {
      actions: new Set(["VIEW", "CREATE", "UPDATE", "DELETE"]),
      scope: "ALL",
    });
  }

  const access: EffectiveAccess = {
    modules: mapModules,
    rowGrants: new Map(),
    role: role as never,
  };

  return {
    id: `u-${role.toLowerCase()}`,
    name: `Test ${role}`,
    email: `${role.toLowerCase()}@test.dz`,
    role: role as never,
    access,
    mustChangePassword: false,
  };
}

describe("ecritures — Jalon 5 (Décisions Q7 & Q8)", () => {
  describe("outilCreerTache", () => {
    it("respecte les droits RBAC (autorisé avec WORKSPACE:CREATE, refusé sans)", () => {
      const userAutorise = creerUtilisateur("DIRECTION", ["WORKSPACE"]);
      const userRefuse = creerUtilisateur("VIEWER", []);

      expect(outilCreerTache.allowed(userAutorise)).toBe(true);
      expect(outilCreerTache.allowed(userRefuse)).toBe(false);
    });

    it("valide les champs requis", async () => {
      const user = creerUtilisateur("DIRECTION", ["WORKSPACE"]);
      const retour = await outilCreerTache.run({ title: "" }, user);
      const parsed = JSON.parse(retour);
      expect(parsed.error).toContain("titre de la tâche est obligatoire");
    });
  });

  describe("outilEnvoyerMessage", () => {
    it("respecte les droits RBAC (autorisé avec MESSAGING:CREATE, refusé sans)", () => {
      const userAutorise = creerUtilisateur("MEDICAL_DELEGATE", ["MESSAGING"]);
      const userRefuse = creerUtilisateur("VIEWER", []);

      expect(outilEnvoyerMessage.allowed(userAutorise)).toBe(true);
      expect(outilEnvoyerMessage.allowed(userRefuse)).toBe(false);
    });

    it("valide la présence du destinataire et du contenu", async () => {
      const user = creerUtilisateur("DIRECTION", ["MESSAGING"]);
      const retour = await outilEnvoyerMessage.run({ destinataireId: "", body: "" }, user);
      const parsed = JSON.parse(retour);
      expect(parsed.error).toContain("identifiant du destinataire est requis");
    });
  });
});
