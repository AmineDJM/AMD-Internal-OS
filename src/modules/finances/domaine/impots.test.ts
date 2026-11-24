import { describe, expect, it } from "vitest";
import {
  AUCUNE_PROPOSITION, dateEcheance, decomposer, echeanceDeLaPeriode, etatDeLEcheance, lireMontantFiscal, periodeCourante, periodeSelonAvis,
  propositionsDesFiches, rappelDu, refusCorrectionEcheance, refusEnvoiEcheance, refusPreparationEcheance, refusQuittanceEcheance,
  refusRetraitEcheance, texteEcheance, validerObligation, origineDuMontant,
  etatDesOrdres,
} from "./impots";
import {
  CATEGORIES_BUDGET_IMPOTS, CODE_ENVELOPPE_IMPOTS, ligneBudgetDuMontant, LIGNES_BUDGET_IMPOTS, LIGNES_MASSE_SALARIALE,
  repartirAuProrata, ventilationBudgetaire,
} from "./budget-impots";

/**
 * IMPÔTS & COTISATIONS — les règles pures (maquette validée, 24/11/2026). La plateforme ne calcule aucun impôt : elle
 * additionne des retenues inscrites et recopie des montants ; l'envoi exige le justificatif ; l'état se lit sur l'ordre.
 */

describe("le préremplissage IRG / CNAS — la somme des retenues des fiches, rien d'autre", () => {
  it("additionne les retenues inscrites ; une fiche sans retenue ne compte pas pour zéro inventé", () => {
    const p = propositionsDesFiches([
      { retIrg: 17460, retSS9: 11520, retSS35: 44800 },
      { retIrg: 38900, retSS9: null, retSS35: null },
      { retIrg: null, retSS9: 5580, retSS35: 21700 },
    ]);
    expect(p).toEqual({ irg: 56360, sal: 17100, pat: (44800 - 11520) + (21700 - 5580), tva: null, fiches: 3 });
  });

  it("aucune fiche ne porte la retenue : pas de proposition — la saisie redevient manuelle", () => {
    expect(propositionsDesFiches([{ retIrg: null, retSS9: null, retSS35: null }])).toEqual({ irg: null, sal: null, pat: null, tva: null, fiches: 1 });
    expect(propositionsDesFiches([])).toEqual(AUCUNE_PROPOSITION);
  });

  it("G50 : l'IRG proposé est repris tel quel, et une correction est MARQUÉE (l'écart est tracé)", () => {
    const p = { irg: 1214600, sal: null, pat: null, tva: null, fiches: 86 };
    const tel = decomposer("G50", { tvaC: "3 412 000", tvaD: "2 251 500" }, p);
    expect(tel.lignes[0]).toMatchObject({ cle: "irg", montant: 1214600, propose: 1214600, modifie: false });
    expect(tel.total).toBe(1214600 + 1160500);
    expect(tel.dePaie).toBe(1214600);
    expect(tel.deDeclaration).toBe(1160500);
    const corrige = decomposer("G50", { irg: "1 198 400", tvaC: "0", tvaD: "0" }, p);
    expect(corrige.lignes[0]).toMatchObject({ montant: 1198400, propose: 1214600, modifie: true });
    expect(origineDuMontant(corrige.lignes[0]!)).toBe("Proposé par la paie, corrigé (proposé 1 214 600)");
  });

  it("CNAS : les deux parts viennent des fiches ; sans fiche, il faut les saisir", () => {
    expect(decomposer("CNAS", {}, { irg: null, sal: 1494450, pat: 4317300, tva: null, fiches: 86 }).total).toBe(5811750);
    const sans = decomposer("CNAS", {}, AUCUNE_PROPOSITION);
    expect(sans.manque).toEqual(["part salariale", "part patronale"]);
  });
});

