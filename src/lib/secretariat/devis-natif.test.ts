import { describe, expect, it } from "vitest";
import {
  lireDevisNatif, validerSaisie, appliquerSaisie, appliquerRetenue, bcsAGenerer, refusEditionDevis, refusFinBCEnRoute,
  totauxDesLignes, tvaParDefaut, enLignesCommerciales, etapeBCAttendue, cleFournisseur, LIBELLE_BC_DEMANDE, type DevisNatif,
} from "./devis-natif";

let n = 0;
const meta = { par: "asst", le: "2026-10-14T10:00:00.000Z", nouvelId: () => `L${++n}` };

function devis(fournisseurId: string | null, fournisseur: string, lignes: { designation: string; quantite: number; prixUnitaire: number; tva?: number }[]): DevisNatif {
  const v = validerSaisie(lignes.map((l) => ({ ...l, tva: l.tva ?? 19 })));
  if (!v.ok) throw new Error(v.error);
  return appliquerSaisie(null, { fournisseurId, fournisseur, date: "2026-10-08", lignes: v.lignes }, meta).devis;
}

describe("devis natif — la retranscription", () => {
  it("valide une saisie : rangée vide ignorée, rangée commencée complète, TVA admise seulement", () => {
    const ok = validerSaisie([
      { designation: "Ramette A4", reference: "R-80", quantite: "10", prixUnitaire: "650,50", tva: "19" },
      { designation: "", reference: "", quantite: "", prixUnitaire: "", tva: "19" },
    ]);
    expect(ok).toMatchObject({ ok: true, lignes: [{ designation: "Ramette A4", reference: "R-80", quantite: 10, prixUnitaire: 650.5, tva: 19 }] });
    expect(validerSaisie([{ designation: "Toner", quantite: "0", prixUnitaire: "100", tva: "19" }])).toMatchObject({ ok: false });
    expect(validerSaisie([{ designation: "", quantite: "2", prixUnitaire: "100", tva: "19" }])).toMatchObject({ ok: false, error: expect.stringMatching(/désignation/) });
    expect(validerSaisie([{ designation: "Toner", quantite: "2", prixUnitaire: "100", tva: "7" }])).toMatchObject({ ok: false, error: expect.stringMatching(/0, 9 ou 19/) });
    expect(validerSaisie([])).toMatchObject({ ok: false });
  });

  it("lit et relit `custom.devisNatif` sans rien deviner — une ligne illisible est écartée", () => {
    const d = devis("c1", "Imprimerie Atlas", [{ designation: "Fiche A4", quantite: 500, prixUnitaire: 12 }]);
    const relu = lireDevisNatif({ fabrique: { x: 1 }, devisNatif: JSON.parse(JSON.stringify(d)) });
    expect(relu).toEqual(d);
    expect(lireDevisNatif({ devisNatif: { version: 2, fournisseur: "X", lignes: [{ id: "a", designation: "ok", quantite: 1, prixUnitaire: 1, tva: 19 }, { id: "b", quantite: 1 }] } })?.lignes.map((l) => l.id)).toEqual(["a"]);
    expect(lireDevisNatif(null)).toBeNull();
    expect(lireDevisNatif({ fabrique: {} })).toBeNull();
  });

  it("une ligne corrigée perd sa retenue (le demandeur avait retenu l'ancien prix) ; une ligne intacte la garde", () => {
    const d = devis("c1", "Atlas", [{ designation: "A", quantite: 1, prixUnitaire: 100 }, { designation: "B", quantite: 2, prixUnitaire: 50 }]);
    const r = appliquerRetenue(d, new Set(d.lignes.map((l) => l.id)), new Set(), { par: "dem", le: "x" });
    if (!r.ok) throw new Error(r.error);
    const [a, b] = r.devis.lignes;
    const s = appliquerSaisie(r.devis, { fournisseurId: "c1", fournisseur: "Atlas", date: null, lignes: [
      { id: a.id, designation: "A", reference: null, quantite: 1, prixUnitaire: 120, tva: 19 },
      { id: b.id, designation: "B", reference: null, quantite: 2, prixUnitaire: 50, tva: 19 },
      { id: null, designation: "C", reference: null, quantite: 1, prixUnitaire: 10, tva: 9 },
    ] }, meta);
    expect(s.retenuesPerdues).toBe(1);
    expect(s.devis.lignes.map((l) => [l.designation, l.retenue])).toEqual([["A", false], ["B", true], ["C", false]]);
    expect(s.devis.version).toBe(r.devis.version + 1);
    expect(new Set(s.devis.lignes.map((l) => l.id)).size).toBe(3);
  });

  it("totaux HT / TVA / TTC, ligne par ligne avec son taux", () => {
    expect(totauxDesLignes([{ quantite: 10, prixUnitaire: 100, tva: 19 }, { quantite: 1, prixUnitaire: 200, tva: 0 }])).toEqual({ ht: 1200, tva: 190, ttc: 1390 });
    expect(enLignesCommerciales([{ id: "x", designation: "A", reference: "R", quantite: 2, prixUnitaire: 5, tva: 9, retenue: true, retenueLe: null, retenuePar: null, bcId: null }]))
      .toEqual([{ designation: "A", reference: "R", quantite: 2, prixUnitaire: 5, tva: 0.09 }]);
    expect(tvaParDefaut([{ quantite: 1, prixUnitaire: 10, tva: 9 }, { quantite: 10, prixUnitaire: 100, tva: 19 }])).toBe(0.19);
  });
});

