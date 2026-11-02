import { describe, expect, it } from "vitest";
import { etatA, fermeture, histoire, tenuA, type FaitDate } from "./faits-dates";
import { chiffresSansSource, compterChiffres } from "./sources";

const d = (s: string) => new Date(s);
const f = (o: Partial<FaitDate> & Pick<FaitDate, "id" | "valeur">): FaitDate => ({
  attribut: "organisation.raisonSociale", valideDu: null, valideAu: null, confirmeLe: d("2026-01-01"), fermeLe: null, source: "PIECE", pieceId: null, confirmeParId: null, ...o,
});

// Saidal SARL du 1er janvier au 1er mai (fermé le 10 mai, saisie tardive), puis Saidal SPA.
const FAITS = [
  f({ id: "a", valeur: "Saidal SARL", valideDu: d("2026-01-01"), valideAu: d("2026-05-01"), confirmeLe: d("2026-01-02"), fermeLe: d("2026-05-10") }),
  f({ id: "b", valeur: "Saidal SPA", valideDu: d("2026-05-01"), confirmeLe: d("2026-05-10") }),
  f({ id: "c", attribut: "organisation.capital", valeur: "1000000", valideDu: d("2026-03-01"), confirmeLe: d("2026-03-01") }),
];

describe("faits bitemporels", () => {
  it("l'état à une date : la valeur d'alors, jamais celle d'aujourd'hui", () => {
    const e = etatA(FAITS, d("2026-02-01"));
    expect(e.valeurs.map((v) => [v.attribut, v.valeurs[0]!.valeur])).toEqual([["organisation.raisonSociale", "Saidal SARL"]]);
    expect(e.inconnus).toEqual(["organisation.capital"]);
    expect(etatA(FAITS, d("2026-06-01")).valeurs.find((v) => v.attribut === "organisation.raisonSociale")!.valeurs[0]!.valeur).toBe("Saidal SPA");
  });

  it("ce qu'on savait à une date (temps de constat) : la fermeture tardive n'était pas encore connue", () => {
    const e = etatA(FAITS, d("2026-05-05"), { connuLe: d("2026-05-06") });
    expect(e.valeurs.find((v) => v.attribut === "organisation.raisonSociale")!.valeurs.map((v) => v.valeur)).toEqual(["Saidal SARL"]);
    expect(tenuA(FAITS[0]!, d("2026-05-06"))).toBe(true);
    expect(tenuA(FAITS[0]!, d("2026-05-11"))).toBe(false);
  });

  it("l'histoire garde tout ; la fermeture n'efface rien", () => {
    expect(histoire(FAITS, "organisation.raisonSociale").map((x) => x.id)).toEqual(["a", "b"]);
    const m = d("2026-05-10");
    expect(fermeture({ maintenant: m, parId: "u", remplaceParId: "b", finDeValidite: d("2026-05-01") }))
      .toEqual({ actif: false, valideAu: d("2026-05-01"), fermeLe: m, fermeParId: "u", remplaceParId: "b" });
  });
});

describe("chaque chiffre porte sa source", () => {
  it("repère une valeur chiffrée sans source, ignore meta", () => {
    expect(chiffresSansSource({ meta: { profondeur: 2 }, faits: [{ valeur: "1000000", source: "PIECE · Piece#x" }] })).toEqual([]);
    expect(chiffresSansSource({ faits: [{ valeur: "1000000" }] })).toEqual(["faits[0].valeur"]);
    expect(chiffresSansSource({ source: "racine", valeur: 12 })).toEqual(["valeur"]);
    expect(compterChiffres({ a: [{ v: 3, source: "s" }, { v: "x" }] })).toEqual({ total: 1, sourcees: 1 });
  });
});