describe("la TVA et les autres lignes — recopiées, jamais calculées", () => {
  it("TVA à payer = collectée − déductible ; un résultat négatif n'ajoute rien et le dit", () => {
    const d = decomposer("G50", { irg: "0", tvaC: "100", tvaD: "250" }, AUCUNE_PROPOSITION);
    expect(d.tvaNegative).toBe(-150);
    expect(d.lignes.find((l) => l.cle === "tva")!.montant).toBe(0);
  });

  it("les deux montants de TVA sont exigés, et suffisent avec l'IRG", () => {
    const d = decomposer("G50", { irg: "10", tvaC: "100" }, AUCUNE_PROPOSITION);
    expect(d.manque).toEqual(["TVA collectée et déductible"]);
    expect(decomposer("G50", { irg: "10", tvaC: "100", tvaD: "40" }, AUCUNE_PROPOSITION).total).toBe(70);
  });

  it("TVA PROPOSÉE par les factures (lot « tva ») : reprise comme l'IRG, corrigible, l'écart marqué ; sans source, saisie", () => {
    const p = { irg: 0, sal: null, pat: null, tva: 1160500, fiches: 1 };
    const tel = decomposer("G50", {}, p);
    expect(tel.lignes.find((l) => l.cle === "tva")).toMatchObject({ source: "FACTURES", montant: 1160500, propose: 1160500, modifie: false, manque: false });
    expect(tel.deFactures).toBe(1160500);
    expect(tel.manque).toEqual([]);
    const corrige = decomposer("G50", { tva: "1 150 000" }, p);
    expect(corrige.lignes.find((l) => l.cle === "tva")).toMatchObject({ montant: 1150000, modifie: true });
    expect(origineDuMontant(corrige.lignes.find((l) => l.cle === "tva")!)).toBe("Proposé par les factures, corrigé (proposé 1 160 500)");
    // Un crédit de TVA n'ajoute rien, et se dit.
    expect(decomposer("G50", {}, { ...p, tva: -50 }).tvaNegative).toBe(-50);
    // Sans source (aujourd'hui), la TVA reste à recopier de la G50.
    expect(decomposer("G50", {}, { ...p, tva: null }).manque).toEqual(["TVA collectée et déductible"]);
  });

  it("une autre ligne de la déclaration s'ajoute ; un montant sans libellé est signalé", () => {
    const d = decomposer("G50", { irg: "0", tvaC: "0", tvaD: "0", autres: [{ libelle: "Droit de timbre", montant: "2 500" }, { libelle: "", montant: "10" }] }, AUCUNE_PROPOSITION);
    expect(d.total).toBe(2510);
    expect(d.autreSansLibelle).toBe(true);
  });

  it("lit les montants saisis à la française, refuse l'illisible", () => {
    expect(lireMontantFiscal("1 214 600")).toBe(1214600);
    expect(lireMontantFiscal("1214600,50")).toBe(1214600.5);
    expect(lireMontantFiscal("")).toBeNull();
    expect(lireMontantFiscal("12a")).toBeNull();
  });
});

describe("l'envoi — le justificatif est obligatoire", () => {
  const base = { periodeLibelle: "novembre 2026", organisme: "Recette des impôts" };
  it("sans justificatif, rien ne part — et le refus nomme la pièce attendue", () => {
    const d = decomposer("G50", { irg: "10", tvaC: "0", tvaD: "0" }, AUCUNE_PROPOSITION);
    expect(refusEnvoiEcheance({ ...base, composition: "G50", decomposition: d, justificatif: false }))
      .toBe("Le justificatif est obligatoire : joignez la déclaration G50 de novembre 2026, signée.");
    const c = decomposer("CNAS", { sal: "1", pat: "1" }, AUCUNE_PROPOSITION);
    expect(refusEnvoiEcheance({ ...base, composition: "CNAS", decomposition: c, justificatif: false })).toMatch(/joignez le bordereau de déclaration CNAS/);
    expect(refusEnvoiEcheance({ ...base, composition: "G50", decomposition: d, justificatif: true })).toBeNull();
  });

  it("ce qui manque passe avant la pièce ; un total nul ne part pas", () => {
    const incomplet = decomposer("MONTANT", {}, AUCUNE_PROPOSITION);
    expect(refusEnvoiEcheance({ ...base, composition: "MONTANT", decomposition: incomplet, justificatif: true })).toMatch(/^Encore à saisir : montant/);
    const nul = decomposer("MONTANT", { montant: "0" }, AUCUNE_PROPOSITION);
    expect(refusEnvoiEcheance({ ...base, composition: "MONTANT", decomposition: nul, justificatif: true })).toMatch(/total est nul/);
  });
});

