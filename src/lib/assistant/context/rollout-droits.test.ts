import { describe, it, expect, beforeEach } from "vitest";
import "@/lib/assistant";
import { assistantToolsFor } from "@/lib/assistant";
import { decideRollout, resetGuard, SAFE_READ_TOOLS } from "./rollout";
import type { CurrentUser } from "@/lib/session";
import { MODULES, ACTIONS, can, defaultScope, type Module, type Action } from "@/lib/rbac";
import type { UserRole } from "@prisma/client";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE RACCOURCI DE LECTURE NE PREND QUE LES OUTILS DE LA PERSONNE (§118.153).
 *
 * Mesuré en parcours réel, dans la peau du pharmacien : « Où en est Nintedanib ? » partait sur le
 * chemin rapide avec `inspect_record` — un outil réservé à la Direction. L'outil répondait « ce
 * module ne vous est pas ouvert », et le raccourci, qui n'envoie aucun schéma d'outil au modèle,
 * lui faisait reformuler CE REFUS comme la réponse. La boucle complète n'expose que les outils
 * permis : elle trouve le chemin qui existe pour cette personne, ou dit qu'il n'y en a pas.
 *
 * Les acteurs sont bâtis depuis la VRAIE matrice de rôles (`can`, `defaultScope`) : un acteur
 * écrit à la main pourrait porter un droit qu'aucun rôle réel n'a, et le cas ne prouverait rien.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

function acteurDuRole(role: UserRole): CurrentUser {
  const modules = new Map<Module, { actions: Set<Action>; scope: string }>();
  for (const m of MODULES) {
    const actions = new Set<Action>(ACTIONS.filter((a) => can(role, m, a)));
    if (actions.size > 0) modules.set(m, { actions, scope: defaultScope(role, m) });
  }
  return {
    id: `essai-${role}`, name: "Essai", email: "essai@example.invalid", role,
    access: { modules, rowGrants: [], secondaryRole: null, role, pipelineView: false, pipelineManage: false },
  } as unknown as CurrentUser;
}

const permis = (u: CurrentUser) => assistantToolsFor(u).map((t) => t.name);
const QUESTION_FICHE = "Où en est Nintedanib ?";

beforeEach(() => resetGuard());

describe("§118.153 — le chemin rapide ne lit pas avec un outil que la personne n'a pas", () => {
  it("PRÉMISSE : chaque outil de la liste blanche existe pour le Super Admin", () => {
    // Sans elle, la règle désarmerait EN SILENCE le raccourci d'un outil que personne n'expose
    // (un nom renommé d'un côté seulement) : le chemin rapide disparaîtrait pour tout le monde
    // sans qu'un seul test tombe.
    const sa = new Set(permis(acteurDuRole("SUPER_ADMIN")));
    for (const outil of SAFE_READ_TOOLS) expect(sa.has(outil), `${outil} absent de la liste du Super Admin`).toBe(true);
  });

  it("PRÉMISSE : le pharmacien n'a PAS l'outil de fiche — sinon le cas ne mesure rien", () => {
    expect(permis(acteurDuRole("MEDICAL_INFO_PHARMACIST"))).not.toContain("inspect_record");
  });

  it("la même question part en boucle complète pour le pharmacien, en rapide pour la Direction", () => {
    const direction = decideRollout(QUESTION_FICHE, { userId: "d", canaryPercent: 0, outilsPermis: permis(acteurDuRole("DIRECTION")) });
    expect(direction.mode).toBe("FAST_READ");
    expect(direction.route.tool).toBe("inspect_record");

    const pharmacien = decideRollout(QUESTION_FICHE, { userId: "p", canaryPercent: 0, outilsPermis: permis(acteurDuRole("MEDICAL_INFO_PHARMACIST")) });
    expect(pharmacien.mode).toBe("LEGACY");
    expect(pharmacien.reason).toMatch(/hors des droits/);
  });

  it("les lectures ouvertes à tous restent rapides pour tous — la règle ne ferme rien d'autre", () => {
    // Le sens inverse : une garde trop large refuserait le raccourci à qui a l'outil, et le
    // coût (un tour plus lent) se paierait à chaque question d'annuaire.
    const outils = permis(acteurDuRole("MEDICAL_INFO_PHARMACIST"));
    const d = decideRollout("Quel est l'email de Raihana ?", { userId: "p", canaryPercent: 0, outilsPermis: outils });
    expect(outils).toContain(d.route.tool as string);
    expect(d.mode).toBe("FAST_READ");
  });

  it("les DEUX tours d'Adam passent les outils permis à la décision (point d'appel, §118.49)", async () => {
    const { readFileSync } = await import("node:fs");
    // `assistant.ts` découpé (lot V4) : ses deux tours vivent dans `boucle/tour.ts` et `boucle/flux.ts`.
    const source = ["src/lib/assistant/boucle/tour.ts", "src/lib/assistant/boucle/flux.ts"].map((f) => readFileSync(f, "utf8")).join("\n");
    const appels = source.match(/decideRollout\([^;]*\);/g) ?? [];
    expect(appels.length, "le tour d'un trait ET le tour en flux").toBe(2);
    for (const a of appels) expect(a).toMatch(/outilsPermis:\s*allTools\.map\(\(t\) => t\.name\)/);
  });
});
