import { describe, expect, it } from "vitest";
import { emailDeProspection, periodeDeLEvenement } from "./email-prospection";

describe("l'e-mail de demande de devis aux agences", () => {
  it("cite le poste, l'événement, sa date, son lieu et le cahier des charges ; signé par l'assistante", () => {
    const e = emailDeProspection({
      poste: "Stand et supports imprimés",
      cahierDesCharges: "Stand 9 m² avec comptoir, 4 kakémonos.",
      evenement: { nom: "Journée de cardiologie", debut: "2026-12-12T09:00:00.000Z", fin: "2026-12-12T17:00:00.000Z", lieu: "CHU d'Oran", ville: "Oran" },
      signataire: "Radia Kebir",
    });
    expect(e.objet).toBe("Demande de devis — Stand et supports imprimés — Journée de cardiologie");
    expect(e.corps).toContain("• Date : le 12/12/2026");
    expect(e.corps).toContain("• Lieu : CHU d'Oran, Oran");
    expect(e.corps).toContain("Stand 9 m² avec comptoir, 4 kakémonos.");
    expect(e.corps.trim().endsWith("Radia Kebir\nAdventum Pharma")).toBe(true);
  });

  it("sans événement ni signataire : rien d'inventé", () => {
    const e = emailDeProspection({ poste: "Salle", cahierDesCharges: "120 places.", evenement: null, signataire: null });
    expect(e.objet).toBe("Demande de devis — Salle");
    expect(e.corps).not.toContain("Date :");
    expect(e.corps).toContain("l'un de nos prochains événements");
  });

  it("la période dit « du … au … » sur plusieurs jours", () => {
    expect(periodeDeLEvenement({ debut: "2026-12-12T09:00:00.000Z", fin: "2026-12-13T09:00:00.000Z" })).toBe("du 12/12/2026 au 13/12/2026");
    expect(periodeDeLEvenement({ debut: null, fin: null })).toBeNull();
  });
});