describe("l'état se lit sur l'ordre — et chaque geste a sa porte", () => {
  it("transitions lues : à préparer → au centre → autorisé → payé, ou refusé", () => {
    expect(etatDeLEcheance(null)).toBe("A_PREPARER");
    expect(etatDeLEcheance({ status: "CANCELLED", centralStatus: "AWAITING" })).toBe("A_PREPARER");
    expect(etatDeLEcheance({ status: "PENDING", centralStatus: "AWAITING" })).toBe("AU_CENTRE");
    expect(etatDeLEcheance({ status: "PENDING", centralStatus: "AWAITING_PROOF" })).toBe("AU_CENTRE");
    expect(etatDeLEcheance({ status: "PENDING", centralStatus: "APPROVED" })).toBe("AUTORISE");
    expect(etatDeLEcheance({ status: "PENDING", centralStatus: "REFUSED" })).toBe("REFUSE");
    expect(etatDeLEcheance({ status: "PAID", centralStatus: "APPROVED" })).toBe("PAYE");
  });

  it("retirer tant que non décidé ; corriger un refus ; la quittance après paiement ; préparer avant l'envoi", () => {
    expect(refusRetraitEcheance("AU_CENTRE")).toBeNull();
    expect(refusRetraitEcheance("AUTORISE")).toMatch(/déjà décidé/);
    expect(refusCorrectionEcheance("REFUSE")).toBeNull();
    expect(refusCorrectionEcheance("AU_CENTRE")).not.toBeNull();
    expect(refusQuittanceEcheance("PAYE")).toBeNull();
    expect(refusQuittanceEcheance("AUTORISE")).not.toBeNull();
    expect(refusPreparationEcheance("A_PREPARER")).toBeNull();
    expect(refusPreparationEcheance("AU_CENTRE")).not.toBeNull();
  });
});

