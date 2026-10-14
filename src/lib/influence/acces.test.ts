import { describe, expect, it, vi } from "vitest";

/**
 * INTELLIGENCE TERRAIN — « visible uniquement par le Super Administrateur » (Direction, 10/2026).
 *
 * La page renvoie tout autre rôle (Direction, Directeur Général, même avec tous les droits de module) AVANT de lire la
 * moindre donnée, et les deux actions refusent de même. L'analyse et les lectures sont remplacées par des pièges : si la
 * garde laissait passer, le test casserait sur eux.
 */

class Redirection extends Error {
  constructor(readonly vers: string) { super(`redirect ${vers}`); }
}
vi.mock("next/navigation", () => ({
  redirect: (vers: string) => { throw new Redirection(vers); },
  notFound: () => { throw new Error("notFound"); },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let ACTOR: { id: string; name: string; email: string; role: string; access: Record<string, unknown>; mustChangePassword: boolean } | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR, getCurrentUser: async () => ACTOR, requireModule: async () => ACTOR }));

const piege = (nom: string) => () => { throw new Error(`${nom} appelé sans être Super Admin`); };
vi.mock("@/lib/influence-luna", () => ({
  CLE_EXECUTION: "influence:execution",
  analyserInfluence: piege("analyserInfluence"),
  recalculerScoresInfluence: piege("recalculerScoresInfluence"),
  chargerContexteInfluence: piege("chargerContexteInfluence"),
}));
vi.mock("@/lib/queries/influence", () => ({ vueInfluence: piege("vueInfluence") }));
vi.mock("@/lib/queries/roi-adpro", () => ({ vueRoi: piege("vueRoi") }));

const acteur = (role: string) => ({ id: `u-${role}`, name: role, email: `${role}@test`, role, access: {}, mustChangePassword: false });

async function destination(appel: () => unknown): Promise<string | null> {
  try {
    await appel();
  } catch (e) {
    if (e instanceof Redirection) return e.vers;
    throw e;
  }
  return null;
}

describe("Intelligence terrain — Super Administrateur seul", () => {
  for (const role of ["DIRECTION", "GENERAL_MANAGER", "HEAD_OF_SALES", "SALES_USER"]) {
    it(`la page renvoie ${role} sans rien lire (les deux onglets)`, async () => {
      ACTOR = acteur(role);
      const { default: Page } = await import("@/app/(app)/admin/intelligence-terrain/page");
      expect(await destination(() => Page({ searchParams: { onglet: "influence" } }))).toBe("/dashboard?denied=ADMIN");
      expect(await destination(() => Page({ searchParams: { onglet: "roi" } }))).toBe("/dashboard?denied=ADMIN");
    });

    it(`les actions refusent ${role} (403) sans rien écrire`, async () => {
      ACTOR = acteur(role);
      const { relancerAnalyseInfluence, deciderLienInfluence } = await import("@/lib/actions/intelligence-terrain-actions");
      expect(await relancerAnalyseInfluence()).toEqual({ ok: false, error: "Réservé au Super Admin." });
      const fd = new FormData();
      fd.set("relationId", "x");
      fd.set("decision", "CONFIRMEE");
      expect(await deciderLienInfluence(fd)).toEqual({ ok: false, error: "Réservé au Super Admin." });
    });
  }

  it("le Super Admin passe la garde (la lecture est alors appelée)", async () => {
    ACTOR = acteur("SUPER_ADMIN");
    const { default: Page } = await import("@/app/(app)/admin/intelligence-terrain/page");
    await expect(Page({ searchParams: { onglet: "influence" } })).rejects.toThrow("vueInfluence appelé");
    await expect(Page({ searchParams: { onglet: "roi" } })).rejects.toThrow("vueRoi appelé");
  });
});
