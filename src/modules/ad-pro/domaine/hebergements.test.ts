import { describe, it, expect } from "vitest";
import {
  NATURES_A_HEBERGEMENTS, porteDesHebergements, lireHebergement, nuitsDe, nuitsLisibles, ligneHebergement, changementsHebergement,
  refusFichesPersonnes, refusChangementNatureFiches, TYPES_CHAMBRE, type HebergementLu,
} from "./hebergements";
import { porteDesVoyageurs } from "./voyageurs";

/**
 * LES FICHES HÔTELLERIE D'UN POSTE (Direction, 06/10) — « une fiche hôtellerie pour chaque personne ;
 * en sponsoring indirect, les fiches hôtellerie et voyageur par personne ne sont pas obligatoires ».
 */
const lu = (h: Partial<HebergementLu> = {}): HebergementLu => ({
  nom: "Haddad", prenom: "Amel", hotel: "Sheraton", ville: "Oran", dateArrivee: new Date("2026-11-12T00:00:00Z"),
  dateDepart: new Date("2026-11-15T00:00:00Z"), typeChambre: "Single", notes: null, ...h,
});

describe("une fiche hôtellerie", () => {
  it("seule l'hôtellerie porte des fiches hôtellerie — et la billetterie garde ses voyageurs", () => {
    expect([...NATURES_A_HEBERGEMENTS]).toEqual(["ACCOMMODATION"]);
    expect(porteDesHebergements("ACCOMMODATION")).toBe(true);
    expect(porteDesHebergements("TICKETING")).toBe(false);
    expect(porteDesHebergements("STAND")).toBe(false);
    expect(porteDesVoyageurs("ACCOMMODATION")).toBe(false);
    expect(TYPES_CHAMBRE).toContain("Double");
  });

  it("un NOM suffit ; le reste est facultatif", () => {
    const r = lireHebergement({ nom: "  Haddad " });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.hebergement).toMatchObject({ nom: "Haddad", prenom: null, hotel: null, dateArrivee: null, dateDepart: null });
  });

  it("sans nom, ou avec une date illisible ou impossible : tout est dit en une fois", () => {
    const r = lireHebergement({ nom: "", dateArrivee: "12/11/2026", dateDepart: "2026-02-31" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/nom de famille/);
    expect(r.error).toMatch(/date d'arrivée lisible/);
    expect(r.error).toMatch(/date de départ lisible/);
  });

  it("le départ ne précède pas l'arrivée ; le même jour est permis (0 nuit)", () => {
    const inverse = lireHebergement({ nom: "X", dateArrivee: "2026-11-15", dateDepart: "2026-11-12" });
    expect(inverse.ok === false ? inverse.error : "").toMatch(/précède/);
    const memeJour = lireHebergement({ nom: "X", dateArrivee: "2026-11-15", dateDepart: "2026-11-15" });
    expect(memeJour.ok).toBe(true);
    if (memeJour.ok) expect(nuitsDe(memeJour.hebergement)).toBe(0);
  });

  it("les nuits se DÉRIVENT des dates ; une date manquante se lit « à confirmer »", () => {
    expect(nuitsDe(lu())).toBe(3);
    expect(nuitsLisibles(lu())).toBe("3 nuits");
    expect(nuitsLisibles(lu({ dateDepart: new Date("2026-11-13T00:00:00Z") }))).toBe("1 nuit");
    expect(nuitsDe(lu({ dateDepart: null }))).toBeNull();
    expect(nuitsLisibles(lu({ dateArrivee: null }))).toBe("nuits à confirmer");
  });

  it("la ligne lue dit la personne, l'hôtel, les dates, les nuits, la chambre", () => {
    const l = ligneHebergement({ ...lu(), pieceIdentite: true });
    expect(l).toContain("Amel Haddad");
    expect(l).toContain("Sheraton, Oran");
    expect(l).toContain("du 12/11/2026 au 15/11/2026 (3 nuits)");
    expect(l).toContain("chambre Single");
    expect(l).toContain("pièce d'identité jointe");
    expect(ligneHebergement(lu({ hotel: null, ville: null }))).toContain("hôtel à confirmer");
  });

  it("les changements se nomment ; un enregistrement à l'identique n'en a aucun", () => {
    expect(changementsHebergement(lu(), lu())).toEqual([]);
    const c = changementsHebergement(lu(), lu({ hotel: "Ibis", dateDepart: new Date("2026-11-16T00:00:00Z") }));
    expect(c).toEqual(["hôtel : Sheraton → Ibis", "départ : 15/11/2026 → 16/11/2026"]);
  });
});

describe("une fiche par personne avant de soumettre", () => {
  it("billetterie sans voyageur, hôtellerie sans fiche : refusées — avec la phrase qui dit quoi faire", () => {
    expect(refusFichesPersonnes({ kind: "TICKETING", fichesPersonnes: 0 })).toMatch(/au moins un voyageur/);
    expect(refusFichesPersonnes({ kind: "ACCOMMODATION", fichesPersonnes: 0 })).toMatch(/au moins une fiche hôtellerie/);
    expect(refusFichesPersonnes({ kind: "ACCOMMODATION", fichesPersonnes: 1 })).toBeNull();
  });

  it("en sponsoring INDIRECT, les fiches ne sont pas obligatoires", () => {
    expect(refusFichesPersonnes({ kind: "TICKETING", fichesPersonnes: 0, priseEnChargeIndirecte: true })).toBeNull();
    expect(refusFichesPersonnes({ kind: "ACCOMMODATION", fichesPersonnes: 0, priseEnChargeIndirecte: true })).toBeNull();
  });

  it("une autre nature n'en demande pas ; un compte inconnu ne refuse pas sur un trou", () => {
    expect(refusFichesPersonnes({ kind: "DINNER", fichesPersonnes: 0 })).toBeNull();
    expect(refusFichesPersonnes({ kind: "TICKETING" })).toBeNull();
  });
});

describe("changer la nature d'un poste qui porte des fiches", () => {
  it("refusé tant que des voyageurs ou des fiches hôtellerie existent — permis sinon", () => {
    expect(refusChangementNatureFiches("TICKETING", "DINNER", { voyageurs: 2, hebergements: 0 })).toMatch(/2 voyageurs/);
    expect(refusChangementNatureFiches("ACCOMMODATION", "TICKETING", { voyageurs: 0, hebergements: 1 })).toMatch(/1 fiche hôtellerie/);
    expect(refusChangementNatureFiches("TICKETING", "DINNER", { voyageurs: 0, hebergements: 0 })).toBeNull();
    expect(refusChangementNatureFiches("STAND", "DINNER", { voyageurs: 0, hebergements: 0 })).toBeNull();
    expect(refusChangementNatureFiches("TICKETING", "TICKETING", { voyageurs: 3, hebergements: 0 })).toBeNull();
  });
});
