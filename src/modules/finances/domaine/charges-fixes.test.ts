import { describe, expect, it } from "vitest";
import {
  cleEcheance, ecartFacture, echeancesAApparaitre, echeancesEntre, etatEcheance, libellePeriode, lignesPrefillChargesFixes,
  lireSaisieCharge, montantAnnuel, peutDemanderPaiement, peutLibererReserve, previsionChargesFixes, refusSurReserve,
  totauxAnnuelsParNature, type ChargeFixePourCalcul,
} from "./charges-fixes";

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const charge = (p: Partial<ChargeFixePourCalcul> = {}): ChargeFixePourCalcul => ({
  id: "c1", companyId: "s1", nature: "LOYER", site: "Siège", beneficiaire: "SCI Les Pins", modeMontant: "FIXE", montant: 450_000,
  periodicite: "MENSUELLE", jourEcheance: 5, moisEcheance: null, dateDebut: d("2027-01-01"), dateFin: null, echeanceFixe: true, active: true,
  ...p,
});

describe("le montant annuel d'une charge, par périodicité", () => {
  it("mensuelle : douze échéances sur une année pleine", () => {
    expect(montantAnnuel(charge(), 2027)).toBe(12 * 450_000);
  });
  it("mensuelle, début en cours d'année : les échéances qui tombent après le début seulement", () => {
    // Début le 10 mars, échéance le 5 : la première tombe le 5 avril → 9 échéances.
    expect(montantAnnuel(charge({ dateDebut: d("2027-03-10") }), 2027)).toBe(9 * 450_000);
  });
  it("mensuelle, fin de bail : l'échéancier s'arrête à la fin", () => {
    expect(montantAnnuel(charge({ dateFin: d("2027-06-30") }), 2027)).toBe(6 * 450_000);
  });
  it("trimestrielle : quatre échéances, à partir du mois réglé", () => {
    const c = charge({ periodicite: "TRIMESTRIELLE", montant: 90_000, moisEcheance: 2, dateDebut: d("2026-01-01") });
    expect(echeancesEntre(c, d("2027-01-01"), d("2027-12-31")).map((e) => e.periode)).toEqual(["2027-02", "2027-05", "2027-08", "2027-11"]);
    expect(montantAnnuel(c, 2027)).toBe(360_000);
  });
  it("annuelle : une échéance, au mois réglé ; jamais avant le début", () => {
    const c = charge({ periodicite: "ANNUELLE", montant: 1_200_000, moisEcheance: 3, dateDebut: d("2027-06-15") });
    expect(montantAnnuel(c, 2027)).toBe(0);
    expect(echeancesEntre(c, d("2028-01-01"), d("2028-12-31")).map((e) => e.periode)).toEqual(["2028-03"]);
  });
  it("le 31 d'un mois court tombe le dernier jour du mois", () => {
    const e = echeancesEntre(charge({ jourEcheance: 31 }), d("2027-02-01"), d("2027-02-28"));
    expect(e[0].date.toISOString().slice(0, 10)).toBe("2027-02-28");
  });
  it("une charge désactivée n'a aucune échéance", () => {
    expect(montantAnnuel(charge({ active: false }), 2027)).toBe(0);
  });
  it("les totaux par nature additionnent les sites", () => {
    const t = totauxAnnuelsParNature([charge(), charge({ id: "c2", site: "Entrepôt", montant: 100_000 }), charge({ id: "c3", nature: "EAU", montant: 5_000 })], 2027);
    expect(t.get("LOYER")).toBe(12 * 550_000);
    expect(t.get("EAU")).toBe(60_000);
  });
});

describe("les échéances qui apparaissent dans « Aujourd'hui » des Finances", () => {
  const c = charge({ dateDebut: d("2027-01-01") });
  it("quinze jours avant, pas seize", () => {
    expect(echeancesAApparaitre([c], d("2027-03-21"), new Set()).map((e) => e.periode)).toContain("2027-04");
    expect(echeancesAApparaitre([c], d("2027-03-20"), new Set()).map((e) => e.periode)).not.toContain("2027-04");
  });
  it("une échéance passée et jamais demandée reste (en retard) ; une demandée sort", () => {
    const toutes = echeancesAApparaitre([c], d("2027-03-21"), new Set());
    expect(toutes.map((e) => e.periode)).toEqual(["2027-01", "2027-02", "2027-03", "2027-04"]);
    const reste = echeancesAApparaitre([c], d("2027-03-21"), new Set([cleEcheance("c1", "2027-01"), cleEcheance("c1", "2027-02")]));
    expect(reste.map((e) => e.periode)).toEqual(["2027-03", "2027-04"]);
  });
});

describe("l'écart de la facture « selon facture » (> 10 %)", () => {
  it("jusqu'à +10 % : pas d'alerte ; au-delà : alerte rouge avec les deux chiffres", () => {
    expect(ecartFacture({ modeMontant: "SELON_FACTURE", prevu: 100_000, facture: 110_000 })).toBeNull();
    const a = ecartFacture({ modeMontant: "SELON_FACTURE", prevu: 100_000, facture: 110_500 });
    expect(a?.niveau).toBe("BLOQUANT");
    expect(a?.detail).toContain("100");
    expect(a?.detail).toContain("110");
  });
  it("une baisse n'alerte jamais ; un montant fixe dépassé alerte", () => {
    expect(ecartFacture({ modeMontant: "SELON_FACTURE", prevu: 100_000, facture: 60_000 })).toBeNull();
    expect(ecartFacture({ modeMontant: "FIXE", prevu: 450_000, facture: 450_000 })).toBeNull();
    expect(ecartFacture({ modeMontant: "FIXE", prevu: 450_000, facture: 460_000 })?.titre).toBe("Montant au-dessus du montant fixe");
  });
});

