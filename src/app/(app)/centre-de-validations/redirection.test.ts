import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * L'ANCIENNE ADRESSE DU CENTRE ABOUTIT (24/11/2026) — le centre de validations n'a plus qu'un écran, `/validations`.
 * `/centre-de-validations` (entrée de menu, anciens liens, notifications déjà en base) y mène, l'étape visée conservée ;
 * sa porte (`VALIDATION_CENTRE`, `ouvreLeCentreDeValidations`) ne change pas.
 */

const suivi = vi.hoisted(() => ({ redirige: null as string | null, introuvable: false, role: "GENERAL_MANAGER" }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { suivi.redirige = url; throw new Error("NEXT_REDIRECT"); },
  notFound: () => { suivi.introuvable = true; throw new Error("NEXT_NOT_FOUND"); },
}));
vi.mock("@/lib/session", () => ({
  requireModule: async () => ({ id: "u1", name: "U", email: "u@t.dz", role: suivi.role, mustChangePassword: false }),
}));

import CentreDeValidationsPage from "./page";
import { reécriteLienNotification } from "@/lib/notifications/lien-actuel";
import { CHEMIN_CENTRE_BC } from "@/lib/bons-de-commande/regle";

const ouvrir = (sp: Record<string, string> = {}) => CentreDeValidationsPage({ searchParams: Promise.resolve(sp) }).catch(() => undefined);

describe("/centre-de-validations → l'écran unique", () => {
  beforeEach(() => { suivi.redirige = null; suivi.introuvable = false; suivi.role = "GENERAL_MANAGER"; });

  it("qui a accès au centre arrive sur /validations", async () => {
    await ouvrir();
    expect(suivi.redirige).toBe("/validations");
  });

  it("l'étape, la demande et le panneau visés suivent ; un paramètre inconnu tombe", async () => {
    await ouvrir({ focus: "s1", vue: "regles", autre: "x" });
    expect(suivi.redirige).toBe("/validations?focus=s1&vue=regles");
    await ouvrir({ demande: "r9" });
    expect(suivi.redirige).toBe("/validations?demande=r9");
  });

  it("la porte ne change pas : sans accès au centre, la page reste introuvable", async () => {
    suivi.role = "MEDICAL_DELEGATE";
    await ouvrir({ focus: "s1" });
    expect(suivi.introuvable).toBe(true);
    expect(suivi.redirige).toBeNull();
  });

  it("les liens déjà écrits (notifications, BC refusés) mènent à l'écran unique", () => {
    expect(reécriteLienNotification("/centre-de-validations?focus=s1#val-s1")).toBe("/validations?focus=s1#val-s1");
    expect(CHEMIN_CENTRE_BC.VALIDATION).toBe("/validations");
  });
});