describe("le calendrier — des périodes et des jours limites que personne n'a codés", () => {
  it("la période de novembre naît en novembre, payable en décembre ; décembre l'est en janvier", () => {
    expect(periodeCourante("MENSUELLE", new Date("2026-11-24T10:00:00Z"))).toEqual({ cle: "2026-11", libelle: "novembre 2026", echeanceAnnee: 2026, echeanceMois: 12 });
    expect(periodeCourante("MENSUELLE", new Date("2026-12-02T10:00:00Z"))).toMatchObject({ cle: "2026-12", echeanceAnnee: 2027, echeanceMois: 1 });
    expect(periodeCourante("TRIMESTRIELLE", new Date("2026-11-24T10:00:00Z"))).toMatchObject({ cle: "2026-T4", echeanceAnnee: 2027, echeanceMois: 1 });
    expect(periodeCourante("ANNUELLE", new Date("2026-11-24T10:00:00Z"))).toMatchObject({ cle: "2026", libelle: "année 2026" });
    expect(periodeCourante("SELON_AVIS", new Date())).toBeNull();
    expect(periodeSelonAvis(2026, 2)).toEqual({ cle: "2026-A2", libelle: "exercice 2026 (2e)" });
  });

  it("le jour limite tombe dans le mois — un 31 en février devient le 28 ; sans jour, pas de date", () => {
    expect(dateEcheance(20, 2026, 12)!.toISOString()).toBe("2026-12-20T12:00:00.000Z");
    expect(dateEcheance(31, 2027, 2)!.toISOString()).toBe("2027-02-28T12:00:00.000Z");
    expect(dateEcheance(null, 2026, 12)).toBeNull();
    expect(texteEcheance(dateEcheance(20, 2026, 12), true)).toBe("avant le 20 déc. · à confirmer");
    expect(texteEcheance(null, false)).toBe("selon l'avis");
  });

  it("un jour limite changé se réaligne sur la période déjà née (mois, trimestre, année) — « selon avis » n'en a pas", () => {
    expect(echeanceDeLaPeriode("2026-11", 15)!.toISOString()).toBe("2026-12-15T12:00:00.000Z");
    expect(echeanceDeLaPeriode("2026-12", 15)!.toISOString()).toBe("2027-01-15T12:00:00.000Z");
    expect(echeanceDeLaPeriode("2026-T3", 20)!.toISOString()).toBe("2026-10-20T12:00:00.000Z");
    expect(echeanceDeLaPeriode("2026", 30)!.toISOString()).toBe("2027-01-30T12:00:00.000Z");
    expect(echeanceDeLaPeriode("2026-A1", 20)).toBeNull();
    expect(echeanceDeLaPeriode("2026-11", null)).toBeNull();
  });

  it("une obligation se valide : organisme, nature, jour de 1 à 31 ou vide", () => {
    expect(validerObligation({ organisme: " CNAS ", nature: "Cotisations", composition: "CNAS", periodicite: "MENSUELLE", jour: "30" }))
      .toEqual({ ok: true, organisme: "CNAS", nature: "Cotisations", composition: "CNAS", periodicite: "MENSUELLE", jourLimite: 30, moisLimite: null });
    // Le solde de l'IBS : annuel, au 30 avril de l'année suivante.
    expect(validerObligation({ organisme: "Recette", nature: "Solde IBS", composition: "MONTANT", periodicite: "ANNUELLE", jour: "30", mois: "4" })).toMatchObject({ ok: true, jourLimite: 30, moisLimite: 4 });
    expect(validerObligation({ organisme: "Recette", nature: "Solde IBS", composition: "MONTANT", periodicite: "ANNUELLE", jour: "30", mois: "13" }).ok).toBe(false);
    expect(echeanceDeLaPeriode("2026", 30, 4)!.toISOString()).toBe("2027-04-30T12:00:00.000Z");
    expect(validerObligation({ organisme: "CNAS", nature: "", composition: "CNAS", periodicite: "MENSUELLE", jour: "" }).ok).toBe(false);
    expect(validerObligation({ organisme: "X", nature: "Y", composition: "MONTANT", periodicite: "SELON_AVIS", jour: "" })).toMatchObject({ ok: true, jourLimite: null });
    expect(validerObligation({ organisme: "X", nature: "Y", composition: "MONTANT", periodicite: "MENSUELLE", jour: "40" }).ok).toBe(false);
  });

  it("le rappel J-7 part une fois, pour une ligne encore à préparer", () => {
    const echeance = new Date("2026-12-20T12:00:00Z");
    const base = { echeance, rappel: true, etat: "A_PREPARER" as const, rappelEnvoyeLe: null };
    expect(rappelDu({ ...base, maintenant: new Date("2026-12-14T08:00:00Z") })).toBe(true);
    expect(rappelDu({ ...base, maintenant: new Date("2026-12-10T08:00:00Z") })).toBe(false);
    expect(rappelDu({ ...base, rappelEnvoyeLe: new Date(), maintenant: new Date("2026-12-14T08:00:00Z") })).toBe(false);
    expect(rappelDu({ ...base, etat: "AU_CENTRE", maintenant: new Date("2026-12-14T08:00:00Z") })).toBe(false);
    expect(rappelDu({ ...base, rappel: false, maintenant: new Date("2026-12-14T08:00:00Z") })).toBe(false);
  });
});

