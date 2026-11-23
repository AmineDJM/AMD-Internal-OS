import { describe, it, expect } from "vitest";
import { bilanAffiche, statutAffiche, type DecisionsLocales } from "./decisions-locales";

/**
 * LA DÉCISION DU CENTRE SE VOIT AUSSITÔT, ET NE SE COMPTE QU'UNE FOIS (recette sponsoring, 23/11/2026).
 *
 * Le DG autorisait, la feuille se refermait, et la carte restait « En attente » avec son bouton
 * « Autoriser » jusqu'au rechargement : il recliquait. La carte montre désormais l'état confirmé
 * par le serveur — mais seulement tant que le serveur montre encore l'état d'avant : ses nouvelles
 * données arrivées, ce sont elles qui parlent, et les compteurs ne doublent pas la décision.
 */

const bilan = { enAttente: 4, montantEnAttente: 400_000, autorises: 2, refuses: 1 };

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

describe("bilanAffiche — les compteurs", () => {
  it("une autorisation : un de moins en attente, son montant retiré, un autorisé de plus", () => {
    const d: DecisionsLocales = { a: { depuis: "AWAITING", statut: "APPROVED", montant: 74_613 } };
    expect(bilanAffiche(bilan, { a: "AWAITING" }, d)).toEqual({ enAttente: 3, montantEnAttente: 325_387, autorises: 3, refuses: 1 });
  });

  it("un refus : un de moins en attente, un refusé de plus", () => {
    const d: DecisionsLocales = { a: { depuis: "AWAITING", statut: "REFUSED", montant: 100_000 } };
    expect(bilanAffiche(bilan, { a: "AWAITING" }, d)).toEqual({ enAttente: 3, montantEnAttente: 300_000, autorises: 2, refuses: 2 });
  });

  it("une réponse du demandeur remet l'ordre en attente du centre", () => {
    const d: DecisionsLocales = { a: { depuis: "CHANGES_REQUESTED", statut: "AWAITING", montant: 50_000 } };
    expect(bilanAffiche(bilan, { a: "CHANGES_REQUESTED" }, d)).toEqual({ enAttente: 5, montantEnAttente: 450_000, autorises: 2, refuses: 1 });
  });

  it("une décision déjà reflétée par le serveur n'est PAS recomptée", () => {
    const d: DecisionsLocales = { a: { depuis: "AWAITING", statut: "APPROVED", montant: 100_000 } };
    expect(bilanAffiche(bilan, { a: "APPROVED" }, d)).toEqual(bilan);
  });

  it("une décision sur un ordre absent de la vue est ignorée", () => {
    const d: DecisionsLocales = { z: { depuis: "AWAITING", statut: "APPROVED", montant: 100_000 } };
    expect(bilanAffiche(bilan, { a: "AWAITING" }, d)).toEqual(bilan);
  });

  it("plusieurs décisions s'additionnent, sans jamais passer sous zéro", () => {
    const d: DecisionsLocales = {
      a: { depuis: "AWAITING", statut: "APPROVED", montant: 300_000 },
      b: { depuis: "AWAITING", statut: "REFUSED", montant: 300_000 },
    };
    const petit = { enAttente: 1, montantEnAttente: 300_000, autorises: 0, refuses: 0 };
    expect(bilanAffiche(petit, { a: "AWAITING", b: "AWAITING" }, d)).toEqual({ enAttente: 0, montantEnAttente: 0, autorises: 1, refuses: 1 });
  });
});
