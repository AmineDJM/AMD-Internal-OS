import { describe, it, expect } from "vitest";
import { attribuer, type PosteDepense } from "./attribution-produit";

/** §85 — direct, alloué, non alloué : jamais mélangés. */

const RAL = "ral", DTG = "dtg", BU = "bu-hiv";
const P = (itemId: string, montant: number, imputations: PosteDepense["imputations"]): PosteDepense => ({ itemId, libelle: itemId, montant, businessUnitId: BU, imputations });

describe("attribution des coûts d'un produit", () => {
  it("§85 — 1 000 direct, 3 000 partagés de BU alloués à 40 % : direct 1 000, alloué 1 200, attribué 2 200, jamais 2 200 « direct »", () => {
    const a = attribuer(RAL, [P("stand-ral", 1000, [{ productId: RAL, pct: 100, montant: null }]), P("congres-bu", 3000, [])], { [BU]: { pct: 40, totalReparti: 40 } });
    expect(a).toMatchObject({ direct: 1000, alloue: 1200, attribue: 2200, nonAlloueBu: 1800 });
    expect(a.lignes.map((l) => l.nature)).toEqual(["DIRECT", "ALLOUE_BU"]);
  });
  it("un poste partagé entre produits est ALLOUÉ, pas direct", () => {
    const a = attribuer(RAL, [P("symposium", 2000, [{ productId: RAL, pct: 60, montant: null }, { productId: DTG, pct: 40, montant: null }])], {});
    expect(a).toMatchObject({ direct: 0, alloue: 1200 });
  });
  it("sans règle de répartition, le coût de BU reste NON ALLOUÉ ; une imputation sans part est signalée", () => {
    const a = attribuer(RAL, [P("congres-bu", 3000, []), P("flou", 500, [{ productId: RAL, pct: null, montant: null }])], {});
    expect(a).toMatchObject({ direct: 0, alloue: 0, nonAlloueBu: 3000 });
    expect(a.limites.join(" ")).toMatch(/sans part ni montant/);
  });
  it("un montant saisi directement l'emporte sur la part", () => {
    expect(attribuer(RAL, [P("x", 1000, [{ productId: RAL, pct: 50, montant: 300 }])], {}).direct).toBe(300);
  });
});