describe("le budget — TVA et IBS aux « Impôts & taxes », IRG et CNAS à la masse salariale", () => {
  it("G50 : la TVA → TVA_NETTE, l'IRG → MS_IRG, une autre ligne → à classer ; la somme des parts égale le total", () => {
    const d = decomposer("G50", { irg: "100", tvaC: "500", tvaD: "200", autres: [{ libelle: "Droit de timbre", montant: "5" }] }, AUCUNE_PROPOSITION);
    const parts = ventilationBudgetaire("G50", d.lignes, "G50 — TVA et IRG salaires", "Recette des impôts");
    expect(parts).toEqual([{ cle: "TVA_NETTE", montant: 300 }, { cle: "MS_IRG", montant: 100 }, { cle: null, montant: 5 }]);
    expect(parts.reduce((t, p) => t + p.montant, 0)).toBe(d.total);
  });

  it("CNAS → MS_CNAS ; acompte et solde d'IBS → IBS ; montants nuls écartés ; rien d'autre n'est désigné", () => {
    expect(ventilationBudgetaire("CNAS", [{ cle: "sal", montant: 9 }, { cle: "pat", montant: 26 }], "Cotisations", "CNAS")).toEqual([{ cle: "MS_CNAS", montant: 35 }]);
    expect(ventilationBudgetaire("MONTANT", [{ cle: "montant", montant: 1 }], "Acompte IBS", "Recette des impôts")).toEqual([{ cle: "IBS", montant: 1 }]);
    expect(ventilationBudgetaire("MONTANT", [{ cle: "montant", montant: 1 }], "Solde IBS (liquidation annuelle)", "Recette des impôts")[0]!.cle).toBe("IBS");
    expect(ligneBudgetDuMontant("Régularisation diverse", "Recette des impôts")).toBeNull();
    expect(ventilationBudgetaire("G50", [{ cle: "irg", montant: 0 }, { cle: "tva", montant: 0 }], "G50", "Recette")).toEqual([]);
  });

  it("le prorata des départements tombe juste au centime ; sans poids, tout est à classer", () => {
    const r = repartirAuProrata(56000, [{ cle: "A", poids: 17460 }, { cle: "B", poids: 38900 }, { cle: "C", poids: 0 }]);
    expect(r.map((x) => x.cle)).toEqual(["A", "B"]);
    expect(Math.round(r.reduce((t, x) => t + x.montant, 0) * 100)).toBe(5600000);
    expect(r[0]!.montant).toBe(Math.round(56000 * 17460 / 56360 * 100) / 100);
    expect(repartirAuProrata(100, [{ cle: "A", poids: 1 }, { cle: "B", poids: 1 }, { cle: "C", poids: 1 }]).map((x) => x.montant).reduce((a, b) => a + b, 0)).toBeCloseTo(100, 6);
    expect(repartirAuProrata(10, [{ cle: "A", poids: 0 }])).toEqual([{ cle: null, montant: 10 }]);
  });

  it("les clés exposées aux autres lots ne bougent pas", () => {
    expect(CODE_ENVELOPPE_IMPOTS).toBe("IMPOTS_TAXES");
    expect(Object.values(LIGNES_BUDGET_IMPOTS)).toEqual(["TVA_NETTE", "IBS"]);
    expect(CATEGORIES_BUDGET_IMPOTS.map((c) => c.cle)).toEqual(["TVA_NETTE", "IBS"]);
    expect(Object.values(LIGNES_MASSE_SALARIALE)).toEqual(["MS_IRG", "MS_CNAS"]);
  });

  it("l'état d'une ligne à plusieurs ordres : un refus l'emporte, payée quand tous le sont", () => {
    expect(etatDesOrdres([])).toBe("A_PREPARER");
    expect(etatDesOrdres([{ status: "PENDING", centralStatus: "APPROVED" }, { status: "PENDING", centralStatus: "REFUSED" }])).toBe("REFUSE");
    expect(etatDesOrdres([{ status: "PENDING", centralStatus: "APPROVED" }, { status: "PENDING", centralStatus: "AWAITING" }])).toBe("AU_CENTRE");
    expect(etatDesOrdres([{ status: "PAID", centralStatus: "APPROVED" }, { status: "PENDING", centralStatus: "APPROVED" }])).toBe("AUTORISE");
    expect(etatDesOrdres([{ status: "PAID", centralStatus: "APPROVED" }, { status: "CANCELLED", centralStatus: "AWAITING" }])).toBe("PAYE");
  });
});