describe("devis natif — le demandeur retient, un BC par fournisseur", () => {
  it("retenir : l'ensemble envoyé remplace le précédent ; une ligne inconnue est refusée", () => {
    const d = devis("c1", "Atlas", [{ designation: "A", quantite: 1, prixUnitaire: 100 }, { designation: "B", quantite: 1, prixUnitaire: 50 }]);
    const r = appliquerRetenue(d, new Set([d.lignes[0].id]), new Set(), { par: "dem", le: "le" });
    expect(r).toMatchObject({ ok: true, changees: 1 });
    if (!r.ok) return;
    expect(r.devis.lignes.map((l) => l.retenue)).toEqual([true, false]);
    expect(r.devis.lignes[0]).toMatchObject({ retenuePar: "dem", retenueLe: "le" });
    const r2 = appliquerRetenue(r.devis, new Set([d.lignes[1].id]), new Set(), { par: "dem", le: "le" });
    expect(r2.ok && r2.devis.lignes.map((l) => l.retenue)).toEqual([false, true]);
    expect(appliquerRetenue(d, new Set(["inconnue"]), new Set(), { par: "dem", le: "le" })).toMatchObject({ ok: false });
    expect(appliquerRetenue(r.devis, new Set([d.lignes[0].id]), new Set(), { par: "dem", le: "le" })).toMatchObject({ ok: true, changees: 0 });
  });

  it("une ligne déjà commandée par un BC en vie ne se décoche plus, et fige la retranscription", () => {
    const d = devis("c1", "Atlas", [{ designation: "A", quantite: 1, prixUnitaire: 100 }]);
    const commandee: DevisNatif = { ...d, lignes: d.lignes.map((l) => ({ ...l, retenue: true, bcId: "bc1" })) };
    expect(appliquerRetenue(commandee, new Set(), new Set(["bc1"]), { par: "dem", le: "le" })).toMatchObject({ ok: false, error: expect.stringMatching(/déjà commandée/) });
    expect(refusEditionDevis(commandee, new Set(["bc1"]), new Map([["bc1", "012/DG/2026"]]))).toMatch(/012\/DG\/2026/);
    // Un BC ANNULÉ ne commande plus rien : la ligne redevient libre.
    expect(appliquerRetenue(commandee, new Set(), new Set(), { par: "dem", le: "le" })).toMatchObject({ ok: true, changees: 1 });
    expect(refusEditionDevis(commandee, new Set(), new Map())).toBeNull();
  });

  it("regroupe les lignes retenues PAR FOURNISSEUR, à travers plusieurs devis ; écarte le commandé et l'annulé", () => {
    const retenir = (d: DevisNatif, idx: number[]) => ({ ...d, lignes: d.lignes.map((l, i) => (idx.includes(i) ? { ...l, retenue: true } : l)) });
    const atlas1 = retenir(devis("c-atlas", "Imprimerie Atlas", [{ designation: "Fiche", quantite: 500, prixUnitaire: 12 }, { designation: "Affiche", quantite: 10, prixUnitaire: 300 }]), [0]);
    const atlas2 = retenir(devis("c-atlas", "Imprimerie ATLAS", [{ designation: "Stylo", quantite: 100, prixUnitaire: 40 }]), [0]);
    const nova = retenir(devis(null, "Nova  Print", [{ designation: "Kakémono", quantite: 2, prixUnitaire: 9000, tva: 9 }]), [0]);
    const deja = { ...retenir(devis(null, "Déjà", [{ designation: "X", quantite: 1, prixUnitaire: 1 }]), [0]) };
    deja.lignes = deja.lignes.map((l) => ({ ...l, bcId: "bc-vivant" }));
    const groupes = bcsAGenerer([
      { id: "q1", reference: "26/01", titre: "t", natif: atlas1, annule: false },
      { id: "q2", reference: "26/02", titre: "t", natif: atlas2, annule: false },
      { id: "q3", reference: null, titre: "t", natif: nova, annule: false },
      { id: "q4", reference: null, titre: "t", natif: deja, annule: false },
      { id: "q5", reference: null, titre: "t", natif: retenir(devis("c-z", "Z", [{ designation: "Z", quantite: 1, prixUnitaire: 1 }]), [0]), annule: true },
    ], new Set(["bc-vivant"]));
    expect(groupes.map((g) => g.fournisseur)).toEqual(["Imprimerie Atlas", "Nova  Print"]);
    expect(groupes[0].devis.map((d) => d.id)).toEqual(["q1", "q2"]);
    expect(groupes[0].lignes.map((l) => [l.designation, l.devisId])).toEqual([["Fiche", "q1"], ["Stylo", "q2"]]);
    expect(groupes[0].totaux).toEqual({ ht: 10_000, tva: 1900, ttc: 11_900 });
    expect(groupes[1].totaux.ttc).toBe(19_620);
    expect(cleFournisseur({ fournisseurId: null, fournisseur: "Nova  Print" })).toBe(cleFournisseur({ fournisseurId: null, fournisseur: "nova print" }));
  });
});

