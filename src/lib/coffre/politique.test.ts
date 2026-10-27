import { describe, expect, it } from "vitest";
import { NATURES_COFFRE, type NatureCoffre } from "./natures";
import { peutLire, type LecteurCoffre, type TitulaireCoffre } from "./politique";

const u = (o: Partial<Extract<LecteurCoffre, { genre: "UTILISATEUR" }>> = {}): LecteurCoffre => ({
  genre: "UTILISATEUR", userId: "u-lecteur", superAdmin: false, tientRH: false, tientFinances: false, ...o,
});
const personne: TitulaireCoffre = { genre: "PERSONNE", personneId: "p1", userId: "u-titulaire" };
const sansCompte: TitulaireCoffre = { genre: "PERSONNE", personneId: "p2", userId: null };
const fournisseur: TitulaireCoffre = { genre: "ORGANISATION", organisationId: "o1" };
const RH: NatureCoffre[] = ["NIN", "PASSEPORT_NUMERO", "PASSEPORT_EXPIRATION", "CNI_NUMERO", "SALAIRE"];
const FIN: NatureCoffre[] = ["IBAN", "RIB"];

describe("peutLire — décisions de la Direction", () => {
  it("un modèle d'IA ne lit JAMAIS, quelle que soit la nature ou le titulaire", () => {
    for (const n of NATURES_COFFRE) {
      for (const t of [personne, sansCompte, fournisseur]) {
        const d = peutLire({ genre: "IA", nom: "assistant" }, n, t);
        expect(d.autorise).toBe(false);
        if (!d.autorise) expect(d.motif).toBe("MODELE_IA");
      }
    }
  });

  it("le Super Admin lit tout ce qui existe", () => {
    for (const n of NATURES_COFFRE) expect(peutLire(u({ superAdmin: true }), n, personne)).toEqual({ autorise: true, motif: "SUPER_ADMIN" });
    for (const n of FIN) expect(peutLire(u({ superAdmin: true }), n, fournisseur).autorise).toBe(true);
  });

  it("la personne lit les siennes, toutes natures", () => {
    for (const n of NATURES_COFFRE) expect(peutLire(u({ userId: "u-titulaire" }), n, personne)).toEqual({ autorise: true, motif: "TITULAIRE" });
  });

  it("…mais pas celles d'une autre personne", () => {
    for (const n of NATURES_COFFRE) expect(peutLire(u(), n, personne).autorise).toBe(false);
  });

  it("une fiche sans compte n'ouvre rien à un lecteur quelconque (userId null ≠ titulaire)", () => {
    expect(peutLire(u({ userId: "" }), "NIN", sansCompte).autorise).toBe(false);
  });

  it("les RH lisent salaires, NIN et pièces d'identité, pas les RIB/IBAN", () => {
    for (const n of RH) expect(peutLire(u({ tientRH: true }), n, personne)).toEqual({ autorise: true, motif: "RH" });
    for (const n of FIN) expect(peutLire(u({ tientRH: true }), n, personne).autorise).toBe(false);
  });

  it("les Finances lisent RIB et IBAN (collaborateurs et organisations), pas les salaires ni les pièces", () => {
    for (const n of FIN) {
      expect(peutLire(u({ tientFinances: true }), n, personne)).toEqual({ autorise: true, motif: "FINANCES" });
      expect(peutLire(u({ tientFinances: true }), n, fournisseur)).toEqual({ autorise: true, motif: "FINANCES" });
    }
    for (const n of RH) expect(peutLire(u({ tientFinances: true }), n, personne).autorise).toBe(false);
  });

  it("une organisation n'a ni salaire, ni NIN, ni pièce : refus de nature, même au Super Admin", () => {
    for (const n of RH) {
      const d = peutLire(u({ superAdmin: true }), n, fournisseur);
      expect(d.autorise).toBe(false);
      if (!d.autorise) expect(d.motif).toBe("NATURE_INCOMPATIBLE");
    }
  });

  it("un refus dit pourquoi, en français", () => {
    const d = peutLire(u(), "SALAIRE", personne);
    expect(d).toMatchObject({ autorise: false, motif: "HORS_PERIMETRE" });
    if (!d.autorise) expect(d.raison).toMatch(/RH/);
    const f = peutLire(u(), "RIB", fournisseur);
    if (!f.autorise) expect(f.raison).toMatch(/Finances/);
  });
});
