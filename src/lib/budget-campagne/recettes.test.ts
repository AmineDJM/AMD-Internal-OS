import { describe, expect, it } from "vitest";
import {
  CLIENT_PAR_DEFAUT, calculerMontantRecette, cleRapprochementRecette, droitsRecettes, normaliserClient, rapprocherAuRealise,
  repartirSurDouzeMois, totauxRecettes, verdictSaisieRecettes,
} from "./recettes";

describe("recettes prévues — droits", () => {
  it("seuls le Super Admin et la DG saisissent ; une direction qui accède à la campagne lit ; les autres rien", () => {
    expect(droitsRecettes({ estSuperAdmin: true, estDG: false, accedeALaCampagne: false })).toEqual({ voit: true, saisit: true, voitSynthese: true });
    expect(droitsRecettes({ estSuperAdmin: false, estDG: true, accedeALaCampagne: true })).toEqual({ voit: true, saisit: true, voitSynthese: true });
    expect(droitsRecettes({ estSuperAdmin: false, estDG: false, accedeALaCampagne: true })).toEqual({ voit: true, saisit: false, voitSynthese: false });
    expect(droitsRecettes({ estSuperAdmin: false, estDG: false, accedeALaCampagne: false }).voit).toBe(false);
  });

  it("le refus dit le remède ; une campagne close fige les recettes", () => {
    const directeur = droitsRecettes({ estSuperAdmin: false, estDG: false, accedeALaCampagne: true });
    const v = verdictSaisieRecettes({ droits: directeur, figeesLe: null });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.raison).toMatch(/Super Admin et la Direction générale/);
    const dg = droitsRecettes({ estSuperAdmin: false, estDG: true, accedeALaCampagne: true });
    expect(verdictSaisieRecettes({ droits: dg, figeesLe: null }).ok).toBe(true);
    expect(verdictSaisieRecettes({ droits: dg, figeesLe: new Date() }).ok).toBe(false);
  });
});

describe("recettes prévues — la ligne", () => {
  it("quantité × prix quand les deux sont là, sinon montant direct, sinon un refus qui dit quoi faire", () => {
    expect(calculerMontantRecette({ quantite: 1000, prixUnitaire: 1234.5, montant: 99 })).toEqual({ ok: true, montant: 1234500, quantite: 1000, prixUnitaire: 1234.5 });
    expect(calculerMontantRecette({ quantite: null, prixUnitaire: null, montant: 5000000 })).toMatchObject({ ok: true, montant: 5000000 });
    const sansPrix = calculerMontantRecette({ quantite: 10, prixUnitaire: null, montant: null });
    expect(sansPrix.ok).toBe(false);
    if (!sansPrix.ok) expect(sansPrix.raison).toMatch(/prix unitaire/);
    expect(calculerMontantRecette({ quantite: null, prixUnitaire: null, montant: null }).ok).toBe(false);
    expect(calculerMontantRecette({ quantite: -1, prixUnitaire: 10, montant: null }).ok).toBe(false);
  });

  it("le client par défaut est la PCH", () => {
    expect(CLIENT_PAR_DEFAUT).toBe("PCH");
    expect(normaliserClient("  ")).toBe("PCH");
    expect(normaliserClient(" Clinique  X ")).toBe("Clinique X");
  });

  it("la clé de rapprochement : société | année-mois | produit (sinon BU, sinon libellé) | client", () => {
    expect(cleRapprochementRecette({ companyId: "c1", annee: 2027, mois: 3, productId: "p1", businessUnitId: "bu1" })).toBe("c1|2027-03|P:p1|pch");
    expect(cleRapprochementRecette({ companyId: "c1", annee: 2027, mois: 11, businessUnitId: "bu1", client: "PCH" })).toBe("c1|2027-11|BU:bu1|pch");
    expect(cleRapprochementRecette({ companyId: "c1", annee: 2027, mois: 1, label: "Prestations  Études", client: "Clinique É" })).toBe("c1|2027-01|L:prestations etudes|clinique e");
  });

  it("répartir sur douze mois ne perd ni ne crée un centime", () => {
    const m = repartirSurDouzeMois(1000);
    expect(m).toHaveLength(12);
    expect(m[0]).toBe(83.33);
    expect(Math.round(m.reduce((a, x) => a + x, 0) * 100)).toBe(100000);
  });
});

describe("recettes prévues — agrégats et rapprochement", () => {
  it("totalise par société et par mois, et par produit / BU", () => {
    const t = totauxRecettes([
      { companyId: "A", mois: 1, montant: 100, productId: "p1", label: "Nivo" },
      { companyId: "A", mois: 1, montant: 50, productId: "p1", label: "Nivo" },
      { companyId: "A", mois: 2, montant: 30, businessUnitId: "bu", label: "Onco" },
      { companyId: "B", mois: 12, montant: 7, label: "Divers" },
      { companyId: "B", mois: 13, montant: 999, label: "hors année" },
    ]);
    expect(t.total).toBe(187);
    expect(t.parSociete.A!.mois.slice(0, 2)).toEqual([150, 30]);
    expect(t.parSociete.B!.total).toBe(7);
    expect(t.parObjet.find((o) => o.objet === "P:p1")!.total).toBe(150);
  });

  it("le prévu rejoint le réalisé par la clé ; une clé d'un seul côté reste visible", () => {
    const r = rapprocherAuRealise([{ cle: "k1", montant: 100 }, { cle: "k2", montant: 40 }], [{ cle: "k1", montant: 90 }, { cle: "k3", montant: 5 }]);
    expect(r).toEqual([
      { cle: "k1", prevu: 100, realise: 90, ecart: -10 },
      { cle: "k2", prevu: 40, realise: 0, ecart: -40 },
      { cle: "k3", prevu: 0, realise: 5, ecart: 5 },
    ]);
  });
});