describe("le BC lu sur la demande", () => {
  it("« Signé et validé » quand il revient signé ; l'étape la plus en retard est celle qu'on attend", () => {
    expect(LIBELLE_BC_DEMANDE.SIGNE).toBe("Signé et validé");
    expect(etapeBCAttendue([{ etape: "A_SIGNER", annule: false }, { etape: "A_VALIDER", annule: false }])).toBe("A_VALIDER");
    expect(etapeBCAttendue([{ etape: "SIGNE", annule: false }, { etape: "A_VALIDER", annule: true }])).toBeNull();
  });
  it("« Terminer » attend la signature d'un BC en route ; un BC refusé, annulé ou d'avant le circuit ne retient rien", () => {
    expect(refusFinBCEnRoute([{ reference: "012/DG/2026", etape: "A_SIGNER", annule: false }])).toMatch(/012\/DG\/2026.*à signer/);
    expect(refusFinBCEnRoute([{ reference: null, etape: "A_VALIDER", annule: false }])).toMatch(/pas encore signé et validé/);
    expect(refusFinBCEnRoute([{ reference: "a", etape: "SIGNE", annule: false }, { reference: "b", etape: "REFUSE", annule: false }, { reference: "c", etape: "A_SIGNER", annule: true }, { reference: "d", etape: "HORS_CIRCUIT", annule: false }])).toBeNull();
  });
});
