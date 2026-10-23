import { describe, expect, it } from "vitest";
import type { CurrentUser } from "@/lib/session";
import type { EffectiveAccess, Module } from "@/lib/rbac";
import { compileContext } from "./contexte";

function creerUtilisateur(role: string, modulesAutorises: Module[] = []): CurrentUser {
  const mapModules = new Map();
  for (const m of modulesAutorises) {
    mapModules.set(m, {
      actions: new Set(["VIEW", "CREATE", "EDIT"]),
      scope: "ALL",
    });
  }

  const access: EffectiveAccess = {
    modules: mapModules,
    rowGrants: new Map(),
    role: role as never,
  };

  return {
    id: `user-${role.toLowerCase()}`,
    name: `Utilisateur ${role}`,
    email: `${role.toLowerCase()}@adventum.dz`,
    role: role as never,
    access,
    mustChangePassword: false,
  };
}

describe("compileContext — Jalon 3 (Décision Q9 & Q14)", () => {
  it("génère un contexte complet avec identité, date d'Alger et périmètre RBAC", async () => {
    const user = creerUtilisateur("HEAD_OF_REGULATORY", ["REGULATORY", "REGULATORY_PIPELINE"]);
    const resultat = await compileContext({ user });

    expect(resultat.systemPrompt).toContain("Adventum Pharma");
    expect(resultat.systemPrompt).toContain("Utilisateur HEAD_OF_REGULATORY");
    expect(resultat.systemPrompt).toContain("fuseau Africa/Algiers");
    expect(resultat.systemPrompt).toContain("Regulatory");
    expect(resultat.systemPrompt).toContain("Pipeline réglementaire");
    expect(resultat.tokensEstimes.total).toBeGreaterThan(50);
    expect(resultat.tokensEstimes.total).toBeLessThan(8000);
    expect(resultat.provenance.userId).toBe(user.id);
  });

  it("intègre le contexte d'écran et censure les données sensibles passées dans l'objet", async () => {
    const user = creerUtilisateur("SUPER_ADMIN", ["REGULATORY"]);
    const resultat = await compileContext({
      user,
      page: {
        pathname: "/regulatory/dossiers/dossier-42",
        donneesObjet: {
          dci: "Amoxicilline",
          forme: "Gélule 500mg",
          salaire: 200000, // Doit être censuré !
          rib: "00799900012345678901", // Doit être censuré !
        },
      },
    });

    expect(resultat.systemPrompt).toContain("/regulatory/dossiers/dossier-42");
    expect(resultat.systemPrompt).toContain("Amoxicilline");
    expect(resultat.systemPrompt).not.toContain("200000");
    expect(resultat.systemPrompt).not.toContain("00799900012345678901");
    expect(resultat.systemPrompt).toContain("[CONFIDENTIEL]");
    expect(resultat.provenance.censureAppliquee).toBe(true);
  });

  it("intègre les consignes spécifiques du rôle en censurant toute mention sensible", async () => {
    const user = creerUtilisateur("MEDICAL_DELEGATE", ["MEDICAL"]);
    const resultat = await compileContext({
      user,
      consignesRole: "Ton direct et orienté terrain. Attention : salaire net est de 150 000 DZD.",
    });

    expect(resultat.systemPrompt).toContain("Ton direct et orienté terrain");
    expect(resultat.systemPrompt).not.toContain("150 000 DZD");
    expect(resultat.systemPrompt).toContain("[CONFIDENTIEL]");
    expect(resultat.provenance.censureAppliquee).toBe(true);
  });

  it("fonctionne proprement sans threadId ni page", async () => {
    const user = creerUtilisateur("VIEWER");
    const resultat = await compileContext({ user });

    expect(resultat.messages).toEqual([]);
    expect(resultat.tokensEstimes.messages).toBe(0);
    expect(resultat.provenance.censureAppliquee).toBe(false);
  });
});
