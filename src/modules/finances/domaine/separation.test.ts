import { describe, expect, it } from "vitest";
import {
  refusSeparationDesTaches, REFUS_AUTORISER_SA_DEMANDE, REFUS_AUTORISER_SON_APPROBATION, REFUS_REGLER_SA_DEMANDE,
  REFUS_REGLER_SON_AUTORISATION,
} from "./separation";

describe("séparation des tâches au centre de paiement (ARGENT-06)", () => {
  const ordre = { requestedById: "demandeur", centralDecidedById: "siege" };

  it("on n'autorise pas sa propre demande", () => {
    expect(refusSeparationDesTaches("AUTORISER", ordre, "demandeur", true)).toBe(REFUS_AUTORISER_SA_DEMANDE);
    expect(refusSeparationDesTaches("AUTORISER", ordre, "autre", true)).toBeNull();
  });

  it("on ne règle ni ce qu'on a demandé, ni ce qu'on a autorisé", () => {
    expect(refusSeparationDesTaches("REGLER", ordre, "demandeur", true)).toBe(REFUS_REGLER_SA_DEMANDE);
    expect(refusSeparationDesTaches("REGLER", ordre, "siege", true)).toBe(REFUS_REGLER_SON_AUTORISATION);
    expect(refusSeparationDesTaches("REGLER", ordre, "comptable", true)).toBeNull();
  });

  it("qui a approuvé la demande en amont (validation, visa) ne l'autorise pas au centre (garde-fous, 24/11/2026)", () => {
    const approuve = { ...ordre, approbateursEnAmont: ["valideur", "dg"] };
    expect(refusSeparationDesTaches("AUTORISER", approuve, "dg", true)).toBe(REFUS_AUTORISER_SON_APPROBATION);
    expect(refusSeparationDesTaches("AUTORISER", approuve, "super-admin", true)).toBeNull();
    // Le demandeur garde SA phrase : c'est la première raison.
    expect(refusSeparationDesTaches("AUTORISER", { ...approuve, approbateursEnAmont: ["demandeur"] }, "demandeur", true)).toBe(REFUS_AUTORISER_SA_DEMANDE);
    // Approuver en amont n'empêche pas de régler : seul le geste du centre est visé.
    expect(refusSeparationDesTaches("REGLER", approuve, "valideur", true)).toBeNull();
    // Le Super Admin y échappe, comme au reste de la règle.
    expect(refusSeparationDesTaches("AUTORISER", approuve, "dg", true, true)).toBeNull();
  });

  it("les refus disent le remède : un AUTRE membre de la Direction générale autorise, un autre des Finances paie", () => {
    expect(REFUS_AUTORISER_SA_DEMANDE).toMatch(/autre membre de la Direction générale/);
    expect(REFUS_AUTORISER_SON_APPROBATION).toMatch(/autre membre de la Direction générale/);
    expect(REFUS_REGLER_SON_AUTORISATION).toMatch(/autre membre des Finances/);
  });

  it("un ordre sans demandeur nommé (émis par le système) ne bloque personne", () => {
    expect(refusSeparationDesTaches("AUTORISER", { requestedById: null, centralDecidedById: null }, "siege", true)).toBeNull();
  });

  it("le SUPER ADMIN autorise et règle ses propres demandes (Direction, 03/11/2026) — les autres restent tenus", () => {
    expect(refusSeparationDesTaches("AUTORISER", ordre, "demandeur", true, true)).toBeNull();
    expect(refusSeparationDesTaches("REGLER", ordre, "demandeur", true, true)).toBeNull();
    expect(refusSeparationDesTaches("REGLER", ordre, "siege", true, true)).toBeNull();
    expect(refusSeparationDesTaches("AUTORISER", ordre, "demandeur", true, false)).toBe(REFUS_AUTORISER_SA_DEMANDE);
  });

  it("suspendue par le Super Admin, la règle ne refuse rien", () => {
    expect(refusSeparationDesTaches("AUTORISER", ordre, "demandeur", false)).toBeNull();
    expect(refusSeparationDesTaches("REGLER", ordre, "siege", false)).toBeNull();
  });
});
