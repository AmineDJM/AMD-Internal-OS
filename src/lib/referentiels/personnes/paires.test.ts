import { describe, expect, it } from "vitest";
import { pairesDePersonnes } from "@/lib/referentiels/personnes/paires";

describe("Des fiches aux paires de Personnes", () => {
  it("ramène les propositions aux Personnes, oublie celles d'une même Personne, garde la plus forte par paire", () => {
    const paires = pairesDePersonnes([
      { personneId: "p2", fiche: { ref: "MedicalDoctor:1", nom: "Dr TADJEDDINE Zoubir", emails: ["z.tadjeddine@gmail.com"] } },
      { personneId: "p2", fiche: { ref: "CareBeneficiary:1", nom: "Zoubir Tadjeddine", liens: ["MedicalDoctor:1"] } },
      { personneId: "p1", fiche: { ref: "AdProVoyageur:1", nom: "TADJEDDINE Zoubir" } },
      { personneId: "p1", fiche: { ref: "User:1", nom: "Zoubir Tadjeddine", emails: ["z.tadjeddine@gmail.com"] } },
    ]);
    expect(paires).toHaveLength(1);
    expect(paires[0]).toMatchObject({ a: "p1", b: "p2", niveau: "CERTAIN" });
    expect(paires[0].raisons.join(" ")).toMatch(/même e-mail personnel/);
  });

  it("des personnes distinctes par leur NIN ne sont pas proposées", () => {
    expect(pairesDePersonnes([
      { personneId: "a", fiche: { ref: "Employee:1", nom: "Zoubir Tadjeddine", nin: "109870123456789012" } },
      { personneId: "b", fiche: { ref: "Employee:2", nom: "Zoubir Tadjeddine", nin: "109870999999999012" } },
    ])).toEqual([]);
  });
});
