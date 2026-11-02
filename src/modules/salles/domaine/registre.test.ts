import { describe, expect, it } from "vitest";
import { chevauche, libelleInstant, lireCreneau, lireTypeMoyen } from "./registre";

describe("registre des moyens généraux — règles pures", () => {
  it("la nature d'un moyen se lit en français", () => {
    expect(lireTypeMoyen("la voiture de service")).toBe("VEHICULE");
    expect(lireTypeMoyen("assurance flotte")).toBe("ASSURANCE");
    expect(lireTypeMoyen("vidange du Kangoo")).toBe("ENTRETIEN");
    expect(lireTypeMoyen("contrat de ménage")).toBe("CONTRAT_PRESTATAIRE");
    expect(lireTypeMoyen("salle du conseil")).toBe("SALLE");
    expect(lireTypeMoyen("SALLE")).toBe("SALLE");
    expect(lireTypeMoyen("xyz")).toBeNull();
  });

  it("créneaux en heure d'Algérie ; chevauchement strict (bout à bout libre)", () => {
    const c = lireCreneau("2027-03-12T10:00", "12:00")!;
    expect(libelleInstant(c.debut)).toBe("12/03/2027 10:00");
    expect(libelleInstant(c.fin)).toBe("12/03/2027 12:00");
    expect(lireCreneau("2027-03-12T10:00", "09:00")).toBeNull();
    const journee = lireCreneau("2027-03-12")!;
    expect(libelleInstant(journee.debut)).toBe("12/03/2027 08:00");
    expect(chevauche(c, lireCreneau("2027-03-12T11:00", "13:00")!)).toBe(true);
    expect(chevauche(c, lireCreneau("2027-03-12T12:00", "13:00")!)).toBe(false);
  });
});
