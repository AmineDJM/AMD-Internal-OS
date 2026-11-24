import { describe, it, expect } from "vitest";
import { statutAffiche, type DecisionsLocales } from "./decisions-locales";

/**
 * LA DÉCISION DU CENTRE SE VOIT AUSSITÔT, ET NE SE COMPTE QU'UNE FOIS (recette sponsoring, 23/11/2026).
 *
 * Le DG autorisait, la feuille se refermait, et la carte restait « En attente » avec son bouton
 * « Autoriser » jusqu'au rechargement : il recliquait. La carte montre désormais l'état confirmé
 * par le serveur — mais seulement tant que le serveur montre encore l'état d'avant : ses nouvelles
 * données arrivées, ce sont elles qui parlent.
 */

describe("statutAffiche — la carte", () => {
  const decisions: DecisionsLocales = { a: { depuis: "AWAITING", statut: "APPROVED", montant: 100_000 } };

  it("montre l'autorisation confirmée tant que le serveur montre encore « en attente »", () => {
    expect(statutAffiche("a", "AWAITING", decisions)).toBe("APPROVED");
  });

  it("rend la parole au serveur dès que ses nouvelles données sont là", () => {
    expect(statutAffiche("a", "APPROVED", decisions)).toBe("APPROVED");
    // Un autre état venu du serveur (corrigé ailleurs, rouvert) l'emporte sur la décision locale.
    expect(statutAffiche("a", "CHANGES_REQUESTED", decisions)).toBe("CHANGES_REQUESTED");
  });

  it("ne touche pas aux ordres sur lesquels on n'a rien décidé", () => {
    expect(statutAffiche("b", "AWAITING", decisions)).toBe("AWAITING");
  });
});
