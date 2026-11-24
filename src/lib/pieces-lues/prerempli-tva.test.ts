import { describe, expect, it } from "vitest";
import type { Repere, TotauxReperes } from "@/lib/pieces-lues/entetes";
import { tvaProposee } from "./prerempli-tva";

const r = (valeur: number, extrait: string, ligne = 10): Repere<number> => ({ valeur, raison: null, extrait, ligne });
const totaux = (x: Partial<TotauxReperes>): TotauxReperes => ({
  totalHt: null, tva: [], totalTva: null, taxes: [], timbre: null, totalTtc: null, netAPayer: null, conflits: [], ...x,
});

describe("la TVA proposée par les totaux imprimés d'une facture", () => {
  it("un seul taux imprimé : base = total HT, TVA = la ligne du taux — aux RÈGLES, chacune avec sa ligne", () => {
    const p = tvaProposee(totaux({ totalHt: r(100_000, "Total HT 100 000,00", 20), tva: [{ taux: 0.19, montant: r(19_000, "TVA 19 % 19 000,00", 21) }] }));
    expect(p.valeurs).toEqual({ tvaHt_19: "100000", tvaMontant_19: "19000" });
    expect(p.marques.tvaHt_19).toEqual({ source: "REGLES", preuve: "Total HT 100 000,00", ou: "ligne 20" });
  });
  it("plusieurs taux : la base de chacun se CALCULE (TVA ÷ taux), le reste du HT est à 0 %", () => {
    const p = tvaProposee(totaux({
      totalHt: r(115_000, "Total HT 115 000"),
      tva: [{ taux: 0.09, montant: r(900, "TVA 9 % 900") }, { taux: 0.19, montant: r(19_000, "TVA 19 % 19 000") }],
    }));
    expect(p.valeurs).toEqual({ tvaHt_9: "10000", tvaMontant_9: "900", tvaHt_19: "100000", tvaMontant_19: "19000", tvaHt_0: "5000" });
    expect(p.marques.tvaHt_9?.source).toBe("CALCUL");
    expect(p.marques.tvaHt_0?.preuve).toMatch(/115\s000 − bases taxées 110\s000 = 5\s000 DZD à 0 %/);
  });
  it("une TVA sans taux imprimé : le taux se déduit du rapport TVA / HT quand il tombe sur un taux en vigueur", () => {
    expect(tvaProposee(totaux({ totalHt: r(1_000, "HT 1 000"), totalTva: r(90, "Montant TVA 90") })).valeurs).toEqual({ tvaHt_9: "1000", tvaMontant_9: "90" });
    expect(tvaProposee(totaux({ totalHt: r(1_000, "HT 1 000"), totalTva: r(150, "Montant TVA 150") })).valeurs).toEqual({});
  });
  it("TTC = HT sans TVA imprimée : à 0 % ; le timbre se propose à part", () => {
    expect(tvaProposee(totaux({ totalHt: r(5_000, "Total HT 5 000"), totalTtc: r(5_000, "Total TTC 5 000") })).valeurs).toEqual({ tvaHt_0: "5000" });
    const p = tvaProposee(totaux({ totalHt: r(1_000, "HT"), tva: [{ taux: 0.19, montant: r(190, "TVA 19 %") }], timbre: r(11.9, "Droit de timbre 11,90") }));
    expect(p.valeurs.tvaAutres).toBe("11.9");
  });
  it("des totaux qui se contredisent, ou une pièce muette : rien n'est proposé", () => {
    expect(tvaProposee(totaux({ totalHt: r(1, "HT"), conflits: [{ quoi: "HT", champ: "Total HT", valeurs: ["1", "2"], extraits: [] }] })).valeurs).toEqual({});
    expect(tvaProposee(null).valeurs).toEqual({});
    expect(tvaProposee(totaux({})).valeurs).toEqual({});
  });
});
