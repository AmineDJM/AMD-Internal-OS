import { describe, expect, it } from "vitest";
import {
  confronterMontantAuxFactures, refusEcartMontant, phraseEcartMontant, noteEcartAssume,
  LIBELLE_CONFIRMATION_ECART, TOLERANCE_MONTANT_FACTURE_DZD, type LectureMontant,
} from "./montant-facture";

/**
 * LE MONTANT DEMANDÉ EST CELUI DE LA FACTURE — la règle pure, cas par cas (Direction, 19/10/2026). Le chemin réel (dépôt,
 * transmission, remplacement) est rejoué dans `actions/paiement-montant-retrait-flow.test.ts`.
 */
const ecart = (l: LectureMontant) => {
  if (l.etat !== "ECART") throw new Error(`attendu ECART, obtenu ${l.etat}`);
  return l;
};
/** `fr-FR` sépare les milliers d'une espace fine insécable : on compare ce qu'on lit. */
const lisible = (s: string | null) => (s ?? "").replace(/[   ]/g, " ");
const phrase = (l: Extract<LectureMontant, { etat: "ECART" }>) => lisible(phraseEcartMontant(l));

describe("confronter le montant demandé au TTC lu des factures en vigueur", () => {
  it("facture = montant demandé → conforme", () => {
    expect(confronterMontantAuxFactures(119_000, [119_000])).toEqual({ etat: "CONFORME", total: 119_000, factures: 1 });
  });

  it("le HT tapé pour une facture TTC (19 %) → écart, en moins", () => {
    const l = ecart(confronterMontantAuxFactures(100_000, [119_000]));
    expect(l).toMatchObject({ total: 119_000, montant: 100_000, ecart: -19_000 });
    expect(phrase(l)).toBe("Montant demandé 100 000 DZD, la facture fait 119 000 DZD TTC (écart de 19 000 DZD en moins).");
  });

  it("le montant du BC demandé quand la facture est PLUS PETITE → écart, en plus", () => {
    expect(ecart(confronterMontantAuxFactures(100_000, [80_000])).ecart).toBe(20_000);
  });

  it("le montant du BC demandé quand la facture est PLUS GRANDE → écart, en moins", () => {
    expect(ecart(confronterMontantAuxFactures(100_000, [120_000])).ecart).toBe(-20_000);
  });

  it("plusieurs factures (un BC facturé en deux fois) s'additionnent", () => {
    expect(confronterMontantAuxFactures(100_000, [60_000, 40_000])).toMatchObject({ etat: "CONFORME", total: 100_000, factures: 2 });
    const l = ecart(confronterMontantAuxFactures(60_000, [60_000, 40_000]));
    expect(phrase(l)).toContain("les 2 factures font 100 000 DZD TTC au total");
  });

  it("la tolérance est d'un dinar (centimes et arrondis de saisie)", () => {
    expect(TOLERANCE_MONTANT_FACTURE_DZD).toBe(1);
    expect(confronterMontantAuxFactures(119_000, [119_000.4]).etat).toBe("CONFORME");
    expect(confronterMontantAuxFactures(119_000, [119_001]).etat).toBe("CONFORME");
    expect(confronterMontantAuxFactures(119_000, [119_001.5]).etat).toBe("ECART");
    // Les centimes s'additionnent sans dérive flottante.
    expect(confronterMontantAuxFactures(0.3, [0.1, 0.2]).etat).toBe("CONFORME");
  });

  it("sans facture (un BC ou un devis seul) → rien à confronter", () => {
    expect(confronterMontantAuxFactures(100_000, [])).toEqual({ etat: "SANS_FACTURE" });
  });

  it("une facture non lue rend le montant NON VÉRIFIABLE — jamais conforme, jamais bloquant", () => {
    expect(confronterMontantAuxFactures(100_000, [null])).toEqual({ etat: "NON_LU", factures: 1, lues: 0 });
    expect(confronterMontantAuxFactures(100_000, [60_000, null])).toEqual({ etat: "NON_LU", factures: 2, lues: 1 });
    expect(refusEcartMontant({ lecture: confronterMontantAuxFactures(5, [null]), justification: null, confirme: false })).toBeNull();
  });
});

describe("un écart se corrige, ou s'explique ET se confirme", () => {
  const l = confronterMontantAuxFactures(100_000, [119_000]);

  it("sans explication → refus qui dit les deux chiffres et ce qui est attendu (le TTC)", () => {
    const r = lisible(refusEcartMontant({ lecture: l, justification: null, confirme: false }));
    expect(r).toContain("Montant demandé 100 000 DZD, la facture fait 119 000 DZD TTC");
    expect(r).toContain("corrigez-le, ou expliquez l'écart");
    expect(refusEcartMontant({ lecture: l, justification: "   ", confirme: true })).toContain("corrigez-le");
  });

  it("expliqué sans la case → refus qui nomme la case", () => {
    expect(refusEcartMontant({ lecture: l, justification: "acompte de 100 000", confirme: false })).toContain(LIBELLE_CONFIRMATION_ECART);
  });

  it("expliqué ET confirmé → passe ; la note garde la phrase et l'explication", () => {
    expect(refusEcartMontant({ lecture: l, justification: "acompte de 100 000", confirme: true })).toBeNull();
    expect(lisible(noteEcartAssume(ecart(l), " acompte de 100 000 "))).toBe(
      "ÉCART ASSUMÉ par le demandeur : Montant demandé 100 000 DZD, la facture fait 119 000 DZD TTC (écart de 19 000 DZD en moins). Justification : « acompte de 100 000 ».",
    );
  });

  it("un écart déjà assumé à l'identique ne se redemande pas ; conforme → jamais de refus", () => {
    expect(refusEcartMontant({ lecture: l, justification: null, confirme: false, dejaAssume: true })).toBeNull();
    expect(refusEcartMontant({ lecture: confronterMontantAuxFactures(119_000, [119_000]), justification: null, confirme: false })).toBeNull();
  });

  it("la phrase est déterministe — c'est elle qui reconnaît un écart déjà assumé", () => {
    expect(phraseEcartMontant(ecart(confronterMontantAuxFactures(100_000, [119_000]))))
      .toBe(phraseEcartMontant(ecart(confronterMontantAuxFactures(100_000, [119_000]))));
    expect(phraseEcartMontant(ecart(confronterMontantAuxFactures(100_000, [119_000]))))
      .not.toBe(phraseEcartMontant(ecart(confronterMontantAuxFactures(100_000, [118_000]))));
  });
});