describe("la réserve pour imprévus : libérable par le DG ou le Super Admin seulement", () => {
  it("DG et Super Admin (rôle principal ou secondaire) : oui ; Finances, Direction : non", () => {
    expect(peutLibererReserve({ role: "GENERAL_MANAGER" })).toBe(true);
    expect(peutLibererReserve({ role: "SUPER_ADMIN" })).toBe(true);
    expect(peutLibererReserve({ role: "FINANCE_BUDGET_MANAGER", secondaryRole: "GENERAL_MANAGER" })).toBe(true);
    expect(peutLibererReserve({ role: "FINANCE_BUDGET_MANAGER" })).toBe(false);
    expect(peutLibererReserve({ role: "DIRECTION" })).toBe(false);
  });
  it("baisser ou imputer sur la réserve est refusé aux Finances ; la budgéter (monter) reste permis ; les autres lignes ne sont pas concernées", () => {
    const fin = { role: "FINANCE_BUDGET_MANAGER" };
    expect(refusSurReserve({ cle: "RESERVE_IMPREVUS", geste: "BAISSER", user: fin })).toMatch(/Directeur général/);
    expect(refusSurReserve({ cle: "RESERVE_IMPREVUS", geste: "IMPUTER", user: fin })).not.toBeNull();
    expect(refusSurReserve({ cle: "RESERVE_IMPREVUS", geste: "MONTER", user: fin })).toBeNull();
    expect(refusSurReserve({ cle: "LOYER", geste: "BAISSER", user: fin })).toBeNull();
    expect(refusSurReserve({ cle: "RESERVE_IMPREVUS", geste: "BAISSER", user: { role: "GENERAL_MANAGER" } })).toBeNull();
  });
});

describe("l'état d'une échéance se lit sur l'ordre", () => {
  it("chaque état", () => {
    expect(etatEcheance(null)).toBe("A_DEMANDER");
    expect(etatEcheance({ status: "PENDING", centralStatus: "AWAITING" })).toBe("AU_CENTRE");
    expect(etatEcheance({ status: "PENDING", centralStatus: "APPROVED" })).toBe("AUTORISEE");
    expect(etatEcheance({ status: "PAID", centralStatus: "APPROVED" })).toBe("PAYEE");
    expect(etatEcheance({ status: "PENDING", centralStatus: "REFUSED" })).toBe("REFUSEE");
    expect(etatEcheance({ status: "CANCELLED", centralStatus: "AWAITING" })).toBe("ANNULEE");
    expect(peutDemanderPaiement("REFUSEE")).toBe(true);
    expect(peutDemanderPaiement("AU_CENTRE")).toBe(false);
  });
});

describe("la saisie d'une charge", () => {
  const base = { site: "Siège", nature: "LOYER", beneficiaire: "SCI", montant: "450 000", periodicite: "MENSUELLE", jourEcheance: "5", dateDebut: "2027-01-01" };
  it("le loyer porte d'office une échéance fixe ; les montants s'écrivent avec espaces", () => {
    const r = lireSaisieCharge(base);
    expect(r.ok && r.valeur.echeanceFixe).toBe(true);
    expect(r.ok && r.valeur.montant).toBe(450_000);
  });
  it("chaque refus dit quoi corriger", () => {
    expect(lireSaisieCharge({ ...base, site: "" })).toMatchObject({ ok: false, error: expect.stringMatching(/site/) });
    expect(lireSaisieCharge({ ...base, montant: "0", modeMontant: "SELON_FACTURE" })).toMatchObject({ ok: false, error: expect.stringMatching(/estimation/) });
    expect(lireSaisieCharge({ ...base, dateFin: "2026-01-01" })).toMatchObject({ ok: false, error: expect.stringMatching(/fin précède/) });
    expect(lireSaisieCharge({ ...base, jourEcheance: "32" })).toMatchObject({ ok: false });
  });
});

describe("la prévision à 12 mois et le pré-remplissage de la campagne", () => {
  const charges = [charge(), charge({ id: "c2", companyId: "s2", nature: "ELECTRICITE", modeMontant: "SELON_FACTURE", montant: 30_000, periodicite: "TRIMESTRIELLE", moisEcheance: 1 })];
  it("par société et par mois ; une échéance réglée sort de la prévision", () => {
    const p = previsionChargesFixes(charges, d("2027-01-15"), 12, new Set([cleEcheance("c1", "2027-01")]));
    const s1 = p.filter((m) => m.companyId === "s1");
    expect(s1.map((m) => m.mois)).toEqual(["2027-02", "2027-03", "2027-04", "2027-05", "2027-06", "2027-07", "2027-08", "2027-09", "2027-10", "2027-11", "2027-12"]);
    expect(p.filter((m) => m.companyId === "s2").map((m) => m.mois)).toEqual(["2027-01", "2027-04", "2027-07", "2027-10"]);
  });
  it("AUTO_CHARGES_FIXES : une ligne par nature, montant = échéances de l'année", () => {
    const l = lignesPrefillChargesFixes(charges.filter((c) => c.companyId === "s1"), 2027);
    expect(l).toEqual([expect.objectContaining({ key: "CHARGES_FIXES:LOYER", categoryKey: "LOYER", source: "AUTO_CHARGES_FIXES", propose: 5_400_000 })]);
  });
  it("les libellés de période", () => {
    expect(libellePeriode("2027-03", "MENSUELLE")).toBe("mars 2027");
    expect(libellePeriode("2027-04", "TRIMESTRIELLE")).toBe("2e trimestre 2027");
    expect(libellePeriode("2027-03", "ANNUELLE")).toBe("2027");
  });
});
