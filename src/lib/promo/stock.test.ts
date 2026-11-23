import { describe, it, expect } from "vitest";
import {
  allouer, cleProduits, etatValidite, libelleArticleStock, lireDateJour, natureDuTransfert, ordreDeSortie, parseQuantity,
  lireRepartition, repartirReception, stockLevel, JOURS_ALERTE_VALIDITE, type LotDisponible,
} from "./stock";

/**
 * LE STOCK PROMOTIONNEL, RÈGLES PURES (§118.164) — lots, validité, ordre de sortie, réception en
 * partie. Le registre ne stocke que des MOUVEMENTS ; ces règles disent lesquels écrire.
 */

const jour = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const lot = (numero: number, solde: number, fin: string | null, recu = "2026-01-01"): LotDisponible =>
  ({ lotId: `L${numero}`, numero, solde, valableJusquau: fin ? jour(fin) : null, recuLe: jour(recu) });

describe("Une quantité saisie à la main", () => {
  it("lit la virgule française et les espaces, refuse ce qui n'est pas un nombre", () => {
    expect(parseQuantity("1 200,5")).toBe(1200.5);
    expect(parseQuantity("")).toBeNull();
    expect(parseQuantity("douze")).toBeNull();
    expect(parseQuantity(Number.NaN)).toBeNull();
  });
});

describe("Signaler AVANT la rupture", () => {
  it("distingue rupture, stock bas et disponible ; sans seuil, seule la rupture crie", () => {
    expect(stockLevel(0, 50)).toBe("OUT");
    expect(stockLevel(40, 50)).toBe("LOW");
    expect(stockLevel(60, 50)).toBe("OK");
    expect(stockLevel(3, null)).toBe("OK");
    expect(stockLevel(-2, null), "un solde négatif se lit comme une rupture, pas comme un stock").toBe("OUT");
  });
});

describe("L'identité d'un article de stock", () => {
  it("l'ordre de saisie des produits ne compte pas — « A + B » et « B + A » sont le même article", () => {
    expect(cleProduits(["b", "a", "a", " "])).toBe("a,b");
    expect(cleProduits(["a", "b"])).toBe(cleProduits(["b", "a"]));
    expect(cleProduits([])).toBe("");
  });

  it("le libellé nomme les produits, ou se tait quand il n'y en a pas", () => {
    expect(libelleArticleStock("Fiche posologique", ["Nivolex", "Trastuzex"])).toBe("Fiche posologique — Nivolex, Trastuzex");
    expect(libelleArticleStock("Stylo", [])).toBe("Stylo");
  });
});

describe("La nature d'un transfert se DÉDUIT de ses deux bouts", () => {
  it("dotation, transfert, retour — et rien quand ce n'est pas un transfert", () => {
    expect(natureDuTransfert(null, "u1")).toBe("DOTATION");
    expect(natureDuTransfert("u1", "u2")).toBe("TRANSFERT");
    expect(natureDuTransfert("u1", null)).toBe("RETOUR");
    expect(natureDuTransfert(null, null), "du magasin au magasin").toBeNull();
    expect(natureDuTransfert("u1", "u1"), "de soi à soi").toBeNull();
  });
});

describe("La validité d'un lot", () => {
  const maintenant = jour("2026-10-01");

  it("est INCLUSIVE : valable jusqu'au 1er octobre, il se distribue encore le 1er", () => {
    expect(etatValidite(jour("2026-10-01"), new Date("2026-10-01T23:59:00.000Z"))).toBe("BIENTOT");
    expect(etatValidite(jour("2026-10-01"), jour("2026-10-02"))).toBe("PERIME");
  });

  it("prévient dans les trente jours, et pas avant", () => {
    expect(JOURS_ALERTE_VALIDITE).toBe(30);
    expect(etatValidite(jour("2026-10-20"), maintenant)).toBe("BIENTOT");
    expect(etatValidite(jour("2026-12-31"), maintenant)).toBe("VALIDE");
    expect(etatValidite(null, maintenant)).toBe("SANS_DATE");
  });

  it("une date saisie se lit en jour UTC, et le 31 février n'existe pas", () => {
    expect(lireDateJour("2026-12-31")?.toISOString()).toBe("2026-12-31T00:00:00.000Z");
    expect(lireDateJour("2026-02-31"), "Date.UTC le ferait glisser au 3 mars en silence").toBeNull();
    expect(lireDateJour("31/12/2026")).toBeNull();
    expect(lireDateJour("")).toBeNull();
  });
});

