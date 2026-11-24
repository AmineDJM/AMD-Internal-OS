import { describe, expect, it } from "vitest";
import { trierLignesBureau, type LigneBureau } from "./ligne-bureau";

function ligne(cle: string, p: Partial<LigneBureau>): LigneBureau {
  return {
    cle, famille: "demande", type: "Déplacement", objet: cle, reference: null, demandeur: null, dates: null,
    etat: "A_PRENDRE", chezQui: null, echeance: null, depuis: "2026-11-01T00:00:00.000Z", href: `/demandes/${cle}`, ...p,
  };
}

describe("le tri du bureau du secrétariat", () => {
  it("met les ouvertes d'abord, l'échéance la plus proche en tête, puis l'attente la plus longue ; les closes en bas", () => {
    const tri = trierLignesBureau([
      ligne("close-ancienne", { etat: "TERMINEE", depuis: "2026-10-01T00:00:00.000Z" }),
      ligne("sans-echeance-recente", { depuis: "2026-11-20T00:00:00.000Z" }),
      ligne("echeance-loin", { echeance: "2026-12-20T00:00:00.000Z" }),
      ligne("close-recente", { etat: "ANNULEE", depuis: "2026-11-15T00:00:00.000Z" }),
      ligne("echeance-proche", { echeance: "2026-11-25T00:00:00.000Z" }),
      ligne("sans-echeance-ancienne", { depuis: "2026-11-02T00:00:00.000Z" }),
    ]).map((l) => l.cle);
    expect(tri).toEqual([
      "echeance-proche", "echeance-loin", "sans-echeance-ancienne", "sans-echeance-recente", "close-recente", "close-ancienne",
    ]);
  });
});
