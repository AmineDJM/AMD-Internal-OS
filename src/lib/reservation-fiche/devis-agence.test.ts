import { describe, expect, it } from "vitest";
import { lireNoteDevisAgence, montantDitDevisAgence, noteDevisAgence } from "./devis-agence";

describe("Devis de l'agence — la note de la demande de pièce, écrite puis relue", () => {
  it("un montant en DZD et l'agence : la note se lit, et se relit telle quelle", () => {
    const note = noteDevisAgence({ pour: "billet · Amel Haddad", fournisseur: "Tassili Voyages", montantDit: montantDitDevisAgence(1_200_000, "DZD", 1_200_000) });
    expect(note).toMatch(/^Devis de l'agence pour billet · Amel Haddad\. Agence : Tassili Voyages\. Montant : 1.200.000 DZD\.$/);
    expect(lireNoteDevisAgence(note)).toEqual({ fournisseur: "Tassili Voyages", montantDzd: 1_200_000 });
  });

  it("un montant en USD : c'est sa conversion en DZD qui est relue, jamais le chiffre en dollars", () => {
    const note = noteDevisAgence({ pour: "billet · Karim Benali", fournisseur: "Air Voyages", montantDit: montantDitDevisAgence(5_000, "USD", 1_200_000) });
    expect(note).toContain("USD (= ");
    expect(lireNoteDevisAgence(note)).toEqual({ fournisseur: "Air Voyages", montantDzd: 1_200_000 });
  });

  it("les centimes passent ; un devis qui couvre plusieurs fiches garde son agence et son total", () => {
    const note = noteDevisAgence({ pour: "billet · A Haddad, billet · K Benali, billet · S Smail", fournisseur: "S.A.R.L. Genius Travel", montantDit: montantDitDevisAgence(124_750.5, "DZD", 124_750.5) });
    expect(lireNoteDevisAgence(note)).toEqual({ fournisseur: "S.A.R.L. Genius Travel", montantDzd: 124_750.5 });
  });

  it("sans agence, sans montant : rien n'est deviné", () => {
    expect(lireNoteDevisAgence(noteDevisAgence({ pour: "hôtel · Nora Fennich", fournisseur: null, montantDit: null }))).toEqual({ fournisseur: null, montantDzd: null });
    expect(lireNoteDevisAgence(noteDevisAgence({ pour: "hôtel · Nora Fennich", fournisseur: "  ", montantDit: montantDitDevisAgence(38_000, "DZD", 38_000) })))
      .toEqual({ fournisseur: null, montantDzd: 38_000 });
    expect(lireNoteDevisAgence(noteDevisAgence({ pour: "hôtel · Nora Fennich", fournisseur: "Hôtel Cirta", montantDit: null })))
      .toEqual({ fournisseur: "Hôtel Cirta", montantDzd: null });
  });

  it("une note d'une autre forme (écrite à la main) ne se relit pas", () => {
    expect(lireNoteDevisAgence("Merci de joindre la facture. Montant : 50 000 DZD.")).toEqual({ fournisseur: null, montantDzd: null });
    expect(lireNoteDevisAgence(null)).toEqual({ fournisseur: null, montantDzd: null });
  });
});