describe("L'ordre de sortie — le plus tôt périmé d'abord, et il est TOTAL", () => {
  it("date de fin, puis ancienneté, puis numéro ; un lot sans date passe après", () => {
    const lots = [lot(3, 5, null), lot(2, 5, "2027-06-30", "2026-03-01"), lot(1, 5, "2027-06-30", "2026-02-01"), lot(4, 5, "2026-12-31")];
    expect([...lots].sort(ordreDeSortie).map((l) => l.numero)).toEqual([4, 1, 2, 3]);
    expect([...lots].reverse().sort(ordreDeSortie).map((l) => l.numero), "deux ordres d'entrée, une seule sortie").toEqual([4, 1, 2, 3]);
  });
});

describe("Allouer une sortie", () => {
  const maintenant = jour("2026-10-01");
  const lots = [lot(1, 10, "2026-09-30"), lot(2, 20, "2026-12-31"), lot(3, 30, null)];

  it("une distribution ne prend JAMAIS un lot périmé, et prend le plus tôt périmé d'abord", () => {
    const a = allouer(lots, 25, { maintenant, inclurePerimes: false });
    expect(a).toEqual({ ok: true, tranches: [{ lotId: "L2", quantite: 20 }, { lotId: "L3", quantite: 5 }] });
  });

  it("le refus sépare ce qui MANQUE de ce qui existe mais ne se distribue plus", () => {
    const a = allouer(lots, 55, { maintenant, inclurePerimes: false });
    expect(a.ok).toBe(false);
    if (a.ok) return;
    expect(a.disponible).toBe(50);
    expect(a.bloqueParPeremption).toBe(10);
    expect(a.raison).toMatch(/50 de distribuable/);
    expect(a.raison).toMatch(/lot périmé/);
  });

  it("une PERTE prend le lot périmé en premier : c'est ainsi qu'on le déclare détruit", () => {
    const a = allouer(lots, 12, { maintenant, inclurePerimes: true });
    expect(a).toEqual({ ok: true, tranches: [{ lotId: "L1", quantite: 10 }, { lotId: "L2", quantite: 2 }] });
  });

  it("refuse une quantité nulle ou négative, et vide exactement le stock quand on le demande", () => {
    expect(allouer(lots, 0, { maintenant, inclurePerimes: false }).ok).toBe(false);
    expect(allouer(lots, -5, { maintenant, inclurePerimes: false }).ok, "une quantité négative n'est pas une sortie de 5").toBe(false);
    expect(allouer(lots, 50, { maintenant, inclurePerimes: false }).ok).toBe(true);
  });
});

describe("Une réception confirmée en partie", () => {
  it("le reçu suit l'ordre de sortie ; le reste est MANQUANT, lot par lot", () => {
    const r = repartirReception([{ lotId: "L2", quantite: 20 }, { lotId: "L3", quantite: 10 }], 25);
    expect(r.recues).toEqual([{ lotId: "L2", quantite: 20 }, { lotId: "L3", quantite: 5 }]);
    expect(r.manquantes).toEqual([{ lotId: "L3", quantite: 5 }]);
  });

  it("tout reçu : rien de manquant ; rien reçu : tout manque", () => {
    expect(repartirReception([{ lotId: "L1", quantite: 8 }], 8).manquantes).toEqual([]);
    expect(repartirReception([{ lotId: "L1", quantite: 8 }], 0).recues).toEqual([]);
  });
});

describe("Répartir un article entre plusieurs personnes (Direction, 23/11/2026)", () => {
  it("ignore les lignes vides ou à zéro, lit la virgule, et totalise le reste", () => {
    const r = lireRepartition([
      { versId: "k1", quantite: "10" }, { versId: "k2", quantite: "" }, { versId: "k3", quantite: "0" },
      { versId: "k4", quantite: "12,5" }, { versId: "k5", quantite: " " },
    ]);
    expect(r).toEqual({ ok: true, lignes: [{ versId: "k1", quantite: 10 }, { versId: "k4", quantite: 12.5 }], total: 22.5 });
  });

  it("refuse TOUT sur une quantité illisible ou négative, une personne nommée deux fois, ou rien à répartir", () => {
    expect(lireRepartition([{ versId: "k1", quantite: "10" }, { versId: "k2", quantite: "dix" }]).ok).toBe(false);
    expect(lireRepartition([{ versId: "k1", quantite: "-3" }]).ok, "une quantité négative n'est pas une ligne à zéro").toBe(false);
    const double = lireRepartition([{ versId: "k1", quantite: "4" }, { versId: "k1", quantite: "6" }]);
    expect(double.ok).toBe(false);
    if (!double.ok) expect(double.error).toMatch(/deux fois/);
    const rien = lireRepartition([{ versId: "k1", quantite: "0" }, { versId: "k2", quantite: "" }]);
    expect(rien.ok).toBe(false);
    if (!rien.ok) expect(rien.error).toMatch(/Rien à répartir/);
  });
});
