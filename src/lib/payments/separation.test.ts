import { describe, expect, it } from "vitest";
import {
  refusSeparationDesTaches, REFUS_AUTORISER_SA_DEMANDE, REFUS_REGLER_SA_DEMANDE, REFUS_REGLER_SON_AUTORISATION,
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

  it("un ordre sans demandeur nommé (émis par le système) ne bloque personne", () => {
    expect(refusSeparationDesTaches("AUTORISER", { requestedById: null, centralDecidedById: null }, "siege", true)).toBeNull();
  });

  it("suspendue par le Super Admin, la règle ne refuse rien", () => {
    expect(refusSeparationDesTaches("AUTORISER", ordre, "demandeur", false)).toBeNull();
    expect(refusSeparationDesTaches("REGLER", ordre, "siege", false)).toBeNull();
  });
});
